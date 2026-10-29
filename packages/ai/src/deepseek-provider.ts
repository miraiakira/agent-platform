import OpenAI from "openai";
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

export interface DeepSeekProviderConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export class DeepSeekProvider implements ModelProvider {
  readonly name = "deepseek";

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: DeepSeekProviderConfig) {
    if (!config.apiKey || !config.model) {
      throw new AIError(
        "CONFIG_ERROR",
        "Missing API key or model",
      );
    }

    this.model = config.model;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL ?? "https://api.deepseek.com",
      maxRetries: 0,
    });
  }

  async generate(
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Model request cancelled", 499);
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          stream: false,
          messages: options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? 30000,
        },
      );

      const content = response.choices[0]?.message.content;

      if (!content) {
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
        content,
        usage: response.usage
          ? {
              inputTokens: response.usage.prompt_tokens,
              outputTokens: response.usage.completion_tokens,
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

  async *stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamEvent> {
    if (options.signal?.aborted) {
      throw new AIError(
        "CANCELLED",
        "Model request cancelled",
        499,
      );
    }

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          stream: true,
          stream_options: {
            include_usage: true,
          },
          messages: options.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        {
          signal: options.signal,
          timeout: options.timeoutMs ?? 30000,
        },
      );

      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        const text = choice?.delta?.content;

        if (text) {
          yield {
            type: "text-delta",
            text,
          };
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          };
        }
      }

      if (
        finishReason !== null &&
        finishReason !== "stop"
      ) {
        throw new AIError(
          "INVALID_RESPONSE",
          `Model stopped unexpectedly: ${finishReason}`,
          502,
        );
      }

      yield { type: "done" };
    } catch (error) {
      if (error instanceof AIError) {
        throw error;
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

      if (
        error instanceof OpenAI.APIConnectionTimeoutError
      ) {
        throw new AIError(
          "TIMEOUT",
          "Model request timed out",
          504,
        );
      }

      throw new AIError(
        "PROVIDER_ERROR",
        "Model streaming failed",
        502,
      );
    }
  }

  async generateWithTools(
    options: ToolGenerateOptions,
  ): Promise<ToolGenerateResult> {
    if (options.signal?.aborted) {
      throw new AIError(
        "CANCELLED",
        "Model request cancelled",
        499,
      );
    }

    try {
      const response =
        await this.client.chat.completions.create(
          {
            model: this.model,
            stream: false,
            messages: options.messages,
            tools: options.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
            parallel_tool_calls: false,
          },
          {
            signal: options.signal,
            timeout: options.timeoutMs ?? 30000,
          },
        );

      const choice = response.choices[0];

      if (!choice) {
        throw new AIError(
          "INVALID_RESPONSE",
          "Model returned no choices",
          502,
        );
      }

      return {
        content: choice.message.content,
        toolCalls:
          choice.message.tool_calls
            ?.filter((call) => call.type === "function")
            .map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.function.name,
                arguments: call.function.arguments,
              },
            })) ?? [],
        finishReason: choice.finish_reason,
      };
    } catch (error) {
      if (error instanceof AIError) throw error;

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

      if (error instanceof OpenAI.RateLimitError) {
        throw new AIError(
          "RATE_LIMIT",
          "Model rate limit exceeded",
          429,
        );
      }

      if (error instanceof OpenAI.AuthenticationError) {
        throw new AIError(
          "AUTH_ERROR",
          "Model authentication failed",
          502,
        );
      }

      if (
        error instanceof OpenAI.APIConnectionTimeoutError
      ) {
        throw new AIError(
          "TIMEOUT",
          "Model request timed out",
          504,
        );
      }

      throw new AIError(
        "PROVIDER_ERROR",
        "Tool-enabled model request failed",
        502,
      );
    }
  }

  async *streamAgentFinal(
    options: {
      messages: AgentMessage[];
      signal?: AbortSignal;
      timeoutMs?: number;
      maxOutputTokens?: number;
    },
  ): AsyncIterable<StreamEvent> {
    try {
      const stream =
        await this.client.chat.completions.create(
          {
            model: this.model,
            messages: options.messages,
            stream: true,
            stream_options: { include_usage: true },
            tool_choice: "none",
            ...(options.maxOutputTokens
            ? { max_tokens: options.maxOutputTokens }
            : {}),
          },
          {
            signal: options.signal,
            timeout: options.timeoutMs ?? 30000,
          },
        );

      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        if (choice?.delta.content) {
          yield {
            type: "text-delta",
            text: choice.delta.content,
          };
        }

        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          };
        }
      }

      if (finishReason !== "stop") {
        throw new AIError(
          "INVALID_RESPONSE",
          `Unexpected finish reason: ${finishReason}`,
          502,
        );
      }

      yield { type: "done" };
    } catch (error) {
      if (error instanceof AIError) throw error;

      if (
        options.signal?.aborted ||
        error instanceof OpenAI.APIUserAbortError
      ) {
        throw new AIError("CANCELLED", "Request cancelled", 499);
      }

      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AIError("TIMEOUT", "Model timed out", 504);
      }

      throw new AIError(
        "PROVIDER_ERROR",
        "Final answer streaming failed",
        502,
      );
    }
  }

  async *streamWithTools(
    options: StreamWithToolsOptions,
  ): AsyncIterable<ModelToolStreamEvent> {
    if (options.signal?.aborted) {
      throw new AIError(
        "CANCELLED",
        "Model request cancelled",
        499,
      );
    }

    try {
      const stream =
        await this.client.chat.completions.create(
          {
            model: this.model,
            messages: options.messages,
            stream: true,
            stream_options: {
              include_usage: true,
            },
            ...(options.tools.length > 0
              ? {
                  tools: options.tools.map((tool) => ({
                    type: "function" as const,
                    function: {
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.parameters,
                    },
                  })),
                  tool_choice: "auto" as const,
                  parallel_tool_calls: false,
                }
              : {}),
            ...(options.maxOutputTokens
              ? { max_tokens: options.maxOutputTokens }
              : {}),
          },
          {
            signal: options.signal,
            timeout: options.timeoutMs ?? 30000,
          },
        );

      for await (const chunk of stream) {
        const choice = chunk.choices[0];

        if (choice?.delta.content) {
          yield {
            type: "text-delta",
            text: choice.delta.content,
          };
        }

        for (const call of choice?.delta.tool_calls ?? []) {
          yield {
            type: "tool-call-delta",
            index: call.index,
            id: call.id,
            name:
              call.type === "function"
                ? call.function?.name
                : undefined,
            arguments:
              call.type === "function"
                ? call.function?.arguments
                : undefined,
          };
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            usage: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          };
        }

        if (choice?.finish_reason) {
          yield {
            type: "model-finish",
            finishReason: choice.finish_reason,
          };
        }
      }
    } catch (error) {
      if (error instanceof AIError) throw error;

      if (
        options.signal?.aborted ||
        error instanceof OpenAI.APIUserAbortError
      ) {
        throw new AIError(
          "CANCELLED",
          "Model request cancelled",
          499,
        );
      }

      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AIError(
          "TIMEOUT",
          "Model request timed out",
          504,
        );
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

      throw new AIError(
        "PROVIDER_ERROR",
        "Model streaming failed",
        502,
      );
    }
  }
}
