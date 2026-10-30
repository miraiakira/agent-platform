import {
  createPool,
  PersistenceStore,
} from "@eap/persistence";

const globalDb = globalThis as typeof globalThis & {
  __eapPool?: ReturnType<typeof createPool>;
  __eapStore?: PersistenceStore;
};

export const pool =
  globalDb.__eapPool ?? createPool();

export const store =
  globalDb.__eapStore ?? new PersistenceStore(pool);

globalDb.__eapPool = pool;
globalDb.__eapStore = store;