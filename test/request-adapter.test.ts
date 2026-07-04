import { Type } from "@sinclair/typebox";
import type { Message } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import {
  adaptPiContextToKiroRequest,
  buildKiroRequestEndpoint,
  convertPiToolDefinitions,
  convertToolResultMessageToKiroMessage,
  mapThinkingLevelToKiroThinkingConfig,
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
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.content).toBe(
      "<thinking_mode>enabled</thinking_mode><max_thinking_length>16384</max_thinking_length>\nBe careful.\n\nSolve this carefully.",
    );
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

    expect(payloadText.length).toBeLessThan(650_000);
    expect(firstHistoryUser?.content.startsWith("user-0-")).toBe(false);
    expect(prepared.payload.conversationState.currentMessage.userInputMessage.content).toBe("latest question");
  });
});
