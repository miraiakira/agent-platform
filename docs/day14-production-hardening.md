# Day 14 — Production Hardening & Reliability Engineering

## 范围与架构

复用 Day 1–13 的 Job Lifecycle、Lease/Fencing、不可变 Ledger/Checkpoint、Prompt Pin、知识 ACL、Memory 删除、真实 Session 测试和观测 SDK。没有新增业务功能，也没有在普通用户 API 增加故障开关。

新增 `010_reliability.sql`、可重复的 CLI Harness、k6 负载档位、AES-GCM 加密备份/恢复、SLO 计算与告警、Production Readiness Gate。工作均在专用 5544 `eap-day14` 测试库中验证；不自动迁移 5432 业务库，不重启既有业务 Web/Worker/数据库。

## 容量与背压

- 提交事务按 Tenant 锁串行化，数据库 `eap_admit_job` 再以短全局事务锁原子检查整个 Schema 的 admitted Job 数量。幂等键复用先于配额判断，不重复入队。
- 默认 `AGENT_GLOBAL_ADMISSION_LIMIT=256`、`AGENT_TENANT_ADMISSION_LIMIT=4`、`AGENT_TENANT_QUEUE_LIMIT=32`；有显式有限上界，不能由 API 覆盖。Tenant 默认统计 pending/running/waiting_approval，保留旧行为；其中队列上限在提高 Tenant admission 上限时仍独立有效。
- 满额明确 429（Tenant）或 503（全局），Retry-After=5；不先成功后丢弃。
- Agent Worker 每进程最多 8 slots；数据库 dispatch 最多 64 个有效 running Lease，每个租户最多 2。Least-recently-dispatched Tenant 优先，租户内部保留 priority/created_at 排序。该策略提供可验证的有限公平性，不宣称对无限租户有无条件延迟保证。
- Pool 默认 10、最大 32，获取连接默认 5 秒，SQL 默认 10 秒，空闲事务 15 秒；Auth Pool 也有获取/语句超时。错误轮询采用有界指数 Backoff + Jitter（最多 30 秒）。SDK 模型请求不无限重试；不重试未声明 retrySafe 的工具。
- Agent、Evaluation、Embedding 是独立执行池；Worker replica 数与这些池的总 Provider 并发需要部署容量计划，不能把 Agent 的 64 当作整个系统的模型调用全局硬上限。

## Graceful Shutdown

SIGTERM/SIGINT 停止新领取。Agent 的 `WORKER_SHUTDOWN_GRACE_MS` 默认 5 秒（0–60 秒），已运行任务在 Drain 期间正常续租，完成则提交；到期通过取消/Deadline 与 fencing 安全终止。非合作 Executor 也有终止兜底，已经排队的终态结果先于晚到的关闭原因，避免覆盖 DEADLINE_EXCEEDED。

等待人工审批没有占用执行槽；Checkpoint 在新 Worker 上恢复。Evaluation/Knowledge Worker 使用各自现有 Abort/Lease 协议安全停止，不将未完成结果当通过。DB close、Trace flush 仍在 finally；完整进程退出还包括 DB/Exporter 的有限超时，因此 Drain 参数不是所有操作的绝对进程退出总时间承诺。

过期、无法确认效果的 Agent Job 保持 blocked/interrupted，不自动重放。新 Worker 正常处理其他 queued Job；需要幂等查询/业务对账/人工批准才能决定后续操作。Ledger 单独不能保证任意外部系统 Exactly-Once。

## 测试环境与命令

```bash
docker compose -p eap-day14 -f compose.day14-test.yaml up -d --wait
# .env.day14.local（本地、gitignored）使用 localhost:5544/eap_test
pnpm reliability:test
pnpm reliability:check
pnpm backup:restore-test
pnpm reliability:alerts
pnpm load:capacity
pnpm reliability:browser
pnpm readiness:check
pnpm reliability:report
```

`reliability:check` 实际运行 `pnpm check` 并保存退出码和日志；`reliability:test` 运行 Persistence、AI、Worker、Knowledge、Evaluation、Web 的完整真实测试，按测试断言映射故障证据，不靠手写 PASS。

测试数据库使用独立项目命名测试卷，不连接业务 `postgres_data`。2 CPU / 512 MiB 限制，允许自身重启后保留测试数据。脚本拒绝非 loopback、非 eap_test 默认目标。恢复演练还验证项目、服务及数据卷归属，且只创建新的随机恢复库。不要并行运行容量测量和其他重型测试，避免污染资源样本。

## k6 Load / Capacity

脚本：[tests/load/scenarios.js](../tests/load/scenarios.js)。固定 k6 1.0.0，容器 1 CPU / 256 MiB、只读根文件系统、无额外 capabilities，不发送 usage report。实现参照 [k6 options](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/) 与 [custom summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/)。

