import { EventStreamCodec } from "@smithy/eventstream-codec";

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  StopReason,
} from "@mariozechner/pi-ai";

type KiroStreamModel = {
  api: Api;
  provider: string;
  id: string;
};

type KiroUsagePayload = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type KiroNormalizedStreamEvent =
  | { type: "content"; text: string }
  | { type: "tool_use"; toolUseId: string; name?: string; inputText?: string; inputValue?: Record<string, unknown>; stop: boolean }
  | { type: "stop"; stopReason?: string; usage?: KiroUsagePayload }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "aborted"; message?: string };

interface KiroToolCallState {
  contentIndex: number;
  partialJson: string;
}

interface KiroStreamAdapterState {
  output: AssistantMessage;
  buffer: string;
  inThinking: boolean;
  textBlockIndex: number | null;
  thinkingBlockIndex: number | null;
  toolCalls: Map<string, KiroToolCallState>;
  stopReason: StopReason;
  started: boolean;
  terminal: boolean;
}

export interface KiroStreamEventAdapter {
  output: AssistantMessage;
  start(): AssistantMessageEvent[];
  pushRawEvent(event: unknown): AssistantMessageEvent[];
  finish(): AssistantMessageEvent[];
}

export interface KiroSseDecoder {
  push(chunk: string): unknown[];
  finish(finalChunk?: string): unknown[];
}

export interface KiroResponseStreamDecoder {
  push(chunk: Uint8Array<ArrayBufferLike>): unknown[];
  finish(finalChunk?: Uint8Array<ArrayBufferLike>): unknown[];
}

const KIRO_THINKING_START_TAG = "<thinking>";
const KIRO_THINKING_END_TAG = "</thinking>";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function createEmptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "text") {
        return { ...part };
      }

      if (part.type === "thinking") {
        return { ...part };
      }

      return {
        ...part,
        arguments: { ...part.arguments },
      };
    }),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  };
}

function cloneEvent(event: AssistantMessageEvent): AssistantMessageEvent {
  if (event.type === "start") {
    return { type: "start", partial: cloneAssistantMessage(event.partial) };
  }

  if (event.type === "done") {
    return { type: "done", reason: event.reason, message: cloneAssistantMessage(event.message) };
  }

  if (event.type === "error") {
    return { type: "error", reason: event.reason, error: cloneAssistantMessage(event.error) };
  }

  if (event.type === "toolcall_end") {
    return {
      type: "toolcall_end",
      contentIndex: event.contentIndex,
      toolCall: {
        ...event.toolCall,
        arguments: { ...event.toolCall.arguments },
      },
      partial: cloneAssistantMessage(event.partial),
    };
  }

  return {
    ...event,
    partial: cloneAssistantMessage(event.partial),
  };
}

function createInitialAssistantMessage(model: KiroStreamModel, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp,
  };
}

function pushEvent(events: AssistantMessageEvent[], event: AssistantMessageEvent): void {
  events.push(cloneEvent(event));
}

function ensureStarted(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): void {
  if (state.started) {
    return;
  }

  state.started = true;
  pushEvent(events, {
    type: "start",
    partial: state.output,
  });
}

function openTextBlock(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): number {
  if (state.textBlockIndex !== null) {
    return state.textBlockIndex;
  }

  state.output.content.push({ type: "text", text: "" });
  state.textBlockIndex = state.output.content.length - 1;
  pushEvent(events, {
    type: "text_start",
    contentIndex: state.textBlockIndex,
    partial: state.output,
  });
  return state.textBlockIndex;
}

function openThinkingBlock(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): number {
  if (state.thinkingBlockIndex !== null) {
    return state.thinkingBlockIndex;
  }

  state.output.content.push({ type: "thinking", thinking: "" });
  state.thinkingBlockIndex = state.output.content.length - 1;
  pushEvent(events, {
    type: "thinking_start",
    contentIndex: state.thinkingBlockIndex,
    partial: state.output,
  });
  return state.thinkingBlockIndex;
}

function emitTextDelta(state: KiroStreamAdapterState, events: AssistantMessageEvent[], text: string): void {
  if (!text) {
    return;
  }

  const contentIndex = openTextBlock(state, events);
  const block = state.output.content[contentIndex];
  if (block.type !== "text") {
    throw new Error("Expected a text content block.");
  }

  block.text += text;
  pushEvent(events, {
    type: "text_delta",
    contentIndex,
    delta: text,
    partial: state.output,
  });
}

