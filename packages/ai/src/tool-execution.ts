import {
  ToolError,
  ToolRegistry,
} from "@eap/tools";

import {
  combineSignals,
  RuntimeError,
  type ExecutionBudget,
} from "./runtime";

const RETRYABLE_CODES = new Set([
  "UPSTREAM_ERROR",
]);

export interface ToolExecutionResult {
  content: string;
  success: boolean;
  attempts: number;
  errorCode?: string;
}

export function serializeLimited(
  value: unknown,
  maxBytes: number,
): string {
  const content = JSON.stringify(value);
  const bytes = new TextEncoder().encode(content);

  if (bytes.byteLength > maxBytes) {
    throw new RuntimeError(
      "TOOL_RESULT_TOO_LARGE",
      `Tool result exceeds ${maxBytes} bytes`,
    );
  }

  return content;
}

export async function executeToolWithPolicy(
  registry: ToolRegistry,
  name: string,
  args: string,
  options: {
    signal: AbortSignal;
    budget: ExecutionBudget;
    remainingMs: () => number;
  },
): Promise<ToolExecutionResult> {
  const maxAttempts = options.budget.maxToolRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal.aborted) {
      throw new RuntimeError("CANCELLED", "Agent cancelled");
    }

    const timeoutMs = Math.min(
      options.budget.maxToolDurationMs,
      options.remainingMs(),
    );

    if (timeoutMs <= 0) {
      throw new RuntimeError(
        "DEADLINE_EXCEEDED",
        "Agent deadline exceeded",
      );
    }

    const signal = combineSignals(
      options.signal,
      timeoutMs,
    );

    try {
      const result = await registry.execute(
        name,
        args,
        { signal },
      );

      if (signal.aborted) {
        throw new RuntimeError(
          "TOOL_TIMEOUT",
          "Tool exceeded its deadline",
        );
      }

      return {
        content: serializeLimited(
          result,
          options.budget.maxToolResultBytes,
        ),
        success: true,
        attempts: attempt,
      };
    } catch (error) {
      if (options.signal.aborted) {
        throw new RuntimeError(
          "CANCELLED",
          "Agent cancelled",
        );
      }

      const code =
        error instanceof ToolError ||
        error instanceof RuntimeError
          ? error.code
          : "TOOL_EXECUTION_FAILED";

      if (
        signal.aborted &&
        !options.signal.aborted
      ) {
        // A timed-out tool is not retried in Day 5.
        return {
          content: JSON.stringify({
            error: "TOOL_TIMEOUT",
          }),
          success: false,
          attempts: attempt,
          errorCode: "TOOL_TIMEOUT",
        };
      }

      if (
        !RETRYABLE_CODES.has(code) ||
        attempt >= maxAttempts
      ) {
        return {
          content: JSON.stringify({ error: code }),
          success: false,
          attempts: attempt,
          errorCode: code,
        };
      }

      const delayMs = Math.min(
        100 * 2 ** (attempt - 1),
        options.remainingMs(),
      );

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          options.signal.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);

        const onAbort = () => {
          clearTimeout(timer);
          reject(
            new RuntimeError(
              "CANCELLED",
              "Agent cancelled",
            ),
          );
        };

        options.signal.addEventListener(
          "abort",
          onAbort,
          { once: true },
        );
      });
    }
  }

  throw new RuntimeError(
    "TOOL_EXECUTION_FAILED",
    "Unexpected retry state",
  );
}