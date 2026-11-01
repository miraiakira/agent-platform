# Day 10 — Human-in-the-Loop & Durable Agent Resume

## 架构与边界

Day 9 的同步 Agent 仍默认拒绝需要人工审批的工具。Day 10 只为持久化后台 Job 提供审批；使用 `/agent` 的 Async 模式。保留现有 AgentRunner、PostgreSQL Queue、Lease/Fencing、Tool Ledger、Better Auth、RLS、SSE 与 OpenTelemetry。

Worker 在模型完整返回一批 tool calls 后、创建下一条 Ledger intent 之前暂停。Checkpoint 和 Approval、Run `waiting_approval`、Job `waiting_approval`、清空 Lease、审计及持久化 SSE 在同一数据库事务提交。无内存等待审批 Promise，不占用 Worker slot；SSE 送达暂停事件后关闭，审批页面、浏览器离线或重启不影响后台状态。页面可点击“查看执行进度”重新订阅，重新订阅不会提交新 Job。

## 状态机

- Approval：`pending → approved | rejected | expired | cancelled`。终态不可互转，重复决定返回 409，已过期返回 410。
- Job：`running → waiting_approval → queued → running`。批准只排队，正常 claim 产生新 lease token；每个恢复点增加一次允许 claim 的次数，不允许自动重放过期的运行 Lease。
- 拒绝与过期：Run/Job failed，明确 `APPROVAL_REJECTED` / `APPROVAL_EXPIRED`。
- 等待时取消：Approval cancelled，Run/Job cancelled。批准和取消锁相同 Job/Run；批准已完成而后取消 queued Job 时，保留 approved 历史但不执行工具。
- 执行中崩溃：沿用 Day 7–9 的 blocked/interrupted 与 UNKNOWN reconciliation，不能因为存在审批而重放副作用。

## 迁移与环境

新增 `006_human_approval.sql`，扩展 Run/Job 状态，创建 `agent_checkpoints`、`agent_approvals`，启用 FORCE RLS；新增复合外键、每个 Run/ToolCall 唯一约束、不可变 Checkpoint/审批绑定触发器及过期扫描函数。已暂停 Run 仍算 active run，不能通过新请求绕过并发上限。

Web 与 Worker 的各自 `.env.local` 必须配置**同一个**独立密钥：

```dotenv
# Generate once: openssl rand -hex 32
AGENT_CHECKPOINT_KEY=<64 hex characters>
```

不要使用 Better Auth secret 或服务 API key 复用此值。密钥仅在需要创建或读取 checkpoint 时要求，不设置不会影响不需审批的旧流程。缺失或错误密钥时 fail closed，不会自动使用明文回退。不要把真实密钥提交 Git。示例变量已加入 Web/Worker env example。

使用现有 provisioner 执行迁移，随后重启 Web/Worker：

```bash
pnpm --filter @eap/persistence db:migrate
pnpm --filter @eap/agent-worker dev
```

这只是说明，开发任务的集成测试使用隔离测试 schema，未自动迁移你的业务数据库。

## Checkpoint v1

- 外部不可变身份：Tenant、Run、Job、Approval、Checkpoint version、请求 Actor、Tool Call ID、Tool Name、Canonical Arguments SHA-256、Policy version。
- Runner state：provider/model、完整消息历史、assistant tool_calls、已完成 tool result、当前 batch / nextIndex、预算、累计 trace/model/tool/usage 计数、已消耗的活动时间。
- Runner state、原始待执行参数、pending call 使用 AES-256-GCM 加密，AAD 绑定 Tenant/Run/Job/Approval/Version；另校验 state hash 与规范化参数 hash。
- `agent_checkpoints` 只追加，数据库禁止 UPDATE/DELETE。审批绑定不可更改，每个 Job 版本唯一；审批不能提交新参数。
- 恢复历史中每个已完成 Tool Result 必须与 conclusive Ledger output 一致；任何 reserved/running/UNKNOWN 均阻止恢复。
- A 已完成、B 待审批、C 尚未执行：保存 A 的结果及 nextIndex=B。恢复直接继续 B，再 C，不重新请求模型生成 B 参数，不重计已有 usage；同一批中 C 再需审批可创建下一 checkpoint 版本。
- 人工等待时间不消耗 Runner 活动执行预算；恢复须匹配 provider/model/budget，配置变化会安全拒绝，不会悄悄改用新模型或扩大预算。

## 授权、审计与执行

权限集中在 `rolePermissions`：Owner/Admin 拥有 `approval:read` 与 `approval:decide`；Member/Viewer 不具备。高风险调用请求人即使后来成为 Owner/Admin，也不能批准自己的操作；需要另一位 Owner/Admin。

列表、详情、决策均验证 Better Auth session、Origin、Tenant membership、RBAC、RLS。决策重新读取当前审批人角色，批准还复查原 Actor、Tenant、当前工具 enabled/allowed_roles/policy version。Owner/Admin 无权覆盖现行工具策略。策略变更后审批失效，重新提交任务以获得新的策略绑定。

