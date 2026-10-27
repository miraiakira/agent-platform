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
}