import type { BotPlatform } from "@midday/bot";

export type BotThreadState = {
  teamId?: string;
  actingUserId?: string;
  platform?: BotPlatform;
  externalUserId?: string;
  conversationContexts?: Record<string, BotConversationContext>;
  processedMessageIds?: Record<string, string[]>;
};

export type BotConversationMessage = {
  role: "user" | "assistant";
  content: string;
  sourceMessageId?: string;
};

export type BotConversationContext = {
  teamId: string;
  actingUserId: string;
  platform: BotPlatform;
  externalUserId: string;
  messages: BotConversationMessage[];
  updatedAt: string;
};

type ConversationOwner = {
  teamId: string;
  actingUserId: string;
  platform: BotPlatform;
  externalUserId: string;
};

const MAX_CONTEXTS_PER_THREAD = 8;
const MAX_PROCESSED_CONTEXTS_PER_THREAD = 32;
const MAX_PROCESSED_MESSAGES_PER_CONTEXT = 256;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 24_000;

export function getConversationContextKey(owner: ConversationOwner) {
  return [
    owner.platform,
    owner.teamId,
    owner.actingUserId,
    owner.externalUserId,
  ].join(":");
}

export function getConversationContext(
  state: BotThreadState | null | undefined,
  owner: ConversationOwner,
) {
  return (
    state?.conversationContexts?.[getConversationContextKey(owner)] ?? null
  );
}

export function hasProcessedConversationMessage(
  state: BotThreadState | null | undefined,
  owner: ConversationOwner,
  sourceMessageId: string,
) {
  const key = getConversationContextKey(owner);
  return Boolean(
    state?.processedMessageIds?.[key]?.includes(sourceMessageId) ||
      getConversationContext(state, owner)?.messages.some(
        (message) =>
          message.role === "user" &&
          message.sourceMessageId === sourceMessageId,
      ),
  );
}

export function recordProcessedConversationMessage(
  state: BotThreadState | null | undefined,
  owner: ConversationOwner,
  sourceMessageId: string,
) {
  const key = getConversationContextKey(owner);
  const ledgers = { ...(state?.processedMessageIds ?? {}) };
  const current = ledgers[key] ?? [];
  ledgers[key] = [
    ...current.filter((messageId) => messageId !== sourceMessageId),
    sourceMessageId,
  ].slice(-MAX_PROCESSED_MESSAGES_PER_CONTEXT);

  return Object.fromEntries(
    Object.entries(ledgers)
      .sort(([, left], [, right]) => right.length - left.length)
      .slice(0, MAX_PROCESSED_CONTEXTS_PER_THREAD),
  );
}

function trimConversationMessages(messages: BotConversationMessage[]) {
  const trimmed: BotConversationMessage[] = [];
  let totalChars = 0;

  for (const message of messages.slice(-MAX_CONTEXT_MESSAGES).reverse()) {
    const content = message.content.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    if (totalChars + content.length > MAX_CONTEXT_CHARS) break;
    trimmed.push({ ...message, content });
    totalChars += content.length;
  }

  return trimmed.reverse();
}

export function appendConversationExchange(
  state: BotThreadState | null | undefined,
  params: ConversationOwner & {
    sourceMessageId: string;
    userText: string;
    assistantText: string;
    toolContext?: string;
    updatedAt?: string;
  },
) {
  const key = getConversationContextKey(params);
  const contexts = { ...(state?.conversationContexts ?? {}) };
  const existing = contexts[key];

  if (
    existing?.messages.some(
      (message) =>
        message.role === "user" &&
        message.sourceMessageId === params.sourceMessageId,
    )
  ) {
    return contexts;
  }

  contexts[key] = {
    teamId: params.teamId,
    actingUserId: params.actingUserId,
    platform: params.platform,
    externalUserId: params.externalUserId,
    messages: trimConversationMessages([
      ...(existing?.messages ?? []),
      {
        role: "user",
        content: params.userText,
        sourceMessageId: params.sourceMessageId,
      },
      ...(params.toolContext
        ? [
            {
              role: "assistant" as const,
              content: params.toolContext,
            },
          ]
        : []),
      { role: "assistant", content: params.assistantText },
    ]),
    updatedAt: params.updatedAt ?? new Date().toISOString(),
  };

  return Object.fromEntries(
    Object.entries(contexts)
      .sort(([, left], [, right]) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, MAX_CONTEXTS_PER_THREAD),
  );
}

export function canReuseCachedThreadState(
  state: BotThreadState,
  params: {
    platform: BotPlatform;
    externalUserId: string;
  },
) {
  const { platform, externalUserId } = params;

  if (
    !state.teamId ||
    !state.actingUserId ||
    !state.platform ||
    !externalUserId
  ) {
    return false;
  }

  if (state.platform !== platform) {
    return false;
  }

  return state.externalUserId === externalUserId;
}
