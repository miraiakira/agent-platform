import { inSpan, estimateCost, currentTraceId, log } from "@eap/observability";
import { AgentRunner, type AgentMessage, type ExecutionTrace, type ModelProvider, type StreamEvent, RuntimeError, AgentPaused } from "@eap/ai";
import type { ToolRegistry } from "@eap/tools";
import { verifyPromptPin, SecurityError, ApprovalStore, AgentEventStore, JobLifecycle, PersistenceStore, type ClaimedJob, type SecurityStore, type JobFinalization } from "@eap/persistence";

export type JobResult = Omit<JobFinalization, "jobId" | "leaseToken"> | {status:"waiting_approval";error?:undefined};
export interface JobExecutor {
  execute(job: ClaimedJob, signal: AbortSignal): Promise<JobResult>;
}

export class AgentExecutor implements JobExecutor {
  constructor(private readonly options: {
    store: PersistenceStore; events: AgentEventStore; lifecycle: JobLifecycle;
    approvals?: ApprovalStore; security: Pick<SecurityStore, "validateJob">; provider: ModelProvider; model?: string; tools: ToolRegistry; maxDurationMs?: number;
  }) {}

  async execute(job: ClaimedJob, signal: AbortSignal): Promise<JobResult> {
    const { store, events, lifecycle, provider, tools } = this.options;
    const run = await store.getRun(job.run_id);
    if (!run || !Array.isArray(run.input) || !run.input.every((m) =>
      m && typeof m === "object" && !Array.isArray(m) &&
      ["system", "user", "assistant"].includes(String(m.role)) && typeof m.content === "string")) {
      throw new Error("Invalid persisted run input");
    }
    const approvals=this.options.approvals;
    try{await this.options.security.validateJob(job,run);}catch(error){
      if(job.active_approval_id && approvals) await approvals.security.audit('approval.execution_denied','approval',job.active_approval_id,'deny',error instanceof SecurityError?error.code:'INVALID_JOB_AUTHORIZATION').catch(()=>log('error','security.audit_unavailable',{error_code:'AUDIT_UNAVAILABLE'}));
      throw error;
    }
    const pinned=run.prompt_binding?await verifyPromptPin(store.db,run.prompt_binding,run.input):null;
    if(pinned&&pinned.model_config.provider!==provider.name)throw new SecurityError(409,'PROMPT_MODEL_MISMATCH');
    const model=pinned?.model_config.model??this.options.model;
    const resumed=await approvals?.resume(job);
    if(pinned&&resumed&&resumed.state.history[0]?.content!==(run.input as AgentMessage[])[0]?.content)throw new SecurityError(409,'PROMPT_CHECKPOINT_MISMATCH');
    let paused=false;
    let trace: ExecutionTrace | undefined;
    const runner = new AgentRunner({
      provider, tools, model,
      budget: { maxDurationMs: this.options.maxDurationMs ?? 60_000 },
      onTrace(value) { trace = value; },
      beforeTool: approvals ? async (state,deadlineSignal) => {
        if(run.prompt_binding)await verifyPromptPin(store.db,run.prompt_binding,run.input);
        const call=state.batch.calls[state.batch.nextIndex]!;
        if(resumed?.grant.callId===call.id) return;
        // Only valid registered calls can request approval; invalid arguments remain normal tool errors.
        if(!tools.validCall(call.function.name,call.function.arguments))return;
        try {
          const policy=await approvals.policy(call.function.name);
          if(policy.requires_approval && await approvals.pause(job,state,3600,deadlineSignal)) {paused=true;throw new AgentPaused();}
        }catch(error){if(error instanceof SecurityError){
          if(error.code==='TOOL_FORBIDDEN') {
            try{await approvals.security.audit('tool.execute','tool',call.function.name,'deny',error.code);}catch{throw new RuntimeError('AUDIT_UNAVAILABLE','Required security audit unavailable');}
          }
          throw new RuntimeError(error.code,error.code);
        }throw error;}
      } : undefined,
      toolLifecycle: {
        async before(call) {
          const grant=resumed?.grant.callId===call.id?resumed.grant:undefined;
          if (!await lifecycle.startTool(job.id, job.lease_token, {
            id: call.id, name: call.function.name, arguments: call.function.arguments,
          },grant)) throw new RuntimeError("TOOL_REPLAY_BLOCKED", "Lease invalid or tool intent already exists; replay disabled");
          return {job:{id:job.id,leaseToken:job.lease_token},...(grant?{approval:grant}:{})};
        },
        async after(call, result) {
          try {
            if (!await lifecycle.finishTool(job.id, job.lease_token, call.id, result)) throw new Error("Outcome not committed");
          } catch {
            log("error", "security.tool_result_unavailable", { error_code: "EXECUTION_OUTCOME_UNKNOWN" });
            // An external success cannot be undone. Leave the existing intent for
            // finalize/recovery to mark UNKNOWN; never replay the effect.
            throw new RuntimeError("EXECUTION_OUTCOME_UNKNOWN", "Tool outcome cannot be safely committed");
          }
        },
      },
    });
    let answer = "";
    let terminal: StreamEvent | undefined;
    try{await inSpan("agent.prompt.execute",run.prompt_binding?{"agent.prompt.version_id":run.prompt_binding.prompt_version_id,"agent.prompt.release_id":run.prompt_binding.release_id,"agent.prompt.variant":run.prompt_binding.variant}:{},async()=>{for await (const event of runner.run({ messages: run.input as AgentMessage[], signal, checkpoint:resumed?.state })) {
      if (event.type === "done" || event.type === "error") {
        terminal = event;
        continue;
      }
      if (event.type === "text-delta") answer += event.text;
      const saved = await events.append({ runId: run.id, jobId: job.id, leaseToken: job.lease_token, type: event.type, payload: event });
      if (!saved) break;
    }});
    }catch(error){
      if(error instanceof RuntimeError && error.code==='INVALID_CHECKPOINT' && job.active_approval_id && approvals) await approvals.security.audit('approval.execution_denied','approval',job.active_approval_id,'deny',error.code).catch(()=>log('error','security.audit_unavailable',{error_code:'AUDIT_UNAVAILABLE'}));
      throw error;
    }
    if(paused) return {status:"waiting_approval"};
    return {
      status: terminal?.type === "done" ? "completed" : "failed",
      answer,
      error: terminal?.type === "error" ? { code: terminal.code, message: terminal.message } : undefined,
      observability: trace ? {
        provider: provider.name, model: provider.name === "mock" ? "mock-model" : model ?? "unknown",
        otelTraceId: currentTraceId(), inputTokens: trace.usage.inputTokens, outputTokens: trace.usage.outputTokens,
        usageSource: trace.usageReports === trace.modelCalls ? "reported" : (trace.usageReports ?? 0) > 0 ? "partial" : "unavailable",
        cost: { ...estimateCost(provider.name, provider.name === "mock" ? "mock-model" : model ?? "unknown",trace.usage.inputTokens,trace.usage.outputTokens,new Date(trace.startedAt)),
          ...(!trace.usageReports ? { usd: null } : {}) },
      } : undefined,
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
