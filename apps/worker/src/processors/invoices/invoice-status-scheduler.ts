import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { BaseProcessor } from "../base";

const PAGE_SIZE = 1000;

/**
 * Twice-daily scheduler: enqueues a status check for every unpaid or
 * overdue invoice.
 */
export class InvoiceStatusSchedulerProcessor extends BaseProcessor {
  async process(_job: Job) {
    const supabase = createClient();

    let count = 0;
    let lastId: string | undefined;

    // Use a cursor because completed checks remove invoices from this result set.
    for (;;) {
      let query = supabase
        .from("invoices")
        .select("id")
        .in("status", ["unpaid", "overdue"])
        .order("id")
        .limit(PAGE_SIZE);

      if (lastId) {
        query = query.gt("id", lastId);
      }

      const { data: invoices } = await query.throwOnError();

      await Promise.all(
        (invoices ?? []).map((invoice) =>
          triggerJob(
            "check-invoice-status",
            { invoiceId: invoice.id },
            "invoices",
          ),
        ),
      );

      count += invoices?.length ?? 0;
      lastId = invoices?.at(-1)?.id;

      if ((invoices?.length ?? 0) < PAGE_SIZE) {
        break;
      }
    }

    this.logger.info("Invoice status check jobs started", { count });

    return { count };
  }
}
