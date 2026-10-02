import { afterEach, expect, mock, test } from "bun:test";
import {
  isAuthorizedDiscordDestination,
  sendDiscordTextNotification,
} from "./discord-notifications";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_CHANNEL_ID;
});

test("notification destinations require the current guild and allowed channel or thread parent", async () => {
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_GUILD_ID = "guild";
  process.env.DISCORD_CHANNEL_ID = "allowed";
  let channel: unknown = {
    id: "thread",
    guild_id: "guild",
    parent_id: "allowed",
    type: 11,
  };
  globalThis.fetch = mock(async () =>
    Response.json(channel),
  ) as unknown as typeof fetch;
  expect(await isAuthorizedDiscordDestination("thread", "guild")).toBe(true);
  channel = { id: "thread", guild_id: "other", parent_id: "allowed", type: 11 };
  expect(await isAuthorizedDiscordDestination("thread", "guild")).toBe(false);
  channel = {
    id: "thread",
    guild_id: "guild",
    parent_id: "disallowed",
    type: 11,
  };
  expect(await isAuthorizedDiscordDestination("thread", "guild")).toBe(false);
  channel = { id: "thread", guild_id: "guild", parent_id: "allowed", type: 0 };
  expect(await isAuthorizedDiscordDestination("thread", "guild")).toBe(false);
  channel = { id: "allowed", guild_id: "guild", type: 0 };
  expect(await isAuthorizedDiscordDestination("allowed", "guild")).toBe(true);
  expect(
    await isAuthorizedDiscordDestination("allowed", "different-guild"),
  ).toBe(false);
});

test("destination authorization fails closed on inaccessible or missing channels", async () => {
  process.env.DISCORD_BOT_TOKEN = "test-token";
  globalThis.fetch = mock(
    async () => new Response(null, { status: 403 }),
  ) as unknown as typeof fetch;
  expect(await isAuthorizedDiscordDestination("channel", "guild")).toBe(false);
  globalThis.fetch = mock(async () => {
    throw new Error("network failure");
  }) as unknown as typeof fetch;
  expect(await isAuthorizedDiscordDestination("channel", "guild")).toBe(false);
});

test("generated Discord notifications disable all mention parsing", async () => {
  process.env.DISCORD_BOT_TOKEN = "test-token";
  const fetchMock = mock(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await sendDiscordTextNotification({
    channelId: "channel",
    text: "Invoice from @everyone is ready",
  });

  const request = fetchMock.mock.calls[0]?.[1];
  expect(request).toBeDefined();
  expect(JSON.parse(String(request?.body))).toEqual({
    content: "Invoice from @everyone is ready",
    allowed_mentions: { parse: [] },
  });
});
