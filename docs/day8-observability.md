# Day 8 — Agent Observability

## 架构与边界

```text
Next.js agent.job.submit → PostgreSQL agent_jobs.trace_context (W3C traceparent)
  → 独立 Worker extract → agent.job.claim / agent.job.execute
    → AgentRunner agent.run → agent.model.request / agent.tool.execute
      → HTTP traceparent → Go business.http
Node / Go OTLP traces → Collector → Tempo
Node OTLP metrics → Collector Prometheus exporter → Prometheus
Node / Go JSON stdout + sanitized OTLP logs → Collector → Loki
Grafana → provisioned Prometheus / Tempo / Loki + Agent Overview
```

业务 `trace_id` 仍为原有 UUID，用于业务 Trace/Run API；OTel Trace ID 为 SDK 生成的 32 位十六进制 ID，保存为 Run `observability.otelTraceId`。二者不混用。异步任务在创建事务中保存 W3C Context，Worker 使用该远程 Parent 创建执行 Span，即使 HTTP 已结束也能关联。不是通过进程内变量维持跨进程关系。

共享包使用独立的 TracerProvider、MeterProvider 和 AsyncLocalStorage Context，不覆盖 Next.js 自身的全局 OTel Provider。Next `instrumentation.ts` 仅在 Node Runtime 初始化；没有将 Node SDK 放入客户端或 Edge Bundle。手工 Span 覆盖 Agent API 与运行链路，不启用会自动抓取 headers、SQL 参数、URL query 的全量 HTTP/数据库自动采集。`agent.sse.subscribe` 覆盖订阅生命周期，浏览器断开仍不取消 Worker。

SDK 使用 global symbol 保证热重载不重复初始化，导出在后台进行、队列有界。Collector 不可用时不重试业务操作；进程关闭最多等待 2 秒。Worker main 在释放数据库连接后关闭遥测，Smoke Test 用 SIGTERM 验证独立进程退出；强制 SIGKILL、进程崩溃或 Next.js 强制退出仍可能丢失未导出的遥测。

## 依赖与版本

Node 锁定 OTel API 1.9.0、SDK/Core/Resources/Metrics 2.12.0、OTLP 和 Logs 0.223.0，作为兼容的一组版本。2.x 的 Trace Node/Base 包已标记 deprecated，但仍是受支持的 2.x 系列；未来升级 3.x 需整体迁移，不能只升级一个导出器。参考 [OTel 官方 3.x 迁移说明](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/3.x/migration-guide.md)。

Go 锁定 OTel Trace 1.38.0、Logs 0.14.0 及对应 OTLP HTTP 导出器。OTLP Logs 接口在这组版本中仍带 0.x 版本号，升级应统一验证。没有添加 Grafana/Tempo/Prometheus 到业务代码依赖。

## 环境变量

模板：[.env.observability.example](../.env.observability.example)。根目录模板不会自动加载，需要分别 export 到 Web、Worker 启动终端。

| 变量 | 用途 |
| --- | --- |
| `OTEL_ENABLED` | 默认 false，设 true 启用 SDK；JSON stdout Logger 仍可用 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Node 默认 http://127.0.0.1:4318，Compose 内 Go 使用 http://otel-collector:4318 |
| `MODEL_PRICES_JSON` | 有效日期/版本化价格数组；缺省仅显式知道 mock-model 免费，真实模型价格未知 |
| `GRAFANA_ADMIN_PASSWORD` | 可选本地引导密码；UI 默认匿名 Viewer，登录表单与 Basic Auth 关闭 |
| `TEST_DATABASE_URL` | 集成测试与 Smoke 使用独立测试 DB，用户须能 CREATE/DROP SCHEMA |
| `GRAFANA_URL` | Smoke 查询入口，默认 http://127.0.0.1:3000 |
| `OBSERVABILITY_FAULT_TEST` | 仅 Smoke 的故障验收模式，true 时验证业务与退出，不要求导出成功 |

Node OTLP HTTP 使用 JSON 编码；Go 使用 protobuf，两者都由同一 Collector HTTP Receiver 接收。不要给 Node 设置 gRPC 协议；当前显式初始化不读取通用 OTEL_TRACES_EXPORTER、OTEL_*_HEADERS、每信号 endpoint 或自动 Resource Detector。默认不传播 baggage/tracestate，以减少敏感数据传播。

## 启动

