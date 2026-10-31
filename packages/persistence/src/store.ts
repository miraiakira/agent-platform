import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type {
  AgentRunRecord,
  Conversation,
  JsonValue,
  MessageRole,
  RunStatus,
  SpanInput,
  StoredMessage,
} from "./types";

const transitions: Record<RunStatus, RunStatus[]> = {
  pending: ["running", "cancelled", "interrupted"],
  running: [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export class PersistenceStore {
  constructor(private readonly db: Pool) {}

  async createConversation(
    title = "New conversation",
  ): Promise<Conversation> {
    const result = await this.db.query<Conversation>(
      `INSERT INTO conversations (id, title)
       VALUES ($1, $2)
       RETURNING *`,
      [randomUUID(), title],
    );

    return result.rows[0]!;
  }

  async getConversation(
    id: string,
  ): Promise<Conversation | null> {
    const result = await this.db.query<Conversation>(
      `SELECT * FROM conversations WHERE id = $1`,
      [id],
    );

    return result.rows[0] ?? null;
  }

  async listConversations(
    limit = 30,
  ): Promise<Conversation[]> {
    const result = await this.db.query<Conversation>(
      `SELECT * FROM conversations
       ORDER BY updated_at DESC, id DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );

    return result.rows;
  }

  async addMessage(input: {
    conversationId: string;
    runId?: string;
    role: MessageRole;
    content: JsonValue;
  }): Promise<StoredMessage> {
    if (input.runId && (await this.db.query("SELECT 1 FROM agent_jobs WHERE run_id=$1", [input.runId])).rowCount) {
      throw new Error("Queued run messages require finalizeJob with a valid lease");
    }
    const result = await this.db.query<StoredMessage>(
      `INSERT INTO messages (
         id, conversation_id, run_id, role, content
       )
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [
        randomUUID(),
        input.conversationId,
        input.runId ?? null,
        input.role,
        JSON.stringify(input.content),
      ],
    );

    await this.db.query(
      `UPDATE conversations
       SET updated_at = now()
       WHERE id = $1`,
      [input.conversationId],
    );

    return result.rows[0]!;
  }

  async listMessages(
    conversationId: string,
    limit = 200,
  ): Promise<StoredMessage[]> {
    const result = await this.db.query<StoredMessage>(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE conversation_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC, id ASC`,
      [
        conversationId,
        Math.min(Math.max(limit, 1), 500),
      ],
    );

    return result.rows;
  }

  async createRun(input: {
    conversationId: string;
    traceId: string;
    messages: JsonValue;
  }): Promise<AgentRunRecord> {
    const result = await this.db.query<AgentRunRecord>(
      `INSERT INTO agent_runs (
         id, conversation_id, trace_id, input
       )
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [
        randomUUID(),
        input.conversationId,
        input.traceId,
        JSON.stringify(input.messages),
      ],
    );

    return result.rows[0]!;
  }

  async getRun(
    id: string,
  ): Promise<AgentRunRecord | null> {
    const result = await this.db.query<AgentRunRecord>(
      `SELECT * FROM agent_runs WHERE id = $1`,
      [id],
    );

    return result.rows[0] ?? null;
  }

  async listRuns(
    conversationId: string,
  ): Promise<AgentRunRecord[]> {
    const result = await this.db.query<AgentRunRecord>(
      `SELECT * FROM agent_runs
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [conversationId],
    );

    return result.rows;
  }

  async transitionRun(
    id: string,
    from: RunStatus,
    to: RunStatus,
  ): Promise<boolean> {
    if (!transitions[from].includes(to)) {
      throw new Error(
        `Invalid run transition: ${from} -> ${to}`,
      );
    }

    const result = await this.db.query(
      `UPDATE agent_runs
       SET status = $3,
           started_at = CASE
             WHEN $3 = 'running'
             THEN COALESCE(started_at, now())
             ELSE started_at
           END,
           heartbeat_at = CASE
             WHEN $3 = 'running' THEN now()
             ELSE heartbeat_at
           END,
           finished_at = CASE
             WHEN $3 IN (
               'completed', 'failed',
               'cancelled', 'interrupted'
             ) THEN now()
             ELSE finished_at
           END
       WHERE id = $1 AND status = $2
         AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=agent_runs.id)`,
      [id, from, to],
    );

    return result.rowCount === 1;
  }

  async heartbeat(runId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE agent_runs
       SET heartbeat_at = now()
       WHERE id = $1 AND status = 'running'
         AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=agent_runs.id)`,
      [runId],
    );

    return result.rowCount === 1;
  }

  async finishRun(input: {
    runId: string;
    status: "completed" | "failed" | "cancelled";
    output?: JsonValue;
    error?: JsonValue;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE agent_runs
       SET status = $2,
           output = $3::jsonb,
           error = $4::jsonb,
           finished_at = now()
       WHERE id = $1 AND status = 'running'
         AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=agent_runs.id)`,
      [
        input.runId,
        input.status,
        JSON.stringify(input.output ?? null),
        JSON.stringify(input.error ?? null),
      ],
    );

    return result.rowCount === 1;
  }

  async saveTrace(input: {
    runId: string;
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    spans: SpanInput[];
  }): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query("BEGIN");
      if ((await client.query("SELECT 1 FROM agent_jobs WHERE run_id=$1", [input.runId])).rowCount) {
        throw new Error("Queued run trace requires finalizeJob with a valid lease");
      }

      await client.query(
        `UPDATE agent_runs
         SET model_calls = $2,
             tool_calls = $3,
             input_tokens = $4,
             output_tokens = $5
         WHERE id = $1`,
        [
          input.runId,
          input.modelCalls,
          input.toolCalls,
          input.inputTokens,
          input.outputTokens,
        ],
      );

      for (const [index, span] of input.spans.entries()) {
        await client.query(
          `INSERT INTO trace_spans (
             id, run_id, span_index, name, kind,
             status, duration_ms, data
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8::jsonb
           )
           ON CONFLICT (run_id, span_index)
           DO UPDATE SET
             name = EXCLUDED.name,
             kind = EXCLUDED.kind,
             status = EXCLUDED.status,
             duration_ms = EXCLUDED.duration_ms,
             data = EXCLUDED.data`,
          [
            randomUUID(),
            input.runId,
            index,
            span.name,
            span.kind,
            span.status,
            span.durationMs ?? null,
            JSON.stringify(span.data ?? {}),
          ],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSpans(runId: string) {
    const result = await this.db.query(
      `SELECT * FROM trace_spans
       WHERE run_id = $1
       ORDER BY span_index`,
      [runId],
    );

    return result.rows;
  }

  async reserveTool(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    idempotencyKey: string;
    arguments: JsonValue;
  }): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO tool_executions (
         id, run_id, tool_call_id, tool_name,
         idempotency_key, status, input
       )
       SELECT $1, $2, $3, $4, $5, 'reserved', $6::jsonb
       WHERE NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=$2)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        input.runId,
        input.toolCallId,
        input.toolName,
        input.idempotencyKey,
        JSON.stringify(input.arguments),
      ],
    );

    return result.rowCount === 1;
  }

  async markToolRunning(
    idempotencyKey: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE tool_executions
       SET status = 'running',
           started_at = now()
       WHERE idempotency_key = $1
         AND status = 'reserved'
         AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=tool_executions.run_id)`,
      [idempotencyKey],
    );

    return result.rowCount === 1;
  }

  async finishTool(input: {
    idempotencyKey: string;
    status: "succeeded" | "failed" | "unknown";
    output?: JsonValue;
    error?: JsonValue;
  }): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE tool_executions
       SET status = $2,
           output = $3::jsonb,
           error = $4::jsonb,
           finished_at = now()
       WHERE idempotency_key = $1
         AND status IN ('reserved', 'running')
         AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id=tool_executions.run_id)`,
      [
        input.idempotencyKey,
        input.status,
        JSON.stringify(input.output ?? null),
        JSON.stringify(input.error ?? null),
      ],
    );

    return result.rowCount === 1;
  }

  async getToolExecution(idempotencyKey: string) {
    const result = await this.db.query(
      `SELECT * FROM tool_executions
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );

    return result.rows[0] ?? null;
  }

  async recoverStaleRuns(
    staleBefore: Date,
  ): Promise<string[]> {
    const client = await this.db.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query<{ id: string }>(
        `UPDATE agent_runs
         SET status = 'interrupted',
             finished_at = now(),
             error = jsonb_build_object(
               'code', 'WORKER_INTERRUPTED',
               'message', 'Run interrupted; automatic replay disabled'
             )
         WHERE status = 'running'
           AND NOT EXISTS (SELECT 1 FROM agent_jobs WHERE run_id = agent_runs.id)
           AND (
             heartbeat_at IS NULL
             OR heartbeat_at < $1
           )
         RETURNING id`,
        [staleBefore],
      );

      const ids = result.rows.map((row) => row.id);

      if (ids.length > 0) {
        await client.query(
          `UPDATE tool_executions
           SET status = 'unknown',
               error = jsonb_build_object(
                 'code', 'EXECUTION_OUTCOME_UNKNOWN'
               )
           WHERE run_id = ANY($1::uuid[])
             AND status IN ('reserved', 'running')`,
          [ids],
        );
      }

      await client.query("COMMIT");
      return ids;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}