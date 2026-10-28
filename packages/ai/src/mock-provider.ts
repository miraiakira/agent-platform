import { AIError } from "./errors";
import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  StreamEvent,
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
}