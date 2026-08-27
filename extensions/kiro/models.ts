import { KIRO_FALLBACK_MODEL_CATALOG } from "./fallback-models";
import { logKiroError, type KiroLoggingDependencies } from "./logging";
import type { KiroOAuthCredentials } from "./types";
import type {
  KiroCatalogModelDefinition,
  KiroInputModality,
  KiroModelCost,
  KiroNormalizedModelDefinition,
  KiroProviderModelConfig,
  KiroThinkingLevelMap,
} from "./types";

const KIRO_ZERO_COST: Readonly<KiroModelCost> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const KIRO_LIST_MODELS_TARGET = "AmazonCodeWhispererService.ListAvailableModels" as const;
const KIRO_LIST_MODELS_CONTENT_TYPE = "application/x-amz-json-1.0" as const;
const KIRO_LIST_MODELS_ORIGIN = "CLI" as const;
const KIRO_LIST_PROFILES_TARGET = "AmazonCodeWhispererService.ListAvailableProfiles" as const;

export interface KiroModelDiscoveryDependencies extends KiroLoggingDependencies {
  fetch?: typeof fetch;
}

export function buildKiroListProfilesUrl(region: string): string {
  return `https://management.${region}.kiro.dev/`;
}

function extractKiroProfileArn(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.profiles)) {
    return undefined;
  }

  for (const profile of payload.profiles) {
    if (isRecord(profile) && typeof profile.arn === "string" && profile.arn.trim()) {
      return profile.arn.trim();
    }
  }

  return undefined;
}

/**
 * Ask Kiro which profile this token can use. CLI-mode requests are rejected with
 * `profileArn is required for this request.` when the field is absent, and Identity Center
 * logins do not return a profile ARN with the tokens, so it has to be looked up.
 */
