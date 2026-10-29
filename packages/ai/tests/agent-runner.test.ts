import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../src";
import { ToolRegistry } from "@eap/tools";

import type {
  ModelProvider,
  ModelToolStreamEvent,
  StreamWithToolsOptions,
  StreamEvent,
} from "../src/types";

describe("AgentRunner", () => {
  it("executes a tool and returns the final answer", async () => {
    const registry = new ToolRegistry();

    const execute = vi.fn(async () => ({
      items: [{ id: "TX-1001", risk_score: 95 }],
    }));

    registry.register({
      name: "get_transactions",
      description: "Query transactions",
      schema: z.object({}).strict(),
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute,
    });

    const streamWithTools = vi.fn(
      async function* (
        options: StreamWithToolsOptions,
      ): AsyncIterable<ModelToolStreamEvent> {
        const hasToolResult = options.messages.some(
          (message) => message.role === "tool",
        );

        if (!hasToolResult) {
          yield {
            type: "tool-call-delta",
            index: 0,
            id: "call-1",
            name: "get_transactions",
            arguments: "{}",
          };

          yield {
            type: "model-finish",
            finishReason: "tool_calls",
          };

          return;
        }

        yield {
          type: "model-finish",
          finishReason: "stop",
        };
      },
    );

    const streamAgentFinal = vi.fn(
      async function* (): AsyncIterable<StreamEvent> {
        yield {
          type: "text-delta",
          text: "Found high-risk transactions",
        };

        yield {
          type: "done",
        };
      },
    );

    const provider = {
      name: "test",
      streamWithTools,
      streamAgentFinal,
    } as unknown as ModelProvider;

    const runner = new AgentRunner({
      provider,
      tools: registry,
    });

    const events: StreamEvent[] = [];

    for await (const event of runner.run({
      messages: [
        {
          role: "user",
          content: "Check transactions",
        },
      ],
    })) {
      events.push(event);
    }

    // 工具执行一次
    expect(execute).toHaveBeenCalledOnce();

    // 两次决策阶段模型调用
    expect(streamWithTools).toHaveBeenCalledTimes(2);

    // 一次最终回答模型调用
    expect(streamAgentFinal).toHaveBeenCalledOnce();

    // 验证第二次模型调用包含工具历史
    const secondCall = streamWithTools.mock.calls[1]?.[0];

    expect(secondCall).toBeDefined();

    expect(secondCall?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "call-1",
              type: "function",
              function: {
                name: "get_transactions",
                arguments: "{}",
              },
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
          content: expect.any(String),
        }),
      ]),
    );

    // 验证工具执行结果事件
    expect(events).toContainEqual({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "get_transactions",
      success: true,
      attempts: 1,
    });

    // 验证最终回答来自 Streaming
    expect(events).toContainEqual({
      type: "text-delta",
      text: "Found high-risk transactions",
    });

    // 正常结束
    expect(events.at(-1)).toEqual({
      type: "done",
    });
  });

  it("stops after the maximum model calls", async () => {
    const registry = new ToolRegistry();

    const execute = vi.fn(async () => ({
      ok: true,
    }));

    registry.register({
      name: "repeat",
      description: "Repeat",
      schema: z.object({}).strict(),
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute,
    });

    let callIndex = 0;

    const streamWithTools = vi.fn(
      async function* (
        _options: StreamWithToolsOptions,
      ): AsyncIterable<ModelToolStreamEvent> {
        callIndex++;

        // 每次模型调用都要求继续执行工具
        yield {
          type: "tool-call-delta",
          index: 0,
          id: `call-${callIndex}`,
          name: "repeat",
          arguments: "{}",
        };

        yield {
          type: "model-finish",
          finishReason: "tool_calls",
        };
      },
    );

    const streamAgentFinal = vi.fn(
      async function* (): AsyncIterable<StreamEvent> {
        yield {
          type: "text-delta",
          text: "Should not reach final answer",
        };

        yield { type: "done" };
      },
    );

    const provider = {
      name: "test",
      streamWithTools,
      streamAgentFinal,
    } as unknown as ModelProvider;

    const runner = new AgentRunner({
      provider,
      tools: registry,
      budget: {
        maxModelCalls: 2,
        maxToolCalls: 10,
      },
    });

    const events: StreamEvent[] = [];

    for await (const event of runner.run({
      messages: [
        {
          role: "user",
          content: "Repeat",
        },
      ],
    })) {
      events.push(event);
    }

    // 模型始终要求调用工具，因此不能进入最终回答阶段
    expect(streamAgentFinal).not.toHaveBeenCalled();

    // 不允许超过最大模型调用次数
    expect(
      streamWithTools.mock.calls.length,
    ).toBeLessThanOrEqual(2);

    // 必须返回明确的预算错误
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "MAX_MODEL_CALLS",
    });
  });
});