# Day 12 PromptOps 浏览器验收

最终运行完成时间：2026-11-06 00:06 JST。执行命令 `pnpm test:e2e:promptops`，退出码 0。

| 范围 | 总数 | PASS | FAIL | SKIPPED |
|---|---:|---:|---:|---:|
| 浏览器场景 | 15 | 15 | 0 | 0 |
| API 验收 | 4 | 4 | 0 | 0 |
| 清理 | 1 | 1 | 0 | 0 |

浏览器场景使用 Playwright 驱动本机 Google Chrome headless，包括注册、退出及密码登录、创建组织、打开 `/prompts`、创建 Prompt、Draft 创建及保存、发布不可变版本及只读状态、导入完整 Day 11 数据集、由真实 Worker 完成绑定评测、创建 Release、禁止作者自我审批、第二管理员独立审批、Canary 0→5→25→50→100% 及完成、v2 Baseline Gate、A/B 实验创建/启动/结束、查看实验指标、v2 Canary 调整、回滚及刷新后状态、Member 页面权限限制。

明确属于 API 验收：管理员配置成员角色、服务端拒绝修改 Published 内容、通过 Job API 创建并等待两个实验任务完成、Member 发布请求返回 403。认证通过真实注册和登录页面获得，未注入伪造 Session，未禁用 Better Auth、RBAC、RLS、独立审批或 Evaluation Gate。

两个实验单位在本次确定性分组中均进入 control；样本量为 2，页面正确标记 `insufficient_sample=true`。两个任务均 completed，成功率 1，P50 约 2396 ms、P95 约 2433 ms，Mock 成本 0。在线 quality / tool accuracy 为 null；离线两个版本均使用完整 6 用例评测，Gate 通过。该结果证明指标链路，不证明模型能力、两组统计差异或因果提升。

## 环境与清理

仓库没有根 README；已阅读 `apps/web/README.md`、Day 12 文档、根及服务 package.json、Vitest 配置和现有隔离数据库 fixture。既有 Web :3551 与 Business API :8080 健康请求均返回 200，PostgreSQL :5432 可连接。未重启既有服务。

测试复用现有数据库 fixture，创建独立 Schema、临时 NOINHERIT/NOSUPERUSER/NOBYPASSRLS 登录角色和真实账号/租户。Web 使用 :3552 和 `.next-e2e`，Worker 使用同一隔离 Schema，Business API 使用 :8082 和独立服务密钥。测试结束关闭浏览器、停止三个测试进程、删除测试 Schema 及临时角色；不删除业务 Schema 的历史数据。Next.js 自动修改的 tsconfig 已恢复。

前期调试出现测试环境 search_path 配置、Ant Design 按钮/虚拟选项定位、限流等待、刷新后重新选择 Prompt 等脚本问题，相关失败证据保留于 `artifacts/day12-browser-attempt*/`。另有一次指标过早采样且服务密钥不匹配的运行，保留于 `artifacts/day12-browser-pre-terminal-metrics/`；最终运行使用独立 Business API 并强制等待任务 completed，Worker 无此错误。以上前期结果不作为最终通过证据。

## 证据与复跑

证据位于 gitignored `artifacts/day12-browser/`：

- `report.json`、`report.md`：逐项结果及分类计数。
- `01-authenticated.png`、`02-published.png`、`03-experiment.png`、`04-rollback.png`、`05-member.png`。
- `trace-0.zip`（Owner）、`trace-1.zip`（Admin）、`trace-2.zip`（Member）：包含操作、网络和截图；ZIP 完整性已验证。
- `experiment-metrics.json`、`web.log`、`worker.log`、`business-api.log`、`sha256.txt`。

复跑要求安装工作区依赖、本机 Google Chrome、可用的 `.env.test.local` / `TEST_DATABASE_URL`，以及业务 API 构建产物：

```bash
pnpm --filter @eap/business-api build
pnpm test:e2e:promptops
pnpm exec playwright show-trace artifacts/day12-browser/trace-0.zip
```

本次 Dashboard 浏览器验收可标记通过。Day 12 整体正式冻结仍需要当前提交的 GitHub Actions 通过；本次未触发或核验远程 CI，不能把浏览器结果替代该项。
