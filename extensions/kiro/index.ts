import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderConfig,
} from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type OAuthCredentials,
  type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

import { createKiroOAuthProviderConfig, type KiroLoginDependencies } from "./auth";
import { logKiroError, logKiroInfo } from "./logging";
import { discoverAndMergeKiroProviderModels, getKiroInitialProviderModels } from "./models";
import {
  adaptPiContextToKiroRequest,
  buildKiroHttpErrorMessage,
  buildKiroTransportRequest,
} from "./request";
import { createKiroResponseStreamDecoder, createKiroStreamEventAdapter } from "./stream";
import {
  KIRO_CONFIG_FILE_NAME,
  KIRO_CUSTOM_API,
  KIRO_DEFAULT_SERVICE_REGION,
  KIRO_PROFILE_ARN_ENV_VAR,
  KIRO_PROVIDER_NAME,
  applyKiroProfileArnOverride,
  buildKiroMissingProfileArnErrorMessage,
  looksLikeKiroMissingProfileArnError,
  parseKiroRuntimeConfigFile,
  type KiroOAuthCredentials,
  type KiroRuntimeConfig,
} from "./types";

export interface KiroExtensionDependencies extends KiroLoginDependencies {
  authPath?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  readAuthFile?: (path: string) => Promise<string>;
  readConfigFile?: (path: string) => Promise<string>;
  runtimeConfig?: KiroRuntimeConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const haystack = `${error.name} ${error.message}`.toLowerCase();
  return haystack.includes("enoent") || haystack.includes("no such file") || haystack.includes("not found");
}

export function getDefaultKiroConfigPath(): string {
  return join(getAgentDir(), KIRO_CONFIG_FILE_NAME);
}

