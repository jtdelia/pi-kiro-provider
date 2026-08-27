import { describe, expect, it, vi } from "vitest";

import {
  createKiroProviderConfig,
  isKiroPayloadDebugEnabled,
} from "../extensions/kiro/index";
import {
  getDefaultKiroPayloadLogPath,
  logKiroPayload,
  redactKiroPayload,
} from "../extensions/kiro/logging";
import type { KiroRequestPayload } from "../extensions/kiro/types";
import { KIRO_CUSTOM_API, KIRO_PROVIDER_NAME } from "../extensions/kiro/types";

function createEmptyResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  }), { status: 200 });
}

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
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

function createProvider(
  dependencies: Parameters<typeof createKiroProviderConfig>[0] = {},
): ReturnType<typeof createKiroProviderConfig> {
  return createKiroProviderConfig({
    env: {},
    fetch: vi.fn(async () => createEmptyResponse()) as unknown as typeof fetch,
    readAuthFile: async () =>
      JSON.stringify({
        kiro: {
          type: "oauth",
          access: "stored-access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          authMode: "identity-center",
          region: "us-west-2",
          oidcRegion: "us-east-1",
          clientId: "client-id",
          clientSecret: "client-secret",
          profileArn: "arn:aws:codewhisperer:us-west-2:111122223333:profile/ABC",
        },
      }),
    ...dependencies,
  });
}

