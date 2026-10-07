# PR #5 re-audit and remediation — 2026-10-02

Reviewed commit: `194b38246c9a6c999fb69aec5aad31717261ca45`.
PR: https://github.com/sudosapient-labs/midday/pull/5

**Historical audit recommendation at `194b38246`: request changes.** The findings below describe that commit. The subsequent implementation addresses all seven groups; the original reproductions are now regression tests. The earlier claim that all findings were resolved was too strong.

## Remediation

| Finding | Implemented change |
| --- | --- |
| Notification destinations | Receipt and batch delivery resolve the current channel through Discord REST, require the authorized guild, and enforce configured guild/channel restrictions. Only Discord thread types may use an allowed parent. Missing channels and API errors fail closed. |
| Request and delivery recovery | The ledger has fenced attempts, expiring pre-execution leases, retryable failures, saved response/tool context, and per-chunk delivery progress. Reads use the primary database. Completed actions cannot replay. Uncertain writes require record inspection rather than an automatic financial retry. |
| Cancellation and approval | Discord mutation tools stage exact operation/argument previews. Only an explicit confirmation after successful preview delivery can execute them. Corrections revoke the old approval; cancellation clears pending state. Mutation calls are serialized and duplicate execution is blocked. Invoice payment/reminder and document-tagging operations are covered; unknown operations fail closed. |
| Schema parity | Restore `bank_accounts.created_by` to non-null and make `discord_installations.created_by` nullable in both schema and the follow-up migration. |
| Tool summaries | Prioritize statuses, error flags, IDs, and text before descriptions. Allocate a structured budget per tool result and serialize complete entries, including omission counts. |
| Attachment context | Persist attachment-only upload summaries and inbox IDs. Save the upload acknowledgment before delivery so retries do not upload again. |
| Atomic linking | Consume the token, check membership, validate/write identity, claim the guild, and update the app in one database transaction. Welcome messages and contact-card delivery happen after commit. |

Verification:

- `bun run test` in `apps/api`: **481 passed, 0 failed**, including the new Discord regressions, each mock-heavy audit in its own process.
- Bot package tests: **17 passed, 0 failed**. The original runtime and notification audits also pass (**14 + 2 tests**).
- API, bot, and database TypeScript checks and Biome checks passed for the changed implementation.
- `audits/discord-db-recovery.ts` exercises the real migrations and query functions in an isolated PGlite PostgreSQL engine: retry acquisition, stale-owner fencing, saved outcomes, delivery progress, completed/uncertain replay rejection, lease expiry, rollback of all linking writes, and installer deletion.

Reproduce the isolated database verification from the repository root:

```sh
npm install --prefix /tmp/midday-pr5-db-verification --no-audit --no-fund @electric-sql/pglite
bun run apps/api/audits/discord-db-recovery.ts /tmp/midday-pr5-db-verification/node_modules/@electric-sql/pglite/dist/index.js
```

Deployment must apply `0049_recover_bot_message_delivery.sql` after migrations 0047/0048 and before starting this API version. Existing `started` rows are treated as potentially executed and never automatically replayed. The restored bank-account constraint requires existing rows to have a creator; the migration does not rewrite or delete financial data.

No live Discord installation or delivery was exercised. A Discord send accepted immediately before a process crash may be delivered again because its acknowledgment was not persisted; financial tools are not rerun. A process failure after a financial write but before its verified result is saved requires checking the affected records.

## Original findings at the audited commit

## 1. P1 — Notification destination is still not authorized

Location: `packages/bot/src/activity-notifications.ts:524`.

Current identity, membership, app settings, and guild installation checks are useful. However, the sender still accepts the channel/thread ID from saved inbox metadata without proving that destination belongs to the authorized guild or allowed parent channel. It also does not enforce `DISCORD_GUILD_ID`/`DISCORD_CHANNEL_ID` restrictions on delivery.

Reproduction: set `DISCORD_CHANNEL_ID=allowed-channel`, retain a valid guild-scoped identity and installation, then supply a stale different channel in receipt metadata. The real orchestration calls the mocked sender with the private receipt text and the disallowed destination.

This proves restriction bypass with saved metadata, not a live attack that forges inbox metadata. Check the actual Discord channel's guild and parent against the current installation and configured restrictions before delivery, including batched notifications. Do not compare a thread ID directly to a parent channel ID.

## 2. P1 — The action ledger prevents recovery as well as replay

Locations: `apps/api/src/bot/runtime.ts:322`, `packages/db/src/queries/bot-message-ledger.ts:16`, `apps/api/src/bot/runtime.ts:472`.

A delivery is permanently claimed before model setup, uploads, or tool execution. Every subsequent conflict returns immediately, regardless of whether the first run failed before doing anything, is still running, or completed but never delivered its answer. There is no lease, error state, recoverable response, or separate delivery retry.

Reproduction: first model call throws a transient error; retry the same message with a now-working model. The assistant is called only once, and the retry never completes. The existing post-failure regression also asserts only that the assistant does not rerun; it does not verify recovery of the saved answer.

