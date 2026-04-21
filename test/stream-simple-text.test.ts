import { EventStreamCodec } from "@smithy/eventstream-codec";
import { describe, expect, it, vi } from "vitest";

import { createKiroProviderConfig } from "../extensions/kiro/index";
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
          usage: { input_tokens: 10, output_tokens: 2 },
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
    expect(done.message?.usage).toMatchObject({ input: 10, output: 2 });
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