恢复再校验 checkpoint、授权及 Lease。审批只允许消费一次，消费与 Ledger start 同事务。实际调用前 ToolRegistry 再读取当前工具策略、Actor membership、Tenant 状态、审批原参数 hash、有效时间、已消费 Lease 与 running Ledger。Tenant/Actor 不能来自模型参数。

`approval.requested/approved/rejected/expired/cancelled` 的审计由数据库触发器同事务写入；审计失败使整个请求/决策回滚，并返回 `AUDIT_UNAVAILABLE`。恢复记录 `approval.execution_resumed`，失败记录 `approval.execution_denied`；数据库不可用时，不能保证 denial audit 落库，此时输出不含参数的错误信号并拒绝执行。外部效果成功后结果提交失败仍保留 UNKNOWN，不重试副作用。

审批相关的已批准 Ledger intent 仅存 approval ID/hash，不再次复制敏感原始参数。Audit/SSE/Trace 不包含原始审批参数；UI 仅展示白名单日期/数量，未知工具全隐藏。审批理由最多 500 字，仅存审批记录，不写入审计 reason_code；请勿填写密钥或敏感内容。

## API 与 UI

- `GET /api/approvals`：当前组织最多 100 条，待审批优先（租户活动任务上限为 4，旧 pending 不会被新历史挤出）；可按状态在 UI 筛选。
- `GET /api/approvals/:id`：安全详情，无原始参数/密文。
- `POST /api/approvals/:id/approve`、`/reject`：严格 JSON `{ "reason": "..." }`，拒绝额外参数，长度最多 500。Session 决定 Actor，验证后的 Tenant selector 决定上下文。
- 未登录 401；无权限 403；不可见资源与不存在资源同为 404；重复决定 409；过期 410；审计/审批存储不可用 503。
- `/approvals` 提供列表、详情抽屉、风险、请求人、时间、脱敏参数、理由、批准/拒绝、历史记录；提交期间防重复点击，成功后刷新；权限由服务端强制执行。
- `/agent` 显示等待状态，提供审批页入口、重新订阅和取消。后台任务提交后 URL 保存 Run ID；`/agent?run=<id>` 从受保护接口恢复原问题与最终回答，并订阅未结束任务。审批列表/详情/成功提示提供“查看原聊天”，Agent 页面可选择最近 50 个后台任务。聊天内容不存 localStorage，租户与访问权限始终由服务端验证。

## 过期与可观测性

Worker 每轮 poll 调用数据库扫描，按数据库当前时间处理最多 100 条 pending 且到期的请求，并通过锁与决策、取消竞争。无需浏览器在线；Worker 重启后继续扫描。若所有 Worker 均停机，清理延后，但任何批准/执行仍检查有效期，不能趁停机批准过期请求。

持久化 SSE 类型 `approval` 包含安全 approval ID/tool name/status，支持 Last-Event-ID；`waiting_approval/approved/rejected/expired/cancelled/resumed` 可回放，终止错误位于决策状态事件之后。恢复 claim span 继承原 Job 的 W3C trace context，业务 trace ID 保持一致。

新增指标：

- `agent_approvals_requested_total`：提交成功后增加。
- `agent_approvals_decided_total`：提交成功后增加，status 仅有限枚举。
- `agent_approval_wait_duration_seconds`：Histogram，单位 s。
- `agent_approvals_pending`：Gauge，Worker 从数据库读取绝对 pending 数；多副本使用 `max`，不要对全局快照求和。

数据库触发器也检查批准时的有效期；即使应用时钟落后，过期仍返回 410，事务回滚后由下一轮持久化扫描终止 pending 请求。

没有 Approval/Run/User ID metrics label。Counter 在事务提交后进程崩溃的极窄窗口可能少计，数据库审计与状态才是权威记录；pending Gauge 在下一 poll 收敛。暂停段不增加终态 Run Counter，也不标记 Trace error；成功/失败段记录累计活动执行时长，人工等待单独由 approval wait Histogram 记录。

## 本地与 CI 验证

```bash
export TEST_DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap_test'
pnpm --filter @eap/agent-worker test
pnpm --filter @eap/persistence test
pnpm --filter @eap/web test
pnpm check
(cd services/business-api && go test -race ./...)
```

真实 PostgreSQL fixtures 使用独立 schema、非超级用户/非 BYPASSRLS runtime login，验证事务、并发、租户隔离、审批与取消/过期冲突、不可变绑定、加密参数 hash、防 replay、多次 pause、断点恢复及 usage 不重计。Worker 测试使用 MockProvider，无需真实 LLM/OAuth/Grafana。

GitHub Actions 现有 migration/typecheck/全包测试/build/Go race 保留，加入 CI 专用测试密钥并明确运行审批集成测试。修改工作流不等于远程 CI 已运行；需提交后查看 Actions 实际结果。

## 已知生产限制

不提供密钥轮转/KMS、多版本模型迁移、邮件通知、审批委托、多级审批、分页、审批后参数编辑或 resource-level 企业数据授权。密钥丢失的 checkpoint 不可自动恢复；先保留历史并人工处置，不应通过禁用约束重放。只支持已完整生成的模型 batch 边界，模型 stream 或工具执行中断不自动恢复；UNKNOWN 仍需人工 reconciliation。需要真实企业资源级授权与保留/擦除策略后再接入生产数据。所有 Worker 停机时不会实时发出过期 SSE，但请求不能再获批准。不可变审批历史的外键会阻止直接删除关联 Job/Run/Conversation；未来需提供受控归档/保留策略。浏览器人工交互与远程 GitHub Actions 需在对应环境实际验收。

