export const MIDDAY_BOT_CONCURRENCY = {
  // Financial requests and attachments must be processed in order. The
  // debounce strategy keeps only the last message in a burst, which can turn
  // "save these expenses" + "yes" into an unsafe context-free yes.
  strategy: "queue",
  maxQueueSize: 25,
  queueEntryTtlMs: 5 * 60 * 1000,
} as const;
