// Regression coverage for the Discord audit findings at a42d5438.
// Run separately from other test files because Bun module mocks are process-global.
import { beforeEach, expect, mock, test } from "bun:test";
import { splitDiscordText } from "../../../packages/bot/src/discord-notifications";
import { getPlatformInstructions } from "../../../packages/bot/src/platform-rules";
import { mocks } from "../src/__tests__/setup";

let subscribed: any;
let newMessage: any;
const assistant = mock(async (_input: any) => ({
  text: Promise.resolve("Done."),
  fullStream: "Done.",
  cleanup: async () => {},
}));
const upload = mock(async (_input: any) => ({}));
mock.module("@api/chat/assistant-runtime", () => ({
  streamMiddayAssistant: assistant,
}));
mock.module("@midday/bot", () => ({
  bot: {
    onNewMention: () => {},
    onSubscribedMessage: (handler: any) => {
      subscribed = handler;
    },
    onNewMessage: (_pattern: any, handler: any) => {
      newMessage = handler;
    },
    onAssistantThreadStarted: () => {},
    onAssistantContextChanged: () => {},
  },
  getPlatformInstructions,
  formatInboxResultMessage: () => "Uploaded.",
  formatNotificationContextForPrompt: () => "",
  formatProcessedUploadSummary: () => "Receipt uploaded.",
  isSupportedInboxUploadMediaType: () => true,
  processInboxUpload: upload,
  splitDiscordText,
}));
const { registerMiddayBotRuntime } = await import("../src/bot/runtime");
registerMiddayBotRuntime();

function message(text: string, userId = "discord-b", id = "current") {
  return {
    id,
    text,
    author: { userId, userName: userId, isMe: false },
    metadata: { dateSent: new Date() },
    attachments: [],
  };
}
function thread(history: any[] = []) {
  let threadState: Record<string, unknown> = {};
  return {
    id: "discord:guild:channel:thread",
    channelId: "guild",
    adapter: { name: "discord" },
    isDM: false,
    get state() {
      return threadState;
    },
    set state(value: Record<string, unknown>) {
      threadState = value;
    },
    recentMessages: history,
    refresh: async () => {},
    setState: mock(
      async (
        nextState: Record<string, unknown>,
        options?: { replace?: boolean },
      ) => {
        threadState = options?.replace
          ? nextState
          : { ...threadState, ...nextState };
      },
    ),
    subscribe: async () => {},
    startTyping: async () => {},
    post: mock(async () => {}),
  };
}
beforeEach(() => {
  delete process.env.DISCORD_GUILD_ID;
  delete process.env.DISCORD_CHANNEL_ID;
  assistant.mockClear();
  upload.mockClear();
  mocks.consumePlatformLinkToken.mockClear();
  mocks.claimBotMessage.mockClear();
  mocks.claimBotMessage.mockImplementation(async () => true);
  mocks.completeBotMessage.mockClear();
  mocks.completeBotMessage.mockImplementation(async () => true);
  mocks.hasTeamAccess.mockImplementation(async () => true);
  mocks.getDiscordInstallation.mockImplementation(async () => ({
    id: "discord-installation-b",
    teamId: "team-b",
  }));
  mocks.getPlatformIdentity.mockImplementation(async () => ({
    id: "identity-b",
    userId: "user-b",
    teamId: "team-b",
    metadata: null,
  }));
  mocks.getUserById.mockImplementation(async () => ({
    id: "user-b",
    fullName: "Bob",
    teamId: "team-active",
    team: { name: "Active USD team", baseCurrency: "USD", countryCode: "US" },
  }));
  mocks.getTeamById.mockImplementation(async () => ({
    id: "team-b",
    name: "Linked INR team",
    baseCurrency: "INR",
    countryCode: "IN",
  }));
});

test("a copied Discord connection message is handled without an undocumented mention", async () => {
  await newMessage(thread(), message("Connect to Midday: abc12345"));
  expect(mocks.consumePlatformLinkToken).toHaveBeenCalled();
});

test("a linked workspace uses its own currency after the user switches dashboard teams", async () => {
  await subscribed(thread(), message("save this expense"));
  expect(assistant).toHaveBeenCalledTimes(1);
  const input = assistant.mock.calls[0]![0];
  expect(input.mcpCtx.teamId).toBe("team-b");
  expect(input.systemPrompt).toContain("Base currency: INR");
  expect(input.enableComposioTools).toBe(false);
});

test("a different workspace's thread context is not reused for the current user's tools", async () => {
  const t = thread([
    message("Save Acme workspace A expenses: 55 water", "discord-a", "old"),
  ]);
  t.state = {
    teamId: "team-a",
    actingUserId: "user-a",
    platform: "discord",
    externalUserId: "discord-a",
  };
  await subscribed(t, message("yes, save them"));
  const input = assistant.mock.calls[0]?.[0];
  expect(input?.mcpCtx.teamId).toBe("team-b");
  expect(JSON.stringify(input?.modelMessages)).not.toContain(
    "workspace A expenses",
  );
});

test("a Discord server cannot execute for a second Midday workspace", async () => {
  mocks.getPlatformIdentity.mockImplementation(async () => ({
    id: "identity-a",
    userId: "user-a",
    teamId: "team-a",
    metadata: null,
  }));
  mocks.getUserById.mockImplementation(async () => ({
    id: "user-a",
    fullName: "Alice",
  }));
  mocks.getTeamById.mockImplementation(async () => ({
    id: "team-a",
    name: "Workspace A",
    baseCurrency: "USD",
  }));

  await subscribed(thread(), message("show balance", "discord-a"));

  expect(assistant).not.toHaveBeenCalled();
});

