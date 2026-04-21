import { createHash } from "node:crypto";

import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";

import { createKiroRefreshToken } from "./refresh";
import {
  KIRO_AUTH_MODES,
  KIRO_DEFAULT_OIDC_REGION,
  KIRO_DEFAULT_SERVICE_REGION,
  applyKiroProfileArnOverride,
  type KiroAuthMode,
  type KiroOAuthCredentials,
  type KiroRuntimeConfig,
} from "./types";

const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/i;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const KIRO_OIDC_USER_AGENT = "KiroIDE";
const KIRO_OIDC_CLIENT_NAME = "Kiro IDE";
const KIRO_EXPIRY_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const KIRO_DEFAULT_POLL_INTERVAL_MS = 5_000;

export const KIRO_BUILDER_ID_START_URL = "https://view.awsapps.com/start";
export const KIRO_OIDC_SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
] as const;

export const KIRO_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const KIRO_REFRESH_TOKEN_GRANT_TYPE = "refresh_token";
export const KIRO_PKCE_CHALLENGE_METHOD = "S256" as const;

export interface NormalizedKiroAuthConfigInput {
  authMode?: string;
  region?: string;
  oidcRegion?: string;
  startUrl?: string;
}

export interface NormalizedKiroAuthConfig {
  authMode: KiroAuthMode;
  region: string;
  oidcRegion: string;
  startUrl?: string;
  authorizationStartUrl: string;
}

export interface OidcClientRegistrationRequestBody {
  clientName: string;
  clientType: "public";
  scopes: string[];
  grantTypes: string[];
}

export interface DeviceAuthorizationRequestBody {
  clientId: string;
  clientSecret: string;
  startUrl: string;
}

export interface TokenPollingRequestBody {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  grantType: typeof KIRO_DEVICE_CODE_GRANT_TYPE;
}

export interface RefreshTokenRequestBody {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  grantType: typeof KIRO_REFRESH_TOKEN_GRANT_TYPE;
}

export interface ParsedAwsTokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  idToken?: string;
  scope?: string;
  error?: string;
  errorDescription?: string;
  raw: Record<string, unknown>;
}

export interface KiroLoginDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onCredentialsUpdated?: (credentials: KiroOAuthCredentials) => Promise<void> | void;
  resolveRuntimeConfig?: () => Promise<KiroRuntimeConfig> | KiroRuntimeConfig;
}

interface JsonResponseShape {
  raw: Record<string, unknown>;
}

interface KiroClientRegistrationResponse extends JsonResponseShape {
  clientId?: string;
  clientSecret?: string;
}

