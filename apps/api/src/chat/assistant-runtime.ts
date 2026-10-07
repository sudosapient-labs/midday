import { openai } from "@ai-sdk/openai";
import { guardBotTools } from "@api/bot/tool-approval";
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

export async function streamMiddayAssistant(params: {
  mcpCtx: McpContext;
  systemPrompt: string;
  modelMessages: Array<ModelMessage>;
  enableComposioTools?: boolean;
  botApproval?: Parameters<typeof guardBotTools>[1];
}) {
  const {
    mcpCtx,
    systemPrompt,
    modelMessages,
    enableComposioTools = true,
  } = params;

  const useToolIndex = process.env.OPENAI_DISABLE_TOOL_INDEX !== "true";
  if (useToolIndex) {
    await ensureToolIndex(mcpCtx);
  } else {
    await ensureToolDefinitions(mcpCtx);
  }

  const [resolvedClient, composioMetaTools] = await Promise.all([
    createExecutionClient(mcpCtx),
    enableComposioTools ? getComposioTools(mcpCtx.userId) : Promise.resolve({}),
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
    const rawMcpTools = resolvedClient.toolsFromDefinitions(toolDefinitions);
    const mcpTools = params.botApproval
      ? guardBotTools(rawMcpTools, params.botApproval)
      : rawMcpTools;
    const composioToolNames = Object.keys(composioMetaTools);
    const pendingToolNames =
      params.botApproval?.pending.map((item) => item.toolName) ?? [];
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
              ...pendingToolNames,
            ],
          })
        : buildLexicalPrepareStep({
            messages: modelMessages,
            maxTools: 12,
            alwaysActive: [
              ...Object.keys(webSearchTools),
              ...composioToolNames,
              ...pendingToolNames,
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
      onFinish: closeClient,
    });

    const result = await agent.stream({
      messages: modelMessages,
      experimental_transform: smoothStream(),
    });

    return Object.assign(result, { cleanup: closeClient });
  } catch (error) {
    await closeClient();
    throw error;
  }
}
