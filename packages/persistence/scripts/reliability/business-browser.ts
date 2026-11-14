import { chromium, expect as baseExpect, type BrowserContext, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { securityDatabase } from '../../tests/security-database';
import { assertTestTarget, metadata, root } from './common';

assertTestTarget();
const expect = baseExpect.configure({ timeout: 30000 });
const base = 'http://localhost:3555';
const out = resolve(root, 'artifacts/business-browser');
await mkdir(out, { recursive: true, mode: 0o700 });
const source = await metadata('business-browser-acceptance');
const db = await securityDatabase();
const url = new URL(db.connectionString);
await db.admin.query(`ALTER ROLE "${decodeURIComponent(url.username)}" SET search_path TO "${db.schema}"`);
const env = {
  ...process.env, DATABASE_URL: db.connectionString, BETTER_AUTH_URL: base,
  BETTER_AUTH_SECRET: randomUUID() + randomUUID(), PROMPT_ROUTING_KEY: randomUUID() + randomUUID(),
  AGENT_CHECKPOINT_KEY: '22'.repeat(32), EVAL_CODE_REVISION: 'business-browser',
  LLM_PROVIDER: 'mock', LLM_MODEL: 'mock-model', EMBEDDING_PROVIDER: 'mock',
  EVAL_ALLOW_EXTERNAL: 'false', EVAL_ALLOW_JUDGE: 'false', OTEL_ENABLED: 'false',
  NEXT_DIST_DIR: '.next-e2e', WORKER_CONCURRENCY: '1',
  BUSINESS_API_KEY: 'business-browser-isolated-service-key-32',
  BUSINESS_API_URL: 'http://127.0.0.1:8085', ADDR: '127.0.0.1:8085',
};
const children: ReturnType<typeof spawn>[] = [];
const contexts: BrowserContext[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
type Result = { name: string; surface: 'browser' | 'API' | 'setup'; status: 'PASS' | 'FAIL' | 'SKIPPED'; error?: string };
const results: Result[] = [];
const planned: [string, Result['surface']][] = [
  ['三个独立用户真实注册与重新登录', 'browser'],
  ['页面创建组织并配置管理员与只读成员', 'browser'],
  ['只读成员不能管理或提交任务', 'browser'],
  ['配置高风险工具与人工审批策略', 'browser'],
  ['页面提交后台 Agent 任务并暂停待审批', 'browser'],
  ['高风险请求人不能自批', 'browser'],
  ['独立管理员批准并返回原聊天查看结果', 'browser'],
  ['刷新后结果与工具执行记录仍存在', 'browser'],
  ['审批、授权与工具结果审计核对', 'API'],
  ['另一组织的任务、审批、知识与审计隔离', 'API'],
  ['另一组织页面不显示原任务', 'browser'],
];
async function step(index: number, fn: () => Promise<void>) {
  const [name, surface] = planned[index]!;
  console.log('START', name);
  try { await fn(); results.push({ name, surface, status: 'PASS' }); console.log('PASS', name); }
  catch (error) { results.push({ name, surface, status: 'FAIL', error: String(error) }); throw error; }
}
function service(command: string, args: string[], cwd: string, name: string) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(resolve(out, name + '.log'), { mode: 0o600 });
  child.stdout!.pipe(log); child.stderr!.pipe(log); children.push(child);
  child.on('error', error => console.error(name, error.message));
}
async function api(page: Page, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await page.request.fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, ...headers }, data: body,
  });
  if (!response.ok()) throw new Error(`${response.status()} ${path}: ${await response.text()}`);
  return response.json();
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText(option, { exact: true }).click();
}
async function screenshot(page: Page, name: string) { await page.screenshot({ path: resolve(out, name + '.png'), fullPage: true }); }
try {
  service(resolve(root, 'services/business-api/bin/business-api'), [], root, 'business');
  service(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', '3555'], resolve(root, 'apps/web'), 'web');
  service(process.execPath, ['--import', 'tsx', 'src/index.ts'], resolve(root, 'services/agent-worker'), 'worker');
  await expect.poll(async () => { try { return (await fetch(base + '/login', { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, { timeout: 90000 }).toBe(true);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL === 'chromium' ? undefined : 'chrome', headless: true });
  const password = 'Acceptance-' + randomUUID();
  async function account(name: string) {
    const context = await browser!.newContext({ viewport: { width: 1600, height: 1100 } });
    contexts.push(context); await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const email = name.toLowerCase().replaceAll(' ', '-') + '-' + randomUUID() + '@e2e.invalid';
    await page.goto(base + '/login'); await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await page.getByLabel('姓名', { exact: true }).fill(name); await page.getByLabel('邮箱地址').fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '创建账号', exact: true }).click();
    await expect(page).toHaveURL(/security/);
    return { page, email, id: (await api(page, '/api/auth/get-session')).user.id as string };
  }
  let owner!: Awaited<ReturnType<typeof account>>, admin!: Awaited<ReturnType<typeof account>>, viewer!: Awaited<ReturnType<typeof account>>;
  let tenant!: string, run!: string, approval!: string;
  await step(0, async () => {
    owner = await account('Acceptance owner'); admin = await account('Acceptance admin'); viewer = await account('Acceptance viewer');
    await owner.page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(owner.page).toHaveURL(/login/);
    await owner.page.getByLabel('邮箱地址').fill(owner.email); await owner.page.getByLabel('密码', { exact: true }).fill(password);
    await owner.page.getByRole('button', { name: '登录工作空间', exact: true }).click(); await expect(owner.page).toHaveURL(/security/);
  });
  const a = () => owner.page;
  await step(1, async () => {
    await a().getByLabel('组织名称', { exact: true }).fill('Acceptance A');
    await a().getByRole('button', { name: '创建组织', exact: true }).click();
    await expect(a().getByLabel('组织名称', { exact: true })).not.toBeVisible();
    tenant = (await api(a(), '/api/tenants')).tenants[0].id;
    for (const [user, role] of [[admin, '管理员 · admin'], [viewer, '只读成员 · viewer']] as const) {
      await a().getByLabel('已注册用户 ID', { exact: true }).fill(user.id);
      await select(a(), '组织角色', role);
      await a().getByRole('button', { name: '保存成员', exact: true }).click();
      await expect(a().getByRole('row').filter({ hasText: user.email })).toContainText(role.split(' · ')[0]!);
      await user.page.reload(); await select(user.page, '当前组织', 'Acceptance A');
      await expect(user.page.getByRole('combobox', { name: '当前组织', exact: true })).toHaveAttribute('aria-expanded', 'false');
    }
    await screenshot(a(), '01-members');
  });
  await step(2, async () => {
    await viewer.page.goto(base + '/security'); await expect(viewer.page.getByText('当前为只读视图。成员权限由 Owner 或 Admin 管理。')).toBeVisible();
    await expect(viewer.page.getByRole('button', { name: '保存成员', exact: true })).toHaveCount(0);
    await viewer.page.goto(base + '/agent'); await expect(viewer.page.getByLabel('消息内容', { exact: true })).toBeDisabled();
    await screenshot(viewer.page, '02-viewer');
  });
  await step(3, async () => {
    await a().getByRole('tab', { name: '工具策略', exact: true }).click();
    const policy = a().locator('section').filter({ has: a().locator('code').getByText('get_high_risk_transactions', { exact: true }) });
    const enabled = policy.getByRole('switch', { name: '启用高风险交易查询工具' });
    if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click();
    await policy.getByRole('combobox', { name: '工具风险等级', exact: true }).click();
    await a().locator('.ant-select-dropdown:visible .ant-select-item-option-content').getByText('高风险', { exact: true }).click();
    const approvalRequired = policy.getByRole('switch', { name: '执行前需要人工审批', exact: true });
    if (await approvalRequired.getAttribute('aria-checked') !== 'true') await approvalRequired.click();
    await policy.getByRole('button', { name: '保存策略', exact: true }).click();
    await expect(a().getByText('工具策略已保存，后续工具执行将检查最新策略。')).toBeVisible();
  });
  await step(4, async () => {
    await a().goto(base + '/agent');
    await expect(a().getByLabel('消息内容', { exact: true })).toBeEnabled();
    await select(a(), '执行方式', '后台任务 · Async');
    await a().getByLabel('消息内容', { exact: true }).fill('查询高风险交易，核对风险并生成分析。');
    const submitted = a().waitForResponse(r => r.url().endsWith('/api/agent/jobs') && r.request().method() === 'POST');
    await a().getByRole('button', { name: '发送', exact: true }).click();
    const response = await submitted; expect(response.status()).toBe(202); run = (await response.json()).runId;
    await expect(a().getByRole('status')).toHaveText('等待人工审批');
    await expect.poll(async () => (await api(a(), '/api/agent/runs/' + run)).run.status).toBe('waiting_approval');
    await screenshot(a(), '03-waiting-approval');
  });
  await step(5, async () => {
    await a().goto(base + '/approvals'); await a().getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(a().getByRole('button', { name: '批准并继续', exact: true })).toBeDisabled();
    approval = (await api(a(), '/api/approvals')).approvals.find((x: { run_id: string }) => x.run_id === run).id;
    await screenshot(a(), '04-self-approval-disabled');
  });
  await step(6, async () => {
    const p = admin.page; await p.goto(base + '/approvals');
    await p.getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(p.getByRole('button', { name: '批准并继续', exact: true })).toBeEnabled();
    await p.getByLabel('决策原因（最多 500 字，请勿填写敏感信息）').fill('独立验收：核对工具与脱敏参数后批准');
    await p.getByRole('button', { name: '批准并继续', exact: true }).click();
    await expect(p.getByText('审批已处理', { exact: true })).toBeVisible();
    await expect.poll(async () => (await api(a(), '/api/agent/runs/' + run)).run.status).toBe('completed');
    await p.getByRole('link', { name: '返回原聊天，查看执行进度与回答', exact: true }).click();
    await expect(p.getByRole('status')).toHaveText('已完成');
    await expect(p.locator('.message-assistant .message-bubble')).toContainText('TX-1001');
    await screenshot(p, '05-approved-result');
  });
  await step(7, async () => {
    await a().goto(base + '/agent?run=' + run); await a().reload();
    await expect(a().getByRole('status')).toHaveText('已完成');
    await expect(a().locator('.message-assistant .message-bubble')).toContainText('TX-1001');
    await expect(a().locator('.tool-activity')).toContainText('高风险交易查询');
    await expect(a().locator('.tool-activity')).toContainText('已完成'); await screenshot(a(), '06-persisted-result');
  });
  await step(8, async () => {
    const audit = (await api(a(), '/api/security/audit')).events;
    expect(audit.some((e: { action: string; resource_id: string; actor_user_id: string }) => e.action === 'approval.approved' && e.resource_id === approval && e.actor_user_id === admin.id)).toBe(true);
    expect(audit.some((e: { action: string; decision: string }) => e.action === 'tool.execute' && e.decision === 'allow')).toBe(true);
    expect(audit.some((e: { action: string }) => e.action === 'tool.execution.result')).toBe(true);
    const ledger = await db.admin.query('SELECT status FROM tool_executions WHERE run_id=$1', [run]);
    expect(ledger.rows).toEqual([{ status: 'succeeded' }]);
    await writeFile(resolve(out, 'audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
  });
  await step(9, async () => {
    const kb = (await api(a(), '/api/knowledge/bases', { name: 'Private A fixture' })).base.id;
    await api(a(), '/api/knowledge/documents', { knowledge_base_id: kb, title: 'Private A policy', mime_type: 'text/plain', content_base64: Buffer.from('Private organization A refund policy.').toString('base64') });
    expect((await api(a(), '/api/knowledge/bases/' + kb + '/documents')).documents).toHaveLength(1);
    const anon = await viewer.page.request.post(base + '/api/agent/jobs', { headers: { Origin: base, 'Idempotency-Key': randomUUID() }, data: { messages: [{ role: 'user', content: 'forbidden' }] } });
    expect(anon.status()).toBe(403);
    await a().goto(base + '/security'); await a().getByRole('tab', { name: '组织设置', exact: true }).click();
    await a().getByLabel('组织名称', { exact: true }).fill('Acceptance B'); await a().getByRole('button', { name: '创建组织', exact: true }).click();
    await expect(a().locator('.security-summary')).toContainText('Acceptance B');
    const foreignRun = await a().request.get(base + '/api/agent/runs/' + run); expect(foreignRun.status()).toBe(404);
    const foreignApproval = await a().request.get(base + '/api/approvals/' + approval); expect(foreignApproval.status()).toBe(404);
    expect((await api(a(), '/api/agent/runs')).runs).toEqual([]);
    expect((await api(a(), '/api/knowledge/bases')).bases).toEqual([]);
    const foreignKb = await api(a(), '/api/knowledge/bases/' + kb + '/documents'); expect(foreignKb.documents).toEqual([]);
    const audit = (await api(a(), '/api/security/audit')).events;
    expect(audit.every((e: { tenant_id: string }) => e.tenant_id !== tenant)).toBe(true);
  });
  await step(10, async () => {
    await a().goto(base + '/agent'); await expect(a().getByLabel('消息内容', { exact: true })).toBeEnabled();
    await a().getByRole('combobox', { name: '历史 Agent 会话', exact: true }).click();
    await expect(a().locator('.ant-select-dropdown:visible .ant-empty-description')).toHaveText('暂无数据');
    await screenshot(a(), '07-other-organization');
  });
} catch (error) {
  console.error(error);
  if (!results.some(r => r.status === 'FAIL')) results.push({ name: '环境启动', surface: 'setup', status: 'FAIL', error: String(error) });
  for (const [i, context] of contexts.entries()) await context.pages()[0]?.screenshot({ path: resolve(out, `failure-${i}.png`), fullPage: true }).catch(() => {});
} finally {
  for (const [i, context] of contexts.entries()) {
    await context.tracing.stop({ path: resolve(out, `trace-${i}.zip`) }).catch(() => {}); await context.close();
  }
  await browser?.close();
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => new Promise<void>(done => {
    if (child.exitCode !== null) { done(); return; }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); done(); });
  })));
  try { await db.close(); results.push({ name: '清理临时服务、Schema 与角色', surface: 'setup', status: 'PASS' }); }
  catch (error) { results.push({ name: '清理', surface: 'setup', status: 'FAIL', error: String(error) }); }
  for (const [name, surface] of planned) if (!results.some(r => r.name === name)) results.push({ name, surface, status: 'SKIPPED' });
  const status = results.every(r => r.status === 'PASS') ? 'PASS' : 'FAIL';
  await writeFile(resolve(out, 'report.json'), JSON.stringify({ ...source, status, results, provider: 'mock', notes: ['Audit and isolation negative cases use real-session API checks, not a nonexistent audit UI.', 'Knowledge isolation uses one API-created fixture base; upload/retrieval/memory and Prompt rollback are separate browser suites.'] }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status, results }, null, 2)); if (status !== 'PASS') process.exitCode = 1;
}
