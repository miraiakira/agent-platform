import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {

  PersistenceStore,
  recoverInterruptedRuns,
} from "../src";

import type { Pool } from "pg";
import { createTestDatabase } from "./database";

describe("PersistenceStore integration", () => {
  let pool: Pool;
  let store: PersistenceStore;

  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  beforeEach(async () => {
    database = await createTestDatabase();
    pool = database.pool;
    store = new PersistenceStore(pool);
  });
  afterEach(async () => { await database?.close(); database = undefined; });

  it("persists conversations and messages", async () => {
    const conversation =
      await store.createConversation("Day 6 test");

    await store.addMessage({
      conversationId: conversation.id,
      role: "user",
      content: "Hello",
    });

    await store.addMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: "Hello!",
    });

    const messages =
      await store.listMessages(conversation.id);

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("enforces run state transitions", async () => {
    const conversation =
      await store.createConversation();

    const run = await store.createRun({
      conversationId: conversation.id,
      traceId: crypto.randomUUID(),
      messages: [],
    });

    expect(
      await store.transitionRun(
        run.id,
        "pending",
        "running",
      ),
    ).toBe(true);

    expect(
      await store.transitionRun(
        run.id,
        "pending",
        "running",
      ),
    ).toBe(false);

    expect(
      await store.finishRun({
        runId: run.id,
        status: "completed",
        output: { answer: "Done" },
      }),
    ).toBe(true);

    expect(
      await store.finishRun({
        runId: run.id,
        status: "failed",
      }),
    ).toBe(false);

    const saved = await store.getRun(run.id);

    expect(saved?.status).toBe("completed");
  });

  it("prevents duplicate tool reservations", async () => {
    const conversation =
      await store.createConversation();

    const run = await store.createRun({
      conversationId: conversation.id,
      traceId: crypto.randomUUID(),
      messages: [],
    });

    const input = {
      runId: run.id,
      toolCallId: "call-1",
      toolName: "transfer",
      idempotencyKey: `${run.id}:call-1`,
      arguments: { amount: 100 },
    };

    expect(await store.reserveTool(input))
      .toBe(true);

    expect(await store.reserveTool(input))
      .toBe(false);

    expect(
      await store.markToolRunning(
        input.idempotencyKey,
      ),
    ).toBe(true);

    expect(
      await store.finishTool({
        idempotencyKey: input.idempotencyKey,
        status: "succeeded",
        output: { transactionId: "TX-1" },
      }),
    ).toBe(true);

    const saved = await store.getToolExecution(
      input.idempotencyKey,
    );

    expect(saved.status).toBe("succeeded");
  });

  it("persists trace spans and usage", async () => {
    const conversation =
      await store.createConversation();

    const run = await store.createRun({
      conversationId: conversation.id,
      traceId: crypto.randomUUID(),
      messages: [],
    });

    await store.saveTrace({
      runId: run.id,
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 120,
      outputTokens: 40,
      spans: [
        {
          name: "model-call",
          kind: "model",
          status: "success",
          durationMs: 200,
        },
        {
          name: "tool-call",
          kind: "tool",
          status: "success",
          durationMs: 50,
        },
      ],
    });

    const saved = await store.getRun(run.id);
    const spans = await store.listSpans(run.id);

    expect(saved?.model_calls).toBe(2);
    expect(saved?.tool_calls).toBe(1);
    expect(saved?.input_tokens).toBe(120);
    expect(spans).toHaveLength(2);
  });

  it("marks stale runs as interrupted", async () => {
    const conversation =
      await store.createConversation();

    const run = await store.createRun({
      conversationId: conversation.id,
      traceId: crypto.randomUUID(),
      messages: [],
    });

    await store.transitionRun(
      run.id,
      "pending",
      "running",
    );

    // 模拟 Agent 已经 5 分钟没有发送心跳
    await pool.query(
        `UPDATE agent_runs
        SET heartbeat_at = now() - INTERVAL '5 minutes'
        WHERE id = $1`,
        [run.id],
    );

    // 超过 2 分钟未发送心跳，则判定为中断
    const recovered = await recoverInterruptedRuns(
        store,
        { staleAfterMs: 120_000 },
    );

    expect(recovered).toContain(run.id);

    const saved = await store.getRun(run.id);

    expect(saved?.status).toBe("interrupted");

    expect(saved?.error).toMatchObject({
        code: "WORKER_INTERRUPTED",
    });

    // 再次恢复时，不应该重复处理已中断的 Run
    const recoveredAgain = await recoverInterruptedRuns(
        store,
        { staleAfterMs: 120_000 },
    );

    expect(recoveredAgain).not.toContain(run.id);
  });
});