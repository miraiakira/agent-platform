# 核心业务功能验收

验收对象：登录与组织权限、知识上传与引用、Agent 任务与人工审批、租户隔离、记忆删除和 Prompt 回滚。

## 可重复执行

使用专用本机测试数据库（本地默认 `127.0.0.1:5544/eap_test`，配置见 `.env.day14.local`）；脚本各自建立随机 Schema 和受限登录身份，结束时清理。不要指向业务数据库。

```sh
pnpm reliability:browser
pnpm test:e2e:business
```

两个命令顺序执行，复用 `.next-e2e` 生成目录，不能并行。脚本仅启动自己的临时 Web、Go API 和 Mock Worker，不启动或迁移业务栈。

## 证据范围

| 要求 | 实际验证 | 证据目录 |
|---|---|---|
| 登录、创建组织、成员权限 | 页面注册/重新登录、创建组织、添加管理员和只读成员；只读成员无管理与发送权限 | `artifacts/business-browser/` |
| 文档 Ready 与引用 | 页面上传 Markdown、等待入库、Hybrid 检索并核对原文与引用 | `artifacts/day13-browser/` |
| Agent 与审批 | 页面提交 Async 任务、待审批暂停、高风险自批按钮禁用、独立管理员批准、回到聊天、刷新后结果与工具记录保留 | `artifacts/business-browser/` |
| 审计 | 真实 Session API 核对独立审批人、授权和工具结果事件，数据库核对一次成功工具执行；当前没有审计列表页面 | `artifacts/business-browser/audit.json` |
| 跨组织隔离 | 页面创建第二组织、历史列表不显示第一组织任务；真实 Session API 核对外组织 Run/Approval 404、任务/知识库/外组织文档列表为空、审计仅属于当前组织 | `artifacts/business-browser/` |
| 记忆删除 | 页面保存/忘记记忆，页面不再展示且真实 API 搜索为空 | `artifacts/day13-browser/` |
| Prompt 回滚 | 页面执行独立审批、Canary、实验、回滚，刷新后状态保留；Member 发布 API 被拒绝 | `artifacts/day12-browser/` |

每个目录包含 JSON 报告、截图与浏览器 Trace；Trace 可能包含测试 Session，应仅用于私有验收。`artifacts/day14/browser/report.json` 汇总既有 Knowledge/PromptOps 套件。

新增业务套件在任何失败/跳过时返回非零，不把未执行项当作通过；`report.json` 包含源码指纹和版本。已有 Knowledge/PromptOps 报告通过外层可靠性脚本绑定版本。

模型与 Embedding 使用 Mock；验证的是实际认证、授权、数据库、Worker、业务工具 HTTP 交互与页面流程，不代表真实模型质量、生产性能或生产上线批准。新增验收代码需要在新提交上重新获得 CI 结果，不能复用旧提交的 Actions 成功。

## 验收中修复的问题

- 工具策略列表中的表单使用独立名称，避免多个同名字段产生重复 DOM ID 和标签关联冲突。
- 已完成 Agent 任务重新打开时，从持久化 SSE 事件恢复工具活动。恢复按 Tool Call ID 去重，仅展示名称与状态；失败或未确认的工具保持对应状态，不重新提交任务或执行工具。
- 添加成功、失败及未确认工具恢复的单元测试，并由业务浏览器套件验证刷新后结果和工具记录仍在。

## 2026-11-14 本地记录

业务浏览器套件最终为 9 项页面场景、2 项 API 核对通过，0 失败、0 跳过；临时服务、Schema 和受限角色已清理。最终截图见 `artifacts/business-browser/06-persisted-result.png`，审计记录见同目录 `audit.json`。

完整 `pnpm reliability:check` 通过：356 项 TypeScript 测试、Go vet/test/build、Next.js Build、Risk 6 项与 RAG 7 项质量 Gate。Lint 为 0 error、2 个已有 warning。

基线提交为 `94902b89045dceb49c08a8e38c53b69c88f33b0a`，本次新增修复和验收代码尚未提交。最终源码指纹为 `e91289e3403a333464c52c6eea56edc9301660a4378b2bd082c6bc86ce3e195b`；业务验收与完整回归报告均匹配该指纹。

最终 Knowledge/PromptOps 复验同样通过，三个浏览器套件合计 **35 项页面场景、6 项 API 场景**，无失败或跳过。完整回归与两个浏览器汇总均匹配上述源码指纹；临时 Web、Go API、Worker、Schema 与角色全部清理。

四项需求的签收汇总为 `artifacts/functional-acceptance/summary.md` 和 `report.json`，结果 **PASS（本地隔离功能验收）**。截图与 Trace 保留在各证据目录；早期业务套件失败截图归档于 `artifacts/business-browser/previous-attempts/`，不混入最终通过计数。
