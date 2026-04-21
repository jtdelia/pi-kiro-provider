import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const KIRO_LOG_FILE_NAME = "kiro.log" as const;

const REDACTED_VALUE = "[REDACTED]" as const;
const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|api[-_]?key|password|access|refresh)/i;

export interface KiroLoggingDependencies {
  logPath?: string;
  appendLogFile?: (path: string, content: string) => Promise<void>;
}

interface KiroSerializedError {
  name: string;
  message: string;
  stack?: string;
}

interface KiroLogEntry {
  timestamp: string;
  level: "error";
  event: string;
  message: string;
  context?: Record<string, unknown>;
  error: KiroSerializedError;
}

export function getDefaultKiroLogPath(): string {
  return join(getAgentDir(), KIRO_LOG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(key: string | undefined, value: unknown): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED_VALUE;
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

export async function logKiroError(
  dependencies: KiroLoggingDependencies,
  event: string,
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  const entry: KiroLogEntry = {
    timestamp: new Date().toISOString(),
    level: "error",
    event,
    message: error instanceof Error ? error.message : String(error),
    context: context ? (redactValue(undefined, context) as Record<string, unknown>) : undefined,
    error: serializeError(error),
  };

  const appendLogFile = dependencies.appendLogFile ?? defaultAppendLogFile;
  const logPath = dependencies.logPath ?? getDefaultKiroLogPath();

  try {
    await appendLogFile(logPath, `${JSON.stringify(redactValue(undefined, entry))}\n`);
  } catch {
    // Logging must never break the provider.
  }
}
