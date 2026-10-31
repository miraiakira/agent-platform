import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface AgentJob {
  id: string;
  run_id: string;
  status: JobStatus;
  priority: number;
  attempt: number;
  max_attempts: number;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  cancel_requested_at: Date | null;
  available_at: Date;
  created_at: Date;
}

export interface ClaimedJob extends AgentJob {
  status: "running";
  worker_id: string;
  lease_token: string;
  lease_expires_at: Date;
}

export class AgentJobQueue {
  constructor(private readonly db: Pool) {}

  async enqueue(input: {
    runId: string;
    priority?: number;
  }): Promise<AgentJob> {
    const result = await this.db.query<AgentJob>(
      `INSERT INTO agent_jobs (
         id, run_id, priority
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id)
       DO UPDATE SET run_id = EXCLUDED.run_id
       RETURNING *`,
      [
        randomUUID(),
        input.runId,
        input.priority ?? 0,
      ],
    );

    return result.rows[0]!;
  }

  async claim(
    workerId: string,
    leaseSeconds = 30,
  ): Promise<ClaimedJob | null> {
    if (!workerId || leaseSeconds <= 0) {
      throw new Error("Invalid worker or lease");
    }

    const token = randomUUID();

    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<ClaimedJob>(
        `
        WITH candidate AS (
          SELECT id
          FROM agent_jobs
          WHERE status = 'queued'
            AND available_at <= now()
            AND cancel_requested_at IS NULL
            AND attempt < max_attempts
          ORDER BY priority DESC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE agent_jobs j
        SET status = 'running',
            worker_id = $1,
            lease_token = $2,
            lease_expires_at =
              now() + ($3 * INTERVAL '1 second'),
            attempt = attempt + 1,
            started_at = now()
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
        `,
        [workerId, token, leaseSeconds],
      );

      const job = result.rows[0] ?? null;

      if (job) {
        const transitioned = await client.query(
          `UPDATE agent_runs
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               heartbeat_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [job.run_id],
        );

        if (transitioned.rowCount !== 1) {
          throw new Error(
            `Run ${job.run_id} is not pending`,
          );
        }
      }

      await client.query("COMMIT");

      return job;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease(
    jobId: string,
    leaseToken: string,
    leaseSeconds = 30,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE agent_jobs
       SET lease_expires_at =
         now() + ($3 * INTERVAL '1 second')
       WHERE id = $1
         AND lease_token = $2
         AND status = 'running'
         AND cancel_requested_at IS NULL
         AND lease_expires_at > now()`,
      [jobId, leaseToken, leaseSeconds],
    );

    return result.rowCount === 1;
  }

  async getJobByRunId(
    runId: string,
  ): Promise<AgentJob | null> {
    const result = await this.db.query<AgentJob>(
      `SELECT * FROM agent_jobs WHERE run_id = $1`,
      [runId],
    );

    return result.rows[0] ?? null;
  }

  async requestCancellation(
    runId: string,
  ): Promise<boolean> {
    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<AgentJob>(
        `UPDATE agent_jobs
         SET cancel_requested_at = now(),
             status = CASE
               WHEN status = 'queued'
               THEN 'cancelled'
               ELSE status
             END,
             finished_at = CASE
               WHEN status = 'queued'
               THEN now()
               ELSE finished_at
             END
         WHERE run_id = $1
           AND status IN ('queued', 'running')
         RETURNING *`,
        [runId],
      );

      const job = result.rows[0];

      if (job?.status === "cancelled") {
        await client.query(
          `UPDATE agent_runs
           SET status = 'cancelled',
               finished_at = now()
           WHERE id = $1 AND status = 'pending'`,
          [runId],
        );
      }

      await client.query("COMMIT");

      return Boolean(job);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(
    jobId: string,
    leaseToken: string,
    status: "completed" | "failed" | "cancelled",
  ): Promise<boolean> {
    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{
        run_id: string;
      }>(
        `UPDATE agent_jobs
         SET status = $3,
             finished_at = now(),
             lease_expires_at = NULL
         WHERE id = $1
           AND lease_token = $2
           AND status = 'running'
           AND lease_expires_at > now()
           AND (
             $3 <> 'completed'
             OR cancel_requested_at IS NULL
           )
         RETURNING run_id`,
        [jobId, leaseToken, status],
      );

      const job = result.rows[0];

      if (!job) {
        await client.query("ROLLBACK");
        return false;
      }

      await client.query(
        `UPDATE agent_runs
         SET status = $2,
             finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [job.run_id, status],
      );

      await client.query("COMMIT");

      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async blockExpiredJobs(): Promise<string[]> {
    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{
        run_id: string;
      }>(
        `UPDATE agent_jobs
        SET status = 'blocked',
            finished_at = now(),
            last_error = jsonb_build_object(
              'code', 'LEASE_EXPIRED'
            )
        WHERE status = 'running'
          AND lease_expires_at < now()
        RETURNING run_id`,
      );

      const runIds = result.rows.map(
        (row) => row.run_id,
      );

      if (runIds.length > 0) {
        await client.query(
          `UPDATE agent_runs
          SET status = 'interrupted',
              finished_at = now()
          WHERE id = ANY($1::uuid[])
            AND status = 'running'`,
          [runIds],
        );

        await client.query(
          `UPDATE tool_executions
          SET status = 'unknown'
          WHERE run_id = ANY($1::uuid[])
            AND status IN ('reserved', 'running')`,
          [runIds],
        );
      }

      await client.query("COMMIT");

      return runIds;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}