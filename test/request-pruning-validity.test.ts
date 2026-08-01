import type { AssistantMessage, Context, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { adaptPiContextToKiroRequest } from "../extensions/kiro/request";
import type { KiroConversationMessage, KiroOAuthCredentials, KiroRequestPayload } from "../extensions/kiro/types";

const credentials = {
  refresh: "r",
  access: "a",
  expires: 1,
  authMode: "builder-id",
  region: "us-east-1",
  oidcRegion: "us-east-1",
} as KiroOAuthCredentials;

const big = (n: number) => "x".repeat(n);

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantToolCall(id: string, name: string, text = "calling"): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      { type: "toolCall", id, name, arguments: { q: 1 } },
    ],
    api: "kiro-api",
    provider: "kiro",
    model: "claude-sonnet-4",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  };
}

function toolResult(id: string, text: string): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 3 };
}

/** Validate the emitted conversation the way the Kiro service does. */
function findStructuralViolations(payload: KiroRequestPayload): string[] {
  const problems: string[] = [];
  const history = payload.conversationState.history ?? [];
  const full: KiroConversationMessage[] = [
    ...history,
    { userInputMessage: payload.conversationState.currentMessage.userInputMessage },
  ];
  const roleOf = (m: KiroConversationMessage) => (m.userInputMessage ? "user" : m.assistantResponseMessage ? "assistant" : "?");

  if (history.length > 0 && roleOf(history[0]!) !== "user") {
    problems.push(`history[0] is ${roleOf(history[0]!)}, expected user`);
  }
  for (let i = 1; i < full.length; i += 1) {
    if (roleOf(full[i]!) === roleOf(full[i - 1]!)) problems.push(`consecutive ${roleOf(full[i]!)} at ${i - 1}/${i}`);
  }
  for (let i = 0; i < full.length; i += 1) {
    const a = full[i]!.assistantResponseMessage;
    if (a?.toolUses?.length) {
      const ids = new Set((full[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults ?? []).map((r) => r.toolUseId));
      for (const tu of a.toolUses) if (!ids.has(tu.toolUseId)) problems.push(`assistant.toolUse ${tu.toolUseId} at ${i} unanswered`);
    }
    const results = full[i]!.userInputMessage?.userInputMessageContext?.toolResults ?? [];
    if (results.length) {
      const useIds = new Set(full[i - 1]?.assistantResponseMessage?.toolUses?.map((t) => t.toolUseId) ?? []);
      for (const r of results) if (!useIds.has(r.toolUseId)) problems.push(`toolResult ${r.toolUseId} at ${i} orphaned`);
    }
  }
  return problems;
}

function prepare(messages: Message[], contextWindow: number): KiroRequestPayload {
  const prepared = adaptPiContextToKiroRequest({
    modelId: "claude-sonnet-4",
    context: { messages, systemPrompt: "You are a coding assistant.", tools: [] } as Context,
    credentials,
    conversationId: "repro",
    contextWindow,
  });
  return prepared.payload;
}

describe("Kiro request stays structurally valid under history pruning (REQUEST_BODY_INVALID regression)", () => {
  it("does not orphan the current tool-result turn when pruning strips its owning assistant", () => {
    // Several large tool exchanges, ending on a tool result as the current turn. A tiny context
    // window forces the byte-prune path to drop the oldest exchanges — including, before the fix,
    // the assistant that owns the current turn's tool result.
    const messages: Message[] = [user("start " + big(2000))];
    for (let i = 0; i < 5; i += 1) {
      const id = `tooluse_${i}`;
      messages.push(assistantToolCall(id, "bash"));
      messages.push(toolResult(id, big(6000)));
    }
    // Current turn = trailing tool result whose owning assistant is early and prunable.
    const payload = prepare(messages, 4000);
    expect(findStructuralViolations(payload)).toEqual([]);
    // The current turn's tool result must still be answered by a preceding assistant turn.
    const history = payload.conversationState.history ?? [];
    expect(history.length).toBeGreaterThan(0);
  });

  it("does not emit consecutive user turns when history ends on a tool-result turn", () => {
    // assistant->toolResult->user with no intervening assistant: history ends on a tool-result
    // (user) turn, and the current turn is also a user turn.
    const messages: Message[] = [
      user("q1"),
      assistantToolCall("tooluse_a", "bash"),
      toolResult("tooluse_a", "result"),
      user("q2 follow-up"),
    ];
    const payload = prepare(messages, 200000);
    expect(findStructuralViolations(payload)).toEqual([]);
  });

  it("keeps a valid user head after pruning drops the leading exchange", () => {
    const messages: Message[] = [user("intro " + big(3000))];
    for (let i = 0; i < 6; i += 1) {
      const id = `tooluse_h${i}`;
      messages.push(assistantToolCall(id, "bash"));
      messages.push(toolResult(id, big(5000)));
      messages.push(user(`turn ${i} ` + big(1000)));
    }
    const payload = prepare(messages, 6000);
    expect(findStructuralViolations(payload)).toEqual([]);
  });
});
