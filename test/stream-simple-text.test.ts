import { EventStreamCodec } from "@smithy/eventstream-codec";
import { describe, expect, it, vi } from "vitest";

import { clearKiroProfileArnCache, createKiroProviderConfig } from "../extensions/kiro/index";
import { KIRO_MAX_REQUEST_BODY_BYTES, serializeKiroPayload } from "../extensions/kiro/request";
import type { KiroRequestPayload } from "../extensions/kiro/types";
import { KIRO_CUSTOM_API, KIRO_PROVIDER_NAME } from "../extensions/kiro/types";

function createEventStreamMessage(eventType: string, body: unknown): Uint8Array {
  const codec = new EventStreamCodec(
    (bytes) => new TextDecoder().decode(bytes),
    (value) => new TextEncoder().encode(value),
  );

  return codec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: new TextEncoder().encode(JSON.stringify(body)),
  });
}

function createEventStreamResponse(messages: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const message of messages) {
          controller.enqueue(message);
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
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

describe("kiro streamSimple transport", () => {
  it("streams a complete text response end to end with stored credentials", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://q.us-west-2.amazonaws.com/generateAssistantResponse");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer latest-access-token",
          Accept: "text/event-stream, application/json",
          "Content-Type": "application/json",
          "x-amzn-kiro-agent-mode": "vibe",
        }),
      );

      const payload = JSON.parse(String(init?.body)) as {
        conversationState: {
          currentMessage: { userInputMessage: { content: string; modelId: string } };
        };
      };
      expect(payload.conversationState.currentMessage.userInputMessage).toMatchObject({
        content: "Say hello.",
        modelId: "claude-sonnet-4",
      });

      return createEventStreamResponse([
        createEventStreamMessage("assistantResponseEvent", {
          content: "Hello",
          modelId: "claude-sonnet-4",
        }),
        createEventStreamMessage("assistantResponseEvent", {
          content: " world",
          modelId: "claude-sonnet-4",
        }),
        createEventStreamMessage("messageDeltaEvent", {
          delta: { stop_reason: "end_turn" },
        }),
        createEventStreamMessage("metadataEvent", {
          tokenUsage: {
            uncachedInputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 1,
            totalTokens: 16,
          },
        }),
      ]);
    });

    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
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
        headers: { "x-test-header": "1" },
      } as never,
      {
        messages: [
          {
            role: "user",
            content: "Say hello.",
            timestamp: 1,
          },
        ],
      } as never,
      {
        apiKey: "latest-access-token",
        headers: { "x-another-header": "2" },
      },
    );

    const events = await collectStreamEvents(requireStream(stream));
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    const done = events.at(-1) as { type: string; message?: { content: unknown; usage: { input: number; output: number } } };
    expect(done.type).toBe("done");
    expect(done.message?.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(done.message?.usage).toMatchObject({
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 16,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discovers a profileArn for image requests and reuses it across turns", async () => {
    // CLI mode is required for image turns and the runtime rejects a body without profileArn.
    const profileArn = "arn:aws:codewhisperer:us-west-2:111122223333:profile/ABC";
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: String(init?.body) });

      if (url.startsWith("https://management.")) {
        return new Response(JSON.stringify({ profiles: [{ arn: profileArn }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return createEventStreamResponse([
        createEventStreamMessage("assistantResponseEvent", { content: "a cat", modelId: "claude-sonnet-4" }),
        createEventStreamMessage("messageDeltaEvent", { delta: { stop_reason: "end_turn" } }),
      ]);
    });

    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "stored-access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "identity-center",
            region: "us-west-2",
            oidcRegion: "us-west-2",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });

    clearKiroProfileArnCache();

    const imageContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is in this image" },
            { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };
    const model = { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME };

    await collectStreamEvents(requireStream(provider.streamSimple?.(model as never, imageContext as never, {})));

    expect(requests[0]?.url).toBe("https://management.us-west-2.kiro.dev/");
    expect(requests[1]?.url).toBe("https://runtime.us-west-2.kiro.dev/");
    expect(JSON.parse(requests[1]!.body).profileArn).toBe(profileArn);

    // A second image turn must reuse the cached ARN rather than re-discovering it.
    await collectStreamEvents(requireStream(provider.streamSimple?.(model as never, imageContext as never, {})));

    expect(requests.filter((request) => request.url.startsWith("https://management."))).toHaveLength(1);
    expect(JSON.parse(requests[2]!.body).profileArn).toBe(profileArn);
  });

  it("skips profile discovery for text-only requests", async () => {
    const fetchMock = vi.fn(async () =>
      createEventStreamResponse([
        createEventStreamMessage("assistantResponseEvent", { content: "hi", modelId: "claude-sonnet-4" }),
        createEventStreamMessage("messageDeltaEvent", { delta: { stop_reason: "end_turn" } }),
      ]),
    );

    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "text-only-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "identity-center",
            region: "us-west-2",
            oidcRegion: "us-west-2",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });

    clearKiroProfileArnCache();

    await collectStreamEvents(requireStream(provider.streamSimple?.(
      { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME } as never,
      { messages: [{ role: "user", content: "Say hello.", timestamp: 1 }] } as never,
      {},
    )));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain("q.us-west-2.amazonaws.com");
  });

  it("logs opt-in stream event shapes without response content", async () => {
    const appendLogFile = vi.fn(async (_path: string, content: string) => {
      expect(content).not.toContain("Hello secret response");
      expect(content).not.toContain("Bearer secret-token");
      expect(content).toContain("stream_event_shape");
    });
    const fetchMock = vi.fn(async () =>
      createEventStreamResponse([
        createEventStreamMessage("assistantResponseEvent", { content: "Hello secret response" }),
        createEventStreamMessage("metadataEvent", {
          tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, totalTokens: 3 },
          authorization: "Bearer secret-token",
        }),
      ]),
    );
    const provider = createKiroProviderConfig({
      env: { KIRO_DEBUG_STREAM_EVENTS: "1" },
      appendLogFile,
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "stored-access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "builder-id",
            region: "us-east-1",
            oidcRegion: "us-east-1",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });

    const stream = provider.streamSimple?.(
      { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME } as never,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as never,
    );

    await collectStreamEvents(requireStream(stream));
    expect(appendLogFile).toHaveBeenCalled();
  });
  it("rejects an oversized callback payload before fetch", async () => {
    const fetchMock = vi.fn(async () => createEventStreamResponse([]));
    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "stored-access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "builder-id",
            region: "us-east-1",
            oidcRegion: "us-east-1",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });
    const stream = provider.streamSimple?.(
      { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME } as never,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] } as never,
      {
        onPayload: async (payload: KiroRequestPayload) => ({
          ...payload,
          conversationState: {
            ...payload.conversationState,
            currentMessage: {
              userInputMessage: {
                ...payload.conversationState.currentMessage.userInputMessage,
                content: "x".repeat(KIRO_MAX_REQUEST_BODY_BYTES),
              },
            },
          },
        }),
      } as never,
    );

    const events = await collectStreamEvents(requireStream(stream));
    const terminal = events.at(-1) as { type: string; error?: { errorMessage?: string } };
    expect(terminal.type).toBe("error");
    expect(terminal.error?.errorMessage).toContain("context_length_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the exact canonical body that is measured", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(Buffer.byteLength(String(init?.body), "utf8")).toBe(serializeKiroPayload(JSON.parse(String(init?.body))).utf8Bytes);
      return createEventStreamResponse([]);
    });
    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "stored-access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "builder-id",
            region: "us-east-1",
            oidcRegion: "us-east-1",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });
    const stream = provider.streamSimple?.(
      { id: "claude-sonnet-4", api: KIRO_CUSTOM_API, provider: KIRO_PROVIDER_NAME } as never,
      { messages: [{ role: "user", content: "😀", timestamp: 1 }] } as never,
    );

    await collectStreamEvents(requireStream(stream));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops cleanly when the abort signal is triggered", async () => {
    const encoder = new TextEncoder();

    const fetchMock = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"assistantResponseEvent":{"content":"Partial"}}\n\n'));
          },
          cancel() {
            return undefined;
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    const provider = createKiroProviderConfig({
      fetch: fetchMock as unknown as typeof fetch,
      readAuthFile: async () =>
        JSON.stringify({
          kiro: {
            type: "oauth",
            access: "stored-access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            authMode: "builder-id",
            region: "us-east-1",
            oidcRegion: "us-east-1",
            clientId: "client-id",
            clientSecret: "client-secret",
          },
        }),
    });

    const abortController = new AbortController();
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
            content: "Abort please.",
            timestamp: 1,
          },
        ],
      } as never,
      {
        apiKey: "latest-access-token",
        signal: abortController.signal,
      },
    );

    const events: unknown[] = [];
    for await (const event of requireStream(stream)) {
      events.push(event);
      if ((event as { type?: string }).type === "text_delta") {
        abortController.abort();
      }
    }
    const terminal = events.at(-1) as { type: string; reason?: string; error?: { errorMessage?: string; content: unknown } };

    expect(terminal.type).toBe("error");
    expect(terminal.reason).toBe("aborted");
    expect(terminal.error?.errorMessage).toBe("Kiro request aborted.");
    expect(terminal.error?.content).toEqual([{ type: "text", text: "Partial" }]);
  });
});
