import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { createKiroOAuthProviderConfig } from "../extensions/kiro/auth";
import {
  KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS,
  createKiroRefreshToken,
} from "../extensions/kiro/refresh";
import { KIRO_AUTH_MODES, type KiroOAuthCredentials } from "../extensions/kiro/types";

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

describe("kiro token refresh", () => {
  it("routes Builder ID refresh through the desktop endpoint and preserves metadata", async () => {
    const now = 1_700_000_000_000;
    const fetchMock = createFetchMock([
      jsonResponse({
        accessToken: "builder-access-next",
        refreshToken: "builder-refresh-next",
        expiresIn: 3600,
      }),
    ]);
    const refreshToken = createKiroRefreshToken({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    const credentials: KiroOAuthCredentials = {
      refresh: "builder-refresh-current",
      access: "builder-access-current",
      expires: now - 1,
      authMode: KIRO_AUTH_MODES.BUILDER_ID,
      region: "eu-west-1",
      oidcRegion: "us-east-1",
      clientId: "builder-client-id",
      clientSecret: "builder-client-secret",
      profileArn: "arn:aws:codewhisperer:profile/builder",
    };

    const refreshed = await refreshToken(credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://prod.eu-west-1.auth.desktop.kiro.dev/refreshToken");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      refreshToken: "builder-refresh-current",
    });

    expect(refreshed).toEqual({
      refresh: "builder-refresh-next",
      access: "builder-access-next",
      expires: now + 3_600_000 - KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS,
      authMode: KIRO_AUTH_MODES.BUILDER_ID,
      region: "eu-west-1",
      oidcRegion: "us-east-1",
      startUrl: undefined,
      clientId: "builder-client-id",
      clientSecret: "builder-client-secret",
      profileArn: "arn:aws:codewhisperer:profile/builder",
    });
  });

  it("routes IAM Identity Center refresh through the AWS OIDC endpoint via the OAuth config", async () => {
    const now = 1_700_000_000_000;
    const fetchMock = createFetchMock([
      jsonResponse({
        access_token: "idc-access-next",
        expires_in: 7200,
      }),
    ]);
    const oauth = createKiroOAuthProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      sleep: vi.fn(async () => undefined),
    });
    const credentials: OAuthCredentials = {
      refresh: "idc-refresh-current",
      access: "idc-access-current",
      expires: now - 1,
      authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      region: "us-west-2",
      oidcRegion: "us-east-2",
      startUrl: "https://acme.awsapps.com/start",
      clientId: "idc-client-id",
      clientSecret: "idc-client-secret",
      profileArn: "arn:aws:codewhisperer:profile/idc",
    } as KiroOAuthCredentials;

    const refreshed = await oauth.refreshToken(credentials);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oidc.us-east-2.amazonaws.com/token");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      clientId: "idc-client-id",
      clientSecret: "idc-client-secret",
      refreshToken: "idc-refresh-current",
      grantType: "refresh_token",
    });

    expect(refreshed).toEqual({
      refresh: "idc-refresh-current",
      access: "idc-access-next",
      expires: now + 7_200_000 - KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS,
      authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      region: "us-west-2",
      oidcRegion: "us-east-2",
      startUrl: "https://acme.awsapps.com/start",
      clientId: "idc-client-id",
      clientSecret: "idc-client-secret",
      profileArn: "arn:aws:codewhisperer:profile/idc",
    });
  });

  it("fails clearly when IAM Identity Center credentials are missing client metadata", async () => {
    const refreshToken = createKiroRefreshToken();

    await expect(
      refreshToken({
        refresh: "idc-refresh-current",
        access: "idc-access-current",
        expires: 1,
        authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
        region: "us-west-2",
        oidcRegion: "us-east-2",
        clientId: "",
        clientSecret: "",
      } as KiroOAuthCredentials),
    ).rejects.toThrow("IAM Identity Center refresh requires stored clientId and clientSecret. Run /login again.");
  });

  it("surfaces a clear error when the stored refresh token is invalid", async () => {
    const fetchMock = createFetchMock([
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "Refresh Token has expired",
        },
        { status: 400 },
      ),
    ]);
    const refreshToken = createKiroRefreshToken({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      refreshToken({
        refresh: "builder-refresh-current",
        access: "builder-access-current",
        expires: 1,
        authMode: KIRO_AUTH_MODES.BUILDER_ID,
        region: "us-east-1",
        oidcRegion: "us-east-1",
        clientId: "builder-client-id",
        clientSecret: "builder-client-secret",
      } as KiroOAuthCredentials),
    ).rejects.toThrow("Builder ID refresh token is invalid or expired. Run /login again.");
  });

  it("applies the expiry safety buffer when computing the new expiry", async () => {
    const now = 1_700_000_000_000;
    const fetchMock = createFetchMock([
      jsonResponse({
        access_token: "idc-access-next",
        refresh_token: "idc-refresh-next",
        expires_in: 600,
      }),
    ]);
    const refreshToken = createKiroRefreshToken({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });

    const refreshed = await refreshToken({
      refresh: "idc-refresh-current",
      access: "idc-access-current",
      expires: now - 1,
      authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      region: "us-west-2",
      oidcRegion: "us-east-1",
      startUrl: "https://acme.awsapps.com/start",
      clientId: "idc-client-id",
      clientSecret: "idc-client-secret",
    } as KiroOAuthCredentials);

    expect(refreshed.expires).toBe(now + 600_000 - KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS);
  });

  it("surfaces a clear network error when the refresh request fails before a response arrives", async () => {
    const refreshToken = createKiroRefreshToken({
      fetch: createFetchMock([new Error("socket hang up")]) as unknown as typeof fetch,
    });

    await expect(
      refreshToken({
        refresh: "builder-refresh-current",
        access: "builder-access-current",
        expires: 1,
        authMode: KIRO_AUTH_MODES.BUILDER_ID,
        region: "us-east-1",
        oidcRegion: "us-east-1",
        clientId: "builder-client-id",
        clientSecret: "builder-client-secret",
      } as KiroOAuthCredentials),
    ).rejects.toThrow("Kiro token refresh failed: socket hang up");
  });

  it("sanitizes secrets in refresh failures before surfacing them", async () => {
    const refreshToken = createKiroRefreshToken({
      fetch: createFetchMock([
        jsonResponse(
          {
            message: 'Authorization: Bearer refresh-secret {"access_token":"abc123"}',
          },
          { status: 500 },
        ),
      ]) as unknown as typeof fetch,
    });

    let message = "";
    try {
      await refreshToken({
        refresh: "builder-refresh-current",
        access: "builder-access-current",
        expires: 1,
        authMode: KIRO_AUTH_MODES.BUILDER_ID,
        region: "us-east-1",
        oidcRegion: "us-east-1",
        clientId: "builder-client-id",
        clientSecret: "builder-client-secret",
      } as KiroOAuthCredentials);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("refresh-secret");
    expect(message).not.toContain("abc123");
  });
});
