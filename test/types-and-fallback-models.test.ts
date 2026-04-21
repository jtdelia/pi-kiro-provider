import { describe, expect, it } from "vitest";

import { KIRO_FALLBACK_MODEL_CATALOG } from "../extensions/kiro/fallback-models";
import {
  KIRO_FALLBACK_MODELS,
  KIRO_FALLBACK_PROVIDER_MODELS,
  deriveContextWindow,
  deriveInputModalities,
  deriveMaxTokens,
  deriveReasoningCapability,
  normalizeKiroCatalog,
  toKiroProviderModelConfig,
} from "../extensions/kiro/models";
import {
  KIRO_AUTH_MODES,
  KIRO_DEFAULT_OIDC_REGION,
  KIRO_DEFAULT_SERVICE_REGION,
  KIRO_PROVIDER_NAME,
} from "../extensions/kiro/types";

describe("kiro shared types and fallback models", () => {
  it("defines the core provider constants", () => {
    expect(KIRO_PROVIDER_NAME).toBe("kiro");
    expect(KIRO_DEFAULT_OIDC_REGION).toBe("us-east-1");
    expect(KIRO_DEFAULT_SERVICE_REGION).toBe("us-east-1");
    expect(KIRO_AUTH_MODES.BUILDER_ID).toBe("builder-id");
    expect(KIRO_AUTH_MODES.IDENTITY_CENTER).toBe("identity-center");
  });

  it("ships a non-empty fallback catalog", () => {
    expect(KIRO_FALLBACK_MODEL_CATALOG.length).toBeGreaterThan(0);
    expect(KIRO_FALLBACK_MODELS.length).toBeGreaterThan(0);
    expect(KIRO_FALLBACK_PROVIDER_MODELS.length).toBeGreaterThan(0);
  });

  it("keeps the fallback catalog limited to known-good baseline models", () => {
    const fallbackIds = new Set<string>(KIRO_FALLBACK_MODEL_CATALOG.map((model) => model.id));

    expect(fallbackIds.has("auto")).toBe(true);
    expect(fallbackIds.has("claude-sonnet-4")).toBe(false);
    expect(fallbackIds.has("claude-3-7-sonnet")).toBe(false);
    expect(fallbackIds.has("minimax-m2.5")).toBe(true);
    expect(fallbackIds.has("glm-5")).toBe(true);
    expect(fallbackIds.has("qwen3-coder-next")).toBe(true);

    expect(fallbackIds.has("deepseek-3.2")).toBe(false);
    expect(fallbackIds.has("minimax-m2.1")).toBe(false);
    expect(fallbackIds.has("nova-swe")).toBe(false);
    expect(fallbackIds.has("gpt-oss-120b")).toBe(false);
    expect(fallbackIds.has("kimi-k2-thinking")).toBe(false);
  });

  it("normalizes fallback models without duplicate ids", () => {
    const normalized = normalizeKiroCatalog();
    const ids = normalized.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes at least one reasoning-capable fallback model", () => {
    expect(KIRO_FALLBACK_MODELS.some((model) => model.reasoning)).toBe(true);
  });

  it("returns provider-model-shaped entries for the full fallback list", () => {
    for (const model of KIRO_FALLBACK_MODELS) {
      const providerModel = toKiroProviderModelConfig(model);

      expect(typeof providerModel.id).toBe("string");
      expect(typeof providerModel.name).toBe("string");
      expect(typeof providerModel.reasoning).toBe("boolean");
      expect(providerModel.input.length).toBeGreaterThan(0);
      expect(providerModel.input.every((input) => input === "text" || input === "image")).toBe(true);
      expect(providerModel.contextWindow).toBeGreaterThan(0);
      expect(providerModel.maxTokens).toBeGreaterThan(0);
      expect(providerModel.cost).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
  });

  it("derives reasoning support conservatively", () => {
    expect(
      deriveReasoningCapability({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      }),
    ).toBe(true);

    expect(
      deriveReasoningCapability({
        id: "minimax-m2.5",
        name: "MiniMax 2.5",
      }),
    ).toBe(false);
  });

  it("derives input modalities and token defaults", () => {
    expect(
      deriveInputModalities({
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
      }),
    ).toEqual(["text", "image"]);

    expect(
      deriveInputModalities({
        id: "deepseek-3.2",
        name: "DeepSeek 3.2",
      }),
    ).toEqual(["text"]);

    expect(
      deriveContextWindow({
        id: "claude-sonnet-4-6-1m",
        name: "Claude Sonnet 4.6 (1M Context)",
      }),
    ).toBe(1000000);

    expect(
      deriveContextWindow({
        id: "qwen3-coder-next",
        name: "Qwen3 Coder Next",
      }),
    ).toBe(256000);

    expect(
      deriveMaxTokens({
        id: "some-new-model",
        name: "Some New Model",
      }),
    ).toBe(64000);
  });
});
