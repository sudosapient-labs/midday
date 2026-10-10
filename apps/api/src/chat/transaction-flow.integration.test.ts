import { beforeAll, expect, mock, test } from "bun:test";
import type { McpContext } from "@api/mcp/types";
import { expandScopes } from "@api/utils/scopes";
import { db } from "@midday/db/client";
import { createTransactions } from "@midday/db/queries";
import { sql } from "drizzle-orm";
import { safeErrorDetails, toolOutcome } from "./diagnostics";
import { buildSystemPrompt } from "./prompt";
import { createExecutionClient } from "./tools";

// External integrations are out of scope; never connect test identities to them.
mock.module("@api/composio/client", () => ({
  getComposioTools: async () => ({}),
}));
const { streamMiddayAssistant } = await import("./assistant-runtime");

const enabled = process.env.SLACK_AUDIT_TEST === "true";
const teamId = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";
const bankAccountId = "00000000-0000-4000-8000-000000000103";
const ctx: McpContext = {
  db,
  teamId,
  userId,
  userEmail: "audit@example.invalid",
  scopes: expandScopes(["apis.all"]) as McpContext["scopes"],
  apiUrl: "http://localhost",
  timezone: "UTC",
  locale: "en",
  countryCode: "IN",
  dateFormat: null,
  timeFormat: 24,
};

beforeAll(async () => {
  if (!enabled) return;
  if (
    new URL(process.env.DATABASE_PRIMARY_URL!).pathname !==
    "/midday_slack_audit_20261010"
  ) {
    throw new Error(
      "Refusing integration tests outside the isolated audit database",
    );
  }
  await db.execute(
    sql`insert into auth.users (id) values (${userId}) on conflict do nothing`,
  );
  await db.execute(
    sql`insert into public.users (id, full_name, email) values (${userId}, 'Audit User', 'audit@example.invalid') on conflict do nothing`,
  );
  await db.execute(
    sql`insert into teams (id, name, base_currency) values (${teamId}, 'Synthetic Audit', 'INR') on conflict do nothing`,
  );
  await db.execute(sql`update users set team_id=${teamId} where id=${userId}`);
  await db.execute(
    sql`insert into users_on_team (user_id,team_id,role) values (${userId},${teamId},'owner') on conflict do nothing`,
  );
  await db.execute(
    sql`insert into bank_accounts (id,name,currency,team_id,created_by,account_id,manual,enabled,balance) values (${bankAccountId},'SIB','INR',${teamId},${userId},'audit-sib',true,true,242315) on conflict do nothing`,
  );
});

test.skipIf(!enabled)(
  "real MCP transaction creation and balance update",
  async () => {
    await db.execute(sql`delete from transactions where team_id=${teamId}`);
    await db.execute(
      sql`update bank_accounts set balance=242315 where id=${bankAccountId}`,
    );
    const client = await createExecutionClient(ctx);
    try {
      const tools = await client.tools();
      const result = await tools.transactions_create_bulk!.execute!(
        {
          transactions: [
            {
              name: "Audit Workspace",
              amount: -252,
              date: "2026-10-03",
              currency: "INR",
              bankAccountId,
              assignedId: "",
              categorySlug: "",
            },
            {
              name: "Audit Rent",
              amount: -25000,
              date: "2026-10-06",
              currency: "INR",
              bankAccountId,
              assignedId: null,
              categorySlug: null,
            },
            {
              name: "Audit Groceries",
              amount: -255,
              date: "2026-10-06",
              currency: "INR",
              bankAccountId,
            },
          ],
        },
        { toolCallId: "audit-direct", messages: [] },
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.data).toHaveLength(3);
      const count = await db.execute(
        sql`select count(*)::int as count from transactions where team_id=${teamId}`,
      );
      expect(count.rows[0].count).toBe(3);
      const balance = await db.execute(
        sql`select balance from bank_accounts where id=${bankAccountId}`,
      );
      expect(Number(balance.rows[0].balance)).toBe(216808);
    } finally {
      await client.close();
    }
  },
  60000,
);

test.skipIf(!enabled)(
  "reproduces the original blank UUID failure without changing records",
  async () => {
    const count = await db.execute(
      sql`select count(*)::int as count from transactions where team_id=${teamId}`,
    );
    const balance = await db.execute(
      sql`select balance from bank_accounts where id=${bankAccountId}`,
    );
    let caught: unknown;
    try {
      await createTransactions(db, [
        {
          teamId,
          bankAccountId,
          name: "Audit invalid input",
          amount: -1,
          currency: "INR",
          date: "2026-10-10",
          assignedId: "",
          categorySlug: "",
        },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(safeErrorDetails(caught).code).toBe("22P02");
    expect(
      (
        await db.execute(
          sql`select count(*)::int as count from transactions where team_id=${teamId}`,
        )
      ).rows,
    ).toEqual(count.rows);
    expect(
      (
        await db.execute(
          sql`select balance from bank_accounts where id=${bankAccountId}`,
        )
      ).rows,
    ).toEqual(balance.rows);
  },
  60000,
);

test.skipIf(!enabled)(
  "real production model saves a confirmed Slack-style follow-up",
  async () => {
    await db.execute(sql`delete from transactions where team_id=${teamId}`);
    await db.execute(
      sql`update bank_accounts set balance=242315 where id=${bankAccountId}`,
    );
    const result = await streamMiddayAssistant({
      mcpCtx: ctx,
      systemPrompt: buildSystemPrompt({
        fullName: "Audit User",
        locale: "en",
        timezone: "UTC",
        dateFormat: null,
        timeFormat: 24,
        baseCurrency: "INR",
        teamName: "Synthetic Audit",
        countryCode: "IN",
        localTime: "2026-10-10T08:00:35Z",
      }),
      modelMessages: [
        {
          role: "user",
          content:
            "Add these transactions to SIB: Oct 3 2026 Audit Workspace INR 252 expense; Oct 6 2026 Audit Rent INR 25000 expense; Oct 6 2026 Audit Groceries INR 255 expense. SIB opening balance is INR 242315.",
        },
        {
          role: "assistant",
          content:
            "Confirm creating these 3 expenses in the existing SIB INR account: Audit Workspace -252 on Oct 3, Audit Rent -25000 on Oct 6, Audit Groceries -255 on Oct 6. Total INR 25507, expected balance INR 216808. Save these?",
        },
        { role: "user", content: "Yes, save these." },
        {
          role: "assistant",
          content: "The insertions failed. Nothing was saved.",
        },
        { role: "user", content: "try again, and create these issues" },
      ],
    });
    try {
      for await (const part of result.fullStream) {
        if (part.type === "tool-error")
          console.log(
            "TEST tool-error",
            part.toolName,
            safeErrorDetails(part.error),
          );
        if (part.type === "tool-result")
          console.log(
            "TEST tool-result",
            part.toolName,
            toolOutcome(part.output),
          );
        if (part.type === "error") throw new Error("Model stream failed");
      }
      console.log("TEST answer", await result.text);
      const count = await db.execute(
        sql`select count(*)::int as count from transactions where team_id=${teamId}`,
      );
      expect(count.rows[0].count).toBe(3);
      const balance = await db.execute(
        sql`select balance from bank_accounts where id=${bankAccountId}`,
      );
      expect(Number(balance.rows[0].balance)).toBe(216808);
    } finally {
      await result.cleanup();
    }
  },
  180000,
);
