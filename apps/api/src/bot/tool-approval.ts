import { createHash } from "node:crypto";
import type { ToolSet } from "ai";
import { isCancelledTask, isWriteToolName } from "./action-intent";

export type PendingBotAction = {
  key: string;
  toolName: string;
  input: unknown;
  previewMessageId?: string;
  previewDelivered?: boolean;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function isBotActionConfirmation(text: string) {
  return /^(?:yes|yep|confirm|confirmed|go ahead|do it|save them|save it)(?:[.!]|,?\s+(?:please|save (?:them|it)|create (?:them|it)|delete (?:them|it)))?[.!]?$/iu.test(
    text.trim(),
  );
}

export function guardBotTools(
  tools: ToolSet,
  options: {
    userText: string;
    pending: PendingBotAction[];
    persist: (pending: PendingBotAction[]) => Promise<void>;
    beforeExecute: () => Promise<void>;
  },
) {
  let pending = [...options.pending];
  const cancelled = isCancelledTask(options.userText);
  const approved =
    isBotActionConfirmation(options.userText) && !cancelled
      ? new Set(
          pending
            .filter((item) => item.previewDelivered)
            .map((item) => item.key),
        )
      : new Set<string>();
  const used = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serialized =
    (run: (input: unknown, executionOptions: any) => Promise<unknown>) =>
    (input: unknown, executionOptions: any) => {
      const result = queue.then(() => run(input, executionOptions));
      queue = result.catch(() => {});
      return result;
    };
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (!isWriteToolName(name) || !tool.execute) return [name, tool];
      const execute = tool.execute;
      return [
        name,
        {
          ...tool,
          execute: serialized(async (input: unknown, executionOptions: any) => {
            if (cancelled)
              return {
                isError: true,
                status: "cancelled",
                message:
                  "The user cancelled this task. Do not execute any mutation.",
              };
            const key = createHash("sha256")
              .update(`${name}:${canonical(input)}`)
              .digest("hex");
            if (used.has(key))
              return {
                isError: true,
                status: "already_executed",
                message:
                  "This action was already attempted in this turn; use its previous result.",
              };
            if (!approved.has(key)) {
              const action = { key, toolName: name, input };
              for (const previous of pending.filter(
                (item) => item.toolName === name,
              ))
                approved.delete(previous.key);
              // A changed preview replaces the operation's previous arguments.
              pending = [
                ...pending.filter((item) => item.toolName !== name),
                action,
              ];
              if (
                JSON.stringify(pending).length > 12_000 ||
                pending.length > 20
              ) {
                return {
                  isError: true,
                  status: "preview_too_large",
                  message: "Split this request into smaller actions.",
                };
              }
              await options.persist(pending);
              return {
                status: "pending_approval",
                executed: false,
                proposedAction: action,
                message:
                  "Nothing has been changed. Show these exact values in a preview and ask the user to confirm in the next message.",
              };
            }
            // Persist uncertainty before the call. A crash may have committed the
            // write; neither a delivery retry nor another confirmation may replay it.
            used.add(key);
            await options.beforeExecute();
            pending = pending.filter((item) => item.key !== key);
            await options.persist(pending);
            return execute(input, executionOptions);
          }),
        },
      ];
    }),
  ) as ToolSet;
}

export function formatPendingActionPreview(actions: PendingBotAction[]) {
  const label = (name: string) =>
    name.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/_/gu, " ");
  const operationLabel = (name: string) => {
    const words = name.split("_");
    const operations = new Set([
      "create",
      "update",
      "delete",
      "send",
      "start",
      "stop",
      "match",
      "confirm",
      "export",
      "sync",
      "pause",
      "resume",
    ]);
    const operation = words.find((word) => operations.has(word)) ?? "change";
    return `${operation[0]?.toUpperCase()}${operation.slice(1)} ${words.filter((word) => word !== operation && word !== "bulk").join(" ")}`;
  };
  const values = (value: unknown, indent = ""): string => {
    if (Array.isArray(value))
      return value
        .map((item, i) => `${indent}${i + 1}.\n${values(item, `${indent}  `)}`)
        .join("\n");
    if (value && typeof value === "object")
      return Object.entries(value)
        .map(
          ([key, child]) =>
            `${indent}${label(key)}: ${child && typeof child === "object" ? `\n${values(child, `${indent}  `)}` : String(child)}`,
        )
        .join("\n");
    return `${indent}${String(value)}`;
  };
  return `Proposed changes — nothing has been changed yet:\n${actions.map((action) => `${operationLabel(action.toolName)}\n${values(action.input)}`).join("\n\n")}\n\nReply “yes” to apply these exact changes, or describe a correction.`;
}
