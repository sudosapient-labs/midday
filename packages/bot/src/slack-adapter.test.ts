import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { Chat, type StateAdapter } from "chat";
import { createWorkspaceSlackAdapter } from "./slack-adapter";

const envKeys = [
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_BOT_TOKEN",
  "SLACK_ENCRYPTION_KEY",
] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function setup() {
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret";
  process.env.SLACK_BOT_TOKEN = "stale-global-token";
  delete process.env.SLACK_ENCRYPTION_KEY;

  const values = new Map<string, unknown>();
  const queues = new Map<string, unknown[]>();
  const state = {
    connect: async () => {},
    disconnect: async () => {},
    acquireLock: async (threadId: string) => ({ threadId, token: "test" }),
    releaseLock: async () => {},
    extendLock: async () => true,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    isSubscribed: async () => false,
    getList: async () => [],
    appendToList: async () => {},
    setIfNotExists: async (key: string, value: unknown) => {
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    enqueue: async (key: string, entry: unknown) => {
      queues.set(key, [JSON.parse(JSON.stringify(entry))]);
      return 1;
    },
    dequeue: async (key: string) => queues.get(key)?.shift() ?? null,
    queueDepth: async (key: string) => queues.get(key)?.length ?? 0,
  } as unknown as StateAdapter;
  const adapter = createWorkspaceSlackAdapter();
  const chat = new Chat({
    userName: "midday",
    adapters: { slack: adapter },
    state,
    concurrency: { strategy: "debounce", debounceMs: 1 },
  });
  const received: Array<{ id: string; text: string; isMention?: boolean }> = [];
  chat.onNewMention(async (_thread, message) => {
    received.push(message);
  });
  await chat.initialize();
  cleanups.push(() => chat.shutdown());
  await adapter.setInstallation("T_FIRST", {
    botToken: "installed-token-first",
    botUserId: "U12345678",
  });
  await adapter.setInstallation("T_SECOND", {
    botToken: "installed-token-second",
    botUserId: "U87654321",
  });
  // Stub the SDK's private HTTP client only in the test harness; exercise its
  // real webhook verification, parser, and queue without calling Slack.
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript permits test access to private SDK fields only with bracket notation.
  const lookup = spyOn(adapter["client"].users, "info").mockImplementation(
    async () => ({
      ok: true,
      user: {
        name: "midday",
        real_name: "Midday",
        profile: { display_name: "Midday" },
      },
    }),
  );
  cleanups.push(async () => {
    lookup.mockRestore();
  });

  async function deliver(
    text: string,
    type = "message",
    teamId = "T_FIRST",
    ts = "1234.5678",
  ) {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: teamId,
      event: { type, channel: "G_TEST", ts, user: "U_SENDER", text },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", "test-signing-secret")
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const tasks: Promise<unknown>[] = [];
    const response = await adapter.handleWebhook(
      new Request("https://api.example.com/apps/slack/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signature,
        },
        body,
      }),
      { waitUntil: (task) => tasks.push(task) },
    );
    expect(response.status).toBe(200);
    await Promise.all(tasks);
  }
  return { adapter, received, deliver };
}

describe("Slack mention ingress", () => {
  for (const separator of [" ", "\n", "\n\n"]) {
    it(`recognizes a raw mention with separator ${JSON.stringify(separator)} after queue serialization`, async () => {
      const { received, deliver } = await setup();
      await deliver(`<@U12345678>${separator}hello`);
      expect(received).toHaveLength(1);
      expect(received[0]?.isMention).toBe(true);
    });
  }

  for (const first of ["message", "app_mention"]) {
    it(`handles duplicate events exactly once when ${first} arrives first`, async () => {
      const { received, deliver } = await setup();
      const text = "<@U12345678>\n\non test";
      await deliver(text, first);
      await deliver(text, first === "message" ? "app_mention" : "message");
      expect(received.map((message) => message.id)).toEqual(["1234.5678"]);
    });
  }

  it("uses each installation's bot ID despite a stale global token", async () => {
    const { adapter, received, deliver } = await setup();
    await deliver("<@U12345678>\n\nhello");
    await deliver("<@U87654321>\n\nhello", "message", "T_SECOND", "1234.5679");
    expect(received).toHaveLength(2);
    expect(adapter.botUserId).toBeUndefined();
  });

  it("does not treat another workspace's bot ID or ordinary messages as mentions", async () => {
    const { received, deliver } = await setup();
    // Both installations intentionally have the same display name. Only the
    // current workspace's raw bot ID may recover this broken normalized text.
    await deliver("<@U87654321>\n\nhello");
    await deliver("hello", "message", "T_FIRST", "1234.5679");
    expect(received).toEqual([]);
  });

  it("rejects an unsigned webhook before dispatching a mention", async () => {
    const { adapter, received } = await setup();
    const response = await adapter.handleWebhook(
      new Request("https://api.example.com/apps/slack/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "event_callback",
          team_id: "T_FIRST",
          event: {
            type: "app_mention",
            channel: "G_TEST",
            ts: "1234.5678",
            text: "<@U12345678>\n\nhello",
          },
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(received).toEqual([]);
  });
});