```bash
pnpm install
# 启用观测 Profile，并使 Go API 启用 OTLP
OTEL_ENABLED=true docker compose --profile observability up -d --build --wait

export DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap'
pnpm --filter @eap/persistence db:migrate

# Worker 终端
export OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
LLM_PROVIDER=mock pnpm --filter @eap/agent-worker start

# 在另一个终端导出相同 DATABASE_URL / OTEL_ENABLED / endpoint 后：
ENABLE_ASYNC_AGENT_DEV=true pnpm --filter @eap/web dev
```

Grafana：http://localhost:3000/d/agent-overview 。只开放本机 3000、4318；Prometheus、Tempo、Loki 的查询端口只在 Compose 网络内部，统一通过 Grafana Datasource Proxy/Explore 查询。默认匿名只读，不能公开部署；如需编辑 Dashboard，通过版本控制中的 JSON Provisioning 修改，不使用匿名 Admin。

现有 PostgreSQL 和 Business API 不属于 observability Profile，普通 `docker compose up` 不会拉起观测组件。启用 Profile 时显式 `OTEL_ENABLED=true` 才打开 Go 导出，普通开发无 Collector 也可继续运行。

## 指标定义与 Dashboard

| 指标 | 语义 |
| --- | --- |
| `agent_runs_total` | AgentRunner 执行结束次数，按 completed 或明确错误码聚合；不是数据库终态历史总数 |
| `agent_run_duration_seconds` | Runner 实际执行时长 Histogram，不含排队时间 |
| `agent_queue_wait_seconds` | 成功 Claim 时，从 Job 创建到领取的时长 Histogram |
| `agent_active_runs` | 当前进程仍在执行的 Runner；非单调 UpDownCounter，Prometheus 导出为 Gauge |
| `agent_worker_claims_total` | 成功领取的 Job 数；空轮询不累计 |
| `agent_worker_lease_renewal_failures_total` | 续租被拒或数据库不可用，按 bounded status 聚合 |
| `agent_worker_active_jobs` | 当前进程正在处理的 Job Gauge |
| `agent_worker_blocked_jobs_total` | 过期扫描成功阻断或完成事务因未知工具结果阻断的数量 |
| `agent_model_requests_total` / `agent_model_duration_seconds` | 每次模型流调用次数和时长，含决策与最终回答阶段 |
| `agent_model_tokens_total` | 仅累计每次请求首个真实 Usage；direction=input/output，usage_source=reported |
| `agent_model_estimated_cost_usd_total` | 基于已报告 Usage 和有效已知价格的估算成本；未知价格不产生伪造 0 点 |
| `agent_tool_executions_total` / `agent_tool_duration_seconds` | 每个逻辑工具调用及策略内重试的总耗时；不因观测重新调用工具 |

Histogram 单位 s；Token Counter 单位 1；成本 Counter 单位 USD。Collector `add_metric_suffixes: false`，Dashboard PromQL 与上述名称精确对应。Histogram 导出 `_bucket`、`_sum`、`_count`。UpDownCounter 的正负变化反映进程实时活跃数，不把历史累计 Job 数伪装成 Gauge。未新增队列 backlog Gauge。

标签仅 provider/model/tool/status/error_code/direction/usage_source 等有限维度；不允许 Run/Job/User/Trace ID 成为业务 Metrics 标签。未注册的模型请求工具名称统一记为 unknown。服务 instance ID 是进程级 Resource，用于区分多个 Worker，避免不同进程的累计指标互相覆盖。

Agent Overview 提供运行次数、成功/失败率、运行时长 P50/P95/P99、队列 P95、活跃任务、续租失败、Token、已知估算成本、工具调用与 P95、错误趋势、blocked 数与活跃 Runner。

注意 `agent_runs_total` 的“成功率”指 Runner 执行完成率。Lease fencing 拒绝完成提交时，数据库可能最终 interrupted，查询 `agent.job.finalize` / 日志 / Run API 才能确认提交结果；不要把执行率当作数据库最终成功率或账单数据。

## Trace 与日志查询

在 Grafana Explore 选 Tempo，用 Run API 返回的 `run.observability.otelTraceId` 查询整条 Trace，或 TraceQL：

```text
{ resource.service.name = "eap-agent-worker" && span.agent.run_id = "<RUN_ID>" }
```

