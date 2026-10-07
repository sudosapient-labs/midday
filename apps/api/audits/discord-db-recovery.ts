// Isolated PostgreSQL verification. Pass an installed PGlite module path as
// argv[2]; no application database URL or service is used.

import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const modulePath = process.argv[2];
if (!modulePath)
  throw new Error(
    "Pass the absolute path to @electric-sql/pglite/dist/index.js",
  );
const pgliteModule = await import(modulePath);
const { PGlite } = pgliteModule;
mock.module("@electric-sql/pglite", () => pgliteModule);
const { drizzle } = await import("drizzle-orm/pglite");
const ledger = await import(
  "../../../packages/db/src/queries/bot-message-ledger"
);
const identities = await import(
  "../../../packages/db/src/queries/platform-identities"
);
const { addDiscordConnection } = await import(
  "../../../packages/db/src/queries/apps"
);
const { bankAccounts, discordInstallations } = await import(
  "../../../packages/db/src/schema"
);

const pg = new PGlite();
const database: any = drizzle(pg, { casing: "snake_case" });
const teamId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000002";
try {
  await pg.exec(`
    CREATE ROLE authenticated;
    CREATE SCHEMA private;
    CREATE FUNCTION private.get_teams_for_authenticated_user() RETURNS SETOF uuid LANGUAGE SQL AS 'SELECT NULL::uuid WHERE false';
    CREATE TYPE platform_provider AS ENUM ('discord');
    CREATE TABLE teams (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE bank_accounts (id uuid PRIMARY KEY, created_by uuid NOT NULL);
    CREATE TABLE platform_identities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider platform_provider NOT NULL,
      team_id uuid NOT NULL, user_id uuid NOT NULL, external_user_id text NOT NULL,
      external_team_id text NOT NULL DEFAULT '', external_channel_id text, metadata jsonb,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE(provider, external_team_id, external_user_id)
    );
    CREATE TABLE platform_link_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, provider platform_provider NOT NULL,
      team_id uuid NOT NULL, user_id uuid NOT NULL, expires_at timestamptz NOT NULL,
      used_at timestamptz, metadata jsonb, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE apps (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid, config jsonb,
      created_at timestamptz DEFAULT now(), app_id text NOT NULL, created_by uuid, settings jsonb,
      UNIQUE(team_id, app_id)
    );
    INSERT INTO teams VALUES ('${teamId}');
    INSERT INTO users VALUES ('${userId}');
  `);
  for (const name of [
    "0047_add_discord_installations.sql",
    "0048_add_bot_message_ledger.sql",
    "0049_recover_bot_message_delivery.sql",
  ]) {
    await pg.exec(
      await readFile(
        new URL(`../../../packages/db/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const key = {
    provider: "discord" as const,
    teamId,
    userId,
    threadId: "thread",
    externalUserId: "member",
    messageId: "retry",
    attemptId: "attempt-1",
  };
  assert.equal(await ledger.claimBotMessage(database, key), true);
  assert.equal(
    await ledger.claimBotMessage(database, { ...key, attemptId: "competing" }),
    false,
  );
  await ledger.failBotMessage(database, key);
  const retry = { ...key, attemptId: "attempt-2" };
  assert.equal(await ledger.claimBotMessage(database, retry), true);
  await assert.rejects(
    ledger.updateBotMessage(database, key, { executionStarted: true }),
    /lease was lost/,
  );
  await ledger.updateBotMessage(database, retry, {
    responseText: "Saved once.",
    toolContext: "record-id",
    deliveredChunks: 1,
  });
  await ledger.failBotMessage(database, retry);
  const delivery = { ...key, attemptId: "delivery" };
  assert.equal(await ledger.claimBotMessage(database, delivery), true);
  const saved = await ledger.getBotMessage(database, delivery);
  assert.equal(saved?.responseText, "Saved once.");
  assert.equal(saved?.deliveredChunks, 1);
  await ledger.completeBotMessage(database, delivery);
  assert.equal(
    await ledger.claimBotMessage(database, {
      ...key,
      attemptId: "after-complete",
    }),
    false,
  );
  console.log(
    "PASS: retry claims, ownership fencing, saved outcomes, delivery progress, and completion",
  );

  const uncertain = { ...key, messageId: "uncertain" };
  await ledger.claimBotMessage(database, uncertain);
  await ledger.updateBotMessage(database, uncertain, {
    executionStarted: true,
  });
  await ledger.failBotMessage(database, uncertain);
  assert.equal(
    (await ledger.getBotMessage(database, uncertain))?.status,
    "needs_review",
  );
  assert.equal(
    await ledger.claimBotMessage(database, {
      ...uncertain,
      attemptId: "replay",
    }),
    false,
  );
  const expired = { ...key, messageId: "expired" };
  await ledger.claimBotMessage(database, expired);
  await pg.exec(
    "UPDATE bot_message_ledger SET lease_until = now() - interval '1 minute' WHERE message_id = 'expired'",
  );
  assert.equal(
    await ledger.claimBotMessage(database, {
      ...expired,
      attemptId: "new-lease",
    }),
    true,
  );
  console.log(
    "PASS: uncertain writes cannot replay; expired pre-execution leases can recover",
  );

  await pg.exec(
    `INSERT INTO platform_link_tokens (code, provider, team_id, user_id, expires_at) VALUES ('rollback', 'discord', '${teamId}', '${userId}', now() + interval '1 hour')`,
  );
  await assert.rejects(
    database.transaction(async (tx: any) => {
      const token = await identities.consumePlatformLinkToken(tx, {
        provider: "discord",
        code: "rollback",
      });
      assert(token);
      await identities.createOrUpdatePlatformIdentity(tx, {
        provider: "discord",
        teamId,
        userId,
        externalUserId: "rollback-member",
        externalTeamId: "rollback-guild",
      });
      await addDiscordConnection(tx, {
        teamId,
        userId: "rollback-member",
        guildId: "rollback-guild",
        createdBy: userId,
      });
      throw new Error("setup failed after writes");
    }),
    /setup failed/,
  );
  assert.equal(
    (
      await pg.query(
        "SELECT used_at FROM platform_link_tokens WHERE code = 'rollback'",
      )
    ).rows[0].used_at,
    null,
  );
  for (const table of [
    "platform_identities",
    "discord_installations",
    "apps",
  ]) {
    assert.equal(
      (await pg.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
      0,
    );
  }
  console.log(
    "PASS: transaction failure rolls back token, identity, guild binding, and app connection",
  );

  assert.equal(bankAccounts.createdBy.notNull, true);
  assert.equal(discordInstallations.createdBy.notNull, false);
  await pg.exec(
    `INSERT INTO discord_installations (guild_id, team_id, created_by) VALUES ('surviving-guild', '${teamId}', '${userId}'); DELETE FROM users WHERE id = '${userId}'`,
  );
  assert.equal(
    (
      await pg.query(
        "SELECT created_by FROM discord_installations WHERE guild_id = 'surviving-guild'",
      )
    ).rows[0].created_by,
    null,
  );
  console.log(
    "PASS: schema nullability and installer deletion preserve guild ownership",
  );
} finally {
  await pg.close();
}