test("receipt notification metadata points to the Discord thread, not the guild", async () => {
  const m: any = message("");
  m.attachments = [
    {
      type: "file",
      mimeType: "application/pdf",
      name: "receipt.pdf",
      data: new Uint8Array([1]),
    },
  ];
  await subscribed(thread(), m);
  expect(upload.mock.calls[0]?.[0].platformMeta.channelId).toBe("thread");
});

test("Discord invoice instructions do not assume a dashboard side panel", async () => {
  await subscribed(thread(), message("create an invoice"));
  expect(assistant.mock.calls[0]?.[0].systemPrompt).not.toContain(
    "The UI automatically renders a full visual preview in a side panel",
  );
});

test("Discord delivery preserves the final total and confirmation in a long response", async () => {
  const response = `${"Expense line 55 USD\n".repeat(120)}Total 6600 USD. Confirm saving?`;
  assistant.mockImplementationOnce(async () => ({
    text: Promise.resolve(response),
    fullStream: response,
    cleanup: async () => {},
  }));
  const currentThread = thread();

  await subscribed(currentThread, message("show the expense preview"));

  const posts = currentThread.post.mock.calls.map(
    ([content]: [string]) => content,
  );
  expect(posts.length).toBeGreaterThan(1);
  expect(posts.every((content: string) => content.length <= 2_000)).toBe(true);
  expect(posts.join("\n")).toContain("Total 6600 USD. Confirm saving?");
});

test("control: the current message is included when refreshed history is stale", async () => {
  await subscribed(thread(), message("Current expense question"));
  const messages = assistant.mock.calls[0]?.[0].modelMessages;
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain("Current expense question");
});

test("control: the current message is not duplicated when history already includes it", async () => {
  const current = message("Current expense question");
  await subscribed(thread([current]), current);
  expect(assistant.mock.calls[0]?.[0].modelMessages).toHaveLength(1);
});

test("persists task text and verified tool outcomes across follow-up turns", async () => {
  const currentThread = thread();
  assistant.mockImplementationOnce(async () => ({
    text: Promise.resolve("I found Cash. Save both expenses there?"),
    fullStream: "I found Cash. Save both expenses there?",
    steps: Promise.resolve([
      {
        toolResults: [
          {
            toolName: "bank_accounts_list",
            output: { id: "account_cash", name: "Cash" },
          },
        ],
      },
    ]),
    cleanup: async () => {},
  }));

  await subscribed(
    currentThread,
    message("Save 55 for water and 247 for curtains", "discord-b", "turn_1"),
  );
  await subscribed(
    currentThread,
    message("yes, save them", "discord-b", "turn_2"),
  );

  const followUpMessages = assistant.mock.calls[1]?.[0].modelMessages;
  expect(JSON.stringify(followUpMessages)).toContain("Save 55 for water");
  expect(JSON.stringify(followUpMessages)).toContain("account_cash");
  expect(JSON.stringify(followUpMessages)).toContain("yes, save them");

  await subscribed(
    currentThread,
    message("yes, save them", "discord-b", "turn_2"),
  );
  expect(assistant).toHaveBeenCalledTimes(2);
});

test("records a completed financial turn before Discord delivery", async () => {
  const currentThread = thread();
  const current = message("save expense 55 water", "discord-b", "write-1");
  currentThread.post.mockImplementationOnce(async () => {
    throw new Error("simulated Discord outage");
  });

  await subscribed(currentThread, current);
  expect(mocks.completeBotMessage).toHaveBeenCalled();
  await subscribed(currentThread, current);

  expect(assistant).toHaveBeenCalledTimes(1);
});

test("records attachment-only messages independently from conversation text", async () => {
  const currentThread = thread();
  const current: any = message("", "discord-b", "attachment-1");
  current.attachments = [
    {
      type: "file",
      mimeType: "application/pdf",
      name: "receipt.pdf",
      data: new Uint8Array([1]),
    },
  ];

  await subscribed(currentThread, current);
  await subscribed(currentThread, current);

  expect(upload).toHaveBeenCalledTimes(1);
});

test("durable replay protection survives conversation cache eviction", async () => {
  const currentThread = thread();
  const current = message("save expense 55 water", "discord-b", "write-2");
  mocks.claimBotMessage
    .mockImplementationOnce(async () => true)
    .mockImplementationOnce(async () => false);

  await subscribed(currentThread, current);
  currentThread.state = {};
  await subscribed(currentThread, current);

  expect(assistant).toHaveBeenCalledTimes(1);
});

test("large tool results retain record IDs for later corrections", async () => {
  const currentThread = thread();
  assistant.mockImplementationOnce(async () => ({
    text: Promise.resolve("Saved all expenses."),
    fullStream: "Saved all expenses.",
    steps: Promise.resolve([
      {
        toolResults: [
          {
            toolName: "transactions_create_bulk",
            output: {
              description: "x".repeat(8_000),
              id: "last-transaction-id",
              amount: 55,
              currency: "USD",
            },
          },
        ],
      },
    ]),
    cleanup: async () => {},
  }));

  await subscribed(
    currentThread,
    message("save these expenses", "discord-b", "large-1"),
  );
  await subscribed(
    currentThread,
    message("correct the last one", "discord-b", "large-2"),
  );

  const context = JSON.stringify(assistant.mock.calls[1]?.[0].modelMessages);
  expect(context).toContain("last-transaction-id");
  expect(context).toContain("output.amount");
});