describe("Kiro payload debug logging", () => {
  it("only enables the documented environment values", () => {
    expect(isKiroPayloadDebugEnabled(undefined)).toBe(false);
    expect(isKiroPayloadDebugEnabled("")).toBe(false);
    expect(isKiroPayloadDebugEnabled("0")).toBe(false);
    expect(isKiroPayloadDebugEnabled("false")).toBe(false);
    expect(isKiroPayloadDebugEnabled("FALSE")).toBe(false);
    expect(isKiroPayloadDebugEnabled("1")).toBe(true);
    expect(isKiroPayloadDebugEnabled("true")).toBe(true);
    expect(isKiroPayloadDebugEnabled("TrUe")).toBe(true);
  });

  it("redacts data-bearing payload fields without mutating the final payload", () => {
    const imageBytes = "c2Vuc2l0aXZlLWltYWdlLWJ5dGVz";
    const payload = {
      profileArn: "arn:aws:codewhisperer:us-west-2:111122223333:profile/ABC",
      authorization: "Bearer custom-authorization-value",
      accessToken: "access-token-value",
      additionalModelRequestFields: { reasoning: { effort: "max" } },
      conversationState: {
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
        conversationId: "conversation-123",
        history: [
          {
            userInputMessage: {
              content: "raw user prompt",
              modelId: "claude-sonnet-4",
              origin: "KIRO_CLI",
              images: [{ format: "png", source: { bytes: imageBytes } }],
              userInputMessageContext: {
                envState: {
                  operatingSystem: "macos",
                  currentWorkingDirectory: "/Users/example/private-project",
                },
                tools: [
                  {
                    toolSpecification: {
                      name: "read_file",
                      description: "raw tool description",
                      inputSchema: {
                        json: {
                          type: "object",
                          properties: { path: { type: "string" } },
                          default: "raw schema default",
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            assistantResponseMessage: {
              messageId: "assistant-message-id",
              content: "raw assistant response",
              toolUses: [{
                toolUseId: "tool-use-1",
                name: "read_file",
                input: { path: "/Users/example/private-project/secret.txt", query: "raw tool argument" },
              }],
              reasoningContent: { redactedContent: "raw reasoning signature" },
            },
          },
          {
            userInputMessage: {
              content: "raw tool result wrapper",
              modelId: "claude-sonnet-4",
              origin: "KIRO_CLI",
              userInputMessageContext: {
                toolResults: [{
                  toolUseId: "tool-use-1",
                  content: [{ text: "raw tool result" }],
                  status: "success",
                }],
              },
            },
          },
        ],
        currentMessage: {
          userInputMessage: {
            content: "raw current prompt",
            modelId: "claude-sonnet-4",
            origin: "KIRO_CLI",
          },
        },
      },
    };
    const original = structuredClone(payload);

    const redacted = redactKiroPayload(payload);
    const serialized = JSON.stringify(redacted);

    expect(payload).toEqual(original);
    expect(serialized).not.toContain("raw user prompt");
    expect(serialized).not.toContain("raw assistant response");
    expect(serialized).not.toContain("raw current prompt");
    expect(serialized).not.toContain("raw tool argument");
    expect(serialized).not.toContain("raw tool result");
    expect(serialized).not.toContain("raw tool description");
    expect(serialized).not.toContain("raw schema default");
    expect(serialized).not.toContain(imageBytes);
    expect(serialized).not.toContain("/Users/example/private-project");
    expect(serialized).not.toContain("111122223333");
    expect(serialized).not.toContain("custom-authorization-value");
    expect(serialized).not.toContain("access-token-value");
    expect(serialized).not.toContain("raw reasoning signature");

    expect(redacted).toMatchObject({
      additionalModelRequestFields: { reasoning: { effort: "max" } },
      conversationState: {
        chatTriggerType: "MANUAL",
        agentTaskType: "vibe",
        conversationId: "conversation-123",
      },
    });
    expect((redacted as { conversationState: { history: Array<{ userInputMessage?: { modelId?: string; origin?: string; images?: Array<{ format?: string }> } }> } }).conversationState.history[0]?.userInputMessage).toMatchObject({
      modelId: "claude-sonnet-4",
      origin: "KIRO_CLI",
      images: [{ format: "png" }],
    });
  });

  it("writes payload entries to the separate payload log", async () => {
    const appendLogFile = vi.fn(async (...args: [string, string]) => {
      void args;
    });

    await logKiroPayload(
      {
        logPath: "/tmp/kiro.log",
        payloadLogPath: "/tmp/kiro-payload.log",
        appendLogFile,
      },
      {
        modelId: "claude-sonnet-4",
        provider: KIRO_PROVIDER_NAME,
        api: KIRO_CUSTOM_API,
        requestMode: "ide",
        conversationId: "conversation-123",
        endpoint: "https://q.us-west-2.amazonaws.com/generateAssistantResponse",
        payloadModifiedByCallback: true,
        finalPayloadUtf8Bytes: 321,
        payload: {
          conversationState: {
            chatTriggerType: "MANUAL",
            currentMessage: { userInputMessage: { content: "raw prompt", modelId: "claude-sonnet-4", origin: "AI_EDITOR" } },
          },
        } as KiroRequestPayload,
      },
    );

    expect(appendLogFile).toHaveBeenCalledTimes(1);
    const [path, content] = appendLogFile.mock.calls[0] ?? [];
    expect(path).toBe("/tmp/kiro-payload.log");
    expect(path).not.toBe("/tmp/kiro.log");
    const entry = JSON.parse(content as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      event: "request_payload",
      context: {
        modelId: "claude-sonnet-4",
        provider: KIRO_PROVIDER_NAME,
        api: KIRO_CUSTOM_API,
        requestMode: "ide",
        conversationId: "conversation-123",
        endpoint: "https://q.us-west-2.amazonaws.com/generateAssistantResponse",
        payloadModifiedByCallback: true,
        finalPayloadUtf8Bytes: 321,
      },
    });
    expect(JSON.stringify(entry)).not.toContain("raw prompt");
  });

  it("logs the final callback payload before fetch and keeps fetch working if logging fails", async () => {
    const appendLogFile = vi.fn(async () => {
      throw new Error("disk full");
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).conversationState.currentMessage.userInputMessage.content).toBe(
        "callback prompt",
      );
      return createEmptyResponse();
    });
    const provider = createProvider({
      env: { KIRO_DEBUG_PAYLOAD: "TRUE" },
      payloadLogPath: "/tmp/kiro-payload.log",
      appendLogFile,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const stream = provider.streamSimple?.(
      { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME } as never,
      { messages: [{ role: "user", content: "original prompt", timestamp: 1 }] } as never,
      {
        sessionId: "conversation-123",
        onPayload: async (payload: KiroRequestPayload) => ({
          ...payload,
          conversationState: {
            ...payload.conversationState,
            currentMessage: {
              userInputMessage: {
                ...payload.conversationState.currentMessage.userInputMessage,
                content: "callback prompt",
              },
            },
          },
        }),
      } as never,
    );

    await collectStreamEvents(requireStream(stream));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appendLogFile).toHaveBeenCalledTimes(1);
  });

  it("uses the default payload log path when no path is injected", async () => {
    const appendLogFile = vi.fn(async (...args: [string, string]) => {
      void args;
    });

    await logKiroPayload(
      { appendLogFile },
      {
        modelId: "model",
        provider: "provider",
        api: "api",
        requestMode: "cli",
        endpoint: "https://runtime.us-east-1.kiro.dev/",
        payloadModifiedByCallback: false,
        finalPayloadUtf8Bytes: 1,
        payload: {},
      },
    );

    expect(appendLogFile.mock.calls[0]?.[0]).toBe(getDefaultKiroPayloadLogPath());
  });
});
