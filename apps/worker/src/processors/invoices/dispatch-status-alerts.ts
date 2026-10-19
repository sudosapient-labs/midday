import { deliverInvoiceStatusAlerts } from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { getDb } from "../../utils/db";

/** Dispatch the durable outbox independently of invoice-check retry state. */
export async function dispatchInvoiceStatusAlerts(invoiceId?: string) {
  return deliverInvoiceStatusAlerts(
    getDb(),
    async (id, payload) => {
      await triggerJob("notification", payload, "notifications", {
        jobId: `invoice-status-${id}`,
      });
    },
    invoiceId,
  );
}
