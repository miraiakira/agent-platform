# database-outage

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

连接失败、Pool 等待、查询超时、Heartbeat 失败和 API 503。

## Detection

DBConnectionSaturation、postgres_pool_wait_seconds、数据库平台监控及安全脱敏日志。

## Severity

多租户不可用为 SEV1；单个池饱和为 SEV2。

## Immediate Mitigation

停止扩流，降低入队上限并滚动重启 Web 使配置生效；不要放开连接池或关闭 RLS；不要自动重放 unknown 工具。

## Recovery Procedure

由 DBA 检查主库、连接数、锁、磁盘和证书。恢复服务后先执行只读连通检查，再恢复 Worker。专用测试容器断连/重启和排队持久性演练：pnpm backup:restore-test。该命令只接受 5544 的 eap-day14 容器。

## Verification

新连接恢复、受限角色仍无 Owner/BYPASSRLS、queued Job 可处理、旧 Lease 被拒绝、数据和终态事件一致。

## Escalation

DBA、平台当班及应用负责人；复制/PITR/恢复决定必须由数据负责人批准。

## Postmortem Checklist

连接增长、最长事务、锁等待、池限制、Timeout、重启恢复耗时、RPO 和受影响请求。

