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
  KiroEnvironmentState,
  KiroImageFormat,
  KiroOperatingSystem,
  KiroPreparedRequest,
  KiroRequestMode,
  KiroRequestAdapterInput,
  KiroRequestImage,
  KiroRequestPayload,
  KiroSerializedPayload,
  KiroThinkingConfig,
  KiroToolDefinition,
  KiroToolResult,
  KiroToolUse,
  KiroUserInputMessage,
} from "./types";

const KIRO_REQUEST_ORIGIN = "AI_EDITOR" as const;
const KIRO_CLI_REQUEST_ORIGIN = "KIRO_CLI" as const;
const KIRO_CHAT_TRIGGER_TYPE = "MANUAL" as const;
const KIRO_AGENT_TASK_TYPE = "vibe" as const;
const KIRO_CONTINUATION_MESSAGE = "Continue";
const KIRO_RUNNING_TOOLS_MESSAGE = "Running tools...";
const KIRO_SYNTHETIC_TOOL_CALL_MESSAGE = "I will execute the following tools.";
const KIRO_SYNTHETIC_TOOL_RESULT_MESSAGE = "No result provided";
const KIRO_EMPTY_ASSISTANT_MESSAGE = "(empty)";
const KIRO_DEFAULT_TOOL_RESULT_MESSAGE = "Tool results provided.";
const KIRO_IMAGE_ONLY_MESSAGE = "Image provided.";
const KIRO_GENERATE_ASSISTANT_RESPONSE_PATH = "/generateAssistantResponse";
const KIRO_TRANSPORT_USER_AGENT = "aws-sdk-js/3.738.0 KiroIDE";
const KIRO_TRANSPORT_USER_AGENT_DETAIL = `aws-sdk-js/3.738.0 ua/2.1 lang/js api/codewhisperer#3.738.0 m/E KiroIDE`;
const KIRO_CLI_TRANSPORT_USER_AGENT = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 md/appVersion-2.18.1 app/AmazonQ-For-CLI";
const KIRO_CLI_TRANSPORT_USER_AGENT_DETAIL = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/linux lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";

const KIRO_THINKING_BUDGETS: Record<ThinkingLevel, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  // Kiro's max effort mode uses the 50k legacy marker budget.
  xhigh: 50000,
};

const KIRO_TRUNCATION_TOKEN = "... [TRUNCATED] ...";
const KIRO_TRUNCATION_MARKER = `\n${KIRO_TRUNCATION_TOKEN}\n`;
const KIRO_MAX_TOOL_RESULT_TEXT_CHARS = 100_000;
export const KIRO_MAX_CURRENT_TOOL_RESULT_TEXT_CHARS = 200_000;
const KIRO_DEFAULT_HISTORY_BYTE_BUDGET = 500_000;
/** Conservative client guardrail, not a documented Kiro service limit. */
export const KIRO_MAX_REQUEST_BODY_BYTES = 650_000;
/** Documented Kiro CLI guidance: no more than ten images per request. */
export const KIRO_MAX_IMAGES_PER_REQUEST = 10;
/** Documented Kiro CLI guidance: images should be under 10 MiB each. */
export const KIRO_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface KiroTransportRequestInput {
  preparedRequest: Pick<KiroPreparedRequest, "endpoint" | "payload" | "requestMode">;
  accessToken: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  requestId?: string;
}

export function serializeKiroPayload(payload: KiroRequestPayload): KiroSerializedPayload {
  const body = JSON.stringify(payload);
  return {
    body,
    utf8Bytes: Buffer.byteLength(body, "utf8"),
  };
}

export function getKiroHistoryByteBudget(contextWindow?: number): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return KIRO_DEFAULT_HISTORY_BYTE_BUDGET;
  }

  return Math.floor((contextWindow / 200_000) * 850_000);
}

export class KiroContextLengthExceededError extends Error {
  readonly utf8Bytes: number;
  readonly maxRequestBodyBytes: number;

