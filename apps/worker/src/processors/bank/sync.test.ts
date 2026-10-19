import { beforeEach, describe, expect, mock, test } from "bun:test";

type Op = { method: string; args: unknown[] };
type QueryCall = { table: string; ops: Op[] };

const calls: QueryCall[] = [];
let resolveQuery: (call: QueryCall) => unknown = () => ({ data: null });

/**
 * Minimal chainable Supabase fake: every builder method records itself and
 * returns the builder; awaiting it resolves through `resolveQuery`.
 */
function createBuilder(table: string) {
  const call: QueryCall = { table, ops: [] };
  calls.push(call);

  const builder: Record<string, unknown> = {};
  for (const method of [
    "select",
    "update",
    "upsert",
    "eq",
    "or",
    "in",
    "order",
    "single",
    "throwOnError",
  ]) {
    builder[method] = (...args: unknown[]) => {
      call.ops.push({ method, args });
      return builder;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: makes the fake awaitable like a Supabase query
  builder.then = (
    onFulfilled: (value: unknown) => unknown,
    onRejected: (reason: unknown) => unknown,
  ) => Promise.resolve(resolveQuery(call)).then(onFulfilled, onRejected);

  return builder;
}

const hasOp = (call: QueryCall, method: string) =>
  call.ops.some((op) => op.method === method);

const opArgs = (call: QueryCall, method: string) =>
  call.ops.find((op) => op.method === method)?.args;

const triggerJob = mock((..._args: unknown[]) =>
  Promise.resolve({ id: "q:1" }),
);
const connectionStatus = mock(() =>
  Promise.resolve({ data: { status: "connected" } }),
);
const getBalance = mock(() =>
  Promise.resolve({ data: { amount: 100, currency: "EUR" } }),
);
const getProviderTransactions = mock(() =>
  Promise.resolve({
    data: [
      {
        id: "tx-1",
        name: "Coffee",
        description: null,
        method: "card_purchase",
        date: "2026-09-29",
        amount: -4.5,
        currency: "EUR",
        category: null,
        balance: null,
        counterparty_name: null,
      },
    ],
  }),
);

mock.module("@midday/supabase/job", () => ({
  createClient: () => ({ from: (table: string) => createBuilder(table) }),
}));

mock.module("@midday/job-client", () => ({ triggerJob }));

mock.module("@midday/trpc", () => ({
  trpc: {
    banking: {
      connectionStatus: { query: connectionStatus },
      getBalance: { query: getBalance },
      getProviderTransactions: { query: getProviderTransactions },
    },
  },
}));

const { syncBankConnection } = await import("./sync");

const CONNECTION_ID = "5f0c1a7e-3c1b-4d0e-9a57-2b8f3f1e2d11";
const TEAM_ID = "0b6f4a2c-8d7e-4f1a-9c3b-5e2d1f0a9b88";

function account(id: string, errorRetries: number | null = null) {
  return {
    id,
    team_id: TEAM_ID,
    account_id: `provider-${id}`,
    type: "depository",
    currency: "EUR",
    error_retries: errorRetries,
  };
}

function defaultResolver(accounts: ReturnType<typeof account>[]) {
  return (call: QueryCall) => {
    if (call.table === "bank_connections" && hasOp(call, "single")) {
      return {
        data: {
          provider: "gocardless",
          access_token: null,
          reference_id: "ref-1",
          team_id: TEAM_ID,
        },
      };
    }

    if (call.table === "bank_accounts" && hasOp(call, "select")) {
      return { data: accounts };
    }

    if (call.table === "transactions" && hasOp(call, "upsert")) {
      return { data: [{ id: "c9d8e7f6-1111-4222-8333-944455556666" }] };
    }

    return { data: null, error: null };
  };
}

beforeEach(() => {
  calls.length = 0;
  triggerJob.mockClear();
  connectionStatus.mockClear();
  getBalance.mockClear();
  getProviderTransactions.mockClear();
  connectionStatus.mockImplementation(() =>
    Promise.resolve({ data: { status: "connected" } }),
  );
  getBalance.mockImplementation(() =>
    Promise.resolve({ data: { amount: 100, currency: "EUR" } }),
  );
});

describe("syncBankConnection", () => {
  test("marks the connection disconnected when the provider reports it", async () => {
    connectionStatus.mockImplementation(() =>
      Promise.resolve({ data: { status: "disconnected" } }),
    );
    resolveQuery = defaultResolver([account("a1")]);

    const result = await syncBankConnection({ connectionId: CONNECTION_ID });

    expect(result.status).toBe("disconnected");
    expect(getBalance).not.toHaveBeenCalled();
    const update = calls.find(
      (call) => call.table === "bank_connections" && hasOp(call, "update"),
    );
    expect(opArgs(update!, "update")).toEqual([{ status: "disconnected" }]);
  });

  test("manual sync imports transactions and enqueues enrichment and matching", async () => {
    resolveQuery = defaultResolver([account("a1")]);

    const result = await syncBankConnection({
      connectionId: CONNECTION_ID,
      manualSync: true,
    });

    expect(result).toEqual({
      status: "connected",
      accountsSynced: 1,
      accountsFailed: 0,
      transactions: 1,
    });

    // Manual syncs fetch full history and include accounts with errors
    expect(getProviderTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ latest: false }),
    );
    const accountQuery = calls.find(
      (call) => call.table === "bank_accounts" && hasOp(call, "select"),
    );
    expect(hasOp(accountQuery!, "or")).toBe(false);

    const upsert = calls.find((call) => hasOp(call, "upsert"));
    const [rows, options] = opArgs(upsert!, "upsert") as [
      Record<string, unknown>[],
      Record<string, unknown>,
    ];
    expect(rows[0]).toMatchObject({
      internal_id: `${TEAM_ID}_tx-1`,
      team_id: TEAM_ID,
      merchant_name: null,
      notified: true,
    });
    expect(options).toEqual({
      onConflict: "internal_id",
      ignoreDuplicates: true,
    });

    const jobNames = triggerJob.mock.calls.map((args) => args[0]);
    expect(jobNames).toEqual([
      "enrich-transactions",
      "match-transactions-bidirectional",
    ]);
  });

  test("background sync skips erroring accounts and schedules notifications", async () => {
    resolveQuery = defaultResolver([account("a1")]);

    await syncBankConnection({ connectionId: CONNECTION_ID });

    const accountQuery = calls.find(
      (call) => call.table === "bank_accounts" && hasOp(call, "select"),
    );
    expect(opArgs(accountQuery!, "or")).toEqual([
      "error_retries.lt.4,error_retries.is.null",
    ]);
    expect(getProviderTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ latest: true }),
    );

    const notification = triggerJob.mock.calls.find(
      (args) => args[0] === "transaction-notifications",
    );
    expect(notification?.[1]).toEqual({ teamId: TEAM_ID });
    expect(notification?.[2]).toBe("bank");
    expect(notification?.[3]).toMatchObject({ delay: 5 * 60 * 1000 });
  });

  test("a disconnected account is recorded without failing the connection", async () => {
    getBalance.mockImplementation(() =>
      Promise.reject({ error: { code: "disconnected", message: "expired" } }),
    );
    resolveQuery = defaultResolver([account("a1", 1)]);

    const result = await syncBankConnection({
      connectionId: CONNECTION_ID,
      manualSync: true,
    });

    expect(result.accountsFailed).toBe(1);
    expect(result.accountsSynced).toBe(0);

    const errorUpdate = calls.find(
      (call) =>
        call.table === "bank_accounts" &&
        hasOp(call, "update") &&
        (opArgs(call, "update")?.[0] as Record<string, unknown>)
          ?.error_retries === 2,
    );
    expect(errorUpdate).toBeDefined();
  });

  test("disconnects the connection when every account has 3+ error retries", async () => {
    resolveQuery = defaultResolver([account("a1", 3)]);

    await syncBankConnection({ connectionId: CONNECTION_ID, manualSync: true });

    const disconnect = calls.find(
      (call) =>
        call.table === "bank_connections" &&
        hasOp(call, "update") &&
        (opArgs(call, "update")?.[0] as Record<string, unknown>)?.status ===
          "disconnected",
    );
    expect(disconnect).toBeDefined();
  });
});
