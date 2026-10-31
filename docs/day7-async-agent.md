# Day 7 异步 Agent：架构、验收与限制

## 审查结论

| 严重度 | 原始问题 | 本次处理 |
| --- | --- | --- |
| 严重 | Worker 入口没有调用 runWorker，Executor 只有接口 | 实现独立入口、真实 AgentRunner 执行器、并发循环、退出清理 |
| 严重 | 创建 Run 与入队分离，网络重试可能重复创建 | JobLifecycle.submit 事务、请求幂等键、会话校验和输入持久化 |
| 严重 | 完成事务未确认 Run 状态，回答和 Trace 在事务外 | finalizeJob 原子保存回答、消息、Trace/Usage、终止事件、Run/Job |
| 严重 | 工具执行没有接入持久化意图，未知副作用可能重试 | Runner 工具生命周期钩子、Lease fencing、未知结果 blocked、不自动重放 |
| 高 | 所有工具都可能重试 UPSTREAM_ERROR | 仅 retrySafe 明确为 true 的工具允许受控重试 |
| 高 | 旧 Worker 的事件检查与写入之间没有锁保护 | 固定 job → run 行锁顺序，获得锁后检查 wall-clock Lease 和 Run 状态 |
| 高 | 全局 identity 不保证并发事务提交顺序 | 每个 Run 的事务序号、Run 行锁、按 sequence 续传 |
| 高 | SSE 轮询 Abort 监听器累积，消费者取消未结束轮询 | 定时器与监听器成对清理、独立订阅取消信号 |
| 高 | 前端只接同步 streaming | 保留 Stream，增加 Async、显式取消及 SSE 重连 |
| 高 | 无用户身份或会话归属校验 | 明确开发环境边界；生产禁用异步 API，需本机、同源、显式 opt-in |
| 高 | 测试与根检查遗漏 Worker 完整链路 | PostgreSQL 并发/事务、实际 Worker、SSE 测试；CI 加 Worker tests |
| 中 | 不响应 AbortSignal 的工具可一直占用执行 | Promise.race 超时退出；结果保留 unknown，不重放 |
| 中 | 数据库测试遗留全局队列数据，相互干扰 | 每个测试独立 schema，执行真实迁移，结束后清理 |

源码中已有 finish() 事务和 Lease 条件，并非完全没有事务；缺口是 Run 更新结果未校验，且没有涵盖消息、Trace 和终止事件。已有 CI 是 `.github/workflows/ci.yaml`，不是 `ci.yml`，且原来已包含 PostgreSQL Service 和 Worker 类型检查。沿用原有文件，不新建重复 workflow。

## 核心接口和一致性

- `JobLifecycle.submit({ conversationId?, requestKey, messages })`：锁定幂等键，在一个事务中验证/创建会话、创建 Run、保存完整系统提示与消息、入队、记录最新用户消息。同键同内容返回原 Run，同键不同内容 409。
- `JobLifecycle.finalizeJob({ jobId, leaseToken, status, answer?, error?, trace? })`：锁定 Job、Run，验证有效 Lease 和运行状态。取消已先提交时，以取消为准。未决工具会使 Job blocked、Run interrupted；否则同步更新 Run/Job，并提交唯一终止事件。任何写入失败整体回滚。
- `startTool` / `finishTool`：调用外部工具前提交带调用 ID、幂等键、原始参数的意图；所有 Worker 工具写入都重新校验 Lease。未知结果保留，不能自动重试整个 Job。
- `AgentRunnerOptions.toolLifecycle`：可选 before/after 钩子。同步调用者不配置钩子仍可使用原有 API。
- `Tool.retrySafe`：默认 false，仅明确声明安全的工具允许已有策略中的瞬时错误重试。当前查询交易工具明确声明 true。
- `AgentEventStore.append`：只写非终止事件。终止事件由完成、取消或恢复事务写入。
- `runWorker(options)`：可测试的 Worker 循环，支持配置并发数、Lease、轮询、退出信号；完成前停止并等待在途心跳，避免心跳与完成竞态。
- 旧的无 Lease `PersistenceStore` 写接口拒绝修改属于 Job Queue 的 Run，旧恢复逻辑忽略有 Job 的 Run。

