# Day 14 低负载流程检查

`pnpm load:low-resource` 是独立的 HTTP 流程检查，不调用现有负载 Harness。
实际网络流程尚未执行，运行需要另行授权。静态类型检查不代表流程验证通过。

默认 `pnpm load:low-resource` 现在只输出计划，不发送 HTTP。
`pnpm load:low-resource:plan` 为同一只读预检入口；
实际运行使用单独的 `pnpm load:low-resource:run`。

## 资源边界

- 单进程、请求串行，最多 5 次；前一个请求结束后至少等待 2 秒。
- 网络检查窗口为 10 秒，单次请求最多 1.5 秒，并受剩余窗口限制。
- 响应最多缓冲 64 KiB；无重试、重定向、SSE 或持续轮询。
- 不启动服务、Worker、Docker，不安装、构建、迁移或准备数据。
- 不写入报告文件；脱敏 JSON 报告仅输出到终端，不覆盖 Stress 证据。
- 计时依赖事件循环和网络取消，不承诺绝对进程退出时间。
- **不设置 CPU 硬限制。** 已有服务处理请求仍会消耗 CPU，不能保证风扇不加速。

## 前置条件

只能使用已由操作者准备好的专用测试环境，地址固定为
`http://127.0.0.1:3554`，不得指向业务数据库。
缺少环境时退出，不自动启动或修复。

操作者须确认：模型与 Embedding 使用 Mock、Agent 并发为 1、
没有额外 Evaluation/Knowledge 后台工作或其他压测，并已有以下数据：

- 一个有执行权限的测试用户及有效 Session。
- 一个测试租户、可用的 risk-agent Prompt 和必要策略。
- 一个已完成入库的小知识文档，包含可检索的 `refund policy` 内容。
- 已运行的专用 Web、Agent Worker 及所需依赖；不在本命令中启动。

当前默认 Worker 入口同时启动 Evaluation、Knowledge 和 Agent 循环；
本脚本不会改变这个行为。若尚无满足上述条件的环境，请勿启动本检查。
Prompt/工具策略应禁止该测试请求产生外部业务效果；用户提示本身不构成安全边界。

新增的 `pnpm fixture:low-resource:worker` 是另行授权后可用的测试入口，**本次未启动**。
它只运行 Agent 循环，并发 1、轮询 1 秒、连接池最多 2 个连接、SQL 超时 2 秒，
Mock Provider 不注册任何工具，因此不依赖提示词来防止业务效果。
仍执行真实受限身份、Job 授权、Prompt Pin 和 Knowledge/Memory 复核。

该入口要求显式 `LLM_PROVIDER=mock`、`EMBEDDING_PROVIDER=mock`，以及指向
`127.0.0.1:5544/eap_test`（或 localhost）的受限 `DATABASE_URL`；
当前 Schema 必须为 `integration_<32位十六进制>`。
不得使用管理员测试 URL作为运行身份，不自动建库、迁移或准备账号/知识。
需要独立的测试 Web；无需为这个无工具流程启动 Go API。
它最长领取任务窗口为 30 秒，随后停止并尝试清理，不承诺绝对进程退出总时间。
环境准备好且获得授权后，在一个终端启动该 Worker，再立即在另一终端执行一次检查；
已有默认 Worker 必须事先由操作者停止，避免并行领取。

配置通过环境变量提供，不自动读取 `.env.day14.local`：

| 变量 | 内容 |
|---|---|
| `LOW_RESOURCE_BASE_URL` | `http://127.0.0.1:3554` |
| `LOW_RESOURCE_TENANT_ID` | 专用测试租户 UUID |
| `LOW_RESOURCE_KNOWLEDGE_BASE_ID` | 已入库知识库 UUID |
| `LOW_RESOURCE_COOKIE` | 测试 Session 的 Cookie 请求头；视为 Secret |
| `LOW_RESOURCE_FIXTURE_READY` | 完成上述核对后显式设为 `true` |
| `LOW_RESOURCE_EXECUTION_APPROVED` | 仅在本次执行获得另行授权后设为 `true` |

两个标记分别表示环境已核对与执行已授权，不能相互替代。
它们是操作者声明，不是对服务端配置或聊天授权的自动证明；脚本不会自动设置它们。
不要把 Cookie 粘贴到聊天、Git、文档或共享终端记录。

## 执行及结果

先使用 `pnpm load:low-resource:plan` 查看配置检查结果和资源边界。
预检即使成功也始终输出 `NOT VERIFIED`，不作为网络验证 PASS。

仅在另行批准运行后，在仓库根目录执行 `pnpm load:low-resource:run`。
顺序为：健康检查 → 提交一个 Job → 查询状态 → 一次检索 → 最终状态查询。
请求慢时可能无法在窗口内完成五步，会提前结束并报告实际进度。

- `PASS`／退出码 0：五步完成、Job 已完成、检索有结果。
- `FAIL`／退出码 1：HTTP、响应结构或 Job 终态等明确失败。
- `NOT VERIFIED`／退出码 2：配置不满足、请求超时、窗口耗尽或 Job 尚未完成。

提交会在测试环境产生一个真实 Job。脚本退出不会取消已接收的 Job，
也不会关闭已有服务；任务可能继续运行，需要操作者根据输出的 Run ID 跟进。
不自动重试未知提交，避免重复创建任务。
JSON 中的 `submission_state=ATTEMPTED_UNCONFIRMED`、`accepted=null` 表示提交可能已被接受；
收到 202 后即记录 `ACCEPTED`，即使后续响应解析失败也不会错误地声称未提交。

本报告只用于低负载流程检查，不能代替 Stress、容量、生产 SLO 或冻结证据。

Harness 的进程、连接与清理诊断，以及容量遇错停止规则见
[Day 15 测试设施说明](day15-harness-diagnostics.md)。