function emitThinkingDelta(state: KiroStreamAdapterState, events: AssistantMessageEvent[], text: string): void {
  if (!text) {
    return;
  }

  const contentIndex = openThinkingBlock(state, events);
  const block = state.output.content[contentIndex];
  if (block.type !== "thinking") {
    throw new Error("Expected a thinking content block.");
  }

  block.thinking += text;
  pushEvent(events, {
    type: "thinking_delta",
    contentIndex,
    delta: text,
    partial: state.output,
  });
}

function closeTextBlock(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): void {
  if (state.textBlockIndex === null) {
    return;
  }

  const block = state.output.content[state.textBlockIndex];
  if (block.type !== "text") {
    throw new Error("Expected a text content block.");
  }

  pushEvent(events, {
    type: "text_end",
    contentIndex: state.textBlockIndex,
    content: block.text,
    partial: state.output,
  });
  state.textBlockIndex = null;
}

function closeThinkingBlock(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): void {
  if (state.thinkingBlockIndex === null) {
    return;
  }

  const block = state.output.content[state.thinkingBlockIndex];
  if (block.type !== "thinking") {
    throw new Error("Expected a thinking content block.");
  }

  pushEvent(events, {
    type: "thinking_end",
    contentIndex: state.thinkingBlockIndex,
    content: block.thinking,
    partial: state.output,
  });
  state.thinkingBlockIndex = null;
}

function applyUsage(state: KiroStreamAdapterState, usage?: KiroUsagePayload): void {
  if (!usage) {
    return;
  }

  if (typeof usage.input_tokens === "number") {
    state.output.usage.input = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    state.output.usage.output = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    state.output.usage.cacheRead = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    state.output.usage.cacheWrite = usage.cache_creation_input_tokens;
  }

  state.output.usage.totalTokens =
    state.output.usage.input +
    state.output.usage.output +
    state.output.usage.cacheRead +
    state.output.usage.cacheWrite;
}

