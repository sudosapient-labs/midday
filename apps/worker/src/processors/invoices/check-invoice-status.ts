import { TZDate } from "@date-fns/tz";
import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { subDays } from "date-fns";
import type { CheckInvoiceStatusPayload } from "../../schemas/invoices";
import { BaseProcessor } from "../base";

/**
 * Check an unpaid/overdue invoice: attach it to a matching recent transaction
 * and mark it paid, or mark it overdue once its due date has passed.
 */
export class CheckInvoiceStatusProcessor extends BaseProcessor<CheckInvoiceStatusPayload> {
  async process(job: Job<CheckInvoiceStatusPayload>) {
    const { invoiceId } = job.data;
    const supabase = createClient();

    const { data: invoice } = await supabase
      .from("invoices")
      .select(
        "id, status, due_date, currency, amount, team_id, file_path, invoice_number, file_size, template, customer_name",
      )
      .eq("id", invoiceId)
      .single();

    if (!invoice?.amount || !invoice.currency || !invoice.due_date) {
      this.logger.warn("Invoice data is missing", { invoiceId });
      return { status: "skipped" };
    }

    const timezone =
      (invoice.template as { timezone?: string } | null)?.timezone || "UTC";

    // Find recent transactions matching invoice amount and currency
    const { data: transactions } = await supabase
      .from("transactions")
      .select("id")
      .eq("team_id", invoice.team_id)
      .eq("amount", invoice.amount)
      .eq("currency", invoice.currency.toUpperCase())
      .gte("date", subDays(new TZDate(new Date(), timezone), 3).toISOString())
      .eq("is_fulfilled", false);

    if (transactions?.length === 1) {
      await supabase.from("transaction_attachments").insert({
        type: "application/pdf",
        path: invoice.file_path,
        transaction_id: transactions[0]!.id,
        team_id: invoice.team_id,
        name: `${invoice.invoice_number}.pdf`,
        size: invoice.file_size,
      });

      const paidAt = new Date().toISOString();
      await this.updateStatus(invoice, "paid", paidAt);

      return { status: "paid" };
    }

    const isOverdue =
      new TZDate(invoice.due_date, timezone) < new TZDate(new Date(), timezone);

    if (isOverdue && invoice.status === "unpaid") {
      await this.updateStatus(invoice, "overdue");
      return { status: "overdue" };
    }

    return { status: invoice.status };
  }

  private async updateStatus(
    invoice: {
      id: string;
      team_id: string;
      invoice_number: string | null;
      customer_name: string | null;
    },
    status: "paid" | "overdue",
    paidAt?: string,
  ) {
    const supabase = createClient();

    await supabase
      .from("invoices")
      .update({ status, paid_at: paidAt })
      .eq("id", invoice.id);

    this.logger.info(`Invoice status changed to ${status}`, {
      invoiceId: invoice.id,
    });

    if (!invoice.invoice_number) {
      return;
    }

    await triggerJob(
      "notification",
      {
        type: status === "paid" ? "invoice_paid" : "invoice_overdue",
        teamId: invoice.team_id,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        customerName: invoice.customer_name ?? undefined,
        ...(paidAt ? { paidAt } : {}),
      },
      "notifications",
    );
  }
}
