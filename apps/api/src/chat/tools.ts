import { createHash } from "node:crypto";
import type { MCPClient } from "@ai-sdk/mcp";
import { createMCPClient } from "@ai-sdk/mcp";
import { createOpenAI } from "@ai-sdk/openai";
import { createMcpServer } from "@api/mcp/server";
import type { McpContext } from "@api/mcp/types";
import { expandScopes } from "@api/utils/scopes";
import { logger } from "@midday/logger";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ModelMessage, PrepareStepFunction, Tool } from "ai";
import type { ToolIndex } from "toolpick";
import { createToolIndex, fileCache } from "toolpick";

export type ChatMCPClient = Awaited<ReturnType<typeof createMCPClient>>;
type ToolDefinitions = Awaited<ReturnType<MCPClient["listTools"]>>;

let cachedDefinitions: ToolDefinitions | null = null;
let cachedIndex: ToolIndex<any> | null = null;
let inflightIndexPromise: Promise<ToolIndex<any>> | null = null;
let inflightDefinitionsPromise: Promise<ToolDefinitions> | null = null;

const embeddingModelName =
  process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
const separateEmbeddingBaseUrl =
  process.env.OPENAI_EMBEDDING_BASE_URL?.trim() || undefined;
const embeddingBaseUrl =
  separateEmbeddingBaseUrl || process.env.OPENAI_BASE_URL?.trim() || undefined;
const embeddingProvider = createOpenAI({
  apiKey:
    process.env.OPENAI_EMBEDDING_API_KEY?.trim() ||
    (separateEmbeddingBaseUrl ? "ollama" : process.env.OPENAI_API_KEY),
  baseURL: embeddingBaseUrl,
});
const embeddingCacheKey =
  `${embeddingBaseUrl ?? "openai"}-${embeddingModelName}`
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");

async function bootstrapTools(ctx: McpContext) {
  const mcpServer = createMcpServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await mcpServer.connect(serverTransport);

  const client = await createMCPClient({
    transport: clientTransport,
    name: "midday-bootstrap",
  });

  const definitions = await client.listTools();
  const tools = client.toolsFromDefinitions(definitions);
  await client.close();

  return { definitions, tools };
}

export function ensureToolDefinitions(
  ctx: McpContext,
): Promise<ToolDefinitions> {
  if (cachedDefinitions) return Promise.resolve(cachedDefinitions);
  if (inflightDefinitionsPromise) return inflightDefinitionsPromise;

  inflightDefinitionsPromise = bootstrapTools(ctx)
    .then(({ definitions }) => {
      cachedDefinitions = definitions;
      return definitions;
    })
    .finally(() => {
      inflightDefinitionsPromise = null;
    });

  return inflightDefinitionsPromise;
}

export function ensureToolIndex(ctx: McpContext): Promise<ToolIndex<any>> {
  if (cachedIndex) return Promise.resolve(cachedIndex);
  if (inflightIndexPromise) return inflightIndexPromise;

  inflightIndexPromise = (async () => {
    const { definitions, tools } = await bootstrapTools(ctx);
    cachedDefinitions = definitions;
    const toolCatalogHash = createHash("sha256")
      .update(
        JSON.stringify(
          [...definitions.tools].sort((a, b) => a.name.localeCompare(b.name)),
        ),
      )
      .digest("hex")
      .slice(0, 12);

    const index = await createToolIndex(tools, {
      embeddingModel: embeddingProvider.embeddingModel(embeddingModelName),
      embeddingCache: fileCache(
        `.toolpick-cache.${embeddingCacheKey}.${toolCatalogHash}.json`,
      ),
      relatedTools: {
        invoices_create: ["customers_list"],
        invoices_create_from_tracker: ["customers_list"],
        invoice_recurring_create: ["customers_list"],
        tracker_timer_start: ["tracker_projects_list"],
        tracker_entries_create: ["tracker_projects_list"],
        tracker_entries_list: ["tracker_projects_list"],
        tracker_projects_list: ["tracker_entries_list"],
        transactions_update: ["categories_list"],
      },
    });

    await index.warmUp();

    cachedIndex = index;
    return index;
  })().catch((err) => {
    inflightIndexPromise = null;
    throw err;
  });

  return inflightIndexPromise;
}

