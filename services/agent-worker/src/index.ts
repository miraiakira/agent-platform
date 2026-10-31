import { randomUUID } from "node:crypto";
import { createModelProvider } from "@eap/ai";
import { createBusinessTools } from "@eap/tools";
import { createPool, AgentJobQueue, AgentEventStore, PersistenceStore, JobLifecycle } from "@eap/persistence";
import { AgentExecutor } from "./executor";
import { runWorker } from "./worker";

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

async function main() {
  const providerName = process.env.LLM_PROVIDER ?? "mock";
  if (providerName !== "mock" && providerName !== "deepseek") throw new Error("Unsupported worker LLM_PROVIDER");
  const provider = createModelProvider({ provider: providerName, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL, baseURL: process.env.LLM_BASE_URL || undefined });
  const pool = createPool();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const lifecycle = new JobLifecycle(pool);
    await runWorker({
      queue: new AgentJobQueue(pool), lifecycle,
      executor: new AgentExecutor({ store: new PersistenceStore(pool), events: new AgentEventStore(pool), lifecycle, provider,
        tools: createBusinessTools({ baseURL: process.env.BUSINESS_API_URL ?? "http://127.0.0.1:8080", apiKey: process.env.BUSINESS_API_KEY }),
        maxDurationMs: positive("WORKER_MAX_DURATION_MS", 60_000),
      }),
      workerId: process.env.WORKER_ID ?? `agent-worker-${randomUUID()}`,
      signal: shutdown.signal,
      concurrency: positive("WORKER_CONCURRENCY", 1),
      leaseSeconds: positive("WORKER_LEASE_SECONDS", 30),
      pollIntervalMs: positive("WORKER_POLL_INTERVAL_MS", 1000),
    });
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await pool.end();
  }
}

main().catch((error) => { console.error("[worker] fatal", error); process.exitCode = 1; });
