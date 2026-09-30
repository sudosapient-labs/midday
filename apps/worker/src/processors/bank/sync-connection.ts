import type { Job } from "bullmq";
import type { SyncConnectionPayload } from "../../schemas/bank";
import { BaseProcessor } from "../base";
import { syncBankConnection } from "./sync";

/**
 * Sync a bank connection: checks status with the provider, then syncs the
 * balance and transactions of every enabled account.
 */
export class SyncConnectionProcessor extends BaseProcessor<SyncConnectionPayload> {
  async process(job: Job<SyncConnectionPayload>) {
    const { connectionId, manualSync } = job.data;

    const result = await syncBankConnection({ connectionId, manualSync });

    this.logger.info("Bank connection synced", { connectionId, ...result });

    return result;
  }
}
