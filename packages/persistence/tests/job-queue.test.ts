
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  AgentEventStore,
  AgentJobQueue,
  PersistenceStore,
  JobLifecycle,
} from "../src";

describe("Day 7 PostgreSQL Job Queue", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let pool: Pool;
  let store: PersistenceStore;
  let queue: AgentJobQueue;
  let events: AgentEventStore;

  beforeEach(async () => {
    database = await createTestDatabase();
    pool = database.pool;
    store = new PersistenceStore(pool);
    queue = new AgentJobQueue(pool);
    events = new AgentEventStore(pool);
  });

  afterEach(async () => {
    await database?.close();
    database = undefined;
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

  it("submits idempotently and rejects a different payload", async () => {
    const lifecycle = new JobLifecycle(pool);
    const input = { requestKey: randomUUID(), messages: [{ role: "user" as const, content: "hello" }] };
    const [first, second] = await Promise.all([lifecycle.submit(input), lifecycle.submit(input)]);
    expect(second.id).toBe(first.id);
    expect((await pool.query("SELECT * FROM agent_jobs")).rowCount).toBe(1);
    expect((await store.listMessages(first.conversation_id))).toHaveLength(1);
    await expect(lifecycle.submit({ ...input, messages: [{ role: "user", content: "different" }] })).rejects.toThrow("different request");
  });

  it("rolls back conversation, run and messages when enqueue fails", async () => {
    await pool.query("ALTER TABLE agent_jobs ADD CONSTRAINT fail_enqueue CHECK (priority < 0)");
    await expect(new JobLifecycle(pool).submit({ requestKey: randomUUID(), messages: [{ role: "user", content: "hello" }] })).rejects.toThrow();
    for (const table of ["conversations", "agent_runs", "agent_jobs", "messages"]) {
      expect((await pool.query(`SELECT * FROM ${table}`)).rowCount).toBe(0);
    }
  });

  it("rolls back finalization when writing the terminal event fails", async () => {
    const { run } = await createTestJob();
    const job = (await queue.claim("rollback"))!;
    await pool.query("ALTER TABLE agent_events ADD CONSTRAINT fail_terminal CHECK (event_type <> 'done')");
    await expect(new JobLifecycle(pool).finalizeJob({ jobId: job.id, leaseToken: job.lease_token, status: "completed", answer: "answer" })).rejects.toThrow();
    expect((await store.getRun(run.id))?.status).toBe("running");
    expect((await queue.getJobByRunId(run.id))?.status).toBe("running");
    expect(await store.listMessages(run.conversation_id)).toHaveLength(0);
  });

  it("serializes cancellation against completion and writes one terminal event", async () => {
    const { run } = await createTestJob();
    const job = (await queue.claim("race"))!;
    await Promise.all([
      queue.requestCancellation(run.id),
      new JobLifecycle(pool).finalizeJob({ jobId: job.id, leaseToken: job.lease_token, status: "completed", answer: "answer" }),
    ]);
    const updated = (await store.getRun(run.id))!;
    expect(["completed", "cancelled"]).toContain(updated.status);
    expect((await queue.getJobByRunId(run.id))?.status).toBe(updated.status);
    expect((await events.listAfter(run.id, "0")).filter((e) => ["done", "error"].includes(e.event_type))).toHaveLength(1);
    expect(await queue.finish(job.id, job.lease_token, "completed")).toBe(false);
  });

  it("waits for earlier event transactions before allocating a cursor", async () => {
    const { run } = await createTestJob();
    const job = (await queue.claim("sequence"))!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM agent_jobs WHERE id=$1 FOR UPDATE", [job.id]);
      await client.query("UPDATE agent_runs SET event_sequence=event_sequence+1 WHERE id=$1", [run.id]);
      await client.query("INSERT INTO agent_events(run_id,sequence,event_type,payload) VALUES($1,1,'text-delta','{}')", [run.id]);
      const pending = events.append({ runId: run.id, jobId: job.id, leaseToken: job.lease_token, type: "text-delta", payload: { text: "second" } });
      expect(await events.listAfter(run.id, "0")).toHaveLength(0);
      await client.query("COMMIT");
      expect((await pending)?.id).toBe("2");
      expect((await events.listAfter(run.id, "0")).map((e) => e.id)).toEqual(["1", "2"]);
      expect((await events.listAfter(run.id, "1")).map((e) => e.id)).toEqual(["2"]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("refuses finalization if the run is no longer running", async () => {
    const { run } = await createTestJob();
    const job = (await queue.claim("run-fence"))!;
    await pool.query("UPDATE agent_runs SET status='interrupted' WHERE id=$1", [run.id]);
    expect(await queue.finish(job.id, job.lease_token, "completed")).toBe(false);
    expect((await queue.getJobByRunId(run.id))?.status).toBe("running");
  });
});
