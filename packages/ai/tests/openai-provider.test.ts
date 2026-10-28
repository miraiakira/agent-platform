import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider, type StreamEvent } from "../src";

afterEach(() => vi.unstubAllGlobals());

function mockStream(events: unknown[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const fetch = vi.fn().mockResolvedValue(new Response(body, {
    headers: { "content-type": "text/event-stream" },
  }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function collect() {
  const events: StreamEvent[] = [];
  const provider = new OpenAIProvider({ apiKey: "test-key", model: "test-model" });
  for await (const event of provider.stream({ messages: [{ role: "user", content: "Hello" }] })) {
    events.push(event);
  }
  return events;
}

describe("OpenAIProvider streaming", () => {
  it("maps Responses text, usage and completion to shared events", async () => {
    const fetch = mockStream([
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " back" },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
    ]);
    expect(await collect()).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " back" },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
      { type: "done" },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(init.body)).toMatchObject({ stream: true, store: false });
  });

  it.each([
    ["response.failed", "PROVIDER_ERROR"],
    ["error", "PROVIDER_ERROR"],
    ["response.incomplete", "INVALID_RESPONSE"],
  ])("rejects %s without reporting completion", async (type, code) => {
    mockStream([{ type }]);
    await expect(collect()).rejects.toMatchObject({ code });
  });

  it("rejects a stream ending without a completion event", async () => {
    mockStream([{ type: "response.output_text.delta", delta: "partial" }]);
    await expect(collect()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("completes without optional usage", async () => {
    mockStream([{ type: "response.completed", response: {} }]);
    expect(await collect()).toEqual([{ type: "done" }]);
  });

  it("does not send an already cancelled request", async () => {
    const fetch = mockStream([]);
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "test-model" });
    const stream = provider.stream({ messages: [], signal: AbortSignal.abort() });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
