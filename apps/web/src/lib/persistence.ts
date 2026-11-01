import {
  ApprovalStore,
  createRuntimePool,
  SecurityStore,
  PersistenceStore,
  AgentJobQueue,
  AgentEventStore,
  JobLifecycle,
} from "@eap/persistence";

const globalDb = globalThis as typeof globalThis & {
  __eapSecurityPoolV2?: ReturnType<typeof createRuntimePool>;
  __eapSecurityStoreV2?: PersistenceStore;
};

export const pool =
  globalDb.__eapSecurityPoolV2 ?? createRuntimePool("eap_app");

export const store =
  globalDb.__eapSecurityStoreV2 ?? new PersistenceStore(pool);

globalDb.__eapSecurityPoolV2 = pool;
globalDb.__eapSecurityStoreV2 = store;

export const jobQueue = new AgentJobQueue(pool);
export const eventStore = new AgentEventStore(pool);
export const security = new SecurityStore(pool);
export const jobLifecycle = new JobLifecycle(pool, security);

export const approvals = new ApprovalStore(pool);
