# worker-crash

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

Worker 退出、Lease 过期、Job interrupted/blocked 或 Tool Ledger unknown。

## Detection

WorkerUnavailable、LeaseExpirationSpike、worker_fencing_rejections_total 与持久化 error 事件。

## Severity

SEV2；涉及未知外部副作用或安全检查异常升级为 SEV1。

## Immediate Mitigation

暂停扩流；保留 Job、Lease Token、Tool Ledger 和审计证据；不要直接把 blocked Job 改成 queued。

## Recovery Procedure

恢复受限 Worker 进程；它会领取正常 queued 任务并阻断过期未知任务。对 unknown 使用下游幂等键/状态查询或人工对账，再通过受控修复流程决定是否新建请求。本地演练：pnpm reliability:test。Worker 开发启动：pnpm --filter @eap/agent-worker dev。

## Verification

旧 Token finalize 必须失败；终态与最后的持久化事件一致；已确认效果不重复；不能确认的效果继续阻断。

## Escalation

联系当班应用负责人和业务工具所有者；不能确认外部效果时不得由值班人员盲目重试。

## Postmortem Checklist

退出原因、Drain 超时、资源限制、Lease 时序、外部效果、幂等覆盖、对账结论和修复测试。

