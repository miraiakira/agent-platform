# Day 12 — Prompt Management, Progressive Delivery & A/B Evaluation

## 架构与兼容范围

PromptOps 控制面位于 `packages/evaluation/src/promptops.ts`，复用 Day 11 的真实 EvaluationStore、Worker、BaselineComparator、Quality Gate。纯模板、Hash、Router 和 Pin 校验位于 `packages/persistence/src/prompt-runtime.ts`，由现有 JobLifecycle 与 AgentExecutor 直接调用，避免 Persistence → Evaluation 的循环依赖。

新增迁移 `008_promptops.sql`，所有控制面修改、路由分配、任务提交均使用现有租户事务。发布和实验操作锁定 Prompt Definition，并使用 revision CAS。数据库约束和触发器再次检查版本、角色、独立审批、门禁记录、状态迁移及审计。API 只接受资源选择器与配置，不接受 actor/role/tenant/passed 等授权声明。

没有注册默认 `risk-agent` 的组织继续使用 Day 1–11 原有 System 输入；注册后必须完成门禁及独立审批，不能悄悄退回旧 Prompt。其他 Agent 可以通过 Job API 的 `promptKey` 选择同租户另一注册定义。显式指定不存在的其他 Key 返回 404。

## 数据库

- `prompt_definitions`：Tenant + Key 唯一；多个 Agent 的独立注册项。
- `prompt_versions`：单调版本号、draft revision、规范化完整 document、SHA-256、作者和发布时间。template / variables_schema / model_config 是 document 的数据库生成列，避免重复内容不一致。
- `prompt_releases`：固定 Stable/Canary、前驱、评测 Run、固定 Dataset Version、Code Revision、审批人、比例、状态、CAS。
- `prompt_experiments`：固定版本、Release、单位 user/conversation、分配比例、生命周期。
- `prompt_assignments`：每个实验单位的 HMAC Hash、不可变 Variant/Version、时间；唯一约束解决并发首次分组。
- `prompt_revocations`：独立 append-only 严重安全撤销，回滚与归档不能删除或覆盖。
- `agent_runs.prompt_binding`：System 绑定快照，派生 prompt_id/version_id/content_hash/release_id/experiment_id/variant 外键列；Job 经 run_id 引用同一个 Pin。
- `eval_runs`：增加 prompt_version_id / prompt_content_hash / tool_policy_document；配置快照和报告也绑定版本、Hash 和工具策略 Hash。

全部新增表 FORCE RLS，跨租户复合外键、唯一约束、索引齐备。App 没有直接写 Assignment 或修改 Revocation 的权限。Worker 只能按 Tenant 读取 Prompt；发布只允许 Owner/Admin。新增触发器还拒绝 App 插入伪造的 completed Evaluation，只能排队等待 Worker 生成真实结果。

## Registry 与版本

Draft 支持编辑，必须提交当前 revision；竞争修改仅一个成功。版本号分配由 Definition 行锁与数据库约束串行化。发布是内容冻结，不等于批准生产流量。发布后模板、Schema、模型配置、Hash 不可改写。

归档只允许没有被当前 Live Release 引用的 published 版本，保留所有内容与 Hash；不能重新发布或评测 archived 版本。历史已绑定 Job 仍可读取归档内容。严重风险必须使用独立 Revocation，而不是归档。

示例模板：[risk-agent-v1.json](../packages/evaluation/prompts/risk-agent-v1.json)。

## 安全模板

使用明确受限的 JSON Schema 子集：object、字符串属性、所有属性 required、additionalProperties=false、每属性 maxLength。最多 16 个变量、模板 16,000 字符、单变量 4,000、渲染结果 32,000。未知、缺失和超长变量拒绝。

占位符仅允许 `{{identifier}}`，变量值通过 JSON 字符串序列化一次；不递归展开变量内容。不提供代码执行、文件或网络访问。API 不接受用户传入的 System 插值变量。生产和评测的运行时变量仅支持服务端生成的 current_date；其他声明可保存在 Draft，但发布时拒绝。

