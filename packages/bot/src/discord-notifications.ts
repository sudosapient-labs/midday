import { createLoggerWithContext } from "@midday/logger";

const logger = createLoggerWithContext("discord-notifications");

export async function sendDiscordTextNotification(params: {
  channelId: string;
  text: string;
}) {
  const botToken = process.env.DISCORD_BOT_TOKEN;

  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required to send Discord notifications",
    );
  }

  const response = await fetch(
    `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: params.text.slice(0, 2000) }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    logger.error("Failed to send Discord notification", {
      channelId: params.channelId,
      status: response.status,
      response: body.slice(0, 500),
    });
    throw new Error(
      `Discord notification failed with status ${response.status}`,
    );
  }
}