export function getToolDefinitions(): ToolDefinitions {
  if (!cachedDefinitions) {
    throw new Error(
      "Tool definitions not bootstrapped — call ensureToolIndex first",
    );
  }
  return cachedDefinitions;
}

/**
 * Build a prepareStep function that delegates to the cached tool index
 * but guarantees `alwaysActive` tool names are always exposed to the model.
 *
 * Toolpick's own `alwaysActive` option filters names against the index,
 * which excludes built-in provider tools like `web_search`. This wrapper
 * appends them after selection so they're never dropped.
 */
export function buildPrepareStep<T extends Record<string, Tool>>(options: {
  maxTools: number;
  alwaysActive?: string[];
}): PrepareStepFunction<T> {
  if (!cachedIndex) {
    throw new Error("Tool index not bootstrapped — call ensureToolIndex first");
  }

  const base = cachedIndex.prepareStep({ maxTools: options.maxTools });
  const always = options.alwaysActive ?? [];

  return (async (stepOptions: any) => {
    const step = await base(stepOptions);
    if (step?.activeTools) {
      const messages = (stepOptions.messages ?? []) as ModelMessage[];
      const query = modelMessageText(messages);
      step.activeTools = step.activeTools.filter((name) =>
        permitsToolForIntent(String(name), query),
      );
      const required = getRequiredConversationTools(messages);
      for (const name of [...required, ...always]) {
        if (!step.activeTools.includes(name)) {
          step.activeTools.push(name);
        }
      }
    }
    return step;
  }) as PrepareStepFunction<T>;
}

const LEXICAL_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "for",
  "from",
  "hello",
  "help",
  "hi",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "please",
  "the",
  "to",
  "want",
  "what",
  "with",
  "you",
]);

const DOMAIN_ALIASES: Record<string, string[]> = {
  add: ["create"],
  accounting: ["accounting"],
  balance: ["bank", "account"],
  bank: ["bank", "account"],
  business: ["report", "revenue", "profit", "cash"],
  cash: ["report", "bank"],
  change: ["update"],
  client: ["customer"],
  customer: ["customer"],
  document: ["document"],
  edit: ["update"],
  email: ["send"],
  expense: ["transaction", "report"],
  expenses: ["transaction", "report"],
  file: ["document", "inbox"],
  find: ["list", "get", "search"],
  income: ["transaction", "report", "revenue"],
  invoice: ["invoice"],
  member: ["team"],
  money: ["transaction", "bank", "report"],
  new: ["create"],
  notification: ["inbox"],
  product: ["invoice", "product"],
  profit: ["report", "profit"],
  project: ["tracker", "project"],
  receipt: ["inbox", "transaction"],
  remove: ["delete"],
  report: ["report"],
  revenue: ["report", "revenue"],
  send: ["send"],
  spend: ["transaction", "create"],
  spending: ["transaction", "create"],
  spent: ["transaction", "create"],
  show: ["list", "get", "summary"],
  tag: ["tag"],
  tax: ["report", "tax"],
  team: ["team"],
  time: ["tracker"],
  timer: ["tracker", "timer"],
  transaction: ["transaction"],
};

