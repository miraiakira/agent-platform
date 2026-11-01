import { createBusinessTools } from "@eap/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelProvider, DeepSeekProvider, AgentRunner } from "../src";

afterEach(() => vi.unstubAllGlobals());

function mockResponse(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const config = { apiKey: "test-key", model: "test-model" };
const messages = [{ role: "user" as const, content: "Hello" }];

describe("DeepSeekProvider", () => {
  it("sends Chat Completions requests and normalizes text and usage", async () => {
    const fetch = mockResponse({
      id: "completion-1",
      model: "test-model",
      choices: [{ message: { role: "assistant", content: "Hello back" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    const provider = createModelProvider({ provider: "deepseek", ...config });
    expect(await provider.generate({ messages })).toEqual({
      id: "completion-1",
      model: "test-model",
      provider: "deepseek",
      content: "Hello back",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.deepseek.com/chat/completions");
    expect(JSON.parse(init.body)).toEqual({ model: config.model, messages, stream: false });
  });

  it("supports a custom base URL and missing usage", async () => {
    const fetch = mockResponse({ id: "1", model: config.model, choices: [{ message: { content: "OK" } }] });
    const provider = new DeepSeekProvider({ ...config, baseURL: "https://example.com/v1" });
    expect((await provider.generate({ messages })).usage).toBeUndefined();
    expect(String(fetch.mock.calls[0][0])).toBe("https://example.com/v1/chat/completions");
  });

  it.each([{ choices: [] }, { choices: [{ message: { content: null } }] }])("rejects missing text: %j", async ({ choices }) => {
    mockResponse({ id: "1", model: config.model, choices });
    await expect(new DeepSeekProvider(config).generate({ messages })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([[401, "AUTH_ERROR"], [429, "RATE_LIMIT"], [500, "PROVIDER_ERROR"]])("maps HTTP %s to %s", async (status, code) => {
    mockResponse({ error: { message: "Provider error" } }, status as number);
    await expect(new DeepSeekProvider(config).generate({ messages })).rejects.toMatchObject({ code });
  });

  it("does not send an already cancelled request", async () => {
    const fetch = mockResponse({});
    await expect(new DeepSeekProvider(config).generate({ messages, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an API key and model", () => {
    expect(() => createModelProvider({ provider: "deepseek" })).toThrow("Missing LLM_API_KEY or LLM_MODEL");
    expect(() => new DeepSeekProvider({ ...config, apiKey: "" })).toThrow("Missing API key or model");
  });

  it("cancels a request after fetch has started", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new DOMException("Request aborted", "AbortError"));
        }, { once: true });
        queueMicrotask(() => controller.abort());
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(new DeepSeekProvider(config).generate({
      messages,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "CANCELLED", statusCode: 499 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps an SDK request timeout to TIMEOUT", async () => {
    const fetch = vi.fn((_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => {
          reject(new DOMException("Request aborted", "AbortError"));
        }, { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(new DeepSeekProvider(config).generate({
      messages,
      signal: controller.signal,
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "TIMEOUT", statusCode: 504 });
    expect(controller.signal.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a network connection failure to PROVIDER_ERROR", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetch);

    await expect(new DeepSeekProvider(config).generate({ messages }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR", statusCode: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  
  it("streams text deltas and usage", async () => {
  const chunks = [
    {
      id: "stream-1",
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { content: "你好" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "stream-1",
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: { content: "，世界" },
          finish_reason: null,
        },
      ],
    },
    {
      id: "stream-1",
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
    },
  ];

  const sse =
    chunks.map((chunk) =>
      `data: ${JSON.stringify(chunk)}\n\n`,
    ).join("") + "data: [DONE]\n\n";

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(sse, {
        headers: {
          "content-type": "text/event-stream",
        },
      }),
    ),
  );

  const provider = new DeepSeekProvider(config);
  const events = [];

  for await (const event of provider.stream({ messages })) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: "text-delta", text: "你好" },
    { type: "text-delta", text: "，世界" },
    {
      type: "usage",
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      },
    },
    { type: "done" },
  ]);
  });

  it("maps stream failures to PROVIDER_ERROR", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Connection lost"));
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    );

    const provider = new DeepSeekProvider(config);

    const consume = async () => {
      for await (const _event of provider.stream({
        messages,
      })) {
        // Consume the stream.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("sends tools and normalizes tool calls", async () => {
    const fetch = mockResponse({
      id: "completion-tool-1",
      model: config.model,
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "get_transactions",
                  arguments: '{"limit":3}',
                },
              },
            ],
          },
        },
      ],
    });

    const provider = new DeepSeekProvider(config);

    const result = await provider.generateWithTools({
      messages,
      tools: [
        {
          name: "get_transactions",
          description: "Query transactions",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer" },
            },
            required: ["limit"],
          },
        },
      ],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe(
      "get_transactions",
    );

    const requestBody = JSON.parse(
      fetch.mock.calls[0][1].body,
    );

    expect(requestBody.tools[0].function.name).toBe(
      "get_transactions",
    );

    expect(requestBody.tool_choice).toBe("auto");
  });
});



function chatStream(deltas: unknown[], finishReason = "tool_calls") {
  const frames: unknown[] = deltas.map((delta) => ({ id: "test-stream", model: "test-model", choices: [{ index: 0, delta, finish_reason: null }] }));
  frames.push({ id: "test-stream", model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } });
}

describe("DeepSeek streamed tool argument regression", () => {
  it.each([undefined, null])("preserves continuation arguments when type is %s", async (type) => {
    const fragments = ['{"date":', '"2026-11-01",', '"limit":3}'];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatStream([
      { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_high_risk_transactions", arguments: "" } }] },
      ...fragments.map((arguments_) => ({ tool_calls: [{ index: 0, type, function: { arguments: arguments_ } }] })),
    ])));
    const events = [];
    for await (const event of new DeepSeekProvider(config).streamWithTools({ messages, tools: [] })) events.push(event);
    const calls = events.filter((event) => event.type === "tool-call-delta");
    expect(calls.map((call) => call.arguments).join("")).toBe(fragments.join(""));
    expect(JSON.parse(calls.map((call) => call.arguments).join(""))).toEqual({ date: "2026-11-01", limit: 3 });
  });

  it("rejects unsupported explicit tool types", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(chatStream([{ tool_calls: [{ index: 0, type: "custom" }] }])));
    const consume = async () => {
      for await (const event of new DeepSeekProvider(config).streamWithTools({ messages, tools: [] })) void event;
    };
    await expect(consume()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("runs the real provider parser and runner through a fragmented tool call to a final answer", async () => {
    const modelFetch = vi.fn()
      .mockResolvedValueOnce(chatStream([
        { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "get_high_risk_transactions", arguments: "" } }] },
        { tool_calls: [{ index: 0, function: { arguments: '{"date":"2026-11-01",' } }] },
        { tool_calls: [{ index: 0, id: "", function: { name: "", arguments: '"limit":3}' } }] },
      ]))
      .mockResolvedValueOnce(chatStream([{ content: "Ready to answer" }], "stop"))
      .mockResolvedValueOnce(chatStream([{ content: "No high-risk transactions found" }], "stop"));
    vi.stubGlobal("fetch", modelFetch);
    const businessFetch = vi.fn(async () => Response.json({ items: [], total: 0 }));
    const tools = createBusinessTools({ authorize: async () => ({ tenantId: "test-tenant", actorUserId: "test-actor", policyVersion: 1 }), baseURL: "http://business.test", fetchImpl: businessFetch });
    const runner = new AgentRunner({ provider: new DeepSeekProvider(config), tools, budget: { maxModelCalls: 5 } });
    const events = [];
    for await (const event of runner.run({ messages })) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events).toContainEqual({ type: "text-delta", text: "No high-risk transactions found" });
    expect(events).toContainEqual({ type: "tool-result", toolCallId: "call-1", toolName: "get_high_risk_transactions", success: true, attempts: 1 });
    expect(businessFetch).toHaveBeenCalledOnce();
    expect(modelFetch).toHaveBeenCalledTimes(3);
    const secondBody = JSON.parse(modelFetch.mock.calls[1][1].body);
    expect(secondBody.messages).toContainEqual({ role: "tool", tool_call_id: "call-1", content: '{"items":[],"total":0}' });
  });
});
