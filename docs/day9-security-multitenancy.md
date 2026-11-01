# Day 9：Security 与 Multi-Tenancy

## 现状审查与实现边界

Day 1–8 中 Conversations、同步 Agent/Chat 可匿名调用，异步 API 依赖 localhost 开关；数据没有身份和租户归属。Worker 的 trace_context 仅用于观测，不是授权凭据。Ledger、Lease、Fencing、Deadline 已存在，继续保留。本次增加身份/授权边界，不替换 AgentRunner、Provider 或队列架构。

认证采用 Better Auth 1.7.14、官方 PostgreSQL Kysely adapter、`toNextJsHandler` 与 `nextCookies`。迁移 005 受版本控制，创建认证与安全表；运行时不自动迁移，不自行哈希密码。Next.js 的 API 每次从数据库验证 Session；cookie cache 禁用，显式启用 Origin 与 CSRF 检查，客户端只有 HttpOnly Session Cookie，无长期 Token localStorage。Cookie SameSite=Lax，生产 Secure 且要求 HTTPS；本地 HTTP 使用非 Secure Cookie。

官方参考：[Next.js 集成](https://better-auth.com/docs/integrations/next)、[数据库 schema](https://better-auth.com/docs/concepts/database)、[认证限流](https://better-auth.com/docs/concepts/rate-limit)。

## 注册与组织流程

访问 `/login` 注册或登录；随后在 `/security` **显式创建组织**，创建者成为 Owner。默认只给已注册成员使用低风险只读交易工具的策略；新注册用户不会获得任何历史数据。加入已有组织时，把自己页面上的用户 ID 交给 Owner/Admin，由其添加现有注册用户；没有公开自助加入或仅凭 tenant_id 加入。此版本不是邮件邀请系统，不发送邀请邮件。

顶栏选择组织，`eap_tenant` Cookie 只保存选择器，不保存权限。API 也支持 `X-Tenant-ID`，SSE 支持 `?tenant=`；任何来源的 ID 都必须与真实 Session 用户的当前有效 Membership 对照。客户端角色、actor_user_id、authorization_context 均不作为授权输入。Job JSON 是 strict schema。

Google OAuth 仅在服务端同时配置 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 后启用，回调为 `<BETTER_AUTH_URL>/api/auth/callback/google`；测试无需 Google 凭据。退出调用框架 signOut，撤销服务器 Session；也支持框架 Session 撤销接口。OAuth token、code、password、Session token 不写入业务/审计日志。

## 数据模型与历史数据

新增 Better Auth 表：`user`、`session`、`account`、`verification`、`rateLimit`。

安全表：

- tenants：UUID、name、status（active/disabled/quarantined）、created_by、created_at。
- tenant_memberships：tenant_id + user_id 主键，role、status。
- tenant_tool_policies：规范化工具名、enabled、allowed_roles、risk_level、requires_approval、policy_version。
- audit_logs：event_id、tenant_id、actor_user_id、action、resource_type、resource_id、decision、reason_code、timestamp、trace_id。
- security_rate_limits：跨进程原子固定窗口配额。

所有业务表（含 agent_usage）都有 tenant_id。Run 的 Conversation、Message 的 Conversation+Run、Job/Span/Tool/Event/Usage 的 Run 使用复合外键。插入触发器验证父级在当前租户可见，Run 的 actor 从服务端事务身份取得，Job 从 Run 复制 actor 和授权上下文；不从模型或请求 JSON 读取。

迁移 005 把现存数据统一放到禁用隔离组织 `00000000-0000-0000-0000-000000000009`。它不是任何真实用户的组织，没有 Membership；旧 Job 不自动领取。原数据、Trace、Ledger、状态与未知结果保护全部保留，不自动重放任务。若旧数据已有不一致父子关系，迁移会失败并回滚，需先调查，不能删除约束来通过迁移。

历史归属恢复必须由数据管理员核对来源、目标组织与责任人，备份并审查一份独立的显式数据迁移（涵盖所有子表、actor、授权上下文、状态及审计）。本版本不提供“领取历史数据”的业务 API，也不自动决定归属。已 running 的历史任务应先停止旧 Worker、检查工具外部结果，再迁移；禁止旧 Worker 与 Day 9 Worker 混跑。

## 集中 RBAC

权限定义在 `packages/persistence/src/security.ts`，各 Route 传 Permission，不分散判断角色。

| 权限 | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| conversation:read / agent:read | 是 | 是 | 是 | 是 |
| conversation:create / agent:execute / agent:cancel / tool:execute | 是 | 是 | 是 | 否 |
| conversation:delete | 是 | 是 | 否 | 否 |
| tool:manage / tenant:manage / member:invite / member:manage / audit:read | 是 | 是 | 否 | 否 |

权限项并不代表每项都有独立 API，例如未增加删除会话接口。Owner/Admin 可添加已注册成员、更新角色和移除成员。Admin 不能授予/修改 Owner；Owner 变更在租户行锁内串行化，不能移除或降级最后一个有效 Owner。Member 不能提升自己。停用组织后后续请求、工具执行被拒绝；恢复使用经审批的运维路径，不能把停用组织重新当作有效 Membership。

## RLS 与数据库身份

业务表与租户控制表 ENABLE + FORCE RLS。

- eap_owner：NOLOGIN、NOBYPASSRLS 的对象所有者；仅其 maintenance policy 允许维护。不能授予运行时身份该角色。
- eap_app：业务租户数据需 tenant_id 匹配且当前 actor 是 active Tenant 的 active Member。
- eap_worker：只能在当前任务 tenant_id 中访问业务数据；即使成员已撤销，也可安全落盘失败状态、续租检查与执行结果，工具仍单独重新授权。
- eap_auth：只访问认证表、限流表和追加 auth 审计，无业务数据读取权限。
- Web 登录身份 eap_web_runtime：NOINHERIT，只可切换 app/auth 角色。
- Worker 登录身份 eap_worker_runtime：NOINHERIT，只可切换 worker 角色。

运行时拒绝超级用户、BYPASSRLS、CREATEROLE、CREATEDB、owner 成员身份，也检查上述执行角色权限。数据库迁移/测试 fixture 创建使用独立 provisioner，**不用于普通业务执行**。真实安全测试使用随机临时受限 LOGIN 连接；准备/断言/清理可以用 fixture 管理连接，隔离行为由受限连接执行。

每次 query 在 BEGIN 内 SET LOCAL ROLE 并用 set_config(...,true) 设置 tenant/actor；connect 的事务也走相同边界。提交或回滚后上下文消失；未结束事务就 release 会销毁连接，不把污染连接放回池。AsyncLocalStorage 隔离并发请求/Job。未设置上下文时业务 RLS 默认拒绝。

Worker 跨组织只通过 `eap_claim_job` / `eap_reap_jobs` 两个 SECURITY DEFINER 函数维护队列。它们固定 search_path、撤销 PUBLIC EXECUTE，仅授权 worker，内部保留 SKIP LOCKED、随机 Lease Token、过期阻断与终态事件。函数 owner 是 NOLOGIN eap_owner，不用超级用户作为常规 Worker 连接。App 不能执行它们。

RLS 是可信服务设置上下文后的防御层，不把可任意执行 SQL 的数据库凭据当成不可信终端用户。不要把数据库账号、服务密钥或设置 GUC 的接口交给客户端。

## Worker 与工具权限

提交持久化 tenant_id、actor_user_id、authorization_context version 1、policy_version。Worker 从被领取的 Job 建立上下文，Executor 在模型运行前核对 Job/Run/actor/快照一致性并读取当前 agent:execute 权限。

ToolRegistry 未配置 authorizer 默认拒绝。生产 Worker 与同步 Agent 都传入数据库 authorizer；真实 tool.execute 之前读取当前 Membership、Tenant 状态、工具 enabled/角色策略；未配置策略、大小写/别名不匹配、requires_approval=true 均拒绝。严格参数 schema 不接受 tenant_id 等额外字段。未知工具不执行，不允许模型指定下游 tenant header。

业务工具使用服务端授权上下文填充 X-Eap-Tenant-Id / X-Eap-Actor-Id。Go API 非健康接口要求 32+ 字符服务密钥与有效上下文；缺失密钥启动失败。不要向浏览器暴露服务密钥。Go 当前返回合成交易样例，没有真实交易数据库；新增真实交易存储时仍必须把 tenant 绑定到查询条件/RLS，不能仅靠 HTTP header 认为数据已隔离。

原 Tool Ledger intent-before-effect、Fence、续租、幂等/未知结果保护保留。确定的 TOOL_FORBIDDEN 不当作未知副作用。Session 退出/过期不取消已授权任务；组织停用、成员撤销、工具策略撤销会阻止后续工具。授权检查与远端 HTTP effect 不可能组成原子事务：已通过检查并已发出的调用不能追溯撤销。

SSE 建立前校验 Session、Membership、Run 归属，之后每轮轮询（默认 1 秒）重新检查 Session 与 Membership；撤销后关闭流。健康检查与认证入口按用途公开；所有业务 API 均验证身份和租户。所有 Legacy Chat/Agent 入口同样受认证、租户和 agent:execute 约束，不保留 localhost 绕过。

## 审计与限流

独立 audit_logs 只追加；运行时没有 UPDATE/DELETE 权限，触发器也禁止修改/删除。成员、Tenant、Tool Policy 变更与审计在同一事务提交。认证创建/撤销 Session、用户创建、认证请求拒绝、API 权限拒绝、资源不可见、工具允许/拒绝均记录结构化安全事件。不存密码、Token、OAuth Code 或消息正文；资源不可见采用一致 404，不查询外租户来判断是否存在。数据库管理员仍可改 DDL；这不是 WORM 或防 DBA 篡改存储。

PostgreSQL 原子 UPSERT 限流跨进程共享：Tenant 120 次/分钟；Agent 提交 tenant+actor 20 次/分钟；每 Tenant 最多 4 个 pending/running Run（租户行锁串行判定，异步与同步 Agent 都接入）。Replay 同一幂等键不再新增 Run。返回 429 + Retry-After。

认证框架开启 database rate limit；另有共享认证全局桶 100 次/分钟，不依赖可伪造 X-Forwarded-For。未信任 IP 头；生产需在受信网关增加更细粒度抗滥用策略，以免一个攻击者耗尽全局认证额度。固定窗口允许边界突发；目前不是完整 DDoS 防御。限流不能替代授权。

## 本地启动

1. 先备份数据库并停止旧 Worker。生成并保存本地密钥（不要提交）：

```bash
export BUSINESS_API_KEY="$(openssl rand -hex 32)"
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export APP_DB_PASSWORD="$(openssl rand -hex 32)"
export WORKER_DB_PASSWORD="$(openssl rand -hex 32)"
docker compose up -d --build postgres business-api
```

2. 用迁移身份创建表和分离运行时账号：

```bash
export MIGRATION_DATABASE_URL='postgresql://eap:eap_dev_password@127.0.0.1:5432/eap'
pnpm --filter @eap/persistence db:migrate
pnpm --filter @eap/persistence db:provision-runtime
```

也可只配置一次：复制 `packages/persistence/.env.example` 为同目录 `.env.local`，填写 MIGRATION_DATABASE_URL、APP_DB_PASSWORD、WORKER_DB_PASSWORD。`db:migrate` 和 `db:provision-runtime` 使用 Node 24 自动加载这个文件；文件不存在时仍接受终端/CI 注入变量，终端同名变量优先。文件已被 Git 忽略。修改密码后再运行 provision 会更新数据库角色密码，需同步更新 Web/Worker 的 DATABASE_URL。不要把迁移管理凭据放进 Web 或 Worker。

3. 参考根目录 `.env.security.example` 分别填入 `apps/web/.env.local` 和 `services/agent-worker/.env.local`。Web 使用 eap_web_runtime + APP_DB_PASSWORD；Worker 使用 eap_worker_runtime + WORKER_DB_PASSWORD。密码需 URL 编码（上面的 hex 密码可直接放入 URL）。两者使用同一 BUSINESS_API_KEY。Web 配置 BETTER_AUTH_URL=http://localhost:3551 和 BETTER_AUTH_SECRET；仅配置了两项 Google 凭据才启用 OAuth。Worker 保留原 LLM/OTEL 配置，不需要认证 secret。MIGRATION_DATABASE_URL 不放入这两个运行时文件。终端已有 DATABASE_URL 优先于文件，启动前应 unset DATABASE_URL。

```bash
unset DATABASE_URL
pnpm --filter @eap/web dev
# 另一个终端：
pnpm --filter @eap/agent-worker dev
```

访问 `/login` → `/security` 创建组织 → 顶栏选择 → `/agent` 查询。Async 模式还需要 Worker。原 ENABLE_ASYNC_AGENT_DEV 不再提供访问资格。

观测栈保持 Day 8 兼容；Compose 现在也需 BUSINESS_API_KEY。只有受控本机才使用 `-f compose.observability-local.yaml` 开启匿名 Grafana Viewer。真实业务运行时不应公开 Grafana 或复用管理员数据库 URL。

## 测试与验收

```bash
export TEST_DATABASE_URL='postgresql://eap:eap_dev_password@127.0.0.1:5432/eap_test'
pnpm --filter @eap/persistence test
pnpm --filter @eap/agent-worker test
pnpm --filter @eap/web test
pnpm check
```

测试 provisioner 需要 CREATE DATABASE/schema/role 所需权限（目前 fixture 在既有测试库中创建随机 schema 和临时 LOGIN），不要把它当生产 runtime。Authentication 测试实际注册、登录、签发/撤销/过期 Session，验证 Cookie 属性和 CSRF；API 测试实际 Session + 真实 RLS，覆盖匿名旧接口、跨组织 Run/Conversation/SSE/取消、角色伪造、长连接撤权和 429。Worker 测试验证下游调用计数、撤权、禁用、审批、模型租户参数和 Ledger。原 Day 1–8 低层回归测试只显式注入测试 authorizer，不改变原期望、不关闭生产授权。

CI 普通流水线执行这些集成测试，Google 凭据不需要；手动 Observability Smoke 使用临时受限登录和真实安全上下文，继续验证 Trace/Metrics/Logs/Usage。远端 CI 是否通过需以实际 Actions 结果为准。

## 已知限制

- 无邮件验证/邀请邮件、密码找回邮件发送、MFA、企业 SSO/SCIM、审批工作流；requires_approval 严格拒绝。Google 需部署者实际配置后单独验收。
- 本地凭据与 Web/Worker 环境需切换，旧匿名 API 使用方式有意被安全边界替换。历史隔离数据不自动归属、重放或恢复。
- 审计追加约束防普通业务修改，不防 DBA；需要独立归档、留存、备份与外部不可变存储才能满足更强合规要求。认证框架事件 hook 与认证写入不是这里声明的业务授权变更同事务承诺。
- 停用组织恢复、历史数据归属、限流表清理等运维使用经审批的维护路径；本版本没有通用管理员绕过 API。需定期清理过期认证/限流数据，配额参数目前为代码常量。
- 轮询撤权有约一轮间隔，不能撤回已发送的数据；工具检查后已发出的 HTTP 请求不能撤回。
- 默认只读合成交易工具；上线真实高风险写工具前必须实现人工审批及下游租户数据隔离，不能复用样例数据的假设。

## 本次本机验收结果（2026-11-01）

| 检查 | 结果 |
| --- | --- |
| pnpm check | 通过；Lint、全部 Typecheck、182 项 TypeScript 测试、Go 测试及 Web/Go Build 成功 |
| Observability | 27 项通过 |
| Tools / AI | 7 / 72 项通过 |
| Persistence | 37 项通过（含 14 项安全/RLS/事务/并发/热重载测试） |
| Worker | 21 项通过（原 14 项 + 7 项安全测试） |
| Web | 18 项通过（原 6 项 + 3 项 Better Auth + 9 项真实 Session/RLS API 测试） |
| 正常 Observability Smoke | 真实受限 Worker 进程 + 受服务密钥保护的临时 Go API；Trace（含 Go）、Metrics、Logs、Dashboard、Usage、Shutdown 通过 |
| Collector 不可用 Smoke | Agent 完成、Usage 落盘、Worker 有界关闭通过 |

Web 保留一条原有 see.test.ts unused-vars warning，无 lint error。曾发现并修复 Better Auth/Kysely 扫描可见 schema 时与另一个测试文件删除 fixture schema 的竞态：Web 文件级 fixture 生命周期串行，真实租户/连接池/配额并发测试仍保留；没有关闭 RLS、schema 校验、Origin 或 CSRF 来通过测试。

源码实现与本地自动化核心验收通过；不把它等同于远端 Actions 已绿或生产安全认证。Google OAuth 未使用真实凭据验收，浏览器中的人工交互流程未单独执行；这些仍需部署者按真实域名、HTTPS、OAuth 配置和账号完成。验证没有调用真实 DeepSeek。历史归属恢复也没有擅自执行。

## 实际修改文件

```text
.env.security.example
.github/workflows/ci.yaml
.github/workflows/observability-smoke.yaml
apps/web/.env.example
apps/web/package.json
apps/web/src/app/api/agent/jobs/route.ts
apps/web/src/app/api/agent/runs/[id]/cancel/route.ts
apps/web/src/app/api/agent/runs/[id]/events/route.ts
apps/web/src/app/api/agent/runs/[id]/route.ts
apps/web/src/app/api/agent/stream/route.ts
apps/web/src/app/api/agent/usage/route.ts
apps/web/src/app/api/auth/[...all]/route.ts
apps/web/src/app/api/chat/route.ts
apps/web/src/app/api/chat/stream/route.ts
apps/web/src/app/api/conversations/[id]/route.ts
apps/web/src/app/api/conversations/[id]/runs/route.ts
apps/web/src/app/api/conversations/route.ts
apps/web/src/app/api/security/audit/route.ts
apps/web/src/app/api/security/members/route.ts
apps/web/src/app/api/security/policies/route.ts
apps/web/src/app/api/security/tenant/route.ts
apps/web/src/app/api/tenants/route.ts
apps/web/src/app/layout.tsx
apps/web/src/app/login/page.tsx
apps/web/src/app/security/page.tsx
apps/web/src/components/security-panel.tsx
apps/web/src/lib/api-security.integration.test.ts
apps/web/src/lib/auth-client.ts
apps/web/src/lib/auth.integration.test.ts
apps/web/src/lib/auth.ts
apps/web/src/lib/persistence.ts
apps/web/src/lib/run-event-stream.ts
apps/web/src/lib/security.ts
apps/web/vitest.config.mts
compose.yaml
docs/day8-observability.md
docs/day9-security-multitenancy.md
packages/ai/tests/agent-runner-v2.test.ts
packages/ai/tests/agent-runner.test.ts
packages/ai/tests/agent-termination.test.ts
packages/ai/tests/deepseek-provider.test.ts
packages/ai/tests/tool-execution.test.ts
packages/persistence/migrations/005_security.sql
packages/persistence/package.json
packages/persistence/scripts/provision-runtime.ts
packages/persistence/src/index.ts
packages/persistence/src/job-lifecycle.ts
packages/persistence/src/job-queue.ts
packages/persistence/src/migrate.ts
packages/persistence/src/runtime-pool.ts
packages/persistence/src/security-context.ts
packages/persistence/src/security.ts
packages/persistence/src/types.ts
packages/persistence/tests/database.ts
packages/persistence/tests/security-database.ts
packages/persistence/tests/security.test.ts
packages/tools/src/registry.ts
packages/tools/src/transactions.ts
packages/tools/tests/registry.test.ts
pnpm-lock.yaml
services/agent-worker/.env.example
services/agent-worker/scripts/observability-smoke.ts
services/agent-worker/src/executor.ts
services/agent-worker/src/index.ts
services/agent-worker/src/worker.ts
services/agent-worker/tests/security.test.ts
services/agent-worker/tests/worker.test.ts
services/business-api/cmd/server/main.go
services/business-api/internal/httpapi/handler.go
services/business-api/internal/httpapi/security.go
services/business-api/internal/httpapi/security_test.go
services/business-api/internal/httpapi/transactions_test.go
```

## Day 9 Security Hardening

本轮只加固事务、工具审计和 Go 内部服务边界，不扩展 Day 10。RLS、角色、表结构、Lease、Fencing、队列状态机与未知结果恢复策略保留，没有新增数据库迁移。

### 风险核对

| 项目 | 实际发现 |
| --- | --- |
| scopedPool | 旧 Proxy 只匹配原样 BEGIN/COMMIT/ROLLBACK。分号、注释、QueryConfig 或复合 SQL 可能绕过本地状态；结束命令的 finally 无论成功失败都清除 transaction 标记，回滚失败时存在错误回池的风险。 |
| authorizeTool | 已经在工具前 await 审计，没有自动放行；但审计 PG 错误可能被泛化，生产 authorizer 包装也会把安全错误全部改成 TOOL_FORBIDDEN；失败是否真正执行过缺少可靠区分。 |
| Go API | 已强制密钥、无默认开发密钥、端口绑定 loopback，主信任边界成立。Actor 只判断非空、重复 Header 不明确，以及 fetch 默认跟随重定向，仍需收紧。 |

### scopedPool 事务生命周期

新增显式 API，传入的身份必须先由 Session + Membership 或已验证的 Job 得到：

```ts
await withTenantTransaction(pool, { tenantId, actorUserId }, async (client) => {
  await client.query('SELECT * FROM conversations WHERE id=$1', [conversationId]);
});
```

管理器掌握同一连接上的 BEGIN → SET LOCAL ROLE → set_config(...,true) → callback → COMMIT。已有 `transaction(pool,fn)` 自动走此路径，`pool.query` 也始终包在完整事务内。回调不能 COMMIT、ROLLBACK 或 release；离开回调后保留的 client 不能继续查询。Client 同时绑定领取时的 Tenant/Actor，不允许借给另一个异步身份使用。没有 Tenant Context 时，RLS 默认不返回业务资源。

保留旧仓库所需的 Promise connect/query/release 兼容入口，但它是受限 facade，不再把任意属性或原始 connection 暴露出去：

- BEGIN / COMMIT / ROLLBACK 只接受单个受控命令，支持大小写、空白、嵌套注释、可选 WORK/TRANSACTION 和尾分号；这些变体仍由管理器处理。
- END、ABORT、AND CHAIN、START TRANSACTION、SAVEPOINT 等不受支持的控制语法直接拒绝，不向数据库透传。
- 普通查询只接受当前仓库使用的 SQL 语句种类，并强制 PostgreSQL extended protocol；复合多语句在任何语句执行前被拒绝。SQL 字符串值中的分号仍由 PostgreSQL 正确解析。
- 不允许 QueryConfig 改成 simple protocol 或注入自定义 Submittable；只传递支持的 query 参数。此 facade 不是任意 pg 插件/回调 API 的替代品。

RLS 与数据库角色权限保持原样。SQL 与上下文 API 属于可信服务器代码，参数必须绑定；这不是让不可信客户端任意执行 SQL 的 SQL 防火墙。不能把未经验证的 Header 直接作为可信身份。

### 异常连接清理

| 路径 | 处理 |
| --- | --- |
| 正常 COMMIT / ROLLBACK | 确认 PostgreSQL 返回的事务命令，再允许连接回池；事务局部角色与 GUC 自动复原。 |
| 普通 SQL 报错 | 进入 failed，禁止继续受保护查询；ROLLBACK 成功后才可回池。调用方吞掉 SQL 错误也不能伪装提交成功。 |
| BEGIN / 角色或 Context 初始化失败 | 尝试清理，并销毁连接。 |
| COMMIT 失败或响应不确定 | 向调用方抛错，尝试回滚但始终销毁连接；不自动重试、不假定没有提交。 |
| ROLLBACK 失败 / socket 断开 | 销毁连接，不将不可信连接归还池；事务管理器保留原始业务异常。 |
| 空闲连接被服务器终止 | pg.Pool 移除失效连接；共享错误监听记录 DATABASE_CONNECTION_LOST，避免未处理的 error 事件导致服务退出。 |
| 未结束事务、查询仍在途时 release | 销毁连接。released 标记不可逆，异步查询晚完成也不能复活 Client。 |

真实 PostgreSQL 测试使用受限 LOGIN，故障注入仅由 fixture 管理连接终止自己的测试 backend。覆盖延迟外键导致的 COMMIT 失败、回滚期间真实断连、查询中断、初始化失败、并发租户、同一 backend 复用、无 Context 默认拒绝和异常后重新获取连接；验证行是否提交/回滚、backend PID 与实际 RLS 结果，不只验证 Mock 调用次数。

### 工具授权与审计 Fail Closed

本轮采用明确且统一的策略：**所有工具，包括低风险只读工具，默认且实际均 Fail Closed**。没有 Fail Open 配置，不根据工具名称猜测风险；未来若开放只读 Fail Open，必须额外定义显式策略与告警。

角色与工具策略在同一 SQL 语句快照读取；注册表在真实 execute 之前等待授权及必要审计完成，并再次检查 abort。组织禁用、成员/角色撤销、未注册/别名工具、策略禁用及 requires_approval=true 都不能绕过授权。

- 授权数据库读取失败：AUTHORIZATION_UNAVAILABLE。
- 必要授权审计写入失败：AUDIT_UNAVAILABLE。
- 已确认无权限或未获审批：TOOL_FORBIDDEN。

前两者产生安全 JSON error log，不输出数据库原始异常、密钥、参数或消息。Tool Registry 保留这些安全错误码，AgentRunner 停止本次执行，不让模型反复尝试把安全设施故障当成普通工具输出。

注册表用内部标记区分“真实 execute 尚未开始”的失败；普通工具抛出的同名错误不能仅凭错误名称宣称没有副作用。确定未开始的授权/审计拒绝可把 Ledger intent 标记 failed；不自动重放。

授权审计与执行结果分开：

- `tool.execute`：执行前的 allow/deny 授权决定。
- `tool.execution.result`：真实执行结果，与 Ledger 更新处于同一事务，记录执行 ID 与 SUCCEEDED/EXECUTION_OUTCOME_UNKNOWN 等原因，不记录参数或返回正文。生产 Worker 显式接入 SecurityStore。

未执行的拒绝不是一次工具执行结果；授权审计不可用时，通过安全错误日志和 failed Ledger 记录已知的零执行失败。外部副作用成功后若结果审计或 Ledger 回写失败，无法撤回外部操作：更新事务回滚，保留 intent，最终按原策略 UNKNOWN / blocked / interrupted 处理，禁止自动重放。

### Go API 内部服务信任边界

保留共享服务密钥方案：BUSINESS_API_KEY 由服务器配置、至少 32 字符；Compose 不提供默认值，缺失时配置失败，Go 启动也失败。生产必须注入独立随机密钥，测试中的固定值只属于测试环境。

受保护接口先认证服务，再校验 Tenant/Actor；只有 Header 不会获得信任。Authorization、X-Eap-Tenant-Id、X-Eap-Actor-Id 都必须单值；Tenant 为 UUID，Actor 为当前项目支持的 1–128 位 ASCII 字母/数字/下划线/连字符 ID。空白、组合值、超长与重复值拒绝。健康检查仍公开。

Worker/同步 Agent 工具客户端使用通过授权得到的上下文构造身份 Header，严格参数 schema 拒绝模型传入 tenant/actor/headers；HTTP redirect:error 避免重定向携带内部身份。密钥不放 URL，也不进入 Trace 属性、普通日志或审计日志。Go 原有可观测性白名单保留。

Compose 的 127.0.0.1:8080 绑定保留；同 Docker 网络和同机访问也必须认证。公开代理不能替外部客户端注入内部服务密钥或相信其身份 Header。

### 冻结边界与剩余生产措施

部署这次补丁后完整重启 Web 与 Worker；Web 使用新的 scoped pool 缓存版本，避免热重载继续使用旧 Proxy。代码无法追溯改变旧进程中已经开始的事务。生产发布需要先排空/停止旧进程。

Day 9 的冻结只涵盖当前架构与测试范围，不表示已达到真实企业数据上线认证：

- 共享密钥只能证明调用者持钥，不能证明具体服务实例、真实 Actor 或资源归属；持钥服务被攻陷仍可伪造上下文。接入真实企业数据前必须实现 Go 资源级授权，并评估 mTLS/短期服务凭证、轮换与撤销。
- 生产链路需 TLS、网络隔离、最小权限配置、Secret 管理与审计外部归档。当前 Go 返回合成样例数据。
- 必要审计与授权数据库不可用时会停止执行；整个数据库失联时，错误持久化/SSE 投递也可能不可用，需依靠独立日志与监控告警。
- 授权检查、审计、远端副作用不能成为同一个原子事务；已经发出的调用不能撤回。COMMIT 丢失确认时真实提交结果仍可能未知，需通过业务幂等键/人工核对处理，不允许盲目重试。
- 不增加审批工作流或自动恢复 UNKNOWN；现有 requires_approval 拒绝与人工对账策略保留。


### 本轮实际验收结果（2026-11-01）

| 检查 | 实际结果 |
| --- | --- |
| `pnpm check` | 通过：211 项 TypeScript 测试、全部类型检查、Go Vet/Test、Next.js Build、Go Build 成功 |
| Persistence 集成测试 | 58 项通过，其中新增 21 项真实 PostgreSQL 事务生命周期测试 |
| Worker 集成测试 | 27 项通过，其中新增 6 项授权/审计/副作用/UNKNOWN 安全用例 |
| Tools | 9 项通过，其中新增 2 项真实本机 HTTP 身份与重定向测试 |
| AI / Observability / Web | 72 / 27 / 18 项通过 |
| Go 单测 | `go test ./...` 通过，新增服务边界用例含重复 Header、伪造身份、畸形 Actor、无默认密钥 |
| Go Race Test | `go test -race ./...` 通过 |
| `git diff --check` | 通过 |

只保留原有 Web see.test.ts 的 unused-vars warning，无 lint error。新增测试没有放宽既有期望、关闭 RLS 或使用超级用户执行业务隔离查询；管理连接仅用于准备、断连故障注入与结果断言。没有观察到现有 Day 1–9 自动化回归。没有运行真实 DeepSeek、Google OAuth 或远端 Actions。

本轮范围可以作为 Day 9 代码冻结候选：已完成上述安全加固和本机验收；合并/发布仍需对应提交的远端 CI 通过，真实企业数据生产上线还需完成上面的资源授权及运维措施。不会因本轮完成而开始 Day 10。

### 本轮实际修改文件

```text
apps/web/src/app/api/agent/stream/route.ts
apps/web/src/lib/persistence.ts
docs/day9-security-multitenancy.md
packages/ai/src/agent-runner.ts
packages/ai/src/tool-execution.ts
packages/persistence/src/job-lifecycle.ts
packages/persistence/src/runtime-pool.ts
packages/persistence/src/security-context.ts
packages/persistence/src/security.ts
packages/persistence/src/transaction.ts
packages/persistence/tests/transaction-safety.test.ts
packages/tools/src/registry.ts
packages/tools/src/transactions.ts
packages/tools/tests/service-boundary.test.ts
services/agent-worker/src/executor.ts
services/agent-worker/src/index.ts
services/agent-worker/tests/security.test.ts
services/business-api/internal/httpapi/security.go
services/business-api/internal/httpapi/security_test.go
```
