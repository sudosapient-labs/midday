import { TZDate } from "@date-fns/tz";
import {
  markInvoiceOverdue,
  markInvoicePaidFromTransaction,
} from "@midday/db/queries";
import { triggerJob } from "@midday/job-client";
import { createClient } from "@midday/supabase/job";
import type { Job } from "bullmq";
import { format, subDays } from "date-fns";
import type { CheckInvoiceStatusPayload } from "../../schemas/invoices";
import { getDb } from "../../utils/db";
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
        "id, status, paid_at, due_date, currency, amount, team_id, file_path, invoice_number, file_size, template, customer_name",
      )
      .eq("id", invoiceId)
      .maybeSingle()
      .throwOnError();

    if (!invoice?.amount || !invoice.currency || !invoice.due_date) {
      this.logger.warn("Invoice data is missing", { invoiceId });
      return { status: "skipped" };
    }

    // Recover an enqueue that failed after a successful commit. Only retries
    // resend: daily checks of overdue invoices must not repeat old alerts.
    if (job.attemptsMade > 0) {
      if (invoice.status === "paid") {
        await this.notify(invoice, "paid", invoice.paid_at ?? undefined);
      } else if (invoice.status === "overdue") {
        await this.notify(invoice, "overdue");
      }
    }

    // A retried job may find the invoice already settled or cancelled
    if (invoice.status !== "unpaid" && invoice.status !== "overdue") {
      return { status: invoice.status };
    }

    const timezone =
      (invoice.template as { timezone?: string } | null)?.timezone || "UTC";
    const now = new TZDate(new Date(), timezone);

    // Match recent transactions with the invoice amount and currency. The
    // claim, attachment and status change are one transaction, so a
    // transaction can't pay two invoices and a failure leaves nothing half done.
    const paidAt = new Date().toISOString();
    const match = await markInvoicePaidFromTransaction(getDb(), {
      invoiceId: invoice.id,
      teamId: invoice.team_id,
      amount: invoice.amount,
      currency: invoice.currency.toUpperCase(),
      since: subDays(now, 3).toISOString().slice(0, 10),
      paidAt,
      attachment: {
        path: invoice.file_path,
        name: `${invoice.invoice_number}.pdf`,
        size: invoice.file_size,
      },
    });

    if (match === "paid") {
      await this.notify(invoice, "paid", paidAt);
      this.logger.info("Invoice status changed to paid", { invoiceId });
      return { status: "paid" };
    }

    if (match === "already_settled") {
      return { status: "skipped" };
    }

    // `due_date` is stored as UTC midnight of the due day the user picked, so
    // the invoice is overdue once that calendar day has ended in its timezone
    // (comparing instants would flag it at the start of the due day)
    const dueDay = new Date(invoice.due_date).toISOString().slice(0, 10);
    const isOverdue = format(now, "yyyy-MM-dd") > dueDay;

    if (isOverdue && invoice.status === "unpaid") {
      const updated = await markInvoiceOverdue(getDb(), {
        invoiceId: invoice.id,
        teamId: invoice.team_id,
      });

      if (updated) {
        await this.notify(invoice, "overdue");
        this.logger.info("Invoice status changed to overdue", { invoiceId });
      }

      return { status: updated ? "overdue" : "skipped" };
    }

    return { status: invoice.status };
  }

  /** Enqueue after commit; deterministic IDs deduplicate retry attempts. */
  private async notify(
    invoice: {
      id: string;
      team_id: string;
      invoice_number: string | null;
      customer_name: string | null;
    },
    status: "paid" | "overdue",
    paidAt?: string,
  ) {
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
      { jobId: `invoice-${status}-${invoice.id}` },
    );
  }
}
