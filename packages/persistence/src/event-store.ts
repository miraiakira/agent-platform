import type { Pool } from "pg";
import { insertEvent, lockLease, transaction } from "./transaction";

export interface StoredAgentEvent {
  /** Per-run sequence, used as the public SSE cursor. */
  id: string;
  run_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
}

export class AgentEventStore {
  constructor(private readonly db: Pool) {}

  async append(input: {
    runId: string; jobId: string; leaseToken: string; type: string; payload: unknown;
  }): Promise<StoredAgentEvent | null> {
    if (["done", "error"].includes(input.type)) {
      throw new Error("Terminal events must be written by finalizeJob");
    }
    return transaction(this.db, async (client) => {
      const job = await lockLease(client, input.jobId, input.leaseToken);
      if (!job || job.run_id !== input.runId || job.cancel_requested_at) return null;
      return insertEvent(client, input.runId, input.type, input.payload);
    });
  }

  async listAfter(runId: string, afterId: string, limit = 100): Promise<StoredAgentEvent[]> {
    if (!/^\d{1,19}$/.test(afterId) || BigInt(afterId) > BigInt("9223372036854775807")) {
      throw new Error("Invalid event cursor");
    }
    const result = await this.db.query<StoredAgentEvent>(
      `SELECT sequence::text AS id, run_id, event_type, payload, created_at
       FROM agent_events WHERE run_id = $1 AND sequence > $2::bigint
       ORDER BY sequence LIMIT $3`,
      [runId, afterId, Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows;
  }
}