事件公共 `id` 现在是 **每个 Run 的 sequence**，不是表的全局 identity。所有同 Run 的事件分配在持有行锁的事务中执行，提交前不可见，回滚不消耗序号。SSE 使用 `Last-Event-ID` 或 `after` 恢复，不触发执行。多个 Run 可以有相同的公共游标，客户端必须按 Run 保存游标。

HTTP 接口：

| 接口 | 行为 |
| --- | --- |
| `POST /api/agent/jobs` | 必须携带 `Idempotency-Key`，202 返回 runId/conversationId/eventsUrl；参数 400、会话不存在 404、冲突 409、数据库不可用 503 |
| `GET /api/agent/runs/[id]` | 返回 Run 和脱敏 Job 状态，不返回 Lease Token |
| `GET /api/agent/runs/[id]/events` | 持久化 SSE，可断线续传；连接关闭仅停止订阅 |
| `POST /api/agent/runs/[id]/cancel` | 202 接受；已终态或不支持取消 409；不存在 404 |
| `POST /api/agent/stream` | 保留 Day 5/6 同步执行方式 |

## 迁移

新增 `packages/persistence/migrations/003_async_lifecycle.sql`：

1. Run 增加 `event_sequence`、唯一 `request_key` 和 `request_payload`。
2. Event 增加 `sequence`，按现有全局 id 为每个 Run 回填，再初始化 Run 计数器。
3. 增加 `(run_id, sequence)` 唯一索引和每个 Run 唯一终止事件的部分索引。
4. 保留旧全局 identity 和所有现有表、功能。

部署迁移前应停止旧 Worker/SSE 连接。旧的全局事件游标不能在新协议下继续使用，升级时重新从 0 订阅；持久化终止事件和数据不会重新执行 Agent。已有重复终止事件会导致唯一索引迁移失败，需先审查并整理历史数据，不能盲目删除记录。

## 本地启动与端到端验收

要求：Node/pnpm、Go、可用 PostgreSQL，数据库用户能 CREATE/DROP SCHEMA（集成测试隔离需要）。不要对生产数据库运行测试。

```bash
pnpm install

docker compose up -d postgres business-api
export DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap'
pnpm --filter @eap/persistence db:migrate
```

独立终端启动 Worker（将同一 DATABASE_URL 导出到该终端）：

```bash
export DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap'
LLM_PROVIDER=mock WORKER_CONCURRENCY=2 pnpm --filter @eap/agent-worker start
```

支持 `WORKER_ID`、`WORKER_CONCURRENCY`（正整数）、`WORKER_LEASE_SECONDS`（默认 30）、`WORKER_POLL_INTERVAL_MS`（默认 1000）、`WORKER_MAX_DURATION_MS`（默认 60000）、`BUSINESS_API_URL`（默认 http://127.0.0.1:8080）、`BUSINESS_API_KEY`。

DeepSeek 使用 `LLM_PROVIDER=deepseek`，并配置 `LLM_API_KEY`、`LLM_MODEL`，可选 `LLM_BASE_URL`。本次没有调用真实 DeepSeek API。

另一个终端启动 Web：

```bash
export DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap'
ENABLE_ASYNC_AGENT_DEV=true pnpm --filter @eap/web dev
```

访问 http://localhost:3551/agent，选择 Async，发送“查询高风险交易”。确认工具状态、最终回答、Usage。切回 Stream 验证原同步模式。Stop 在 Async 模式发送取消请求；关闭页面不会取消 Worker。页面只在当前会话内自动恢复断开的 SSE，刷新页面后可通过 Run API 手动查询/订阅；尚未实现刷新后恢复 UI 会话。

