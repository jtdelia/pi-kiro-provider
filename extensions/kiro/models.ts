import { KIRO_FALLBACK_MODEL_CATALOG } from "./fallback-models";
import { logKiroError, type KiroLoggingDependencies } from "./logging";
import type { KiroOAuthCredentials } from "./types";
import type {
  KiroCatalogModelDefinition,
  KiroInputModality,
  KiroModelCost,
  KiroNormalizedModelDefinition,
  KiroProviderModelConfig,
} from "./types";

const KIRO_ZERO_COST: Readonly<KiroModelCost> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const KIRO_DISCOVERY_ENDPOINT_PATHS = [
  "/models",
  "/listModels",
  "/model-catalog",
] as const;

export interface KiroModelDiscoveryDependencies extends KiroLoggingDependencies {
  fetch?: typeof fetch;
}

export interface KiroDiscoveredModelRecord {
  id?: string;
  slug?: string;
  name?: string;
  displayName?: string;
  serviceModelId?: string;
  modelId?: string;
  family?: string;
  reasoning?: boolean;
  supportsReasoning?: boolean;
  reasoningSupported?: boolean;
  inputModalities?: readonly KiroInputModality[];
  modalities?: {
    input?: readonly KiroInputModality[];
  };
  contextWindow?: number;
  context_window?: number;
  maxTokens?: number;
  max_tokens?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  limit?: {
    context?: number;
    output?: number;
  };
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
  const name = record.name ?? record.displayName ?? id;

  if (!id || !name) {
    throw new Error("Discovered Kiro model is missing an id or name.");
  }

  const catalogModel: KiroCatalogModelDefinition = {
    id,
    name,
    serviceModelId: record.serviceModelId ?? record.modelId ?? id,
    family: record.family,
    reasoning: record.reasoning ?? record.supportsReasoning ?? record.reasoningSupported,
    inputModalities: record.inputModalities ?? record.modalities?.input,
    contextWindow: record.contextWindow ?? record.context_window ?? record.limit?.context,
    maxTokens: record.maxTokens ?? record.max_tokens ?? record.maxOutputTokens ?? record.max_output_tokens ?? record.limit?.output,
    notes: record.notes,
  };

  return normalizeKiroCatalogModel(catalogModel, "discovered");
}

export function extractKiroDiscoveredModelRecords(payload: unknown): KiroDiscoveredModelRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord).map((item) => ({
      id: readString(item.id),
      slug: readString(item.slug),
      name: readString(item.name),
      displayName: readString(item.displayName),
      serviceModelId: readString(item.serviceModelId),
      modelId: readString(item.modelId),
      family: readString(item.family),
      reasoning: readBoolean(item.reasoning),
      supportsReasoning: readBoolean(item.supportsReasoning),
      reasoningSupported: readBoolean(item.reasoningSupported),
      inputModalities: readInputModalities(item.inputModalities),
      modalities: isRecord(item.modalities)
        ? { input: readInputModalities(item.modalities.input) }
        : undefined,
      contextWindow: readNumber(item.contextWindow),
      context_window: readNumber(item.context_window),
      maxTokens: readNumber(item.maxTokens),
      max_tokens: readNumber(item.max_tokens),
      maxOutputTokens: readNumber(item.maxOutputTokens),
      max_output_tokens: readNumber(item.max_output_tokens),
      limit: isRecord(item.limit)
        ? {
            context: readNumber(item.limit.context),
            output: readNumber(item.limit.output),
          }
        : undefined,
      notes: readString(item.notes),
    }));
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidateKeys = ["models", "items", "data", "modelCatalog", "catalog"] as const;
  for (const key of candidateKeys) {
    const candidate = payload[key];
    const extracted = extractKiroDiscoveredModelRecords(candidate);
    if (extracted.length > 0) {
      return extracted;
    }
  }

  return [];
}

export function buildKiroDiscoveryUrls(credentials: Pick<KiroOAuthCredentials, "region" | "profileArn">): string[] {
  return KIRO_DISCOVERY_ENDPOINT_PATHS.map((path) => {
    const url = new URL(`https://q.${credentials.region}.amazonaws.com${path}`);
    url.searchParams.set("origin", "AI_EDITOR");
    if (credentials.profileArn) {
      url.searchParams.set("profileArn", credentials.profileArn);
    }
    return url.toString();
  });
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
      input: [...model.input],
      cost: { ...model.cost },
    });
  }

  for (const model of discoveredModels) {
    merged.set(model.id, {
      ...model,
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
  const discoveryUrls = buildKiroDiscoveryUrls(credentials);
  let lastError: Error | undefined;

  for (const url of discoveryUrls) {
    try {
      const response = await fetchImplementation(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credentials.access}`,
          "Content-Type": "application/json",
          "x-amzn-kiro-agent-mode": "vibe",
          "amz-sdk-request": "attempt=1; max=1",
        },
      });

      if (!response.ok) {
        lastError = new Error(`Model discovery failed with HTTP ${response.status}.`);
        continue;
      }

      const payload = (await response.json()) as unknown;
      const records = extractKiroDiscoveredModelRecords(payload);
      if (records.length === 0) {
        lastError = new Error("Model discovery response did not contain any model records.");
        continue;
      }

      return records.map(normalizeDiscoveredKiroModel);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Kiro model discovery failed.");
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
      discoveryUrls: buildKiroDiscoveryUrls(credentials).map((url) => {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      }),
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
