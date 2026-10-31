import { afterEach, expect, it, vi } from "vitest";
import { asyncAgentAccess, validRunId } from "./async-agent-access";
afterEach(() => vi.unstubAllEnvs());
it("denies production, missing opt-in, remote hosts and cross-origin requests", () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("ENABLE_ASYNC_AGENT_DEV", "true");
  expect(asyncAgentAccess(new Request("http://localhost:3551"))?.status).toBe(403);
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("ENABLE_ASYNC_AGENT_DEV", "false");
  expect(asyncAgentAccess(new Request("http://localhost:3551"))?.status).toBe(403);
  vi.stubEnv("ENABLE_ASYNC_AGENT_DEV", "true");
  expect(asyncAgentAccess(new Request("http://public.example"))?.status).toBe(403);
  expect(asyncAgentAccess(new Request("http://localhost:3551", { headers: { Origin: "http://evil.example" } }))?.status).toBe(403);
  expect(asyncAgentAccess(new Request("http://localhost:3551", { headers: { Origin: "http://localhost:3551" } }))).toBeNull();
});
it("validates run identifiers before querying PostgreSQL", () => {
  expect(validRunId(crypto.randomUUID())).toBe(true);
  expect(validRunId("not-a-uuid")).toBe(false);
});
