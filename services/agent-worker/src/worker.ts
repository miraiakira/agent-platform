import { RuntimeError } from "@eap/ai";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentJobQueue, JobLifecycle, ClaimedJob } from "@eap/persistence";
import type { JobExecutor, JobResult } from "./executor";

export interface WorkerOptions {
  queue: AgentJobQueue; lifecycle: JobLifecycle; executor: JobExecutor;
  workerId: string; signal: AbortSignal;
  concurrency?: number; leaseSeconds?: number; pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export async function runWorker(options: WorkerOptions): Promise<void> {
  const { queue, lifecycle, executor, workerId, signal } = options;
  const lease = options.leaseSeconds ?? 30;
  const poll = options.pollIntervalMs ?? 1000;
  const concurrency = options.concurrency ?? 1;
  if (!workerId || !Number.isFinite(lease) || lease < 0.1 || !Number.isInteger(concurrency) || concurrency < 1 || !Number.isFinite(poll) || poll <= 0) {
    throw new Error("Invalid worker configuration");
  }
  const report = options.onError ?? ((error: unknown) => console.error("[worker]", error));
  const pause = () => delay(poll, undefined, { signal }).catch(() => {});

  async function execute(job: ClaimedJob) {
    const controller = new AbortController();
    const stop = () => controller.abort(new RuntimeError("WORKER_STOPPED", "Worker stopped"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    // Serial heartbeat loop; always joined before finalization.
    const heartbeatStop = new AbortController();
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted) {
        try {
          await delay(Math.max(10, lease * 1000 / 3), undefined, { signal: heartbeatStop.signal });
        } catch { break; }
        try {
          const renewed = await queue.renewLease(job.id, job.lease_token, lease);
          if (heartbeatStop.signal.aborted) break;
          if (!renewed) {
            const current = await queue.getJobByRunId(job.run_id);
            if (heartbeatStop.signal.aborted) break;
            const cancelled = current?.status === "running" &&
              current.lease_token === job.lease_token && current.cancel_requested_at;
            controller.abort(cancelled
              ? new RuntimeError("CANCELLED", "Agent cancelled")
              : new RuntimeError("LEASE_LOST", "Worker lease lost"));
            break;
          }
        } catch (error) {
          report(error);
          if (!heartbeatStop.signal.aborted) {
            controller.abort(new RuntimeError("HEARTBEAT_FAILED", "Worker heartbeat failed"));
          }
          break;
        }
      }
    })();
    let result: JobResult;
    try {
      result = await executor.execute(job, controller.signal);
    } catch (error) {
      report(error);
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      result = { status: "failed", error: reason instanceof RuntimeError
        ? { code: reason.code, message: reason.message }
        : { code: "WORKER_ERROR", message: "Worker execution interrupted" } };
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      signal.removeEventListener("abort", stop);
    }
    // finalizeJob checks lease and cancellation under locks. Never infer user cancellation from generic abort.
    try {
      // A late shutdown/heartbeat cannot replace a terminal cause already returned
      // by AgentRunner (in particular DEADLINE_EXCEEDED).
      if (!result.error && controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof RuntimeError) {
          result = { ...result, status: "failed", error: { code: reason.code, message: reason.message } };
        }
      }
      const saved = await lifecycle.finalizeJob({ ...result, jobId: job.id, leaseToken: job.lease_token });
      if (!saved) report(new Error(`Finalization fenced: ${job.id}`));
    } catch (error) { report(error); }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!signal.aborted) {
      try {
        await queue.blockExpiredJobs();
        const job = await queue.claim(workerId, lease);
        if (job) await execute(job);
        else await pause();
      } catch (error) {
        report(error);
        await pause();
      }
    }
  }));
}