function modelMessageText(messages: ModelMessage[]): string {
  const userTexts = messages
    .filter((message) => message.role === "user")
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];

      return message.content.flatMap((part) =>
        "text" in part && typeof part.text === "string" ? [part.text] : [],
      );
    });

  const hasDomain = (text: string) =>
    /\b(?:accounts?|balances?|cash|categor(?:y|ies)|customers?|documents?|expenses?|invoices?|money|payments?|projects?|receipts?|reports?|revenue|runway|spend(?:ing)?|spent|tags?|tax|teams?|time|transactions?|trackers?)\b/iu.test(
      text,
    );
  const isContinuation = (text: string) =>
    /^(?:yes|yep|yeah|ok(?:ay)?|sure|confirm(?:ed)?|do it|go ahead)\b/iu.test(
      text.trim(),
    ) ||
    /\b(?:it|them|those|these|that|instead|not|correction)\b/iu.test(text) ||
    /^(?:use|choose|select)\b/iu.test(text.trim()) ||
    // An action without a named business domain usually confirms the task the
    // assistant just previewed (for example, “yes, save them”).
    (/\b(?:save|create|update|delete|send)\b/iu.test(text) && !hasDomain(text));

  const latest = userTexts.at(-1) ?? "";

  // An explicit domain starts a new task. Contextual replies retain enough
  // prior user turns to preserve the task through confirmation and
  // clarification chains without leaking an abandoned task into a topic
  // switch such as “show my invoices”.
  if ((hasDomain(latest) && !isContinuation(latest)) || userTexts.length < 2) {
    return latest;
  }

  const taskStart = userTexts.findLastIndex(
    (text, index) =>
      index < userTexts.length - 1 && hasDomain(text) && !isContinuation(text),
  );

  return userTexts.slice(Math.max(taskStart, 0)).join(" ");
}

function lexicalTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !LEXICAL_STOP_WORDS.has(token));
  const expanded = new Set(tokens);

  for (const token of tokens) {
    const singular = token.endsWith("s") ? token.slice(0, -1) : token;
    expanded.add(singular);

    for (const alias of DOMAIN_ALIASES[singular] ?? []) {
      expanded.add(alias);
    }
  }

  return expanded;
}

function isWriteToolName(name: string) {
  return /(?:^|_)(?:confirm|create|decline|delete|draft|duplicate|export|match|pause|resume|send|start|stop|sync|toggle|unmatch|update|upsert)(?:_|$)/u.test(
    name,
  );
}

function permitsToolForIntent(name: string, query: string) {
  if (!isWriteToolName(name)) return true;
  if (!matchesWriteDomain(name, query)) return false;

  if (/(?:^|_)delete(?:_|$)/u.test(name)) {
    return /\b(?:delete|remove|void)\b/iu.test(query);
  }
  if (/(?:^|_)(?:update|upsert)(?:_|$)/u.test(name)) {
    return /\b(?:categor(?:ize|ise)|change|correct|correction|edit|fix|update)\b/iu.test(
      query,
    );
  }
  if (/(?:^|_)(?:create|draft)(?:_|$)/u.test(name)) {
    return /\b(?:add|book|create|draft|enter|log|record|save|store|track)\b/iu.test(
      query,
    );
  }
  if (/(?:^|_)send(?:_|$)/u.test(name)) {
    return /\bsend\b/iu.test(query);
  }
  if (/(?:^|_)start(?:_|$)/u.test(name)) {
    return /\bstart\b/iu.test(query);
  }
  if (/(?:^|_)sync(?:_|$)/u.test(name)) {
    return /\bsync\b/iu.test(query);
  }
  if (/(?:^|_)export(?:_|$)/u.test(name)) {
    return /\bexport\b/iu.test(query);
  }
  if (/(?:^|_)duplicate(?:_|$)/u.test(name)) {
    return /\bduplicate\b/iu.test(query);
  }
  if (/(?:^|_)(?:confirm|decline|match|unmatch)(?:_|$)/u.test(name)) {
    return /\b(?:confirm|decline|match|unmatch)\b/iu.test(query);
  }
  if (/(?:^|_)(?:pause|resume|stop|toggle)(?:_|$)/u.test(name)) {
    return /\b(?:pause|resume|stop|toggle)\b/iu.test(query);
  }

  return false;
}

