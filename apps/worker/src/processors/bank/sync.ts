import { triggerJob } from "@midday/job-client";
import { createLoggerWithContext } from "@midday/logger";
import { createClient } from "@midday/supabase/job";
import { trpc } from "@midday/trpc";
import type { BankProvider } from "../../schemas/bank";
import {
  getClassification,
  type ProviderTransaction,
  parseAPIError,
  transformTransaction,
} from "../../utils/bank";

const logger = createLoggerWithContext("worker:bank-sync");

const UPSERT_BATCH_SIZE = 500;

// Pause between accounts during background syncs to avoid provider rate limits
const BACKGROUND_ACCOUNT_DELAY_MS = 10_000;

// Delay transaction notifications so transactions from all accounts are grouped
const TRANSACTION_NOTIFICATION_DELAY_MS = 5 * 60 * 1000;

type AccountType =
  | "credit"
  | "other_asset"
  | "other_liability"
  | "depository"
  | "loan";

type SyncAccountParams = {
  id: string;
  teamId: string;
  accountId: string;
  accountType: AccountType;
  accessToken?: string;
  errorRetries?: number | null;
  provider: BankProvider;
  currency?: string;
  manualSync?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Upsert a batch of provider transactions, then enqueue enrichment and
 * inbox matching for the rows that were newly inserted.
 */
async function upsertTransactions({
  transactions,
  teamId,
  bankAccountId,
  manualSync,
}: {
  transactions: ProviderTransaction[];
  teamId: string;
  bankAccountId: string;
  manualSync?: boolean;
}) {
  const supabase = createClient();

  const formattedTransactions = transactions.map((transaction) =>
    transformTransaction({
      transaction,
      teamId,
      bankAccountId,
      notified: manualSync,
    }),
  );

  // Skip duplicates based on internal_id
  const { data: upsertedTransactions } = await supabase
    .from("transactions")
    .upsert(formattedTransactions, {
      onConflict: "internal_id",
      ignoreDuplicates: true,
    })
    .select("id")
    .throwOnError();

  const transactionIds = upsertedTransactions?.map((tx) => tx.id) ?? [];

  if (transactionIds.length === 0) {
    return 0;
  }

  await triggerJob(
    "enrich-transactions",
    { transactionIds, teamId },
    "transactions",
  );

  await triggerJob(
    "match-transactions-bidirectional",
    { teamId, newTransactionIds: transactionIds },
    "inbox",
  );

  return transactionIds.length;
}

/**
 * Sync balance and transactions for a single bank account
 */
export async function syncBankAccount({
  id,
  teamId,
  accountId,
  accountType,
  accessToken,
  errorRetries,
  provider,
  currency: storedCurrency,
  manualSync,
}: SyncAccountParams): Promise<{ transactions: number }> {
  const supabase = createClient();
  const classification = getClassification(accountType);

  // Only heal currency when we know for certain it's "XXX"
  const needsCurrencyHeal = storedCurrency?.toUpperCase() === "XXX";
  let currencyHealed = false;

  // Balance
  try {
    const balanceResult = await trpc.banking.getBalance.query({
      provider,
      id: accountId,
      accessToken,
      accountType,
    });

    const balanceData = balanceResult.data as {
      amount: number;
      currency: string;
      available_balance?: number | null;
      credit_limit?: number | null;
    } | null;

    const balance = balanceData?.amount ?? null;

    // Update balance (including zero/negative for overdrafts) and reset errors
    if (balance !== null) {
      const updatePayload: Record<string, unknown> = {
        balance,
        available_balance: balanceData?.available_balance ?? null,
        credit_limit: balanceData?.credit_limit ?? null,
        error_details: null,
        error_retries: null,
      };

      if (
        needsCurrencyHeal &&
        balanceData?.currency &&
        balanceData.currency.toUpperCase() !== "XXX"
      ) {
        updatePayload.currency = balanceData.currency;
        currencyHealed = true;
      }

      await supabase.from("bank_accounts").update(updatePayload).eq("id", id);
    } else {
      await supabase
        .from("bank_accounts")
        .update({ error_details: null, error_retries: null })
        .eq("id", id);
    }
  } catch (error) {
    const parsedError = parseAPIError(error);

    logger.error("Failed to sync account balance", {
      accountId: id,
      error: parsedError,
    });

    if (parsedError.code === "disconnected") {
      await supabase
        .from("bank_accounts")
        .update({
          error_details: parsedError.message,
          error_retries: (errorRetries ?? 0) + 1,
        })
        .eq("id", id);

      throw error;
    }
  }

  // Transactions
  const transactionsResult = await trpc.banking.getProviderTransactions.query({
    provider,
    accountId,
    accountType: classification,
    accessToken,
    // Manual syncs fetch all available transactions
    latest: !manualSync,
  });

  await supabase
    .from("bank_accounts")
    .update({ error_details: null, error_retries: null })
    .eq("id", id);

  const transactions = (
    (transactionsResult.data ?? []) as ProviderTransaction[]
  ).map((tx) => ({
    ...tx,
    merchant_name: tx.merchant_name ?? null,
  }));

  if (transactions.length === 0) {
    return { transactions: 0 };
  }

  // Derive currency from transactions if the balance didn't provide one
  if (needsCurrencyHeal && !currencyHealed) {
    const txCurrency = transactions.find(
      (tx) => tx.currency && tx.currency.toUpperCase() !== "XXX",
    )?.currency;

    if (txCurrency) {
      await supabase
        .from("bank_accounts")
        .update({ currency: txCurrency })
        .eq("id", id);
    }
  }

  let inserted = 0;
  for (let i = 0; i < transactions.length; i += UPSERT_BATCH_SIZE) {
    inserted += await upsertTransactions({
      transactions: transactions.slice(i, i + UPSERT_BATCH_SIZE),
      teamId,
      bankAccountId: id,
      manualSync,
    });
  }

  return { transactions: inserted };
}

/**
 * Check a connection's status with the provider and sync every enabled account.
 * Throws when the connection itself cannot be synced; individual account
 * failures are recorded on the account and do not fail the connection.
 */
export async function syncBankConnection({
  connectionId,
  manualSync = false,
}: {
  connectionId: string;
  manualSync?: boolean;
}): Promise<{
  status: "connected" | "disconnected";
  accountsSynced: number;
  accountsFailed: number;
  transactions: number;
}> {
  const supabase = createClient();

  const { data: connection } = await supabase
    .from("bank_connections")
    .select("provider, access_token, reference_id, team_id")
    .eq("id", connectionId)
    .single()
    .throwOnError();

  if (!connection) {
    throw new Error("Connection not found");
  }

  const connectionResult = await trpc.banking.connectionStatus.query({
    id: connection.reference_id ?? undefined,
    provider: connection.provider as BankProvider,
    accessToken: connection.access_token ?? undefined,
  });

  const connectionData = connectionResult.data;

  if (!connectionData) {
    throw new Error("Failed to get connection status");
  }

  if (connectionData.status !== "connected") {
    logger.info("Connection disconnected", { connectionId });

    await supabase
      .from("bank_connections")
      .update({ status: "disconnected" })
      .eq("id", connectionId);

    return {
      status: "disconnected",
      accountsSynced: 0,
      accountsFailed: 0,
      transactions: 0,
    };
  }

  await supabase
    .from("bank_connections")
    .update({ status: "connected", last_accessed: new Date().toISOString() })
    .eq("id", connectionId);

  const query = supabase
    .from("bank_accounts")
    .select("id, team_id, account_id, type, currency, error_retries")
    .eq("bank_connection_id", connectionId)
    .eq("enabled", true)
    .eq("manual", false);

  // Skip accounts with more than 3 error retries during background sync
  // Allow all accounts during manual sync to clear errors after reconnect
  if (!manualSync) {
    query.or("error_retries.lt.4,error_retries.is.null");
  }

  const { data: bankAccounts } = await query.throwOnError();

  let accountsSynced = 0;
  let accountsFailed = 0;
  let transactions = 0;

  for (const [index, account] of (bankAccounts ?? []).entries()) {
    if (!manualSync && index > 0) {
      await sleep(BACKGROUND_ACCOUNT_DELAY_MS);
    }

    try {
      const result = await syncBankAccount({
        id: account.id,
        teamId: account.team_id,
        accountId: account.account_id,
        accountType: (account.type ?? "depository") as AccountType,
        accessToken: connection.access_token ?? undefined,
        errorRetries: account.error_retries,
        provider: connection.provider as BankProvider,
        currency: account.currency ?? undefined,
        manualSync,
      });

      accountsSynced++;
      transactions += result.transactions;
    } catch (error) {
      accountsFailed++;
      logger.error("Failed to sync bank account", {
        connectionId,
        accountId: account.id,
        error:
          error instanceof Error ? error.message : parseAPIError(error).message,
      });
    }
  }

  // Background syncs notify about new transactions after a short delay
  if (!manualSync) {
    await triggerJob(
      "transaction-notifications",
      { teamId: connection.team_id },
      "bank",
      {
        delay: TRANSACTION_NOTIFICATION_DELAY_MS,
        // One pending notification per team collects every connection's sync
        jobId: `transaction-notifications-${connection.team_id}-${Math.floor(
          Date.now() / TRANSACTION_NOTIFICATION_DELAY_MS,
        )}`,
      },
    );
  }

  // If all accounts have 3+ error retries, disconnect the connection
  // so the user is notified and can reconnect the bank
  const { data: accountErrors } = await supabase
    .from("bank_accounts")
    .select("id, error_retries")
    .eq("bank_connection_id", connectionId)
    .eq("manual", false)
    .eq("enabled", true);

  if (
    accountErrors?.length &&
    accountErrors.every((account) => (account.error_retries ?? 0) >= 3)
  ) {
    logger.info("All bank accounts have 3+ error retries, disconnecting", {
      connectionId,
    });

    await supabase
      .from("bank_connections")
      .update({ status: "disconnected" })
      .eq("id", connectionId);
  }

  return {
    status: "connected",
    accountsSynced,
    accountsFailed,
    transactions,
  };
}
