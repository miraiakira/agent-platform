import { AIError } from "./errors";
import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
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
}