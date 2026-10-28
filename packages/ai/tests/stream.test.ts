import { describe, expect, it } from "vitest";

import {
  AIService,
  MockProvider,
  encodeSSE,
} from "../src";

describe("AI streaming", () => {
  it("streams mock text and completes", async () => {
    const service = new AIService(new MockProvider());
    const events = [];

    for await (const event of service.stream({
      messages: [
        { role: "user", content: "你好" },
      ],
    })) {
      events.push(event);
    }

    const text = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("");

    expect(text).toBe("Mock response: 你好");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("encodes valid SSE frames", () => {
    expect(
      encodeSSE({
        type: "text-delta",
        text: "你好",
      }),
    ).toBe(
      'event: text-delta\ndata: {"type":"text-delta","text":"你好"}\n\n',
    );
  });

  it("rejects a pre-cancelled mock stream", async () => {
    const provider = new MockProvider();

    const consume = async () => {
      for await (const _event of provider.stream({
        messages: [
          { role: "user", content: "Hello" },
        ],
        signal: AbortSignal.abort(),
      })) {
        // Consume.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});