模板是有编辑权限的作者提供的 Trusted System Instructions。用户消息保留 user/assistant 角色，工具结果保留 tool 角色，不拼进 System。绑定评测时 Dataset 的 system 消息被转为带 untrusted_dataset_context 的 user 数据，候选模板独占 System 角色。模型配置只支持当前可实际执行的 provider/model；未知模型参数直接拒绝。转义与分角色不能保证完全解决 Prompt Injection，业务工具授权和审批仍独立执行。

## Evaluation Gate

必须先发布不可变 Candidate，再通过 `/versions/:versionId/evaluate` 创建真实异步评测。服务端读取版本生成绑定，不信任请求 Hash。Evaluation Worker 加载 Hash 一致且未撤销的版本，渲染为实际 AgentRunner System 输入；真实 Provider 读取该输入，Mock 仍使用 Day 11 的确定性 fixture。

创建 Release、独立审批、扩大流量、恢复及完成发布时，服务端重算严格 Day 11 Quality Gate，并校验：

1. Published Candidate 的 Hash 与 DB、配置快照、报告一致。
2. Run 已 completed，完成时间在 24 小时内。
3. Dataset Version 与 Release 固定策略相同。
4. Provider/Model 与版本一致；Code Revision 与服务端当前部署一致。
5. 当前工具策略规范化快照与评测一致，所有安全硬失败均为零。
6. 有 Stable 时，必须使用绑定 Stable 的 completed Baseline，Dataset、模型、Code Revision、工具策略相同；Baseline 自身严格门禁通过。
7. Candidate 报告完整性、分数/通过率/工具/安全指标、回归和成本/延迟预算均通过默认严格门禁。客户端降低 gate 阈值不能降低发布门槛。

数据库额外检查同租户 Run、绑定、摘要、过期、Baseline 和策略快照；评测绑定字段在排队后不可变。初次 Bootstrap 必须 Stable=Candidate，避免把未评测的任意版本当作回退目标。之后的 Stable 只能来自前一个完成或回滚的 Live Release。

Mock Gate 是确定性流程和安全回归证据，不代表真实模型能力；mock 版本只能绑定 mock 模型。DeepSeek 版本必须使用对应真实 Provider 评测，需显式开启 EVAL_ALLOW_EXTERNAL；CI 不依赖真实服务。

## Release 状态机

`draft → active(0%) → 5% → 25% → 50% → 100% → completed`。

- 独立管理员审批才能 draft → active；版本作者和 Release 发起者均不能自我审批。
- active 可以暂停到 paused，之后显式恢复；未结束的发布不能被另一个发布替代。
- 不允许跳过比例阶段；必须已到 100% 才能完成。
- active / paused / completed 可填写原因回滚到 rolled_back。普通 Canary 新任务立即使用原 Stable；已绑定 Job 不重路由。
- completed 的新任务使用 Canary 版本；原 Stable 保留作本次安全回退目标。后续发布从 completed Canary 继承新的 Stable。
- 下一次独立审批事务将前一个 completed/rolled_back 标记 superseded，并启用新发布；任何失败（包含审计失败）均回滚整个事务。
- 同一个 Prompt 至多一个 active/paused/completed/rolled_back。每次变更 increment revision；回滚重复请求返回已经回滚的记录且不重复改写原因。

暂停是可用的安全操作，不因评测过期而被拒绝；恢复必须重新检查评测门禁。回滚不需要 Candidate 再通过质量门禁，但 Stable 必须未撤销。发布记录与审计历史保留，Dashboard 每 5 秒刷新并显示回滚状态。

## Canary Router

HMAC-SHA256(secret, JSON([tenant_id,prompt_id,release_id,conversation_id]))，取前 32 位映射到 `[0,100)`。`bucket < canary_percentage` 选择 Canary。0% 永不进入 Canary，100% 全部进入；同一 Release 的分桶固定，逐步扩容具有单调性。新 Release 是新的分桶域，既有 Job 不受影响。

生产必须设置至少 32 字符的 `PROMPT_ROUTING_KEY`，同一部署的 Web 实例使用同一密钥。密钥不出现在日志或报告中。只有哈希写入实验 Assignment；不记录分组键原文。运行中实验不要轮换该密钥；轮换会产生新的分组身份，需先结束实验或另行设计密钥版本迁移。

## A/B 实验