如默认开发服务器已在运行，可使用独立验收目录和端口，避免停止已有进程：

```bash
NEXT_DIST_DIR=.next-e2e ENABLE_ASYNC_AGENT_DEV=true \
  pnpm --filter @eap/web exec next dev --hostname 127.0.0.1 --port 3552
```

HTTP 验收（保留同一 key 可重试提交）：

```bash
curl -sS http://localhost:3551/api/agent/jobs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: day7-acceptance-001' \
  -d '{"messages":[{"role":"user","content":"查询高风险交易"}]}'

# 使用返回的 RUN_ID
curl -N "http://localhost:3551/api/agent/runs/$RUN_ID/events"
curl -sS "http://localhost:3551/api/agent/runs/$RUN_ID"
# 使用已收到的某个事件序号恢复
curl -N -H 'Last-Event-ID: 5' "http://localhost:3551/api/agent/runs/$RUN_ID/events"
# 对另一个仍在排队/执行中的 Run 测试取消
curl -X POST "http://localhost:3551/api/agent/runs/$RUN_ID/cancel"
```

重复提交同 key/同 payload 应返回同 Run；同 key/不同 payload 应 409。完成后的 Run 和 Job 都应 completed，输出包含真实工具返回交易，最后只有一个 done。取消用 error/CANCELLED 事件表示，保持已有 StreamEvent 联合类型。

## 测试与 CI

为测试建立独立数据库（仅首次需要，例如 `docker compose exec postgres createdb -U eap eap_test`），然后：

```bash
export TEST_DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap_test'
export DATABASE_URL="$TEST_DATABASE_URL"
pnpm --filter @eap/persistence db:migrate
pnpm --filter @eap/ai typecheck
pnpm --filter @eap/ai test
pnpm --filter @eap/tools typecheck
pnpm --filter @eap/tools test
pnpm --filter @eap/persistence typecheck
pnpm --filter @eap/persistence test
pnpm --filter @eap/agent-worker typecheck
pnpm --filter @eap/agent-worker test
pnpm check
```

根 check 包含全部 TS 包类型检查与测试、Web lint/build、Go vet/test/build。CI 使用已有 PostgreSQL Service，增加 Worker 集成测试；保留单独 Go Job 的 `go test -race`。没有新增重复 workflow，也无需改 workspace glob，现有 `services/*` 已覆盖 Worker。

测试覆盖：原子入队回滚、完成回滚、幂等提交、Claim 并发、Lease fencing/续租/过期、取消竞态、事件顺序、SSE 续传和监听器释放；真实 AgentRunner + MockProvider + ToolRegistry、回答/Trace/Usage、SSE 断开不影响执行、取消、Deadline、数据库瞬时失败重试、多 Worker、退出、崩溃和未知副作用工具不重放。

## 已知限制与发布判断

- 当前没有用户认证、租户隔离或会话归属校验。异步端点在生产模式强制 403；开发模式还需 `ENABLE_ASYNC_AGENT_DEV=true`、本机 Host、同源 Origin。此措施是受控开发限制，不是认证，也不能防范有本机访问权限的其他进程。不要通过公网代理暴露。原有同步和会话 API 的安全边界仍需在公开发布前统一加固。
- Worker 对未知结果采用保守阻断；未实现自动对账/人工恢复 UI。需按持久化调用 ID 和幂等键核对外部系统，确认结果后再设计恢复流程。
- 外部副作用必须由下游支持幂等或 fencing 才能获得更强保证。这里保证数据库提交 fencing 和不自动重放，不声称跨系统 exactly-once。
- Runner/Provider 应遵循 AbortSignal。工具超时会退出等待，但无法强制终止不配合的外部副作用；这类结果保持 unknown。Provider 迭代也通过 AbortSignal 竞争退出，不等待不配合的迭代器 return；不能强制释放第三方实现持有的外部资源，部署时仍应设置进程管理器退出宽限期。
- 当前输入保存完整客户端消息和服务器系统提示，不自动重构工具执行历史，也不会自动恢复中断 Run。没有按工具名称推断安全性。
- MockProvider 已验证真实 Worker/数据库/HTTP 链路；DeepSeek 真实凭据调用、浏览器交互、远端 GitHub Actions 执行需另行验收。
- 事件逐条持久化优先保证正确性；高吞吐场景需另做批量与保留策略，保持 Run 序号/提交顺序约束。

