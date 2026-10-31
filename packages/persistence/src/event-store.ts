import type { Pool } from "pg";

export interface StoredAgentEvent {
  id: string;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

export class AgentEventStore {
  constructor(private readonly db: Pool) {}

  async append(input: {
    runId: string;
    jobId: string;
    leaseToken: string;
    type: string;
    payload: unknown;
  }): Promise<StoredAgentEvent | null> {
    const result = await this.db.query<StoredAgentEvent>(
      `
      INSERT INTO agent_events (
        run_id, event_type, payload
      )
      SELECT j.run_id, $4, $5::jsonb
      FROM agent_jobs j
      WHERE j.id = $2
        AND j.run_id = $1
        AND j.lease_token = $3
        AND j.status = 'running'
        AND j.lease_expires_at > now()
        AND j.cancel_requested_at IS NULL
      RETURNING *
      `,
      [
        input.runId,
        input.jobId,
        input.leaseToken,
        input.type,
        JSON.stringify(input.payload),
      ],
    );

    return result.rows[0] ?? null;
  }

  async listAfter(
    runId: string,
    afterId: string,
    limit = 100,
  ): Promise<StoredAgentEvent[]> {
    const result = await this.db.query<StoredAgentEvent>(
      `
      SELECT *
      FROM agent_events
      WHERE run_id = $1
        AND id > $2::bigint
      ORDER BY id ASC
      LIMIT $3
      `,
      [
        runId,
        afterId,
        Math.min(Math.max(limit, 1), 500),
      ],
    );

    return result.rows;
  }
}