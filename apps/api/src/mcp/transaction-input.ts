import { createTransactionSchema } from "@api/schemas/transactions";
import { z } from "zod";

// Strict model gateways often populate every optional property. Empty strings
// must not become UUIDs or category foreign keys. Accept null/blank for absent
// optional fields, but validate all non-empty IDs before reaching the database.
export const assistantTransactionSchema = createTransactionSchema.extend({
  bankAccountId: z
    .string()
    .uuid()
    .describe("Existing bank account ID returned by bank_accounts_list"),
  assignedId: z
    .union([z.string().uuid(), z.literal(""), z.null()])
    .optional()
    .describe("Existing team member UUID, or null when unassigned"),
  categorySlug: z
    .string()
    .nullish()
    .describe(
      "Existing category slug returned by categories_list, or null when uncategorized",
    ),
  note: z.string().nullish().describe("Optional memo, or null"),
});

export function normalizeAssistantTransaction(
  input: z.infer<typeof assistantTransactionSchema>,
) {
  return {
    ...input,
    assignedId: input.assignedId?.trim() || undefined,
    categorySlug: input.categorySlug?.trim() || undefined,
    note: input.note ?? undefined,
  };
}
