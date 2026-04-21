import type { OAuthCredentials } from "@mariozechner/pi-ai";

import {
  KIRO_AUTH_MODES,
  KIRO_DEFAULT_OIDC_REGION,
  applyKiroProfileArnOverride,
  type KiroAuthMode,
  type KiroOAuthCredentials,
  type KiroRuntimeConfig,
} from "./types";

const KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const KIRO_REFRESH_USER_AGENT = "KiroIDE";
const KIRO_REFRESH_GRANT_TYPE = "refresh_token";

export interface KiroRefreshDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  resolveRuntimeConfig?: () => Promise<KiroRuntimeConfig> | KiroRuntimeConfig;
}

export interface KiroRefreshRequest {
  url: string;
  init: RequestInit;
}

interface ParsedRefreshResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: string;
  errorDescription?: string;
  message?: string;
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function readNumberField(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function requireNonEmptyString(value: string | undefined, fieldName: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeStoredRegion(region?: string): string {
  const normalized = region?.trim().toLowerCase();
  return normalized || KIRO_DEFAULT_OIDC_REGION;
}

function normalizeStoredAuthMode(authMode?: string): KiroAuthMode {
  if (authMode === KIRO_AUTH_MODES.IDENTITY_CENTER) {
    return KIRO_AUTH_MODES.IDENTITY_CENTER;
  }

  return KIRO_AUTH_MODES.BUILDER_ID;
}

function getFetchImplementation(dependencies: KiroRefreshDependencies): typeof fetch {
  if (dependencies.fetch) {
    return dependencies.fetch;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  return globalThis.fetch.bind(globalThis);
}

function getNow(dependencies: KiroRefreshDependencies): () => number {
  return dependencies.now ?? Date.now;
}

async function getRuntimeConfig(dependencies: KiroRefreshDependencies): Promise<KiroRuntimeConfig> {
  const runtimeConfig = await dependencies.resolveRuntimeConfig?.();
  return runtimeConfig ?? {};
}

function parseRefreshResponse(input: string): ParsedRefreshResponse {
  if (!input.trim()) {
    return {
      error: "invalid_response",
      errorDescription: "Kiro token refresh returned an empty response.",
      raw: {},
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return {
      error: "invalid_response",
      errorDescription: "Kiro token refresh returned invalid JSON.",
      raw: {},
    };
  }

  if (!isRecord(parsed)) {
    return {
      error: "invalid_response",
      errorDescription: "Kiro token refresh returned a non-object JSON payload.",
      raw: {},
    };
  }

  return {
    accessToken: readStringField(parsed, "accessToken", "access_token"),
    refreshToken: readStringField(parsed, "refreshToken", "refresh_token"),
    expiresIn: readNumberField(parsed, "expiresIn", "expires_in"),
    error: readStringField(parsed, "error", "code"),
    errorDescription: readStringField(parsed, "error_description", "errorDescription"),
    message: readStringField(parsed, "message"),
    raw: parsed,
  };
}

function calculateBufferedExpiry(now: number, expiresInSeconds: number | undefined): number {
  const bufferedExpiry = now + (expiresInSeconds ?? 3600) * 1000 - KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS;
  return Math.max(now + 1_000, bufferedExpiry);
}

function describeRefreshTarget(authMode: KiroAuthMode): string {
  return authMode === KIRO_AUTH_MODES.IDENTITY_CENTER ? "IAM Identity Center" : "Builder ID";
}

function buildRefreshFailureMessage(
  authMode: KiroAuthMode,
  response: Response,
  parsed: ParsedRefreshResponse,
  responseText: string,
): string {
  if (parsed.error === "invalid_grant") {
    return `${describeRefreshTarget(authMode)} refresh token is invalid or expired. Run /login again.`;
  }

  if (parsed.error === "invalid_client") {
    return `${describeRefreshTarget(authMode)} client credentials were rejected. Run /login again.`;
  }

  if (parsed.error === "invalid_response") {
    return `Kiro token refresh failed: ${parsed.errorDescription ?? "invalid provider response."}`;
  }

  const responseDetail = responseText.trim() || response.statusText;
  const detail = parsed.message ?? parsed.errorDescription ?? parsed.error ?? responseDetail;
  return `Kiro token refresh failed with HTTP ${response.status}: ${detail}`;
}

function buildRefreshHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": KIRO_REFRESH_USER_AGENT,
  };
}

export function buildBuilderIdRefreshRequest(credentials: Pick<KiroOAuthCredentials, "region" | "refresh">): KiroRefreshRequest {
  const region = normalizeStoredRegion(credentials.region);

  return {
    url: `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`,
    init: {
      method: "POST",
      headers: buildRefreshHeaders(),
      body: JSON.stringify({
        refreshToken: requireNonEmptyString(credentials.refresh, "Refresh token"),
      }),
    },
  };
}

export function buildIdentityCenterRefreshRequest(
  credentials: Pick<KiroOAuthCredentials, "oidcRegion" | "region" | "refresh" | "clientId" | "clientSecret">,
): KiroRefreshRequest {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      "IAM Identity Center refresh requires stored clientId and clientSecret. Run /login again.",
    );
  }

  const oidcRegion = normalizeStoredRegion(credentials.oidcRegion ?? credentials.region);

  return {
    url: `https://oidc.${oidcRegion}.amazonaws.com/token`,
    init: {
      method: "POST",
      headers: buildRefreshHeaders(),
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken: requireNonEmptyString(credentials.refresh, "Refresh token"),
        grantType: KIRO_REFRESH_GRANT_TYPE,
      }),
    },
  };
}

