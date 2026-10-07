import { describe, expect, test } from "bun:test";
import { MIDDAY_BOT_CONCURRENCY } from "./concurrency";

describe("bot message concurrency", () => {
  test("queues every message in a burst instead of superseding earlier details", () => {
    expect(MIDDAY_BOT_CONCURRENCY).toMatchObject({
      strategy: "queue",
      maxQueueSize: 25,
    });
  });
});