export async function discoverKiroProfileArn(
  credentials: Pick<KiroOAuthCredentials, "access" | "region">,
  dependencies: KiroModelDiscoveryDependencies = {},
): Promise<string | undefined> {
  const fetchImplementation = getFetchImplementation(dependencies);
  const response = await fetchImplementation(buildKiroListProfilesUrl(credentials.region), {
    method: "POST",
    headers: {
      "Content-Type": KIRO_LIST_MODELS_CONTENT_TYPE,
      "X-Amz-Target": KIRO_LIST_PROFILES_TARGET,
      Authorization: `Bearer ${credentials.access}`,
      Accept: "*/*",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`ListAvailableProfiles failed with HTTP ${response.status}.`);
  }

  return extractKiroProfileArn((await response.json()) as unknown);
}

export interface KiroDiscoveredModelRecord {
  id?: string;
  slug?: string;
  name?: string;
  displayName?: string;
  modelName?: string;
  serviceModelId?: string;
  modelId?: string;
  family?: string;
  reasoning?: boolean;
  supportsReasoning?: boolean;
  thinkingLevelMap?: Partial<Record<"minimal" | "low" | "medium" | "high" | "xhigh", string>>;
  reasoningSupported?: boolean;
  supportsPromptCache?: boolean;
  inputModalities?: readonly KiroInputModality[];
  supportedInputTypes?: readonly string[];
  modalities?: {
    input?: readonly KiroInputModality[];
  };
  contextWindow?: number;
  context_window?: number;
  maxTokens?: number;
  max_tokens?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  maxInputTokens?: number;
  tokenLimits?: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  rateMultiplier?: number;
  rateUnit?: string;
  description?: string;
  notes?: string;
}

function cloneZeroCost(): KiroModelCost {
  return { ...KIRO_ZERO_COST };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readInputModalities(value: unknown): KiroInputModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const modalities = value.filter((item): item is KiroInputModality => item === "text" || item === "image");
  return modalities.length > 0 ? modalities : undefined;
}

function getFetchImplementation(dependencies: KiroModelDiscoveryDependencies): typeof fetch {
  if (dependencies.fetch) {
    return dependencies.fetch;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  return globalThis.fetch.bind(globalThis);
}

export function deriveReasoningCapability(model: KiroCatalogModelDefinition): boolean {
  if (typeof model.reasoning === "boolean") {
    return model.reasoning;
  }

  const haystack = `${model.id} ${model.name}`.toLowerCase();
  return (
    haystack.includes("thinking") ||
    haystack.includes("reasoning") ||
    haystack.includes("claude sonnet") ||
    haystack.includes("claude opus")
  );
}

export function deriveThinkingLevelMap(
  model: KiroCatalogModelDefinition,
  reasoning = deriveReasoningCapability(model),
): KiroThinkingLevelMap | undefined {
  if (!reasoning) {
    return undefined;
  }

  if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
    return { ...model.thinkingLevelMap };
  }

  // pi exposes xhigh as its highest portable level; Kiro's equivalent is max.
  return { xhigh: "max" };
}

export function deriveInputModalities(model: KiroCatalogModelDefinition): KiroInputModality[] {
  if (model.inputModalities && model.inputModalities.length > 0) {
    return [...model.inputModalities];
  }

  if (model.id.startsWith("claude-")) {
    return ["text", "image"];
  }

  return ["text"];
}

export function deriveContextWindow(model: KiroCatalogModelDefinition): number {
  if (typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
    return model.contextWindow;
  }

  if (model.id.includes("-1m") || model.name.toLowerCase().includes("1m")) {
    return 1000000;
  }

  switch (model.id) {
    case "deepseek-3.2":
    case "gpt-oss-120b":
      return 128000;
    case "qwen3-coder-next":
      return 256000;
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
    case "gpt-5.6-luna":
      return 272000;
    default:
      return 200000;
  }
}

export function deriveMaxTokens(model: KiroCatalogModelDefinition): number {
  if (typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0) {
    return model.maxTokens;
  }

  return 64000;
}

export function normalizeKiroCatalogModel(
  model: KiroCatalogModelDefinition,
  source: KiroNormalizedModelDefinition["source"] = "fallback",
): KiroNormalizedModelDefinition {
  return {
    id: model.id,
    name: model.name,
    source,
    serviceModelId: model.serviceModelId ?? model.id,
    family: model.family,
    notes: model.notes,
    reasoning: deriveReasoningCapability(model),
    thinkingLevelMap: deriveThinkingLevelMap(model),
    input: deriveInputModalities(model),
    cost: cloneZeroCost(),
    contextWindow: deriveContextWindow(model),
    maxTokens: deriveMaxTokens(model),
  };
}

export function toKiroProviderModelConfig(model: KiroNormalizedModelDefinition): KiroProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function normalizeKiroCatalog(
  models: readonly KiroCatalogModelDefinition[] = KIRO_FALLBACK_MODEL_CATALOG,
  source: KiroNormalizedModelDefinition["source"] = "fallback",
): KiroNormalizedModelDefinition[] {
  const normalizedById = new Map<string, KiroNormalizedModelDefinition>();

  for (const model of models) {
    normalizedById.set(model.id, normalizeKiroCatalogModel(model, source));
  }

  return [...normalizedById.values()];
}

export function getKiroFallbackProviderModels(): KiroProviderModelConfig[] {
  return normalizeKiroCatalog(KIRO_FALLBACK_MODEL_CATALOG).map(toKiroProviderModelConfig);
}

export function getKiroInitialProviderModels(): KiroProviderModelConfig[] {
  return getKiroFallbackProviderModels();
}

export function normalizeDiscoveredKiroModel(record: KiroDiscoveredModelRecord): KiroNormalizedModelDefinition {
  const id = record.id ?? record.slug ?? record.serviceModelId ?? record.modelId;
  const name = record.name ?? record.displayName ?? record.modelName ?? id;

  if (!id || !name) {
    throw new Error("Discovered Kiro model is missing an id or name.");
  }

  // Derive input modalities from supportedInputTypes (API uses "TEXT", "IMAGE")
  let inputModalities: readonly KiroInputModality[] | undefined =
    record.inputModalities ?? record.modalities?.input;
  if (!inputModalities && record.supportedInputTypes) {
    inputModalities = record.supportedInputTypes
      .map((t) => t.toLowerCase())
      .filter((t): t is KiroInputModality => t === "text" || t === "image");
  }

  const catalogModel: KiroCatalogModelDefinition = {
    id,
    name,
    serviceModelId: record.serviceModelId ?? record.modelId ?? id,
    family: record.family ?? deriveModelFamily(id),
    reasoning: record.reasoning ?? record.supportsReasoning ?? record.reasoningSupported,
    thinkingLevelMap: record.thinkingLevelMap,
    inputModalities,
    contextWindow: record.contextWindow
      ?? record.context_window
      ?? record.maxInputTokens
      ?? record.tokenLimits?.maxInputTokens
      ?? record.limit?.context,
    maxTokens: record.maxTokens
      ?? record.max_tokens
      ?? record.maxOutputTokens
      ?? record.max_output_tokens
      ?? record.tokenLimits?.maxOutputTokens
      ?? record.limit?.output,
    notes: record.notes ?? record.description,
  };

  return normalizeKiroCatalogModel(catalogModel, "discovered");
}

function deriveModelFamily(modelId: string): string | undefined {
  if (modelId.startsWith("claude-")) return "claude";
  if (modelId.startsWith("gpt-")) return "openai";
  if (modelId.startsWith("deepseek-")) return "deepseek";
  if (modelId.startsWith("minimax-")) return "minimax";
  if (modelId.startsWith("glm-")) return "glm";
  if (modelId.startsWith("qwen")) return "qwen";
  return undefined;
}

function readSupportedInputTypes(value: unknown): KiroInputModality[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const mapped = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.toLowerCase())
    .filter((item): item is KiroInputModality => item === "text" || item === "image");
  return mapped.length > 0 ? mapped : undefined;
}

