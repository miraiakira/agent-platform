-- Keep the legacy global identity for compatibility; SSE uses per-run sequence.
ALTER TABLE agent_runs ADD COLUMN event_sequence BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN request_key TEXT UNIQUE;
ALTER TABLE agent_runs ADD COLUMN request_payload JSONB;
ALTER TABLE agent_events ADD COLUMN sequence BIGINT;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY run_id ORDER BY id) AS seq
  FROM agent_events
)
UPDATE agent_events e SET sequence = n.seq FROM numbered n WHERE e.id = n.id;
UPDATE agent_runs r SET event_sequence = s.seq FROM (
  SELECT run_id, max(sequence) AS seq FROM agent_events GROUP BY run_id
) s WHERE r.id = s.run_id;
ALTER TABLE agent_events ALTER COLUMN sequence SET NOT NULL;
CREATE UNIQUE INDEX idx_events_run_sequence ON agent_events(run_id, sequence);
CREATE UNIQUE INDEX idx_events_terminal ON agent_events(run_id)
  WHERE event_type IN ('done', 'error');
