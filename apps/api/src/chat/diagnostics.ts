/** Allowlisted metadata only: never log tool arguments, SQL, replies or secrets. */
export function safeErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { errorType: "UnknownError" };
  const value = error as Record<string, unknown>;
  const cause =
    value.cause && typeof value.cause === "object"
      ? (value.cause as Record<string, unknown>)
      : undefined;
  const code = cause?.code ?? value.code;
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    ...(typeof code === "string" && /^[A-Z0-9_-]{1,40}$/i.test(code)
      ? { code }
      : {}),
  };
}

export function toolOutcome(output: unknown) {
  const result =
    output && typeof output === "object"
      ? (output as {
          isError?: boolean;
          structuredContent?: { data?: unknown };
        })
      : undefined;
  return {
    status: result?.isError ? "error" : "success",
    ...(Array.isArray(result?.structuredContent?.data)
      ? { returnedCount: result.structuredContent.data.length }
      : {}),
  };
}

// Chat SDK ignores non-text error chunks. Throw so bot handlers can report a
// failed response rather than treating an empty/partial stream as delivery.
export async function* checkedAssistantStream<T extends { type: string }>(
  stream: AsyncIterable<T>,
) {
  for await (const part of stream) {
    if (part.type === "error") throw new Error("Assistant stream failed");
    yield part;
  }
}
