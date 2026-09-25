import { describe, expect, test } from "bun:test";
import { getRequiredLexicalTools } from "./tools";

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
