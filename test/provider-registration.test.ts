import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import kiroExtension, { createKiroProviderConfig } from "../extensions/kiro/index";
import { KIRO_FALLBACK_PROVIDER_MODELS } from "../extensions/kiro/models";
import { KIRO_CUSTOM_API, KIRO_PROVIDER_NAME } from "../extensions/kiro/types";

describe("kiro provider registration", () => {
  it("registers the kiro provider with fallback models, OAuth, and a custom stream handler", () => {
    const registerProvider = vi.fn();
    const on = vi.fn();
    const pi = {
      registerProvider,
      on,
    } as Pick<ExtensionAPI, "registerProvider" | "on"> as ExtensionAPI;

    expect(() => kiroExtension(pi)).not.toThrow();

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerName, config] = registerProvider.mock.calls[0] as [
      string,
      {
        baseUrl: string;
        api: string;
        models: unknown[];
        oauth: { name: string; login: unknown; refreshToken: unknown; getApiKey: unknown };
        streamSimple: unknown;
      },
    ];

    expect(providerName).toBe(KIRO_PROVIDER_NAME);
    expect(config.baseUrl).toBe("https://q.us-east-1.amazonaws.com");
    expect(config.api).toBe(KIRO_CUSTOM_API);
    expect(config.models).toEqual(KIRO_FALLBACK_PROVIDER_MODELS);
    expect(config.oauth).toEqual(
      expect.objectContaining({
        name: "Kiro",
        login: expect.any(Function),
        refreshToken: expect.any(Function),
        getApiKey: expect.any(Function),
      }),
    );
    expect(config.streamSimple).toEqual(expect.any(Function));
  });

  it("creates a valid streamSimple implementation even when credentials are missing", async () => {
    const provider = createKiroProviderConfig({
      readAuthFile: async () => {
        throw new Error("missing auth file");
      },
    });
    expect(provider.streamSimple).toBeDefined();

    const stream = provider.streamSimple?.(
      {
        id: "auto",
        api: KIRO_CUSTOM_API,
        provider: KIRO_PROVIDER_NAME,
      } as never,
      { messages: [] } as never,
    );

    expect(stream).toBeDefined();

    const events = [] as Array<{ type: string; error?: { errorMessage?: string } }>;
    for await (const event of stream ?? []) {
      events.push(event as { type: string; error?: { errorMessage?: string } });
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events[1]?.error?.errorMessage).toContain("Run /login again");
  });
});
