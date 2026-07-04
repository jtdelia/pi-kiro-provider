import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
  adaptPiContextToKiroRequest,
  convertPiToolDefinitions,
  normalizeKiroMessages,
} from "../extensions/kiro/request";
import { convertKiroStreamEventsToAssistantEvents } from "../extensions/kiro/stream";
import type { KiroOAuthCredentials } from "../extensions/kiro/types";

const model = {
  api: "kiro-api",
  provider: "kiro",
  id: "claude-sonnet-4",
} as const;

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

describe("kiro tool-call support", () => {
  it("converts tool definitions correctly", () => {
    expect(
      convertPiToolDefinitions([
        {
          name: "read_file",
          description: "Read a file from disk",
          parameters: Type.Object({
            path: Type.String(),
            offset: Type.Optional(Type.Number()),
          }),
        },
      ]),
    ).toEqual([
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

  it("a streamed tool call becomes a valid pi tool call", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        {
          toolUseEvent: {
            toolUseId: "call-1",
            name: "read_file",
            input: '{"path":"src/index.ts"}',
            stop: true,
          },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("toolUse");
      expect(done.message.content).toEqual([
        {
          type: "toolCall",
          id: "call-1",
          name: "read_file",
          arguments: { path: "src/index.ts" },
        },
      ]);
    }
  });

  it("partial tool-call JSON is accumulated correctly", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        {
          toolUseEvent: {
            toolUseId: "call-2",
            name: "read_file",
            input: '{"path":"src/',
          },
        },
        {
          toolUseEvent: {
            toolUseId: "call-2",
            input: 'index.ts","offset":12}',
            stop: true,
          },
        },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
        { type: "message_stop" },
      ],
    });

    expect(events.filter((event) => event.type === "toolcall_delta")).toHaveLength(2);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.content).toEqual([
        {
          type: "toolCall",
          id: "call-2",
          name: "read_file",
          arguments: {
            path: "src/index.ts",
            offset: 12,
          },
        },
      ]);
    }
  });

  it("malformed tool-call JSON surfaces a clear error", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        {
          toolUseEvent: {
            toolUseId: "call-3",
            name: "read_file",
            input: '{"path":',
            stop: true,
          },
        },
      ],
    });

    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.reason).toBe("error");
      expect(terminal.error.errorMessage).toContain("Malformed Kiro tool call arguments");
      expect(terminal.error.content).toEqual([
        {
          type: "toolCall",
          id: "call-3",
          name: "read_file",
          arguments: {},
        },
      ]);
    }
  });

  it("tool result follow-up requests convert correctly", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          {
            role: "user",
            content: "Inspect the file",
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-4",
                name: "read_file",
                arguments: { path: "src/index.ts" },
              },
            ],
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
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call-4",
            toolName: "read_file",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
            timestamp: 3,
          },
        ],
      },
    });

    expect(prepared.payload.conversationState.history).toEqual([
      {
        userInputMessage: {
          content: "Inspect the file",
          modelId: "claude-sonnet-4",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "",
          toolUses: [
            {
              toolUseId: "call-4",
              name: "read_file",
              input: { path: "src/index.ts" },
            },
          ],
        },
      },
    ]);

    expect(prepared.payload.conversationState.currentMessage.userInputMessage).toEqual({
      content: "file contents",
      modelId: "claude-sonnet-4",
      origin: "AI_EDITOR",
      userInputMessageContext: {
        toolResults: [
          {
            toolUseId: "call-4",
            content: [{ text: "file contents" }],
            status: "success",
          },
        ],
        tools: [
          {
            toolSpecification: {
              name: "read_file",
              description: "Tool",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {},
                },
              },
            },
          },
        ],
      },
    });
  });

  it("aggregates consecutive tool results into one current message", () => {
    const prepared = adaptPiContextToKiroRequest({
      modelId: "claude-sonnet-4",
      credentials,
      context: {
        messages: [
          {
            role: "user",
            content: "Investigate Archon",
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-ls",
                name: "bash",
                arguments: { command: "ls -la" },
              },
              {
                type: "toolCall",
                id: "call-help",
                name: "bash",
                arguments: { command: "archon --help" },
              },
            ],
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
            stopReason: "toolUse",
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "call-ls",
            toolName: "bash",
            content: [{ type: "text", text: "total 8" }],
            isError: false,
            timestamp: 3,
          },
          {
            role: "toolResult",
            toolCallId: "call-help",
            toolName: "bash",
            content: [{ type: "text", text: "Usage: archon" }],
            isError: false,
            timestamp: 4,
          },
        ],
      },
    });

    expect(prepared.payload.conversationState.history).toEqual([
      {
        userInputMessage: {
          content: "Investigate Archon",
          modelId: "claude-sonnet-4",
          origin: "AI_EDITOR",
        },
      },
      {
        assistantResponseMessage: {
          content: "",
          toolUses: [
            {
              toolUseId: "call-ls",
              name: "bash",
              input: { command: "ls -la" },
            },
            {
              toolUseId: "call-help",
              name: "bash",
              input: { command: "archon --help" },
            },
          ],
        },
      },
    ]);

    expect(prepared.payload.conversationState.currentMessage.userInputMessage).toEqual({
      content: "total 8\n\nUsage: archon",
      modelId: "claude-sonnet-4",
      origin: "AI_EDITOR",
      userInputMessageContext: {
        toolResults: [
          {
            toolUseId: "call-ls",
            content: [{ text: "total 8" }],
            status: "success",
          },
          {
            toolUseId: "call-help",
            content: [{ text: "Usage: archon" }],
            status: "success",
          },
        ],
        tools: [
          {
            toolSpecification: {
              name: "bash",
              description: "Tool",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {},
                },
              },
            },
          },
        ],
      },
    });
  });

  it("inserts synthetic tool results before a later user message when tool results are missing", () => {
    const normalized = normalizeKiroMessages([
      {
        role: "user",
        content: "Inspect the file",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-missing",
            name: "read_file",
            arguments: { path: "src/index.ts" },
          },
        ],
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
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "user",
        content: "Please continue",
        timestamp: 3,
      },
    ]);

    expect(normalized).toEqual([
      {
        role: "user",
        content: "Inspect the file",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-missing",
            name: "read_file",
            arguments: { path: "src/index.ts" },
          },
        ],
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
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-missing",
        toolName: "read_file",
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: expect.any(Number),
      },
      {
        role: "user",
        content: "Please continue",
        timestamp: 3,
      },
    ]);
  });

  it("inserts synthetic tool results when the conversation ends with an assistant tool use", () => {
    const normalized = normalizeKiroMessages([
      {
        role: "user",
        content: "Inspect the file",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-final",
            name: "read_file",
            arguments: { path: "src/index.ts" },
          },
        ],
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
        stopReason: "toolUse",
        timestamp: 2,
      },
    ]);

    expect(normalized).toEqual([
      {
        role: "user",
        content: "Inspect the file",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-final",
            name: "read_file",
            arguments: { path: "src/index.ts" },
          },
        ],
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
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-final",
        toolName: "read_file",
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: expect.any(Number),
      },
    ]);
  });
});
