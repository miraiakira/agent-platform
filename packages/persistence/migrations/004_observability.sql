ALTER TABLE agent_jobs ADD COLUMN trace_context JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_runs ADD COLUMN observability JSONB;
-- One immutable committed usage/cost snapshot per Run; idempotent finalize cannot double bill.
CREATE TABLE agent_usage (
  run_id UUID PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  total_tokens BIGINT GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  usage_source TEXT NOT NULL CHECK (usage_source IN ('reported','partial','unavailable')),
  estimated_cost_usd NUMERIC,
  price JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