- Smoke：2 VU / 30 秒。
- Baseline：独立 10、25、50 VU 各 30 秒，间隔避免重叠；独立 p10/p25/p50 延迟趋势。
- Stress：50 → 100 → 150，各档有 Ramp 与保持时间，共 60 秒。
- Spike：2 → 100 → 2，并记录结束后的健康恢复时间。
- Soak：本地默认 10 VU / 120 秒，仅是短时资格检查；手动 Workflow 默认 30 分钟，可配置。长时间生产 Soak 仍需审批和证据。

单档命令 `pnpm load:test smoke|baseline|stress|spike|soak`，全档 `pnpm load:capacity`。可用本机 `K6_BINARY` 替代 Docker，但默认 Profile 及目标白名单仍生效。

Harness 为每档创建临时 Schema/受限角色，启动 3554 Web、8084 Go 测试服务和独立 Worker，真实 Better Auth 注册两个用户及 8 个 Tenant。以真实权限准备 32 份文档、Memory 和已通过评测/独立审批的 Prompt Release；k6 持有真实 Session，认证/RBAC/RLS/限流保持开启。

覆盖 health、Job submit/status、SSE、Evaluation、Prompt 查询、Knowledge、Memory。Prompt Resolution 通过真实 Job Submit 的 Pin 路径执行，不把管理查询冒充生产路由。部分重复提交使用同一幂等键验证同 Run。

JSON/Markdown 保存 HTTP Throughput/P50/P95/P99、限流/非预期错误、真实 Accepted/Completed Job、Queue/Execution P95/P99、端到端延迟、Token、模型耗时、队列深度、DB 连接、进程 CPU/RSS 样本、硬件、资源限制、数据规模及恢复时间。短 SSE 超时单独记录，协议正确性由既有重连/Last-Event-ID 测试验证。

数据来源：HTTP 来自 k6；Job 与 Token 来自实际持久化表；资源来自实际进程/数据库采样。CPU 为 ps 生命周期平均值，RSS 相加包含共享页，不能当作精确物理内存或瞬时整机 CPU。Native Next/Worker 未配置 cgroup 限制，明确 NOT VERIFIED。Next.js dev 与 Mock 不是生产容量承诺；配额造成的平台期不能冒充物理吞吐极限。PASS 表示测量完成、服务恢复、已接收 Job 对账一致；仍需查看是否达到 Proposed SLO。

## 故障与恢复不变量

复用并补充断言：

1. 容量竞争下 accepted 必有持久化 Job，无 phantom/静默丢失。
2. 全局/Tenant 配额原子生效，公平调度不被热租户一直占据。
3. 实际 SIGKILL 位于外部效果前/后，恢复将 Ledger unknown 阻断，旧 Token 不能提交；不伪称外部系统的任意 Exactly-Once。
4. 原有工具成功但审计/写回失败仍 unknown，不能靠重试掩盖。
5. PostgreSQL 断连、池耗尽、SQL 超时、独立容器重启，恢复后可处理原 queued 任务。
6. 真实本机 HTTP Fixture 注入模型 429、500、503、Timeout、中断/Partial Tool Call；不执行不完整调用，不访问真实付费 API。
7. 取消不重新执行，SSE 断线按现有 Last-Event-ID 去重并与终态一致。
8. HITL 真实进程恢复保持审批、Prompt Pin、ACL 与 Memory 复核，撤销/删除后不继续使用旧授权。
9. Audit 失败关闭、Drain 有界、终态 Deadline 原因不被晚到关闭覆盖。

故障代码仅在独立 CLI/测试 Fixture 中；没有普通用户 API 开关。生产 ENABLE_FAULT_INJECTION=true 会拒绝启动；Worker 生产 Mock 模型/Embedding 均需显式批准。

## Proposed SLO / Error Budget

所有目标是配置起点，尚无生产窗口数据，不声明 Achieved SLO：

| SLI | Numerator / Denominator | Window / Target | Exclusions / Source |
|---|---|---|---|
| API Availability | 合格受保护请求非服务错误 / 合格请求 | 30d / 99.9% | 无效输入/权限拒绝排除；HTTP category metrics；容量问题另外报告 |
| Submission | 202 / 有效授权提交尝试（含容量拒绝） | 30d / 99.9% | 无效/拒绝授权排除；幂等 HTTP Retry 算请求，独立 Job 数另计 |
| Completion | Active Deadline 内完成 / 合格终态和到期未终态 Job | 30d / 99% | 排除主动取消与人工等待时段；以 Job/Approval/Trace 为事实源 |
| Lightweight API | ≤300ms / 合格轻量非流式请求 | 30d / 95% | SSE、上传及长任务排除；HTTP latency histogram |
| Retrieval | ≤500ms / 合格检索 | 30d / 95% | 仅指定 Corpus/硬件；不含外部 LLM；retrieval histogram |

Error Budget = total×(1−target)，Burn = bad/budget，剩余可为负；零样本返回 NOT VERIFIED，不默认 100%。短/长窗口必须同时超过阈值：5m/1h 14.4x、30m/6h 6x。Completion 指标目前是观察到的终态代理；精确扣除全部审批等待及 overdue 分母必须结合持久化查询，不能只用 HTTP 或 Counter 宣称 SLO 达成。

