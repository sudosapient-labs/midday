import { describe, expect, test } from "bun:test";
import { getRequiredConversationTools, getRequiredLexicalTools } from "./tools";

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

describe("conversation-aware required tools", () => {
  test("keeps write tools on a confirmation turn", () => {
    expect(
      getRequiredConversationTools([
        {
          role: "user",
          content: "Today we spent 55 on water and 247 on curtains",
        },
        { role: "assistant", content: "Save both expenses to Cash?" },
        { role: "user", content: "yes, save them" },
      ]),
    ).toContain("transactions_create_bulk");
  });

  test("drops an abandoned transaction action on an invoice topic switch", () => {
    expect(
      getRequiredConversationTools([
        { role: "user", content: "Delete the old transactions" },
        { role: "assistant", content: "Which transactions?" },
        { role: "user", content: "show my invoices" },
      ]),
    ).not.toContain("transactions_delete_bulk");
  });

  test("continues from the most recent explicit task boundary", () => {
    const tools = getRequiredConversationTools([
      { role: "user", content: "Delete the old transactions" },
      { role: "user", content: "create an invoice for Acme" },
      { role: "user", content: "yes, create it" },
    ]);

    expect(tools).not.toContain("transactions_delete_bulk");
  });

  test("treats amount edits as changes to an unsaved expense preview", () => {
    const tools = getRequiredConversationTools([
      { role: "user", content: "Save expenses 0.55 water" },
      { role: "user", content: "55, not 0.55" },
      { role: "user", content: "yes, save them" },
    ]);

    expect(tools).toContain("transactions_create_bulk");
    expect(tools).not.toContain("transactions_update");
  });
});