interface KiroDeviceAuthorizationResponse extends JsonResponseShape {
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  interval?: number;
  expiresIn?: number;
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

function requireNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function base64UrlEncode(value: Uint8Array | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getFetchImplementation(dependencies: KiroLoginDependencies): typeof fetch {
  if (dependencies.fetch) {
    return dependencies.fetch;
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }

  return globalThis.fetch.bind(globalThis);
}

function getNow(dependencies: KiroLoginDependencies): () => number {
  return dependencies.now ?? Date.now;
}

function getSleep(dependencies: KiroLoginDependencies): (ms: number, signal?: AbortSignal) => Promise<void> {
  return dependencies.sleep ?? abortableSleep;
}

async function getRuntimeConfig(dependencies: KiroLoginDependencies): Promise<KiroRuntimeConfig> {
  const runtimeConfig = await dependencies.resolveRuntimeConfig?.();
  return runtimeConfig ?? {};
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Login cancelled.");
  }
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled."));
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timeout);
      reject(new Error("Login cancelled."));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readJsonObjectResponse(response: Response, operation: string): Promise<Record<string, unknown>> {
  const responseText = await response.text();

  if (!response.ok) {
    const suffix = responseText ? `: ${responseText}` : "";
    throw new Error(`${operation} failed with HTTP ${response.status}${suffix}`);
  }

  if (!responseText.trim()) {
    throw new Error(`${operation} returned an empty response.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error(`${operation} returned invalid JSON.`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${operation} returned a non-object JSON payload.`);
  }

  return parsed;
}

function parseClientRegistrationResponse(raw: Record<string, unknown>): KiroClientRegistrationResponse {
  return {
    clientId: readStringField(raw, "clientId", "client_id"),
    clientSecret: readStringField(raw, "clientSecret", "client_secret"),
    raw,
  };
}

function parseDeviceAuthorizationResponse(raw: Record<string, unknown>): KiroDeviceAuthorizationResponse {
  return {
    deviceCode: readStringField(raw, "deviceCode", "device_code"),
    userCode: readStringField(raw, "userCode", "user_code"),
    verificationUri: readStringField(raw, "verificationUri", "verification_uri"),
    verificationUriComplete: readStringField(
      raw,
      "verificationUriComplete",
      "verification_uri_complete",
    ),
    interval: readNumberField(raw, "interval"),
    expiresIn: readNumberField(raw, "expiresIn", "expires_in"),
    raw,
  };
}

function parseAuthModeSelection(selection: string): KiroAuthMode {
  const normalized = selection.trim().toLowerCase();

  if (
    normalized === "1" ||
    normalized === "builder" ||
    normalized === "builder id" ||
    normalized === "builder-id" ||
    normalized === "aws builder id"
  ) {
    return KIRO_AUTH_MODES.BUILDER_ID;
  }

  if (
    normalized === "2" ||
    normalized === "identity center" ||
    normalized === "iam identity center" ||
    normalized === "identity-center" ||
    normalized === "iam-identity-center"
  ) {
    return KIRO_AUTH_MODES.IDENTITY_CENTER;
  }

  throw new Error("Invalid auth mode selection. Enter 1 for Builder ID or 2 for IAM Identity Center.");
}

async function promptForKiroAuthConfig(callbacks: OAuthLoginCallbacks): Promise<NormalizedKiroAuthConfig> {
  const authModeSelection = await callbacks.onPrompt({
    message: "Choose Kiro auth mode:\n1. Builder ID\n2. IAM Identity Center\nEnter 1 or 2:",
    placeholder: "1",
  });

  const authMode = parseAuthModeSelection(authModeSelection);

  if (authMode === KIRO_AUTH_MODES.BUILDER_ID) {
    const regionInput = await callbacks.onPrompt({
      message: `Enter the AWS region for Kiro sign-in (default: ${KIRO_DEFAULT_OIDC_REGION}):`,
      placeholder: KIRO_DEFAULT_OIDC_REGION,
      allowEmpty: true,
    });

    return normalizeKiroAuthConfig({
      authMode,
      region: regionInput || KIRO_DEFAULT_SERVICE_REGION,
      oidcRegion: regionInput || KIRO_DEFAULT_OIDC_REGION,
    });
  }

  const startUrl = await callbacks.onPrompt({
    message: "Enter your IAM Identity Center Start URL:",
    placeholder: "https://your-org.awsapps.com/start",
  });

  const regionInput = await callbacks.onPrompt({
    message: `Enter the AWS region for Kiro sign-in (default: ${KIRO_DEFAULT_OIDC_REGION}):`,
    placeholder: KIRO_DEFAULT_OIDC_REGION,
    allowEmpty: true,
  });

  return normalizeKiroAuthConfig({
    authMode,
    startUrl,
    region: regionInput || KIRO_DEFAULT_SERVICE_REGION,
    oidcRegion: regionInput || KIRO_DEFAULT_OIDC_REGION,
  });
}

export function normalizeKiroRegion(region?: string): string {
  const normalized = region?.trim().toLowerCase();

  if (!normalized || !AWS_REGION_PATTERN.test(normalized)) {
    return KIRO_DEFAULT_OIDC_REGION;
  }

  return normalized;
}

export function normalizeKiroStartUrl(startUrl?: string): string | undefined {
  const trimmed = startUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(candidate);

  if (url.protocol !== "https:") {
    throw new Error("Start URL must use https.");
  }

  url.search = "";
  url.hash = "";
  url.pathname = "/start";

  return url.toString();
}

export function normalizeKiroAuthMode(authMode?: string): KiroAuthMode {
  if (authMode === KIRO_AUTH_MODES.IDENTITY_CENTER) {
    return KIRO_AUTH_MODES.IDENTITY_CENTER;
  }

  return KIRO_AUTH_MODES.BUILDER_ID;
}

export function normalizeKiroAuthConfig(
  input: NormalizedKiroAuthConfigInput = {},
): NormalizedKiroAuthConfig {
  const authMode = normalizeKiroAuthMode(input.authMode);
  const region = normalizeKiroRegion(input.region ?? input.oidcRegion ?? KIRO_DEFAULT_SERVICE_REGION);
  const oidcRegion = normalizeKiroRegion(input.oidcRegion ?? input.region ?? KIRO_DEFAULT_OIDC_REGION);

  if (authMode === KIRO_AUTH_MODES.BUILDER_ID) {
    return {
      authMode,
      region,
      oidcRegion,
      authorizationStartUrl: KIRO_BUILDER_ID_START_URL,
    };
  }

  const startUrl = normalizeKiroStartUrl(input.startUrl);
  if (!startUrl) {
    throw new Error("Start URL is required for IAM Identity Center authentication.");
  }

  return {
    authMode,
    region,
    oidcRegion,
    startUrl,
    authorizationStartUrl: startUrl,
  };
}

export function buildIdentityCenterDeviceUrl(startUrl: string, userCode: string): string {
  const normalizedStartUrl = normalizeKiroStartUrl(startUrl);
  const normalizedUserCode = requireNonEmptyString(userCode, "User code");

  if (!normalizedStartUrl) {
    throw new Error("Start URL is required to build the IAM Identity Center device URL.");
  }

  const url = new URL(normalizedStartUrl);
  url.pathname = "/start/";
  url.search = "";
  url.hash = `#/device?user_code=${encodeURIComponent(normalizedUserCode)}`;

  return url.toString();
}

export function buildPkceCodeVerifier(verifierBytes: Uint8Array): string {
  if (verifierBytes.length < 32) {
    throw new Error("PKCE verifier input must contain at least 32 bytes.");
  }

  return base64UrlEncode(verifierBytes);
}

export function buildPkceCodeChallenge(codeVerifier: string): string {
  const normalizedVerifier = codeVerifier.trim();
  if (!PKCE_VERIFIER_PATTERN.test(normalizedVerifier)) {
    throw new Error("PKCE code verifier must be 43-128 characters using RFC 7636 characters.");
  }

  return createHash("sha256").update(normalizedVerifier).digest("base64url");
}

export function buildPkcePair(codeVerifier: string): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof KIRO_PKCE_CHALLENGE_METHOD;
} {
  const normalizedVerifier = codeVerifier.trim();

  return {
    codeVerifier: normalizedVerifier,
    codeChallenge: buildPkceCodeChallenge(normalizedVerifier),
    codeChallengeMethod: KIRO_PKCE_CHALLENGE_METHOD,
  };
}