function mapKiroStopReason(stopReason?: string): StopReason {
  switch (stopReason) {
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
    case "toolUse":
      return "toolUse";
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function getPartialTagSuffixLength(buffer: string, tag: string): number {
  const maxLength = Math.min(buffer.length, tag.length - 1);

  for (let length = maxLength; length > 0; length -= 1) {
    if (buffer.endsWith(tag.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

function flushBufferedContent(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  finalize = false,
): void {
  while (state.buffer.length > 0) {
    if (state.inThinking) {
      const endIndex = state.buffer.indexOf(KIRO_THINKING_END_TAG);
      if (endIndex !== -1) {
        emitThinkingDelta(state, events, state.buffer.slice(0, endIndex));
        state.buffer = state.buffer.slice(endIndex + KIRO_THINKING_END_TAG.length);
        closeThinkingBlock(state, events);
        state.inThinking = false;
        continue;
      }

      if (!finalize) {
        const partialSuffixLength = getPartialTagSuffixLength(state.buffer, KIRO_THINKING_END_TAG);
        const safeLength = state.buffer.length - partialSuffixLength;
        if (safeLength === 0) {
          break;
        }
        emitThinkingDelta(state, events, state.buffer.slice(0, safeLength));
        state.buffer = state.buffer.slice(safeLength);
        break;
      }

      emitThinkingDelta(state, events, state.buffer);
      state.buffer = "";
      closeThinkingBlock(state, events);
      state.inThinking = false;
      break;
    }

    const startIndex = state.buffer.indexOf(KIRO_THINKING_START_TAG);
    if (startIndex !== -1) {
      emitTextDelta(state, events, state.buffer.slice(0, startIndex));
      closeTextBlock(state, events);
      state.buffer = state.buffer.slice(startIndex + KIRO_THINKING_START_TAG.length);
      state.inThinking = true;
      continue;
    }

    if (!finalize) {
      const partialSuffixLength = getPartialTagSuffixLength(state.buffer, KIRO_THINKING_START_TAG);
      const safeLength = state.buffer.length - partialSuffixLength;
      if (safeLength === 0) {
        break;
      }
      emitTextDelta(state, events, state.buffer.slice(0, safeLength));
      state.buffer = state.buffer.slice(safeLength);
      break;
    }

    emitTextDelta(state, events, state.buffer);
    state.buffer = "";
    break;
  }

  if (finalize) {
    closeTextBlock(state, events);
    closeThinkingBlock(state, events);
  }
}

function normalizeToolUseEvent(event: Record<string, unknown>): KiroNormalizedStreamEvent | undefined {
  const toolUseId = readString(event.toolUseId) ?? readString(event.id);
  if (!toolUseId) {
    return undefined;
  }

  const input = event.input;
  const stop = readBoolean(event.stop) ?? false;

  if (typeof input === "string") {
    return {
      type: "tool_use",
      toolUseId,
      name: readString(event.name),
      inputText: input,
      stop,
    };
  }

  if (isRecord(input)) {
    return {
      type: "tool_use",
      toolUseId,
      name: readString(event.name),
      inputValue: input,
      stop,
    };
  }

  if (input !== undefined) {
    return {
      type: "tool_use",
      toolUseId,
      name: readString(event.name),
      inputText: JSON.stringify(input),
      stop,
    };
  }

  return {
    type: "tool_use",
    toolUseId,
    name: readString(event.name),
    stop,
  };
}

function normalizeKiroEvent(event: unknown): KiroNormalizedStreamEvent | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  if (typeof event.type === "string") {
    switch (event.type) {
      case "assistantResponseEvent":
        if (typeof event.content === "string") {
          return { type: "content", text: event.content };
        }
        break;
      case "toolUseEvent":
        return normalizeToolUseEvent(event);
      case "message_delta": {
        const usage = isRecord(event.usage)
          ? {
              input_tokens: typeof event.usage.input_tokens === "number" ? event.usage.input_tokens : undefined,
              output_tokens: typeof event.usage.output_tokens === "number" ? event.usage.output_tokens : undefined,
              cache_creation_input_tokens:
                typeof event.usage.cache_creation_input_tokens === "number"
                  ? event.usage.cache_creation_input_tokens
                  : undefined,
              cache_read_input_tokens:
                typeof event.usage.cache_read_input_tokens === "number"
                  ? event.usage.cache_read_input_tokens
                  : undefined,
            }
          : undefined;
        const delta = isRecord(event.delta) ? event.delta : undefined;
        return {
          type: "stop",
          stopReason: readString(delta?.stop_reason),
          usage,
        };
      }
      case "message_stop":
      case "done":
        return { type: "done" };
      case "error":
        return {
          type: "error",
          message:
            readString(event.message) ??
            readString(isRecord(event.error) ? event.error.message : undefined) ??
            "Kiro stream failed.",
        };
      case "aborted":
        return {
          type: "aborted",
          message: readString(event.message),
        };
      default:
        break;
    }
  }

  if (isRecord(event.assistantResponseEvent) && typeof event.assistantResponseEvent.content === "string") {
    return { type: "content", text: event.assistantResponseEvent.content };
  }

  if (isRecord(event.toolUseEvent)) {
    return normalizeToolUseEvent(event.toolUseEvent);
  }

  if (isRecord(event.messageDeltaEvent)) {
    const delta = isRecord(event.messageDeltaEvent.delta) ? event.messageDeltaEvent.delta : undefined;
    const usage = isRecord(event.messageDeltaEvent.usage) ? event.messageDeltaEvent.usage : undefined;
    return {
      type: "stop",
      stopReason: readString(delta?.stop_reason),
      usage: usage
        ? {
            input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            cache_creation_input_tokens:
              typeof usage.cache_creation_input_tokens === "number"
                ? usage.cache_creation_input_tokens
                : undefined,
            cache_read_input_tokens:
              typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : undefined,
          }
        : undefined,
    };
  }

  return undefined;
}

function parseSseEventBlock(block: string): unknown | undefined {
  const lines = block
    .split(/\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith(":"));

  if (lines.length === 0) {
    return undefined;
  }

  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) {
    return undefined;
  }

  if (data === "[DONE]") {
    return { type: "message_stop" };
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    return { type: "assistantResponseEvent", content: data };
  }
}

function drainSseBlocks(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  let rest = buffer.replace(/\r/g, "");

  let separatorIndex = rest.indexOf("\n\n");
  while (separatorIndex !== -1) {
    const block = rest.slice(0, separatorIndex);
    rest = rest.slice(separatorIndex + 2);
    const parsedBlock = parseSseEventBlock(block);
    if (parsedBlock !== undefined) {
      events.push(parsedBlock);
    }
    separatorIndex = rest.indexOf("\n\n");
  }

  return { events, rest };
}

function emitTerminalDone(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): void {
  state.output.stopReason = state.stopReason;
  pushEvent(events, {
    type: "done",
    reason: state.stopReason === "error" || state.stopReason === "aborted" ? "stop" : state.stopReason,
    message: state.output,
  });
  state.terminal = true;
}

function emitTerminalError(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  reason: "error" | "aborted",
  message?: string,
): void {
  state.output.stopReason = reason;
  state.output.errorMessage = message ?? (reason === "aborted" ? "Kiro stream aborted." : "Kiro stream failed.");
  pushEvent(events, {
    type: "error",
    reason,
    error: state.output,
  });
  state.terminal = true;
}

function openToolCallBlock(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  input: Pick<Extract<KiroNormalizedStreamEvent, { type: "tool_use" }>, "toolUseId" | "name">,
): KiroToolCallState {
  const existing = state.toolCalls.get(input.toolUseId);
  if (existing) {
    const block = state.output.content[existing.contentIndex];
    if (block.type !== "toolCall") {
      throw new Error("Expected a tool call content block.");
    }

    if (input.name) {
      block.name = input.name;
    }
    return existing;
  }

  closeTextBlock(state, events);
  closeThinkingBlock(state, events);

  state.output.content.push({
    type: "toolCall",
    id: input.toolUseId,
    name: input.name ?? "tool",
    arguments: {},
  });

  const contentIndex = state.output.content.length - 1;
  const toolCallState: KiroToolCallState = {
    contentIndex,
    partialJson: "",
  };

  state.toolCalls.set(input.toolUseId, toolCallState);
  pushEvent(events, {
    type: "toolcall_start",
    contentIndex,
    partial: state.output,
  });
  return toolCallState;
}

function parseToolCallArguments(rawJson: string): { arguments?: Record<string, unknown>; error?: string } {
  const trimmedJson = rawJson.trim();
  if (!trimmedJson) {
    return { arguments: {} };
  }

  try {
    const parsed = JSON.parse(trimmedJson) as unknown;
    if (!isRecord(parsed)) {
      return { error: "tool arguments must be a JSON object." };
    }

    return { arguments: parsed };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function appendToolCallDelta(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  toolUseId: string,
  delta: string,
): void {
  if (!delta) {
    return;
  }

  const toolCallState = state.toolCalls.get(toolUseId);
  if (!toolCallState) {
    throw new Error(`Expected tool call state for ${toolUseId}.`);
  }

  const block = state.output.content[toolCallState.contentIndex];
  if (block.type !== "toolCall") {
    throw new Error("Expected a tool call content block.");
  }

  toolCallState.partialJson += delta;

  const parsed = parseToolCallArguments(toolCallState.partialJson);
  if (parsed.arguments) {
    block.arguments = parsed.arguments;
  }

  pushEvent(events, {
    type: "toolcall_delta",
    contentIndex: toolCallState.contentIndex,
    delta,
    partial: state.output,
  });
}

function finalizeToolCall(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  toolUseId: string,
): void {
  const toolCallState = state.toolCalls.get(toolUseId);
  if (!toolCallState) {
    return;
  }

  const block = state.output.content[toolCallState.contentIndex];
  if (block.type !== "toolCall") {
    throw new Error("Expected a tool call content block.");
  }

  const parsed = parseToolCallArguments(toolCallState.partialJson);
  if (parsed.error) {
    emitTerminalError(
      state,
      events,
      "error",
      `Malformed Kiro tool call arguments for ${block.name} (${toolUseId}): ${parsed.error}`,
    );
    return;
  }

  block.arguments = parsed.arguments ?? {};
  pushEvent(events, {
    type: "toolcall_end",
    contentIndex: toolCallState.contentIndex,
    toolCall: block,
    partial: state.output,
  });
  state.toolCalls.delete(toolUseId);
}

function finalizePendingToolCalls(state: KiroStreamAdapterState, events: AssistantMessageEvent[]): void {
  for (const toolUseId of [...state.toolCalls.keys()]) {
    finalizeToolCall(state, events, toolUseId);
    if (state.terminal) {
      return;
    }
  }
}

function applyToolUseEvent(
  state: KiroStreamAdapterState,
  events: AssistantMessageEvent[],
  event: Extract<KiroNormalizedStreamEvent, { type: "tool_use" }>,
): void {
  const toolCallState = openToolCallBlock(state, events, event);

  if (event.inputValue) {
    const inputJson = JSON.stringify(event.inputValue);
    appendToolCallDelta(state, events, event.toolUseId, inputJson);
  } else if (event.inputText) {
    appendToolCallDelta(state, events, event.toolUseId, event.inputText);
  }

  if (event.stop) {
    finalizeToolCall(state, events, event.toolUseId);
    if (state.terminal) {
      return;
    }
  }

  const block = state.output.content[toolCallState.contentIndex];
  if (block.type === "toolCall" && event.name) {
    block.name = event.name;
  }
}

export function createKiroStreamEventAdapter(input: {
  model: KiroStreamModel;
  timestamp?: number;
}): KiroStreamEventAdapter {
  const state: KiroStreamAdapterState = {
    output: createInitialAssistantMessage(input.model, input.timestamp ?? Date.now()),
    buffer: "",
    inThinking: false,
    textBlockIndex: null,
    thinkingBlockIndex: null,
    toolCalls: new Map(),
    stopReason: "stop",
    started: false,
    terminal: false,
  };

  return {
    get output() {
      return state.output;
    },
    start(): AssistantMessageEvent[] {
      const events: AssistantMessageEvent[] = [];
      ensureStarted(state, events);
      return events;
    },
    pushRawEvent(rawEvent: unknown): AssistantMessageEvent[] {
      const events: AssistantMessageEvent[] = [];
      ensureStarted(state, events);

      if (state.terminal) {
        return events;
      }

      const event = normalizeKiroEvent(rawEvent);
      if (!event) {
        return events;
      }

      if (event.type === "content") {
        state.buffer += event.text;
        flushBufferedContent(state, events, false);
        return events;
      }

      if (event.type === "tool_use") {
        flushBufferedContent(state, events, true);
        applyToolUseEvent(state, events, event);
        return events;
      }

      if (event.type === "stop") {
        state.stopReason = mapKiroStopReason(event.stopReason);
        applyUsage(state, event.usage);
        return events;
      }

      flushBufferedContent(state, events, true);
      finalizePendingToolCalls(state, events);
      if (state.terminal) {
        return events;
      }

      if (event.type === "done") {
        emitTerminalDone(state, events);
        return events;
      }

      emitTerminalError(state, events, event.type === "aborted" ? "aborted" : "error", event.message);
      return events;
    },
    finish(): AssistantMessageEvent[] {
      const events: AssistantMessageEvent[] = [];
      ensureStarted(state, events);

      if (state.terminal) {
        return events;
      }

      flushBufferedContent(state, events, true);
      finalizePendingToolCalls(state, events);
      if (state.terminal) {
        return events;
      }
      emitTerminalDone(state, events);
      return events;
    },
  };
}

export function createKiroSseDecoder(): KiroSseDecoder {
  let buffer = "";

  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const drained = drainSseBlocks(buffer);
      buffer = drained.rest;
      return drained.events;
    },
    finish(finalChunk = ""): unknown[] {
      buffer += finalChunk;
      const drained = drainSseBlocks(buffer);
      buffer = drained.rest;

      const trailing = parseSseEventBlock(buffer.trim());
      buffer = "";
      return trailing === undefined ? drained.events : [...drained.events, trailing];
    },
  };
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.length === 0) {
    return new Uint8Array(right);
  }

  if (right.length === 0) {
    return new Uint8Array(left);
  }

  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function looksLikeSseChunk(chunk: Uint8Array<ArrayBufferLike>): boolean {
  if (chunk.length === 0) {
    return true;
  }

  const sample = new TextDecoder().decode(chunk.slice(0, Math.min(chunk.length, 64)));
  return /^(?:\s|data:|event:|:)/.test(sample);
}

function parseKiroEventStreamMessage(message: {
  headers: Record<string, { value: unknown }>;
  body: Uint8Array<ArrayBufferLike>;
}): unknown | undefined {
  const eventType = readString(message.headers[":event-type"]?.value);
  const messageType = readString(message.headers[":message-type"]?.value);
  const bodyText = new TextDecoder().decode(message.body).trim();

  if (messageType === "error" || messageType === "exception") {
    return {
      type: "error",
      message: bodyText || eventType || "Kiro stream failed.",
    };
  }

  let parsedBody: unknown = undefined;
  if (bodyText) {
    try {
      parsedBody = JSON.parse(bodyText) as unknown;
    } catch {
      parsedBody = bodyText;
    }
  }

  switch (eventType) {
    case "assistantResponseEvent":
      return isRecord(parsedBody) ? { assistantResponseEvent: parsedBody } : undefined;
    case "toolUseEvent":
      return isRecord(parsedBody) ? { toolUseEvent: parsedBody } : undefined;
    case "messageDeltaEvent":
      return isRecord(parsedBody) ? { messageDeltaEvent: parsedBody } : undefined;
    case "contextUsageEvent":
      return isRecord(parsedBody) ? { contextUsageEvent: parsedBody } : undefined;
    default:
      return isRecord(parsedBody) ? parsedBody : undefined;
  }
}

export function createKiroResponseStreamDecoder(): KiroResponseStreamDecoder {
  const sseDecoder = createKiroSseDecoder();
  const textDecoder = new TextDecoder();
  const eventStreamCodec = new EventStreamCodec(
    (bytes) => new TextDecoder().decode(bytes),
    (value) => new TextEncoder().encode(value),
  );

  let mode: "sse" | "eventstream" | undefined;
  let binaryBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  const drainBinaryMessages = (): unknown[] => {
    const events: unknown[] = [];

    while (binaryBuffer.length >= 4) {
      const totalLength = new DataView(
        binaryBuffer.buffer,
        binaryBuffer.byteOffset,
        binaryBuffer.byteLength,
      ).getUint32(0, false);

      if (binaryBuffer.length < totalLength) {
        break;
      }

      const messageBytes = new Uint8Array(binaryBuffer.slice(0, totalLength));
      binaryBuffer = new Uint8Array(binaryBuffer.slice(totalLength));
      const event = parseKiroEventStreamMessage(eventStreamCodec.decode(messageBytes));
      if (event !== undefined) {
        events.push(event);
      }
    }

    return events;
  };

  return {
    push(chunk: Uint8Array<ArrayBufferLike>): unknown[] {
      if (!mode) {
        mode = looksLikeSseChunk(chunk) ? "sse" : "eventstream";
      }

      if (mode === "sse") {
        return sseDecoder.push(textDecoder.decode(chunk, { stream: true }));
      }

      binaryBuffer = concatBytes(binaryBuffer, chunk);
      return drainBinaryMessages();
    },
    finish(finalChunk: Uint8Array<ArrayBufferLike> = new Uint8Array(0)): unknown[] {
      if (!mode) {
        mode = looksLikeSseChunk(finalChunk) ? "sse" : "eventstream";
      }

      if (mode === "sse") {
        return sseDecoder.finish(textDecoder.decode(finalChunk, { stream: false }) + textDecoder.decode());
      }

      binaryBuffer = concatBytes(binaryBuffer, finalChunk);
      const events = drainBinaryMessages();
      binaryBuffer = new Uint8Array(0);
      return events;
    },
  };
}

export function parseKiroSseChunks(chunks: readonly string[]): unknown[] {
  const decoder = createKiroSseDecoder();
  const events: unknown[] = [];

  for (const chunk of chunks) {
    events.push(...decoder.push(chunk));
  }

  events.push(...decoder.finish());
  return events;
}

export function convertKiroStreamEventsToAssistantEvents(input: {
  model: KiroStreamModel;
  events: readonly unknown[];
  timestamp?: number;
}): AssistantMessageEvent[] {
  const adapter = createKiroStreamEventAdapter({
    model: input.model,
    timestamp: input.timestamp,
  });
  const events: AssistantMessageEvent[] = [...adapter.start()];

  for (const rawEvent of input.events) {
    events.push(...adapter.pushRawEvent(rawEvent));
  }

  events.push(...adapter.finish());
  return events;
}

export function convertKiroStreamChunksToAssistantEvents(input: {
  model: KiroStreamModel;
  chunks: readonly string[];
  timestamp?: number;
}): AssistantMessageEvent[] {
  return convertKiroStreamEventsToAssistantEvents({
    model: input.model,
    events: parseKiroSseChunks(input.chunks),
    timestamp: input.timestamp,
  });
}
