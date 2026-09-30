import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { bankConnectionsRouter } from "../../trpc/routers/bank-connections";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const CONN_ID = "d1e2f3a4-b5c6-7890-abcd-ef1234567890";

const createCaller = createCallerFactory(bankConnectionsRouter);

describe("tRPC: bankConnections.get", () => {
  beforeEach(() => {
    mocks.getBankConnections.mockReset();
    mocks.getBankConnections.mockImplementation(() => Promise.resolve([]));
  });

  test("returns connections for team", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.get({})).toEqual([]);
    expect(mocks.getBankConnections).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ teamId: "test-team-id" }),
    );
  });

  test("passes enabled filter when provided", async () => {
    const caller = createCaller(createTestContext());
    await caller.get({ enabled: true });

    expect(mocks.getBankConnections).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teamId: "test-team-id",
        enabled: true,
      }),
    );
  });
});

describe("tRPC: bankConnections.delete", () => {
  beforeEach(() => {
    mocks.deleteBankConnection.mockReset();
    mocks.deleteBankConnection.mockImplementation(() =>
      Promise.resolve({
        id: CONN_ID,
        referenceId: "ref-xyz",
        provider: "gocardless",
        accessToken: "token-abc",
      }),
    );
  });

  test("deletes connection and returns row", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: CONN_ID });

    expect(result).toMatchObject({
      id: CONN_ID,
      referenceId: "ref-xyz",
      provider: "gocardless",
    });
    expect(mocks.deleteBankConnection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: CONN_ID, teamId: "test-team-id" }),
    );
  });

  test("throws when connection is not found", async () => {
    mocks.deleteBankConnection.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());

    await expect(caller.delete({ id: CONN_ID })).rejects.toThrow(
      "Bank connection not found",
    );
  });
});

describe("tRPC: bankConnections job dispatch", () => {
  beforeEach(() => {
    mocks.triggerJob.mockReset();
    mocks.triggerJob.mockImplementation(() =>
      Promise.resolve({ id: "bank:1" }),
    );
    mocks.getBankConnections.mockReset();
    mocks.getBankConnections.mockImplementation(() =>
      Promise.resolve([{ id: CONN_ID }]),
    );
    mocks.deleteBankConnection.mockReset();
    mocks.deleteBankConnection.mockImplementation(() =>
      Promise.resolve({
        id: CONN_ID,
        referenceId: "ref-xyz",
        provider: "gocardless",
        accessToken: "token-abc",
      }),
    );
    mocks.createBankConnection.mockReset();
    mocks.createBankConnection.mockImplementation(() =>
      Promise.resolve({ id: CONN_ID }),
    );
  });

  test("create enqueues initial-bank-setup and returns the job id", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.create({
      provider: "gocardless",
      referenceId: "ref-xyz",
      accounts: [
        {
          accountId: "acc-1",
          institutionId: "inst-1",
          bankName: "Test Bank",
          name: "Checking",
          currency: "EUR",
          enabled: true,
          balance: 0,
          type: "depository",
        },
      ],
    } as Parameters<ReturnType<typeof createCaller>["create"]>[0]);

    expect(result).toEqual({ id: "bank:1" });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "initial-bank-setup",
      { connectionId: CONN_ID, teamId: "test-team-id" },
      "bank",
    );
  });

  test("delete enqueues provider cleanup on the bank queue", async () => {
    const caller = createCaller(createTestContext());
    await caller.delete({ id: CONN_ID });

    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "delete-connection",
      {
        referenceId: "ref-xyz",
        provider: "gocardless",
        accessToken: "token-abc",
      },
      "bank",
    );
  });

  test("sync enqueues a manual sync for an owned connection", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.sync({ connectionId: CONN_ID });

    expect(result).toEqual({ id: "bank:1" });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "sync-connection",
      { connectionId: CONN_ID, teamId: "test-team-id", manualSync: true },
      "bank",
    );
  });

  test("sync rejects a connection owned by another team", async () => {
    mocks.getBankConnections.mockImplementation(() => Promise.resolve([]));

    const caller = createCaller(createTestContext());

    await expect(caller.sync({ connectionId: CONN_ID })).rejects.toThrow(
      "Bank connection not found",
    );
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });

  test("triggerReconnect enqueues reconnect-connection", async () => {
    const caller = createCaller(createTestContext());
    await caller.triggerReconnect({
      connectionId: CONN_ID,
      provider: "teller",
    });

    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "reconnect-connection",
      { teamId: "test-team-id", connectionId: CONN_ID, provider: "teller" },
      "bank",
    );
  });
});
