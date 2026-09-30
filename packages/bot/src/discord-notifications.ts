import { createLoggerWithContext } from "@midday/logger";

const logger = createLoggerWithContext("discord-notifications");
const DISCORD_MESSAGE_LIMIT = 2_000;

export function splitDiscordText(
  text: string,
  limit = DISCORD_MESSAGE_LIMIT,
): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit / 2) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit / 2) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

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

  for (const content of splitDiscordText(params.text)) {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(params.channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content }),
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
}
