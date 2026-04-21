import type { Context, OAuthCredentials, ThinkingLevel } from "@mariozechner/pi-ai";

export const KIRO_PROVIDER_NAME = "kiro" as const;
export const KIRO_CUSTOM_API = "kiro-api" as const;
export const KIRO_DEFAULT_OIDC_REGION = "us-east-1" as const;
export const KIRO_DEFAULT_SERVICE_REGION = "us-east-1" as const;
export const KIRO_PROFILE_ARN_ENV_VAR = "KIRO_PROFILE_ARN" as const;
export const KIRO_CONFIG_FILE_NAME = "kiro.json" as const;

export const KIRO_AUTH_MODES = {
  BUILDER_ID: "builder-id",
  IDENTITY_CENTER: "identity-center",
} as const;

export type KiroProviderName = typeof KIRO_PROVIDER_NAME;
export type KiroAuthMode = (typeof KIRO_AUTH_MODES)[keyof typeof KIRO_AUTH_MODES];
export type KiroInputModality = "text" | "image";
export type KiroModelCatalogSource = "fallback" | "discovered";
export type KiroRuntimeConfigSource = "environment" | "config-file";

export interface KiroRuntimeConfigFile {
  profileArn?: string;
}

export interface KiroRuntimeConfig {
  profileArn?: string;
  source?: KiroRuntimeConfigSource;
  configPath?: string;
}

export interface KiroOAuthCredentials extends OAuthCredentials {
  authMode: KiroAuthMode;
  region: string;
  oidcRegion: string;
  startUrl?: string;
  clientId: string;
  clientSecret: string;
  profileArn?: string;
}

export interface KiroModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface KiroCatalogModelDefinition {
  id: string;
  name: string;
  serviceModelId?: string;
  family?: string;
  reasoning?: boolean;
  inputModalities?: readonly KiroInputModality[];
  contextWindow?: number;
  maxTokens?: number;
  notes?: string;
}

export interface KiroProviderModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: KiroInputModality[];
  cost: KiroModelCost;
  contextWindow: number;
  maxTokens: number;
}

export interface KiroNormalizedModelDefinition extends KiroProviderModelConfig {
  source: KiroModelCatalogSource;
  serviceModelId: string;
  family?: string;
  notes?: string;
}

export interface KiroRequestImage {
  format: string;
  source: {
    bytes: Uint8Array;
  };
}

export interface KiroToolDefinition {
  toolSpecification: {
    name: string;
    description: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface KiroToolResultContentPart {
  text?: string;
}

export interface KiroToolResult {
  toolUseId: string;
  content: KiroToolResultContentPart[];
  status: "success" | "error";
}

export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[];
  tools?: KiroToolDefinition[];
}

export interface KiroUserInputMessage {
  content: string;
  modelId: string;
  origin: "AI_EDITOR";
  images?: KiroRequestImage[];
  userInputMessageContext?: KiroUserInputMessageContext;
}

export interface KiroAssistantResponseMessage {
  content: string;
  toolUses?: KiroToolUse[];
}

export interface KiroConversationMessage {
  userInputMessage?: KiroUserInputMessage;
  assistantResponseMessage?: KiroAssistantResponseMessage;
}

export interface KiroConversationState {
  chatTriggerType: "MANUAL";
  conversationId?: string;
  history?: KiroConversationMessage[];
  currentMessage: {
    userInputMessage: KiroUserInputMessage;
  };
}

export interface KiroRequestPayload {
  conversationState: KiroConversationState;
  profileArn?: string;
}

export interface KiroThinkingConfig {
  enabled: boolean;
  level?: ThinkingLevel;
  budgetTokens?: number;
  systemPromptPrefix?: string;
}

export interface KiroRequestAdapterInput {
  modelId: string;
  context: Context;
  credentials: Pick<KiroOAuthCredentials, "region" | "profileArn">;
  reasoning?: ThinkingLevel;
  conversationId?: string;
  serviceModelId?: string;
}

export interface KiroPreparedRequest {
  endpoint: string;
  region: string;
  requestedModelId: string;
  serviceModelId: string;
  effectiveSystemPrompt?: string;
  thinkingConfig: KiroThinkingConfig;
  payload: KiroRequestPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeKiroProfileArn(profileArn?: string): string | undefined {
  const normalized = profileArn?.trim();
  return normalized || undefined;
}

export function parseKiroRuntimeConfigFile(input: string): KiroRuntimeConfigFile {
  if (!input.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch (error) {
    throw new Error(
      `Kiro config file must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("Kiro config file must contain a JSON object.");
  }

  return {
    profileArn: normalizeKiroProfileArn(
      typeof parsed.profileArn === "string"
        ? parsed.profileArn
        : typeof parsed.idcProfileArn === "string"
          ? parsed.idcProfileArn
          : undefined,
    ),
  };
}

export function applyKiroProfileArnOverride<T extends { profileArn?: string }>(
  value: T,
  profileArn?: string,
): T {
  const normalizedProfileArn = normalizeKiroProfileArn(profileArn);

  if (value.profileArn || !normalizedProfileArn) {
    return value;
  }

  return {
    ...value,
    profileArn: normalizedProfileArn,
  };
}

export function looksLikeKiroMissingProfileArnError(input: {
  authMode?: string;
  profileArn?: string;
  status?: number;
  detail?: string;
}): boolean {
  if (input.authMode !== KIRO_AUTH_MODES.IDENTITY_CENTER || normalizeKiroProfileArn(input.profileArn)) {
    return false;
  }

  if (typeof input.status === "number" && input.status !== 401 && input.status !== 403) {
    return false;
  }

  const haystack = (input.detail ?? "").toLowerCase();
  return (
    haystack.includes("profilearn") ||
    haystack.includes("profile arn") ||
    haystack.includes("accessdenied") ||
    haystack.includes("not authorized") ||
    haystack.includes("codewhisperer") ||
    haystack.includes("q developer")
  );
}

export function buildKiroMissingProfileArnErrorMessage(configPath?: string): string {
  const configLocation = configPath ?? "~/.pi/agent/kiro.json";
  return `This IAM Identity Center account appears to require profileArn. Set ${KIRO_PROFILE_ARN_ENV_VAR} or add {"profileArn":"arn:aws:..."} to ${configLocation}, then run /login again.`;
}
