import { eq, sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../client";
import { DiscordInstallationAlreadyLinkedError } from "../errors";
import { discordInstallations } from "../schema";

export async function getDiscordInstallation(
  db: DatabaseOrTransaction,
  guildId: string,
) {
  const [installation] = await db
    .select()
    .from(discordInstallations)
    .where(eq(discordInstallations.guildId, guildId))
    .limit(1);

  return installation ?? null;
}

export async function claimDiscordInstallation(
  db: DatabaseOrTransaction,
  params: { guildId: string; teamId: string; createdBy: string },
) {
  await db
    .insert(discordInstallations)
    .values(params)
    .onConflictDoNothing({ target: discordInstallations.guildId });

  const installation = await getDiscordInstallation(db, params.guildId);
  if (!installation || installation.teamId !== params.teamId) {
    throw new DiscordInstallationAlreadyLinkedError();
  }

  if (installation.createdBy === params.createdBy) {
    return installation;
  }

  const [updated] = await db
    .update(discordInstallations)
    .set({ updatedAt: sql`now()` })
    .where(eq(discordInstallations.id, installation.id))
    .returning();

  return updated ?? installation;
}
