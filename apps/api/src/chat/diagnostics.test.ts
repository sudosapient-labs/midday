import { expect, test } from "bun:test";
import {
  checkedAssistantStream,
  safeErrorDetails,
  toolOutcome,
} from "./diagnostics";

test("diagnostics exclude SQL, values, stack and credentials", () => {
  const error = new Error("secret SQL values", {
    cause: { code: "22P02", detail: "private data" },
  });
  expect(safeErrorDetails(error)).toEqual({
    errorType: "Error",
    code: "22P02",
  });
});
test("MCP errors are not logged as successful tools", () => {
  expect(
    toolOutcome({ isError: true, content: [{ text: "private" }] }),
  ).toEqual({ status: "error" });
  expect(toolOutcome({ structuredContent: { data: [{}, {}, {}] } })).toEqual({
    status: "success",
    returnedCount: 3,
  });
});
test("stream error chunks propagate to bot failure handling", async () => {
  async function* stream() {
    yield { type: "text-delta", text: "partial" };
    yield { type: "error", error: new Error("secret") };
  }
  const consume = async () => {
    for await (const _ of checkedAssistantStream(stream())) {
    }
  };
  await expect(consume()).rejects.toThrow("Assistant stream failed");
});
test("normal stream parts pass through unchanged", async () => {
  const parts = [{ type: "text-delta", text: "ok" }, { type: "finish" }];
  async function* stream() {
    yield* parts;
  }
  expect(await Array.fromAsync(checkedAssistantStream(stream()))).toEqual(
    parts,
  );
});
