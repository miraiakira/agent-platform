import { randomUUID } from "node:crypto";

import {
  createPool,
  AgentJobQueue,
} from "@eap/persistence";

import type { JobExecutor } from "./executor";

const pool = createPool();
const queue = new AgentJobQueue(pool);

const workerId = `agent-worker-${randomUUID()}`;

const LEASE_SECONDS = 30;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 10_000;

let stopping = false;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runWorker(
  executor: JobExecutor,
) {
  console.log(`[worker] started: ${workerId}`);

  while (!stopping) {
    let job;

    try {
      job = await queue.claim(
        workerId,
        LEASE_SECONDS,
      );
    } catch (error) {
      console.error("[worker] claim failed", error);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    console.log(
      `[worker] claimed run=${job.run_id}`,
    );

    const controller = new AbortController();

    let heartbeatInProgress = false;

    const heartbeat = setInterval(async () => {
      if (heartbeatInProgress) return;

      heartbeatInProgress = true;

      try {
        const renewed = await queue.renewLease(
          job.id,
          job.lease_token,
          LEASE_SECONDS,
        );

        if (!renewed) {
          console.error(
            `[worker] lease lost: ${job.id}`,
          );

          controller.abort();
        }

        const current = await queue.getJobByRunId(
          job.run_id,
        );

        if (current?.cancel_requested_at) {
          controller.abort();
        }
      } catch (error) {
        console.error(
          "[worker] heartbeat failed",
          error,
        );

        // 续租失败时保守停止执行。
        controller.abort();
      } finally {
        heartbeatInProgress = false;
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      await executor.execute(
        job,
        controller.signal,
      );

      if (controller.signal.aborted) {
        await queue.finish(
          job.id,
          job.lease_token,
          "cancelled",
        );
      } else {
        const completed = await queue.finish(
          job.id,
          job.lease_token,
          "completed",
        );

        if (!completed) {
          console.error(
            `[worker] completion rejected: ${job.id}`,
          );
        }
      }
    } catch (error) {
      console.error(
        `[worker] run failed: ${job.run_id}`,
        error,
      );

      await queue.finish(
        job.id,
        job.lease_token,
        controller.signal.aborted
          ? "cancelled"
          : "failed",
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
}

process.on("SIGTERM", () => {
  stopping = true;
});

process.on("SIGINT", () => {
  stopping = true;
});

// 下一步注入真正的 Day 6 AgentExecutor。
// 不要使用空实现启动 Worker，否则会错误地把任务标记为完成。

export { runWorker, pool };