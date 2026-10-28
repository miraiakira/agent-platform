import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../src";
import { ToolRegistry } from "@eap/tools";
import type { ModelProvider } from "../src";

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

    const generateWithTools = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "get_transactions",
              arguments: "{}",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "TX-1001 has a risk score of 95.",
        finishReason: "stop",
        toolCalls: [],
      });

    const provider = {
      name: "test",
      generateWithTools,
    } as unknown as ModelProvider;

    const runner = new AgentRunner({
      provider,
      tools: registry,
    });

    const events = [];

    for await (const event of runner.run({
      messages: [
        { role: "user", content: "Check transactions" },
      ],
    })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledOnce();
    expect(generateWithTools).toHaveBeenCalledTimes(2);

    const secondCall = generateWithTools.mock.calls[1][0];

    expect(secondCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: expect.any(Array),
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-1",
        }),
      ]),
    );

    expect(events).toContainEqual({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "get_transactions",
      success: true,
    });

    expect(events.at(-1)).toEqual({
      type: "done",
    });
  });

  it("stops after the maximum model calls", async () => {
    const registry = new ToolRegistry();

    registry.register({
      name: "repeat",
      description: "Repeat",
      schema: z.object({}).strict(),
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({ ok: true }),
    });

    const provider = {
      name: "test",
      generateWithTools: vi.fn().mockResolvedValue({
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-repeat",
            type: "function",
            function: {
              name: "repeat",
              arguments: "{}",
            },
          },
        ],
      }),
    } as unknown as ModelProvider;

    const runner = new AgentRunner({
      provider,
      tools: registry,
      maxModelCalls: 2,
    });

    const events = [];

    for await (const event of runner.run({
      messages: [{ role: "user", content: "Repeat" }],
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "MAX_MODEL_CALLS",
    });
  });
});