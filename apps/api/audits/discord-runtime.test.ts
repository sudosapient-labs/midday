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
  return {
    id: "discord:guild:channel:thread",
    channelId: "guild",
    adapter: { name: "discord" },
    isDM: false,
    state: {},
    recentMessages: history,
    refresh: async () => {},
    setState: mock(async () => {}),
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
  mocks.hasTeamAccess.mockImplementation(async () => true);
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
