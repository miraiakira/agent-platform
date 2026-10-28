import OpenAI from "openai";
import { AIError } from "./errors";
import type {
  AgentMessage,
  ToolGenerateOptions,
  ToolGenerateResult,
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

  stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    return this.streamResponse(options);
  }

  streamAgentFinal(
    options: Parameters<ModelProvider["streamAgentFinal"]>[0],
  ): AsyncIterable<StreamEvent> {
    return this.streamResponse(options, true);
  }

  private toResponseInput(messages: AgentMessage[]): OpenAI.Responses.ResponseInput {
    const input: OpenAI.Responses.ResponseInput = [];
    for (const message of messages) {
      if (message.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: message.content,
        });
      } else if (message.role === "assistant") {
        if (message.content !== null) {
          input.push({ role: "assistant", content: message.content });
        }
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
      } else {
        input.push({ role: message.role, content: message.content });
      }
    }
    return input;
  }

  async generateWithTools(options: ToolGenerateOptions): Promise<ToolGenerateResult> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Model request cancelled", 499);
    }
    try {
      const response = await this.client.responses.create({
        model: this.model,
        store: false,
        input: this.toResponseInput(options.messages),
        tools: options.tools.map((tool) => ({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: false,
        })),
        tool_choice: "auto",
        parallel_tool_calls: false,
      }, { signal: options.signal, timeout: options.timeoutMs ?? 30000 });

      if (response.status === "incomplete") {
        throw new AIError("INVALID_RESPONSE", "Model response incomplete", 502);
      }
      if (response.status !== "completed") {
        throw new AIError("PROVIDER_ERROR", "Tool-enabled model request failed", 502);
      }
      const toolCalls = response.output
        .filter((item) => item.type === "function_call")
        .map((call) => ({
          id: call.call_id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      if (!response.output_text && toolCalls.length === 0) {
        throw new AIError("INVALID_RESPONSE", "Model returned no text or tool calls", 502);
      }
      return {
        content: response.output_text || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      };
    } catch (error) {
      if (error instanceof AIError) throw error;
      if (error instanceof OpenAI.APIUserAbortError || options.signal?.aborted) {
        throw new AIError("CANCELLED", "Model request cancelled", 499);
      }
      if (error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new AIError("TIMEOUT", "Model request timed out", 504);
      }
      if (error instanceof OpenAI.AuthenticationError) {
        throw new AIError("AUTH_ERROR", "Model authentication failed", 502);
      }
      if (error instanceof OpenAI.RateLimitError) {
        throw new AIError("RATE_LIMIT", "Model rate limit exceeded", 429);
      }
      throw new AIError("PROVIDER_ERROR", "Tool-enabled model request failed", 502);
    }
  }

  private async *streamResponse(
    options: Parameters<ModelProvider["streamAgentFinal"]>[0],
    finalAnswer = false,
  ): AsyncIterable<StreamEvent> {
    if (options.signal?.aborted) {
      throw new AIError("CANCELLED", "Model request cancelled", 499);
    }

    try {
      const stream = await this.client.responses.create(
        {
          model: this.model,
          store: false,
          stream: true,
          input: this.toResponseInput(options.messages),
          ...(finalAnswer ? { tool_choice: "none" as const } : {}),
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
