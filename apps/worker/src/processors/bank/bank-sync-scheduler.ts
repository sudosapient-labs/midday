import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { unregisterDynamicScheduler } from "../../schedulers/registry";
import type { BankSyncSchedulerPayload } from "../../schemas/bank";
import { BaseProcessor } from "../base";

// Stagger connection syncs to avoid provider rate limits
const CONNECTION_STAGGER_MS = 60_000;

/**
 * Daily per-team scheduler: fans out a sync-connection job for each of the
 * team's bank connections.
 */
export class BankSyncSchedulerProcessor extends BaseProcessor<BankSyncSchedulerPayload> {
  async process(job: Job<BankSyncSchedulerPayload>) {
    const { teamId } = job.data;
    const supabase = createClient();

    const { data: connections } = await supabase
      .from("bank_connections")
      .select("id")
      .eq("team_id", teamId)
      .throwOnError();

    if (!connections?.length) {
      this.logger.info("No bank connections, removing team scheduler", {
        teamId,
      });
      await unregisterDynamicScheduler("bank-sync-scheduler", teamId);
      return { connections: 0 };
    }

    await Promise.all(
      connections.map((connection, index) =>
        triggerJob(
          "sync-connection",
          { connectionId: connection.id, teamId, manualSync: false },
          "bank",
          { delay: index * CONNECTION_STAGGER_MS },
        ),
      ),
    );

    return { connections: connections.length };
  }
}
