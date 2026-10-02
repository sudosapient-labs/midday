# Discord conversation audit — 2026-09-30

Audited `main` at `a42d54380c67e1f195ed04da78315d8c42e82d2a`, concentrating on `2be35217` (Discord integration) and `a42d5438` (context and tool routing).

The original implementation passed its existing tests but did not exercise multi-turn tool selection, workspace changes inside a shared Discord thread, Discord message limits, or messaging-specific prompts. The branch `fix/discord-persistent-context` adds regression coverage and resolves the confirmed failures.

## Implemented changes

### Persistent, scoped conversation context

- Stores a bounded conversation per platform, Midday workspace, Midday user, and external user.
- Persists user requests, assistant replies, and compact verified tool outcomes for later corrections and follow-ups.
- Keeps up to 16 messages and 24,000 characters per conversation, with at most eight identities in one thread state.
- Does not import another Discord participant's raw channel history into the current workspace context.
- Ignores a message ID after its completed exchange has been persisted, preventing retry-driven duplicate writes.
- Clears thread state with replacement semantics when authorization is revoked.

### Reliable tool selection

- Treats confirmations, corrections, pronouns, and account selections as continuations of the pending task.
- Treats an explicit domain change, such as “show my invoices,” as a new task.
- Guarantees the required transaction tools in both lexical fallback mode and normal embedding-index mode.
- Keeps create, update, delete, read, and balance tool families distinct.

### Correct workspace and Discord behavior

- Builds currency, country, and company context from the workspace linked to the messaging identity rather than the user's currently selected dashboard workspace.
- Accepts the dashboard's documented `Connect to Midday: CODE` message in the configured Discord channel without requiring an undocumented mention.
- Continues normal conversations only in subscribed threads, avoiding unsolicited replies to every channel message.
- Sends receipt match follow-ups to the originating Discord thread instead of using the guild ID as a channel ID.
- Splits assistant replies and proactive Discord notifications into messages of at most 2,000 characters, preserving final totals and confirmation questions.

### Messaging-specific responses

- Removes dashboard-only side panel assumptions and fragment links from external messaging prompts.
- Requires invoice number, customer, total, due date, status, and a usable preview URL in messaging replies when available.
- Uses compact lists or paragraphs for external messaging while retaining dashboard-specific tables and entity links in the dashboard.

### Observability

- Emits structured start and completion events with platform, thread, message, workspace, duration, response length, persisted-message count, and whether tool context was retained.
- Emits a separate event when a completed message retry is ignored.
- Does not log message contents in these events.

## Conversation model

Discord conversation state is stored in the existing Redis-backed Chat thread state, which has a 30-day TTL. The durable context key includes platform, workspace, acting user, and external user. The assistant receives only that scoped context plus the current Discord message.

Tool outcomes are stored as bounded internal context. They let a later instruction such as “55, not 0.55” reuse returned transaction IDs without presenting historical results as a new action. The assistant must still execute and verify a new write before claiming that the correction succeeded.

## Regression coverage

Run the audit files independently because the runtime harness uses process-global Bun module mocks:

```sh
bun test --exit --timeout 30000 audits/discord-routing.test.ts
bun test --exit --timeout 30000 audits/discord-runtime.test.ts
```

Coverage includes:

- expense preview → confirmation;
- correction routing;
- account clarification → confirmation;
- explicit topic switch;
- cross-workspace thread isolation;
- linked-workspace currency;
- channel connection messages;
- receipt notification destinations;
- messaging invoice instructions;
- long response delivery;
- stale and duplicate current messages;
- persisted task text and verified tool results;
- duplicate delivery suppression.

## Remaining live verification

No Discord credentials or production channel transcripts were present in the checkout. A live staging pass should verify bot permissions, Gateway reconnect behavior, response latency, Discord rendering, and real MCP writes against an isolated test workspace. The recommended script is: connect account, preview multiple expenses, choose an account, confirm save, correct one amount, switch to invoices, upload a receipt, and observe the later match notification in the same thread.