实验依附已经独立审批、0% 的 Release，Control=Stable、Treatment=Candidate，二者必须不同。与 Canary 扩流互斥，先结束实验再扩大 Canary。生命周期 `draft → running ↔ paused → ended`，版本和实验单位不可修改。

实验用独立 HMAC 域 `experiment_id`，单位可以是服务端 Session Actor 或 Conversation ID；首次分组写入唯一 Assignment，此后比例变化只影响新参与者。并发同一单位只产生一行。暂停实验或 Release 不纳入新参与者，已有实验分组保持不变；普通 Canary 暂停时新任务使用 Stable。结束/回滚停止实验路由，保留全部历史分组；已有 Job 继续原 Pin。

结果将 Assignment 单位样本量与请求数分开，少于 30 单位明确 insufficient_sample。在线结果包含终态 Task Success Rate、审批比例、已记录安全拒绝率、总 Tokens、完整 Usage 下的估算成本及端到端 P50/P95（包含排队/审批等待）。离线结果单独提供真实 Evaluation Summary，包含质量与 Tool Accuracy。

线上业务没有真值标签，evaluation_score / tool_accuracy 明确为 null，不用成功工具请求冒充正确率。安全拒绝率只是记录到的安全事件比例，不是不存在漏洞的证明。结果不提供未经验证的显著性或因果提升结论。

## Runtime Pinning 与 HITL

JobLifecycle.submit 在现有提交事务中锁定发布快照、分配实验组、生成一次 System 输入并保存不可变 Pin。Idempotency Retry 返回同一个 Run，不再路由。Worker 从数据库读取 Pin，不在重启、恢复、重试时查询“最新版本”。

AgentExecutor 执行前、每次工具 intent 提交前和审批恢复后都验证版本 Hash、System 输入及撤销状态。HITL 解密检查点继续使用原始历史；检查点 System 必须与原始 Run 一致。当前模型 Provider 也须与 Pin 配置一致，使用绑定模型计算 Usage/Cost。Trace 只添加版本、Release、Variant 元数据，不添加完整模板或变量。

保留 Day 7 的 Lease 安全语义：租约过期的未知执行状态被 fenced/blocked，不自动重放或重新路由；重新提交同一个幂等请求仍返回旧 Run。审批后的合法重新领取同一个 Job 使用原 Pin。Tool Ledger 与 Checkpoint 的去重/加密/授权规则保持有效。

## Emergency Revocation

撤销写入独立不可变记录。已撤销版本不能用于新绑定、评测、发布、恢复或后续工具执行。Runtime 在进入 AgentRunner、写入工具 intent 和实际 Tool Authorization 时复核。等待审批的历史记录仍保留；恢复时以 PROMPT_REVOKED 失败，不静默切换版本。取消或到期清理沿用现有 Job/Approval 管理。

已绑定其他版本的 Job 不受普通回滚影响。回滚无法清除撤销；Stable 已撤销时回滚失败关闭，没有可用安全 Stable 时需要新建并评测安全版本。已发生的外部效果无法撤回，授权检查之后已经在途的网络操作不能保证被撤销抢断。

## API 与权限

复用 Better Auth Session、Tenant Membership、RBAC、FORCE RLS、Origin、统一错误响应、最大 1 MB Body 和共享限流。Prompt 写入每组织每分钟 30 次，评测另有限流和并发限制。

- prompt:read / prompt:edit：Owner、Admin、Member；Viewer 不可用。
- prompt:release：仅 Owner、Admin，独立于编辑权限；审批还受禁止自我审批约束。
- Evaluation 运行仍要求 evaluation:run。

路径：