function extractSingleModelRecord(item: Record<string, unknown>): KiroDiscoveredModelRecord {
  const tokenLimits = isRecord(item.tokenLimits) ? item.tokenLimits : undefined;

  return {
    id: readString(item.id) ?? readString(item.modelId),
    slug: readString(item.slug),
    name: readString(item.name) ?? readString(item.modelName),
    displayName: readString(item.displayName) ?? readString(item.modelName),
    modelName: readString(item.modelName),
    serviceModelId: readString(item.serviceModelId) ?? readString(item.modelId),
    modelId: readString(item.modelId),
    family: readString(item.family),
    reasoning: readBoolean(item.reasoning),
    supportsReasoning: readBoolean(item.supportsReasoning),
    thinkingLevelMap: isRecord(item.thinkingLevelMap)
      ? {
          minimal: readString(item.thinkingLevelMap.minimal),
          low: readString(item.thinkingLevelMap.low),
          medium: readString(item.thinkingLevelMap.medium),
          high: readString(item.thinkingLevelMap.high),
          xhigh: readString(item.thinkingLevelMap.xhigh),
        }
      : undefined,
    reasoningSupported: readBoolean(item.reasoningSupported),
    supportsPromptCache: readBoolean(item.supportsPromptCache),
    inputModalities: readInputModalities(item.inputModalities)
      ?? readSupportedInputTypes(item.supportedInputTypes),
    supportedInputTypes: Array.isArray(item.supportedInputTypes)
      ? item.supportedInputTypes.filter((v): v is string => typeof v === "string")
      : undefined,
    modalities: isRecord(item.modalities)
      ? { input: readInputModalities(item.modalities.input) }
      : undefined,
    contextWindow: readNumber(item.contextWindow)
      ?? readNumber(item.context_window)
      ?? readNumber(tokenLimits?.maxInputTokens),
    context_window: readNumber(item.context_window),
    maxTokens: readNumber(item.maxTokens)
      ?? readNumber(item.max_tokens)
      ?? readNumber(item.maxOutputTokens)
      ?? readNumber(item.max_output_tokens)
      ?? readNumber(tokenLimits?.maxOutputTokens),
    max_tokens: readNumber(item.max_tokens),
    maxOutputTokens: readNumber(item.maxOutputTokens) ?? readNumber(tokenLimits?.maxOutputTokens),
    max_output_tokens: readNumber(item.max_output_tokens),
    maxInputTokens: readNumber(item.maxInputTokens) ?? readNumber(tokenLimits?.maxInputTokens),
    tokenLimits: tokenLimits
      ? {
          maxInputTokens: readNumber(tokenLimits.maxInputTokens),
          maxOutputTokens: readNumber(tokenLimits.maxOutputTokens),
        }
      : undefined,
    limit: isRecord(item.limit)
      ? {
          context: readNumber(item.limit.context),
          output: readNumber(item.limit.output),
        }
      : undefined,
    rateMultiplier: typeof item.rateMultiplier === "number" ? item.rateMultiplier : undefined,
    rateUnit: readString(item.rateUnit),
    description: readString(item.description),
    notes: readString(item.notes) ?? readString(item.description),
  };
}

export function extractKiroDiscoveredModelRecords(payload: unknown): KiroDiscoveredModelRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord).map(extractSingleModelRecord);
  }

  if (!isRecord(payload)) {
    return [];
  }

  // Handle ListAvailableModels response which has { models: [...], defaultModel: {...} }
  const candidateKeys = ["models", "items", "data", "modelCatalog", "catalog"] as const;
  for (const key of candidateKeys) {
    const candidate = payload[key];
    const extracted = extractKiroDiscoveredModelRecords(candidate);
    if (extracted.length > 0) {
      // If there's a defaultModel at the top level and it's not already in the list, prepend it
      if (key === "models" && isRecord(payload.defaultModel)) {
        const defaultRecord = extractSingleModelRecord(payload.defaultModel as Record<string, unknown>);
        const defaultId = defaultRecord.id ?? defaultRecord.modelId;
        if (defaultId && !extracted.some((r) => (r.id ?? r.modelId) === defaultId)) {
          extracted.unshift(defaultRecord);
        }
      }
      return extracted;
    }
  }

  return [];
}

