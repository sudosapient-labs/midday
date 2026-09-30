import { afterEach, expect, mock, test } from "bun:test";
import { sendDiscordTextNotification } from "./discord-notifications";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.DISCORD_BOT_TOKEN;
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
