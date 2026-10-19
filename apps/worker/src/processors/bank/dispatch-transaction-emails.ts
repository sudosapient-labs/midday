import {
  deliverTransactionEmails,
  TransactionEmailRetryableError,
} from "@midday/db/queries";
import { type CreateEmailOptions, Resend } from "resend";
import { getDb } from "../../utils/db";

/** Send only committed email work; failures leave it pending for the daily sweep. */
export async function dispatchTransactionEmails(teamId?: string) {
  const resend = new Resend(process.env.RESEND_API_KEY!);
  return deliverTransactionEmails(
    getDb(),
    async (id, payload) => {
      let response: Awaited<ReturnType<typeof resend.emails.send>>;
      try {
        response = await resend.emails.send(payload as CreateEmailOptions, {
          idempotencyKey: `transaction-email-${id}`,
        });
      } catch (error) {
        // Transport failures have no definitive provider response and remain retryable.
        throw new TransactionEmailRetryableError(String(error));
      }
      const { error } = response;
      if (error) {
        if (
          error.name === "validation_error" ||
          error.name === "missing_required_field"
        ) {
          throw new Error(`Transaction email failed: ${error.message}`);
        }
        // Rate limits, provider outages and fixable service configuration errors
        // must not permanently exhaust a committed email.
        throw new TransactionEmailRetryableError(error.message);
      }
    },
    teamId,
  );
}