export function createKiroRefreshToken(dependencies: KiroRefreshDependencies = {}) {
  return async function refreshKiroToken(credentials: OAuthCredentials): Promise<KiroOAuthCredentials> {
    const runtimeConfig = await getRuntimeConfig(dependencies);
    const kiroCredentials = applyKiroProfileArnOverride(
      credentials as KiroOAuthCredentials,
      runtimeConfig.profileArn,
    );
    const authMode = normalizeStoredAuthMode(kiroCredentials.authMode);
    const request =
      authMode === KIRO_AUTH_MODES.IDENTITY_CENTER
        ? buildIdentityCenterRefreshRequest(kiroCredentials)
        : buildBuilderIdRefreshRequest(kiroCredentials);

    const fetchImplementation = getFetchImplementation(dependencies);
    const now = getNow(dependencies)();

    let response: Response;
    try {
      response = await fetchImplementation(request.url, request.init);
    } catch (error) {
      throw new Error(
        `Kiro token refresh failed: ${error instanceof Error ? error.message : "network request failed."}`,
      );
    }

    const responseText = await response.text();
    const parsed = parseRefreshResponse(responseText);

    if (!response.ok) {
      throw new Error(buildRefreshFailureMessage(authMode, response, parsed, responseText));
    }

    if (!parsed.accessToken) {
      if (parsed.error === "invalid_grant") {
        throw new Error(`${describeRefreshTarget(authMode)} refresh token is invalid or expired. Run /login again.`);
      }

      throw new Error(
        `Kiro token refresh failed: ${parsed.errorDescription ?? "response did not include an access token."}`,
      );
    }

    return {
      refresh: parsed.refreshToken ?? kiroCredentials.refresh,
      access: parsed.accessToken,
      expires: calculateBufferedExpiry(now, parsed.expiresIn),
      authMode,
      region: normalizeStoredRegion(kiroCredentials.region),
      oidcRegion: normalizeStoredRegion(kiroCredentials.oidcRegion ?? kiroCredentials.region),
      startUrl: kiroCredentials.startUrl,
      clientId: requireNonEmptyString(kiroCredentials.clientId, "Client ID"),
      clientSecret: requireNonEmptyString(kiroCredentials.clientSecret, "Client secret"),
      profileArn: kiroCredentials.profileArn,
    };
  };
}

export { KIRO_REFRESH_EXPIRY_SAFETY_BUFFER_MS };
