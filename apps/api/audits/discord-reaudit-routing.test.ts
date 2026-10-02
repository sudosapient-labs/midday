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
  return (
    (
      await buildLexicalPrepareStep({
        messages: turns.map((content) => ({ role: "user", content })),
        maxTools: 12,
      })({} as never)
    )?.activeTools ?? []
  );
}

test("invoice confirmation does not revive an abandoned transaction deletion", async () => {
  const tools = await selected(
    "Delete the old transactions",
    "create an invoice for Acme",
    "yes, create it",
  );

  expect(tools).toContain("invoices_create");
  expect(tools).not.toContain("transactions_delete_bulk");
});

test("an unsaved preview correction retains transaction creation tools", async () => {
  const tools = await selected(
    "Save expenses 0.55 water",
    "55, not 0.55",
    "yes, save them",
  );

  expect(tools).toContain("transactions_create_bulk");
  expect(tools).not.toContain("transactions_update");
  expect(tools).not.toContain("transactions_delete_bulk");
});

test("a read-only transaction query does not expose mutation tools", async () => {
  const tools = await selected("show my transactions");

  expect(
    tools.some((name) =>
      /transactions_(?:create|update|delete)/u.test(String(name)),
    ),
  ).toBe(false);
});

test("cancellation removes deletion capabilities", async () => {
  const tools = await selected(
    "Delete the old transactions",
    "never mind, don't delete them",
  );
  expect(tools).not.toContain("transactions_delete_bulk");
});
test("explicit preview correction retains creation capabilities", async () => {
  const tools = await selected(
    "Save expenses 0.55 water",
    "correct it to 55",
    "yes, save them",
  );
  expect(tools).not.toContain("transactions_update");
  expect(tools).toContain("transactions_create_bulk");
});

test("a confirmation after cancellation cannot revive the cancelled deletion", async () => {
  const tools = await selected(
    "Delete the old transactions",
    "never mind, don't delete them",
    "yes",
  );
  expect(tools).not.toContain("transactions_delete_bulk");
});
