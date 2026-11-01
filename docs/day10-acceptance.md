# Day 10 验收记录

日期：2026-11-02（Asia/Tokyo）。记录针对当前工作区源码，不将旧提交的 CI 结果计入 Day 10。

## 验收方法

- PostgreSQL 自动化使用 eap_test 的独立 schema 和受限 runtime 角色，不修改业务组织、权限或业务记录。
- 补充了批准后禁用 Tenant、拒绝 API 成功路径、真实 Worker 进程退出/重启三项测试。
- 实际业务库仅运行只读事务，读取汇总计数，不输出模型消息、工具参数或密钥。
- 实际 Prometheus 通过 Grafana datasource proxy 查询；浏览器操作必须使用连接的浏览器工具，不能把 HTTP 200 当成 UI 操作验收。

## 清单与证据

| 项目 | 结果 | 证据 |
|---|---|---|
| 审批请求持久化成功 | 通过 | 真实 PG 测试；业务库有 2 条审批、2 个 Checkpoint |
| 批准、拒绝、过期、取消状态正确 | 通过 | PG 状态机及终态测试，HTTP 批准/拒绝测试 |
| 并发审批只有一个决策生效 | 通过 | 并发 approve/reject；approve/cancel 竞争测试 |
| 审批记录具备 Tenant 隔离 | 通过 | 非超级用户 RLS 和跨租户 API 测试 |
| AgentRunner 支持持久化 Checkpoint | 通过 | 加密、不可变约束、恢复结果测试 |
| 审批等待期间 Worker 释放 Lease | 通过 | 数据库 lease_token/worker_id 为 NULL；真实子进程停机测试 |
| 批准后 Worker 可重新领取任务 | 通过 | 第二个真实 Worker 进程 claim，attempt=2，worker_id 改变 |
| 恢复时不会重新生成已批准参数 | 通过 | 恢复原 batch 与 hash，model 调用计数验证 |
| 多工具恢复不重复执行完成工具 | 通过 | A/B/C 多工具及连续两次暂停测试 |
| 审批人 RBAC、自批限制 | 通过 | Member 拒绝、审批人撤权、高风险请求人晋升 Admin 后仍不可自批 |
| 审批后重新验证 Actor、Tenant、Policy | 通过 | Actor 移除、Tenant 禁用、工具禁用、策略版本变化及消费审批后撤权测试 |
| 参数 Hash 与 Checkpoint 版本 | 通过 | 加密参数篡改、不可变约束与版本冲突测试 |
| 审计失败不放行高风险工具 | 通过 | 审批创建/决策审计故障回滚，下游调用次数不增加 |
| 审批列表和详情 UI | 待验收 | Web HTTP 200、build 通过；浏览器工具仍未连接，未完成实际点击 |
| 批准、拒绝 API | 通过 | 真实 Session/RLS、200 成功、409 重复、403 权限、严格输入验证 |
| Audit、SSE、Metrics | 通过 | 自动化 + 下方实际环境只读证据 |
| 过期、取消可持久恢复 | 通过 | 新建扫描实例发现过期、DB 时钟落后保护、等待取消及竞争测试 |
| Day 1–9 无回归 | 原有测试通过 | 全部既有测试保留；不等同于所有真实模型组合均验收 |
| PostgreSQL 并发与恢复测试 | 通过 | 真实数据库测试和真实 Worker 子进程停机/恢复测试 |
| pnpm check | 通过（退出码 0） | lint、typecheck、所有包测试、Next.js/Go build |
| 当前 Day 10 GitHub Actions | 待验收 | 本次代码尚未提交/推送；已成功的旧 CI 不含工作区修改 |

## 实际环境只读证据

- Web `http://127.0.0.1:3551/agent`：HTTP 200。
- Grafana health：HTTP 200；Postgres、Collector、Prometheus、Tempo、Loki、Grafana 均运行，配置 healthcheck 的容器 healthy。
- 业务库：approved=2，Checkpoint=2。
- 审计：approval.requested=2，approval.approved=2，approval.execution_resumed=2。
- SSE：waiting_approval=2，approved=2，resumed=2。
- pending 审批与 Job/Lease/active approval 绑定不一致数：0（当前无 pending，释放 Lease 的证明另由真实 PG 和进程测试提供）。
- Approval/Checkpoint Tenant、Run、Job、Version、Hash 绑定不一致数：0。
- Prometheus 四类指标均存在，查询 HTTP 200、status=success；瞬时请求数=1、决策数=1、wait histogram count=1、pending=0。
- 查询 `count(count_over_time(agent_approvals_requested_total[24h]))` 返回 2 个实例序列；`sum(max_over_time(agent_approvals_requested_total[24h]))` 与 decided 同类查询均返回 2，与数据库历史记录一致。该查询仅用于此次实例累计值核对，不能作为通用事件计费方式。
- 指标标签未发现 approval_id/run_id/job_id/user_id/tenant_id/actor_id；真实 decision status=approved。

## 真实 Worker 进程重启验证

在隔离 schema 与本机 Mock HTTP 服务中执行：

1. 第一个 `node --import tsx src/index.ts` 进程领取任务。
2. 持久化等待审批，DB Lease 释放，实际工具 HTTP 调用次数为 0。
3. SIGTERM 退出第一个进程，确认正常退出。
4. 在无 Worker 运行时批准审批。
5. 启动第二个 Node Worker 进程；从 DB Checkpoint 恢复并完成。
6. 实际工具 HTTP 调用次数恰好 1，Ledger 仅一条 succeeded，model_calls=3，tool_calls=1，Usage 快照仅一条、80 Token。

测试使用 MockProvider，不调用真实 DeepSeek，也不调用业务 API 容器。此前报告的 DeepSeek DSML 输出问题及真实回答展示不属于本次 Mock 测试已证明的结论。

## GitHub Actions

只读查询 GitHub API 成功（HTTP 200），最新已有 CI：

- 提交：`5093e769487d311562b93cc909d2f137ba9da2c3`，Day 9 安全加固。
- 状态：completed / success。
- [已有 CI 运行](https://github.com/miraiakira/agent-platform/actions/runs/41307623908)。

当前 Day 10 代码仍在工作区，不能用上述绿灯验收。需要提交并推送后，再核对对应新 SHA 的 frontend/backend 结果。本轮没有自动提交、推送或发布。

## 浏览器限制

已按 Browser 技能初始化并在用户回复“已打开并登录”后重连，工具仍返回 `No browser is available`，浏览器列表为空。此结果表示工具未连接到页面，不能推断用户没有打开或没有登录。不读取浏览器 Cookie/Session，也不以其他控制方式绕过限制。UI 点击项保留待验收。

## 最终运行结果

- `pnpm check`：退出码 0。
- TypeScript 测试：245 项全部通过（Observability 28、Tools 9、AI 72、Persistence 58、Worker 51、Web 27）。
- 本轮新增 3 项：批准后 Tenant 禁用、拒绝 API 正常终止任务、真实两个 Node Worker 进程停机/恢复；未放宽现有测试断言或 Agent Deadline。
- `go test -race ./...`：退出码 0。
- Next.js Build、Go Build：通过。
- `git diff --check`：通过。
- 保留已有 see.test.ts 的 unused `_event` warning，无 lint error。
- 日志：`/tmp/eap-day10-acceptance-check.log`、`/tmp/eap-day10-process-acceptance.log`。
- 21 项清单中 19 项具有自动化/运行环境证据；UI 点击验收与本次 Day 10 提交的远程 CI 两项仍未完成，暂不正式冻结。