Loki 的链接模板按 [Grafana 官方 Provisioning 说明](https://grafana.com/docs/grafana/latest/datasources/loki/configure/) 使用双美元转义，Smoke 检查加载后仍为 `${__value.raw}`。

选 Loki，按 Run/Trace 的结构化元数据过滤，不将这些 ID 建为索引标签：

```logql
{service_name="eap-agent-worker"} | run_id="<RUN_ID>"
{service_name=~"eap.*"} | trace_id="<OTEL_TRACE_ID>"
```

Node 和 Go 都将脱敏事件写标准输出，同时经 OTLP → Collector → Loki，日志采集已实际连通，不依赖挂载 Docker socket 或宿主机日志路径。Node 使用白名单 JSON Logger：timestamp、level、service、message、trace_id、span_id、run_id、job_id、worker_id、error_code；无关联值时为 null。Go HTTP 日志关联 trace/span，使用固定事件名与错误码，不记录完整路径、query、headers 或 payload。Go 的 stdout 使用 slog 标准 time/msg 字段，OTLP 记录会携带标准时间和 Body。

Span 不记录 Prompt、模型响应、工具参数、工具结果、API Key、数据库 URL 或 Authorization。异常只提取有限错误码，不自动 recordException。提交链路不传播 baggage/tracestate。业务消息仍按 Day 6/7 设计保存到 PostgreSQL；这与遥测采集边界不同。

## Usage 与成本

迁移 `004_observability.sql` 增加 Job `trace_context`、Run `observability`、唯一 `agent_usage(run_id)` 快照表；不改变业务状态枚举或状态机。Worker 仍使用原来的 finalizeJob 事务和 Lease 检查，回答、Trace、状态及快照一起提交，重复 finalize 不会再计一次 Usage 或成本。

- 模型请求层 Metrics 累计 Usage，完成事务不会再次把最终 Token 计入 Metrics。
- `agent_usage` 提供每 Run 输入、输出、总 Token、provider/model、Usage 完整度、估算 USD 和所用价格快照。
- `usage_source=reported`：每次模型调用均返回 Usage；partial：部分调用返回；unavailable：完全没有 Usage。没有通过字符数伪造 Token，没有把未知 Usage 标为实际 Usage。
- MockProvider 当前没有 final 阶段 Usage，所以正常测试快照是 partial（输入 50、输出 30、已知共 80）；不是整个 Run 的完整账单。
- USD = `(inputTokens × inputPrice + outputTokens × outputPrice) / 1,000,000`。
- 模型价格来自 `MODEL_PRICES_JSON`，按 provider、model、effectiveAt 选择生效版本，包含 input/output、unit=per_million_tokens、version。Run 快照以 Run 开始时的报价计算已报告用量，Metrics 按各次模型请求用量报价；跨价格生效边界时二者可能不同。
- 未知价格或没有任何 Usage 时，Run 成本为 null。前端显示 Unknown，部分 Usage 标注 incomplete coverage；不是已收费账单。
- `GET /api/agent/runs/[id]` 查看单 Run 快照；`GET /api/agent/usage` 按模型聚合持久化数据，返回 unknown_cost_runs、incomplete_usage_runs。只要一项价格未知，聚合成本保持 null。两个 API 沿用 Day 7 的受控本机开发访问限制。

价格配置结构示例（金额是演示值，必须替换成运营方核实的实际报价）：

```json
[{"provider":"deepseek","model":"your-model","input":1,"output":2,"unit":"per_million_tokens","effectiveAt":"2026-11-01T00:00:00Z","version":"operator-quote-v1"}]
```

不要在 AgentRunner 中硬编码商业价格。错误或无效价格配置按未知处理，避免中断业务。

## 自动化验证和完整本地验收

```bash
# 第一次建立专用测试库；已存在时无需重复创建
docker compose exec -T postgres createdb -U eap eap_test
export TEST_DATABASE_URL='postgresql://eap:eap_dev_password@localhost:5432/eap_test'
export DATABASE_URL="$TEST_DATABASE_URL"
pnpm --filter @eap/persistence db:migrate
pnpm check
(cd services/business-api && go test -race ./...)

# 需要已启动且健康的五个观测后端，以及启用 OTEL 的真实 Go API
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm test:observability
```

Smoke 在专用 PostgreSQL schema 提交一个 Job，启动真正的独立 Worker 子进程，调用真实 Go API，完成后 SIGTERM 并验证有界、正常退出。然后通过 Grafana Proxy 检查 Tempo 整条 Trace（包含 Go）、Prometheus Token 指标、Loki 关联日志、Dashboard Provisioning 和每条 Dashboard PromQL；最后清理测试 schema。不能在生产数据库运行 Smoke。

人工验收：访问 http://localhost:3551/agent，选择 Async，发送“查询今天风险最高的 3 笔交易”。最终结果后查看成本与 Usage 完整度提示，用 Run API 查询 OTel Trace ID，再在 Grafana Explore 和 Dashboard 核对。保持已有 Stream 模式可用；刷新页面后 UI 恢复会话的限制与 Day 7 相同。

Collector 故障验收：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:1 \
  OBSERVABILITY_FAULT_TEST=true pnpm test:observability
```

这会让 Node 真实 OTLP 导出不可用，确认业务完成、Usage 持久化和退出有界，不要求后端出现遥测。也可 `docker compose --profile observability stop otel-collector` 后提交普通任务，核实仍完成，再启动 Collector；有界内存队列期间未发送的数据可能丢失，不会自动补账。

普通 CI 增加 Observability Typecheck/Tests，保留原 PostgreSQL Service、AI/Tools/Persistence/Worker/Web 和 Go Vet/Race/Build，不需要观测后端。另新增仅 workflow_dispatch 的 `Observability Smoke` 工作流，完整启动 Compose 并执行 Smoke，不拖慢每个 PR。

## 数据保留与已知限制

- Prometheus 24h / 最大 512MB；Tempo Trace 24h；Loki 24h，由 compactor 清理；Grafana 配置存在命名卷。删除 Profile 容器不会删卷，过期清理不是即时的磁盘硬上限。
- Collector/SKD 内存队列有界，不是持久化遥测 outbox。进程崩溃、后端长时间不可用会丢 Metrics/Trace/Logs；Prometheus Counter 不能用作精确账本。唯一 Run Usage 快照是持久化核算依据，但当前 Worker 崩溃前尚未完成的 Usage 没有最终快照。
- Trace 默认对根 Trace 采样并尊重上游采样标记，生产需按流量增加采样、配额、OTLP TLS/认证、访问控制、保留/磁盘策略。本地 Profile 匿名只读和 loopback 绑定不等于生产安全配置。
- 队列 claim/finalize 的 Span 和 Metrics 是观测，不改变重试、Lease、fencing、取消或未知副作用不重放规则。
- 目前以 AgentRunner 路径为重点；普通 `/api/chat` 非 Agent 模型调用只有结构化错误日志，未扩展成完整的 GenAI 自动采集。
- 当前 Web 的生产异步 API 禁用策略与 Day 7 一致。没有新增用户认证/多租户隔离。
- 当前只做估算，不支持缓存命中 Token 价格、分档费率、税费或供应商对账。真实 DeepSeek 不在 CI 中调用。
- SDK 2.x 与 0.x OTLP/Logs 接口已经锁文件固定；未来升级要重跑单元、跨进程、后端 Smoke，不能只依赖容器 healthy。

## 本次实际执行结果

- `pnpm install` 完成，并更新锁文件；保留已有 Web Node 20 类型与 Vitest 5 的 peer 提示，以及锁定 OTel 2.x 旧入口的 deprecated 提示。
- `pnpm check` 最终通过：Observability 12、AI 68、Tools 6、Persistence 23、Worker 14、Web 6，共 129 项 TypeScript 测试；六个包类型检查、Web lint/build、Go vet/test/build 全部通过。
- Go `go test -race ./...` 通过，包含 W3C Parent 提取、HTTP 错误状态、日志脱敏、禁用 SDK 测试。
- `004_observability.sql` 已应用到本地 eap 和 eap_test；数据库测试继续使用独立 schema 和真实 PostgreSQL。
- 实际构建并运行 Collector、Prometheus、Tempo、Loki、Grafana，五个均 healthy；Business API 已按当前源码重新构建，OTLP 启用。
- 正常 `pnpm test:observability` 通过：独立 Worker、真实 Go HTTP Span、Prometheus Token 数据、Loki Trace 关联日志、Dashboard Provisioning、每条 Dashboard PromQL、SIGTERM 退出码及唯一 Usage 快照均验证成功。
- 故障 Smoke 通过：Node OTLP 指向不可用的 localhost:1，Agent 仍完成，Usage 仍持久化，Worker 有界退出。
- 验证中发现并修复 Collector 重试间隔与上限冲突，以及 Tempo 部分 Trace 提前可见导致 Smoke 过早断言的问题（现在按完整 Span 集合轮询）；依赖更新后 Web Vitest 旧路径缓存导致的套件加载问题，清缓存后完整检查通过。
- 唯一已有 lint 警告是 `apps/web/src/lib/see.test.ts` 的未使用变量。没有跳过或删除旧测试，没有修改原 Deadline 测试的期望/时间。
- 未调用真实 DeepSeek，未运行远端 GitHub Actions，未完成浏览器交互/视觉验收；不能声称这些已验证。
- 观测后端与启用 OTel 的 Go 容器保留运行，方便本地查看 Grafana；Smoke 临时 Worker 已退出、临时数据库 schema 已清理。

## 修改文件清单

```text
.env.observability.example
.github/workflows/ci.yaml
.github/workflows/observability-smoke.yaml
apps/web/.env.example
apps/web/.gitignore
apps/web/package.json
apps/web/src/app/api/agent/jobs/route.ts
apps/web/src/app/api/agent/runs/[id]/cancel/route.ts
apps/web/src/app/api/agent/stream/route.ts
apps/web/src/app/api/agent/usage/route.ts
apps/web/src/app/api/chat/route.ts
apps/web/src/components/chat-panel.tsx
apps/web/src/instrumentation.ts
apps/web/src/lib/run-event-stream.ts
apps/web/src/lib/sse.ts
compose.yaml
docs/day8-observability.md
infra/observability/Dockerfile
infra/observability/collector.yaml
infra/observability/grafana/dashboards/agent-overview.json
infra/observability/grafana/provisioning/dashboards/dashboards.yaml
infra/observability/grafana/provisioning/datasources/datasources.yaml
infra/observability/healthcheck.go
infra/observability/loki.yaml
infra/observability/prometheus.yaml
infra/observability/tempo.yaml
package.json
packages/ai/package.json
packages/ai/src/agent-runner.ts
packages/ai/src/runtime.ts
packages/observability/package.json
packages/observability/src/cost.ts
packages/observability/src/index.ts
packages/observability/src/testing.ts
packages/observability/tests/telemetry.test.ts
packages/observability/tsconfig.json
packages/persistence/migrations/004_observability.sql
packages/persistence/package.json
packages/persistence/src/job-lifecycle.ts
packages/persistence/src/job-queue.ts
packages/persistence/src/store.ts
packages/persistence/src/types.ts
packages/tools/package.json
packages/tools/src/transactions.ts
pnpm-lock.yaml
services/agent-worker/package.json
services/agent-worker/scripts/observability-smoke.ts
services/agent-worker/src/executor.ts
services/agent-worker/src/index.ts
services/agent-worker/src/worker.ts
services/agent-worker/tests/worker.test.ts
services/agent-worker/tsconfig.json
services/business-api/Dockerfile
services/business-api/cmd/server/main.go
services/business-api/go.mod
services/business-api/go.sum
services/business-api/internal/httpapi/handler.go
services/business-api/internal/telemetry/telemetry.go
services/business-api/internal/telemetry/telemetry_test.go
```

## 稀疏流量下的面板口径

短命 Smoke Worker 可能在 Prometheus 第一次抓取之前就完成了所有请求。此时首次计数已为 1，后续没有增长，`rate`/`increase` 不能反推首次抓取前的事件，Histogram rate 分位数还可能为 NaN。不能据此判断没有采集数据。

Agent Overview 的主要概览现采用 Stat 面板，显示选定时间内出现过的每个进程最新累计 Counter，以及累计 Histogram 的分位数。标题标记 Observed，描述说明这包含进程生命周期累计量，不是严格的时间段新增量；历史样本可以在 Worker 退出后继续查看。近期错误趋势保留 rate 查询，活跃任务保持实时采样 Gauge。未采集到过的失败/阻断事件显示 No reported samples，不能把没有遥测误当成零故障。

这次修复通过 Grafana 代理逐一执行所有面板 PromQL，并核对实际返回的运行数、Token、成本和延迟值；查询合法与查询有数据分别检查。

## Worker 的本地环境文件

`pnpm --filter @eap/agent-worker start` 和 `dev` 会自动读取 `services/agent-worker/.env.local`（Node 24），无需手写 `pnpm exec tsx --env-file`。文件不存在时继续使用终端环境，保留 CI 与容器的注入方式。可参考同目录 `.env.example` 创建本地文件；不要提交真实密钥。

终端中已 export 的同名变量优先于文件。例如以前执行过 `export LLM_PROVIDER=mock`，需先 `unset LLM_PROVIDER` 才会使用文件中的 deepseek。环境文件修改后重启 Worker。Web 仍使用自己的 `apps/web/.env.local`。
