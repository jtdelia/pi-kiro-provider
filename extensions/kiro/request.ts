import { randomUUID } from "node:crypto";

import type {
  AssistantMessage,
  Context,
  Message,
  ThinkingLevel,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

import { sanitizeKiroLogString } from "./logging";
import { KIRO_FALLBACK_MODELS } from "./models";
import type {
  KiroAssistantResponseMessage,
  KiroConversationMessage,
  KiroPreparedRequest,
  KiroRequestAdapterInput,
  KiroRequestImage,
  KiroThinkingConfig,
  KiroToolDefinition,
  KiroToolResult,
  KiroToolUse,
  KiroUserInputMessage,
} from "./types";

const KIRO_REQUEST_ORIGIN = "AI_EDITOR" as const;
const KIRO_CHAT_TRIGGER_TYPE = "MANUAL" as const;
const KIRO_CONTINUATION_MESSAGE = "[system: conversation continues]";
const KIRO_DEFAULT_TOOL_RESULT_MESSAGE = "Tool results provided.";
const KIRO_GENERATE_ASSISTANT_RESPONSE_PATH = "/generateAssistantResponse";
const KIRO_TRANSPORT_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
const KIRO_TRANSPORT_USER_AGENT_DETAIL = `aws-sdk-js/3.738.0 ua/2.1 lang/js api/codewhisperer#3.738.0 m/E KiroIDE`;

const KIRO_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
};

export interface KiroTransportRequestInput {
  preparedRequest: Pick<KiroPreparedRequest, "endpoint" | "payload">;
  accessToken: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  requestId?: string;
}

function extractRegionFromProfileArn(profileArn?: string): string | undefined {
  const normalizedArn = profileArn?.trim();
  if (!normalizedArn) {
    return undefined;
  }

  const parts = normalizedArn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") {
    return undefined;
  }

  const region = parts[3]?.trim();
  return region || undefined;
}

function extractTextFromUserContent(content: UserMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function convertBase64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}

export function convertPiImageToKiroImage(image: { data: string; mimeType: string }): KiroRequestImage {
  const mimeType = image.mimeType.trim().toLowerCase();
  const format = mimeType.split("/")[1];

  if (!format) {
    throw new Error(`Unsupported image mime type: ${image.mimeType}`);
  }

  return {
    format,
    source: {
      bytes: convertBase64ToBytes(image.data),
    },
  };
}

function toJsonSchemaRecord(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export function convertPiToolDefinition(tool: Tool): KiroToolDefinition {
  return {
    toolSpecification: {
      name: tool.name,
      description: tool.description.slice(0, 9216),
      inputSchema: {
        json: toJsonSchemaRecord(tool.parameters),
      },
    },
  };
}

export function convertPiToolDefinitions(tools: Context["tools"]): KiroToolDefinition[] {
  return (tools ?? []).map(convertPiToolDefinition);
}

export function mapThinkingLevelToKiroThinkingConfig(reasoning?: ThinkingLevel): KiroThinkingConfig {
  if (!reasoning) {
    return { enabled: false };
  }

  const budgetTokens = KIRO_THINKING_BUDGETS[reasoning];
  return {
    enabled: true,
    level: reasoning,
    budgetTokens,
    systemPromptPrefix: `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budgetTokens}</max_thinking_length>`,
  };
}

function combineThinkingAndTextContent(message: AssistantMessage): string {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const part of message.content) {
    if (part.type === "text") {
      textParts.push(part.text);
      continue;
    }

    if (part.type === "thinking") {
      thinkingParts.push(part.thinking);
    }
  }

  const sections: string[] = [];
  if (thinkingParts.length > 0) {
    sections.push(`<thinking>${thinkingParts.join("")}</thinking>`);
  }
  if (textParts.length > 0) {
    sections.push(textParts.join(""));
  }

  return sections.join("\n\n");
}

export function convertAssistantToolCalls(message: AssistantMessage): KiroToolUse[] {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => part.type === "toolCall")
    .map((part) => ({
      toolUseId: part.id,
      name: part.name,
      input: part.arguments,
    }));
}

export function convertAssistantMessageToKiroMessage(
  message: AssistantMessage,
): KiroConversationMessage | undefined {
  const content = combineThinkingAndTextContent(message);
  const toolUses = convertAssistantToolCalls(message);

  if (!content && toolUses.length === 0) {
    return undefined;
  }

  const assistantResponseMessage: KiroAssistantResponseMessage = {
    content,
  };

  if (toolUses.length > 0) {
    assistantResponseMessage.toolUses = toolUses;
  }

  return {
    assistantResponseMessage,
  };
}

export function convertUserMessageToKiroMessage(
  message: UserMessage,
  serviceModelId: string,
): KiroConversationMessage {
  const userInputMessage: KiroUserInputMessage = {
    content: extractTextFromUserContent(message.content),
    modelId: serviceModelId,
    origin: KIRO_REQUEST_ORIGIN,
  };

  if (Array.isArray(message.content)) {
    const images = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "image" }> => part.type === "image")
      .map((part) => convertPiImageToKiroImage({ data: part.data, mimeType: part.mimeType }));

    if (images.length > 0) {
      userInputMessage.images = images;
    }
  }

  return {
    userInputMessage,
  };
}

