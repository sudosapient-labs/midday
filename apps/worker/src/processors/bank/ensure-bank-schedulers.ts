import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { registerDynamicScheduler } from "../../schedulers/registry";
import { generateCronTag } from "../../utils/generate-cron-tag";
import { BaseProcessor } from "../base";

/**
 * Daily verification that every team with a bank connection has a
 * registered bank-sync-scheduler. Registration is idempotent (upsert),
 * so this also recovers schedulers created before the BullMQ migration.
 */
export class EnsureBankSchedulersProcessor extends BaseProcessor {
  async process(_job: Job) {
    const supabase = createClient();

    const { data: connections } = await supabase
      .from("bank_connections")
      .select("team_id")
      .throwOnError();

    const teamIds = [...new Set((connections ?? []).map((row) => row.team_id))];

    let registered = 0;
    let failed = 0;

    for (const teamId of teamIds) {
      try {
        await registerDynamicScheduler({
          template: "bank-sync-scheduler",
          accountId: teamId,
          cronPattern: generateCronTag(teamId),
        });
        registered++;
      } catch (error) {
        failed++;
        this.logger.error("Failed to register bank scheduler", {
          teamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("Bank scheduler verification complete", {
      teams: teamIds.length,
      registered,
      failed,
    });

    return { teams: teamIds.length, registered, failed };
  }
}
