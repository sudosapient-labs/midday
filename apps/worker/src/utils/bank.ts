import { createLoggerWithContext } from "@midday/logger";
import {
  type ApiAccount,
  type DbAccount,
  findMatchingAccount,
  type MatchingResult,
} from "@midday/supabase/account-matching";
import { createClient } from "@midday/supabase/job";
import type { Database } from "@midday/supabase/types";

const logger = createLoggerWithContext("worker:bank");

type TransactionInsert = Database["public"]["Tables"]["transactions"]["Insert"];

export type ProviderTransaction = {
  id: string;
  name: string;
  description: string | null;
  method: string | null;
  date: string;
  amount: number;
  currency: string;
  category: string | null;
  balance: number | null;
  counterparty_name: string | null;
  merchant_name: string | null;
};

/**
 * Parses errors returned by the banking tRPC API into a provider error code
 */
export function parseAPIError(error: unknown) {
  if (typeof error === "object" && error !== null && "error" in error) {
    const apiError = error as { error: { code: string; message: string } };

    return {
      code: apiError.error.code,
      message: apiError.error.message,
    };
  }

  // Handle TRPCClientError shape where providerCode is embedded in the message
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: string }).message;

    try {
      const parsed = JSON.parse(message);
      if (parsed.providerCode) {
        return {
          code: parsed.providerCode as string,
          message: (parsed.message ?? message) as string,
        };
      }
    } catch {
      // Not JSON, fall through
    }
  }

  return { code: "unknown", message: "An unknown error occurred" };
}

export function getClassification(type: string) {
  switch (type) {
    case "credit":
      return "credit";
    default:
      return "depository";
  }
}

export function transformTransaction({
  transaction,
  teamId,
  bankAccountId,
  notified,
}: {
  transaction: ProviderTransaction;
  teamId: string;
  bankAccountId: string;
  notified?: boolean;
}): TransactionInsert {
  return {
    name: transaction.name,
    description: transaction.description,
    date: transaction.date,
    amount: transaction.amount,
    currency: transaction.currency,
    // The banking API normalizes methods to the transaction_methods enum
    method: transaction.method as TransactionInsert["method"],
    internal_id: `${teamId}_${transaction.id}`,
    category_slug: transaction.category,
    bank_account_id: bankAccountId,
    balance: transaction.balance,
    team_id: teamId,
    counterparty_name: transaction.counterparty_name,
    merchant_name: transaction.merchant_name,
    // We only support posted transactions for now
    status: "posted",
    // If the transactions are being synced manually, we don't want to notify
    // And using upsert, we don't want to override the notified value
    ...(notified ? { notified } : {}),
  };
}

/**
 * Matches API accounts to existing database accounts and updates their account_id.
 * Used after a reconnect, when some providers issue new account IDs.
 */
export async function matchAndUpdateAccountIds({
  existingAccounts,
  apiAccounts,
  connectionId,
  provider,
}: {
  existingAccounts: DbAccount[];
  apiAccounts: ApiAccount[];
  connectionId: string;
  provider: string;
}): Promise<MatchingResult> {
  const supabase = createClient();
  const matchedDbIds = new Set<string>();
  const results: MatchingResult = { matched: 0, unmatched: 0, errors: 0 };

  for (const apiAccount of apiAccounts) {
    const match = findMatchingAccount(
      apiAccount,
      existingAccounts,
      matchedDbIds,
    );

    if (!match) {
      logger.warn(`No matching DB account found for ${provider} account`, {
        resource_id: apiAccount.resource_id,
        type: apiAccount.type,
        currency: apiAccount.currency,
      });
      results.unmatched++;
      continue;
    }

    matchedDbIds.add(match.id);

    const updates: Record<string, string | null> = {
      account_id: apiAccount.id,
    };
    if (apiAccount.resource_id) {
      updates.account_reference = apiAccount.resource_id;
    }
    if (apiAccount.iban) {
      updates.iban = apiAccount.iban;
    }

    const { error } = await supabase
      .from("bank_accounts")
      .update(updates)
      .eq("id", match.id);

    if (error) {
      logger.warn(`Failed to update ${provider} account`, {
        resource_id: apiAccount.resource_id,
        dbAccountId: match.id,
        error: error.message,
      });
      results.errors++;
    } else {
      results.matched++;
    }
  }

  logger.info(`Account matching complete for ${provider}`, {
    connectionId,
    ...results,
    totalApiAccounts: apiAccounts.length,
    totalDbAccounts: existingAccounts.length,
  });

  return results;
}
