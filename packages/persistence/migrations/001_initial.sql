CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'running', 'completed',
      'failed', 'cancelled', 'interrupted'
    )),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error JSONB,
  model_calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL
    REFERENCES conversations(id) ON DELETE CASCADE,
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL
    CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trace_spans (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL
    REFERENCES agent_runs(id) ON DELETE CASCADE,
  span_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, span_index)
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL
    REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status IN (
      'reserved', 'running', 'succeeded',
      'failed', 'unknown'
    )),
  input JSONB NOT NULL,
  output JSONB,
  error JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, tool_call_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_runs_conversation
  ON agent_runs(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_recovery
  ON agent_runs(status, heartbeat_at)
  WHERE status IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_spans_run
  ON trace_spans(run_id, span_index);

-- 每个会话同时最多允许一个非终态 Run。
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run
  ON agent_runs(conversation_id)
  WHERE status IN ('pending', 'running');