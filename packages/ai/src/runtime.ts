import { randomUUID } from "node:crypto";
import type { AgentUsage } from "./types";

export interface ExecutionBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxToolDurationMs: number;
  maxToolResultBytes: number;
  maxToolRetries: number;
  maxOutputTokens: number;
}

export const DEFAULT_BUDGET: ExecutionBudget = {
  maxModelCalls: 5,
  maxToolCalls: 8,
  maxDurationMs: 60_000,
  maxToolDurationMs: 10_000,
  maxToolResultBytes: 16 * 1024,
  maxToolRetries: 1,
  maxOutputTokens: 2048,
};

export class RuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export interface TraceSpan {
  id: string;
  kind: "model" | "tool";
  name: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionTrace {
  traceId: string;
  startedAt: string;
  durationMs: number;
  modelCalls: number;
  toolCalls: number;
  usage: AgentUsage;
  spans: TraceSpan[];
}

export function createTrace(): ExecutionTrace {
  return {
    traceId: randomUUID(),
    startedAt: new Date().toISOString(),
    durationMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    spans: [],
  };
}

export function addUsage(
  total: AgentUsage,
  next: AgentUsage,
): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.totalTokens += next.totalTokens;
}

export function addSpan(
  trace: ExecutionTrace,
  span: Omit<TraceSpan, "id">,
): void {
  trace.spans.push({
    id: randomUUID(),
    ...span,
  });
}

export function createDeadline(
  durationMs: number,
  parent?: AbortSignal,
) {
  const controller = new AbortController();
  const started = performance.now();
  let reason: "deadline" | "cancelled" | null = null;

  const abortFromParent = () => {
    reason = "cancelled";
    controller.abort(parent?.reason);
  };

  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      reason = "deadline";
      controller.abort(
        new RuntimeError(
          "DEADLINE_EXCEEDED",
          "Agent deadline exceeded",
        ),
      );
    }
  }, durationMs);

  return {
    signal: controller.signal,

    remainingMs() {
      return Math.max(
        0,
        durationMs - (performance.now() - started),
      );
    },

    throwIfAborted() {
      if (!controller.signal.aborted) return;

      if (reason === "deadline") {
        throw new RuntimeError(
          "DEADLINE_EXCEEDED",
          "Agent deadline exceeded",
        );
      }

      throw new RuntimeError(
        "CANCELLED",
        "Agent cancelled",
      );
    },

    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener(
        "abort",
        abortFromParent,
      );
    },
  };
}

export function combineSignals(
  parent: AbortSignal,
  timeoutMs: number,
) {
  const timeout = AbortSignal.timeout(timeoutMs);

  return AbortSignal.any([parent, timeout]);
}
/** Bound iteration even when a custom provider ignores its AbortSignal. */
export async function* abortableStream<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let done = false;
  try {
    while (!done) {
      if (signal.aborted) throw signal.reason ?? new RuntimeError("CANCELLED", "Agent cancelled");
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new RuntimeError("CANCELLED", "Agent cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      let next: IteratorResult<T>;
      try {
        next = await Promise.race([iterator.next(), aborted]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      done = Boolean(next.done);
      if (!next.done) yield next.value;
    }
  } finally {
    // An uncooperative iterator may never resolve return(); do not block fencing/cleanup.
    if (!done) void iterator.return?.().catch(() => {});
  }
}