export function buildKiroListModelsUrl(credentials: Pick<KiroOAuthCredentials, "region" | "profileArn">): string {
  const url = new URL(`https://codewhisperer.${credentials.region}.amazonaws.com/`);
  url.searchParams.set("origin", KIRO_LIST_MODELS_ORIGIN);
  if (credentials.profileArn) {
    url.searchParams.set("profileArn", credentials.profileArn);
  }
  return url.toString();
}

/** @deprecated Use buildKiroListModelsUrl instead. Kept for backward compatibility in tests. */
export function buildKiroDiscoveryUrls(credentials: Pick<KiroOAuthCredentials, "region" | "profileArn">): string[] {
  return [buildKiroListModelsUrl(credentials)];
}

export function mergeKiroNormalizedModels(
  fallbackModels: readonly KiroNormalizedModelDefinition[],
  discoveredModels: readonly KiroNormalizedModelDefinition[],
): KiroNormalizedModelDefinition[] {
  const merged = new Map<string, KiroNormalizedModelDefinition>();

  for (const model of fallbackModels) {
    merged.set(model.id, model);
  }

  for (const model of discoveredModels) {
    merged.set(model.id, model);
  }

  return [...merged.values()];
}

export function mergeKiroProviderModels(
  fallbackModels: readonly KiroProviderModelConfig[],
  discoveredModels: readonly KiroProviderModelConfig[],
): KiroProviderModelConfig[] {
  const merged = new Map<string, KiroProviderModelConfig>();

  for (const model of fallbackModels) {
    merged.set(model.id, {
      ...model,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      input: [...model.input],
      cost: { ...model.cost },
    });
  }

  for (const model of discoveredModels) {
    merged.set(model.id, {
      ...model,
      ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
      input: [...model.input],
      cost: { ...model.cost },
    });
  }

  return [...merged.values()];
}

export async function discoverKiroModels(
  credentials: Pick<KiroOAuthCredentials, "access" | "region" | "profileArn">,
  dependencies: KiroModelDiscoveryDependencies = {},
): Promise<KiroNormalizedModelDefinition[]> {
  const fetchImplementation = getFetchImplementation(dependencies);
  const url = buildKiroListModelsUrl(credentials);
  const allRecords: KiroDiscoveredModelRecord[] = [];
  let nextToken: string | undefined;

  do {
    const body: Record<string, unknown> = {};
    if (nextToken) {
      body.nextToken = nextToken;
    }

    const response = await fetchImplementation(url, {
      method: "POST",
      headers: {
        "Content-Type": KIRO_LIST_MODELS_CONTENT_TYPE,
        "X-Amz-Target": KIRO_LIST_MODELS_TARGET,
        Authorization: `Bearer ${credentials.access}`,
        Accept: "application/json",
        "amz-sdk-request": "attempt=1; max=3",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ListAvailableModels failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as unknown;
    const records = extractKiroDiscoveredModelRecords(payload);
    allRecords.push(...records);

    nextToken = isRecord(payload) && typeof payload.nextToken === "string" ? payload.nextToken : undefined;
  } while (nextToken);

  if (allRecords.length === 0) {
    throw new Error("ListAvailableModels response did not contain any model records.");
  }

  return allRecords.map(normalizeDiscoveredKiroModel);
}

export async function discoverAndMergeKiroProviderModels(
  credentials: Pick<KiroOAuthCredentials, "access" | "region" | "profileArn"> | undefined,
  dependencies: KiroModelDiscoveryDependencies = {},
): Promise<KiroProviderModelConfig[]> {
  const fallbackModels = KIRO_FALLBACK_PROVIDER_MODELS;

  if (!credentials) {
    return fallbackModels.map((model) => ({
      ...model,
      input: [...model.input],
      cost: { ...model.cost },
    }));
  }

  try {
    const discovered = await discoverKiroModels(credentials, dependencies);
    return mergeKiroProviderModels(fallbackModels, discovered.map(toKiroProviderModelConfig));
  } catch (error) {
    await logKiroError(dependencies, "model_discovery_error", error, {
      region: credentials.region,
      discoveryUrl: buildKiroListModelsUrl(credentials),
    });

    return fallbackModels.map((model) => ({
      ...model,
      input: [...model.input],
      cost: { ...model.cost },
    }));
  }
}

export const KIRO_FALLBACK_MODELS = normalizeKiroCatalog(KIRO_FALLBACK_MODEL_CATALOG);
export const KIRO_FALLBACK_PROVIDER_MODELS = KIRO_FALLBACK_MODELS.map(toKiroProviderModelConfig);
