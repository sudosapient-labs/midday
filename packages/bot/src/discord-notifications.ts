import { createLoggerWithContext } from "@midday/logger";

const logger = createLoggerWithContext("discord-notifications");
const DISCORD_MESSAGE_LIMIT = 2_000;

// Resolve the destination at delivery time: stored inbox metadata can outlive
// an installation or a channel restriction. Fail closed on Discord errors.
export async function isAuthorizedDiscordDestination(
  channelId: string,
  guildId: string,
) {
  if (!guildId || !process.env.DISCORD_BOT_TOKEN) return false;
  if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_GUILD_ID !== guildId)
    return false;
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`,
      {
        headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      },
    );
    if (!response.ok) return false;
    const channel = (await response.json()) as {
      id?: string;
      guild_id?: string;
      parent_id?: string;
      type?: number;
    };
    if (channel.id !== channelId || channel.guild_id !== guildId) return false;
    const allowed = process.env.DISCORD_CHANNEL_ID;
    const isThread = [10, 11, 12].includes(channel.type ?? -1);
    return (
      !allowed ||
      channelId === allowed ||
      (isThread && channel.parent_id === allowed)
    );
  } catch {
    return false;
  }
}

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
        body: JSON.stringify({
          content,
          allowed_mentions: { parse: [] },
        }),
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
