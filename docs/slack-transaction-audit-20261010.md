# Slack transaction failure audit — 2026-10-10

## Evidence

- The incident webhook was accepted and processed, but no requested transactions
  were present in production. HTTP 200 was not reply or write success.
- Follow-up `try again, and create these issues` dropped the transaction domain:
  generic action words were incorrectly treated as explicit domain switches.
- Reproduced the failed insertion with the production model against a separate,
  schema-only database containing synthetic fixtures. The model populated unused
  assignment/category fields with empty strings; bulk insertion returned a SQL
  error, zero records and no balance change. Direct reproduction confirms PostgreSQL
  `22P02` for the empty assignment UUID. Original tool arguments were not logged,
  so this is a reproduced failure mechanism, not a recovered incident trace.
- No replica is configured locally. Replica lag is not an evidenced explanation
  for this incident; primary-only bot reads are defensive consistency hardening.

## Changes

- Preserve the recent domain for short follow-ups without inheriting old write
  intent into read-only questions or overriding a new action/domain.
- Keep transaction lookup tools available during creation for duplicate checks.
- Normalize blank/null optional assignment and category fields at the MCP boundary;
  reject malformed non-empty UUIDs before database execution.
- Log tool name/call ID/outcome/count and allowlisted error metadata, not arguments,
  SQL, message content, credentials or financial data.
- Surface stream failures instead of allowing Chat SDK to silently ignore error
  chunks; post a failure response for Slack DMs too.
- Distinguish failed/uncertain writes and partial success. Never advise blind retries.

## Tests and boundaries

Run suites in separate Bun processes: existing DB/module mocks leak across suites.

```sh
bun scripts/run-slack-audit.ts test --exit src/chat/tools.test.ts src/chat/diagnostics.test.ts src/mcp/transaction-input.test.ts
bun scripts/run-slack-audit.ts test --exit src/__tests__/routers/bot-runtime.test.ts
bun scripts/run-slack-audit.ts test --exit /app/packages/bot/src/slack-adapter.test.ts
bun scripts/run-slack-audit.ts test --exit src/chat/transaction-flow.integration.test.ts
bun scripts/run-slack-audit.ts test --exit src/chat/slack-workflow.integration.test.ts
```

The runner uses live model configuration but redirects every database connection
to `midday_slack_audit_20261010`. Financial fixtures are synthetic. External
integrations are disabled. No real Slack messages or production financial writes
are permitted. Tests assert 3 rows and the expected balance, empty-field handling,
rollback on malformed UUIDs, and routing/stream-error regressions.

Final results: 64 distinct passing tests across routing/input/diagnostics (21),
bot runtime (22), Slack ingress (8), MCP authorization/schema (9), real database
and model tests (3), and the combined signed Slack workflow (1).

The combined workflow passed at 08:48:41 UTC with 17 assertions: no writes before
confirmation, exactly 3 writes after confirmation, correct balance, completed
native Slack streaming response containing a success acknowledgment, and no
additional reply/records/balance change on duplicate delivery. It uses real bot
handlers, identity/membership queries, model, MCP and SQL. Chat state/history
are in-memory, and Slack HTTP is intercepted at the Axios transport; no real
Slack delivery is claimed. An earlier harness attempt used an incomplete
fetch-only interception and received `invalid_auth` using a fake token; no real
message was sent. That attempt was not accepted as end-to-end success.

A whole-API TypeScript check was stopped when it caused memory pressure on the
shared host; do not describe that check as passed. Runtime suites and formatting
are the verification gates for this narrow patch.

## Local deployment / rollback

Base checkout: `e7b8a896ab32f3f701426aafbda1f832c74f7d57`.
The original dirty checkout `/root/midday-mod` is unchanged.

The existing API image is preserved as `midday-local-api:before-slack-fix-20261010`.
Build only the changed API source layer with `apps/api/Dockerfile.slack-fix`.
Append `/root/midday-slack-fix/compose.slack-fix.yml` to the existing compose files
and run `up -d --no-deps --no-build api`. Do not rebuild dashboard/worker or touch
database/storage/Redis services. No migrations are needed.

To roll back, omit the final hotfix override and run the same scoped API recreation
with `--no-build`; the original `midday-local-api:latest` tag is unchanged.
The isolated audit database may be retained for repeatable tests; it contains no
copied production rows.

Deployed 2026-10-10 08:39 UTC. Internal and public API health checks returned
`{"status":"ok"}`. API, worker and dashboard are healthy; worker/dashboard start
times did not change. Before/after checksums of all 199 production transactions
and all 3 bank-account rows match exactly. Live source hashes match this worktree.
