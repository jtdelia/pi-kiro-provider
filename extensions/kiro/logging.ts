import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const KIRO_LOG_FILE_NAME = "kiro.log" as const;
export const KIRO_PAYLOAD_LOG_FILE_NAME = "kiro-payload.log" as const;

const REDACTED_VALUE = "[REDACTED]" as const;
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|api[-_]?key|password|access|refresh)/i;
const SENSITIVE_STRING_FIELD_PATTERN = [
  "authorization",
  "access(?:[_-]?token)?",
  "refresh(?:[_-]?token)?",
  "id(?:[_-]?token)?",
  "client(?:[_-]?secret)?",
  "secret",
  "api[-_]?key",
  "password",
].join("|");

export interface KiroLoggingDependencies {
  logPath?: string;
  payloadLogPath?: string;
  appendLogFile?: (path: string, content: string) => Promise<void>;
}

export interface KiroPayloadLogInput {
  modelId: string;
  provider: string;
  api: string;
  requestMode: string;
  conversationId?: string;
  endpoint: string;
  serviceModelId?: string;
  payloadModifiedByCallback: boolean;
  finalPayloadUtf8Bytes: number;
  payload: unknown;
}

interface KiroSerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface KiroLogEntry {
  timestamp: string;
  level: "error" | "info";
  event: string;
  message: string;
  context?: Record<string, unknown>;
  error?: KiroSerializedError;
}

export function getDefaultKiroLogPath(): string {
  return join(getAgentDir(), KIRO_LOG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeKiroLogString(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, `$1 ${REDACTED_VALUE}`)
    .replace(
      new RegExp(
        `([?&](?:${SENSITIVE_STRING_FIELD_PATTERN})=)([^&#\\s]+)`,
        "gi",
      ),
      `$1${REDACTED_VALUE}`,
    )
    .replace(
      new RegExp(
        `(["']?(?:${SENSITIVE_STRING_FIELD_PATTERN})["']?\\s*[:=]\\s*["'])([^"']*)(["'])`,
        "gi",
      ),
      `$1${REDACTED_VALUE}$3`,
    )
    .replace(
      new RegExp(
        `(["']?(?:${SENSITIVE_STRING_FIELD_PATTERN})["']?\\s*[:=]\\s*)([^,\\s)}]+)`,
        "gi",
      ),
      `$1${REDACTED_VALUE}`,
    );
}

function redactValue(key: string | undefined, value: unknown): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED_VALUE;
  }

  if (typeof value === "string") {
    return sanitizeKiroLogString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(undefined, item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactValue(entryKey, entryValue)]),
    );
  }

  return value;
}

function redactDataValue(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return REDACTED_VALUE;
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(redactDataValue);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactDataValue(entryValue),
      ]),
    );
  }

  return REDACTED_VALUE;
}

function redactTextField(
  result: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    result[key] = REDACTED_VALUE;
    result[`${key}Length`] = value.length;
    return;
  }

  result[key] = redactDataValue(value);
}

function redactKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? REDACTED_VALUE : redactKiroSchema(item));
  }

  if (!isRecord(value)) {
    return redactDataValue(value);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "properties" && isRecord(entryValue)) {
      result.propertyCount = Object.keys(entryValue).length;
      continue;
    }

    if (key === "required" && Array.isArray(entryValue)) {
      result.requiredCount = entryValue.length;
      continue;
    }

    if (key === "type" || key === "format") {
      result[key] = typeof entryValue === "string" ? entryValue : REDACTED_VALUE;
      continue;
    }

    if (
      key === "additionalProperties" &&
      typeof entryValue === "boolean"
    ) {
      result[key] = entryValue;
      continue;
    }

    if (
      ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key) &&
      typeof entryValue === "number" &&
      Number.isFinite(entryValue)
    ) {
      result[key] = entryValue;
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      result[key] = redactKiroSchema(entryValue);
      continue;
    }

    result[key] = redactDataValue(entryValue);
  }

  return result;
}

function redactKiroImage(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if (typeof value.format === "string") {
    result.format = value.format;
  }

  if (isRecord(value.source)) {
    result.source = {
      bytes: REDACTED_VALUE,
      ...(typeof value.source.bytes === "string" ? { encodedLength: value.source.bytes.length } : {}),
    };
  } else if ("source" in value) {
    result.source = REDACTED_VALUE;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (key !== "format" && key !== "source") {
      result[key] = redactDataValue(entryValue);
    }
  }

  return result;
}