| Method | Path | Body |
|---|---|---|
| GET/POST | /api/prompts | 创建时 key/name/description |
| GET | /api/prompts/:id | 版本、发布、实验、评测证据与审计 |
| POST | /api/prompts/:id/versions | document |
| POST | /api/prompts/:id/versions/:versionId | document/revision |
| POST | /api/prompts/:id/versions/:versionId/publish | revision |
| POST | /api/prompts/:id/versions/:versionId/archive | revision |
| POST | /api/prompts/:id/versions/:versionId/evaluate | dataset_version_id/baseline_run_id?/config? |
| GET/POST | /api/prompts/:id/releases | candidate_version_id/evaluation_run_id/dataset_version_id |
| POST | /api/prompts/:id/releases/:releaseId/change | revision/action/percentage?/reason? |
| POST | /api/prompts/:id/releases/:releaseId/rollout | revision/percentage |
| POST | /api/prompts/:id/releases/:releaseId/rollback | revision/reason |
| GET/POST | /api/prompts/:id/experiments | release_id/name/allocation_percentage/assignment_unit |
| POST | /api/prompts/:id/experiments/:experimentId | revision/status/allocation_percentage? |
| GET | /api/prompts/:id/experiments/:experimentId/results | — |
| POST | /api/prompts/:id/revoke | version_id/reason |

GET 不返回跨组织资源；无租户权限时 403，租户内不存在/外租户 ID 统一 404。Next.js 使用 Promise params 和现有 Node runtime。

## Dashboard 与观测

`/prompts` 复用现有 Workspace、Ant Design 和侧边栏。提供注册、JSON Draft 编辑与 OCC、发布、版本历史、逐字段 Diff、绑定评测、Baseline 选择、Gate 状态、Release/Canary 管理、回滚、紧急撤销、实验和指标查询及审计。所有高风险操作有确认。创建生产发布按钮要求已完成且 gate_result 通过；服务端仍独立重算门禁，前端状态不能作为授权。

新增 agent_prompt_resolutions_total / agent_prompt_release_changes_total / agent_prompt_rollbacks_total / agent_prompt_gate_failures_total / agent_prompt_experiment_assignments_total。只用受控 status 和版本 1–20/other 桶，Metric 不含用户/任务/Prompt 内容。Assignment Counter 计路由到实验的次数；独立实验单位数以数据库 Assignment 聚合为准。Trace 可关联 Prompt Version/Release/Variant；不把高基数 ID 作为 Metric 标签。

关键控制面变更由数据库 AFTER Trigger 写入审计，同事务失败关闭；不记录模板、用户原始分组键或变量内容。

## 本机启用与验收

1. 在 Web `.env.local` 设置 PROMPT_ROUTING_KEY（openssl rand -hex 32 生成），设置与 Worker 一致的 EVAL_CODE_REVISION。
2. 用 Migration 身份运行 `pnpm --filter @eap/persistence db:migrate`，应用 008；Web/Worker 继续使用受限身份。
3. 启动现有 Web/Worker，两个独立管理员账号加入同一组织。
4. `/evaluations` 发布固定 Dataset；`/prompts` 新建定义（先用演示 Key 可避免影响现有 risk-agent）。
5. 作者创建并发布 v1，选择 Dataset 提交绑定评测；完成后创建 Release。另一个管理员审批，初次 Bootstrap 的 Stable/Canary 都是该 v1。
6. 发布 v2 前，给同一个 Dataset 的 Stable v1 跑当前代码与策略下的 Baseline；v2 评测选择该 Baseline。创建 Release 并由独立管理员审批，0% 起步。
7. 逐步 5/25/50/100 或在 0% 创建 A/B。检查回滚、独立安全撤销与历史任务行为。

测试环境加载仓库根 `.env.test.local` 后执行：

```bash
set -a
source .env.test.local
set +a
pnpm --filter @eap/evaluation test
pnpm check
```

测试自动创建隔离 PostgreSQL Schema、受限登录角色及实验用户，清理后不修改业务数据。CI 执行相同的 Evaluation/PromptOps 集成测试，固定外部 Provider/Judge 关闭，继续保存 Day 11 JSON/Markdown/Gate 报告；没有跳过旧测试。

## 已知限制与验收记录

- 实验单位只有 Session Actor 或 Conversation；无匿名 Cookie 单位、自动扩流、自动显著性结论和自动模型回滚。
- 当前 Schema 是受限字符串模板子集，模型配置只支持实际接入的 provider/model。任意表达式、外部变量来源和其他模型参数会被拒绝。
- 历史数据不可变，没有隐式删除/擦除路径；需要后续受控保留策略。列表有限额，未实现分页。
- 同一模型、数据集、代码和策略兼容是明确发布策略；跨模型发布需独立建立适合的策略，本版拒绝不兼容 Baseline。
- 路由密钥轮换需要实验生命周期管理；服务端/Worker、数据库 provisioner 与允许扩展的代码仍是可信计算基。
- 线上 Tool Accuracy 没有真值，明确未知；离线指标与线上观察不混算。Mock 不宣称真实智能能力。
- 版本 Pin 保证 Prompt/模型配置一致，不能将已部署进程的代码与外部模型版本冻结；Code Revision 是发布门禁兼容证据。
- 远程 GitHub Actions 和浏览器人工交互需对本次代码另行验收，不能用旧提交的绿色结果代替。


