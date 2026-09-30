import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client";
import { botMessageLedger } from "../schema";
import type { PlatformProvider } from "./platform-identities";

type BotMessageKey = {
  provider: PlatformProvider;
  teamId: string;
  userId: string;
  externalTeamId?: string | null;
  threadId: string;
  externalUserId: string;
  messageId: string;
};

export async function claimBotMessage(db: Database, params: BotMessageKey) {
  const [claimed] = await db
    .insert(botMessageLedger)
    .values({
      ...params,
      externalTeamId: params.externalTeamId ?? "",
    })
    .onConflictDoNothing()
    .returning({ id: botMessageLedger.id });

  return Boolean(claimed);
}

export async function completeBotMessage(db: Database, params: BotMessageKey) {
  const [completed] = await db
    .update(botMessageLedger)
    .set({
      status: "completed",
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(botMessageLedger.provider, params.provider),
        eq(botMessageLedger.teamId, params.teamId),
        eq(botMessageLedger.userId, params.userId),
        eq(botMessageLedger.externalTeamId, params.externalTeamId ?? ""),
        eq(botMessageLedger.threadId, params.threadId),
        eq(botMessageLedger.externalUserId, params.externalUserId),
        eq(botMessageLedger.messageId, params.messageId),
      ),
    )
    .returning({ id: botMessageLedger.id });

  return Boolean(completed);
}
