import { describe, expect, it } from "vitest";

import {
  KIRO_BUILDER_ID_START_URL,
  KIRO_DEVICE_CODE_GRANT_TYPE,
  KIRO_OIDC_SCOPES,
  KIRO_PKCE_CHALLENGE_METHOD,
  KIRO_REFRESH_TOKEN_GRANT_TYPE,
  buildDeviceAuthorizationRequestBody,
  buildIdentityCenterDeviceUrl,
  buildOidcClientRegistrationRequestBody,
  buildPkceCodeChallenge,
  buildPkceCodeVerifier,
  buildPkcePair,
  buildRefreshTokenRequestBody,
  buildTokenPollingRequestBody,
  normalizeKiroAuthConfig,
  normalizeKiroRegion,
  normalizeKiroStartUrl,
  safeParseAwsTokenResponse,
} from "../extensions/kiro/auth";
import { KIRO_AUTH_MODES } from "../extensions/kiro/types";

describe("kiro auth helpers", () => {
  it("normalizes regions and falls back to us-east-1", () => {
    expect(normalizeKiroRegion("  EU-WEST-1 ")).toBe("eu-west-1");
    expect(normalizeKiroRegion("not-a-region")).toBe("us-east-1");
    expect(normalizeKiroRegion(undefined)).toBe("us-east-1");
  });

  it("normalizes common portal URLs to the /start form", () => {
    expect(normalizeKiroStartUrl("https://example.awsapps.com")).toBe("https://example.awsapps.com/start");
    expect(normalizeKiroStartUrl("https://example.awsapps.com/start/")).toBe(
      "https://example.awsapps.com/start",
    );
    expect(normalizeKiroStartUrl("example.awsapps.com/some/deep/link?foo=bar#/whatever")).toBe(
      "https://example.awsapps.com/start",
    );
  });

  it("treats builder id as the default auth mode and does not require a Start URL", () => {
    expect(normalizeKiroAuthConfig({})).toEqual({
      authMode: KIRO_AUTH_MODES.BUILDER_ID,
      region: "us-east-1",
      oidcRegion: "us-east-1",
      authorizationStartUrl: KIRO_BUILDER_ID_START_URL,
    });

    expect(
      buildDeviceAuthorizationRequestBody({
        authMode: KIRO_AUTH_MODES.BUILDER_ID,
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      startUrl: KIRO_BUILDER_ID_START_URL,
    });
  });

  it("requires and normalizes a Start URL for identity center mode", () => {
    expect(() =>
      normalizeKiroAuthConfig({
        authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      }),
    ).toThrow("Start URL is required for IAM Identity Center authentication.");

    expect(
      normalizeKiroAuthConfig({
        authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
        startUrl: "https://acme.awsapps.com/start/#/login",
        oidcRegion: "us-west-2",
        region: "eu-central-1",
      }),
    ).toEqual({
      authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
      startUrl: "https://acme.awsapps.com/start",
      oidcRegion: "us-west-2",
      region: "eu-central-1",
      authorizationStartUrl: "https://acme.awsapps.com/start",
    });
  });

  it("builds the IAM Identity Center device URL with the correct fragment", () => {
    expect(buildIdentityCenterDeviceUrl("https://acme.awsapps.com/start", "WXYZ-1234")).toBe(
      "https://acme.awsapps.com/start/#/device?user_code=WXYZ-1234",
    );
  });

  it("builds the expected AWS OIDC request payloads", () => {
    expect(buildOidcClientRegistrationRequestBody()).toEqual({
      clientName: "Kiro IDE",
      clientType: "public",
      scopes: [...KIRO_OIDC_SCOPES],
      grantTypes: [KIRO_DEVICE_CODE_GRANT_TYPE, KIRO_REFRESH_TOKEN_GRANT_TYPE],
    });

    expect(
      buildDeviceAuthorizationRequestBody({
        authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
        startUrl: "acme.awsapps.com",
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      startUrl: "https://acme.awsapps.com/start",
    });

    expect(
      buildTokenPollingRequestBody({
        clientId: "client-id",
        clientSecret: "client-secret",
        deviceCode: "device-code",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      deviceCode: "device-code",
      grantType: KIRO_DEVICE_CODE_GRANT_TYPE,
    });

    expect(
      buildRefreshTokenRequestBody({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      }),
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      grantType: KIRO_REFRESH_TOKEN_GRANT_TYPE,
    });
  });

  it("derives deterministic PKCE values from caller-provided input", () => {
    const verifier = buildPkceCodeVerifier(new Uint8Array(32).fill(7));

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(buildPkceCodeChallenge(verifier)).toHaveLength(43);
    expect(buildPkcePair(verifier)).toEqual({
      codeVerifier: verifier,
      codeChallenge: buildPkceCodeChallenge(verifier),
      codeChallengeMethod: KIRO_PKCE_CHALLENGE_METHOD,
    });
  });

  it("safely parses success and error AWS token responses", () => {
    expect(
      safeParseAwsTokenResponse(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
    ).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 3600,
      tokenType: "Bearer",
      idToken: undefined,
      scope: undefined,
      error: undefined,
      errorDescription: undefined,
      raw: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      },
    });

    expect(
      safeParseAwsTokenResponse({
        error: "authorization_pending",
        errorDescription: "Still waiting",
      }),
    ).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      expiresIn: undefined,
      tokenType: undefined,
      idToken: undefined,
      scope: undefined,
      error: "authorization_pending",
      errorDescription: "Still waiting",
      raw: {
        error: "authorization_pending",
        errorDescription: "Still waiting",
      },
    });
  });

  it("does not throw on invalid token response payloads", () => {
    expect(safeParseAwsTokenResponse("not-json")).toEqual({
      error: "invalid_response",
      errorDescription: "AWS token response was not valid JSON.",
      raw: {},
    });
  });
});