Day 7 的受控开发异步链路可以验收；不能据此认定已达到可公开部署的生产安全标准。

## 本次实际验证结果

- `pnpm install`：通过。存在原有 Vitest 5 / Web Node 20 类型 peer 提示。
- 全部五个 TypeScript 包的 typecheck：通过。
- AI：52/52；Tools：6/6；Persistence：23/23；Worker：10/10；Web：6/6，共 97 项 TypeScript 测试通过。
- `pnpm check`：最终完整通过，包括 Go vet、go test ./...、Go build 和 Next.js production build。
- 新迁移已在本地 eap_test 应用，所有数据库相关测试使用真实 PostgreSQL，并在独立 schema 中执行全部迁移。
- HTTP 端到端使用独立运行的 Next.js、Worker 和真实 Business API：Run `b36e8618-0812-4202-b89e-cfc54560cd18` 与 Job 均 completed；3 次模型调用、1 次工具调用，回答含 TX-1001；566 条事件游标连续；重复请求返回同一 Run；Last-Event-ID 续传通过。
- 完整检查中唯一现有 lint 警告为 `apps/web/src/lib/see.test.ts` 的未使用变量，没有 lint error。
- 临时验收进程已停止；独立 `.next-e2e` 目录已从 lint、TS、Git 排除。
- 本环境浏览器列表为空，未验证页面交互/截图；没有调用真实 DeepSeek，也没有触发或查看远端 GitHub Actions 运行，不能声称这些已通过。
- 检查过程中发现独立验收目录会被 lint 扫描，已补排除后重新运行完整检查通过。

## 修改文件清单

```text
.github/workflows/ci.yaml
.gitignore
apps/web/eslint.config.mjs
apps/web/next.config.ts
apps/web/src/app/api/agent/jobs/route.ts
apps/web/src/app/api/agent/runs/[id]/cancel/route.ts
apps/web/src/app/api/agent/runs/[id]/events/route.ts
apps/web/src/app/api/agent/runs/[id]/route.ts
apps/web/src/components/chat-panel.tsx
apps/web/src/lib/async-agent-access.test.ts
apps/web/src/lib/async-agent-access.ts
apps/web/src/lib/async-agent-client.ts
apps/web/src/lib/persistence.ts
apps/web/src/lib/run-event-stream.test.ts
apps/web/src/lib/run-event-stream.ts
apps/web/src/lib/sse.ts
apps/web/tsconfig.json
docs/day7-async-agent.md
package.json
packages/ai/src/agent-runner.ts
packages/ai/src/runtime.ts
packages/ai/src/tool-execution.ts
packages/ai/tests/tool-execution.test.ts
packages/persistence/migrations/003_async_lifecycle.sql
packages/persistence/src/event-store.ts
packages/persistence/src/index.ts
packages/persistence/src/job-lifecycle.ts
packages/persistence/src/job-queue.ts
packages/persistence/src/store.ts
packages/persistence/src/transaction.ts
packages/persistence/tests/database.ts
packages/persistence/tests/job-queue.test.ts
packages/persistence/tests/persistence.test.ts
packages/tools/src/registry.ts
packages/tools/src/transactions.ts
pnpm-lock.yaml
services/agent-worker/package.json
services/agent-worker/src/executor.ts
services/agent-worker/src/index.ts
services/agent-worker/src/worker.ts
services/agent-worker/tests/worker.test.ts
services/agent-worker/tsconfig.json
```
