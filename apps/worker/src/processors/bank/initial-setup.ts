import { triggerJob } from "@midday/job-client";
import type { Job } from "bullmq";
import { registerDynamicScheduler } from "../../schedulers/registry";
import type { InitialBankSetupPayload } from "../../schemas/bank";
import { generateCronTag } from "../../utils/generate-cron-tag";
import { BaseProcessor } from "../base";
import { syncBankConnection } from "./sync";

// GoCardless, Teller and Plaid can take a few minutes to make all
// transactions available, so run a second sync after the initial one
const FOLLOW_UP_SYNC_DELAY_MS = 5 * 60 * 1000;

/**
 * Initial bank setup processor
 * Registers the team's daily bank sync and runs the first sync for the connection.
 * The dashboard polls this job's status to show the initial import progress.
 */
export class InitialBankSetupProcessor extends BaseProcessor<InitialBankSetupPayload> {
  async process(job: Job<InitialBankSetupPayload>) {
    const { teamId, connectionId } = job.data;

    await registerDynamicScheduler({
      template: "bank-sync-scheduler",
      accountId: teamId,
      cronPattern: generateCronTag(teamId),
    });

    await job.updateProgress({ progress: 10, step: "syncing" });

    const result = await syncBankConnection({ connectionId, manualSync: true });

    if (result.status !== "connected") {
      throw new Error("Bank connection is not connected");
    }

    await triggerJob(
      "sync-connection",
      { connectionId, teamId, manualSync: true },
      "bank",
      { delay: FOLLOW_UP_SYNC_DELAY_MS },
    );

    this.logger.info("Initial bank setup completed", {
      teamId,
      connectionId,
      ...result,
    });

    return result;
  }
}
