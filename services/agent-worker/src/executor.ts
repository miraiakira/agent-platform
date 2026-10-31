import { AgentRunner, type AgentMessage, type ExecutionTrace, type ModelProvider, type StreamEvent, RuntimeError } from "@eap/ai";
import type { ToolRegistry } from "@eap/tools";
import { AgentEventStore, JobLifecycle, PersistenceStore, type ClaimedJob, type JobFinalization } from "@eap/persistence";

export type JobResult = Omit<JobFinalization, "jobId" | "leaseToken">;
export interface JobExecutor {
  execute(job: ClaimedJob, signal: AbortSignal): Promise<JobResult>;
}

export class AgentExecutor implements JobExecutor {
  constructor(private readonly options: {
    store: PersistenceStore; events: AgentEventStore; lifecycle: JobLifecycle;
    provider: ModelProvider; tools: ToolRegistry; maxDurationMs?: number;
  }) {}

  async execute(job: ClaimedJob, signal: AbortSignal): Promise<JobResult> {
    const { store, events, lifecycle, provider, tools } = this.options;
    const run = await store.getRun(job.run_id);
    if (!run || !Array.isArray(run.input) || !run.input.every((m) =>
      m && typeof m === "object" && !Array.isArray(m) &&
      ["system", "user", "assistant"].includes(String(m.role)) && typeof m.content === "string")) {
      throw new Error("Invalid persisted run input");
    }
    let trace: ExecutionTrace | undefined;
    const runner = new AgentRunner({
      provider, tools,
      budget: { maxDurationMs: this.options.maxDurationMs ?? 60_000 },
      onTrace(value) { trace = value; },
      toolLifecycle: {
        async before(call) {
          if (!await lifecycle.startTool(job.id, job.lease_token, {
            id: call.id, name: call.function.name, arguments: call.function.arguments,
          })) throw new RuntimeError("TOOL_REPLAY_BLOCKED", "Lease invalid or tool intent already exists; replay disabled");
        },
        async after(call, result) {
          if (!await lifecycle.finishTool(job.id, job.lease_token, call.id, result)) {
            throw new RuntimeError("EXECUTION_OUTCOME_UNKNOWN", "Tool outcome cannot be safely committed");
          }
        },
      },
    });
    let answer = "";
    let terminal: StreamEvent | undefined;
    for await (const event of runner.run({ messages: run.input as AgentMessage[], signal })) {
      if (event.type === "done" || event.type === "error") {
        terminal = event;
        continue;
      }
      if (event.type === "text-delta") answer += event.text;
      const saved = await events.append({ runId: run.id, jobId: job.id, leaseToken: job.lease_token, type: event.type, payload: event });
      if (!saved) break;
    }
    return {
      status: terminal?.type === "done" ? "completed" : "failed",
      answer,
      error: terminal?.type === "error" ? { code: terminal.code, message: terminal.message } : undefined,
      trace: trace ? {
        traceId: trace.traceId, durationMs: trace.durationMs, modelCalls: trace.modelCalls, toolCalls: trace.toolCalls,
        inputTokens: trace.usage.inputTokens, outputTokens: trace.usage.outputTokens,
        spans: trace.spans.map((span) => ({
          name: span.name, kind: span.kind, status: span.success ? "success" : "error",
          durationMs: span.durationMs, data: JSON.parse(JSON.stringify(span)),
        })),
      } : undefined,
    };
  }
}
