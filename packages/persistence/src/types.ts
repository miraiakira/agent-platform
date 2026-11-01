export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
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
  tenant_id?: string;
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
  tenant_id?: string;
  actor_user_id?: string | null;
  id: string;
  conversation_id: string;
  trace_id: string;
  status: RunStatus;
  observability?: JsonValue | null;
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