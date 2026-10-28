export type ChatStreamEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "usage";
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | { type: "done" }
  | { type: "error"; code: string; message: string }
  | {
    type: "tool-start";
    toolCallId: string;
    toolName: string;
  }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      success: boolean;
    };

export async function* readSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, {
        stream: true,
      });

      // Normalize CRLF and CR line endings.
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary: number;

      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (!data || data === "[DONE]") continue;

        const event = JSON.parse(data) as ChatStreamEvent;
        yield event;
      }
    }

    // A successful stream must contain a complete terminal frame.
    // Do not silently accept an unfinished SSE event.
    if (buffer.trim()) {
      throw new Error("Incomplete SSE frame");
    }
  } finally {
    reader.releaseLock();
  }
}