  constructor(input: {
    utf8Bytes: number;
    reductions?: {
      prunedHistoryMessageCount: number;
      removedHistoricalImageCount: number;
      aggregateToolResultTruncationCount: number;
      removedOptionalToolDefinitionCount: number;
    };
  }) {
    const reductions = input.reductions
      ? `; reductions: history=${input.reductions.prunedHistoryMessageCount}, historicalImages=${input.reductions.removedHistoricalImageCount}, aggregateToolResults=${input.reductions.aggregateToolResultTruncationCount}, optionalTools=${input.reductions.removedOptionalToolDefinitionCount}`
      : "";
    super(
      `context_length_exceeded: Kiro request body is ${input.utf8Bytes} bytes, exceeding the ${KIRO_MAX_REQUEST_BODY_BYTES}-byte client guardrail${reductions}.`,
    );
    this.name = "KiroContextLengthExceededError";
    this.utf8Bytes = input.utf8Bytes;
    this.maxRequestBodyBytes = KIRO_MAX_REQUEST_BODY_BYTES;
  }
}

function createKiroContextLengthExceededError(input: {
  utf8Bytes: number;
  reductions?: {
    prunedHistoryMessageCount: number;
    removedHistoricalImageCount: number;
    aggregateToolResultTruncationCount: number;
    removedOptionalToolDefinitionCount: number;
  };
}): KiroContextLengthExceededError {
  return new KiroContextLengthExceededError(input);
}

export class KiroImageLimitExceededError extends Error {
  readonly reason: "count" | "size";
  readonly imageCount: number;
  readonly imageBytes?: number;

  constructor(input: { reason: "count"; imageCount: number } | { reason: "size"; imageCount: number; imageBytes: number }) {
    const message = input.reason === "count"
      ? `Kiro request contains ${input.imageCount} images, exceeding the ${KIRO_MAX_IMAGES_PER_REQUEST}-image limit.`
      : `Kiro image is ${input.imageBytes} bytes, exceeding the ${KIRO_MAX_IMAGE_BYTES}-byte per-image limit.`;
    super(message);
    this.name = "KiroImageLimitExceededError";
    this.reason = input.reason;
    this.imageCount = input.imageCount;
    if (input.reason === "size") {
      this.imageBytes = input.imageBytes;
    }
  }
}

function getKiroImageByteLength(image: KiroRequestImage): number {
  return Buffer.byteLength(Buffer.from(image.source.bytes, "base64"));
}

export function validateKiroImages(images: readonly KiroRequestImage[]): void {
  if (images.length > KIRO_MAX_IMAGES_PER_REQUEST) {
    throw new KiroImageLimitExceededError({ reason: "count", imageCount: images.length });
  }

  for (const image of images) {
    const imageBytes = getKiroImageByteLength(image);
    if (imageBytes >= KIRO_MAX_IMAGE_BYTES) {
      throw new KiroImageLimitExceededError({ reason: "size", imageCount: images.length, imageBytes });
    }
  }
}

function getKiroPayloadImages(payload: KiroRequestPayload): KiroRequestImage[] {
  return [
    ...(payload.conversationState.history ?? []).flatMap((message) => message.userInputMessage?.images ?? []),
    ...(payload.conversationState.currentMessage.userInputMessage.images ?? []),
  ];
}

export function validateKiroPayloadImages(payload: KiroRequestPayload): void {
  validateKiroImages(getKiroPayloadImages(payload));
}

