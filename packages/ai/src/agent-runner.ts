import type {
  AgentMessage,
  ModelProvider,
  StreamEvent,
} from "./types";

import {
  ToolError,
  ToolRegistry,
} from "@eap/tools";

export interface AgentRunnerOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  maxModelCalls?: number;
}

export class AgentRunner {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly maxModelCalls: number;

  constructor(options: AgentRunnerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.maxModelCalls = options.maxModelCalls ?? 5;
  }

  async *run(options: {
    messages: AgentMessage[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): AsyncIterable<StreamEvent> {
    const history: AgentMessage[] = [
      ...options.messages,
    ];

    const definitions = this.tools.definitions();

    for (
      let iteration = 0;
      iteration < this.maxModelCalls;
      iteration++
    ) {
      if (options.signal?.aborted) return;

      const result = await this.provider.generateWithTools({
        messages: history,
        tools: definitions,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      if (
        result.finishReason !== "tool_calls" ||
        result.toolCalls.length === 0
      ) {
        if (result.finishReason !== "stop") {
          yield {
            type: "error",
            code: "INVALID_RESPONSE",
            message: "Model did not finish normally",
          };
          return;
        }

        // 已经拿到最终文本，无须再次请求模型。
        // Day 4 采用 SSE 分块输出已有文本。
        const content = result.content ?? "";

        for (const text of Array.from(content)) {
          if (options.signal?.aborted) return;
          yield { type: "text-delta", text };
        }

        yield { type: "done" };
        return;
      }

      history.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
      });

      for (const call of result.toolCalls) {
        if (options.signal?.aborted) return;

        yield {
          type: "tool-start",
          toolCallId: call.id,
          toolName: call.function.name,
        };

        let output: string;
        let success = true;

        try {
          const value = await this.tools.execute(
            call.function.name,
            call.function.arguments,
            { signal: options.signal },
          );

          output = JSON.stringify(value);
        } catch (error) {
          if (options.signal?.aborted) return;

          success = false;

          output = JSON.stringify({
            error:
              error instanceof ToolError
                ? error.code
                : "TOOL_EXECUTION_FAILED",
          });
        }

        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: output,
        });

        yield {
          type: "tool-result",
          toolCallId: call.id,
          toolName: call.function.name,
          success,
        };
      }
    }

    yield {
      type: "error",
      code: "MAX_MODEL_CALLS",
      message: "Agent exceeded maximum model calls",
    };
  }
}