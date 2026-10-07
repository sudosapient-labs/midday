import { createSlackAdapter } from "@chat-adapter/slack";
import type { ChatInstance } from "chat";

export function createWorkspaceSlackAdapter() {
  // OAuth installations supply each workspace's token, even when a stale
  // single-workspace SLACK_BOT_TOKEN is present in the environment.
  const adapter = createSlackAdapter({
    userName: "midday",
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
  });
  const initialize = adapter.initialize.bind(adapter);

  adapter.initialize = async (chat) => {
    const processMessage: ChatInstance["processMessage"] = (
      source,
      threadId,
      messageOrFactory,
      options,
    ) => {
      // Capture the workspace's bot ID while the webhook context is active.
      // Plain-text conversion can merge paragraphs ("@Midday\n\non" becomes
      // "@Middayon"), and queues serialize messages before dispatching them.
      const botUserId = adapter.botUserId;
      chat.processMessage(
        source,
        threadId,
        async () => {
          const message =
            typeof messageOrFactory === "function"
              ? await messageOrFactory()
              : messageOrFactory;
          const raw = message.raw as { text?: unknown } | undefined;
          if (
            botUserId &&
            typeof raw?.text === "string" &&
            raw.text.includes(`<@${botUserId}>`)
          ) {
            message.isMention = true;
          }
          return message;
        },
        options,
      );
    };

    // Adapt the SDK's public message ingress without patching its parser or
    // changing the shared Chat instance used by other platforms.
    await initialize(
      new Proxy(chat, {
        get(target, property) {
          if (property === "processMessage") return processMessage;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
  };

  return adapter;
}