export function assertKiroPayloadFitsBudget(payload: KiroRequestPayload): KiroSerializedPayload {
  validateKiroPayloadImages(payload);
  const serialized = serializeKiroPayload(payload);
  if (serialized.utf8Bytes > KIRO_MAX_REQUEST_BODY_BYTES) {
    throw createKiroContextLengthExceededError({ utf8Bytes: serialized.utf8Bytes });
  }

  return serialized;
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

function normalizeKiroImageFormat(mimeType: string): KiroImageFormat {
  const [type, subtypeWithParameters] = mimeType.trim().toLowerCase().split("/", 2);
  const subtype = subtypeWithParameters?.split(";", 1)[0]?.trim();
  const format = subtype === "jpg" ? "jpeg" : subtype;

  if (type !== "image" || !format || !["jpeg", "png", "gif", "webp"].includes(format)) {
    throw new Error(`Unsupported image mime type: ${mimeType}`);
  }

  return format as KiroImageFormat;
}

export function convertPiImageToKiroImage(image: { data: string; mimeType: string }): KiroRequestImage {
  return {
    format: normalizeKiroImageFormat(image.mimeType),
    source: {
      bytes: image.data,
    },
  };
}

function toJsonSchemaRecord(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  if (budgetTokens === undefined) {
    throw new Error(`Unsupported Kiro thinking level: ${reasoning}`);
  }

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

    if (part.type === "thinking" && part.thinking) {
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
    if (message.responseId) {
      assistantResponseMessage.messageId = message.responseId;
    }

    const thinkingSignature = message.content.find(
      (part): part is Extract<AssistantMessage["content"][number], { type: "thinking" }> =>
        part.type === "thinking" && Boolean(part.thinkingSignature),
    )?.thinkingSignature;
    if (thinkingSignature) {
      assistantResponseMessage.reasoningContent = { redactedContent: thinkingSignature };
    }

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
  const textContent = extractTextFromUserContent(message.content);
  const userInputMessage: KiroUserInputMessage = {
    content: textContent,
    modelId: serviceModelId,
    origin: KIRO_REQUEST_ORIGIN,
  };

  if (Array.isArray(message.content)) {
    const images = message.content
      .filter((part): part is Extract<(typeof message.content)[number], { type: "image" }> => part.type === "image")
      .map((part) => convertPiImageToKiroImage({ data: part.data, mimeType: part.mimeType }));

    if (images.length > 0) {
      userInputMessage.images = images;
      if (!textContent) {
        userInputMessage.content = KIRO_IMAGE_ONLY_MESSAGE;
      }
    }
  }

  return {
    userInputMessage,
  };
}

export function convertToolResultMessageToKiroToolResult(message: ToolResultMessage): KiroToolResult {
  return {
    toolUseId: message.toolCallId,
    content: message.content
      .filter((part): part is Extract<ToolResultMessage["content"][number], { type: "text" }> => part.type === "text")
      .map((part) => ({ text: truncateToolResultText(part.text) })),
    status: message.isError ? "error" : "success",
  };
}

function extractToolResultMessageImages(message: ToolResultMessage): KiroRequestImage[] {
  return message.content
    .filter((part): part is Extract<ToolResultMessage["content"][number], { type: "image" }> => part.type === "image")
    .map((part) => convertPiImageToKiroImage({ data: part.data, mimeType: part.mimeType }));
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
  const images = messages.flatMap(extractToolResultMessageImages);
  const textContent = messages.map(extractToolResultMessageText).filter(Boolean).join("\n\n");
  const userInputMessage: KiroUserInputMessage = {
    content: textContent || (images.length > 0 ? "" : KIRO_DEFAULT_TOOL_RESULT_MESSAGE),
    modelId: serviceModelId,
    origin: KIRO_REQUEST_ORIGIN,
    userInputMessageContext: {
      toolResults,
    },
  };

  if (images.length > 0) {
    userInputMessage.images = images;
  }

  return { userInputMessage };
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

export function buildKiroRequestEndpoint(
  credentials: KiroRequestAdapterInput["credentials"],
  requestMode: KiroRequestMode = "ide",
): string {
  const region = resolveKiroRequestRegion(credentials);
  if (requestMode === "cli") {
    return `https://runtime.${region}.kiro.dev/`;
  }

  return `https://q.${region}.amazonaws.com${KIRO_GENERATE_ASSISTANT_RESPONSE_PATH}`;
}

/**
 * Kiro rejects the request body outright (`REQUEST_BODY_INVALID`) when
 * `envState.operatingSystem` is not one of `linux`, `macos`, or `windows`, so Node's
 * `process.platform` values cannot be forwarded as-is. Unknown platforms omit the field,
 * which the service accepts.
 */
export function mapNodePlatformToKiroOperatingSystem(platform: string): KiroOperatingSystem | undefined {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return undefined;
  }
}

function getKiroEnvironmentState(): KiroEnvironmentState {
  const operatingSystem = mapNodePlatformToKiroOperatingSystem(process.platform);
  return {
    ...(operatingSystem ? { operatingSystem } : {}),
    currentWorkingDirectory: process.cwd(),
  };
}

function applyKiroRequestMode(payload: KiroRequestPayload, requestMode: KiroRequestMode): KiroRequestPayload {
  if (requestMode === "ide") {
    return payload;
  }

  const convertHistoricalUserMessage = (message: KiroUserInputMessage): KiroUserInputMessage => ({
    content: message.content,
    origin: KIRO_CLI_REQUEST_ORIGIN,
  });

  const convertCurrentUserMessage = (message: KiroUserInputMessage): KiroUserInputMessage => ({
    ...message,
    origin: KIRO_CLI_REQUEST_ORIGIN,
  });

  const convertHistoricalAssistantMessage = (
    message: KiroAssistantResponseMessage,
  ): KiroAssistantResponseMessage => message.toolUses?.length
    ? { ...message, content: "", messageId: message.messageId ?? randomUUID() }
    : message;

  const convertHistoricalMessage = (message: KiroConversationMessage): KiroConversationMessage => {
    if (message.userInputMessage) {
      return { ...message, userInputMessage: convertHistoricalUserMessage(message.userInputMessage) };
    }

    if (message.assistantResponseMessage) {
      return {
        ...message,
        assistantResponseMessage: convertHistoricalAssistantMessage(message.assistantResponseMessage),
      };
    }

    return message;
  };

  return {
    ...payload,
    conversationState: {
      ...payload.conversationState,
      agentTaskType: KIRO_AGENT_TASK_TYPE,
      history: payload.conversationState.history?.map(convertHistoricalMessage),
      currentMessage: {
        userInputMessage: {
          ...convertCurrentUserMessage(payload.conversationState.currentMessage.userInputMessage),
          userInputMessageContext: {
            envState: getKiroEnvironmentState(),
            ...(payload.conversationState.currentMessage.userInputMessage.userInputMessageContext ?? {}),
          },
        },
      },
    },
  };
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

  const firstUserIndex = sanitized.findIndex((entry) => Boolean(entry.userInputMessage));
  return firstUserIndex === -1 ? [] : sanitized.slice(firstUserIndex);
}

function cloneKiroUserInputMessage(message: KiroUserInputMessage): KiroUserInputMessage {
  return {
    ...message,
    images: message.images ? [...message.images] : undefined,
    userInputMessageContext: message.userInputMessageContext
      ? {
          ...message.userInputMessageContext,
          tools: message.userInputMessageContext.tools ? [...message.userInputMessageContext.tools] : undefined,
          toolResults: message.userInputMessageContext.toolResults?.map((toolResult) => ({
            ...toolResult,
            content: toolResult.content.map((part) => ({ ...part })),
          })),
        }
      : undefined,
  };
}

function cloneKiroHistory(history: readonly KiroConversationMessage[]): KiroConversationMessage[] {
  return history.map((message) => ({
    ...(message.userInputMessage ? { userInputMessage: cloneKiroUserInputMessage(message.userInputMessage) } : {}),
    ...(message.assistantResponseMessage
      ? {
          assistantResponseMessage: {
            ...message.assistantResponseMessage,
            toolUses: message.assistantResponseMessage.toolUses?.map((toolUse) => ({ ...toolUse })),
          },
        }
      : {}),
  }));
}

function getCurrentToolResultIds(currentMessage: KiroUserInputMessage): Set<string> {
  return new Set(currentMessage.userInputMessageContext?.toolResults?.map((toolResult) => toolResult.toolUseId) ?? []);
}

function findProtectedHistoryStart(
  history: readonly KiroConversationMessage[],
  protectedToolUseIds: ReadonlySet<string>,
): number | undefined {
  if (protectedToolUseIds.size === 0) {
    return undefined;
  }

  let protectedStart: number | undefined;
  for (let index = 0; index < history.length; index += 1) {
    const hasProtectedToolUse = history[index]?.assistantResponseMessage?.toolUses?.some((toolUse) =>
      protectedToolUseIds.has(toolUse.toolUseId),
    );
    if (!hasProtectedToolUse) {
      continue;
    }

    for (let userIndex = index - 1; userIndex >= 0; userIndex -= 1) {
      if (history[userIndex]?.userInputMessage) {
        protectedStart = protectedStart === undefined ? userIndex : Math.min(protectedStart, userIndex);
        break;
      }
    }
    protectedStart = protectedStart === undefined ? index : Math.min(protectedStart, index);
  }

  return protectedStart;
}

function pruneKiroHistoryToByteBudget(
  history: readonly KiroConversationMessage[],
  maxBytes: number,
  protectedToolUseIds: ReadonlySet<string>,
): KiroConversationMessage[] {
  let pruned = sanitizeKiroHistory(history);
  while (Buffer.byteLength(JSON.stringify(pruned), "utf8") > maxBytes && pruned.length > 0) {
    const reduced = dropOldestKiroHistoryExchange(pruned, protectedToolUseIds);
    if (reduced.length === pruned.length) {
      break;
    }
    pruned = reduced;
  }

  return pruned;
}

function dropOldestKiroHistoryExchange(
  history: readonly KiroConversationMessage[],
  protectedToolUseIds: ReadonlySet<string>,
): KiroConversationMessage[] {
  const sanitized = sanitizeKiroHistory(history);
  const nextUserIndex = sanitized.findIndex((message, index) => index > 0 && Boolean(message.userInputMessage));
  const protectedStart = findProtectedHistoryStart(sanitized, protectedToolUseIds);
  if (nextUserIndex === -1 || (protectedStart !== undefined && nextUserIndex > protectedStart)) {
    return sanitized;
  }

  return sanitizeKiroHistory(sanitized.slice(nextUserIndex));
}

function stripHistoricalImages(history: readonly KiroConversationMessage[]): {
  history: KiroConversationMessage[];
  removedCount: number;
} {
  let removedCount = 0;
  const stripped = cloneKiroHistory(history);
  for (const entry of stripped) {
    if (entry.userInputMessage?.images?.length) {
      removedCount += entry.userInputMessage.images.length;
      delete entry.userInputMessage.images;
    }
  }

  return { history: stripped, removedCount };
}

function applyPerResultToolResultBudget(currentMessage: KiroUserInputMessage): KiroUserInputMessage {
  const nextMessage = cloneKiroUserInputMessage(currentMessage);
  const toolResults = nextMessage.userInputMessageContext?.toolResults;
  if (!toolResults) {
    return nextMessage;
  }

  for (const toolResult of toolResults) {
    toolResult.content = toolResult.content.map((part) => ({
      text: truncateToolResultText(part.text ?? ""),
    }));
  }

  return nextMessage;
}

function applyAggregateToolResultBudget(currentMessage: KiroUserInputMessage): {
  currentMessage: KiroUserInputMessage;
  truncationCount: number;
} {
  const nextMessage = cloneKiroUserInputMessage(currentMessage);
  const toolResults = nextMessage.userInputMessageContext?.toolResults;
  if (!toolResults) {
    return { currentMessage: nextMessage, truncationCount: 0 };
  }

  let remainingCharacters = KIRO_MAX_CURRENT_TOOL_RESULT_TEXT_CHARS;
  let truncationCount = 0;
  let nextContent = nextMessage.content;

  for (const toolResult of toolResults) {
    for (const part of toolResult.content) {
      const originalText = part.text ?? "";
      const budgetedText = remainingCharacters === 0
        ? KIRO_TRUNCATION_TOKEN
        : truncateMiddle(originalText, remainingCharacters);
      if (budgetedText !== originalText) {
        truncationCount += 1;
        nextContent = nextContent.replace(originalText, budgetedText);
      }
      part.text = budgetedText;
      remainingCharacters = Math.max(0, remainingCharacters - originalText.length);
    }
  }

  nextMessage.content = nextContent;
  return { currentMessage: nextMessage, truncationCount };
}

function removeOneOptionalToolDefinition(
  history: readonly KiroConversationMessage[],
  currentMessage: KiroUserInputMessage,
): KiroUserInputMessage | undefined {
  const tools = currentMessage.userInputMessageContext?.tools;
  if (!tools?.length) {
    return undefined;
  }

  const requiredNames = new Set(
    history.flatMap((message) => message.assistantResponseMessage?.toolUses?.map((toolUse) => toolUse.name) ?? []),
  );
  let removableIndex = -1;
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (!requiredNames.has(tools[index]!.toolSpecification.name)) {
      removableIndex = index;
      break;
    }
  }
  if (removableIndex === -1) {
    return undefined;
  }

  const nextMessage = cloneKiroUserInputMessage(currentMessage);
  const nextTools = nextMessage.userInputMessageContext?.tools;
  if (!nextTools) {
    return undefined;
  }

  nextTools.splice(removableIndex, 1);
  if (nextTools.length === 0) {
    delete nextMessage.userInputMessageContext?.tools;
    if (nextMessage.userInputMessageContext && Object.keys(nextMessage.userInputMessageContext).length === 0) {
      delete nextMessage.userInputMessageContext;
    }
  }

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
    // A synthetic assistant `toolUses` turn must follow a user turn to preserve alternation and,
    // when history is empty, to give the request a valid user head. Insert a placeholder user
    // turn unless the last history turn is already a user turn.
    if (history.length === 0 || Boolean(history.at(-1)?.assistantResponseMessage)) {
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
    content: [input.currentMessage.content, ...extraTextBlocks].filter(Boolean).join("\n\n") ||
      (input.currentMessage.images?.length ? "" : KIRO_DEFAULT_TOOL_RESULT_MESSAGE),
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

/**
 * Repair the history that will be sent on the wire so that, combined with the trailing
 * `currentMessage` (always a user turn), it satisfies Kiro's structural rules and avoids
 * `REQUEST_BODY_INVALID`. Pruning slices history from the front and can strand it in shapes
 * that are individually valid but invalid once `currentMessage` is appended:
 *
 *  - a leading orphaned tool-result user turn (its owning assistant was pruned away),
 *  - a leading assistant turn with no user head (e.g. only the protected assistant that owns
 *    the current turn's tool results survived pruning),
 *  - a trailing user turn, which would sit adjacent to the current user turn.
 *
 * `modelId` is used for any synthesized user turn so it matches the request's service model.
 */
function repairKiroWireHistory(
  history: readonly KiroConversationMessage[],
  modelId: string,
): KiroConversationMessage[] {
  let repaired = [...history];

  // Drop leading orphaned tool-result user turns; a tool-result turn is only valid immediately
  // after its matching assistant `toolUses` turn, which cannot be the first turn.
  while (repaired.length > 0 && repaired[0]?.userInputMessage?.userInputMessageContext?.toolResults) {
    repaired = repaired.slice(1);
  }

  // If history now begins with an assistant turn, give it a valid user head instead of dropping
  // it — the surviving assistant may own the current turn's tool results.
  if (repaired.length > 0 && repaired[0]?.assistantResponseMessage) {
    repaired = [
      { userInputMessage: { content: KIRO_RUNNING_TOOLS_MESSAGE, modelId, origin: KIRO_REQUEST_ORIGIN } },
      ...repaired,
    ];
  }

  // The current turn is always a user turn, so history must not end on a user turn. Insert a
  // synthetic "Continue" assistant turn to preserve alternation (mirrors appendHistoryMessage).
  if (repaired.length > 0 && repaired[repaired.length - 1]?.userInputMessage) {
    repaired = [...repaired, { assistantResponseMessage: { content: KIRO_CONTINUATION_MESSAGE } }];
  }

  return repaired;
}

function fitKiroPayloadToSize(input: {
  history: readonly KiroConversationMessage[];
  currentMessage: KiroUserInputMessage;
  originalMessages: readonly Message[];
  serviceModelId: string;
  conversationId?: string;
  profileArn?: string;
  historyByteBudget: number;
  requestMode: KiroRequestMode;
}): {
  payload: KiroRequestPayload;
  serialized: KiroSerializedPayload;
  diagnostics: {
    prunedHistoryMessageCount: number;
    removedHistoricalImageCount: number;
    aggregateToolResultTruncationCount: number;
    removedOptionalToolDefinitionCount: number;
  };
} {
  const strippedHistory = stripHistoricalImages(input.history);
  let currentMessage = applyPerResultToolResultBudget(input.currentMessage);
  validateKiroImages(currentMessage.images ?? []);
  const protectedToolUseIds = getCurrentToolResultIds(currentMessage);
  let history = pruneKiroHistoryToByteBudget(
    strippedHistory.history,
    input.historyByteBudget,
    protectedToolUseIds,
  );
  let aggregateToolResultTruncationCount = 0;
  let removedOptionalToolDefinitionCount = 0;

  const buildPayload = (): KiroRequestPayload => {
    const wireHistory = repairKiroWireHistory(history, currentMessage.modelId ?? input.serviceModelId);
    return applyKiroRequestMode(
      {
        conversationState: {
          chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
          conversationId: input.conversationId,
          history: wireHistory.length > 0 ? wireHistory : undefined,
          currentMessage: { userInputMessage: currentMessage },
        },
        profileArn: input.profileArn,
      },
      input.requestMode,
    );
  };

  let payload = buildPayload();
  let serialized = serializeKiroPayload(payload);

  while (serialized.utf8Bytes > KIRO_MAX_REQUEST_BODY_BYTES && history.length > 0) {
    const reduced = dropOldestKiroHistoryExchange(history, protectedToolUseIds);
    if (reduced.length === history.length) {
      break;
    }
    history = reduced;
    payload = buildPayload();
    serialized = serializeKiroPayload(payload);
  }

  const aggregateBudgeted = applyAggregateToolResultBudget(currentMessage);
  currentMessage = aggregateBudgeted.currentMessage;
  aggregateToolResultTruncationCount = aggregateBudgeted.truncationCount;
  payload = buildPayload();
  serialized = serializeKiroPayload(payload);

  while (serialized.utf8Bytes > KIRO_MAX_REQUEST_BODY_BYTES) {
    const withoutOptionalTool = removeOneOptionalToolDefinition(history, currentMessage);
    if (!withoutOptionalTool) {
      break;
    }

    currentMessage = withoutOptionalTool;
    removedOptionalToolDefinitionCount += 1;
    payload = buildPayload();
    serialized = serializeKiroPayload(payload);
  }

  // Pruning drops history from the front and can strip away the assistant `toolUses` turn that
  // owns the current turn's tool results (sanitizeKiroHistory discards a headless protected
  // assistant). Re-run alignment against the original messages so those owners are always
  // restored; otherwise the current tool-result turn is orphaned and Kiro returns
  // REQUEST_BODY_INVALID.
  const realigned = alignCurrentToolResultsWithHistory({
    history,
    currentMessage,
    originalMessages: input.originalMessages,
    serviceModelId: input.serviceModelId,
  });
  history = realigned.history;
  currentMessage = realigned.currentMessage;
  payload = buildPayload();
  serialized = serializeKiroPayload(payload);

  const diagnostics = {
    prunedHistoryMessageCount: Math.max(0, input.history.length - history.length),
    removedHistoricalImageCount: strippedHistory.removedCount,
    aggregateToolResultTruncationCount,
    removedOptionalToolDefinitionCount,
  };

  if (serialized.utf8Bytes > KIRO_MAX_REQUEST_BODY_BYTES) {
    throw createKiroContextLengthExceededError({
      utf8Bytes: serialized.utf8Bytes,
      reductions: diagnostics,
    });
  }

  return { payload, serialized, diagnostics };
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

/**
 * Whether a context will be sent over the CLI wire contract, which is selected by image turns
 * and, unlike IDE mode, requires a `profileArn`. Callers use this to avoid paying for profile
 * discovery on text-only requests.
 */
export function kiroContextRequiresCliMode(context: Pick<Context, "messages">): boolean {
  return context.messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "image");
  });
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
  const requestMode = input.requestMode ?? (currentWithHistoryTools.images?.length ? "cli" : "ide");
  const historyByteBudget = getKiroHistoryByteBudget(input.contextWindow);
  const fitted = fitKiroPayloadToSize({
    history: injected.history,
    currentMessage: currentWithHistoryTools,
    originalMessages: normalizedMessages,
    serviceModelId,
    conversationId: input.conversationId,
    profileArn: input.credentials.profileArn,
    historyByteBudget,
    requestMode,
  });
  const payload = fitted.payload;
  const endpoint = buildKiroRequestEndpoint(input.credentials, requestMode);
  const region = resolveKiroRequestRegion(input.credentials);

  return {
    endpoint,
    region,
    requestMode,
    requestedModelId: input.modelId,
    serviceModelId,
    effectiveSystemPrompt: effectiveSystemPrompt || undefined,
    thinkingConfig,
    payload,
    diagnostics: {
      toolResultTruncationCount: countKiroToolResultTruncations(
        payload.conversationState.history ?? [],
        payload.conversationState.currentMessage.userInputMessage,
      ),
      aggregateToolResultTruncationCount: fitted.diagnostics.aggregateToolResultTruncationCount,
      currentMessageTruncated: payload.conversationState.currentMessage.userInputMessage.content.includes(
        KIRO_TRUNCATION_TOKEN,
      ),
      prunedHistoryMessageCount: fitted.diagnostics.prunedHistoryMessageCount,
      removedHistoricalImageCount: fitted.diagnostics.removedHistoricalImageCount,
      removedOptionalToolDefinitionCount: fitted.diagnostics.removedOptionalToolDefinitionCount,
      finalPayloadUtf8Bytes: serializeKiroPayload(payload).utf8Bytes,
      maxRequestBodyBytes: KIRO_MAX_REQUEST_BODY_BYTES,
      requestFitsBudget: true,
      historyByteBudget,
    },
  };
}

export function buildKiroTransportHeaders(input: {
  accessToken: string;
  headers?: Record<string, string>;
  requestId?: string;
  requestMode?: KiroRequestMode;
}): Record<string, string> {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw new Error("Kiro transport requires an access token.");
  }

  const isCli = input.requestMode === "cli";
  return {
    Accept: isCli ? "*/*" : "text/event-stream, application/json",
    "Content-Type": isCli ? "application/x-amz-json-1.0" : "application/json",
    "amz-sdk-invocation-id": input.requestId ?? randomUUID(),
    "amz-sdk-request": isCli ? "attempt=1; max=3" : "attempt=1; max=1",
    Authorization: `Bearer ${accessToken}`,
    Connection: "keep-alive",
    "user-agent": isCli ? KIRO_CLI_TRANSPORT_USER_AGENT : KIRO_TRANSPORT_USER_AGENT_DETAIL,
    "x-amz-user-agent": isCli ? KIRO_CLI_TRANSPORT_USER_AGENT_DETAIL : KIRO_TRANSPORT_USER_AGENT,
    ...(isCli ? {
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "x-amzn-codewhisperer-optout": "false",
      "x-kiro-attempt": "1;max=3",
    } : { "x-amzn-kiro-agent-mode": "vibe" }),
    ...(input.headers ?? {}),
  };
}

