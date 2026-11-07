# Day 13 逐项验收

日期：2026-11-06。范围为当前本地工作区；远程 CI 不用旧提交的结果替代。

| 清单 | 结果 | 证据 |
|---|---|---|
| 多租户 Knowledge Base CRUD | PASS | 受限角色集成测试、真实认证 API、浏览器创建/列表；跨租户资源不可见 |
| 文档上传、版本化、异步入库 | PASS | Markdown 浏览器上传至 Ready；真实版本递增、去重、原子发布和失败不暴露索引 |
| Chunking / Embedding 可复现 | PASS（Mock/接口契约） | Unicode/重叠/offset/空与长文档、文本 PDF/无 OCR、固定 32 维 Mock、真实 HTTP 接口响应验证 |
| pgvector / FTS | PASS | PostgreSQL 17 + vector 扩展，真实 SQL 距离、FTS 和中文子串查询 |
| Hybrid / RRF 排序 | PASS | 真实 SQL 验证 2/61、2/62 数值及 UUID Tie-breaker、版本与元数据过滤 |
| Tenant RLS / Document ACL | PASS | 无权限及跨租户 Chunk 为 0；显式 user/role/group 授权、撤销后即时拒绝；所有表 FORCE RLS |
| Citation 可验证、不伪造 | PASS | Chunk/版本/正文 Hash/来源元数据核对；非本次检索引用拒绝；伪造文本未进入 SSE |
| 恶意文档不能提升工具权限 | PASS（授权控制） | 文档保持 tool role；独立 Policy/HITL 未放宽；可执行工具不由文档定义。不宣称所有真实模型都免疫注入 |
| Session Summary / Long-Term 分离 | PASS | session_summary + session scope/source；显式从本人 user/assistant 历史提取；浏览器生成与用户事实同时显示 |
| Scope / TTL / Delete | PASS | 服务端 Agent/session 绑定、立即过期过滤、受限批次内容清理、忘记后普通查询为空 |
| 跨租户/跨用户记忆隔离 | PASS | 两个真实 Better Auth 用户不能读/删对方私有记忆；tenant scope 仅显式授权共享 |
| Worker / HITL 恢复 | PASS | 延迟旧 Worker 被新 lease fenced；Embedding 退避重试；新 Executor 恢复只执行一次后续工具，撤销时效果为 0 |
| RAG Evaluation → Day 11 Gate | PASS | 7 个确定性 RAG 用例通过；伪造引用/泄露独立 Hard Failure；Faithfulness 词项代理为 inconclusive |
| API / Dashboard | PASS | 真实 Session/Origin/RBAC/RLS API 集成与 11 个浏览器场景 |
| pnpm check | PASS | 退出码 0；333 项 TypeScript 测试、Go vet/test/build、Next.js Build、Risk 6 / RAG 7 Gate 全通过；Go race 另行通过 |
| GitHub Actions CI | NOT VERIFIED | 工作流已更新 pgvector、Knowledge/RAG、Chromium E2E 与证据上传；工作区未提交/推送，无对应远程运行 |
| 浏览器 E2E / Day 1–12 回归 | PASS | Day 13：11 PASS / 0 FAIL / 0 SKIPPED；Day 12：15 浏览器 PASS + 4 API PASS；原全部测试保留 |

## 计数与运行范围

TypeScript：Knowledge 27、Evaluation 53、Observability 29、Tools 9、AI 72、Persistence 58、Worker 51、Web 34，共 333。Go HTTP/Telemetry tests 与 race 均通过。原有 see.test.ts 的 unused `_event` warning 仍存在，Lint 无 error。

Day 13 的 11 个浏览器场景：真实注册/租户、知识库创建、上传 Ready、版本历史、Hybrid 引用、Session Summary、显式用户记忆、忘记、ACL 授撤、删除后空检索、RAG Dataset/Run/Gate。Session Summary 用认证 Job API 准备本人会话，随后实际点击页面生成；该 API 属于测试数据准备，不冒充页面操作。其余 API 权限负例由真实 Session 集成测试单独验证。

测试复用项目 fixture，在独立 5543 pgvector 测试库中创建临时 Schema/角色；浏览器通过真实 Better Auth 注册，未注入伪造 Session、未关闭 RLS/RBAC/Gate。测试结束清除账号、租户、Schema 和临时角色，关闭 3552/3553 Web、Worker 及 8082/8083 测试业务服务。既有业务数据库未迁移，既有 3551 Web 未重启。

## 证据

- `artifacts/day13-acceptance/report.json`、`pnpm-check.log`、`go-race.log`、`modified-files.txt`、`sha256.txt`。
- `artifacts/day13-browser/report.json`、`trace-0.zip`、`01-ready.png`、`02-retrieval.png`、`03-memory.png`、`04-rag-evaluation.png`、服务日志。
- `artifacts/day12-browser/report.json`、Owner/Admin/Member 的 `trace-0.zip` / `trace-1.zip` / `trace-2.zip` 与截图。
- `artifacts/evaluation/` 和 `artifacts/rag-evaluation/` 的 JSON/Markdown/Gate 报告。
- Trace ZIP 完整性已检查。前期失败发现并修复了空 Document ID 的 ACL 撤销请求、异步控件等待、Tab/加载状态和删除记忆的 RLS 冲突；最终数字只取最终通过运行。

## 冻结结论与未验证边界

**本地功能与回归验收通过；Day 13 整体暂不正式冻结，等待当前提交的远程 GitHub Actions 通过。**

真实付费 Embedding / DeepSeek / LLM Judge 调用为 NOT VERIFIED，不以 Mock 的满分代替真实语义质量。RAG CLI 的隔离 Corpus 与真实 PostgreSQL 集成测试是不同证据：前者验证质量/安全 Gate 流程，后者验证真实 SQL 检索/ACL；不宣称已对客户真实知识库完成质量基准。

CJK 是 FTS + 子串回退；无 OCR；精确检索未承诺大规模 ANN 性能；语义忠实性与注入免疫无法仅靠规则证明。完整架构、API、迁移和限制见 [Day 13 技术文档](day13-enterprise-knowledge-memory.md)。

## 实际运行库 pgvector 修复（2026-11-06）

用户执行迁移遇到 vector.control 缺失后，已导出当前 eap 数据库及全局角色的私有备份。Compose PostgreSQL 改为 `infra/postgres/Dockerfile` 构建：使用现有容器精确 Alpine 17.11 底座，加装 pgvector 0.8.2；只重建 postgres 容器，保持 `enterprise-agent-platform_postgres_data` 数据卷。已在实际 localhost:5432/eap 成功应用 009。

迁移前后用户 2、租户 3、会话 13、Run 13、消息 19，数量一致。Worker 受限角色的扩展类型、入库/清理函数权限和回滚事务中的清理调用通过。在该实际 Alpine 环境的隔离 Schema 中补跑 Knowledge 27 项测试，全部通过。修复报告见 `artifacts/day13-runtime-repair/`；私有备份见 `artifacts/db-backups/pgvector-G36agLxH/`。本节更新了此前“业务库未迁移”的运行环境状态；远程 CI 状态仍未改变。
