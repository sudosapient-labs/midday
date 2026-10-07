import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { BaseProcessor } from "../base";

/**
 * Twice-daily scheduler: enqueues a status check for every unpaid or
 * overdue invoice.
 */
export class InvoiceStatusSchedulerProcessor extends BaseProcessor {
  async process(_job: Job) {
    const supabase = createClient();

    const { data: invoices } = await supabase
      .from("invoices")
      .select("id")
      .in("status", ["unpaid", "overdue"])
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

    this.logger.info("Invoice status check jobs started", {
      count: invoices?.length ?? 0,
    });

    return { count: invoices?.length ?? 0 };
  }
}
