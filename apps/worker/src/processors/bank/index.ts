import { BankSyncSchedulerProcessor } from "./bank-sync-scheduler";
import { DeleteConnectionProcessor } from "./delete-connection";
import { EnsureBankSchedulersProcessor } from "./ensure-bank-schedulers";
import { InitialBankSetupProcessor } from "./initial-setup";
import { ReconnectConnectionProcessor } from "./reconnect-connection";
import { SyncConnectionProcessor } from "./sync-connection";
import { TransactionNotificationsProcessor } from "./transaction-notifications";

/**
 * Export all bank processors (for type imports)
 */
export { BankSyncSchedulerProcessor } from "./bank-sync-scheduler";
export { DeleteConnectionProcessor } from "./delete-connection";
export { EnsureBankSchedulersProcessor } from "./ensure-bank-schedulers";
export { InitialBankSetupProcessor } from "./initial-setup";
export { ReconnectConnectionProcessor } from "./reconnect-connection";
export { SyncConnectionProcessor } from "./sync-connection";
export { TransactionNotificationsProcessor } from "./transaction-notifications";

/**
 * Bank processor registry
 * Maps job names to processor instances
 */
export const bankProcessors = {
  "initial-bank-setup": new InitialBankSetupProcessor(),
  "sync-connection": new SyncConnectionProcessor(),
  "reconnect-connection": new ReconnectConnectionProcessor(),
  "delete-connection": new DeleteConnectionProcessor(),
  "bank-sync-scheduler": new BankSyncSchedulerProcessor(),
  "ensure-bank-schedulers": new EnsureBankSchedulersProcessor(),
  "transaction-notifications": new TransactionNotificationsProcessor(),
};
