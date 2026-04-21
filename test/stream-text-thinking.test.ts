import { describe, expect, it } from "vitest";

import {
  convertKiroStreamChunksToAssistantEvents,
  convertKiroStreamEventsToAssistantEvents,
} from "../extensions/kiro/stream";

const model = {
  api: "kiro-api",
  provider: "kiro",
  id: "claude-sonnet-4",
} as const;

describe("kiro stream adapter", () => {
  it("plain text stream emits correct event order", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      timestamp: 123,
      events: [
        { assistantResponseEvent: { content: "Hello " } },
        { assistantResponseEvent: { content: "world" } },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_creation_input_tokens: 1,
            cache_read_input_tokens: 3,
          },
        },
        { type: "message_stop" },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("stop");
      expect(done.message.content).toEqual([{ type: "text", text: "Hello world" }]);
      expect(done.message.usage).toMatchObject({
        input: 10,
        output: 2,
        cacheWrite: 1,
        cacheRead: 3,
        totalTokens: 16,
      });
    }
  });

  it("thinking stream emits correct event order", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        { assistantResponseEvent: { content: "<thinking>Plan" } },
        { assistantResponseEvent: { content: " carefully</thinking>" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "done",
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.content).toEqual([{ type: "thinking", thinking: "Plan carefully" }]);
    }
  });

  it("mixed text and thinking blocks are reconstructed correctly", () => {
    const events = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        { assistantResponseEvent: { content: "Answer: <thinking>consider" } },
        { assistantResponseEvent: { content: " options</thinking> final" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "thinking_start",
      "thinking_delta",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.content).toEqual([
        { type: "text", text: "Answer: " },
        { type: "thinking", thinking: "consider options" },
        { type: "text", text: " final" },
      ]);
    }
  });

  it("raw SSE chunks are parsed and converted correctly", () => {
    const events = convertKiroStreamChunksToAssistantEvents({
      model,
      chunks: [
        'data: {"assistantResponseEvent":{"content":"Hi"}}\n\n',
        'data: {"assistantResponseEvent":{"content":" there"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        "data: [DONE]\n\n",
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.content).toEqual([{ type: "text", text: "Hi there" }]);
    }
  });

  it("error and abort states produce the correct terminal events", () => {
    const errorEvents = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        { assistantResponseEvent: { content: "Oops" } },
        { type: "error", message: "boom" },
      ],
    });
    const error = errorEvents.at(-1);
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.reason).toBe("error");
      expect(error.error.errorMessage).toBe("boom");
      expect(error.error.content).toEqual([{ type: "text", text: "Oops" }]);
    }

    const abortedEvents = convertKiroStreamEventsToAssistantEvents({
      model,
      events: [
        { assistantResponseEvent: { content: "Partial" } },
        { type: "aborted", message: "cancelled by user" },
      ],
    });
    const aborted = abortedEvents.at(-1);
    expect(aborted?.type).toBe("error");
    if (aborted?.type === "error") {
      expect(aborted.reason).toBe("aborted");
      expect(aborted.error.errorMessage).toBe("cancelled by user");
      expect(aborted.error.content).toEqual([{ type: "text", text: "Partial" }]);
    }
  });
});
