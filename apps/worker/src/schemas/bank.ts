import { z } from "zod";

/**
 * Bank job schemas (independent from @midday/jobs)
 */

export const bankProviderSchema = z.enum([
  "gocardless",
  "plaid",
  "teller",
  "enablebanking",
]);

export type BankProvider = z.infer<typeof bankProviderSchema>;

export const initialBankSetupSchema = z.object({
  teamId: z.string().uuid(),
  connectionId: z.string().uuid(),
});

export type InitialBankSetupPayload = z.infer<typeof initialBankSetupSchema>;

export const syncConnectionSchema = z.object({
  connectionId: z.string().uuid(),
  // Included so the dashboard can poll job status (jobs.getStatus checks teamId)
  teamId: z.string().uuid().optional(),
  manualSync: z.boolean().optional(),
});

export type SyncConnectionPayload = z.infer<typeof syncConnectionSchema>;

export const reconnectConnectionSchema = z.object({
  teamId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string(),
});

export type ReconnectConnectionPayload = z.infer<
  typeof reconnectConnectionSchema
>;

export const deleteConnectionSchema = z.object({
  referenceId: z.string().optional().nullable(),
  provider: bankProviderSchema,
  accessToken: z.string().optional().nullable(),
});

export type DeleteConnectionPayload = z.infer<typeof deleteConnectionSchema>;

export const bankSyncSchedulerSchema = z.object({
  teamId: z.string().uuid(),
});

export type BankSyncSchedulerPayload = z.infer<typeof bankSyncSchedulerSchema>;

export const transactionNotificationsSchema = z.object({
  teamId: z.string().uuid(),
});

export type TransactionNotificationsPayload = z.infer<
  typeof transactionNotificationsSchema
>;