export function buildOidcClientRegistrationRequestBody(
  clientName = KIRO_OIDC_CLIENT_NAME,
): OidcClientRegistrationRequestBody {
  return {
    clientName,
    clientType: "public",
    scopes: [...KIRO_OIDC_SCOPES],
    grantTypes: [KIRO_DEVICE_CODE_GRANT_TYPE, KIRO_REFRESH_TOKEN_GRANT_TYPE],
  };
}

export function buildDeviceAuthorizationRequestBody(
  input: Pick<NormalizedKiroAuthConfigInput, "authMode" | "startUrl" | "region" | "oidcRegion"> & {
    clientId: string;
    clientSecret: string;
  },
): DeviceAuthorizationRequestBody {
  return {
    clientId: requireNonEmptyString(input.clientId, "Client ID"),
    clientSecret: requireNonEmptyString(input.clientSecret, "Client secret"),
    startUrl: normalizeKiroAuthConfig(input).authorizationStartUrl,
  };
}

export function buildTokenPollingRequestBody(input: {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
}): TokenPollingRequestBody {
  return {
    clientId: requireNonEmptyString(input.clientId, "Client ID"),
    clientSecret: requireNonEmptyString(input.clientSecret, "Client secret"),
    deviceCode: requireNonEmptyString(input.deviceCode, "Device code"),
    grantType: KIRO_DEVICE_CODE_GRANT_TYPE,
  };
}

export function buildRefreshTokenRequestBody(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): RefreshTokenRequestBody {
  return {
    clientId: requireNonEmptyString(input.clientId, "Client ID"),
    clientSecret: requireNonEmptyString(input.clientSecret, "Client secret"),
    refreshToken: requireNonEmptyString(input.refreshToken, "Refresh token"),
    grantType: KIRO_REFRESH_TOKEN_GRANT_TYPE,
  };
}

export function safeParseAwsTokenResponse(input: unknown): ParsedAwsTokenResponse {
  let raw: Record<string, unknown> = {};

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (isRecord(parsed)) {
        raw = parsed;
      } else {
        return {
          error: "invalid_response",
          errorDescription: "AWS token response JSON was not an object.",
          raw,
        };
      }
    } catch {
      return {
        error: "invalid_response",
        errorDescription: "AWS token response was not valid JSON.",
        raw,
      };
    }
  } else if (isRecord(input)) {
    raw = input;
  } else {
    return {
      error: "invalid_response",
      errorDescription: "AWS token response was empty or not an object.",
      raw,
    };
  }

  return {
    accessToken: readStringField(raw, "access_token", "accessToken"),
    refreshToken: readStringField(raw, "refresh_token", "refreshToken"),
    expiresIn: readNumberField(raw, "expires_in", "expiresIn"),
    tokenType: readStringField(raw, "token_type", "tokenType"),
    idToken: readStringField(raw, "id_token", "idToken"),
    scope: readStringField(raw, "scope"),
    error: readStringField(raw, "error"),
    errorDescription: readStringField(raw, "error_description", "errorDescription"),
    raw,
  };
}