function redactKiroToolDefinition(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const specification = isRecord(value.toolSpecification) ? value.toolSpecification : undefined;
  if (!specification) {
    return redactDataValue(value);
  }

  const result: Record<string, unknown> = {
    toolSpecification: {},
  };
  const redactedSpecification = result.toolSpecification as Record<string, unknown>;

  if (typeof specification.name === "string") {
    redactedSpecification.name = specification.name;
  }
  if ("description" in specification) {
    redactTextField(redactedSpecification, "description", specification.description);
  }
  if (isRecord(specification.inputSchema) && "json" in specification.inputSchema) {
    redactedSpecification.inputSchema = {
      json: redactKiroSchema(specification.inputSchema.json),
    };
  } else if ("inputSchema" in specification) {
    redactedSpecification.inputSchema = REDACTED_VALUE;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (key !== "toolSpecification") {
      result[key] = redactDataValue(entryValue);
    }
  }

  return result;
}

function redactKiroToolResult(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if (typeof value.toolUseId === "string") {
    result.toolUseId = value.toolUseId;
  }
  if (value.status === "success" || value.status === "error") {
    result.status = value.status;
  }
  if (Array.isArray(value.content)) {
    result.content = value.content.map((part) => {
      if (!isRecord(part)) {
        return REDACTED_VALUE;
      }

      const redactedPart: Record<string, unknown> = {};
      if ("text" in part) {
        redactTextField(redactedPart, "text", part.text);
      }
      for (const [key, entryValue] of Object.entries(part)) {
        if (key !== "text") {
          redactedPart[key] = redactDataValue(entryValue);
        }
      }
      return redactedPart;
    });
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (!["toolUseId", "status", "content"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }

  return result;
}

function redactKiroUserInputMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if ("content" in value) {
    redactTextField(result, "content", value.content);
  }
  if (typeof value.modelId === "string") {
    result.modelId = value.modelId;
  }
  if (value.origin === "AI_EDITOR" || value.origin === "KIRO_CLI") {
    result.origin = value.origin;
  }
  if (Array.isArray(value.images)) {
    result.images = value.images.map(redactKiroImage);
  }

  if (isRecord(value.userInputMessageContext)) {
    const context = value.userInputMessageContext;
    const redactedContext: Record<string, unknown> = {};
    if (isRecord(context.envState)) {
      const envState: Record<string, unknown> = {};
      if (typeof context.envState.operatingSystem === "string") {
        envState.operatingSystem = context.envState.operatingSystem;
      }
      if ("currentWorkingDirectory" in context.envState) {
        redactTextField(envState, "currentWorkingDirectory", context.envState.currentWorkingDirectory);
      }
      redactedContext.envState = envState;
    }
    if (Array.isArray(context.toolResults)) {
      redactedContext.toolResults = context.toolResults.map(redactKiroToolResult);
    }
    if (Array.isArray(context.tools)) {
      redactedContext.tools = context.tools.map(redactKiroToolDefinition);
    }
    for (const [key, entryValue] of Object.entries(context)) {
      if (!["envState", "toolResults", "tools"].includes(key)) {
        redactedContext[key] = redactDataValue(entryValue);
      }
    }
    result.userInputMessageContext = redactedContext;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (!["content", "modelId", "origin", "images", "userInputMessageContext"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }

  return result;
}

function redactKiroAssistantResponseMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if (typeof value.messageId === "string") {
    result.messageId = value.messageId;
  }
  if ("content" in value) {
    redactTextField(result, "content", value.content);
  }
  if (Array.isArray(value.toolUses)) {
    result.toolUses = value.toolUses.map((toolUse) => {
      if (!isRecord(toolUse)) {
        return REDACTED_VALUE;
      }

      const redactedToolUse: Record<string, unknown> = {};
      if (typeof toolUse.toolUseId === "string") {
        redactedToolUse.toolUseId = toolUse.toolUseId;
      }
      if (typeof toolUse.name === "string") {
        redactedToolUse.name = toolUse.name;
      }
      if ("input" in toolUse) {
        redactedToolUse.input = redactDataValue(toolUse.input);
      }
      for (const [key, entryValue] of Object.entries(toolUse)) {
        if (!["toolUseId", "name", "input"].includes(key)) {
          redactedToolUse[key] = redactDataValue(entryValue);
        }
      }
      return redactedToolUse;
    });
  }
  if (isRecord(value.reasoningContent)) {
    const reasoningContent: Record<string, unknown> = {};
    if ("redactedContent" in value.reasoningContent) {
      redactTextField(reasoningContent, "redactedContent", value.reasoningContent.redactedContent);
    }
    result.reasoningContent = reasoningContent;
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (!["messageId", "content", "toolUses", "reasoningContent"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }

  return result;
}

function redactKiroConversationMessage(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if ("userInputMessage" in value) {
    result.userInputMessage = redactKiroUserInputMessage(value.userInputMessage);
  }
  if ("assistantResponseMessage" in value) {
    result.assistantResponseMessage = redactKiroAssistantResponseMessage(value.assistantResponseMessage);
  }
  for (const [key, entryValue] of Object.entries(value)) {
    if (!["userInputMessage", "assistantResponseMessage"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }
  return result;
}

function redactKiroConversationState(value: unknown): unknown {
  if (!isRecord(value)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if (typeof value.chatTriggerType === "string") {
    result.chatTriggerType = value.chatTriggerType;
  }
  if (typeof value.agentTaskType === "string") {
    result.agentTaskType = value.agentTaskType;
  }
  if (typeof value.conversationId === "string") {
    result.conversationId = value.conversationId;
  }
  if (Array.isArray(value.history)) {
    result.history = value.history.map(redactKiroConversationMessage);
  }
  if (isRecord(value.currentMessage)) {
    result.currentMessage = {
      ...value.currentMessage,
      ...(typeof value.currentMessage.userInputMessage !== "undefined"
        ? { userInputMessage: redactKiroUserInputMessage(value.currentMessage.userInputMessage) }
        : {}),
    };
  }
  for (const [key, entryValue] of Object.entries(value)) {
    if (!["chatTriggerType", "agentTaskType", "conversationId", "history", "currentMessage"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }
  return result;
}

/** Redact a final Kiro wire payload without mutating the request object. */
export function redactKiroPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return REDACTED_VALUE;
  }

  const result: Record<string, unknown> = {};
  if ("conversationState" in payload) {
    result.conversationState = redactKiroConversationState(payload.conversationState);
  }
  if ("profileArn" in payload) {
    result.profileArn = REDACTED_VALUE;
  }
  if (isRecord(payload.additionalModelRequestFields)) {
    const additionalFields: Record<string, unknown> = {};
    if (isRecord(payload.additionalModelRequestFields.reasoning)) {
      const reasoning: Record<string, unknown> = {};
      const effort = payload.additionalModelRequestFields.reasoning.effort;
      if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
        reasoning.effort = effort;
      }
      additionalFields.reasoning = reasoning;
    }
    for (const [key, entryValue] of Object.entries(payload.additionalModelRequestFields)) {
      if (key !== "reasoning") {
        additionalFields[key] = redactDataValue(entryValue);
      }
    }
    result.additionalModelRequestFields = additionalFields;
  }
  for (const [key, entryValue] of Object.entries(payload)) {
    if (!["conversationState", "profileArn", "additionalModelRequestFields"].includes(key)) {
      result[key] = redactDataValue(entryValue);
    }
  }
  return result;
}

function serializeError(error: unknown): KiroSerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

async function defaultAppendLogFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, content, "utf8");
}

async function writeKiroLogEntry(
  dependencies: KiroLoggingDependencies,
  entry: KiroLogEntry,
): Promise<void> {
  const appendLogFile = dependencies.appendLogFile ?? defaultAppendLogFile;
  const logPath = dependencies.logPath ?? getDefaultKiroLogPath();

  try {
    await appendLogFile(logPath, `${JSON.stringify(redactValue(undefined, entry))}\n`);
  } catch {
    // Logging must never break the provider.
  }
}

export async function logKiroInfo(
  dependencies: KiroLoggingDependencies,
  event: string,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  await writeKiroLogEntry(dependencies, {
    timestamp: new Date().toISOString(),
    level: "info",
    event,
    message,
    context: context ? (redactValue(undefined, context) as Record<string, unknown>) : undefined,
  });
}

export async function logKiroError(
  dependencies: KiroLoggingDependencies,
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  await writeKiroLogEntry(dependencies, {
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    message: error instanceof Error ? error.message : String(error),
    context: context ? (redactValue(undefined, context) as Record<string, unknown>) : undefined,
    error: serializeError(error),
  });
}

export function getDefaultKiroPayloadLogPath(): string {
  return join(getAgentDir(), KIRO_PAYLOAD_LOG_FILE_NAME);
}

/**
 * Write a redacted final request payload to the opt-in payload log. Payload-log failures are
 * deliberately swallowed so diagnostics can never change request behavior.
 */
export async function logKiroPayload(
  dependencies: KiroLoggingDependencies,
  input: KiroPayloadLogInput,
): Promise<void> {
  const appendLogFile = dependencies.appendLogFile ?? defaultAppendLogFile;
  const payloadLogPath = dependencies.payloadLogPath ?? getDefaultKiroPayloadLogPath();

  try {
    const entry = {
      timestamp: new Date().toISOString(),
      level: "debug" as const,
      event: "request_payload" as const,
      context: {
        modelId: input.modelId,
        provider: input.provider,
        api: input.api,
        requestMode: input.requestMode,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        endpoint: input.endpoint,
        ...(input.serviceModelId ? { serviceModelId: input.serviceModelId } : {}),
        payloadModifiedByCallback: input.payloadModifiedByCallback,
        finalPayloadUtf8Bytes: input.finalPayloadUtf8Bytes,
      },
      payload: redactKiroPayload(input.payload),
    };
    await appendLogFile(payloadLogPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Payload diagnostics must never prevent or alter the model request.
  }
}