## 实际修改文件清单

- `.env.security.example`
- `.github/workflows/ci.yaml`
- `apps/web/.env.example`
- `apps/web/src/app/api/approvals/[id]/approve/route.ts`
- `apps/web/src/app/api/approvals/[id]/reject/route.ts`
- `apps/web/src/app/api/approvals/[id]/route.ts`
- `apps/web/src/app/api/approvals/route.ts`
- `apps/web/src/app/approvals/page.tsx`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/approval-panel.tsx`
- `apps/web/src/components/chat-panel.tsx`
- `apps/web/src/components/security-panel.tsx`
- `apps/web/src/lib/api-security.integration.test.ts`
- `apps/web/src/lib/approval-decision.ts`
- `apps/web/src/lib/async-agent-client.ts`
- `apps/web/src/lib/persistence.ts`
- `apps/web/src/lib/run-event-stream.ts`
- `apps/web/src/lib/sse.ts`
- `apps/web/src/lib/ui-errors.ts`
- `docs/day10-human-in-the-loop.md`
- `packages/ai/src/agent-runner.ts`
- `packages/ai/src/checkpoint.ts`
- `packages/ai/src/index.ts`
- `packages/ai/src/tool-execution.ts`
- `packages/observability/src/index.ts`
- `packages/observability/tests/telemetry.test.ts`
- `packages/persistence/migrations/006_human_approval.sql`
- `packages/persistence/package.json`
- `packages/persistence/src/approval-crypto.ts`
- `packages/persistence/src/approvals.ts`
- `packages/persistence/src/index.ts`
- `packages/persistence/src/job-lifecycle.ts`
- `packages/persistence/src/job-queue.ts`
- `packages/persistence/src/security.ts`
- `packages/persistence/src/store.ts`
- `packages/persistence/src/types.ts`
- `packages/tools/src/registry.ts`
- `pnpm-lock.yaml`
- `services/agent-worker/.env.example`
- `services/agent-worker/src/executor.ts`
- `services/agent-worker/src/index.ts`
- `services/agent-worker/src/worker.ts`
- `services/agent-worker/tests/approvals.test.ts`

## 本次实际验证结果（2026-11-01）

- 最终 `pnpm check`：退出码 0。Lint、全部 Typecheck、TypeScript 测试、Go 单元测试、Next.js Build、Go Build 均通过。
- TypeScript 测试共 236 项：Observability 28、Tools 9、AI 72、Persistence 58、Worker 49、Web 20。
- 新增 25 项测试：22 项真实 PostgreSQL 审批/恢复/权限/并发/故障场景，2 项真实 Session/RLS 审批 API 测试，1 项审批指标测试。Day 1–9 原有测试全部保留且通过。
- Worker 完整 49 项测试连续运行 10 次：10/10 通过；日志位于 `/tmp/eap-day10-worker-1.log` 至 `10.log`。
- `go test -race ./...`：退出码 0。
- `git diff --check`：通过。
- 保留现有 `apps/web/src/lib/see.test.ts` 中 `_event` 未使用的 ESLint warning，无 lint error。
- 未运行远程 GitHub Actions，未完成浏览器人工点击验收；不能将这两项标记为通过。未自动修改业务数据库或真实 `.env.local`，也未调用真实 LLM/OAuth。
- 当前结论：本地自动化验收通过；正式冻结前仍需配置共享 checkpoint key、迁移业务库、重启 Web/Worker，并完成浏览器与远程 CI 验收。

## 聊天恢复修复（2026-11-02）

原问题是 `/agent` 只保存 React 内存状态，审批导航或刷新后没有数据库恢复入口。新增 `GET /api/agent/runs`（RLS 下最近 50 项）、`AgentHistory` 历史选择、持久 Run URL、原问题/已完成回答恢复，以及未完成任务 SSE 重新订阅。恢复只执行 GET，不会重新提交 Job 或重复工具副作用。切换组织或任务会取消旧订阅，权限错误不回退到缓存内容。

本次聊天恢复修复验证：`pnpm check` 退出码 0，242 项 TypeScript 测试全部通过（Web 26 项）；新增 5 项恢复读取测试及 1 项真实 Session/RLS 历史列表测试，Next.js 与 Go 构建通过。无需新增数据库迁移。浏览器人工点击尚未验收。

## 最终专项验收（2026-11-02）

补齐 Tenant 禁用、拒绝 API 和真实 Worker 子进程重启三项测试后，最新 `pnpm check` 245 项全部通过；Go Race Test 通过。实际数据库审批/Audit/SSE 与 Prometheus 历史请求/决策计数均核对为 2。UI 浏览器工具未连接，当前工作区尚未提交/推送，远程 Day 10 CI 不能标记通过。完整逐项结果见 [Day 10 验收记录](day10-acceptance.md)。
