import { openai } from "@ai-sdk/openai";
import {
  buildLexicalPrepareStep,
  buildPrepareStep,
  createExecutionClient,
  ensureToolDefinitions,
  ensureToolIndex,
  getGatewayCompatibleToolDefinitions,
  getSearchTool,
  getToolDefinitions,
} from "@api/chat/tools";
import { getComposioTools } from "@api/composio/client";
import type { McpContext } from "@api/mcp/types";
import { logger } from "@midday/logger";
import {
  type ModelMessage,
  smoothStream,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { safeErrorDetails, toolOutcome } from "./diagnostics";

export async function streamMiddayAssistant(params: {
  mcpCtx: McpContext;
  systemPrompt: string;
  modelMessages: Array<ModelMessage>;
  traceId?: string;
}) {
  const { mcpCtx, systemPrompt, modelMessages } = params;
  const traceId = params.traceId ?? crypto.randomUUID();

  const useToolIndex = process.env.OPENAI_DISABLE_TOOL_INDEX !== "true";
  if (useToolIndex) {
    await ensureToolIndex(mcpCtx);
  } else {
    await ensureToolDefinitions(mcpCtx);
  }

  const [resolvedClient, composioMetaTools] = await Promise.all([
    createExecutionClient(mcpCtx),
    getComposioTools(mcpCtx.userId),
  ]);

  let closed = false;
  const closeClient = async () => {
    if (closed) return;
    closed = true;
    await resolvedClient.close().catch(() => {});
  };

  try {
    const toolDefinitions = useToolIndex
      ? getToolDefinitions()
      : getGatewayCompatibleToolDefinitions();
    const mcpTools = resolvedClient.toolsFromDefinitions(toolDefinitions);
    const composioToolNames = Object.keys(composioMetaTools);
    const webSearchTools: ToolSet = {};
    if (process.env.OPENAI_ENABLE_WEB_SEARCH !== "false") {
      webSearchTools.web_search = openai.tools.webSearch({
        searchContextSize: "medium",
        userLocation: {
          type: "approximate",
          country: mcpCtx.countryCode ?? undefined,
          timezone: mcpCtx.timezone ?? undefined,
        },
      });
    }

    if (composioToolNames.length > 0) {
      logger.info("[chat] Composio tools available:", {
        tools: composioToolNames,
      });
    }

    const agent = new ToolLoopAgent({
      model: openai(process.env.OPENAI_MODEL || "gpt-4.1-mini"),
      instructions: systemPrompt,
      tools: {
        ...mcpTools,
        ...composioMetaTools,
        ...webSearchTools,
        ...(useToolIndex ? { search_tools: getSearchTool() } : {}),
      },
      prepareStep: useToolIndex
        ? buildPrepareStep({
            maxTools: 12,
            alwaysActive: [
              ...Object.keys(webSearchTools),
              "search_tools",
              ...composioToolNames,
            ],
          })
        : buildLexicalPrepareStep({
            messages: modelMessages,
            maxTools: 12,
            alwaysActive: [
              ...Object.keys(webSearchTools),
              ...composioToolNames,
            ],
          }),
      // This OpenAI-compatible gateway does not persist Responses API items.
      // Keeping storage disabled makes the SDK send complete tool-call context
      // on follow-up steps instead of item references the gateway cannot find.
      providerOptions: {
        openai: {
          store: false,
        },
      },
      stopWhen: stepCountIs(10),
      onStepFinish: (step) => {
        for (const part of step.content) {
          if (part.type === "tool-call") {
            logger.info("[chat] Tool called", {
              traceId,
              tool: part.toolName,
              toolCallId: part.toolCallId,
            });
          } else if (part.type === "tool-result") {
            logger.info("[chat] Tool completed", {
              traceId,
              tool: part.toolName,
              toolCallId: part.toolCallId,
              ...toolOutcome(part.output),
            });
          } else if (part.type === "tool-error") {
            logger.error("[chat] Tool failed", {
              traceId,
              tool: part.toolName,
              toolCallId: part.toolCallId,
              ...safeErrorDetails(part.error),
            });
          }
        }
      },
      onFinish: async (event) => {
        logger.info("[chat] Generation finished", {
          traceId,
          finishReason: event.finishReason,
          steps: event.steps.length,
        });
        await closeClient();
      },
    });

    const result = await agent.stream({
      messages: modelMessages,
      experimental_transform: smoothStream(),
    });

    return Object.assign(result, { cleanup: closeClient });
  } catch (error) {
    logger.error("[chat] Generation failed", {
      traceId,
      ...safeErrorDetails(error),
    });
    await closeClient();
    throw error;
  }
}