function matchesWriteDomain(name: string, query: string) {
  const rules: Array<[RegExp, RegExp]> = [
    [
      /^transactions?_/u,
      /\b(?:expenses?|payments?|purchases?|spend|spent|transactions?)\b/iu,
    ],
    [/^invoices?_/u, /\binvoices?\b/iu],
    [/^bank_accounts?_/u, /\b(?:accounts?|balances?|bank|cash)\b/iu],
    [/^customers?_/u, /\b(?:clients?|customers?)\b/iu],
    [/^categories?_/u, /\bcategor(?:y|ies|ize|ise)\b/iu],
    [/^documents?_/u, /\b(?:documents?|files?)\b/iu],
    [/^document_tags?_/u, /\b(?:document tags?|tags?)\b/iu],
    [/^inbox_/u, /\b(?:inbox|receipts?)\b/iu],
    [/^tags?_/u, /\btags?\b/iu],
    [/^tracker_/u, /\b(?:projects?|time|timers?|trackers?)\b/iu],
    [/^accounting_/u, /\baccounting\b/iu],
  ];
  const matchingRule = rules.find(([prefix]) => prefix.test(name));
  return matchingRule ? matchingRule[1].test(query) : false;
}

export function getRequiredLexicalTools(query: string): string[] {
  const hasTransactionContext =
    /\b(?:transactions?|expenses?|spend|spending|spent|payments?|purchases?|outlays?|balance|cash)\b/iu.test(
      query,
    );

  if (!hasTransactionContext) {
    return [];
  }

  const isWrite =
    /\b(?:add|book|create|enter|log|record|save|store|track)\b/iu.test(query);
  const isCorrection =
    /\b(?:change|correct|correction|edit|fix|instead|not|update|categor(?:ize|ise))\b/iu.test(
      query,
    );
  const isDelete = /\b(?:delete|remove|void)\b/iu.test(query);
  const isStrongCorrection =
    /\b(?:change|correct|correction|edit|fix|update|categor(?:ize|ise))\b/iu.test(
      query,
    );

  if (isDelete) {
    return [
      "transactions_list",
      "transactions_get",
      "transactions_delete",
      "transactions_delete_bulk",
    ];
  }

  if (isCorrection && (isStrongCorrection || !isWrite)) {
    return [
      "categories_list",
      "bank_accounts_list",
      "transactions_list",
      "transactions_get",
      "transactions_update",
      "transactions_update_bulk",
    ];
  }

  if (isWrite) {
    return [
      "categories_list",
      "bank_accounts_list",
      "transactions_create",
      "transactions_create_bulk",
    ];
  }

  if (/\b(?:balance|cash position|cash on hand|bank account)\b/iu.test(query)) {
    return ["bank_accounts_balances", "bank_accounts_list"];
  }

  // Read-only spending questions need reports and transaction lookup tools.
  // Keeping write tools out of this set prevents the model from interpreting a
  // sentence such as “we spent 55 on water” as permission to save it.
  if (/\b(?:spend|spending|spent|expenses?|outlays?)\b/iu.test(query)) {
    return ["reports_spending", "reports_expenses", "transactions_list"];
  }

  return ["transactions_list", "transactions_get"];
}

export function getRequiredConversationTools(messages: ModelMessage[]) {
  return getRequiredLexicalTools(modelMessageText(messages));
}

