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
const KIRO_CONTINUATION_MESSAGE = "Continue";
const KIRO_RUNNING_TOOLS_MESSAGE = "Running tools...";
const KIRO_SYNTHETIC_TOOL_CALL_MESSAGE = "I will execute the following tools.";
const KIRO_SYNTHETIC_TOOL_RESULT_MESSAGE = "No result provided";
const KIRO_EMPTY_ASSISTANT_MESSAGE = "(empty)";
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

const KIRO_TRUNCATION_TOKEN = "... [TRUNCATED] ...";
const KIRO_TRUNCATION_MARKER = `\n${KIRO_TRUNCATION_TOKEN}\n`;
const KIRO_MAX_TOOL_RESULT_TEXT_CHARS = 100_000;
const KIRO_MAX_CURRENT_MESSAGE_TEXT_CHARS = 120_000;
const KIRO_MAX_HISTORY_SERIALIZED_CHARS = 500_000;
const KIRO_MAX_PAYLOAD_SERIALIZED_CHARS = 650_000;

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

function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  if (maxChars <= KIRO_TRUNCATION_MARKER.length + 2) {
    return text.slice(0, maxChars);
  }

  const remainingChars = maxChars - KIRO_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(remainingChars / 2);
  const tailChars = Math.floor(remainingChars / 2);
  return `${text.slice(0, headChars)}${KIRO_TRUNCATION_MARKER}${text.slice(text.length - tailChars)}`;
}

function truncateToolResultText(text: string): string {
  return truncateMiddle(text, KIRO_MAX_TOOL_RESULT_TEXT_CHARS);
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = text.indexOf(needle, index);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    index = nextIndex + needle.length;
  }
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
    sections.push(textParts.join("\n\n"));
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

function getAssistantToolCalls(message: AssistantMessage): Array<Pick<KiroToolUse, "toolUseId" | "name">> {
  return convertAssistantToolCalls(message).map((toolUse) => ({
    toolUseId: toolUse.toolUseId,
    name: toolUse.name,
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
    content: content || (toolUses.length > 0 ? KIRO_EMPTY_ASSISTANT_MESSAGE : content),
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

    return { text: truncateToolResultText(part.text) };
  });

  return {
    toolUseId: message.toolCallId,
    content,
    status: message.isError ? "error" : "success",
  };
}

function dedupeKiroToolResults(toolResults: readonly KiroToolResult[]): KiroToolResult[] {
  const deduped = new Map<string, KiroToolResult>();

  for (const toolResult of toolResults) {
    if (!deduped.has(toolResult.toolUseId)) {
      deduped.set(toolResult.toolUseId, toolResult);
    }
  }

  return [...deduped.values()].map((toolResult) => ({
    ...toolResult,
    content: toolResult.content.map((part) => ({ ...part })),
  }));
}

function extractToolResultMessageText(message: ToolResultMessage): string {
  return truncateToolResultText(
    message.content
      .filter((part): part is Extract<ToolResultMessage["content"][number], { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
}

export function convertToolResultMessagesToKiroMessage(
  messages: readonly ToolResultMessage[],
  serviceModelId: string,
): KiroConversationMessage {
  const toolResults = dedupeKiroToolResults(messages.map(convertToolResultMessageToKiroToolResult));
  const textContent = messages.map(extractToolResultMessageText).filter(Boolean).join("\n\n");

  return {
    userInputMessage: {
      content: textContent || KIRO_DEFAULT_TOOL_RESULT_MESSAGE,
      modelId: serviceModelId,
      origin: KIRO_REQUEST_ORIGIN,
      userInputMessageContext: {
        toolResults,
      },
    },
  };
}

export function convertToolResultMessageToKiroMessage(
  message: ToolResultMessage,
  serviceModelId: string,
): KiroConversationMessage {
  return convertToolResultMessagesToKiroMessage([message], serviceModelId);
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

function isAssistantMessageErrorState(message: AssistantMessage): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

function createSyntheticToolResultMessage(toolCall: Pick<KiroToolUse, "toolUseId" | "name">): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.toolUseId,
    toolName: toolCall.name,
    content: [{ type: "text", text: KIRO_SYNTHETIC_TOOL_RESULT_MESSAGE }],
    isError: true,
    timestamp: Date.now(),
  };
}

export function normalizeKiroMessages(messages: readonly Message[]): Message[] {
  const normalized: Message[] = [];
  let pendingToolCalls: Array<Pick<KiroToolUse, "toolUseId" | "name">> = [];
  let seenToolResultIds = new Set<string>();

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length === 0) {
      return;
    }

    for (const toolCall of pendingToolCalls) {
      if (!seenToolResultIds.has(toolCall.toolUseId)) {
        normalized.push(createSyntheticToolResultMessage(toolCall));
      }
    }

    pendingToolCalls = [];
    seenToolResultIds = new Set<string>();
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      flushPendingToolCalls();

      if (isAssistantMessageErrorState(message)) {
        continue;
      }

      const toolCalls = getAssistantToolCalls(message);
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        seenToolResultIds = new Set<string>();
      }

      normalized.push(message);
      continue;
    }

    if (message.role === "toolResult") {
      seenToolResultIds.add(message.toolCallId);
      normalized.push(message);
      continue;
    }

    flushPendingToolCalls();
    normalized.push(message);
  }

  flushPendingToolCalls();
  return normalized;
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

