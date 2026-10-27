import { DeepSeekProvider } from "./deepseek-provider";
import { AIError } from "./errors";
import { MockProvider } from "./mock-provider";
import { OpenAIProvider } from "./openai-provider";
import type { ModelProvider } from "./types";

export interface ProviderConfig {
  provider: "openai" | "deepseek" | "mock";
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export function createModelProvider(
  config: ProviderConfig,
): ModelProvider {
  switch (config.provider) {
    case "mock":
      return new MockProvider();

    case "deepseek":
      if (!config.apiKey || !config.model) {
        throw new AIError(
          "CONFIG_ERROR",
          "Missing LLM_API_KEY or LLM_MODEL",
        );
      }

      return new DeepSeekProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
      });

    case "openai":
      if (!config.apiKey || !config.model) {
        throw new AIError(
          "CONFIG_ERROR",
          "Missing LLM_API_KEY or LLM_MODEL",
        );
      }

      return new OpenAIProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
      });

    default:
      throw new AIError(
        "CONFIG_ERROR",
        "Unsupported provider",
      );
  }
}