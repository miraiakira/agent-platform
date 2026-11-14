# Day 15：Harness 诊断、清理与低资源流程

本次范围仅为测试设施与操作文档；生产认证、RLS、RBAC、HITL、配额和生产安全门禁保持原有行为。

## Harness 报告

`load.ts` 的报告增加：

- `processes`：服务名称、受控启动命令与参数、PID、进程组、启动/退出时间、退出码、信号、日志/启动/停止错误、是否使用 SIGKILL。
- `samples[].processes`：PID/PPID、可执行文件名、所属服务及 CPU/RSS。数据库采样失败时仍保留已取得的进程快照。
- `connection_targets`、`diagnostic_errors`：固定服务目标和脱敏的 code/syscall/address/port，以及有界的嵌套 cause；不保存任意 message、stack、URL、密码或环境变量。
- `ports_before_start`、`ports_after_cleanup`：仅检查专用 3554/8084 端口；已有占用时拒绝启动，不按端口杀死未知服务。
- `cleanup`、`cleanup_steps`：逐项记录采样停止、每个服务进程组退出、数据库关闭、端口释放、临时文件清理的状态、耗时与脱敏错误。

阶段区分 Fixture 初始化、端口预检、服务启动、真实认证、数据准备、评测门禁、数据库初始采样、k6、k6 汇总、Web 恢复、队列排空和数据库对账。不会再把整个收尾过程笼统标为 k6。

仅对 Harness 自己创建的进程组发送信号。正常清理先 SIGTERM，再按有限等待尝试 SIGKILL；退出兜底不等于已证明完整清理。中断时负载生成器/容器清理标为 NOT VERIFIED，整体 FAIL，不自动重跑或重启数据库。

## 数据库 Fixture 清理

测试池增加 5 秒连接/客户端查询超时。清理步骤使用独立错误收集，前一个失败后仍尝试剩余步骤，并以 AggregateError 返回失败及嵌套步骤。

每个普通清理步骤默认 5 秒；嵌套数据库关闭使用更长、明确的等待窗口。超时只表示等待失败，不能取消任意底层操作，也不承诺整个进程已退出。任何超时均保持 FAIL。

这些设置仅用于测试 Fixture，不调整生产连接池。

## 容量流程遇错停止

`capacity.ts` 仅在当前档位同时满足以下条件时继续：

1. 子命令退出码为 0。
2. 本轮报告为 PASS，且显式 `cleanup=PASS`。
3. 报告时间不早于本次档位启动，源码指纹与 Git revision 匹配。

启动失败、报告缺失/损坏/陈旧、清理失败或任何档位失败，都会停止后续档位；剩余项目标为 `NOT RUN / PREVIOUS_PROFILE_FAILED`。不读取后续档位的旧报告来补齐结果，不把未运行项目写为 PASS。

## 独立低资源流程

详细前置条件见 [低资源说明](day14-low-resource.md)。

- `pnpm load:low-resource` / `pnpm load:low-resource:plan`：只读配置预检，无网络，无服务启动，始终 NOT VERIFIED。
- `pnpm load:low-resource:run`：必须另行授权，且有独立的执行授权标记及环境就绪确认；缺少任何条件均不发送请求。
- 最多 5 个串行请求、总检查窗口 10 秒、单次 1.5 秒、间隔 2 秒、响应上限 64 KiB、无自动重试。
- 不启动 k6、Docker、Web 或 Worker，不构建、不安装、不准备数据，不覆盖 Stress 报告。
- 单独提供 `fixture:low-resource:worker` 测试入口，须另行授权；只运行单并发 Agent，无工具注册、无 Evaluation/Knowledge 循环，30 秒后停止领取。它不由 HTTP 检查自动启动，生产入口不变。
- 不设整机 CPU/RSS 硬限制；已有服务的请求处理与任务执行仍会消耗资源。

低资源流程仅验证已有隔离 Fixture 的连通与业务流程，不替代 Stress、容量、生产 SLO 或冻结证据。

## 当前验证边界

已增加脱敏、清理继续执行、清理超时和容量证据有效性的回归用例；尚未运行测试。仅允许静态检查，不启动任何验证环境。

2026-11-15 已完成且通过以下静态检查：

```sh
pnpm --filter @eap/persistence exec tsc --noEmit
pnpm --filter @eap/persistence exec tsc --noEmit -p tsconfig.reliability.json
```

尚未运行新增单元测试、计划命令、Fixture Worker 或实际 HTTP 流程；这些运行结果均为 NOT VERIFIED。没有改写历史 Stress 报告。

获得执行授权后，先执行纯逻辑单元测试，再核对隔离环境配置、Mock、单 Worker 并发和无额外后台工作，最后仅执行一次低资源流程。出现失败或未知提交立即停止；不自动进入 Smoke/Stress，不自动重试。
