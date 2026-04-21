import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { KIRO_BUILDER_ID_START_URL, createKiroLogin, createKiroOAuthProviderConfig } from "../extensions/kiro/auth";
import kiroExtension from "../extensions/kiro/index";
import { KIRO_AUTH_MODES, KIRO_PROVIDER_NAME } from "../extensions/kiro/types";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function createFetchMock(responses: Response[]) {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("Unexpected fetch call");
    }
    return response;
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
}

function createCallbacks(promptResponses: string[]) {
  const prompts: string[] = [];
  const onAuth = vi.fn();
  const onProgress = vi.fn();
  const onPrompt = vi.fn(async (prompt: Parameters<OAuthLoginCallbacks["onPrompt"]>[0]) => {
    prompts.push(prompt.message);
    const response = promptResponses.shift();
    if (response === undefined) {
      throw new Error(`No queued answer for prompt: ${prompt.message}`);
    }
    return response;
  });

  const callbacks: OAuthLoginCallbacks = {
    onAuth,
    onProgress,
    onPrompt,
  };

  return {
    callbacks,
    prompts,
    onAuth,
    onProgress,
    onPrompt,
  };
}

describe("kiro oauth login", () => {
  it("registers the kiro provider with an OAuth config", () => {
    const registerProvider = vi.fn();
    const on = vi.fn();
    const pi = {
      registerProvider,
      on,
    } as Pick<ExtensionAPI, "registerProvider" | "on"> as ExtensionAPI;

    kiroExtension(pi);

    expect(registerProvider).toHaveBeenCalledTimes(1);
    const [providerName, config] = registerProvider.mock.calls[0] as [string, { oauth: { name: string } }];
    expect(providerName).toBe(KIRO_PROVIDER_NAME);
    expect(config.oauth.name).toBe("Kiro");
  });

  it("Builder ID flow prompts only for region and returns the full credential payload", async () => {
    const fetchMock = createFetchMock([
      jsonResponse({ clientId: "builder-client", clientSecret: "builder-secret" }),
      jsonResponse({
        deviceCode: "builder-device-code",
        userCode: "ABCD-1234",
        verificationUri: "https://device.sso.aws.amazon.com/",
        verificationUriComplete: "https://device.sso.aws.amazon.com/?user_code=ABCD-1234",
        interval: 1,
        expiresIn: 600,
      }),
      jsonResponse({ error: "authorization_pending" }, { status: 400 }),
      jsonResponse({
        access_token: "builder-access-token",
        refresh_token: "builder-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    ]);
    const sleep = vi.fn(async () => undefined);
    const now = vi.fn(() => 1_700_000_000_000);
    const login = createKiroLogin({ fetch: fetchMock as unknown as typeof fetch, sleep, now });
    const { callbacks, prompts, onAuth } = createCallbacks(["1", "eu-west-1"]);

    const credentials = await login(callbacks);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.toLowerCase()).toContain("auth mode");
    expect(prompts[1]?.toLowerCase()).toContain("region");
    expect(prompts.join(" ").toLowerCase()).not.toContain("start url");

    expect(onAuth).toHaveBeenCalledWith({
      url: "https://device.sso.aws.amazon.com/?user_code=ABCD-1234",
      instructions:
        "Open https://device.sso.aws.amazon.com/?user_code=ABCD-1234 and complete sign-in. If AWS asks for a code, enter: ABCD-1234",
    });

    expect(credentials).toEqual({
      refresh: "builder-refresh-token",
      access: "builder-access-token",
      expires: 1_700_003_300_000,
      authMode: KIRO_AUTH_MODES.BUILDER_ID,
      region: "eu-west-1",
      oidcRegion: "eu-west-1",
      startUrl: undefined,
      clientId: "builder-client",
      clientSecret: "builder-secret",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oidc.eu-west-1.amazonaws.com/client/register");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://oidc.eu-west-1.amazonaws.com/device_authorization");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      clientId: "builder-client",
      clientSecret: "builder-secret",
      startUrl: KIRO_BUILDER_ID_START_URL,
    });
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it("Identity Center flow prompts for Start URL and region and opens the org-specific device URL", async () => {
    const fetchMock = createFetchMock([
      jsonResponse({ clientId: "idc-client", clientSecret: "idc-secret" }),
      jsonResponse({
        deviceCode: "idc-device-code",
        userCode: "WXYZ-9876",
        verificationUri: "https://device.sso.aws.amazon.com/",
        verificationUriComplete: "https://device.sso.aws.amazon.com/?user_code=WXYZ-9876",
        interval: 2,
        expiresIn: 900,
      }),
      jsonResponse({
        access_token: "idc-access-token",
        refresh_token: "idc-refresh-token",
        expires_in: 7200,
        token_type: "Bearer",
      }),
    ]);
    const login = createKiroLogin({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: vi.fn(async () => undefined),
      now: () => 1_700_000_000_000,
    });
    const { callbacks, prompts, onAuth } = createCallbacks([
      "2",
      "https://acme.awsapps.com/portal/deep/link?foo=bar#/something",
      "us-west-2",
    ]);

    const credentials = await login(callbacks);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]?.toLowerCase()).toContain("start url");
    expect(prompts[2]?.toLowerCase()).toContain("region");

    expect(onAuth).toHaveBeenCalledWith({
      url: "https://acme.awsapps.com/start/#/device?user_code=WXYZ-9876",
      instructions:
        "Open https://acme.awsapps.com/start/#/device?user_code=WXYZ-9876 and complete the IAM Identity Center sign-in flow.",
    });

    expect(credentials).toEqual({
      refresh: "idc-refresh-token",
      access: "idc-access-token",
      expires: 1_700_006_900_000,
      authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      region: "us-west-2",
      oidcRegion: "us-west-2",
      startUrl: "https://acme.awsapps.com/start",
      clientId: "idc-client",
      clientSecret: "idc-secret",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oidc.us-west-2.amazonaws.com/client/register");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://oidc.us-west-2.amazonaws.com/device_authorization");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      clientId: "idc-client",
      clientSecret: "idc-secret",
      startUrl: "https://acme.awsapps.com/start",
    });
  });

  it("surfaces a clear error when the token response is invalid", async () => {
    const fetchMock = createFetchMock([
      jsonResponse({ clientId: "client-id", clientSecret: "client-secret" }),
      jsonResponse({
        deviceCode: "device-code",
        userCode: "ABCD-1234",
        verificationUriComplete: "https://device.sso.aws.amazon.com/?user_code=ABCD-1234",
        interval: 1,
        expiresIn: 600,
      }),
      jsonResponse({ access_token: "missing-refresh-token" }),
    ]);
    const login = createKiroLogin({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: vi.fn(async () => undefined),
      now: () => 1_700_000_000_000,
    });
    const { callbacks } = createCallbacks(["builder-id", "us-east-1"]);

    await expect(login(callbacks)).rejects.toThrow(
      "Token exchange failed: response did not include both access and refresh tokens.",
    );
  });

  it("exposes getApiKey on the OAuth config", () => {
    const oauth = createKiroOAuthProviderConfig();

    expect(oauth.getApiKey({ access: "token", refresh: "refresh", expires: 123 })).toBe("token");
  });
});
