# queue-backlog

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

queued 数量/等待时间增长，入队返回 429 或 GLOBAL_CAPACITY_LIMIT 503。

## Detection

QueueBacklog、agent_jobs_queued、agent_queue_oldest_seconds、限流率和 Accepted/Completed Jobs per second。

## Severity

持续超 Deadline SEV2；多租户饥饿或任务丢失 SEV1。

## Immediate Mitigation

保留明确拒绝和 Retry-After；不要提高上限掩盖饱和。先确认 Worker、DB 与 Provider 的瓶颈。

## Recovery Procedure

使用证据支持的容量计划调整 AGENT_GLOBAL_ADMISSION_LIMIT / AGENT_TENANT_ADMISSION_LIMIT / AGENT_TENANT_QUEUE_LIMIT；Worker 每进程最多 8 slots，数据库 Agent 执行最多 64 且每租户最多 2。副本、Evaluation 和 Embedding 的总模型预算另行评审。隔离测量：pnpm load:capacity。

## Verification

多租户公平性测试通过；拒绝后没有 phantom Job；同一幂等请求返回原 Run；积压恢复、已接受任务都有可追溯状态。

## Escalation

应用当班、DBA 与模型平台负责人共同确认瓶颈后再扩容。

## Postmortem Checklist

RPS、有效入队/完成率、配额拒绝、各阶段队列等待、资源曲线、其他租户服务情况。

