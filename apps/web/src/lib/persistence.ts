import {
  createRuntimePool,
  SecurityStore,
  PersistenceStore,
  AgentJobQueue,
  AgentEventStore,
  JobLifecycle,
} from "@eap/persistence";

const globalDb = globalThis as typeof globalThis & {
  __eapSecurityPoolV1?: ReturnType<typeof createRuntimePool>;
  __eapSecurityStoreV1?: PersistenceStore;
};

export const pool =
  globalDb.__eapSecurityPoolV1 ?? createRuntimePool("eap_app");

export const store =
  globalDb.__eapSecurityStoreV1 ?? new PersistenceStore(pool);

globalDb.__eapSecurityPoolV1 = pool;
globalDb.__eapSecurityStoreV1 = store;

export const jobQueue = new AgentJobQueue(pool);
export const eventStore = new AgentEventStore(pool);
export const security = new SecurityStore(pool);
export const jobLifecycle = new JobLifecycle(pool, security);
