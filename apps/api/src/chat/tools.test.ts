import { describe, expect, test } from "bun:test";
import { getRequiredLexicalTools, modelMessageText } from "./tools";

describe("follow-up routing", () => {
  const route = (...texts: string[]) =>
    getRequiredLexicalTools(
      modelMessageText(
        texts.map((content) => ({ role: "user" as const, content })),
      ),
    );

  test.each([
    "try again, and create these issues",
    "yes, save it",
    "try again",
  ])("retains transaction tools for %s", (reply) => {
    expect(route("add these transactions", reply)).toContain(
      "transactions_create_bulk",
    );
  });

  test("retains domain across repeated short follow-ups", () => {
    expect(route("add these transactions", "yes", "try again")).toContain(
      "transactions_create_bulk",
    );
  });

  test("respects an explicit plural domain switch", () => {
    expect(route("add these transactions", "create invoices")).toEqual([]);
  });

  test("does not inherit an earlier destructive action", () => {
    const tools = route("delete these transactions", "create these instead");
    expect(tools).toContain("transactions_create_bulk");
    expect(tools).not.toContain("transactions_delete");
  });

  test("does not inherit write intent for a new read-only question", () => {
    expect(
      route("add these transactions", "how much were they?"),
    ).not.toContain("transactions_create_bulk");
    expect(route("add these transactions", "what is my balance?")).toEqual([
      "bank_accounts_balances",
      "bank_accounts_list",
    ]);
  });
});

describe("lexical transaction tool routing", () => {
  test("routes a spending question to read-only report tools", () => {
    expect(getRequiredLexicalTools("today we spent 55 on water")).toEqual([
      "reports_spending",
      "reports_expenses",
      "transactions_list",
    ]);
  });

  test("keeps write tools available only for an explicit save request", () => {
    expect(getRequiredLexicalTools("save these expenses")).toEqual([
      "categories_list",
      "bank_accounts_list",
      "transactions_list",
      "transactions_create",
      "transactions_create_bulk",
    ]);
  });

  test("routes balance questions to balance tools", () => {
    expect(getRequiredLexicalTools("what is my current bank balance?")).toEqual(
      ["bank_accounts_balances", "bank_accounts_list"],
    );
  });

  test("includes lookup tools when updating transactions", () => {
    const tools = getRequiredLexicalTools(
      "the transactions weren't updated; update them",
    );

    expect(tools).toContain("transactions_list");
    expect(tools).toContain("transactions_update");
  });

  test("does not add transaction tools to unrelated requests", () => {
    expect(getRequiredLexicalTools("show my invoices")).toEqual([]);
  });
});
