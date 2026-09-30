import type { ApiAccount } from "@midday/supabase/account-matching";
import { createClient } from "@midday/supabase/job";
import { trpc } from "@midday/trpc";
import type { Job } from "bullmq";
import type { ReconnectConnectionPayload } from "../../schemas/bank";
import { matchAndUpdateAccountIds } from "../../utils/bank";
import { BaseProcessor } from "../base";
import { syncBankConnection } from "./sync";

/**
 * Reconnect a bank connection after the user re-authorized it.
 * Some providers issue new account IDs on reconnect, so existing accounts are
 * re-matched to the provider's accounts before a full sync runs.
 */
export class ReconnectConnectionProcessor extends BaseProcessor<ReconnectConnectionPayload> {
  async process(job: Job<ReconnectConnectionPayload>) {
    const { teamId, connectionId, provider } = job.data;
    const supabase = createClient();

    const { data: existingAccounts } = await supabase
      .from("bank_accounts")
      .select("id, account_reference, iban, type, currency, name")
      .eq("bank_connection_id", connectionId)
      .eq("team_id", teamId);

    const { data: connection } = await supabase
      .from("bank_connections")
      .select("access_token, enrollment_id, reference_id, institution_id")
      .eq("id", connectionId)
      .eq("team_id", teamId)
      .single();

    if (!connection) {
      throw new Error("Connection not found");
    }

    let apiAccounts: ApiAccount[] | undefined;

    switch (provider) {
      case "gocardless": {
        // GoCardless issues a new requisition, so update the reference first
        const connectionResponse =
          await trpc.banking.connectionByReference.query({ reference: teamId });

        const referenceId = connectionResponse?.data?.id;

        if (!referenceId) {
          throw new Error("Connection not found");
        }

        await supabase
          .from("bank_connections")
          .update({ reference_id: referenceId })
          .eq("id", connectionId)
          .eq("team_id", teamId);

        const accountsResponse = await trpc.banking.getProviderAccounts.query({
          id: referenceId,
          provider: "gocardless",
        });

        apiAccounts = accountsResponse.data as ApiAccount[] | undefined;
        break;
      }

      case "teller": {
        if (!connection.access_token || !connection.enrollment_id) {
          throw new Error("Teller connection not found");
        }

        const accountsResponse = await trpc.banking.getProviderAccounts.query({
          id: connection.enrollment_id,
          provider: "teller",
          accessToken: connection.access_token,
        });

        apiAccounts = accountsResponse.data as ApiAccount[] | undefined;
        break;
      }

      case "enablebanking": {
        if (!connection.reference_id) {
          throw new Error("EnableBanking connection not found");
        }

        const accountsResponse = await trpc.banking.getProviderAccounts.query({
          id: connection.reference_id,
          provider: "enablebanking",
        });

        apiAccounts = accountsResponse.data as ApiAccount[] | undefined;
        break;
      }

      case "plaid": {
        // Plaid update mode preserves account IDs; only verify the connection
        if (!connection.access_token) {
          throw new Error("Plaid connection not found");
        }

        const accountsResponse = await trpc.banking.getProviderAccounts.query({
          provider: "plaid",
          accessToken: connection.access_token,
          institutionId: connection.institution_id ?? undefined,
        });

        if (!accountsResponse.data) {
          throw new Error("Plaid accounts verification failed");
        }
        break;
      }
    }

    if (provider !== "plaid") {
      if (!apiAccounts) {
        throw new Error(`${provider} accounts not found`);
      }

      if (existingAccounts?.length) {
        await matchAndUpdateAccountIds({
          existingAccounts,
          apiAccounts,
          connectionId,
          provider,
        });
      }
    }

    // Sync inline so the job the dashboard polls covers the full reconnect
    return syncBankConnection({ connectionId, manualSync: true });
  }
}
