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

    // Page through the table: Supabase caps a single response at 1,000 rows
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: invoices } = await supabase
        .from("invoices")
        .select("id")
        .in("status", ["unpaid", "overdue"])
        .order("id")
        .range(from, from + PAGE_SIZE - 1)
        .throwOnError();

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

      if ((invoices?.length ?? 0) < PAGE_SIZE) {
        break;
      }
    }

    this.logger.info("Invoice status check jobs started", { count });

    return { count };
  }
}