function collectConsecutiveToolResults(
  messages: readonly Message[],
  startIndex: number,
): {
  toolResults: ToolResultMessage[];
  nextIndex: number;
} {
  const toolResults: ToolResultMessage[] = [];
  let index = startIndex;

  while (index < messages.length && messages[index]?.role === "toolResult") {
    toolResults.push(messages[index] as ToolResultMessage);
    index += 1;
  }

  return {
    toolResults,
    nextIndex: index,
  };
}

export function buildKiroHistory(messages: readonly Message[], serviceModelId: string): KiroConversationMessage[] {
  const history: KiroConversationMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    if (message.role === "toolResult") {
      const { toolResults, nextIndex } = collectConsecutiveToolResults(messages, index);
      appendHistoryMessage(history, convertToolResultMessagesToKiroMessage(toolResults, serviceModelId));
      index = nextIndex - 1;
      continue;
    }

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

function sanitizeKiroHistory(history: readonly KiroConversationMessage[]): KiroConversationMessage[] {
  const sanitized: KiroConversationMessage[] = [];

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (!message) {
      continue;
    }

    if (message.assistantResponseMessage?.toolUses) {
      const next = history[index + 1];
      if (!next || next.userInputMessage?.userInputMessageContext?.toolResults) {
        sanitized.push(message);
      }
      continue;
    }

    if (message.userInputMessage?.userInputMessageContext?.toolResults) {
      const previous = sanitized.at(-1);
      if (previous?.assistantResponseMessage?.toolUses) {
        sanitized.push(message);
      }
      continue;
    }

    sanitized.push(message);
  }

  return sanitized;
}

function pruneKiroHistoryToSize(
  history: readonly KiroConversationMessage[],
  maxSerializedChars = KIRO_MAX_HISTORY_SERIALIZED_CHARS,
): KiroConversationMessage[] {
  let pruned = sanitizeKiroHistory(history);
  let serializedSize = JSON.stringify(pruned).length;

  while (serializedSize > maxSerializedChars && pruned.length > 2) {
    pruned = pruned.slice(1);

    while (pruned.length > 0 && !pruned[0]?.userInputMessage) {
      pruned = pruned.slice(1);
    }

    pruned = sanitizeKiroHistory(pruned);
    serializedSize = JSON.stringify(pruned).length;
  }

  return pruned;
}

function applyKiroCurrentMessageSizeBudget(currentMessage: KiroUserInputMessage): KiroUserInputMessage {
  const nextMessage: KiroUserInputMessage = {
    ...currentMessage,
    content: truncateMiddle(currentMessage.content, KIRO_MAX_CURRENT_MESSAGE_TEXT_CHARS),
  };

  const toolResults = currentMessage.userInputMessageContext?.toolResults;
  if (!toolResults || toolResults.length === 0) {
    return nextMessage;
  }

  nextMessage.userInputMessageContext = {
    ...(currentMessage.userInputMessageContext ?? {}),
    toolResults: toolResults.map((toolResult) => ({
      ...toolResult,
      content: toolResult.content.map((part) => ({
        text: truncateToolResultText(part.text ?? ""),
      })),
    })),
  };

  return nextMessage;
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

function splitKiroMessagesForCurrentTurn(messages: readonly Message[]): {
  historyMessages: Message[];
  currentMessages: Message[];
} {
  if (messages.length === 0) {
    return { historyMessages: [], currentMessages: [] };
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "toolResult") {
    return {
      historyMessages: messages.slice(0, -1),
      currentMessages: [lastMessage as Message],
    };
  }

  let startIndex = messages.length - 1;
  while (startIndex > 0 && messages[startIndex - 1]?.role === "toolResult") {
    startIndex -= 1;
  }

  return {
    historyMessages: messages.slice(0, startIndex),
    currentMessages: messages.slice(startIndex),
  };
}

function createKiroToolUseFromAssistantToolCall(toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>): KiroToolUse {
  return {
    toolUseId: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments,
  };
}

function findOriginalKiroToolUse(messages: readonly Message[], toolUseId: string): KiroToolUse | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    const toolCall = message.content.find(
      (part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
        part.type === "toolCall" && part.id === toolUseId,
    );

    if (toolCall) {
      return createKiroToolUseFromAssistantToolCall(toolCall);
    }
  }

  return undefined;
}