export function convertToolResultMessageToKiroToolResult(message: ToolResultMessage): KiroToolResult {
  const content = message.content.map((part) => {
    if (part.type === "image") {
      throw new Error("Kiro tool result image attachments are not supported yet.");
    }

    return { text: part.text };
  });

  return {
    toolUseId: message.toolCallId,
    content,
    status: message.isError ? "error" : "success",
  };
}

export function convertToolResultMessageToKiroMessage(
  message: ToolResultMessage,
  serviceModelId: string,
): KiroConversationMessage {
  const textContent = message.content
    .filter((part): part is Extract<ToolResultMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

  return {
    userInputMessage: {
      content: textContent || KIRO_DEFAULT_TOOL_RESULT_MESSAGE,
      modelId: serviceModelId,
      origin: KIRO_REQUEST_ORIGIN,
      userInputMessageContext: {
        toolResults: [convertToolResultMessageToKiroToolResult(message)],
      },
    },
  };
}

export function convertPiMessageToKiroMessage(
  message: Message,
  serviceModelId: string,
): KiroConversationMessage | undefined {
  if (message.role === "user") {
    return convertUserMessageToKiroMessage(message, serviceModelId);
  }

  if (message.role === "assistant") {
    return convertAssistantMessageToKiroMessage(message);
  }

  return convertToolResultMessageToKiroMessage(message, serviceModelId);
}

function appendHistoryMessage(history: KiroConversationMessage[], message: KiroConversationMessage): void {
  const last = history.at(-1);

  if (message.assistantResponseMessage && last?.assistantResponseMessage) {
    const previous = last.assistantResponseMessage;
    const current = message.assistantResponseMessage;

    previous.content = [previous.content, current.content].filter(Boolean).join("\n\n");
    if (current.toolUses && current.toolUses.length > 0) {
      previous.toolUses = [...(previous.toolUses ?? []), ...current.toolUses];
    }
    return;
  }

  if (message.userInputMessage && last?.userInputMessage) {
    history.push({
      assistantResponseMessage: {
        content: KIRO_CONTINUATION_MESSAGE,
      },
    });
  }

  history.push(message);
}

export function buildKiroHistory(messages: readonly Message[], serviceModelId: string): KiroConversationMessage[] {
  const history: KiroConversationMessage[] = [];

  for (const message of messages) {
    const converted = convertPiMessageToKiroMessage(message, serviceModelId);
    if (!converted) {
      continue;
    }

    appendHistoryMessage(history, converted);
  }

  return history;
}

function prependSystemPrompt(content: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return content;
  }

  return content ? `${systemPrompt}\n\n${content}` : systemPrompt;
}

export function injectSystemPromptIntoKiroMessages(
  history: KiroConversationMessage[],
  currentMessage: KiroUserInputMessage,
  systemPrompt?: string,
): {
  history: KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
} {
  if (!systemPrompt) {
    return { history, currentMessage };
  }

  const firstUserMessage = history.find((entry) => entry.userInputMessage)?.userInputMessage;
  if (firstUserMessage) {
    firstUserMessage.content = prependSystemPrompt(firstUserMessage.content, systemPrompt);
    return { history, currentMessage };
  }

  return {
    history,
    currentMessage: {
      ...currentMessage,
      content: prependSystemPrompt(currentMessage.content, systemPrompt),
    },
  };
}

function resolveKiroServiceModelId(input: Pick<KiroRequestAdapterInput, "modelId" | "serviceModelId">): string {
  if (input.serviceModelId) {
    return input.serviceModelId;
  }

  return KIRO_FALLBACK_MODELS.find((model) => model.id === input.modelId)?.serviceModelId ?? input.modelId;
}

export function resolveKiroRequestRegion(credentials: KiroRequestAdapterInput["credentials"]): string {
  return extractRegionFromProfileArn(credentials.profileArn) ?? credentials.region;
}

export function buildKiroRequestEndpoint(credentials: KiroRequestAdapterInput["credentials"]): string {
  return `https://q.${resolveKiroRequestRegion(credentials)}.amazonaws.com${KIRO_GENERATE_ASSISTANT_RESPONSE_PATH}`;
}

function createPlaceholderCurrentMessage(serviceModelId: string): KiroUserInputMessage {
  return {
    content: KIRO_CONTINUATION_MESSAGE,
    modelId: serviceModelId,
    origin: KIRO_REQUEST_ORIGIN,
  };
}

function applyToolsToCurrentMessage(currentMessage: KiroUserInputMessage, tools: KiroToolDefinition[]): KiroUserInputMessage {
  if (tools.length === 0) {
    return currentMessage;
  }

  return {
    ...currentMessage,
    userInputMessageContext: {
      ...(currentMessage.userInputMessageContext ?? {}),
      tools,
    },
  };
}

function createPlaceholderToolDefinition(name: string): KiroToolDefinition {
  return {
    toolSpecification: {
      name,
      description: "Tool",
      inputSchema: {
        json: {
          type: "object",
          properties: {},
        },
      },
    },
  };
}

