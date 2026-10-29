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
      maxOutputTokens?: number;
    },
  ): AsyncIterable<StreamEvent>;

  streamWithTools(
    options: StreamWithToolsOptions,
  ): AsyncIterable<ModelToolStreamEvent>;
}

export type AgentRuntimeEvent =
  | {
      type: "run-start";
      traceId: string;
    }
  | {
      type: "model-start";
      iteration: number;
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
      attempts: number;
    }
  | {
      type: "trace";
      traceId: string;
      durationMs: number;
      modelCalls: number;
      toolCalls: number;
      usage: AgentUsage;
    };

export type StreamEvent =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "usage";
      usage: AgentUsage;
    }
  | {
      type: "done";
    }
  | {
      type: "error";
      code: string;
      message: string;
    }
  | AgentRuntimeEvent;
  

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

// 模型 Token 使用量
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// DeepSeek 工具调用流式事件
export type ModelToolStreamEvent =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      arguments?: string;
    }
  | {
      type: "usage";
      usage: AgentUsage;
    }
  | {
      type: "model-finish";
      finishReason: string | null;
    };

// 支持工具调用的流式请求参数
export interface StreamWithToolsOptions
  extends ToolGenerateOptions {
  maxOutputTokens?: number;
}