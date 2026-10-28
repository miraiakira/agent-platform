import { describe, expect, it } from "vitest";
import { readSSE } from "./sse";

describe("readSSE", () => {
  it("handles split UTF-8 chunks and SSE frames", async () => {
    const bytes = new TextEncoder().encode(
      'event: text-delta\ndata: {"type":"text-delta","text":"你好"}\n\n' +
      'event: done\ndata: {"type":"done"}\n\n',
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliberately split every UTF-8 byte.
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]));
        }

        controller.close();
      },
    });

    const events = [];

    for await (const event of readSSE(stream)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "你好" },
      { type: "done" },
    ]);
  });

  it("rejects an incomplete frame", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"done"}',
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const consume = async () => {
      for await (const _event of readSSE(stream)) {
        // Consume.
      }
    };

    await expect(consume()).rejects.toThrow(
      "Incomplete SSE frame",
    );
  });
});