function ensureHistoryToolDefinitions(
  history: readonly KiroConversationMessage[],
  currentMessage: KiroUserInputMessage,
): KiroUserInputMessage {
  const historyToolNames = new Set(
    history.flatMap((message) => message.assistantResponseMessage?.toolUses?.map((toolUse) => toolUse.name) ?? []),
  );

  if (historyToolNames.size === 0) {
    return currentMessage;
  }

  const existingTools = currentMessage.userInputMessageContext?.tools ?? [];
  const existingToolNames = new Set(existingTools.map((tool) => tool.toolSpecification.name));
  const missingTools = [...historyToolNames]
    .filter((name) => !existingToolNames.has(name))
    .map(createPlaceholderToolDefinition);

  if (missingTools.length === 0) {
    return currentMessage;
  }

  return {
    ...currentMessage,
    userInputMessageContext: {
      ...(currentMessage.userInputMessageContext ?? {}),
      tools: [...existingTools, ...missingTools],
    },
  };
}

export function adaptPiContextToKiroRequest(input: KiroRequestAdapterInput): KiroPreparedRequest {
  if (input.context.messages.length === 0) {
    throw new Error("Kiro request adapter requires at least one message.");
  }

  const serviceModelId = resolveKiroServiceModelId(input);
  const thinkingConfig = mapThinkingLevelToKiroThinkingConfig(input.reasoning);
  const effectiveSystemPrompt = [thinkingConfig.systemPromptPrefix, input.context.systemPrompt]
    .filter(Boolean)
    .join("\n");
  const history = buildKiroHistory(input.context.messages.slice(0, -1), serviceModelId);
  const lastMessage = input.context.messages.at(-1);

  if (!lastMessage) {
    throw new Error("Kiro request adapter requires a final message.");
  }

  let currentMessage: KiroUserInputMessage;
  if (lastMessage.role === "assistant") {
    const convertedAssistant = convertAssistantMessageToKiroMessage(lastMessage);
    if (convertedAssistant) {
      appendHistoryMessage(history, convertedAssistant);
    }
    currentMessage = createPlaceholderCurrentMessage(serviceModelId);
  } else {
    const convertedCurrent = convertPiMessageToKiroMessage(lastMessage, serviceModelId);
    if (!convertedCurrent?.userInputMessage) {
      throw new Error("Kiro current message must resolve to a user-input message.");
    }
    currentMessage = convertedCurrent.userInputMessage;
  }

  const currentWithTools = applyToolsToCurrentMessage(currentMessage, convertPiToolDefinitions(input.context.tools));
  const injected = injectSystemPromptIntoKiroMessages(history, currentWithTools, effectiveSystemPrompt || undefined);
  const currentWithHistoryTools = ensureHistoryToolDefinitions(injected.history, injected.currentMessage);
  const endpoint = buildKiroRequestEndpoint(input.credentials);
  const region = resolveKiroRequestRegion(input.credentials);

  return {
    endpoint,
    region,
    requestedModelId: input.modelId,
    serviceModelId,
    effectiveSystemPrompt: effectiveSystemPrompt || undefined,
    thinkingConfig,
    payload: {
      conversationState: {
        chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
        conversationId: input.conversationId,
        history: injected.history.length > 0 ? injected.history : undefined,
        currentMessage: {
          userInputMessage: currentWithHistoryTools,
        },
      },
      profileArn: input.credentials.profileArn,
    },
  };
}

export function buildKiroTransportHeaders(input: {
  accessToken: string;
  headers?: Record<string, string>;
  requestId?: string;
}): Record<string, string> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw new Error("Kiro transport requires an access token.");
  }

  return {
    Accept: "text/event-stream, application/json",
    "Content-Type": "application/json",
    "amz-sdk-invocation-id": input.requestId ?? randomUUID(),
    "amz-sdk-request": "attempt=1; max=1",
    Authorization: `Bearer ${accessToken}`,
    Connection: "keep-alive",
    "user-agent": KIRO_TRANSPORT_USER_AGENT_DETAIL,
    "x-amz-user-agent": KIRO_TRANSPORT_USER_AGENT,
    "x-amzn-kiro-agent-mode": "vibe",
    ...(input.headers ?? {}),
  };
}

export function buildKiroTransportRequest(input: KiroTransportRequestInput): {
  url: string;
  init: RequestInit;
} {
  return {
    url: input.preparedRequest.endpoint,
    init: {
      method: "POST",
      headers: buildKiroTransportHeaders({
        accessToken: input.accessToken,
        headers: input.headers,
        requestId: input.requestId,
      }),
      body: JSON.stringify(input.preparedRequest.payload),
      signal: input.signal,
    },
  };
}

export function buildKiroHttpErrorMessage(response: Pick<Response, "status" | "statusText">, bodyText: string): string {
  const detail = sanitizeKiroLogString(bodyText.trim() || response.statusText || "request failed");
  return `Kiro request failed with HTTP ${response.status}: ${detail}`;
}