## Metrics / Alerts / Dashboards

复用既有 queue wait / active jobs / model / RAG 指标，增加 completion/failure、fencing、lease expiry、poll retries、admission、pool wait、execution duration、worker heartbeat age、未知结果及 HTTP 指标。标签只有有限路由类别、状态、原因，不使用 Tenant/User/Run/Prompt 内容。Worker 忙时也刷新健康快照。

提供 SLO、Worker、Queue、Database、RAG、Recovery 六个 Grafana Dashboard，无样本显示 NOT VERIFIED。`reliability-alerts.yaml` 覆盖 Queue、Worker 缺失/超龄、Job Failure、Pool Saturation、Lease、Security、Backup Missing/Expired、双窗口 Burn。`pnpm reliability:alerts` 使用真实 promtool 语法及正负例测试。

规则和 Dashboard 文件不等于已部署告警。生产必须复核 Exporter 可达、真实采集、Alertmanager/通知接收人与演练；本次没有自动给现有线上观测栈发送告警或配置外部通知。

## Backup / Restore

`pnpm backup:create` 使用本机/指定 PG_DUMP_BINARY 的 pg_dump，自定义格式经 AES-256-GCM 加密，Manifest 不含 URL/Secret。文件 0600、目录 0700、密钥来自独立 Secret Store、文件不入 Git。只在完整成功后上报 scheduled backup success 时间；演练不冒充生产定期备份。

`pnpm backup:restore-test` 在专用测试容器执行实际 pg_dump → 认证加密/解密 → 新库 pg_restore，验证每张表数据摘要、pgvector、RLS/FORCE RLS、真实受限角色与跨租户隔离、应用检索 Smoke，并重启专用测试 PostgreSQL 验证 queued Job 与终态事件。不会覆盖开发/生产库。

演练自动生成的密钥只在内存中存活，不是可长期恢复的生产备份；提供 BACKUP_ENCRYPTION_KEY 时可由操作者保留密钥。报告真实耗时只适用于该 fixture 数据规模。定期逻辑快照没有零丢失 RPO；分钟级 RPO 需要独立 WAL Archiving/PITR 和真实恢复演练。保留/删除先执行 `pnpm backup:retention` dry-run；未经异地副本/恢复/法律保留确认不自动删除。

## Production Readiness Gate

`pnpm readiness:check` 输出 JSON/Markdown，逐项 PASS/WARN/FAIL 与 VERIFIED/NOT VERIFIED/FAILED/NOT APPLICABLE；关键 FAIL 或关键缺证据必须非零退出。

检查生产模式、TLS verify-full、Secret 形状/开发默认值、Origin、Mock 批准、可信代理策略、有限资源、超时、观测、备份、真实迁移、pgvector、RLS、审计触发器、受限运行身份与 Worker 心跳。只读 inspection 使用 READINESS_DATABASE_URL / READINESS_SCHEMA；凭据或连通性缺失不默认通过。

Evidence 必须新鲜（24 小时）、成功且 source SHA 匹配：faults、regression、load smoke、backup restore。配置 SHA 绑定实际安全配置，报告不输出密钥原文。源码 Hash 和文件摘要是完整性证据，不是签名；制品目录/审核输入必须由可信 CI/发布操作者控制。

部署 Cookie/CSRF、真实采集/通知、定期生产备份/恢复、生产容量计划、依赖/容器审查为 MANUAL REVIEW；本地 Mock 不能替代。若有可信人工签核，READINESS_MANUAL_REVIEW_FILE 包含 source_sha256、configuration_sha256、reviewer、approved_at 和 checks[{id,evidence_file,sha256}]。Gate 核对有效期、绑定和附件完整性；这是明确的人工认定，不是自动证明或可让普通用户调用的 API。缺失时保持 NOT VERIFIED。

依赖扫描、镜像 Digest/非 Root、TLS/代理和通知交付中无法自动确认的部分，不伪装成 PASS。参考 `.env.production.example`，真实 Secret 不入 Git。

## CI、Runbooks 与冻结

普通 CI 保留原测试，加入 Reliability/Fault、脚本类型检查、隔离 Backup/Restore/Restart、30 秒 k6 Smoke、promtool 以及制品上传。`reliability-heavy.yaml` 仅手动运行 Baseline/Stress/Spike/Soak，60 分钟上限；不在每个 PR 跑数小时压力测试。全部使用 Mock 或本机受控 HTTP Fixture。

操作 Runbooks 位于 [operations](operations/worker-crash.md)：Worker crash、DB outage、Model outage、Queue backlog、Backup/Restore、Security incident、Rollback，包含症状、检测、分级、缓解、恢复、验证、升级及复盘。

`pnpm reliability:report` 汇总 26 项验收与范围。生产 Readiness、远程本次提交 CI、长生产 Soak、真实付费 Provider、真正生产数据规模/RPO/RTO及人工安全审查未验证时，Day 14 不正式冻结。测试脚本绿色只证明对应范围，不代表生产承诺。
