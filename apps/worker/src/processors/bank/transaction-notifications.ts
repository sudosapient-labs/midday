import {
  claimTransactionNotifications,
  queueTransactionEmail,
} from "@midday/db/queries";
import { Notifications } from "@midday/notifications";
import type { Job } from "bullmq";
import type { TransactionNotificationsPayload } from "../../schemas/bank";
import { getDb } from "../../utils/db";
import { BaseProcessor } from "../base";
import { dispatchTransactionEmails } from "./dispatch-transaction-emails";

/**
 * Notify a team about transactions imported by background bank syncs
 */
export class TransactionNotificationsProcessor extends BaseProcessor<TransactionNotificationsPayload> {
  async process(job: Job<TransactionNotificationsPayload>) {
    const { teamId } = job.data;
    const db = getDb();

    const result = await db.transaction(async (tx) => {
      // Row locks serialize overlapping batches. The claim and activities commit
      // together, so notification errors cannot leave a claimed batch without alerts.
      const batch = await claimTransactionNotifications(tx, teamId);
      if (!batch.length) return { notified: 0 };

      const notifications = new Notifications(db, tx, async (payload) => {
        await queueTransactionEmail(tx, teamId, { ...payload });
      });
      const result = await notifications.create(
        "transactions_created",
        teamId,
        { transactions: batch },
        { sendEmail: true },
      );
      if (result.emails.failed > 0) {
        throw new Error("Failed to send transaction notification emails");
      }

      return { notified: batch.length };
    });
    await dispatchTransactionEmails(teamId);
    return result;
  }
}
