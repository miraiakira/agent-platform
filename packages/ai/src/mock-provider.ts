import { AIError } from "./errors";
import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  StreamEvent,
  ToolGenerateOptions,
  ToolGenerateResult,
  AgentMessage,
  ModelToolStreamEvent,
  StreamWithToolsOptions,
} from "./types";

export class MockProvider implements ModelProvider {
  readonly name = "mock";

  async generate(
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    if (options.signal?.aborted) {
      throw new AIError(
        "CANCELLED",
        "Request cancelled",
        499,
      );
    }

    const lastMessage = [...options.messages]
      .reverse()
      .find((message) => message.role === "user");

    const content = lastMessage?.content ?? "";

    return {
      id: "mock-response-001",
      model: "mock-model",
      provider: this.name,
      content: `Mock response: ${content}`,
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      },
    };
  }

  async *stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamEvent> {
    const lastMessage = [...options.messages]
      .reverse()
      .find((message) => message.role === "user");

    const content = `Mock response: ${lastMessage?.content ?? ""}`;

    for (const text of Array.from(content)) {
      if (options.signal?.aborted) {
        throw new AIError(
          "CANCELLED",
          "Model request cancelled",
          499,
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });

      if (options.signal?.aborted) {
        throw new AIError(
          "CANCELLED",
          "Model request cancelled",
          499,
        );
      }

      yield {
        type: "text-delta",
        text,
      };
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 10,
        totalTokens: 20,
      },
    };

    yield { type: "done" };
  }

  async generateWithTools(
    options: ToolGenerateOptions,
  ): Promise<ToolGenerateResult> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Cancelled", 499);
    }

    const userMessage = [...options.messages]
      .reverse()
      .find((message) => message.role === "user");

    const hasToolResult = options.messages.some(
      (message) => message.role === "tool",
    );

    if (!hasToolResult && options.tools.length > 0) {
      return {
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "mock-call-1",
            type: "function",
            function: {
              name: "get_high_risk_transactions",
              arguments: JSON.stringify({
                date: new Date().toISOString().slice(0, 10),
                limit: 3,
              }),
            },
          },
        ],
      };
    }

    return {
      content:
        userMessage?.content ?? "Mock response",
      toolCalls: [],
      finishReason: "stop",
    };
  }

  async *streamAgentFinal(
    options: {
      messages: AgentMessage[];
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncIterable<StreamEvent> {
    const toolResult = [...options.messages]
      .reverse()
      .find((message) => message.role === "tool");

    const content = toolResult
      ? `模拟风控分析结果：${toolResult.content}`
      : "模拟 Agent 回答";

    for (const character of Array.from(content)) {
      if (options.signal?.aborted) {
        throw new AIError("CANCELLED", "Cancelled", 499);
      }

      yield {
        type: "text-delta",
        text: character,
      };
    }

    yield { type: "done" };
  }

  async *streamWithTools(
    options: StreamWithToolsOptions,
  ): AsyncIterable<ModelToolStreamEvent> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Cancelled", 499);
    }

    const hasToolResult = options.messages.some(
      (message) => message.role === "tool",
    );

    if (!hasToolResult && options.tools.length > 0) {
      const args = JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        limit: 3,
      });

      yield {
        type: "tool-call-delta",
        index: 0,
        id: "mock-call-1",
        name: "get_high_risk_transactions",
        arguments: args.slice(0, 12),
      };

      yield {
        type: "tool-call-delta",
        index: 0,
        arguments: args.slice(12),
      };

      yield {
        type: "usage",
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          totalTokens: 30,
        },
      };

      yield {
        type: "model-finish",
        finishReason: "tool_calls",
      };

      return;
    }

    const result = [...options.messages]
      .reverse()
      .find((message) => message.role === "tool");

    const content = result
      ? `模拟分析结果：${result.content}`
      : "模拟 Agent 回答";

    for (const character of Array.from(content)) {
      if (options.signal?.aborted) {
        throw new AIError("CANCELLED", "Cancelled", 499);
      }

      yield {
        type: "text-delta",
        text: character,
      };

      await Promise.resolve();
    }

    yield {
      type: "usage",
      usage: {
        inputTokens: 30,
        outputTokens: 20,
        totalTokens: 50,
      },
    };

    yield {
      type: "model-finish",
      finishReason: "stop",
    };
  }
}