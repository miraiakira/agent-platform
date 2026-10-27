import { describe, expect, it } from "vitest";

import {
  AIError,
  AIService,
  MockProvider,
  createModelProvider,
} from "../src/index";

describe("ModelProvider", () => {
  it("creates a mock provider", () => {
    const provider = createModelProvider({
      provider: "mock",
    });

    expect(provider.name).toBe("mock");
  });

  it("generates a mock response", async () => {
    const service = new AIService(
      new MockProvider(),
    );

    const result = await service.generate({
      messages: [
        {
          role: "user",
          content: "Hello Agent",
        },
      ],
    });

    expect(result.content).toBe(
      "Mock response: Hello Agent",
    );

    expect(result.provider).toBe("mock");
    expect(result.usage?.totalTokens).toBe(20);
  });

  it("supports cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const service = new AIService(
      new MockProvider(),
    );

    await expect(
      service.generate({
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("rejects missing provider configuration", () => {
    expect(() =>
      createModelProvider({
        provider: "openai",
      }),
    ).toThrow(AIError);
  });
});