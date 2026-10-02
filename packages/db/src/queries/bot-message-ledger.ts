import { and, eq, sql } from "drizzle-orm";
import type { Database, DatabaseWithPrimary } from "../client";
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
  attemptId?: string;
};

export async function claimBotMessage(db: Database, params: BotMessageKey) {
  const [claimed] = await db
    .insert(botMessageLedger)
    .values({
      ...params,
      externalTeamId: params.externalTeamId ?? "",
      leaseUntil: sql`now() + interval '10 minutes'`,
    })
    .onConflictDoUpdate({
      target: [
        botMessageLedger.provider,
        botMessageLedger.externalTeamId,
        botMessageLedger.threadId,
        botMessageLedger.externalUserId,
        botMessageLedger.messageId,
      ],
      set: {
        attemptId: params.attemptId,
        status: "started",
        leaseUntil: sql`now() + interval '10 minutes'`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`${botMessageLedger.teamId} = ${params.teamId} AND ${botMessageLedger.userId} = ${params.userId} AND (
        ${botMessageLedger.status} IN ('retryable', 'delivery_failed') OR
        (${botMessageLedger.leaseUntil} < now() AND (${botMessageLedger.responseText} IS NOT NULL OR ${botMessageLedger.executionStarted} = false))
      ) AND ${botMessageLedger.status} <> 'completed'`,
    })
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
    .where(messagePredicate(params))
    .returning({ id: botMessageLedger.id });

  return Boolean(completed);
}

function messagePredicate(params: BotMessageKey) {
  return and(
    eq(botMessageLedger.provider, params.provider),
    eq(botMessageLedger.teamId, params.teamId),
    eq(botMessageLedger.userId, params.userId),
    eq(botMessageLedger.externalTeamId, params.externalTeamId ?? ""),
    eq(botMessageLedger.threadId, params.threadId),
    eq(botMessageLedger.externalUserId, params.externalUserId),
    eq(botMessageLedger.messageId, params.messageId),
    params.attemptId
      ? eq(botMessageLedger.attemptId, params.attemptId)
      : undefined,
  );
}

export async function getBotMessage(db: Database, params: BotMessageKey) {
  const [record] = await ((db as DatabaseWithPrimary).$primary ?? db)
    .select()
    .from(botMessageLedger)
    .where(messagePredicate(params))
    .limit(1);
  return record ?? null;
}

export async function updateBotMessage(
  db: Database,
  params: BotMessageKey,
  values: {
    executionStarted?: boolean;
    responseText?: string;
    toolContext?: string;
    deliveredChunks?: number;
  },
) {
  const rows = await db
    .update(botMessageLedger)
    .set({
      ...values,
      leaseUntil: sql`now() + interval '10 minutes'`,
      updatedAt: sql`now()`,
    })
    .where(messagePredicate(params))
    .returning({ id: botMessageLedger.id });
  if (!rows.length) throw new Error("Bot message lease was lost");
}

export async function failBotMessage(db: Database, params: BotMessageKey) {
  await db
    .update(botMessageLedger)
    .set({
      status: sql`CASE WHEN ${botMessageLedger.responseText} IS NOT NULL THEN 'delivery_failed'
      WHEN ${botMessageLedger.executionStarted} THEN 'needs_review' ELSE 'retryable' END`,
      updatedAt: sql`now()`,
    })
    .where(messagePredicate(params));
}
