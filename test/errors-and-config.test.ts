import { describe, expect, it, vi } from "vitest";

import { createKiroLogin } from "../extensions/kiro/auth";
import { createKiroProviderConfig, loadKiroRuntimeConfig } from "../extensions/kiro/index";
import { createKiroRefreshToken } from "../extensions/kiro/refresh";
import {
  KIRO_AUTH_MODES,
  KIRO_CUSTOM_API,
  KIRO_PROFILE_ARN_ENV_VAR,
  KIRO_PROVIDER_NAME,
  type KiroOAuthCredentials,
} from "../extensions/kiro/types";

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

const identityCenterCredentials: KiroOAuthCredentials = {
  refresh: "refresh-token",
  access: "access-token",
  expires: 1,
  authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
  region: "us-east-1",
  oidcRegion: "us-east-1",
  startUrl: "https://acme.awsapps.com/start",
  clientId: "client-id",
  clientSecret: "client-secret",
};

describe("kiro enterprise config and errors", () => {
  it("loads profileArn from the documented config file shape", async () => {
    const config = await loadKiroRuntimeConfig({
      env: {},
      configPath: "/tmp/kiro.json",
      readConfigFile: async () =>
        JSON.stringify({
          profileArn: " arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1 ",
        }),
    });

    expect(config).toEqual({
      profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1",
      source: "config-file",
      configPath: "/tmp/kiro.json",
    });
  });

  it("prefers the environment variable over the config file", async () => {
    const config = await loadKiroRuntimeConfig({
      env: {
        [KIRO_PROFILE_ARN_ENV_VAR]: "arn:aws:codewhisperer:us-west-2:123456789012:profile/from-env",
      },
      configPath: "/tmp/kiro.json",
      readConfigFile: async () => JSON.stringify({ profileArn: "arn:aws:codewhisperer:us-east-1:123:profile/from-file" }),
    });

    expect(config).toEqual({
      profileArn: "arn:aws:codewhisperer:us-west-2:123456789012:profile/from-env",
      source: "environment",
      configPath: "/tmp/kiro.json",
    });
  });

  it("surfaces a clear, actionable error when an enterprise request appears to require profileArn", async () => {
    const provider = createKiroProviderConfig({
      env: {},
      configPath: "/Users/test/.pi/agent/kiro.json",
      readConfigFile: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
      readAuthFile: async () =>
        JSON.stringify({
          [KIRO_PROVIDER_NAME]: {
            type: "oauth",
            ...identityCenterCredentials,
          },
        }),
      fetch: createFetchMock([
        new Response(
          "AccessDeniedException: User is not authorized to access Q Developer without profileArn",
          { status: 403 },
        ),
      ]) as unknown as typeof fetch,
    });

    const stream = provider.streamSimple?.(
      {
        id: "claude-sonnet-4",
        api: KIRO_CUSTOM_API,
        provider: KIRO_PROVIDER_NAME,
      } as never,
      {
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: 1,
          },
        ],
      } as never,
    );

    const events: Array<{ type: string; error?: { errorMessage?: string } }> = [];
    for await (const event of stream ?? []) {
      events.push(event as { type: string; error?: { errorMessage?: string } });
    }

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events[1]?.error?.errorMessage).toContain("appears to require profileArn");
    expect(events[1]?.error?.errorMessage).toContain(KIRO_PROFILE_ARN_ENV_VAR);
    expect(events[1]?.error?.errorMessage).toContain("/Users/test/.pi/agent/kiro.json");
    expect(events[1]?.error?.errorMessage).toContain("run /login again");
  });

  it("keeps auth failures user-readable", async () => {
    const login = createKiroLogin({
      fetch: createFetchMock([new Response("upstream down", { status: 500 })]) as unknown as typeof fetch,
      sleep: vi.fn(async () => undefined),
      now: () => 1_700_000_000_000,
    });

    await expect(
      login({
        onPrompt: vi
          .fn()
          .mockResolvedValueOnce("1")
          .mockResolvedValueOnce("us-east-1"),
        onAuth: vi.fn(),
        onProgress: vi.fn(),
      }),
    ).rejects.toThrow("Kiro sign-in could not register with AWS OIDC");
  });

  it("applies configured profileArn during refresh and keeps refresh errors user-readable", async () => {
    const refreshToken = createKiroRefreshToken({
      resolveRuntimeConfig: async () => ({
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1",
      }),
      fetch: createFetchMock([
        new Response(
          JSON.stringify({
            access_token: "next-access-token",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ]) as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    });

    const refreshed = await refreshToken(identityCenterCredentials);

    expect(refreshed.profileArn).toBe(
      "arn:aws:codewhisperer:us-east-1:123456789012:profile/QDevProfile-us-east-1",
    );

    const failingRefreshToken = createKiroRefreshToken({
      fetch: createFetchMock([
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Refresh token expired",
          }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ]) as unknown as typeof fetch,
    });

    await expect(failingRefreshToken(identityCenterCredentials)).rejects.toThrow(
      "IAM Identity Center refresh token is invalid or expired. Run /login again.",
    );
  });
});
