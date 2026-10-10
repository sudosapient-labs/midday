// End-to-end Slack webhook coverage: a real signed Slack event flows through
// the actual `chat` SDK, the real `createWorkspaceSlackAdapter`, and
// `registerMiddayBotRuntime` into the real assistant/model/MCP/DB stack.
// Slack HTTP/history and Chat state are simulated; model, MCP, database and
// bot handlers are real. External integrations and attachment handling are out of scope.
//
// Opt-in with SLACK_AUDIT_TEST=true against the isolated
// `midday_slack_audit_20261010` database. See scripts/run-slack-audit.ts.
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@midday/db/client";
import { Chat, Message, type StateAdapter } from "chat";
import { sql } from "drizzle-orm";

// Real (unmocked) `@midday/bot` formatting utilities, imported directly from
// their source files so the test keeps genuine formatting behaviour without
// pulling in `packages/bot/src/instance.ts`, which would construct the
// production multi-platform bot (Redis state, WhatsApp/Telegram/Discord
// adapters) as a side effect of import.
import { formatNotificationContextForPrompt } from "../../../../packages/bot/src/activity-notifications";
import {
  formatInboxResultMessage,
  formatProcessedUploadSummary,
  isSupportedInboxUploadMediaType,
} from "../../../../packages/bot/src/inbox-upload";
import { getPlatformInstructions } from "../../../../packages/bot/src/platform-rules";
// The real workspace Slack adapter (mention-normalization wrapper over
// `@chat-adapter/slack`) used in production.
import { createWorkspaceSlackAdapter } from "../../../../packages/bot/src/slack-adapter";

const enabled = process.env.SLACK_AUDIT_TEST === "true";
const cleanups: Array<() => Promise<void>> = [];

// The audit runner strips COMPOSIO_API_KEY along with other platform
// secrets. `@api/composio/client` constructs its SDK client at import time
// and throws synchronously without *some* key present, even though the
// business logic already treats the literal sentinel "local-disabled" as
// "not actually configured" and skips any outbound Composio call. Set it
// before the dynamic `../bot/runtime` import below pulls that module in.
process.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || "local-disabled";

const teamId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";
const bankAccountId = "00000000-0000-4000-8000-000000000103";

const SLACK_TEAM_ID = "T0SLACKAUDIT";
const SLACK_USER_ID = "U0SLACKAUDIT";
const SLACK_CHANNEL_ID = "D0SLACKAUDIT"; // Slack DM channel IDs start with "D".

