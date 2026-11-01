import type { AgentMessage, FunctionCall } from './types';
import type { ExecutionBudget, ExecutionTrace } from './runtime';
/** Only emitted between model/tool steps; never halfway through an external effect. */
export interface RunnerCheckpoint {
  version: 1;
  provider: string;
  model: string;
  history: AgentMessage[];
  trace: ExecutionTrace;
  budget: ExecutionBudget;
  elapsedActiveMs: number;
  batch: { iteration: number; calls: FunctionCall[]; nextIndex: number };
}
export class AgentPaused extends Error {
  constructor() { super('Agent durably paused'); }
}
