// Real MCP catalog; no model calls, database queries, or external writes.
import { beforeAll, expect, test } from "bun:test";
import {
  buildLexicalPrepareStep,
  ensureToolDefinitions,
} from "../src/chat/tools";
import type { McpContext } from "../src/mcp/types";
import { expandScopes } from "../src/utils/scopes";

beforeAll(async () => {
  await ensureToolDefinitions({
    db: {} as McpContext["db"],
    teamId: "audit",
    userId: "audit",
    userEmail: null,
    scopes: expandScopes(["apis.all"]) as McpContext["scopes"],
    apiUrl: "https://example.invalid",
    timezone: "UTC",
    locale: "en",
    countryCode: null,
    dateFormat: null,
    timeFormat: 24,
  });
});

async function selected(...turns: string[]) {
  const prepare = buildLexicalPrepareStep({
    messages: turns.map((content) => ({ role: "user", content })),
    maxTools: 12,
  });
  return (await prepare({} as never))?.activeTools ?? [];
}

test("expense confirmation retains transaction creation tools", async () => {
  expect(
    await selected(
      "Today we spent 55 on water and 247 on curtains",
      "yes, save them",
    ),
  ).toContain("transactions_create_bulk");
});

test("amount correction to an unsaved preview retains creation tools", async () => {
  expect(
    await selected(
      "Save these expenses: 55 water, 247 curtains",
      "55, not 0.55",
    ),
  ).toContain("transactions_create_bulk");
});

test("confirming an account selection preserves the pending expense workflow", async () => {
  expect(
    await selected(
      "Save these expenses: 55 water, 247 curtains",
      "Use the cash account",
      "yes",
    ),
  ).toContain("transactions_create_bulk");
});

test("a new plural domain does not retain the old transaction deletion request", async () => {
  expect(
    await selected("Delete the old transactions", "show my invoices"),
  ).not.toContain("transactions_delete_bulk");
});

test("control: a direct expense-saving request has the required tool", async () => {
  expect(await selected("save these expenses")).toContain(
    "transactions_create_bulk",
  );
});

test("control: a direct balance question has the required tool", async () => {
  expect(await selected("what is my current bank balance?")).toContain(
    "bank_accounts_balances",
  );
});
