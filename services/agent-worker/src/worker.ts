import { inSpan, startSpan, extractTraceContext, withIdentity, metric, log, errorCode } from "@eap/observability";
import { RuntimeError } from "@eap/ai";
import { setTimeout as delay } from "node:timers/promises";
import { withSecurityContext, SecurityError } from "@eap/persistence";
import type { AgentJobQueue, JobLifecycle, ClaimedJob } from "@eap/persistence";
import type { JobExecutor, JobResult } from "./executor";

export interface WorkerOptions {
  approvals?: import("@eap/persistence").ApprovalStore; queue: AgentJobQueue; lifecycle: JobLifecycle; executor: JobExecutor;
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
  const report = options.onError ?? ((error: unknown) => log("error", "worker.error", { error_code: errorCode(error), worker_id: workerId }));
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
            metric("agent_worker_lease_renewal_failures_total",1,{status:"rejected"});
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
          metric("agent_worker_lease_renewal_failures_total",1,{status:"unavailable"});
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
      result = { status: "failed", error: reason instanceof RuntimeError || reason instanceof SecurityError
        ? { code: reason.code, message: reason.message }
        : { code: "WORKER_ERROR", message: "Worker execution interrupted" } };
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      signal.removeEventListener("abort", stop);
    }
    if(result.status==="waiting_approval") return undefined;
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
      const saved = await inSpan("agent.job.finalize", { "agent.run_id": job.run_id, "agent.job_id": job.id },
        () => lifecycle.finalizeJob({ ...result, jobId: job.id, leaseToken: job.lease_token }), undefined, (saved) => saved ? undefined : "LEASE_LOST");
      log(!saved || result.error ? "warn" : "info", saved ? "job.finished" : "job.finalization_fenced", { error_code: saved ? result.error?.code : "LEASE_LOST" });
      if (!saved) report(new Error(`Finalization fenced: ${job.id}`));
      return result.error?.code ?? (saved ? undefined : "LEASE_LOST");
    } catch (error) { report(error); return errorCode(error); }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!signal.aborted) {
      try {
        await options.approvals?.expire();
        const blocked = await queue.blockExpiredJobs();
        if (blocked.length) metric("agent_worker_blocked_jobs_total",blocked.length);
        const claimStarted = Date.now();
        const job = await queue.claim(workerId, lease);
        if (job) {
          // Successful claim spans join the persisted submission context; idle polls do not flood tracing.
          startSpan("agent.job.claim", { "agent.run_id": job.run_id, "agent.job_id": job.id },
            extractTraceContext(job.trace_context), undefined, claimStarted).end();
          metric("agent_worker_claims_total",1);
          metric("agent_queue_wait_seconds",Math.max(0,(Date.now()-new Date(job.created_at).getTime())/1000));
          metric("agent_worker_active_jobs",1);
          const span = startSpan("agent.job.execute", { "agent.run_id": job.run_id, "agent.job_id": job.id }, extractTraceContext(job.trace_context));
          let outcome: string | undefined;
          try {
            outcome = await withIdentity({ run_id: job.run_id, job_id: job.id, worker_id: workerId }, () => span.run(() => job.tenant_id && job.actor_user_id ? withSecurityContext({tenantId:job.tenant_id,actorUserId:job.actor_user_id},()=>execute(job)) : execute(job)));
          } finally { span.end(outcome); metric("agent_worker_active_jobs",-1); }
        }
        else await pause();
      } catch (error) {
        report(error);
        await pause();
      }
    }
  }));
}
