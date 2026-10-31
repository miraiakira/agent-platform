
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  AgentEventStore,
  AgentJobQueue,
  PersistenceStore,
  createPool,
} from "../src";

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "TEST_DATABASE_URL is required for job queue integration tests",
  );
}

describe("Day 7 PostgreSQL Job Queue", () => {
  let adminPool: Pool;
  let schema: string;
  let pool: Pool;
  let store: PersistenceStore;
  let queue: AgentJobQueue;
  let events: AgentEventStore;

  beforeAll(() => {
    adminPool = createPool(connectionString);
  });

  beforeEach(async () => {
    // Claims scan the entire queue, so every test needs an isolated queue.
    // A schema also keeps existing database rows and parallel suites untouched.
    schema = `job_queue_test_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });

    const migrationDir = new URL("../migrations/", import.meta.url);
    const migrations = (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql"))
      .sort();

    for (const migration of migrations) {
      await pool.query(await readFile(new URL(migration, migrationDir), "utf8"));
    }

    store = new PersistenceStore(pool);
    queue = new AgentJobQueue(pool);
    events = new AgentEventStore(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (schema) {
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  afterAll(async () => {
    await adminPool?.end();
  });

  async function createTestRun() {
    const conversation = await store.createConversation(
      `Day 7 Test ${randomUUID()}`,
    );

    const run = await store.createRun({
      conversationId: conversation.id,
      traceId: randomUUID(),
      messages: [
        {
          role: "user",
          content: "查询高风险交易",
        },
      ],
    });

    return { conversation, run };
  }

  async function createTestJob() {
    const { conversation, run } = await createTestRun();

    const job = await queue.enqueue({
      runId: run.id,
    });

    return { conversation, run, job };
  }

  it("creates a queued job", async () => {
    const { run, job } = await createTestJob();

    expect(job.id).toBeDefined();
    expect(job.run_id).toBe(run.id);
    expect(job.status).toBe("queued");
    expect(job.attempt).toBe(0);
  });

  it("does not create duplicate jobs for the same run", async () => {
    const { run, job } = await createTestJob();

    const duplicate = await queue.enqueue({
      runId: run.id,
    });

    expect(duplicate.id).toBe(job.id);

    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM agent_jobs WHERE run_id = $1",
      [run.id],
    );

    expect(result.rows[0].count).toBe(1);
  });

  it("claims a queued job and transitions its run to running", async () => {
    const { run, job } = await createTestJob();

    const claimed = await queue.claim("worker-claim");

    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.worker_id).toBe("worker-claim");
    expect(claimed?.lease_token).toBeTruthy();
    expect(claimed?.attempt).toBe(1);

    const updatedRun = await store.getRun(run.id);

    expect(updatedRun?.status).toBe("running");
  });

  it("prevents two workers from claiming the same job", async () => {
    const { job } = await createTestJob();

    const [first, second] = await Promise.all([
      queue.claim("worker-A"),
      queue.claim("worker-B"),
    ]);

    const claimed = [first, second].filter(
      (item) => item?.id === job.id,
    );

    expect(claimed).toHaveLength(1);
  });

  it("renews a lease only with the correct token", async () => {
    const { job } = await createTestJob();

    const claimed = await queue.claim("worker-lease");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    const invalid = await queue.renewLease(
      claimed.id,
      randomUUID(),
      30,
    );

    expect(invalid).toBe(false);

    const valid = await queue.renewLease(
      claimed.id,
      claimed.lease_token,
      60,
    );

    expect(valid).toBe(true);
  });

  it("rejects completion from an invalid lease owner", async () => {
    const { job } = await createTestJob();

    const claimed = await queue.claim("worker-finish");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    const invalid = await queue.finish(
      claimed.id,
      randomUUID(),
      "completed",
    );

    expect(invalid).toBe(false);

    const valid = await queue.finish(
      claimed.id,
      claimed.lease_token,
      "completed",
    );

    expect(valid).toBe(true);

    const updatedRun = await store.getRun(claimed.run_id);

    expect(updatedRun?.status).toBe("completed");
  });

  it("rejects completion after lease expiry", async () => {
    const { job } = await createTestJob();

    const claimed = await queue.claim("worker-expired");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    await pool.query(
      `UPDATE agent_jobs
       SET lease_expires_at = now() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [claimed.id],
    );

    const completed = await queue.finish(
      claimed.id,
      claimed.lease_token,
      "completed",
    );

    expect(completed).toBe(false);
  });

  it("cancels queued jobs before execution", async () => {
    const { run, job } = await createTestJob();

    const cancelled = await queue.requestCancellation(run.id);

    expect(cancelled).toBe(true);

    const updatedJob = await queue.getJobByRunId(run.id);
    const updatedRun = await store.getRun(run.id);

    expect(updatedJob?.status).toBe("cancelled");
    expect(updatedRun?.status).toBe("cancelled");

    const claimed = await queue.claim("worker-cancelled");

    expect(claimed?.id).not.toBe(job.id);
  });

  it("records cancellation requests for running jobs", async () => {
    const { run, job } = await createTestJob();

    const claimed = await queue.claim("worker-cancel");

    expect(claimed?.id).toBe(job.id);

    const requested = await queue.requestCancellation(run.id);

    expect(requested).toBe(true);

    const updatedJob = await queue.getJobByRunId(run.id);

    expect(updatedJob?.status).toBe("running");
    expect(updatedJob?.cancel_requested_at).not.toBeNull();

    if (!claimed) throw new Error("Claim failed");

    const renewed = await queue.renewLease(
      claimed.id,
      claimed.lease_token,
    );

    expect(renewed).toBe(false);
  });

  it("blocks expired jobs and interrupts their runs", async () => {
    const { run, job } = await createTestJob();

    const claimed = await queue.claim("worker-crashed");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    await pool.query(
      `UPDATE agent_jobs
       SET lease_expires_at = now() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [claimed.id],
    );

    const blockedRunIds = await queue.blockExpiredJobs();

    expect(blockedRunIds).toContain(run.id);

    const updatedJob = await queue.getJobByRunId(run.id);
    const updatedRun = await store.getRun(run.id);

    expect(updatedJob?.status).toBe("blocked");
    expect(updatedRun?.status).toBe("interrupted");

    const secondScan = await queue.blockExpiredJobs();

    expect(secondScan).not.toContain(run.id);
  });

  it("persists SSE events and reads them by cursor", async () => {
    const { run, job } = await createTestJob();

    const claimed = await queue.claim("worker-events");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    const first = await events.append({
      runId: run.id,
      jobId: claimed.id,
      leaseToken: claimed.lease_token,
      type: "text-delta",
      payload: {
        type: "text-delta",
        text: "发现",
      },
    });

    const second = await events.append({
      runId: run.id,
      jobId: claimed.id,
      leaseToken: claimed.lease_token,
      type: "text-delta",
      payload: {
        type: "text-delta",
        text: "高风险交易",
      },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    if (!first || !second) {
      throw new Error("Event append failed");
    }

    const all = await events.listAfter(run.id, "0");

    expect(all.map((event) => event.id)).toEqual([
      first.id,
      second.id,
    ]);

    const resumed = await events.listAfter(
      run.id,
      first.id,
    );

    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe(second.id);
    expect(resumed[0]?.payload).toEqual({
      type: "text-delta",
      text: "高风险交易",
    });
  });

  it("rejects event writes from stale lease owners", async () => {
    const { run, job } = await createTestJob();

    const claimed = await queue.claim("worker-stale");

    expect(claimed?.id).toBe(job.id);

    if (!claimed) throw new Error("Claim failed");

    await pool.query(
      `UPDATE agent_jobs
       SET lease_expires_at = now() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [claimed.id],
    );

    const event = await events.append({
      runId: run.id,
      jobId: claimed.id,
      leaseToken: claimed.lease_token,
      type: "text-delta",
      payload: {
        type: "text-delta",
        text: "This should not persist",
      },
    });

    expect(event).toBeNull();

    const persisted = await events.listAfter(run.id, "0");

    expect(persisted).toHaveLength(0);
  });
});
