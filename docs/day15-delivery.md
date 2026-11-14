# Day 15 — 验收收尾与交付

日期：2026-11-14。范围为本地功能交付；生产上线仍遵守 Day 14 readiness gate。

## 本次修复

- 完整回归的 ESLint 排除 `.next-load/**`，与已有 `.next`、`.next-e2e` 生成目录一致。保留全部源码规则。
- 负载 Harness 在数据库恢复与 Job 对账前保存 k6 结果、退出码及准确阶段。数据库不可用时仍返回失败，但保留 HTTP 测量证据。
- 旧 Worker 超时/关闭竞争失败已用真实 PostgreSQL 集成套件重新验证；最终结果以当前执行报告为准。

## 启动与配置交接

日常开发启动见根 README。Web、Go API、Worker 是独立进程；根 `pnpm dev` 不启动 Worker。迁移使用 provisioner 身份，运行服务使用受限身份；不要把测试数据库管理员配置给业务服务。

- Web 配置参考 `apps/web/.env.example`。
- Worker 配置参考 `services/agent-worker/.env.example`。
- 生产配置参考 `.env.production.example`，并执行 `pnpm readiness:check`。
- 数据库升级前先备份；回滚与恢复见 `docs/operations/rollback.md`、`docs/operations/backup-restore.md`。
- 密钥、Session、备份和浏览器 Trace 不入 Git；`artifacts/` 为本地私有证据目录。

## 演示步骤与判定

1. 在 `/login` 注册并创建组织，在 `/security` 检查成员、角色和工具策略。
2. 在 `/knowledge` 创建知识库，上传包含退款规则的小 Markdown，等待 Ready，检索并核对引用内容与来源。
3. 创建显式授权记忆，再删除，确认后续查询不再返回内容。
4. 在 `/agent` 提交 Agent 请求，观察持久化任务和流式结果；刷新后核对任务状态。
5. 对需审批工具走人工审批，核对批准/拒绝及审计记录；使用另一个组织确认资源隔离。
6. 在 `/prompts` 展示版本、评测、独立审批发布与回滚；未通过质量 Gate 的版本不能直接上线。

浏览器自动化覆盖 Knowledge/Memory 与 PromptOps；审批、取消、重连、授权撤销和租户隔离另有真实 Session API / PostgreSQL / Worker 集成证据。不要将 API 测试称为已完成的页面点击。

## 复验命令

仅使用 `127.0.0.1:5544/eap_test` 专用测试环境，按顺序运行，备份演练会重启该测试数据库。

```sh
docker compose -p eap-day14 -f compose.day14-test.yaml up -d --wait
# .env.day14.local 配置 TEST_DATABASE_URL，使用 compose.day14-test.yaml 的测试凭据
pnpm reliability:check
pnpm reliability:test
pnpm reliability:browser
pnpm reliability:alerts
pnpm backup:restore-test
pnpm load:test smoke
pnpm reliability:report
```

完整回归、故障、浏览器、告警、备份恢复及 Smoke 的结果分别位于 `artifacts/day14/{regression,faults,browser,alerts,backup-restore,load/smoke}/report.json`。报告需要成功、24 小时内且源码指纹与版本匹配。汇总不刷新执行时间。

Stress、Spike、Soak 在手动 `reliability-heavy.yaml` 中分别执行。旧 Stress 记录含数据库 `ECONNREFUSED`，没有充分证据证明是资源耗尽或应用容量极限，仍保留 FAIL。不要通过降低并发后沿用 Stress 名称来消除该失败。

## 签收边界

本地演示交付、Day 14 全项冻结、生产上线分别判定。本地测试通过不能替代当前提交的远程 CI、生产配置、真实告警通知、定期备份、容量计划和安全审查。缺证据标注 NOT VERIFIED；已有失败继续保留，禁止把 Day 15 开始日期作为 Day 14 验收通过依据。

## 2026-11-14 执行记录

| 检查 | 结果 |
|---|---|
| `pnpm reliability:check` | PASS；354 项 TypeScript 测试、Go vet/test/build、Next.js Build、Risk 6 / RAG 7 Gate |
| `pnpm reliability:test` | PASS；316 项断言，0 失败，包含 Worker 55 项集成测试 |
| `pnpm reliability:browser` | PASS；Knowledge/Memory 11 项、PromptOps 页面 15 项、API 4 项，均无失败/跳过 |
| `pnpm reliability:alerts` | PASS；真实 promtool 校验及正负例 |
| `pnpm backup:restore-test` | PASS；12 项检查，新库恢复、隔离权限、测试库重启与队列持久性 |
| `go test -race ./...` | PASS |
| `pnpm load:test smoke` | PASS；2 VU / 30 秒，256 次请求，非预期 HTTP 错误为 0，32 个任务全部完成，无失败或未完成任务 |

Lint 保留 2 个已有 warning（Knowledge effect cleanup、SSE 测试 unused variable），0 error。当前执行使用本地 Mock/受控 HTTP Fixture；未调用真实付费 Provider。

本次修复后的核心证据源码指纹为 `fcd4ed189da36b282029ae2b699ecf609892f1e82c77299d0d65733f924dc6e5`。版本基线为 `482807c94e6116061bd36c546fae996f5961615d` 加本地未提交改动；源码指纹覆盖这些改动，不能把该基线提交的旧 CI 当作本次 CI。

结论：本地功能演示与上述回归具备签收证据。Day 14 全项仍不冻结：Stress 历史失败、Baseline 证据过期、Spike/Soak 缺证据，生产 readiness 与远程 CI 未验证。现有测试脚本已清理临时服务、Schema 和角色；专用测试 PostgreSQL 容器保留运行，未启动业务栈。