The ledger helps prevent duplicate actions, but it is not a complete action/delivery state machine. Add recoverable states and separately retry delivery from saved outcomes; use tool-level idempotency for uncertain writes rather than blindly rerunning a financial turn.

## 3. P2 — Cancellation and pending-preview state remain incomplete

Locations: `apps/api/src/chat/tools.ts:253`, `apps/api/src/chat/tools.ts:383`, `apps/api/src/chat/assistant-runtime.ts:76`.

The current task heuristic still concatenates cancellation with the earlier delete request. There is no durable pending-action/approval binding at tool execution. Mutation exposure is decided by words in user history, which does not distinguish preview edits from edits to saved records.

Real-catalog reproductions:
- `Delete the old transactions` → `never mind, don't delete them` still selects `transactions_delete_bulk`.
- `Save expenses 0.55 water` → `correct it to 55` → `yes, save them` selects update tools and drops `transactions_create_bulk`.

These are tool-availability reproductions, not claims that a live LLM deleted records after cancellation. Track pending tasks, cancellation, execution status, and approval for exact operations/arguments outside the prompt.

## 4. P2 — The last schema fix edited the wrong table

Locations: `packages/db/src/schema.ts:697`, `packages/db/src/schema.ts:1967`, migration `0047_add_discord_installations.sql`.

Commit `194b38246` made **bank_accounts.created_by** nullable. **discord_installations.created_by** remains `NOT NULL` in the Drizzle schema while its foreign key uses `ON DELETE SET NULL`. The SQL migration correctly makes the Discord column nullable, so migration-created and schema-pushed databases disagree.

Under a schema-pushed database, deleting the installer cannot set this non-null column to null. Restore the unrelated bank-account constraint and make the Discord installer column nullable in the schema. This is confirmed by the commit diff/schema inspection; no PostgreSQL deletion was run.

## 5. P2 — Verified outcomes still lose IDs and error status

Locations: `apps/api/src/bot/runtime.ts:566`, `apps/api/src/bot/runtime.ts:580`.

The summary still slices serialized JSON at 12,000 characters, limits extraction to 100 fields in encounter order, and lets descriptions consume the budget before later IDs. It ignores camelCase `isError` and text blocks when a recognized structured field is present.

Reproductions:
- A bulk result of 30 records with long descriptions loses `record-29` in the next turn.
- A tool output with `isError: true`, a permission-denied text block, and a structured record ID retains the ID but drops both the error status and explanation.

Use operation-aware summaries that prioritize success/error, record IDs, and relevant values; budget complete structured entries before serialization. Never truncate JSON bytes or discard failure status.

## 6. P2 — Attachment-only turns still do not retain conversational context

Location: `apps/api/src/bot/runtime.ts:345`.

The attachment-only branch writes dedupe IDs and completes the ledger, then returns without appending receipt summaries or inbox/entity IDs to conversation memory. Dedupe has improved, but receipt follow-ups before a match notification remain context-free.

Reproduction: upload an attachment with no text, then ask `explain that receipt`. The model input contains only the follow-up, with no prior upload summary.

Persist the successful upload's identifiers and bounded summary before returning, independently of whether the user included text.

## 7. P2 — Linking still commits side effects before identity validation

Location: `apps/api/src/bot/platform-resolver.ts:84`.

The token is consumed first; `afterConnect` then claims the guild and updates the app; identity ownership is validated afterward. These writes are not one transaction. A conflict or later database failure can consume the token and leave partial setup/connection state.

Reproduction confirms the token-consumption and app-setup calls happen before a deliberately failing identity write. Database rollback was not exercised; the production query sequence has no enclosing transaction.

Validate ownership and atomically commit the token consumption, guild binding, identity, and app connection. Send the welcome response after the transaction.

## Improvements confirmed

- Guild/workspace binding rejects a second workspace during a chat turn.
- Workspace currency and conversation history remain scoped to the linked identity.
- Removed identities prevent receipt notification delivery.
- Bot conversations explicitly disable user-wide Composio tools.
- The bot instance now selects the ordered queue strategy.
- Completed actions are deduplicated independently from trimmed conversation text.
- Baseline topic-switch and simple `55, not 0.55` routing cases work.
- Generated notification REST payloads disable mention parsing.

## Validation and scope

- Full API suite: **439 passed, 0 failed**.
- Runtime re-audit: **19 passed**, comprising 14 existing controls/regressions and 5 bug-characterization tests.
- Routing re-audit: **5 passed**, comprising 3 existing regressions and 2 bug-characterization tests.
- Notification re-audit: **3 passed**, comprising 2 existing regressions and 1 bug-characterization test.
- **Eight passing REPRO tests mean eight failures were demonstrated, not fixed.**

The three new audit files are `apps/api/audits/discord-reaudit*.test.ts`. Run each in its own Bun process because module mocks are global. Fixtures are synthetic; model generation, database queries, and outbound sends are mocked. Routing uses the real MCP tool catalog. No live Discord message, real financial write, PostgreSQL migration/deletion, or deployment was performed.

The existing audit tests remain useful, but they cover the happy-path fixes and cannot establish approval enforcement, rollback, migration parity, destination authorization, or failed-delivery recovery.
