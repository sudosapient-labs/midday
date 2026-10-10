import { describe, expect, test } from "bun:test";
import {
  assistantTransactionSchema,
  normalizeAssistantTransaction,
} from "./transaction-input";

const base = {
  name: "Synthetic expense",
  amount: -12,
  currency: "INR",
  date: "2026-10-10",
  bankAccountId: "00000000-0000-4000-8000-000000000103",
};

describe("assistant transaction inputs", () => {
  test.each([
    undefined,
    null,
    "",
  ])("normalizes absent optional fields (%s)", (empty) => {
    const parsed = assistantTransactionSchema.parse({
      ...base,
      assignedId: empty,
      categorySlug: empty,
      note: empty,
    });
    expect(normalizeAssistantTransaction(parsed)).toMatchObject({
      assignedId: undefined,
      categorySlug: undefined,
    });
  });
  test("preserves real assignment and category", () => {
    const input = {
      ...base,
      assignedId: "00000000-0000-4000-8000-000000000102",
      categorySlug: "office",
      note: "memo",
    };
    expect(
      normalizeAssistantTransaction(assistantTransactionSchema.parse(input)),
    ).toEqual(input);
  });
  test("rejects invalid non-empty UUIDs before SQL execution", () => {
    expect(
      assistantTransactionSchema.safeParse({ ...base, assignedId: "invented" })
        .success,
    ).toBe(false);
    expect(
      assistantTransactionSchema.safeParse({ ...base, bankAccountId: "" })
        .success,
    ).toBe(false);
  });
});
