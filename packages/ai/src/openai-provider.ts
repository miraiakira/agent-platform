import OpenAI from "openai";
import { AIError } from "./errors";
import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from "./types";

export interface OpenAIProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: OpenAIProviderConfig) {
    if (!config.apiKey || !config.model) {
      throw new AIError(
        "CONFIG_ERROR",
        "Missing API key or model",
      );
    }

    this.model = config.model;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
    });
  }

  async generate(
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          store: false,
          input: options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? 30000,
        },
      );

      if (!response.output_text) {
        throw new AIError(
          "INVALID_RESPONSE",
          "Model returned no text",
          502,
        );
      }

      return {
        id: response.id,
        model: response.model,
        provider: this.name,
        content: response.output_text,
        usage: response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof AIError) {
        throw error;
      }

      if (error instanceof OpenAI.AuthenticationError) {
        throw new AIError(
          "AUTH_ERROR",
          "Model authentication failed",
          502,
        );
      }

      if (error instanceof OpenAI.RateLimitError) {
        throw new AIError(
          "RATE_LIMIT",
          "Model rate limit exceeded",
          429,
        );
      }

      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AIError(
          "TIMEOUT",
          "Model request timed out",
          504,
        );
      }

      if (
        error instanceof OpenAI.APIUserAbortError ||
        options.signal?.aborted
      ) {
        throw new AIError(
          "CANCELLED",
          "Model request cancelled",
          499,
        );
      }

      throw new AIError(
        "PROVIDER_ERROR",
        "Model request failed",
        502,
      );
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Model request cancelled", 499);
    }

    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          store: false,
          stream: true,
          input: options.messages.map(({ role, content }) => ({ role, content })),
        },
        { signal: options.signal, timeout: options.timeoutMs ?? 30000 },
      );

      for await (const event of stream) {
        if (options.signal?.aborted) {
          throw new AIError("CANCELLED", "Model request cancelled", 499);
        }

        if (event.type === "response.output_text.delta") {
          yield { type: "text-delta", text: event.delta };
        } else if (event.type === "response.completed") {
          const usage = event.response.usage;
          if (usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                totalTokens: usage.total_tokens,
              },
            };
          }
          yield { type: "done" };
          return;
        } else if (event.type === "response.incomplete") {
          throw new AIError("INVALID_RESPONSE", "Model response incomplete", 502);
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new AIError("PROVIDER_ERROR", "Model streaming failed", 502);
        }
      }

      if (options.signal?.aborted) {
        throw new AIError("CANCELLED", "Model request cancelled", 499);
      }
      throw new AIError("INVALID_RESPONSE", "Model stream ended without completion", 502);
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AIError("TIMEOUT", "Model request timed out", 504);
      }
      if (error instanceof OpenAI.APIUserAbortError || options.signal?.aborted) {
        throw new AIError("CANCELLED", "Model request cancelled", 499);
      }
      if (error instanceof OpenAI.AuthenticationError) {
        throw new AIError("AUTH_ERROR", "Model authentication failed", 502);
      }
      if (error instanceof OpenAI.RateLimitError) {
        throw new AIError("RATE_LIMIT", "Model rate limit exceeded", 429);
      }
      throw new AIError("PROVIDER_ERROR", "Model streaming failed", 502);
    }
  }
}
