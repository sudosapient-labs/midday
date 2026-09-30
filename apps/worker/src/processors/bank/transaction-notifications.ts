import { Notifications } from "@midday/notifications";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import type { TransactionNotificationsPayload } from "../../schemas/bank";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";

/**
 * Notify a team about transactions imported by background bank syncs
 */
export class TransactionNotificationsProcessor extends BaseProcessor<TransactionNotificationsPayload> {
  async process(job: Job<TransactionNotificationsPayload>) {
    const { teamId } = job.data;
    const supabase = createClient();

    // Mark all unnotified transactions as notified and return them
    const { data: transactions } = await supabase
      .from("transactions")
      .update({ notified: true })
      .eq("team_id", teamId)
      .eq("notified", false)
      .select("id, date, amount, name, currency")
      .order("date", { ascending: false })
      .throwOnError();

    if (!transactions?.length) {
      return { notified: 0 };
    }

    const notifications = new Notifications(getDb());

    await notifications.create(
      "transactions_created",
      teamId,
      {
        transactions: transactions.map((transaction) => ({
          id: transaction.id,
          date: transaction.date,
          amount: transaction.amount,
          name: transaction.name,
          currency: transaction.currency,
        })),
      },
      { sendEmail: true },
    );

    return { notified: transactions.length };
  }
}
