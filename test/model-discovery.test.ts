import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import kiroExtension from "../extensions/kiro/index";
import {
  KIRO_FALLBACK_PROVIDER_MODELS,
  discoverAndMergeKiroProviderModels,
  discoverKiroModels,
  mergeKiroProviderModels,
  toKiroProviderModelConfig,
} from "../extensions/kiro/models";
import { KIRO_PROVIDER_NAME, type KiroOAuthCredentials } from "../extensions/kiro/types";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function createFetchMock(responses: Array<Response | Error>) {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }

    if (response instanceof Error) {
      throw response;
    }

    return response;
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
}

const credentials: KiroOAuthCredentials = {
  refresh: "refresh-token",
  access: "access-token",
  expires: 1,
  authMode: "builder-id",
  region: "us-east-1",
  oidcRegion: "us-east-1",
  clientId: "client-id",
  clientSecret: "client-secret",
};

describe("kiro model discovery", () => {
  it("successful discovery returns normalized live models", async () => {
    const fetchMock = createFetchMock([
      jsonResponse({
        models: [
          {
            id: "claude-sonnet-4",
            displayName: "Claude Sonnet 4 (Live)",
            reasoningSupported: true,
            inputModalities: ["text", "image"],
            contextWindow: 300000,
            maxOutputTokens: 48000,
          },
          {
            slug: "qwen3-coder-next",
            name: "Qwen3 Coder Next (Live)",
            supportsReasoning: false,
            modalities: { input: ["text"] },
            context_window: 512000,
            max_tokens: 32000,
          },
        ],
      }),
    ]);

    const discovered = await discoverKiroModels(credentials, {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(discovered.map((model) => ({
      id: model.id,
      name: model.name,
      source: model.source,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))).toEqual([
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4 (Live)",
        source: "discovered",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 300000,
        maxTokens: 48000,
      },
      {
        id: "qwen3-coder-next",
        name: "Qwen3 Coder Next (Live)",
        source: "discovered",
        reasoning: false,
        input: ["text"],
        contextWindow: 512000,
        maxTokens: 32000,
      },
    ]);
  });

  it("discovery failure falls back cleanly", async () => {
    const fetchMock = createFetchMock([
      new Error("network down"),
      jsonResponse({ message: "not found" }, { status: 404 }),
      jsonResponse({ catalog: [] }),
    ]);

    const models = await discoverAndMergeKiroProviderModels(credentials, {
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(models).toEqual(KIRO_FALLBACK_PROVIDER_MODELS);
  });

  it("duplicate ids prefer live data", () => {
    const merged = mergeKiroProviderModels(KIRO_FALLBACK_PROVIDER_MODELS, [
      toKiroProviderModelConfig({
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4 (Live)",
        source: "discovered",
        serviceModelId: "claude-sonnet-4",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 123456,
        maxTokens: 7890,
      }),
    ]);

    expect(merged.find((model) => model.id === "claude-sonnet-4")).toEqual({
      id: "claude-sonnet-4",
      name: "Claude Sonnet 4 (Live)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 123456,
      maxTokens: 7890,
    });
  });

  it("provider update path uses merged models on session start when stored credentials exist", async () => {
    const registerProvider = vi.fn();
    const handlers = new Map<string, (event: unknown) => Promise<void>>();
    const pi = {
      registerProvider,
      on: vi.fn((event: string, handler: (event: unknown) => Promise<void>) => {
        handlers.set(event, handler);
      }),
    } as Pick<ExtensionAPI, "registerProvider" | "on"> as ExtensionAPI;

    const fetchMock = createFetchMock([
      jsonResponse({
        models: [
          {
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4 (Live)",
            reasoning: true,
            inputModalities: ["text", "image"],
            contextWindow: 250000,
            maxTokens: 48000,
          },
          {
            id: "brand-new-model",
            name: "Brand New Model",
            reasoning: false,
            inputModalities: ["text"],
            contextWindow: 64000,
            maxTokens: 8000,
          },
        ],
      }),
    ]);

    kiroExtension(pi, {
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          [KIRO_PROVIDER_NAME]: {
            type: "oauth",
            ...credentials,
          },
        }),
    });

    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider.mock.calls[0]?.[1]?.models).toEqual(KIRO_FALLBACK_PROVIDER_MODELS);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeDefined();
    await sessionStart?.({ reason: "startup" });

    expect(registerProvider).toHaveBeenCalledTimes(2);
    const updatedConfig = registerProvider.mock.calls[1]?.[1] as { models: Array<{ id: string; name: string }> };
    expect(updatedConfig.models.find((model) => model.id === "claude-sonnet-4")?.name).toBe(
      "Claude Sonnet 4 (Live)",
    );
    expect(updatedConfig.models.some((model) => model.id === "brand-new-model")).toBe(true);
  });
});
