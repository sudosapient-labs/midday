import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCallerFactory } from "../../trpc/init";
import { appsRouter } from "../../trpc/routers/apps";
import { createTestContext } from "../helpers/test-context";
import { mocks } from "../setup";

const createCaller = createCallerFactory(appsRouter);

describe("tRPC: apps.get", () => {
  beforeEach(() => {
    mocks.getApps.mockReset();
    mocks.getApps.mockImplementation(() => Promise.resolve([]));
  });

  test("returns apps for team", async () => {
    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([]);
    expect(mocks.getApps).toHaveBeenCalledWith(
      expect.anything(),
      "test-team-id",
    );
  });

  test("returns integrations when query returns rows", async () => {
    mocks.getApps.mockImplementation(() =>
      Promise.resolve([{ app_id: "slack", settings: null, config: null }]),
    );

    const caller = createCaller(createTestContext());

    expect(await caller.get()).toEqual([
      { app_id: "slack", settings: null, config: null },
    ]);
  });
});

describe("tRPC: apps.discordSetup", () => {
  const originalApplicationId = process.env.DISCORD_APPLICATION_ID;

  afterEach(() => {
    if (originalApplicationId === undefined) {
      delete process.env.DISCORD_APPLICATION_ID;
    } else {
      process.env.DISCORD_APPLICATION_ID = originalApplicationId;
    }
  });

  test("returns a bot installation URL for the configured application", async () => {
    process.env.DISCORD_APPLICATION_ID = "123456789";
    const caller = createCaller(createTestContext());

    const result = await caller.discordSetup();
    const url = new URL(result.installUrl!);

    expect(url.origin).toBe("https://discord.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("123456789");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe("328565115968");
    expect(url.searchParams.get("integration_type")).toBe("0");
  });

  test("returns no installation URL when Discord is not configured", async () => {
    delete process.env.DISCORD_APPLICATION_ID;
    const caller = createCaller(createTestContext());

    expect(await caller.discordSetup()).toEqual({ installUrl: null });
  });
});
