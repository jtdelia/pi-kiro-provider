import { Type } from "@sinclair/typebox";
import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import {
  adaptPiContextToKiroRequest,
  buildKiroRequestEndpoint,
  buildKiroTransportRequest,
  getKiroHistoryByteBudget,
  KIRO_MAX_CURRENT_TOOL_RESULT_TEXT_CHARS,
  KIRO_MAX_IMAGE_BYTES,
  KIRO_MAX_IMAGES_PER_REQUEST,
  KIRO_MAX_REQUEST_BODY_BYTES,
  KiroImageLimitExceededError,
  convertPiToolDefinitions,
  convertToolResultMessageToKiroMessage,
  mapNodePlatformToKiroOperatingSystem,
  mapThinkingLevelToKiroThinkingConfig,
  serializeKiroPayload,
} from "../extensions/kiro/request";
import type { KiroOAuthCredentials } from "../extensions/kiro/types";

const credentials: KiroOAuthCredentials = {
  refresh: "refresh-token",
  access: "access-token",
  expires: 1,
  authMode: "builder-id",
  region: "us-west-2",
  oidcRegion: "us-east-1",
  clientId: "client-id",
  clientSecret: "client-secret",
};

describe("kiro request adapter", () => {
  it("converts a simple text conversation correctly", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        systemPrompt: "Follow the repo conventions.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Summarize the auth flow." }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "The auth flow uses AWS device auth." }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
          },
          {
            role: "user",
            content: [{ type: "text", text: "Now explain refresh token handling." }],
            timestamp: 3,
          },
        ],
      },
      conversationId: "conv-123",
    });

    expect(prepared.serviceModelId).toBe("claude-sonnet-4");
    expect(prepared.endpoint).toBe("https://q.us-west-2.amazonaws.com/generateAssistantResponse");
    expect(prepared.payload.conversationState.conversationId).toBe("conv-123");
    expect(prepared.payload.conversationState.history).toEqual([
      {
        userInputMessage: {
          content: "Follow the repo conventions.\n\nSummarize the auth flow.",
          modelId: "claude-sonnet-4",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "The auth flow uses AWS device auth.",
        },
      },
    ]);
    expect(prepared.payload.conversationState.currentMessage.userInputMessage).toEqual({
      content: "Now explain refresh token handling.",
      modelId: "claude-sonnet-4",
      origin: "AI_EDITOR",
    });
  });

  it("converts tool definitions correctly", () => {
    const tools = convertPiToolDefinitions([
      {
        name: "read_file",
        description: "Read a file from disk",
        parameters: Type.Object({
          path: Type.String(),
          offset: Type.Optional(Type.Number()),
        }),
      },
    ]);

    expect(tools).toEqual([
      {
        toolSpecification: {
          name: "read_file",
          description: "Read a file from disk",
          inputSchema: {
            json: {
              type: "object",
              properties: {
                path: { type: "string" },
                offset: { type: "number" },
              },
              required: ["path"],
            },
          },
        },
      },
    ]);
  });

  it("forwards tool-result images on the Kiro user-input message", () => {
    const imageData = Buffer.from("screenshot").toString("base64");
    const message = convertToolResultMessageToKiroMessage(
      {
        role: "toolResult",
        toolCallId: "call-screenshot",
        toolName: "screenshot",
        content: [
          { type: "text", text: "Screenshot captured." },
          { type: "image", data: imageData, mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 10,
      },
      "claude-sonnet-4",
    );

    expect(message).toEqual({
      userInputMessage: {
        content: "Screenshot captured.",
        modelId: "claude-sonnet-4",
        origin: "AI_EDITOR",
        images: [{ format: "png", source: { bytes: imageData } }],
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: "call-screenshot",
              content: [{ text: "Screenshot captured." }],
              status: "success",
            },
          ],
        },
      },
    });
  });

  it("leaves image-only tool results empty while preserving the image", () => {
    const imageData = Buffer.from("screenshot").toString("base64");
    const message = convertToolResultMessageToKiroMessage(
      {
        role: "toolResult",
        toolCallId: "call-screenshot",
        toolName: "read",
        content: [{ type: "image", data: imageData, mimeType: "image/png" }],
        isError: false,
        timestamp: 10,
      },
      "claude-sonnet-4",
    );

    expect(message.userInputMessage).toMatchObject({
      content: "",
      images: [{ format: "png", source: { bytes: imageData } }],
    });
    expect(message.userInputMessage?.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "call-screenshot",
        content: [],
        status: "success",
      },
    ]);
  });

  it("converts supported image MIME types to Kiro formats", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "image", data: "jpeg", mimeType: "IMAGE/JPG" },
            { type: "image", data: "png", mimeType: "image/png; charset=binary" },
            { type: "image", data: "gif", mimeType: "image/gif" },
            { type: "image", data: "webp", mimeType: "image/webp" },
          ],
          timestamp: 1,
        }],
      },
    });

    expect(prepared.payload.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: "jpeg", source: { bytes: "jpeg" } },
      { format: "png", source: { bytes: "png" } },
      { format: "gif", source: { bytes: "gif" } },
      { format: "webp", source: { bytes: "webp" } },
    ]);
  });

  it("preserves multiple current tool-result images and strips historical tool images", () => {
    const firstImage = Buffer.from("first").toString("base64");
    const secondImage = Buffer.from("second").toString("base64");
    const historicalImage = Buffer.from("historical").toString("base64");
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          { role: "user", content: "historical request", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "old-call", name: "screenshot", arguments: {} }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "old-call",
            toolName: "screenshot",
            content: [{ type: "image", data: historicalImage, mimeType: "image/png" }],
            isError: false,
            timestamp: 3,
          },
          { role: "user", content: "current request", timestamp: 4 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "current-call", name: "capture", arguments: {} },
              { type: "toolCall", id: "failed-call", name: "capture", arguments: {} },
            ],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 5,
          },
          {
            role: "toolResult",
            toolCallId: "current-call",
            toolName: "capture",
            content: [
              { type: "text", text: "Captured." },
              { type: "image", data: firstImage, mimeType: "image/png" },
              { type: "image", data: secondImage, mimeType: "image/webp" },
            ],
            isError: false,
            timestamp: 6,
          },
          {
            role: "toolResult",
            toolCallId: "failed-call",
            toolName: "capture",
            content: [{ type: "image", data: firstImage, mimeType: "image/jpeg" }],
            isError: true,
            timestamp: 7,
          },
        ],
      },
    });

    const current = prepared.payload.conversationState.currentMessage.userInputMessage;
    expect(current.images).toEqual([
      { format: "png", source: { bytes: firstImage } },
      { format: "webp", source: { bytes: secondImage } },
      { format: "jpeg", source: { bytes: firstImage } },
    ]);
    expect(current.userInputMessageContext?.toolResults).toEqual([
      {
        toolUseId: "current-call",
        content: [{ text: "Captured." }],
        status: "success",
      },
      {
        toolUseId: "failed-call",
        content: [],
        status: "error",
      },
    ]);
    expect(prepared.payload.conversationState.history?.some((entry) =>
      entry.userInputMessage?.images?.some((image) => image.source.bytes === historicalImage),
    )).toBe(false);
  });

  it("converts tool result messages correctly", () => {
    const message = convertToolResultMessageToKiroMessage(
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 10,
      },
      "claude-sonnet-4",
    );

    expect(message).toEqual({
      userInputMessage: {
        content: "file contents",
        modelId: "claude-sonnet-4",
        origin: "AI_EDITOR",
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: "call-1",
              content: [{ text: "file contents" }],
              status: "success",
            },
          ],
        },
      },
    });
  });

  it("maps thinking levels to the expected config and request fields", () => {
    expect(mapThinkingLevelToKiroThinkingConfig("high")).toEqual({
      enabled: true,
      level: "high",
      budgetTokens: 16384,
      systemPromptPrefix:
        "<thinking_mode>enabled</thinking_mode><max_thinking_length>16384</max_thinking_length>",
    });

    expect(mapThinkingLevelToKiroThinkingConfig("xhigh")).toEqual({
      enabled: true,
      level: "xhigh",
    });

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      reasoning: "high",
      context: {
        systemPrompt: "Be careful.",
        messages: [
          {
            role: "user",
            content: "Solve this carefully.",
            timestamp: 1,
          },
        ],
      },
    });

    expect(prepared.thinkingConfig.enabled).toBe(true);
    expect(prepared.payload.additionalModelRequestFields).toBeUndefined();
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.content).toBe(
      "<thinking_mode>enabled</thinking_mode><max_thinking_length>16384</max_thinking_length>\nBe careful.\n\nSolve this carefully.",
    );

    const maxPrepared = adaptPiContextToKiroRequest({
      modelId: "claude-opus-4",
      credentials,
      reasoning: "xhigh",
      context: {
        messages: [{ role: "user", content: "Use max effort.", timestamp: 1 }],
      },
    });
    expect(maxPrepared.requestMode).toBe("ide");
    expect(maxPrepared.payload.additionalModelRequestFields).toEqual({
      reasoning: { effort: "max" },
    });
    expect(maxPrepared.effectiveSystemPrompt).toBeUndefined();
    expect(maxPrepared.payload.conversationState.currentMessage.userInputMessage.content).toBe(
      "Use max effort.",
    );
    expect(JSON.stringify(maxPrepared.payload)).not.toContain("max_thinking_length");
  });

  it("uses stored region by default and profileArn region when provided", () => {
    expect(buildKiroRequestEndpoint(credentials)).toBe(
      "https://q.us-west-2.amazonaws.com/generateAssistantResponse",
    );

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials: {
        ...credentials,
        profileArn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example",
      },
      context: {
        messages: [
          {
            role: "user",
            content: "hello",
            timestamp: 1,
          },
        ],
      },
    });

    expect(prepared.region).toBe("eu-central-1");
    expect(prepared.endpoint).toBe("https://q.eu-central-1.amazonaws.com/generateAssistantResponse");
    expect(prepared.payload.profileArn).toBe(
      "arn:aws:codewhisperer:eu-central-1:123456789012:profile/example",
    );
  });

  it("truncates oversized tool result text", () => {
    const longText = `${"a".repeat(70_000)}${"b".repeat(70_000)}`;
    const message = convertToolResultMessageToKiroMessage(
      {
        role: "toolResult",
        toolCallId: "call-long",
        toolName: "bash",
        content: [{ type: "text", text: longText }],
        isError: false,
        timestamp: 10,
      },
      "claude-sonnet-4",
    );

    const truncated = message.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.content[0]?.text;
    expect(truncated).toContain("... [TRUNCATED] ...");
    expect(truncated?.length).toBeLessThan(longText.length);
    expect(message.userInputMessage?.content).toContain("... [TRUNCATED] ...");
  });

  it("prunes oversized replay history to stay within a payload budget", () => {
    const longChunk = "x".repeat(80_000);
    const messages: Message[] = [];

    for (let index = 0; index < 8; index += 1) {
      messages.push({
        role: "user",
        content: `user-${index}-${longChunk}`,
        timestamp: index * 2 + 1,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant-${index}-${longChunk}` }],
        api: "kiro-api",
        provider: "kiro",
        model: "claude-sonnet-4",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: index * 2 + 2,
      });
    }

    messages.push({
      role: "user",
      content: "latest question",
      timestamp: 100,
    });

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: { messages },
    });

    const payloadText = JSON.stringify(prepared.payload);
    const firstHistoryUser = prepared.payload.conversationState.history?.find((entry) => entry.userInputMessage)?.userInputMessage;

    expect(Buffer.byteLength(payloadText, "utf8")).toBeLessThanOrEqual(KIRO_MAX_REQUEST_BODY_BYTES);
    expect(prepared.diagnostics?.finalPayloadUtf8Bytes).toBe(Buffer.byteLength(payloadText, "utf8"));
    expect(firstHistoryUser?.content.startsWith("user-0-")).toBe(false);
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.content).toBe("latest question");
  });

  it("prunes history using UTF-8 bytes for non-ASCII content", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 8; index += 1) {
      messages.push(
        { role: "user", content: `用户-${index}-${"😀".repeat(20_000)}`, timestamp: index * 2 + 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: `助手-${index}-${"😀".repeat(20_000)}` }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: index * 2 + 2,
        },
      );
    }
    messages.push({ role: "user", content: "最新の質問", timestamp: 100 });

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: { messages },
    });
    const history = prepared.payload.conversationState.history ?? [];

    expect(prepared.diagnostics?.prunedHistoryMessageCount).toBeGreaterThan(0);
    expect(history[0]?.userInputMessage).toBeDefined();
    expect(prepared.diagnostics?.finalPayloadUtf8Bytes).toBeLessThanOrEqual(KIRO_MAX_REQUEST_BODY_BYTES);
  });

  it("removes leading assistant history and preserves a valid user-first history", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "orphaned assistant response" }],
        api: "kiro-api",
        provider: "kiro",
        model: "claude-sonnet-4",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1,
      },
      { role: "user", content: "actual first turn", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "valid response" }],
        api: "kiro-api",
        provider: "kiro",
        model: "claude-sonnet-4",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 3,
      },
      { role: "user", content: "current turn", timestamp: 4 },
    ];

    const prepared = adaptPiContextToKiroRequest({ modelId: "claude-sonnet-4", credentials, context: { messages } });
    const history = prepared.payload.conversationState.history ?? [];

    expect(history[0]?.userInputMessage?.content).toBe("actual first turn");
    expect(history.every((entry) => entry.userInputMessage || entry.assistantResponseMessage)).toBe(true);
  });

  it("serializes the final payload as UTF-8 bytes rather than JavaScript code units", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: { messages: [{ role: "user", content: "emoji: 😀 中文", timestamp: 1 }] },
    });

    const serialized = serializeKiroPayload(prepared.payload);
    expect(serialized.utf8Bytes).toBe(Buffer.byteLength(serialized.body, "utf8"));
    expect(serialized.utf8Bytes).toBeGreaterThan(serialized.body.length);

    const transport = buildKiroTransportRequest({
      preparedRequest: prepared,
      accessToken: credentials.access,
      requestId: "request-id",
    });
    expect(transport.init.body).toBe(serialized.body);
    expect(transport.serializedPayload).toEqual(serialized);
  });

  it("serializes user image bytes as the original base64 string", () => {
    const imageData = Buffer.from("image").toString("base64");
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [{
          role: "user",
          content: [{ type: "image", data: imageData, mimeType: "image/png" }],
          timestamp: 1,
        }],
      },
    });

    const currentImage = prepared.payload.conversationState.currentMessage.userInputMessage.images?.[0];
    expect(currentImage).toEqual({ format: "png", source: { bytes: imageData } });
    expect(typeof currentImage?.source.bytes).toBe("string");
    expect(JSON.parse(JSON.stringify(prepared.payload)).conversationState.currentMessage.userInputMessage.images[0].source.bytes).toBe(
      imageData,
    );
  });

  it("uses the Kiro CLI runtime contract for image turns", () => {
    const imageData = Buffer.from("image").toString("base64");
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      conversationId: "cli-conv",
      reasoning: "xhigh",
      context: {
        messages: [
          { role: "user", content: "Earlier question.", timestamp: 0 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Earlier answer." }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image." },
              { type: "image", data: imageData, mimeType: "image/png" },
            ],
            timestamp: 2,
          },
        ],
      },
    });

    expect(prepared.requestMode).toBe("cli");
    expect(prepared.endpoint).toBe("https://runtime.us-west-2.kiro.dev/");
    expect(prepared.payload).toMatchObject({
      profileArn: undefined,
      additionalModelRequestFields: {
        reasoning: { effort: "max" },
      },
    });
    expect(JSON.stringify(prepared.payload)).not.toContain("max_thinking_length");
    expect(prepared.payload.conversationState).toMatchObject({
      conversationId: "cli-conv",
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
    });
    expect(prepared.payload.conversationState.history?.[0]?.userInputMessage).toMatchObject({
      content: expect.any(String),
      origin: "KIRO_CLI",
    });
    expect(Object.keys(prepared.payload.conversationState.history?.[0]?.userInputMessage ?? {}).sort()).toEqual([
      "content",
      "origin",
    ]);
    expect(prepared.payload.conversationState.currentMessage.userInputMessage).toMatchObject({
      origin: "KIRO_CLI",
      modelId: "claude-sonnet-4",
      images: [{ format: "png", source: { bytes: imageData } }],
      userInputMessageContext: {
        envState: {
          operatingSystem: mapNodePlatformToKiroOperatingSystem(process.platform),
          currentWorkingDirectory: process.cwd(),
        },
      },
    });

    const transport = buildKiroTransportRequest({
      preparedRequest: prepared,
      accessToken: credentials.access,
      requestId: "cli-request-id",
    });
    expect(transport.url).toBe(prepared.endpoint);
    expect(transport.init.headers).toEqual(expect.objectContaining({
      Accept: "*/*",
      "Content-Type": "application/x-amz-json-1.0",
      "amz-sdk-request": "attempt=1; max=3",
      "amz-sdk-invocation-id": "cli-request-id",
      "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "x-amzn-codewhisperer-optout": "false",
      "x-kiro-attempt": "1;max=3",
      "user-agent": expect.stringContaining("app/AmazonQ-For-CLI"),
      "x-amz-user-agent": expect.stringContaining("m/F app/AmazonQ-For-CLI"),
    }));
    expect(Buffer.byteLength(String(transport.init.body), "utf8")).toBe(transport.serializedPayload.utf8Bytes);
  });

  it("replays CLI assistant tool calls with a message ID before image turns", () => {
    const imageData = Buffer.from("image").toString("base64");
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          { role: "user", content: "Inspect the image.", timestamp: 1 },
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call_read_image",
              name: "read",
              arguments: { image_paths: ["/tmp/image.png"] },
            }, {
              type: "thinking",
              thinking: "",
              thinkingSignature: "opaque-redacted-content",
              redacted: true,
            }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            responseId: "assistant-response-id",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call_read_image",
            toolName: "read",
            content: [],
            isError: false,
            timestamp: 3,
          },
          {
            role: "user",
            content: [{ type: "image", data: imageData, mimeType: "image/png" }],
            timestamp: 4,
          },
        ],
      },
    });

    const assistant = prepared.payload.conversationState.history?.find(
      (message) => message.assistantResponseMessage?.toolUses?.length,
    )?.assistantResponseMessage;
    expect(assistant).toMatchObject({
      messageId: "assistant-response-id",
      content: "",
      reasoningContent: { redactedContent: "opaque-redacted-content" },
      toolUses: [{ toolUseId: "call_read_image", name: "read" }],
    });
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: "png", source: { bytes: imageData } },
    ]);
    expect(prepared.requestMode).toBe("cli");
  });


  it("uses a placeholder for an image-only user prompt", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [{
          role: "user",
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" }],
          timestamp: 1,
        }],
      },
    });

    expect(prepared.payload.conversationState.currentMessage.userInputMessage.content).toBe("Image provided.");
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.images).toEqual([
      { format: "jpeg", source: { bytes: "aW1hZ2U=" } },
    ]);
  });

  it("rejects more than the allowed number of current-turn images", () => {
    const images = Array.from({ length: KIRO_MAX_IMAGES_PER_REQUEST + 1 }, (_, index) => ({
      type: "image" as const,
      data: Buffer.from(`image-${index}`).toString("base64"),
      mimeType: "image/png",
    }));

    expect(() => adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: { messages: [{ role: "user", content: images, timestamp: 1 }] },
    })).toThrowError(KiroImageLimitExceededError);
  });

  it("rejects a current-turn image larger than the documented limit", () => {
    const imageData = Buffer.alloc(KIRO_MAX_IMAGE_BYTES + 1).toString("base64");

    expect(() => adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [{
          role: "user",
          content: [{ type: "image", data: imageData, mimeType: "image/png" }],
          timestamp: 1,
        }],
      },
    })).toThrowError(KiroImageLimitExceededError);
  });

  it("applies image limits to images returned by current-turn tools", () => {
    const images = Array.from({ length: KIRO_MAX_IMAGES_PER_REQUEST + 1 }, (_, index) => ({
      type: "image" as const,
      data: Buffer.from(`tool-image-${index}`).toString("base64"),
      mimeType: "image/png",
    }));

    expect(() => adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "capture", name: "capture", arguments: {} }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "toolUse",
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "capture",
            toolName: "capture",
            content: images,
            isError: false,
            timestamp: 2,
          },
        ],
      },
    })).toThrowError(KiroImageLimitExceededError);
  });

  it("removes historical images but preserves current-turn images", () => {
    const image = { type: "image" as const, data: Buffer.from("image").toString("base64"), mimeType: "image/png" };
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          { role: "user", content: [image], timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "I saw it." }],
            api: "kiro-api",
            provider: "kiro",
            model: "claude-sonnet-4",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: 2,
          },
          { role: "user", content: [image], timestamp: 3 },
        ],
      },
    });

    expect(prepared.payload.conversationState.history?.[0]?.userInputMessage?.images).toBeUndefined();
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.images).toHaveLength(1);
    expect(prepared.diagnostics?.removedHistoricalImageCount).toBe(1);
  });

  it("applies an aggregate current tool-result budget while retaining IDs and statuses", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: Array.from({ length: 4 }, (_, index) => ({
          type: "toolCall" as const,
          id: `call-${index}`,
          name: "read_file",
          arguments: { path: `/tmp/${index}` },
        })),
        api: "kiro-api",
        provider: "kiro",
        model: "claude-sonnet-4",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        role: "toolResult" as const,
        toolCallId: `call-${index}`,
        toolName: "read_file",
        content: [{ type: "text" as const, text: String(index).repeat(100_000) }],
        isError: index === 3,
        timestamp: index + 2,
      })),
    ];
    const prepared = adaptPiContextToKiroRequest({ modelId: "claude-sonnet-4", credentials, context: { messages } });
    const results = prepared.payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? [];

    expect(prepared.diagnostics?.aggregateToolResultTruncationCount).toBeGreaterThan(0);
    expect(results.map((result) => [result.toolUseId, result.status])).toEqual([
      ["call-0", "success"],
      ["call-1", "success"],
      ["call-2", "success"],
      ["call-3", "error"],
    ]);
    expect(results.reduce((total, result) => total + result.content.reduce((sum, part) => sum + (part.text?.length ?? 0), 0), 0)).toBeLessThanOrEqual(
      KIRO_MAX_CURRENT_TOOL_RESULT_TEXT_CHARS + 3 * "... [TRUNCATED] ...".length,
    );
  });

  it("retains the declaring tool-use exchange when byte pruning current tool results", () => {
    const messages: Message[] = [];
    for (let index = 0; index < 5; index += 1) {
      messages.push(
        { role: "user", content: `old-user-${index}-${"x".repeat(100_000)}`, timestamp: index * 2 + 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: `old-assistant-${index}-${"x".repeat(100_000)}` }],
          api: "kiro-api",
          provider: "kiro",
          model: "claude-sonnet-4",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: index * 2 + 2,
        },
      );
    }
    messages.push(
      { role: "user", content: "run the protected tool", timestamp: 20 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "protected-call", name: "read_file", arguments: { path: "/tmp/file" } }],
        api: "kiro-api",
        provider: "kiro",
        model: "claude-sonnet-4",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 21,
      },
      {
        role: "toolResult",
        toolCallId: "protected-call",
        toolName: "read_file",
        content: [{ type: "text", text: "result".repeat(20_000) }],
        isError: false,
        timestamp: 22,
      },
    );

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      contextWindow: 400_000,
      context: { messages },
    });
    const history = prepared.payload.conversationState.history ?? [];
    const resultIds = new Set(
      prepared.payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(
        (result) => result.toolUseId,
      ),
    );
    const historyToolUseIds = new Set(
      history.flatMap((entry) => entry.assistantResponseMessage?.toolUses?.map((toolUse) => toolUse.toolUseId) ?? []),
    );

    expect(prepared.diagnostics?.prunedHistoryMessageCount).toBeGreaterThan(0);
    expect([...resultIds].every((id) => historyToolUseIds.has(id))).toBe(true);
    expect(history.some((entry) => entry.userInputMessage?.content === "run the protected tool")).toBe(true);
  });

  it("fails closed when protected current content or profileArn exceeds the byte guardrail", () => {
    const oversizedPrompt = "x".repeat(KIRO_MAX_REQUEST_BODY_BYTES);
    expect(() => adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: { messages: [{ role: "user", content: oversizedPrompt, timestamp: 1 }] },
    })).toThrow("context_length_exceeded");

    expect(() => adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials: { ...credentials, profileArn: "a".repeat(KIRO_MAX_REQUEST_BODY_BYTES) },
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    })).toThrow("context_length_exceeded");
  });

  it("scales history allocation from model context without changing the body guardrail", () => {
    expect(getKiroHistoryByteBudget()).toBe(500_000);
    expect(getKiroHistoryByteBudget(200_000)).toBe(850_000);
    expect(getKiroHistoryByteBudget(400_000)).toBe(1_700_000);

    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      contextWindow: 400_000,
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });
    expect(prepared.diagnostics).toMatchObject({ historyByteBudget: 1_700_000, maxRequestBodyBytes: KIRO_MAX_REQUEST_BODY_BYTES });
  });

  it("maps Node platforms onto the operating systems Kiro accepts", () => {
    // Kiro answers REQUEST_BODY_INVALID for any other value, including raw "darwin"/"win32".
    expect(mapNodePlatformToKiroOperatingSystem("darwin")).toBe("macos");
    expect(mapNodePlatformToKiroOperatingSystem("win32")).toBe("windows");
    expect(mapNodePlatformToKiroOperatingSystem("linux")).toBe("linux");
    expect(mapNodePlatformToKiroOperatingSystem("freebsd")).toBeUndefined();
  });

  it("never sends a raw Node platform in the CLI envState", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      requestMode: "cli",
      context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    });

    const envState = prepared.payload.conversationState.currentMessage.userInputMessage
      .userInputMessageContext?.envState;
    expect(envState?.currentWorkingDirectory).toBe(process.cwd());
    if (envState?.operatingSystem !== undefined) {
      expect(["linux", "macos", "windows"]).toContain(envState.operatingSystem);
    }
  });
});
