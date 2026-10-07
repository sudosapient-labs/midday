import { beforeEach, expect, mock, test } from "bun:test";
import { mocks } from "../src/__tests__/setup";

const getAppByAppId = mock(async () => ({
  id: "discord-app",
  appId: "discord",
  teamId: "team-a",
  config: {},
  settings: [
    { id: "matches", value: true },
    { id: "transactions", value: true },
  ],
}));
const getPlatformIdentityById = mock(async () => null);
const shouldSendNotification = mock(async () => true);
const listDueProviderNotificationBatches = mock(async (): Promise<any[]> => []);

mock.module("@midday/db/queries", () => ({
  ...mocks,
  getAppByAppId,
  getPlatformIdentityById,
  listDueProviderNotificationBatches,
  listPlatformIdentitiesForTeam: mock(async () => []),
  markProviderNotificationBatchSent: mock(async () => {}),
  queueProviderNotificationBatch: mock(async () => {}),
  shouldSendNotification,
}));

const send = mock(async (_input: unknown) => {});
mock.module("../../../packages/bot/src/discord-notifications", () => ({
  sendDiscordTextNotification: send,
  isAuthorizedDiscordDestination: mock(
    async (channelId: string) =>
      !process.env.DISCORD_CHANNEL_ID ||
      channelId === process.env.DISCORD_CHANNEL_ID,
  ),
}));

const { sendToProviders, flushDueActivityNotificationBatches } = await import(
  "../../../packages/bot/src/activity-notifications"
);

const payload = {
  inboxId: "receipt",
  transactionId: "transaction",
  documentName: "Private supplier invoice",
  documentAmount: 55,
  documentCurrency: "USD",
  transactionName: "Private purchase",
  transactionAmount: 55,
  transactionCurrency: "USD",
  confidenceScore: 0.99,
  matchType: "auto_matched" as const,
};

beforeEach(() => {
  send.mockClear();
  mocks.getPlatformIdentity.mockReset();
  mocks.getDiscordInstallation.mockReset();
  mocks.hasTeamAccess.mockReset();
  mocks.updatePlatformIdentityMetadata.mockReset();
  shouldSendNotification.mockClear();
  listDueProviderNotificationBatches.mockReset();
  listDueProviderNotificationBatches.mockImplementation(async () => []);
});

test("batched Discord notifications also enforce the current channel restriction", async () => {
  process.env.DISCORD_CHANNEL_ID = "allowed-channel";
  try {
    mocks.getDiscordInstallation.mockImplementation(async () => ({
      teamId: "team-a",
    }));
    mocks.hasTeamAccess.mockImplementation(async () => true);
    getPlatformIdentityById.mockImplementation(
      async () =>
        ({
          id: "identity-a",
          provider: "discord",
          teamId: "team-a",
          userId: "user-a",
          externalTeamId: "guild-a",
          externalChannelId: "disallowed-channel",
        }) as any,
    );
    listDueProviderNotificationBatches.mockImplementation(async () => [
      {
        id: "batch",
        platformIdentityId: "identity-a",
        teamId: "team-a",
        userId: "user-a",
        provider: "discord",
        eventFamily: "transaction",
        payload: {
          entries: [{ transactions: [{ id: "private-transaction" }] }],
        },
      },
    ]);
    await flushDueActivityNotificationBatches({} as never);
    expect(send).not.toHaveBeenCalled();
  } finally {
    delete process.env.DISCORD_CHANNEL_ID;
    getPlatformIdentityById.mockImplementation(async () => null);
  }
});

test("does not send a Discord receipt match after identity removal", async () => {
  mocks.getPlatformIdentity.mockImplementation(async () => null);
  mocks.getDiscordInstallation.mockImplementation(async () => ({
    id: "installation",
    teamId: "team-a",
  }));

  await sendToProviders({} as never, "team-a", "match", payload, {
    inboxMeta: {
      source: "discord",
      sourceMetadata: {
        channelId: "old-thread",
        externalUserId: "removed-user",
        guildId: "guild-a",
      },
    },
  });

  expect(send).not.toHaveBeenCalled();
  expect(mocks.hasTeamAccess).not.toHaveBeenCalled();
});

test("sends only through the current guild-scoped identity and installation", async () => {
  mocks.getPlatformIdentity.mockImplementation(async () => ({
    id: "identity-a",
    userId: "user-a",
    teamId: "team-a",
    externalTeamId: "guild-a",
  }));
  mocks.getDiscordInstallation.mockImplementation(async () => ({
    id: "installation",
    teamId: "team-a",
  }));
  mocks.hasTeamAccess.mockImplementation(async () => true);

  await sendToProviders({} as never, "team-a", "match", payload, {
    inboxMeta: {
      source: "discord",
      sourceMetadata: {
        channelId: "current-thread",
        externalUserId: "discord-a",
        guildId: "guild-a",
      },
    },
  });

  expect(mocks.getPlatformIdentity).toHaveBeenCalledWith(expect.anything(), {
    provider: "discord",
    externalUserId: "discord-a",
    externalTeamId: "guild-a",
  });
  expect(send).toHaveBeenCalledWith({
    channelId: "current-thread",
    text: expect.stringContaining("Private supplier invoice"),
  });
  expect(mocks.updatePlatformIdentityMetadata).toHaveBeenCalled();
});

test("configured destination restriction is enforced by delayed notifications", async () => {
  const original = process.env.DISCORD_CHANNEL_ID;
  process.env.DISCORD_CHANNEL_ID = "allowed-channel";
  try {
    mocks.getPlatformIdentity.mockImplementation(async () => ({
      id: "identity-a",
      userId: "user-a",
      teamId: "team-a",
      externalTeamId: "guild-a",
      externalChannelId: "allowed-channel",
    }));
    mocks.getDiscordInstallation.mockImplementation(async () => ({
      id: "installation",
      teamId: "team-a",
    }));
    mocks.hasTeamAccess.mockImplementation(async () => true);
    await sendToProviders({} as never, "team-a", "match", payload, {
      inboxMeta: {
        source: "discord",
        sourceMetadata: {
          channelId: "stale-disallowed-channel",
          externalUserId: "discord-a",
          guildId: "guild-a",
        },
      },
    });
    expect(send).not.toHaveBeenCalled();
  } finally {
    if (original === undefined) delete process.env.DISCORD_CHANNEL_ID;
    else process.env.DISCORD_CHANNEL_ID = original;
  }
});
