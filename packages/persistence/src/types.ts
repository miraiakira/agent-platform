export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Conversation {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: MessageRole;
  content: JsonValue;
  created_at: Date;
}

export interface AgentRunRecord {
  id: string;
  conversation_id: string;
  trace_id: string;
  status: RunStatus;
  input: JsonValue;
  output: JsonValue | null;
  error: JsonValue | null;
  model_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  heartbeat_at: Date | null;
  created_at: Date;
}

export interface SpanInput {
  name: string;
  kind: string;
  status: string;
  durationMs?: number;
  data?: JsonValue;
}