export function buildKiroOidcEndpoint(region?: string): string {
  return `https://oidc.${normalizeKiroRegion(region)}.amazonaws.com`;
}

async function registerOidcClient(
  config: NormalizedKiroAuthConfig,
  dependencies: KiroLoginDependencies,
): Promise<{ clientId: string; clientSecret: string }> {
  try {
    const fetchImplementation = getFetchImplementation(dependencies);
    const response = await fetchImplementation(`${buildKiroOidcEndpoint(config.oidcRegion)}/client/register`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": KIRO_OIDC_USER_AGENT,
      },
      body: JSON.stringify(buildOidcClientRegistrationRequestBody()),
    });

    const raw = await readJsonObjectResponse(response, "OIDC client registration");
    const data = parseClientRegistrationResponse(raw);

    if (!data.clientId || !data.clientSecret) {
      throw new Error("OIDC client registration response was missing clientId or clientSecret.");
    }

    return {
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    };
  } catch (error) {
    throw new Error(
      `Kiro sign-in could not register with AWS OIDC: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function requestDeviceAuthorization(
  config: NormalizedKiroAuthConfig,
  client: { clientId: string; clientSecret: string },
  dependencies: KiroLoginDependencies,
): Promise<Required<Pick<KiroDeviceAuthorizationResponse, "deviceCode" | "userCode">> & {
  verificationUri?: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}> {
  try {
    const fetchImplementation = getFetchImplementation(dependencies);
    const response = await fetchImplementation(
      `${buildKiroOidcEndpoint(config.oidcRegion)}/device_authorization`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": KIRO_OIDC_USER_AGENT,
        },
        body: JSON.stringify(
          buildDeviceAuthorizationRequestBody({
            authMode: config.authMode,
            startUrl: config.startUrl,
            region: config.region,
            oidcRegion: config.oidcRegion,
            clientId: client.clientId,
            clientSecret: client.clientSecret,
          }),
        ),
      },
    );

    const raw = await readJsonObjectResponse(response, "Device authorization");
    const data = parseDeviceAuthorizationResponse(raw);

    if (!data.deviceCode || !data.userCode) {
      throw new Error("Device authorization response was missing deviceCode or userCode.");
    }

    return {
      deviceCode: data.deviceCode,
      userCode: data.userCode,
      verificationUri: data.verificationUri,
      verificationUriComplete: data.verificationUriComplete,
      interval: data.interval ?? KIRO_DEFAULT_POLL_INTERVAL_MS / 1000,
      expiresIn: data.expiresIn ?? 600,
    };
  } catch (error) {
    throw new Error(
      `Kiro sign-in could not start AWS device authorization: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getBuilderIdBrowserUrl(
  verificationUriComplete: string | undefined,
  verificationUri: string | undefined,
): string {
  const url = verificationUriComplete ?? verificationUri;
  if (!url) {
    throw new Error("Device authorization response did not include a verification URL.");
  }

  return url;
}

function getBrowserInstructions(authMode: KiroAuthMode, userCode: string, verificationUrl: string): string {
  if (authMode === KIRO_AUTH_MODES.IDENTITY_CENTER) {
    return `Open ${verificationUrl} and complete the IAM Identity Center sign-in flow.`;
  }

  return `Open ${verificationUrl} and complete sign-in. If AWS asks for a code, enter: ${userCode}`;
}

async function pollForToken(
  config: NormalizedKiroAuthConfig,
  client: { clientId: string; clientSecret: string },
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  callbacks: OAuthLoginCallbacks,
  dependencies: KiroLoginDependencies,
): Promise<KiroOAuthCredentials> {
  const fetchImplementation = getFetchImplementation(dependencies);
  const now = getNow(dependencies);
  const sleep = getSleep(dependencies);
  const deadline = now() + expiresInSeconds * 1000;
  let intervalMs = Math.max(1_000, Math.floor(intervalSeconds * 1000));

  while (now() < deadline) {
    ensureNotAborted(callbacks.signal);

    const response = await fetchImplementation(`${buildKiroOidcEndpoint(config.oidcRegion)}/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": KIRO_OIDC_USER_AGENT,
      },
      body: JSON.stringify(
        buildTokenPollingRequestBody({
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          deviceCode,
        }),
      ),
    });

    const responseText = await response.text();
    const parsed = safeParseAwsTokenResponse(responseText || {});

    if (parsed.accessToken && parsed.refreshToken) {
      const expiresAt = now() + (parsed.expiresIn ?? 3600) * 1000 - KIRO_EXPIRY_SAFETY_BUFFER_MS;

      return {
        refresh: parsed.refreshToken,
        access: parsed.accessToken,
        expires: Math.max(now() + 1_000, expiresAt),
        authMode: config.authMode,
        region: config.region,
        oidcRegion: config.oidcRegion,
        startUrl: config.startUrl,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      };
    }

    if (parsed.error === "authorization_pending") {
      await sleep(intervalMs, callbacks.signal);
      continue;
    }

    if (parsed.error === "slow_down") {
      intervalMs += 5_000;
      await sleep(intervalMs, callbacks.signal);
      continue;
    }

    if (parsed.error === "access_denied") {
      throw new Error("Authorization was denied by the user.");
    }

    if (parsed.error === "expired_token") {
      throw new Error("Device authorization expired before login completed.");
    }

    if (parsed.error === "invalid_response") {
      throw new Error(`Token exchange failed: ${parsed.errorDescription ?? "invalid AWS response."}`);
    }

    if (!response.ok) {
      const reason = parsed.error
        ? `${parsed.error}${parsed.errorDescription ? ` - ${parsed.errorDescription}` : ""}`
        : responseText || response.statusText;
      throw new Error(`Token exchange failed with HTTP ${response.status}: ${reason}`);
    }

    throw new Error("Token exchange failed: response did not include both access and refresh tokens.");
  }

  throw new Error("Authentication timed out before AWS returned a token.");
}

export function createKiroLogin(dependencies: KiroLoginDependencies = {}) {
  return async function loginKiro(callbacks: OAuthLoginCallbacks): Promise<KiroOAuthCredentials> {
    const config = await promptForKiroAuthConfig(callbacks);
    const runtimeConfig = await getRuntimeConfig(dependencies);

    callbacks.onProgress?.("Registering the Kiro OIDC client...");
    const client = await registerOidcClient(config, dependencies);

    callbacks.onProgress?.("Starting AWS device authorization...");
    const deviceAuthorization = await requestDeviceAuthorization(config, client, dependencies);

    const browserUrl =
      config.authMode === KIRO_AUTH_MODES.IDENTITY_CENTER && config.startUrl
        ? buildIdentityCenterDeviceUrl(config.startUrl, deviceAuthorization.userCode)
        : getBuilderIdBrowserUrl(
            deviceAuthorization.verificationUriComplete,
            deviceAuthorization.verificationUri,
          );

    callbacks.onAuth({
      url: browserUrl,
      instructions: getBrowserInstructions(config.authMode, deviceAuthorization.userCode, browserUrl),
    });

    callbacks.onProgress?.("Waiting for the browser login to complete...");
    const credentials = await pollForToken(
      config,
      client,
      deviceAuthorization.deviceCode,
      deviceAuthorization.interval,
      deviceAuthorization.expiresIn,
      callbacks,
      dependencies,
    );

    return applyKiroProfileArnOverride(credentials, runtimeConfig.profileArn);
  };
}

function notifyCredentialsUpdated(
  callback: KiroLoginDependencies["onCredentialsUpdated"],
  credentials: KiroOAuthCredentials,
): void {
  if (!callback) {
    return;
  }

  void Promise.resolve(callback(credentials)).catch(() => undefined);
}

export function createKiroOAuthProviderConfig(dependencies: KiroLoginDependencies = {}) {
  const login = createKiroLogin(dependencies);
  const refreshToken = createKiroRefreshToken(dependencies);

  return {
    name: "Kiro",
    async login(callbacks: OAuthLoginCallbacks): Promise<KiroOAuthCredentials> {
      const credentials = await login(callbacks);
      notifyCredentialsUpdated(dependencies.onCredentialsUpdated, credentials);
      return credentials;
    },
    async refreshToken(credentials: OAuthCredentials): Promise<KiroOAuthCredentials> {
      const refreshedCredentials = await refreshToken(credentials);
      notifyCredentialsUpdated(dependencies.onCredentialsUpdated, refreshedCredentials);
      return refreshedCredentials;
    },
    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },
  };
}
