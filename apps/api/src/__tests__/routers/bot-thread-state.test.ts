import { describe, expect, test } from "bun:test";
import {
  appendConversationExchange,
  canReuseCachedThreadState,
  getConversationContext,
  hasProcessedConversationMessage,
  recordProcessedConversationMessage,
} from "../../bot/thread-state";

describe("bot thread state reuse", () => {
  test("reuses cached state when the same telegram user continues", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "telegram",
          externalUserId: "telegram_user_a",
        },
        {
          platform: "telegram",
          externalUserId: "telegram_user_a",
        },
      ),
    ).toBe(true);
  });

  test("does not reuse cached telegram state for a different sender", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "telegram",
          externalUserId: "telegram_user_a",
        },
        {
          platform: "telegram",
          externalUserId: "telegram_user_b",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached whatsapp state for a different sender", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "whatsapp",
          externalUserId: "+15551234567",
        },
        {
          platform: "whatsapp",
          externalUserId: "+15557654321",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached state when platform is missing", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          externalUserId: "shared_user_id",
        },
        {
          platform: "telegram",
          externalUserId: "shared_user_id",
        },
      ),
    ).toBe(false);
  });

  test("does not reuse cached state without a sender id", () => {
    expect(
      canReuseCachedThreadState(
        {
          teamId: "team_123",
          actingUserId: "user_123",
          platform: "telegram",
          externalUserId: "telegram_user_a",
        },
        {
          platform: "telegram",
          externalUserId: "",
        },
      ),
    ).toBe(false);
  });
});

describe("persistent bot conversation context", () => {
  const owner = {
    platform: "discord" as const,
    teamId: "team_123",
    actingUserId: "user_123",
    externalUserId: "discord_user_123",
  };

  test("keeps exchanges scoped to platform, workspace, and user", () => {
    const conversationContexts = appendConversationExchange(
      {},
      {
        ...owner,
        sourceMessageId: "message_1",
        userText: "Save these expenses",
        assistantText: "Which account should I use?",
        toolContext:
          'Verified internal tool results: {"toolName":"bank_accounts_list","id":"account_1"}',
        updatedAt: "2026-09-30T10:00:00.000Z",
      },
    );
    const state = { conversationContexts };

    expect(getConversationContext(state, owner)?.messages).toEqual([
      {
        role: "user",
        content: "Save these expenses",
        sourceMessageId: "message_1",
      },
      {
        role: "assistant",
        content:
          'Verified internal tool results: {"toolName":"bank_accounts_list","id":"account_1"}',
      },
      { role: "assistant", content: "Which account should I use?" },
    ]);
    expect(
      getConversationContext(state, { ...owner, teamId: "other_team" }),
    ).toBeNull();
  });

  test("recognizes a completed message retry without appending it twice", () => {
    const first = appendConversationExchange(
      {},
      {
        ...owner,
        sourceMessageId: "message_1",
        userText: "Yes, save them",
        assistantText: "Saved two expenses.",
      },
    );
    const second = appendConversationExchange(
      { conversationContexts: first },
      {
        ...owner,
        sourceMessageId: "message_1",
        userText: "Yes, save them",
        assistantText: "Saved two expenses again.",
      },
    );

    expect(second).toEqual(first);
    expect(
      hasProcessedConversationMessage(
        { conversationContexts: second },
        owner,
        "message_1",
      ),
    ).toBe(true);
  });

  test("keeps replay protection independent from trimmed conversation text", () => {
    const processedMessageIds = recordProcessedConversationMessage(
      {},
      owner,
      "message_1",
    );

    expect(
      hasProcessedConversationMessage(
        { processedMessageIds, conversationContexts: {} },
        owner,
        "message_1",
      ),
    ).toBe(true);
  });
});
