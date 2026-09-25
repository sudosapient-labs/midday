import { createDiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { resolveRedisUrl } from "@midday/cache/shared-redis";
import { Chat } from "chat";
import { createSendblueAdapter } from "chat-adapter-sendblue";

export function createMiddayBot() {
  const adapters = {
    whatsapp: createWhatsAppAdapter(),
    telegram: createTelegramAdapter(),
    slack: createSlackAdapter(),
    sendblue: createSendblueAdapter(),
  };

  // Discord is created only when configured, but keep it in the adapter map's
  // static type so the Gateway entrypoint can access it without weakening the
  // Chat adapter contract. The guarded runtime path below guarantees it exists
  // before anyone calls getAdapter("discord").
  const typedAdapters = adapters as typeof adapters & {
    discord: ReturnType<typeof createDiscordAdapter>;
  };

  // The Discord adapter validates its credentials during construction. Keep it
  // optional so environments that have not enabled Discord remain bootable.
  if (
    process.env.DISCORD_BOT_TOKEN &&
    process.env.DISCORD_PUBLIC_KEY &&
    process.env.DISCORD_APPLICATION_ID
  ) {
    typedAdapters.discord = createDiscordAdapter();
  }

  return new Chat({
    userName: "midday",
    adapters: typedAdapters,
    state: createRedisState({ url: resolveRedisUrl() }),
    concurrency: {
      strategy: "debounce",
      debounceMs: 1500,
    },
  });
}

export const bot = createMiddayBot();