function getKiroToolResultText(toolResult: KiroToolResult): string {
  return toolResult.content.map((part) => part.text ?? "").join("");
}

function alignCurrentToolResultsWithHistory(input: {
  history: KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
  originalMessages: readonly Message[];
  serviceModelId: string;
}): {
  history: KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
} {
  const existingToolResults = input.currentMessage.userInputMessageContext?.toolResults ?? [];
  if (existingToolResults.length === 0) {
    return {
      history: input.history,
      currentMessage: input.currentMessage,
    };
  }

  const historyToolUseIds = new Set(
    input.history.flatMap((message) => message.assistantResponseMessage?.toolUses?.map((toolUse) => toolUse.toolUseId) ?? []),
  );

  const finalToolResults: KiroToolResult[] = [];
  const syntheticToolUses: KiroToolUse[] = [];
  const extraTextBlocks: string[] = [];

  for (const toolResult of existingToolResults) {
    if (historyToolUseIds.has(toolResult.toolUseId)) {
      finalToolResults.push(toolResult);
      continue;
    }

    const originalToolUse = findOriginalKiroToolUse(input.originalMessages, toolResult.toolUseId);
    if (originalToolUse) {
      syntheticToolUses.push(originalToolUse);
      historyToolUseIds.add(originalToolUse.toolUseId);
      finalToolResults.push(toolResult);
      continue;
    }

    extraTextBlocks.push(`[Output for tool call ${toolResult.toolUseId}]:\n${getKiroToolResultText(toolResult)}`);
  }

  const history = [...input.history];
  if (syntheticToolUses.length > 0) {
    if (history.at(-1)?.assistantResponseMessage) {
      history.push({
        userInputMessage: {
          content: KIRO_RUNNING_TOOLS_MESSAGE,
          modelId: input.serviceModelId,
          origin: KIRO_REQUEST_ORIGIN,
        },
      });
    }

    history.push({
      assistantResponseMessage: {
        content: KIRO_SYNTHETIC_TOOL_CALL_MESSAGE,
        toolUses: syntheticToolUses,
      },
    });
  }

  const nextCurrentMessage: KiroUserInputMessage = {
    ...input.currentMessage,
    content: [input.currentMessage.content, ...extraTextBlocks].filter(Boolean).join("\n\n") || KIRO_DEFAULT_TOOL_RESULT_MESSAGE,
    userInputMessageContext: {
      ...(input.currentMessage.userInputMessageContext ?? {}),
    },
  };

  if (finalToolResults.length > 0) {
    nextCurrentMessage.userInputMessageContext = {
      ...(nextCurrentMessage.userInputMessageContext ?? {}),
      toolResults: dedupeKiroToolResults(finalToolResults),
    };
  } else if (nextCurrentMessage.userInputMessageContext) {
    delete nextCurrentMessage.userInputMessageContext.toolResults;
    if (Object.keys(nextCurrentMessage.userInputMessageContext).length === 0) {
      delete nextCurrentMessage.userInputMessageContext;
    }
  }

  return {
    history,
    currentMessage: nextCurrentMessage,
  };
}

function countKiroToolResultTruncations(history: readonly KiroConversationMessage[], currentMessage: KiroUserInputMessage): number {
  const countTruncations = (message: KiroUserInputMessage | undefined): number => {
    if (!message?.userInputMessageContext?.toolResults) {
      return 0;
    }

    return message.userInputMessageContext.toolResults.reduce(
      (total, toolResult) =>
        total + toolResult.content.reduce((partTotal, part) => partTotal + countOccurrences(part.text ?? "", KIRO_TRUNCATION_TOKEN), 0),
      0,
    );
  };

  return history.reduce((total, entry) => total + countTruncations(entry.userInputMessage), 0) + countTruncations(currentMessage);
}

