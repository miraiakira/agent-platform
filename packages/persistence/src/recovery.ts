import type { PersistenceStore } from "./store";

export interface RecoveryOptions {
  staleAfterMs?: number;
}

export async function recoverInterruptedRuns(
  store: PersistenceStore,
  options: RecoveryOptions = {},
): Promise<string[]> {
  const staleAfterMs = options.staleAfterMs ?? 120_000;

  if (staleAfterMs <= 0) {
    throw new Error("staleAfterMs must be positive");
  }

  const staleBefore = new Date(
    Date.now() - staleAfterMs,
  );

  return store.recoverStaleRuns(staleBefore);
}