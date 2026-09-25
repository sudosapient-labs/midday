import { registerMiddayBotRuntime } from "@api/bot/runtime";
import type { DiscordAdapter } from "@chat-adapter/discord";
import { bot } from "@midday/bot";
import { createLoggerWithContext } from "@midday/logger";

const logger = createLoggerWithContext("discord-gateway");
const GATEWAY_SESSION_MS = 50 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 1000;

let listenerActive = false;
let restartTimer: ReturnType<typeof setTimeout> | undefined;

function isDiscordConfigured() {
  return Boolean(
    process.env.DISCORD_BOT_TOKEN &&
      process.env.DISCORD_PUBLIC_KEY &&
      process.env.DISCORD_APPLICATION_ID &&
      process.env.DISCORD_GUILD_ID &&
      process.env.DISCORD_CHANNEL_ID,
  );
}

function scheduleGatewayRestart(delay = RETRY_DELAY_MS) {
  if (!isDiscordConfigured() || listenerActive || restartTimer) {
    return;
  }

  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    void startGatewaySession();
  }, delay);
}

async function startGatewaySession() {
  if (!isDiscordConfigured() || listenerActive) {
    return;
  }

  listenerActive = true;

  try {
    registerMiddayBotRuntime();
    await bot.initialize();

    const adapter = bot.getAdapter("discord") as DiscordAdapter;
    const response = await adapter.startGatewayListener(
      {
        waitUntil: (task) => {
          void task
            .catch((error) => {
              logger.error("Discord Gateway listener failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => {
              listenerActive = false;
              scheduleGatewayRestart();
            });
        },
      },
      GATEWAY_SESSION_MS,
    );

    if (!response.ok) {
      listenerActive = false;
      logger.error("Discord Gateway listener did not start", {
        status: response.status,
      });
      scheduleGatewayRestart();
    }
  } catch (error) {
    listenerActive = false;
    logger.error("Unable to start Discord Gateway listener", {
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleGatewayRestart();
  }
}

/** Start the persistent Discord Gateway listener when Discord is configured. */
export function startDiscordGateway() {
  if (!isDiscordConfigured()) {
    logger.info(
      "Discord Gateway disabled; configure Discord credentials, guild, and channel to enable it",
    );
    return;
  }

  void startGatewaySession();
}