function fitKiroPayloadToSize(input: {
  history: readonly KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
  conversationId?: string;
}): {
  history: KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
} {
  let history = pruneKiroHistoryToSize(input.history);
  const currentMessage = applyKiroCurrentMessageSizeBudget(input.currentMessage);

  let payload = {
    conversationState: {
      chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
      conversationId: input.conversationId,
      history: history.length > 0 ? history : undefined,
      currentMessage: {
        userInputMessage: currentMessage,
      },
    },
  };

  while (JSON.stringify(payload).length > KIRO_MAX_PAYLOAD_SERIALIZED_CHARS && history.length > 0) {
    history = pruneKiroHistoryToSize(history.slice(1));
    payload = {
      conversationState: {
        chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
        conversationId: input.conversationId,
        history: history.length > 0 ? history : undefined,
        currentMessage: {
          userInputMessage: currentMessage,
        },
      },
    };
  }

  return {
    history,
    currentMessage,
  };
}

function buildKiroCurrentMessage(
  currentMessages: readonly Message[],
  serviceModelId: string,
  history: KiroConversationMessage[],
): {
  history: KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
} {
  if (currentMessages.length === 0) {
    return {
      history,
      currentMessage: createPlaceholderCurrentMessage(serviceModelId),
    };
  }

  const [firstMessage] = currentMessages;
  if (!firstMessage) {
    return {
      history,
      currentMessage: createPlaceholderCurrentMessage(serviceModelId),
    };
  }

  if (firstMessage.role === "assistant") {
    const convertedAssistant = convertAssistantMessageToKiroMessage(firstMessage);
    if (convertedAssistant) {
      appendHistoryMessage(history, convertedAssistant);
    }

    return {
      history,
      currentMessage: createPlaceholderCurrentMessage(serviceModelId),
    };
  }

  if (firstMessage.role === "toolResult") {
    const convertedCurrent = convertToolResultMessagesToKiroMessage(
      currentMessages as ToolResultMessage[],
      serviceModelId,
    );

    return {
      history,
      currentMessage: convertedCurrent.userInputMessage!,
    };
  }

  const convertedCurrent = convertUserMessageToKiroMessage(firstMessage, serviceModelId);
  return {
    history,
    currentMessage: convertedCurrent.userInputMessage!,
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
  const normalizedMessages = normalizeKiroMessages(input.context.messages);
  const { historyMessages, currentMessages } = splitKiroMessagesForCurrentTurn(normalizedMessages);
  const history = buildKiroHistory(historyMessages, serviceModelId);
  const builtCurrent = buildKiroCurrentMessage(currentMessages, serviceModelId, history);
  const currentWithTools = applyToolsToCurrentMessage(
    builtCurrent.currentMessage,
    convertPiToolDefinitions(input.context.tools),
  );
  const aligned = alignCurrentToolResultsWithHistory({
    history: builtCurrent.history,
    currentMessage: currentWithTools,
    originalMessages: normalizedMessages,
    serviceModelId,
  });
  const injected = injectSystemPromptIntoKiroMessages(
    aligned.history,
    aligned.currentMessage,
    effectiveSystemPrompt || undefined,
  );
  const currentWithHistoryTools = ensureHistoryToolDefinitions(injected.history, injected.currentMessage);
  const fitted = fitKiroPayloadToSize({
    history: injected.history,
    currentMessage: currentWithHistoryTools,
    conversationId: input.conversationId,
  });
  const endpoint = buildKiroRequestEndpoint(input.credentials);
  const region = resolveKiroRequestRegion(input.credentials);

  const payload = {
    conversationState: {
      chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
      conversationId: input.conversationId,
      history: fitted.history.length > 0 ? fitted.history : undefined,
      currentMessage: {
        userInputMessage: fitted.currentMessage,
      },
    },
    profileArn: input.credentials.profileArn,
  };

  return {
    endpoint,
    region,
    requestedModelId: input.modelId,
    serviceModelId,
    effectiveSystemPrompt: effectiveSystemPrompt || undefined,
    thinkingConfig,
    payload,
    diagnostics: {
      toolResultTruncationCount: countKiroToolResultTruncations(fitted.history, fitted.currentMessage),
      currentMessageTruncated: fitted.currentMessage.content.includes(KIRO_TRUNCATION_TOKEN),
      prunedHistoryMessageCount: Math.max(0, injected.history.length - fitted.history.length),
      finalPayloadChars: JSON.stringify(payload).length,
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
