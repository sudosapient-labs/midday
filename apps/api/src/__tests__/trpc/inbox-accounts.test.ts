import { beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { inboxAccountsRouter } from "../../trpc/routers/inbox-accounts";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const ACCOUNT_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

const createCaller = createCallerFactory(inboxAccountsRouter);

describe("tRPC: inboxAccounts.get", () => {
  beforeEach(() => {
    mocks.getInboxAccounts.mockReset();
    mocks.getInboxAccounts.mockImplementation(() => Promise.resolve([]));
  });

  test("returns inbox accounts for the team", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.get();

    expect(result).toEqual([]);
    expect(mocks.getInboxAccounts).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("propagates when getInboxAccounts fails", async () => {
    mocks.getInboxAccounts.mockImplementation(() =>
      Promise.reject(new Error("database unavailable")),
    );

    const caller = createCaller(createTestContext());

    await expect(caller.get()).rejects.toThrow("database unavailable");
  });
});

describe("tRPC: inboxAccounts.delete", () => {
  beforeEach(() => {
    mocks.deleteInboxAccount.mockReset();
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve({ id: ACCOUNT_ID, scheduleId: null }),
    );
  });

  test("returns the deleted row id", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: ACCOUNT_ID });

    expect(result).toEqual({ id: ACCOUNT_ID, scheduleId: null });
    expect(mocks.deleteInboxAccount).toHaveBeenCalledWith(expect.anything(), {
      id: ACCOUNT_ID,
      teamId: "test-team-id",
    });
  });

  test("returns null when nothing was deleted", async () => {
    mocks.deleteInboxAccount.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());
    expect(await caller.delete({ id: ACCOUNT_ID })).toBeNull();
  });
});

describe("tRPC: inboxAccounts.delete scheduler cleanup", () => {
  beforeEach(() => {
    mocks.removeJobScheduler.mockReset();
    mocks.removeJobScheduler.mockImplementation(() => Promise.resolve(true));
    mocks.deleteInboxAccount.mockReset();
    mocks.deleteInboxAccount.mockImplementation(() =>
      Promise.resolve({
        id: ACCOUNT_ID,
        scheduleId: `inbox-sync-${ACCOUNT_ID}`,
      }),
    );
  });

  test("removes the account's BullMQ sync scheduler", async () => {
    const caller = createCaller(createTestContext());
    await caller.delete({ id: ACCOUNT_ID });

    expect(mocks.getQueue).toHaveBeenCalledWith("inbox-provider");
    expect(mocks.removeJobScheduler).toHaveBeenCalledWith(
      `scheduler:inbox-sync-${ACCOUNT_ID}`,
    );
  });

  test("still returns the deleted row when scheduler removal fails", async () => {
    mocks.removeJobScheduler.mockImplementation(() =>
      Promise.reject(new Error("redis unavailable")),
    );

    const caller = createCaller(createTestContext());
    const result = await caller.delete({ id: ACCOUNT_ID });

    expect(result).toMatchObject({ id: ACCOUNT_ID });
  });

  test("does not touch schedulers when nothing was deleted", async () => {
    mocks.deleteInboxAccount.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());
    await caller.delete({ id: ACCOUNT_ID });

    expect(mocks.removeJobScheduler).not.toHaveBeenCalled();
  });
});

describe("tRPC: inboxAccounts.sync", () => {
  beforeEach(() => {
    mocks.triggerJob.mockReset();
    mocks.triggerJob.mockImplementation(() =>
      Promise.resolve({ id: "inbox-provider:7" }),
    );
    mocks.getInboxAccountById.mockReset();
    mocks.getInboxAccountById.mockImplementation(() =>
      Promise.resolve({ id: ACCOUNT_ID }),
    );
  });

  test("enqueues a BullMQ sync job with the team id for status polling", async () => {
    const caller = createCaller(createTestContext());
    const result = await caller.sync({ id: ACCOUNT_ID, manualSync: true });

    expect(result).toEqual({ id: "inbox-provider:7" });
    expect(mocks.triggerJob).toHaveBeenCalledWith(
      "sync-scheduler",
      { id: ACCOUNT_ID, teamId: "test-team-id", manualSync: true },
      "inbox-provider",
    );
  });

  test("rejects accounts that do not belong to the team", async () => {
    mocks.getInboxAccountById.mockImplementation(() => Promise.resolve(null));

    const caller = createCaller(createTestContext());

    await expect(caller.sync({ id: ACCOUNT_ID })).rejects.toThrow(
      "Inbox account not found",
    );
    expect(mocks.triggerJob).not.toHaveBeenCalled();
  });
});
