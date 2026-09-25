import { registerMiddayBotRuntime } from "@api/bot/runtime";
import type { Context } from "@api/rest/types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bot } from "@midday/bot";

const app = new OpenAPIHono<Context>();

registerMiddayBotRuntime();

app.post("/", async (c) => {
  if (
    !process.env.DISCORD_BOT_TOKEN ||
    !process.env.DISCORD_PUBLIC_KEY ||
    !process.env.DISCORD_APPLICATION_ID
  ) {
    return c.text("Discord is not configured", 503);
  }

  await bot.initialize();

  const webhook = (
    bot.webhooks as unknown as {
      discord?: (request: Request) => Promise<Response>;
    }
  ).discord;

  if (!webhook) {
    return c.text("Discord is not initialized", 503);
  }

  // The adapter validates the unmodified request body against Discord's
  // Ed25519 signature, so pass Hono's raw request through unchanged.
  return webhook(c.req.raw);
});

export const discordWebhookRouter = app;
