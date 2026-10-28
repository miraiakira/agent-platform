import type { ToolDefinition } from "@eap/tools";

export type MessageRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  id: string;
  model: string;
  provider: string;
  content: string;
  usage?: TokenUsage;
}

export interface ModelProvider {
  readonly name: string;

  generate(
    options: GenerateOptions,
  ): Promise<GenerateResult>;

  stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamEvent>;

  generateWithTools(
    options: ToolGenerateOptions,
  ): Promise<ToolGenerateResult>;

  streamAgentFinal(
    options: {
      messages: AgentMessage[];
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncIterable<StreamEvent>;
}

export type StreamEvent =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "usage";
      usage: TokenUsage;
    }
  | {
      type: "done";
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | {
    type: "tool-start";
    toolCallId: string;
    toolName: string;
  }
  | {
    type: "tool-result";
    toolCallId: string;
    toolName: string;
    success: boolean;
  };
  

export interface FunctionCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type AgentMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: FunctionCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface ToolGenerateOptions {
  messages: AgentMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ToolGenerateResult {
  content: string | null;
  toolCalls: FunctionCall[];
  finishReason: string | null;
}