import type {
  AgentMessage,
  FunctionCall,
  ModelProvider,
  StreamEvent,
} from "./types";

import { ToolRegistry } from "@eap/tools";

import {
  abortableStream,
  addSpan,
  addUsage,
  createDeadline,
  createTrace,
  DEFAULT_BUDGET,
  RuntimeError,
  type ExecutionBudget,
} from "./runtime";

import {
  executeToolWithPolicy,
} from "./tool-execution";

export interface AgentRunnerOptions {
  provider: ModelProvider;
  toolLifecycle?: {
    before(call: FunctionCall): Promise<void>;
    after(call: FunctionCall, result: import("./tool-execution").ToolExecutionResult): Promise<void>;
  };
  tools: ToolRegistry;
  budget?: Partial<ExecutionBudget>;
  onTrace?: (
    trace: ReturnType<typeof createTrace>,
  ) => void | Promise<void>;
}

export class AgentRunner {
  private readonly toolLifecycle?: AgentRunnerOptions["toolLifecycle"];
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly budget: ExecutionBudget;
  private readonly onTrace?: AgentRunnerOptions["onTrace"];

  constructor(options: AgentRunnerOptions) {
    this.toolLifecycle = options.toolLifecycle;
    this.provider = options.provider;
    this.tools = options.tools;
    this.budget = {
      ...DEFAULT_BUDGET,
      ...options.budget,
    };
    this.onTrace = options.onTrace;
  }

