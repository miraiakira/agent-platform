import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { z } from "zod";
import { ToolRegistry } from "@eap/tools";

import { AgentRunner } from "../src/agent-runner";
import type {
  ModelProvider,
  ModelToolStreamEvent,
  StreamEvent,
} from "../src/types";

function makeTools() {
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

  return { registry, execute };
}

function makeProvider() {
  let call = 0;

  const streamWithTools = vi.fn(
    async function* (): AsyncIterable<ModelToolStreamEvent> {
      call++;

      if (call === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "call-1",
          name: "get_transactions",
          arguments: "{",
        };

        yield {
          type: "tool-call-delta",
          index: 0,
          arguments: "}",
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
        text: "TX-1001",
      };

      yield {
        type: "text-delta",
        text: " risk score 95",
      };

      yield { type: "done" };
    },
  );

  const provider = {
    name: "test",
    streamWithTools,
    streamAgentFinal,
  } as unknown as ModelProvider;

  return {
    provider,
    streamWithTools,
    streamAgentFinal,
  };
}

describe("AgentRunner V2", () => {
  it("executes tools then streams final model output", async () => {
    const { registry, execute } = makeTools();
    const model = makeProvider();

    const onTrace = vi.fn();

    const runner = new AgentRunner({
      provider: model.provider,
      tools: registry,
      onTrace,
    });

    const events: StreamEvent[] = [];

    for await (const event of runner.run({
      messages: [
        { role: "user", content: "Check risks" },
      ],
    })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledOnce();

    expect(
      model.streamWithTools,
    ).toHaveBeenCalledTimes(2);

    expect(
      model.streamAgentFinal,
    ).toHaveBeenCalledOnce();

    expect(
      events.filter(
        (event) => event.type === "text-delta",
      ),
    ).toEqual([
      { type: "text-delta", text: "TX-1001" },
      {
        type: "text-delta",
        text: " risk score 95",
      },
    ]);

    expect(events.at(-1)).toEqual({
      type: "done",
    });

    expect(onTrace).toHaveBeenCalledOnce();

    const trace = onTrace.mock.calls[0][0];

    expect(trace.modelCalls).toBe(3);
    expect(trace.toolCalls).toBe(1);
    expect(trace.spans).toHaveLength(4);
  });

  it("rejects tool calls beyond budget", async () => {
    const { registry, execute } = makeTools();

    const provider = {
      name: "test",
      streamWithTools: async function* () {
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
      },
    } as unknown as ModelProvider;

    const runner = new AgentRunner({
      provider,
      tools: registry,
      budget: {
        maxToolCalls: 0,
      },
    });

    const events: StreamEvent[] = [];

    for await (const event of runner.run({
      messages: [
        { role: "user", content: "Check risks" },
      ],
    })) {
      events.push(event);
    }

    expect(execute).not.toHaveBeenCalled();

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "TOOL_BUDGET_EXCEEDED",
    });
  });
});