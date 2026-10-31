import type { Pool, PoolClient } from "pg";
import type { ClaimedJob } from "./job-queue";

export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Lock order everywhere: job, then run. Check wall time after acquiring locks.
export async function lockLease(client: PoolClient, jobId: string, token: string) {
  const { rows } = await client.query<ClaimedJob>(
    "SELECT * FROM agent_jobs WHERE id = $1 FOR UPDATE", [jobId],
  );
  const job = rows[0];
  if (!job) return null;
  const run = await client.query("SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE", [job.run_id]);
  const valid = await client.query(
    `SELECT 1 FROM agent_jobs WHERE id = $1 AND lease_token = $2
     AND status = 'running' AND lease_expires_at > clock_timestamp()`, [jobId, token],
  );
  return valid.rowCount && run.rows[0]?.status === "running" ? job : null;
}

// Caller holds the job and run locks until commit, so sequence order is commit order.
export async function insertEvent(client: PoolClient, runId: string, type: string, payload: unknown) {
  const { rows } = await client.query(
    `WITH seq AS (
       UPDATE agent_runs SET event_sequence = event_sequence + 1 WHERE id = $1
       RETURNING event_sequence
     ) INSERT INTO agent_events(run_id, sequence, event_type, payload)
     SELECT $1, event_sequence, $2, $3::jsonb FROM seq
     RETURNING sequence::text AS id, run_id, event_type, payload, created_at`,
    [runId, type, JSON.stringify(payload)],
  );
  return rows[0];
}
