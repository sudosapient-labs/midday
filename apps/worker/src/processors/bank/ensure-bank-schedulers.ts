import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { registerDynamicScheduler } from "../../schedulers/registry";
import { generateCronTag } from "../../utils/generate-cron-tag";
import { BaseProcessor } from "../base";
import { dispatchTransactionEmails } from "./dispatch-transaction-emails";

const PAGE_SIZE = 1000;

/**
 * Daily verification that every team with a bank connection has a
 * registered bank-sync-scheduler. Registration is idempotent (upsert),
 * so this also recovers schedulers created before the BullMQ migration.
 */
export class EnsureBankSchedulersProcessor extends BaseProcessor {
  async process(_job: Job) {
    const supabase = createClient();

    // Page through the table: Supabase caps a single response at 1,000 rows
    const teamIdSet = new Set<string>();

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: connections } = await supabase
        .from("bank_connections")
        .select("team_id")
        .order("id")
        .range(from, from + PAGE_SIZE - 1)
        .throwOnError();

      for (const row of connections ?? []) {
        teamIdSet.add(row.team_id);
      }

      if ((connections?.length ?? 0) < PAGE_SIZE) {
        break;
      }
    }

    const teamIds = [...teamIdSet];

    let registered = 0;
    let failed = 0;

    for (const teamId of teamIds) {
      try {
        await registerDynamicScheduler({
          template: "bank-sync-scheduler",
          accountId: teamId,
          cronPattern: generateCronTag(teamId),
          force: true,
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

    await dispatchTransactionEmails();

    return { teams: teamIds.length, registered, failed };
  }
}