  async *run(options: {
    messages: AgentMessage[];
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent> {
    const trace = createTrace();

    const deadline = createDeadline(
      this.budget.maxDurationMs,
      options.signal,
    );

    const history: AgentMessage[] = [
      ...options.messages,
    ];

    const tools = this.tools.definitions();
    let terminal = false;

    try {
      yield {
        type: "run-start",
        traceId: trace.traceId,
      };

      for (
        let iteration = 1;
        iteration <= this.budget.maxModelCalls;
        iteration++
      ) {
        deadline.throwIfAborted();

        const remainingToolCalls =
          this.budget.maxToolCalls - trace.toolCalls;

        const availableTools =
          remainingToolCalls > 0 ? tools : [];

        trace.modelCalls++;

        yield {
          type: "model-start",
          iteration,
        };

        const modelStarted = performance.now();
        let modelSucceeded = false;
        let modelErrorCode: string | undefined;

        const pendingCalls = new Map<
          number,
          {
            id: string;
            name: string;
            arguments: string;
          }
        >();

        let text = "";
        let finishReason: string | null = null;
        let usageReceived = false;

        try {
          const modelStream =
            this.provider.streamWithTools({
              messages: history,
              tools: availableTools,
              signal: deadline.signal,
              timeoutMs: Math.max(
                1,
                Math.floor(deadline.remainingMs()),
              ),
              maxOutputTokens:
                this.budget.maxOutputTokens,
            });

          for await (const event of abortableStream(modelStream, deadline.signal)) {
            deadline.throwIfAborted();

            switch (event.type) {
              case "text-delta":
                text += event.text;
                break;

              case "tool-call-delta": {
                const current = pendingCalls.get(
                  event.index,
                ) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };

                current.id = event.id ?? current.id;
                current.name =
                  event.name ?? current.name;
                current.arguments +=
                  event.arguments ?? "";

                pendingCalls.set(
                  event.index,
                  current,
                );
                break;
              }

              case "usage":
                if (usageReceived) {
                  throw new RuntimeError(
                    "INVALID_RESPONSE",
                    "Duplicate usage event",
                  );
                }

                addUsage(trace.usage, event.usage);
                usageReceived = true;
                break;

              case "model-finish":
                finishReason = event.finishReason;
                break;
            }
          }

          deadline.throwIfAborted();
          modelSucceeded = true;
        } catch (error) {
          modelErrorCode =
            error instanceof RuntimeError
              ? error.code
              : "MODEL_ERROR";
          throw error;
        } finally {
          addSpan(trace, {
            kind: "model",
            name: this.provider.name,
            startedAt: new Date(
              Date.now() -
                (performance.now() - modelStarted),
            ).toISOString(),
            durationMs:
              performance.now() - modelStarted,
            success: modelSucceeded,
            errorCode: modelErrorCode,
            metadata: {
              iteration,
              finishReason,
            },
          });
        }

        if (finishReason === "stop") {
          if (pendingCalls.size > 0) {
            throw new RuntimeError(
              "INVALID_RESPONSE",
              "Unexpected tool calls in final response",
            );
          }

          // Day 5：检查是否还有最终回答的模型调用预算
          if (trace.modelCalls >= this.budget.maxModelCalls) {
            throw new RuntimeError(
              "MAX_MODEL_CALLS",
              "No model call budget for final answer",
            );
          }

          // 最终回答也算一次模型调用
          trace.modelCalls++;

          // Stage B: genuinely stream the final answer.
          // Do not append the provisional decision-stage text.
          const finalStarted = performance.now();
          let finalSucceeded = false;
          let finalErrorCode: string | undefined;
          let finalDone = false;
          let finalUsageReceived = false;

          try {
            const finalStream =
              this.provider.streamAgentFinal({
                messages: history,
                signal: deadline.signal,
                timeoutMs: Math.max(
                  1,
                  Math.floor(deadline.remainingMs()),
                ),
                maxOutputTokens: this.budget.maxOutputTokens,
              });

            for await (const event of abortableStream(finalStream, deadline.signal)) {
              deadline.throwIfAborted();

              if (event.type === "text-delta") {
                // This is the actual DeepSeek network delta.
                yield event;
              } else if (event.type === "usage") {
                if (finalUsageReceived) {
                  throw new RuntimeError(
                    "INVALID_RESPONSE",
                    "Duplicate final usage",
                  );
                }

                addUsage(trace.usage, event.usage);
                finalUsageReceived = true;

                yield event;
              } else if (event.type === "done") {
                finalDone = true;
              } else if (event.type === "error") {
                throw new RuntimeError(
                  event.code,
                  event.message,
                );
              }
            }

            deadline.throwIfAborted();
            if (!finalDone) {
              throw new RuntimeError(
                "INVALID_RESPONSE",
                "Final stream ended without done",
              );
            }

            finalSucceeded = true;
          } catch (error) {
            finalErrorCode =
              error instanceof RuntimeError
                ? error.code
                : "MODEL_ERROR";
            throw error;
          } finally {
            addSpan(trace, {
              kind: "model",
              name: `${this.provider.name}:final`,
              startedAt: new Date(
                Date.now() -
                  (performance.now() - finalStarted),
              ).toISOString(),
              durationMs:
                performance.now() - finalStarted,
              success: finalSucceeded,
              errorCode: finalErrorCode,
              metadata: { stage: "final" },
            });
          }

          terminal = true;
          yield { type: "done" };
          return;
        }

        if (
          finishReason !== "tool_calls" ||
          pendingCalls.size === 0
        ) {
          throw new RuntimeError(
            "INVALID_RESPONSE",
            `Unexpected finish reason: ${finishReason}`,
          );
        }

        const calls: FunctionCall[] = [
          ...pendingCalls.entries(),
        ]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => {
            if (!call.id || !call.name) {
              throw new RuntimeError(
                "INVALID_RESPONSE",
                "Incomplete tool call",
              );
            }

            return {
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            };
          });

        if (
          calls.length > remainingToolCalls
        ) {
          throw new RuntimeError(
            "TOOL_BUDGET_EXCEEDED",
            "Too many tool calls requested",
          );
        }

        history.push({
          role: "assistant",
          content: text || null,
          tool_calls: calls,
        });

        for (const call of calls) {
          deadline.throwIfAborted();

          trace.toolCalls++;

          yield {
            type: "tool-start",
            toolCallId: call.id,
            toolName: call.function.name,
          };

          const toolStarted = performance.now();

          let success = false;
          let errorCode: string | undefined;
          let attempts = 0;

          try {
            await this.toolLifecycle?.before(call);
            const result = await executeToolWithPolicy(
              this.tools,
              call.function.name,
              call.function.arguments,
              {
                signal: deadline.signal,
                budget: this.budget,
                remainingMs:
                  deadline.remainingMs,
              },
            );

            await this.toolLifecycle?.after(call, result);
            deadline.throwIfAborted();

            success = result.success;
            errorCode = result.errorCode;
            attempts = result.attempts;

            history.push({
              role: "tool",
              tool_call_id: call.id,
              content: result.content,
            });
          } finally {
            addSpan(trace, {
              kind: "tool",
              name: call.function.name,
              startedAt: new Date(
                Date.now() -
                  (performance.now() - toolStarted),
              ).toISOString(),
              durationMs:
                performance.now() - toolStarted,
              success,
              errorCode,
              metadata: {
                toolCallId: call.id,
                attempts,
              },
            });
          }

          yield {
            type: "tool-result",
            toolCallId: call.id,
            toolName: call.function.name,
            success,
            attempts,
          };
        }
      }

      throw new RuntimeError(
        "MAX_MODEL_CALLS",
        "Agent exceeded model call budget",
      );
    } catch (error) {
      terminal = true;

      // Timers and performance.now() need not agree at the boundary. Use the
      // first actual abort cause, even if a different error surfaces afterwards.
      const code = deadline.terminationReason?.code ?? (
        error instanceof RuntimeError ? error.code : "AGENT_ERROR"
      );

      yield {
        type: "error",
        code,
        message:
          code === "CANCELLED"
            ? "Agent cancelled"
            : "Agent execution failed",
      };
    } finally {
      deadline.dispose();

      trace.durationMs =
        Date.now() -
        new Date(trace.startedAt).getTime();

      try {
        await this.onTrace?.(trace);
      } catch {
        // Telemetry failures must not replace the
        // original execution result.
      }

      // Do not emit another terminal event here.
      void terminal;
    }
  }
}