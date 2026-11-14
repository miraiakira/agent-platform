import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Standalone HTTP probe: never import the load harness or start any services.
type Check = { name: string; http_status: number; duration_ms: number };
const checks: Check[] = [];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
let runId: string | undefined;
let runStatus: string | undefined;
let accepted = false;
let requests = 0;
let started: number | undefined;
let lastFinished: number | undefined;
class ProbeError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ProbeError(code); }
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

async function main() {
  let status: 'PASS' | 'FAIL' | 'NOT VERIFIED' = 'NOT VERIFIED';
  let reason = 'CONFIGURATION_REQUIRED';
  try {
    const env = process.env;
    if (env.NODE_ENV === 'production') fail('PRODUCTION_PROBE_FORBIDDEN');
    // Operator attestation, not automatic proof of the server's configuration.
    if (env.LOW_RESOURCE_FIXTURE_READY !== 'true') fail('FIXTURE_ATTESTATION_REQUIRED');
    const base = env.LOW_RESOURCE_BASE_URL;
    if (base !== 'http://127.0.0.1:3554') fail('DEDICATED_LOOPBACK_TARGET_REQUIRED');
    const tenant = env.LOW_RESOURCE_TENANT_ID ?? '';
    const knowledgeBase = env.LOW_RESOURCE_KNOWLEDGE_BASE_ID ?? '';
    const cookie = env.LOW_RESOURCE_COOKIE ?? '';
    if (!uuid.test(tenant) || !uuid.test(knowledgeBase)) fail('FIXTURE_IDS_REQUIRED');
    if (!cookie || cookie.length > 4096 || /[\r\n]/.test(cookie)) fail('SESSION_COOKIE_REQUIRED');
    started = performance.now();
    const remaining = () => 10_000 - (performance.now() - started!);

    async function request(name: string, path: string, method = 'GET', body?: unknown) {
      if (lastFinished !== undefined) {
        const wait = Math.max(0, 2000 - (performance.now() - lastFinished));
        if (remaining() <= wait) fail('WINDOW_EXPIRED');
        await delay(wait);
      }
      if (remaining() < 1 || requests >= 5) fail('WINDOW_EXPIRED');
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(1500, remaining()))));
      requests++;
      const before = performance.now();
      try {
        const response = await fetch(base + path, {
          method, signal, redirect: 'error',
          headers: {
            Cookie: cookie, Origin: base!, 'x-tenant-id': tenant,
            'Content-Type': 'application/json',
            ...(method === 'POST' && name === 'submit'
              ? { 'Idempotency-Key': `low-resource-${randomUUID()}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        checks.push({ name, http_status: response.status, duration_ms: Math.round(performance.now() - before) });
        if (response.status !== (name === 'submit' ? 202 : 200)) {
          await response.body?.cancel();
          fail('UNEXPECTED_HTTP_STATUS');
        }
        // Bound response buffering before JSON parsing.
        const reader = response.body?.getReader();
        if (!reader) fail('EMPTY_RESPONSE');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 65536) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        const value = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!value) fail('INVALID_RESPONSE');
        return value;
      } catch (error) {
        if (error instanceof ProbeError) throw error;
        if (remaining() <= 0) fail('WINDOW_EXPIRED');
        fail(signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_OR_RESPONSE_FAILED');
      } finally { lastFinished = performance.now(); }
    }

    await request('health', '/api/health');
    const submission = await request('submit', '/api/agent/jobs', 'POST', {
      messages: [{ role: 'user', content: 'Reply briefly with OK. Do not call any tools.' }],
    });
    if (typeof submission.runId !== 'string' || !uuid.test(submission.runId)) fail('INVALID_RUN_ID');
    runId = submission.runId;
    accepted = true;
    async function readStatus(name: string) {
      const value = await request(name, `/api/agent/runs/${runId}`);
      const run = object(value.run);
      if (!run || run.id !== runId || typeof run.status !== 'string') fail('INVALID_RUN_RESPONSE');
      const state = run.status as string;
      if (!['pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'interrupted'].includes(state)) fail('INVALID_RUN_STATUS');
      runStatus = state;
      if (['failed', 'cancelled', 'interrupted'].includes(state)) fail('JOB_TERMINATED_UNSUCCESSFULLY');
    }
    await readStatus('status');
    const retrieval = await request('retrieval', '/api/knowledge/search', 'POST', {
      query: 'refund policy', knowledge_base_ids: [knowledgeBase], top_k: 1, mode: 'hybrid',
    });
    if (!Array.isArray(retrieval.results) || retrieval.results.length === 0) fail('FIXTURE_RETRIEVAL_EMPTY');
    await readStatus('final-status');
    status = runStatus === 'completed' ? 'PASS' : 'NOT VERIFIED';
    reason = status === 'PASS' ? 'LOW_LOAD_FLOW_COMPLETED' : 'JOB_NOT_COMPLETED_IN_WINDOW';
  } catch (error) {
    reason = error instanceof ProbeError ? error.code : 'PROBE_FAILED';
    status = ['WINDOW_EXPIRED', 'REQUEST_TIMEOUT', 'CONFIGURATION_REQUIRED',
      'FIXTURE_ATTESTATION_REQUIRED', 'DEDICATED_LOOPBACK_TARGET_REQUIRED',
      'FIXTURE_IDS_REQUIRED', 'SESSION_COOKIE_REQUIRED', 'PRODUCTION_PROBE_FORBIDDEN'].includes(reason)
      ? 'NOT VERIFIED' : 'FAIL';
  }
  console.log(JSON.stringify({
    profile: 'low-resource', scope: 'isolated-fixture-flow-only', status, reason,
    generated_at: new Date().toISOString(), requests, checks, accepted,
    run_id: runId ?? null, run_status: runStatus ?? null,
    elapsed_ms: started === undefined ? 0 : Math.round(performance.now() - started),
    cpu_limit: 'NOT ENFORCED', fixture_configuration: 'OPERATOR_ATTESTED',
    notes: ['Not stress or production readiness evidence.',
      'An accepted job may continue after this probe exits; no automatic cancellation or retry.'],
  }, null, 2));
  process.exitCode = status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2;
}

void main();