export async function loadKiroRuntimeConfig(
  dependencies: Pick<
    KiroExtensionDependencies,
    "configPath" | "env" | "readConfigFile" | "runtimeConfig"
  > = {},
): Promise<KiroRuntimeConfig> {
  if (dependencies.runtimeConfig) {
    return {
      ...dependencies.runtimeConfig,
      profileArn: dependencies.runtimeConfig.profileArn?.trim() || undefined,
      configPath: dependencies.runtimeConfig.configPath ?? dependencies.configPath ?? getDefaultKiroConfigPath(),
    };
  }

  const configPath = dependencies.configPath ?? getDefaultKiroConfigPath();
  const env = dependencies.env ?? process.env;
  const envProfileArn = env[KIRO_PROFILE_ARN_ENV_VAR]?.trim();
  if (envProfileArn) {
    return {
      profileArn: envProfileArn,
      source: "environment",
      configPath,
    };
  }

  const readConfigFile = dependencies.readConfigFile ?? (async (path: string) => readFile(path, "utf8"));
  let content: string;

  try {
    content = await readConfigFile(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { configPath };
    }

    throw new Error(
      `Could not read Kiro config file at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const config = parseKiroRuntimeConfigFile(content);
    return {
      profileArn: config.profileArn,
      source: config.profileArn ? "config-file" : undefined,
      configPath,
    };
  } catch (error) {
    throw new Error(
      `Kiro config file at ${configPath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toStoredKiroOAuthCredentials(value: unknown): KiroOAuthCredentials | undefined {
  if (!isRecord(value) || value.type !== "oauth") {
    return undefined;
  }

  const access = typeof value.access === "string" ? value.access : undefined;
  const refresh = typeof value.refresh === "string" ? value.refresh : undefined;
  const expires = typeof value.expires === "number" ? value.expires : undefined;
  const region = typeof value.region === "string" ? value.region : undefined;

  if (!access || !refresh || !expires || !region) {
    return undefined;
  }

  return value as KiroOAuthCredentials;
}

export async function loadStoredKiroCredentials(
  dependencies: Pick<
    KiroExtensionDependencies,
    "authPath" | "configPath" | "env" | "readAuthFile" | "readConfigFile" | "runtimeConfig"
  > = {},
): Promise<KiroOAuthCredentials | undefined> {
  const authPath = dependencies.authPath ?? join(getAgentDir(), "auth.json");
  const readAuthFile = dependencies.readAuthFile ?? (async (path: string) => readFile(path, "utf8"));
  const runtimeConfig = await loadKiroRuntimeConfig(dependencies);

  try {
    const content = await readAuthFile(authPath);
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const storedCredentials = toStoredKiroOAuthCredentials(parsed[KIRO_PROVIDER_NAME]);
    return storedCredentials ? applyKiroProfileArnOverride(storedCredentials, runtimeConfig.profileArn) : undefined;
  } catch {
    return undefined;
  }
}

function getFetchImplementation(dependencies: KiroExtensionDependencies): typeof fetch {
  if (dependencies.fetch) {
    return dependencies.fetch;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  return globalThis.fetch.bind(globalThis);
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function resolveKiroStreamCredentials(
  dependencies: KiroExtensionDependencies,
  options?: SimpleStreamOptions,
): Promise<Pick<KiroOAuthCredentials, "access" | "region" | "profileArn"> & {
  authMode?: KiroOAuthCredentials["authMode"];
  configPath?: string;
}> {
  const runtimeConfig = await loadKiroRuntimeConfig(dependencies);
  const storedCredentials = await loadStoredKiroCredentials({
    ...dependencies,
    runtimeConfig,
  });

  if (storedCredentials) {
    return {
      access: options?.apiKey ?? storedCredentials.access,
      authMode: storedCredentials.authMode,
      region: storedCredentials.region,
      profileArn: storedCredentials.profileArn,
      configPath: runtimeConfig.configPath,
    };
  }

  if (options?.apiKey) {
    return {
      access: options.apiKey,
      authMode: undefined,
      region: KIRO_DEFAULT_SERVICE_REGION,
      profileArn: runtimeConfig.profileArn,
      configPath: runtimeConfig.configPath,
    };
  }

  throw new Error("No stored Kiro credentials found. Run /login again.");
}

export function createKiroStreamSimple(dependencies: KiroExtensionDependencies = {}) {
  return function streamKiro(model: { api: Api; provider: string; id: string; headers?: Record<string, string> }, context: { messages: unknown[]; systemPrompt?: string; tools?: unknown[] }, options?: SimpleStreamOptions) {
    const stream = createAssistantMessageEventStream();

    void (async () => {
      const adapter = createKiroStreamEventAdapter({
        model,
        timestamp: dependencies.now?.() ?? Date.now(),
      });
      const fetchImplementation = getFetchImplementation(dependencies);
      const responseDecoder = createKiroResponseStreamDecoder();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let aborted = false;
      let requestUrl: string | undefined;
      let responseStatus: number | undefined;
      let conversationId: string | undefined;

      try {
        for (const event of adapter.start()) {
          stream.push(event);
        }

        const credentials = await resolveKiroStreamCredentials(dependencies, options);
        conversationId = options?.sessionId ?? randomUUID();
        const preparedRequest = adaptPiContextToKiroRequest({
          modelId: model.id,
          context: context as never,
          credentials,
          reasoning: options?.reasoning,
          conversationId,
        });

        if (
          preparedRequest.diagnostics &&
          (preparedRequest.diagnostics.toolResultTruncationCount > 0 ||
            preparedRequest.diagnostics.currentMessageTruncated ||
            preparedRequest.diagnostics.prunedHistoryMessageCount > 0)
        ) {
          await logKiroInfo(dependencies, "request_budget_applied", "Kiro request budget applied.", {
            modelId: model.id,
            provider: model.provider,
            api: model.api,
            conversationId,
            diagnostics: preparedRequest.diagnostics,
          });
        }

        const nextPayload = await options?.onPayload?.(preparedRequest.payload, model as never);
        const request = buildKiroTransportRequest({
          preparedRequest: {
            ...preparedRequest,
            payload: (nextPayload ?? preparedRequest.payload) as typeof preparedRequest.payload,
          },
          accessToken: credentials.access,
          headers: {
            ...(model.headers ?? {}),
            ...(options?.headers ?? {}),
          },
          signal: options?.signal,
        });

        requestUrl = request.url;

        const response = await fetchImplementation(request.url, request.init);
        responseStatus = response.status;
        await options?.onResponse?.(
          { status: response.status, headers: headersToRecord(response.headers) },
          model as never,
        );

        if (!response.ok) {
          const responseText = await response.text();
          if (
            looksLikeKiroMissingProfileArnError({
              authMode: credentials.authMode,
              profileArn: credentials.profileArn,
              status: response.status,
              detail: responseText,
            })
          ) {
            throw new Error(buildKiroMissingProfileArnErrorMessage(credentials.configPath));
          }

          throw new Error(buildKiroHttpErrorMessage(response, responseText));
        }

        if (!response.body) {
          throw new Error("Kiro response did not include a streaming body.");
        }

        reader = response.body.getReader();
        const onAbort = () => {
          aborted = true;
          void reader?.cancel().catch(() => undefined);
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            if (aborted || options?.signal?.aborted) {
              break;
            }

            for (const rawEvent of responseDecoder.push(value)) {
              for (const event of adapter.pushRawEvent(rawEvent)) {
                stream.push(event);
              }
            }
          }

          for (const rawEvent of responseDecoder.finish()) {
            for (const event of adapter.pushRawEvent(rawEvent)) {
              stream.push(event);
            }
          }
        } finally {
          options?.signal?.removeEventListener("abort", onAbort);
        }

        if (aborted || options?.signal?.aborted) {
          throw new Error("Kiro request aborted.");
        }

        for (const event of adapter.finish()) {
          stream.push(event);
        }
      } catch (error) {
        const reason = aborted || options?.signal?.aborted ? "aborted" : "error";
        const message = error instanceof Error ? error.message : String(error);

        await logKiroError(dependencies, "request_error", error, {
          reason,
          modelId: model.id,
          provider: model.provider,
          api: model.api,
          requestUrl,
          responseStatus,
          conversationId,
        });

        for (const event of adapter.pushRawEvent({ type: reason, message })) {
          stream.push(event);
        }
      } finally {
        stream.end();
      }
    })();

    return stream;
  };
}

export function createKiroProviderConfig(
  dependencies: KiroExtensionDependencies = {},
  models = getKiroInitialProviderModels(),
): ProviderConfig {
  return {
    baseUrl: `https://q.${KIRO_DEFAULT_SERVICE_REGION}.amazonaws.com`,
    api: KIRO_CUSTOM_API,
    models,
    oauth: createKiroOAuthProviderConfig({
      ...dependencies,
      resolveRuntimeConfig: () => loadKiroRuntimeConfig(dependencies),
    }),
    streamSimple: createKiroStreamSimple(dependencies),
  };
}

export default function kiroExtension(pi: ExtensionAPI, dependencies: KiroExtensionDependencies = {}): void {
  const registerProviderWithModels = (models = getKiroInitialProviderModels()): void => {
    pi.registerProvider(
      KIRO_PROVIDER_NAME,
      createKiroProviderConfig(
        {
          ...dependencies,
          onCredentialsUpdated: updateProviderModelsForCredentials,
        },
        models,
      ),
    );
  };

  const updateProviderModelsForCredentials = async (
    credentials: Pick<KiroOAuthCredentials, "access" | "region" | "profileArn">,
  ): Promise<void> => {
    const models = await discoverAndMergeKiroProviderModels(credentials, dependencies);
    registerProviderWithModels(models);
  };

  registerProviderWithModels();

  pi.on("session_start", async () => {
    try {
      const storedCredentials = await loadStoredKiroCredentials(dependencies);
      if (!storedCredentials) {
        return;
      }

      await updateProviderModelsForCredentials(storedCredentials);
    } catch (error) {
      await logKiroError(dependencies, "session_start_error", error);
    }
  });
}

export function getKiroApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}
