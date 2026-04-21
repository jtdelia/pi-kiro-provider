import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createKiroLogin } from "../extensions/kiro/auth";
import { createKiroProviderConfig } from "../extensions/kiro/index";
import { createKiroRefreshToken } from "../extensions/kiro/refresh";
import { KIRO_AUTH_MODES, KIRO_CUSTOM_API, KIRO_PROVIDER_NAME, type KiroOAuthCredentials } from "../extensions/kiro/types";

async function createTempLogPath(): Promise<{ logPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "kiro-log-test-"));
  return {
    logPath: join(dir, "kiro.log"),
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

async function readLogEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createCallbacks(promptResponses: string[]) {
  return {
    onAuth: vi.fn(),
    onProgress: vi.fn(),
    onPrompt: vi.fn(async () => {
      const response = promptResponses.shift();
      if (response === undefined) {
        throw new Error("Missing prompt response");
      }
      return response;
    }),
  };
}

async function collectStreamEvents(stream: AsyncIterable<unknown>) {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function requireStream<T>(stream: T | undefined): T {
  if (!stream) {
    throw new Error("Expected streamSimple to return a stream.");
  }

  return stream;
}

describe("kiro logging", () => {
  it("writes login errors to the log file", async () => {
    const { logPath, cleanup } = await createTempLogPath();

    try {
      const login = createKiroLogin({
        logPath,
        fetch: vi.fn(async () => new Response("upstream down", { status: 500 })) as unknown as typeof fetch,
        sleep: vi.fn(async () => undefined),
        now: () => 1_700_000_000_000,
      });

      await expect(login(createCallbacks(["1", "us-east-1"]))).rejects.toThrow(
        "Kiro sign-in could not register with AWS OIDC",
      );

      const entries = await readLogEntries(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.event).toBe("login_error");
      expect(entries[0]?.message).toBe("Kiro sign-in could not register with AWS OIDC: OIDC client registration failed with HTTP 500: upstream down");
      expect(entries[0]?.context).toMatchObject({
        authMode: "builder-id",
        region: "us-east-1",
        oidcRegion: "us-east-1",
      });
    } finally {
      await cleanup();
    }
  });

  it("writes request errors and request metadata to the log file", async () => {
    const { logPath, cleanup } = await createTempLogPath();

    try {
      const provider = createKiroProviderConfig({
        logPath,
        fetch: vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
        readAuthFile: async () =>
          JSON.stringify({
            kiro: {
              type: "oauth",
              access: "stored-access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
              authMode: "builder-id",
              region: "us-west-2",
              oidcRegion: "us-west-2",
              clientId: "client-id",
              clientSecret: "client-secret",
            },
          }),
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

      const events = await collectStreamEvents(requireStream(stream));
      expect((events.at(-1) as { type: string }).type).toBe("error");

      const entries = await readLogEntries(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.event).toBe("request_error");
      expect(entries[0]?.context).toMatchObject({
        modelId: "claude-sonnet-4",
        provider: KIRO_PROVIDER_NAME,
        api: KIRO_CUSTOM_API,
        requestUrl: "https://q.us-west-2.amazonaws.com/generateAssistantResponse",
        responseStatus: 500,
      });
    } finally {
      await cleanup();
    }
  });

  it("writes refresh errors and request metadata to the log file", async () => {
    const { logPath, cleanup } = await createTempLogPath();

    try {
      const refreshToken = createKiroRefreshToken({
        logPath,
        fetch: vi.fn(
          async () =>
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
        ) as unknown as typeof fetch,
      });

      await expect(
        refreshToken({
          refresh: "refresh-token",
          access: "access-token",
          expires: 1,
          authMode: KIRO_AUTH_MODES.IDENTITY_CENTER,
          region: "us-west-2",
          oidcRegion: "us-east-2",
          startUrl: "https://acme.awsapps.com/start",
          clientId: "client-id",
          clientSecret: "client-secret",
        } as KiroOAuthCredentials),
      ).rejects.toThrow("IAM Identity Center refresh token is invalid or expired. Run /login again.");

      const entries = await readLogEntries(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.event).toBe("refresh_error");
      expect(entries[0]?.context).toMatchObject({
        authMode: "identity-center",
        region: "us-west-2",
        oidcRegion: "us-east-2",
        requestUrl: "https://oidc.us-east-2.amazonaws.com/token",
        responseStatus: 400,
      });
    } finally {
      await cleanup();
    }
  });
});
