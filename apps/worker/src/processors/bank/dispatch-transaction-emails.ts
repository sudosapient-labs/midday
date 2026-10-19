import { deliverTransactionEmails } from "@midday/db/queries";
import { type CreateEmailOptions, Resend } from "resend";
import { getDb } from "../../utils/db";

/** Send only committed email work; failures leave it pending for the daily sweep. */
export async function dispatchTransactionEmails(teamId?: string) {
  const resend = new Resend(process.env.RESEND_API_KEY!);
  return deliverTransactionEmails(
    getDb(),
    async (id, payload) => {
      const { error } = await resend.emails.send(
        payload as CreateEmailOptions,
        {
          idempotencyKey: `transaction-email-${id}`,
        },
      );
      if (error) throw new Error(`Transaction email failed: ${error.message}`);
    },
    teamId,
  );
}