export function buildKiroTransportRequest(input: KiroTransportRequestInput): {
  url: string;
  init: RequestInit;
  serializedPayload: KiroSerializedPayload;
} {
  const serializedPayload = assertKiroPayloadFitsBudget(input.preparedRequest.payload);
  return {
    url: input.preparedRequest.endpoint,
    init: {
      method: "POST",
      headers: buildKiroTransportHeaders({
        accessToken: input.accessToken,
        headers: input.headers,
        requestId: input.requestId,
        requestMode: input.preparedRequest.requestMode,
      }),
      body: serializedPayload.body,
      signal: input.signal,
    },
    serializedPayload,
  };
}

export function isKiroContextLengthExceededError(input: { status: number; bodyText: string }): boolean {
  if (input.status === 413) {
    return true;
  }

  if (input.status !== 400) {
    return false;
  }

  const detail = input.bodyText.toLowerCase();
  return detail.includes("content_length_exceeds_threshold") || detail.includes("input is too long");
}

export function buildKiroHttpErrorMessage(response: Pick<Response, "status" | "statusText">, bodyText: string): string {
  const detail = sanitizeKiroLogString(bodyText.trim() || response.statusText || "request failed");
  const prefix = isKiroContextLengthExceededError({ status: response.status, bodyText })
    ? "context_length_exceeded: "
    : "";
  return `${prefix}Kiro request failed with HTTP ${response.status}: ${detail}`;
}