## 实际验证结果（2026-11-04）

- `pnpm check`：退出码 0；299 项 TypeScript 测试通过（Evaluation/PromptOps 49、Observability 29、Tools 9、AI 72、Persistence 58、Worker 51、Web 31）。原有 Day 1–11 测试保留并通过，新增 PromptOps 15 项和真实 Session API 1 项。
- 两个真实 Worker 进程重启测试：v1 审批等待 → 停机 → v2 全量路由 → 新进程恢复仍用 v1，业务测试 HTTP 只调用一次；同样场景撤销 v1 后，恢复以 PROMPT_REVOKED 失败，HTTP 调用为零。
- 并发 Draft CAS、发布比例 CAS、同单位并发 Assignment、审计失败事务回滚、伪造 completed Evaluation、无效/过期/不匹配评测、工具策略不匹配、历史 Pin、Lease fencing、归档、撤销不可被回滚解除均有自动化覆盖。
- Next.js / Go 构建、Go vet、`go test -race ./...` 与 `git diff --check` 通过。仅保留既有 see.test.ts unused `_event` warning。
- 确定性 CLI：6 用例、Overall Score=1、Gate passed，报告位于 gitignored `artifacts/evaluation/`。
- 本次没有自动迁移业务数据库，没有访问真实 DeepSeek/Judge，没有提交或推送代码。远程 GitHub Actions 尚待本次提交执行；浏览器人工操作尚未验收。Day 12 本地自动化验收通过，不能据此声称远程 CI 或生产发布已通过。
- 生产应设置实际部署的 EVAL_CODE_REVISION（通常 commit SHA），不要把本地 working-tree 标识当作可信代码来源证明。Hash 保障内容完整性，不是签名。

## 修改文件清单

2026-11-06 补充：Dashboard 自动浏览器验收已通过，15 个浏览器场景、4 个 API 检查及测试数据清理全部通过。完整范围、限制、失败调试记录与证据位置见 [浏览器验收记录](day12-browser-acceptance.md)。远程 GitHub Actions 仍需针对当前提交单独确认。

- `.github/workflows/ci.yaml`
- `apps/web/.env.example`
- `apps/web/src/app/api/agent/jobs/route.ts`
- `apps/web/src/app/api/prompts/[id]/[...operation]/route.ts`
- `apps/web/src/app/api/prompts/[id]/route.ts`
- `apps/web/src/app/api/prompts/route.ts`
- `apps/web/src/app/prompts/page.tsx`
- `apps/web/src/components/app-shell.tsx`
- `apps/web/src/components/promptops-dashboard.tsx`
- `apps/web/src/lib/api-security.integration.test.ts`
- `apps/web/src/lib/prompt-api.ts`
- `docs/day12-promptops.md`
- `packages/evaluation/prompts/risk-agent-v1.json`
- `packages/evaluation/src/index.ts`
- `packages/evaluation/src/promptops.ts`
- `packages/evaluation/src/runner.ts`
- `packages/evaluation/src/schema.ts`
- `packages/evaluation/src/store.ts`
- `packages/evaluation/src/worker.ts`
- `packages/evaluation/tests/promptops.test.ts`
- `packages/observability/src/index.ts`
- `packages/persistence/migrations/008_promptops.sql`
- `packages/persistence/src/index.ts`
- `packages/persistence/src/job-lifecycle.ts`
- `packages/persistence/src/prompt-runtime.ts`
- `packages/persistence/src/security.ts`
- `packages/persistence/src/store.ts`
- `packages/persistence/src/types.ts`
- `packages/tools/src/registry.ts`
- `services/agent-worker/.env.example`
- `services/agent-worker/src/executor.ts`