function selectToolsLexically(query: string, maxTools: number): string[] {
  const tokens = lexicalTokens(query);
  if (tokens.size === 0) return [];

  const definitions = getToolDefinitions().tools;
  const ranked = definitions
    .map((definition) => {
      const normalizedName = definition.name.toLowerCase().replaceAll("_", " ");
      const description = (definition.description ?? "").toLowerCase();
      let score = 0;

      for (const token of tokens) {
        if (normalizedName.split(" ").includes(token)) score += 8;
        else if (normalizedName.includes(token)) score += 4;

        if (description.includes(token)) score += 1;
      }

      return { name: definition.name, score };
    })
    .filter(({ name, score }) => score > 0 && permitsToolForIntent(name, query))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const transactionTools = getRequiredLexicalTools(query);
  const selected = ranked.slice(0, maxTools).map(({ name }) => name);
  const dependencies: string[] = [];

  if (selected.some((name) => name.startsWith("invoices_"))) {
    dependencies.push("customers_list");
  }
  if (selected.some((name) => name.startsWith("tracker_"))) {
    dependencies.push("tracker_projects_list");
  }
  if (selected.some((name) => name.startsWith("transactions_"))) {
    dependencies.push("categories_list", "bank_accounts_list");
  }
  if (selected.some((name) => name.startsWith("documents_"))) {
    dependencies.push("document_tags_list");
  }

  return [
    ...new Set([...transactionTools, ...dependencies, ...selected]),
  ].slice(0, maxTools);
}

/**
 * Select a compact tool set without embeddings. This keeps OpenAI-compatible
 * gateways from receiving the complete MCP catalog on every streamed turn.
 */
export function buildLexicalPrepareStep<
  T extends Record<string, Tool>,
>(options: {
  messages: ModelMessage[];
  maxTools: number;
  alwaysActive?: string[];
}): PrepareStepFunction<T> {
  const selected = selectToolsLexically(
    modelMessageText(options.messages),
    options.maxTools,
  );
  const activeTools = [
    ...new Set([...selected, ...(options.alwaysActive ?? [])]),
  ] as Array<keyof T>;

  logger.info("[chat] Selected tools without embedding index", {
    tools: activeTools,
  });

  return () => ({ activeTools });
}

function sanitizeToolSchema<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((child) => sanitizeToolSchema(child)) as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["$schema", "format", "pattern"].includes(key))
        .map(([key, child]) => [key, sanitizeToolSchema(child)]),
    ) as T;
  }

  return value;
}

/**
 * Some OpenAI-compatible gateways fail on JSON Schema validation metadata
 * such as Zod's email regex. The MCP server still validates the original
 * schema when a tool is executed; this only simplifies the model-facing copy.
 */
export function getGatewayCompatibleToolDefinitions(): ToolDefinitions {
  const definitions = getToolDefinitions();

  return {
    ...definitions,
    tools: definitions.tools.map((definition) => ({
      ...definition,
      inputSchema: sanitizeToolSchema(definition.inputSchema),
    })),
  };
}

export function getSearchTool() {
  if (!cachedIndex) {
    throw new Error("Tool index not bootstrapped — call ensureToolIndex first");
  }
  return cachedIndex.searchTool();
}

/**
 * Pre-warm the tool index at server startup so the first chat request
 * doesn't pay the MCP bootstrap + embedding cost. Safe to call multiple
 * times — subsequent calls are no-ops once the index is cached.
 */
export function warmToolIndex(): void {
  const stubCtx: McpContext = {
    db: {} as McpContext["db"],
    teamId: "warmup",
    userId: "warmup",
    userEmail: null,
    scopes: expandScopes(["apis.all"]) as McpContext["scopes"],
    apiUrl: process.env.MIDDAY_API_URL ?? "https://api.midday.ai",
    timezone: "UTC",
    locale: "en",
    countryCode: null,
    dateFormat: null,
    timeFormat: 24,
  };

  if (process.env.OPENAI_DISABLE_TOOL_INDEX === "true") {
    ensureToolDefinitions(stubCtx)
      .then(() => {
        logger.info(
          "[chat] Embedding tool index disabled; using lexical tool selection",
        );
      })
      .catch((err) => {
        logger.warn("[chat] Tool definition warm-up failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }

  ensureToolIndex(stubCtx).catch((err) => {
    logger.warn(
      "[chat] Tool index warm-up failed (will retry on first request)",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  });
}

export async function createExecutionClient(ctx: McpContext) {
  const mcpServer = createMcpServer(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  return createMCPClient({
    transport: clientTransport,
    name: "midday-chat",
  });
}
