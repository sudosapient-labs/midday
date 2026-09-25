import { describe, expect, test } from "bun:test";
import { getRequiredLexicalTools } from "./tools";

describe("lexical transaction tool routing", () => {
  test("includes read and write tools for a spending note", () => {
    expect(getRequiredLexicalTools("today we spent 55 on water")).toEqual([
      "bank_accounts_list",
      "bank_accounts_create",
      "categories_list",
      "transactions_list",
      "transactions_get",
      "transactions_create",
      "transactions_create_bulk",
      "transactions_update",
      "transactions_update_bulk",
    ]);
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