// --- Outbound-Slack-HTTP boundary -----------------------------------------
// Every HTTP request this process makes to Slack must be blocked, even if a
// code path we did not anticipate bypasses the per-method spies below. This
// is a hard backstop, not the primary mocking mechanism.
const realFetch = globalThis.fetch;
const fetchGuard: typeof fetch = ((input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (/(^|\.)slack\.com$/u.test(new URL(url, "http://localhost").hostname)) {
    throw new Error(
      `Refusing real Slack network call in slack-workflow.integration.test.ts: ${url}`,
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = fetchGuard;

// --- In-memory Chat state (mirrors packages/bot/src/slack-adapter.test.ts) -
function createInMemoryState(): StateAdapter {
  const values = new Map<string, unknown>();
  const lists = new Map<string, unknown[]>();
  const queues = new Map<string, unknown[]>();
  const subscriptions = new Set<string>();
  return {
    connect: async () => {},
    disconnect: async () => {},
    acquireLock: async (threadId: string) => ({ threadId, token: "test" }),
    releaseLock: async () => {},
    forceReleaseLock: async () => {},
    extendLock: async () => true,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    isSubscribed: async (threadId: string) => subscriptions.has(threadId),
    subscribe: async (threadId: string) => {
      subscriptions.add(threadId);
    },
    unsubscribe: async (threadId: string) => {
      subscriptions.delete(threadId);
    },
    getList: async (key: string) => (lists.get(key) ?? []) as unknown[],
    appendToList: async (key: string, value: unknown) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
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
}

async function setupSlackHarness() {
  // Set signing credentials in-process; the audit runner strips real
  // SLACK_* secrets from the environment before this file is executed.
  process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret";
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ENCRYPTION_KEY;

  const state = createInMemoryState();
  const adapter = createWorkspaceSlackAdapter();
  const chat = new Chat({
    userName: "midday",
    adapters: { slack: adapter },
    state,
    concurrency: { strategy: "debounce", debounceMs: 1 },
  });

  // Mock `@midday/bot` with a real local Chat instance wired to the real
  // Slack adapter. Only the module's `bot` singleton is replaced (to avoid
  // constructing the production multi-platform bot with Redis state); the
  // formatting utilities are the genuine implementations imported above.
  mock.module("@midday/bot", () => ({
    bot: chat,
    formatInboxResultMessage,
    formatNotificationContextForPrompt,
    formatProcessedUploadSummary,
    getPlatformInstructions,
    isSupportedInboxUploadMediaType,
    // No test message carries attachments, so this real-signature stub is
    // never exercised; it exists only to satisfy the module shape.
    processInboxUpload: mock(() => Promise.resolve(null)),
  }));

  const { registerMiddayBotRuntime } = await import("../bot/runtime");
  registerMiddayBotRuntime();

  // Intercept the actual Axios transport, not just global fetch: Slack's
  // native streaming methods use Axios and would bypass a fetch-only guard.
  // Every SDK request stays in-process, including unexpected methods.
  // biome-ignore lint/complexity/useLiteralKeys: bracket notation is required for test access to private SDK fields.
  const client = adapter["client"] as unknown as {
    axios: {
      defaults: {
        adapter: (config: { url?: string; data?: string }) => Promise<unknown>;
      };
    };
  };
  const posted: Array<{ method: string; text: string }> = [];
  const unexpectedMethods: string[] = [];
  const streams = new Map<string, string>();
  let nextTs = 9000;
  client.axios.defaults.adapter = async (config) => {
    const method = config.url?.split("/").at(-1) ?? "unknown";
    const args = new URLSearchParams(config.data);
    const chunks = JSON.parse(args.get("chunks") ?? "[]") as Array<{
      type: string;
      text?: string;
    }>;
    const text =
      (args.get("markdown_text") ?? "") +
      chunks
        .filter((chunk) => chunk.type === "markdown_text")
        .map((chunk) => chunk.text ?? "")
        .join("");
    const ts = args.get("ts") ?? String(nextTs++);
    let data: Record<string, unknown> = {
      ok: true,
      ts,
      channel: SLACK_CHANNEL_ID,
    };
    if (method === "users.info") {
      data.user = {
        name: "audit_user",
        real_name: "Audit User",
        profile: { display_name: "Audit User" },
      };
    } else if (
      ["chat.startStream", "chat.appendStream", "chat.stopStream"].includes(
        method,
      )
    ) {
      streams.set(ts, (streams.get(ts) ?? "") + text);
      if (method === "chat.stopStream") {
        posted.push({ method, text: streams.get(ts) ?? "" });
        data.message = { ts };
      }
    } else if (["chat.postMessage", "chat.update"].includes(method)) {
      posted.push({ method, text: args.get("text") ?? "" });
    } else if (method !== "assistant.threads.setStatus") {
      unexpectedMethods.push(method);
      data = { ok: false, error: "unexpected_test_method" };
    }
    return {
      data,
      status: 200,
      statusText: "OK",
      headers: {},
      request: { path: `/api/${method}` },
      config,
    };
  };
  await chat.initialize();
  cleanups.push(() => chat.shutdown());
  await adapter.setInstallation(SLACK_TEAM_ID, {
    botToken: "installed-test-token",
    botUserId: "UBOTAUDIT",
  });

  // `thread.refresh()` otherwise calls `conversations.replies` (real Slack
  // HTTP) to rebuild conversation history. Replace it with an in-memory log
  // the test controls directly, keeping every other Chat SDK code path real.
  const historyByThread = new Map<string, Message[]>();
  spyOn(adapter, "fetchMessages").mockImplementation(
    async (threadId: string) => ({
      messages: historyByThread.get(threadId) ?? [],
    }),
  );

  function rememberHistory(threadId: string, message: Message) {
    const existing = historyByThread.get(threadId) ?? [];
    existing.push(message);
    historyByThread.set(threadId, existing);
  }

  function makeMessage(params: { id: string; text: string; isMe: boolean }) {
    return new Message({
      id: params.id,
      threadId: `slack:${SLACK_CHANNEL_ID}:`,
      text: params.text,
      formatted: { type: "root", children: [] } as never,
      raw: {},
      author: {
        userId: params.isMe ? "UBOTAUDIT" : SLACK_USER_ID,
        userName: params.isMe ? "midday" : "audit_user",
        fullName: params.isMe ? "Midday" : "Audit User",
        isBot: params.isMe,
        isMe: params.isMe,
      },
      metadata: { dateSent: new Date() },
      attachments: [],
      links: [],
    });
  }

  async function deliver(text: string, ts: string) {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: SLACK_TEAM_ID,
      event: {
        type: "message",
        channel: SLACK_CHANNEL_ID,
        channel_type: "im",
        ts,
        user: SLACK_USER_ID,
        text,
      },
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

    // Record this turn (and the bot's reply, if any) for the next turn's
    // conversation history, mirroring how a real Slack DM accumulates.
    const threadId = `slack:${SLACK_CHANNEL_ID}:`;
    rememberHistory(threadId, makeMessage({ id: ts, text, isMe: false }));
    const reply = posted.at(-1);
    if (reply) {
      rememberHistory(
        threadId,
        makeMessage({ id: `bot-${ts}`, text: reply.text, isMe: true }),
      );
    }
  }

  return { adapter, posted, deliver, unexpectedMethods };
}

async function resetFixtureData() {
  await db.execute(sql`delete from transactions where team_id = ${teamId}`);
  await db.execute(
    sql`update bank_accounts set balance = 242315 where id = ${bankAccountId}`,
  );
}

beforeAll(async () => {
  if (!enabled) return;

  if (
    new URL(process.env.DATABASE_PRIMARY_URL!).pathname !==
    "/midday_slack_audit_20261010"
  ) {
    throw new Error(
      "Refusing integration tests outside the isolated audit database",
    );
  }

  await db.execute(
    sql`insert into auth.users (id) values (${userId}) on conflict do nothing`,
  );
  await db.execute(
    sql`insert into public.users (id, full_name, email) values (${userId}, 'Slack Audit User', 'slack-audit@example.invalid') on conflict do nothing`,
  );
  await db.execute(
    sql`insert into teams (id, name, base_currency) values (${teamId}, 'Synthetic Audit', 'INR') on conflict do nothing`,
  );
  await db.execute(
    sql`update users set team_id = ${teamId} where id = ${userId}`,
  );
  await db.execute(
    sql`insert into users_on_team (user_id, team_id, role) values (${userId}, ${teamId}, 'owner') on conflict do nothing`,
  );
  await db.execute(
    sql`insert into bank_accounts (id, name, currency, team_id, created_by, account_id, manual, enabled, balance) values (${bankAccountId}, 'SIB', 'INR', ${teamId}, ${userId}, 'audit-sib', true, true, 242315) on conflict do nothing`,
  );
  await db.execute(sql`
    insert into platform_identities (provider, team_id, user_id, external_user_id, external_team_id, external_channel_id)
    values ('slack', ${teamId}, ${userId}, ${SLACK_USER_ID}, ${SLACK_TEAM_ID}, ${SLACK_CHANNEL_ID})
    on conflict (provider, external_team_id, external_user_id)
    do update set team_id = excluded.team_id, user_id = excluded.user_id
  `);
});

afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  globalThis.fetch = realFetch;
});

test.skipIf(!enabled)(
  "real signed Slack DM webhook previews, confirms, and persists exactly once",
  async () => {
    await resetFixtureData();
    const { posted, deliver, unexpectedMethods } = await setupSlackHarness();

    // Turn 1: an explicit request for 3 new expenses. Per the system
    // prompt's confirmation rule for 3+ record writes, the assistant must
    // preview the change and ask for confirmation rather than writing yet.
    await deliver(
      "Add these transactions to SIB: Oct 3 2026 Audit Workspace INR 252 expense; " +
        "Oct 6 2026 Audit Rent INR 25000 expense; Oct 6 2026 Audit Groceries INR 255 expense. " +
        "SIB opening balance is INR 242315.",
      "1000.0001",
    );

    expect(posted.length).toBeGreaterThan(0);
    const previewCount = await db.execute(
      sql`select count(*)::int as count from transactions where team_id = ${teamId}`,
    );
    expect(previewCount.rows[0]?.count).toBe(0);
    expect(posted.at(-1)?.method).toBe("chat.stopStream");

    // Turn 2: explicit confirmation. The assistant should now call the
    // write tool(s) and persist exactly 3 transactions, updating the SIB
    // balance from 242315 to 216808 (-252 - 25000 - 255).
    const previewPosts = posted.length;
    await deliver("Yes, save these.", "1000.0002");

    const confirmedCount = await db.execute(
      sql`select count(*)::int as count from transactions where team_id = ${teamId}`,
    );
    expect(confirmedCount.rows[0]?.count).toBe(3);
    const balance = await db.execute(
      sql`select balance from bank_accounts where id = ${bankAccountId}`,
    );
    expect(Number(balance.rows[0]?.balance)).toBe(216808);
    expect(posted.length).toBeGreaterThan(previewPosts);
    expect(posted.at(-1)?.method).toBe("chat.stopStream");
    expect(posted.at(-1)?.text).toMatch(/saved|created|recorded|added/iu);
    expect(posted.at(-1)?.text).toMatch(/\b3\b/u);
    expect(posted.at(-1)?.text).not.toMatch(
      /failed|unavailable|nothing was saved/iu,
    );
    expect(unexpectedMethods).toEqual([]);

    // Duplicate delivery of the exact same confirmation event (same Slack
    // message ts) must be deduplicated by the Chat SDK and must not cause
    // any additional transactions or a second model turn.
    const postedCountBeforeDuplicate = posted.length;
    await deliver("Yes, save these.", "1000.0002");

    const countAfterDuplicate = await db.execute(
      sql`select count(*)::int as count from transactions where team_id = ${teamId}`,
    );
    expect(countAfterDuplicate.rows[0]?.count).toBe(3);
    const balanceAfterDuplicate = await db.execute(
      sql`select balance from bank_accounts where id = ${bankAccountId}`,
    );
    expect(Number(balanceAfterDuplicate.rows[0]?.balance)).toBe(216808);
    expect(posted.length).toBe(postedCountBeforeDuplicate);
  },
  240000,
);
