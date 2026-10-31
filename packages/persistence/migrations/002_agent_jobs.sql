-- Day 7: Agent Job Queue

CREATE TABLE agent_jobs (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL UNIQUE
    REFERENCES agent_runs(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'blocked'
    )),

  priority INTEGER NOT NULL DEFAULT 0,

  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,

  worker_id TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,

  cancel_requested_at TIMESTAMPTZ,

  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,

  last_error JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (attempt >= 0),
  CHECK (max_attempts >= 1),

  CHECK (
    status <> 'running'
    OR (
      worker_id IS NOT NULL
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_agent_jobs_claim
  ON agent_jobs (
    priority DESC,
    available_at ASC,
    created_at ASC
  )
  WHERE status = 'queued';

CREATE INDEX idx_agent_jobs_lease
  ON agent_jobs (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE agent_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  run_id UUID NOT NULL
    REFERENCES agent_runs(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_events_run
  ON agent_events(run_id, id);