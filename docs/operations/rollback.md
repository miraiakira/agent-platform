# rollback

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

新版本造成错误、性能退化或安全门禁失败。

## Detection

质量/安全 Gate、SLO Burn、容量与错误率、版本对照。

## Severity

按影响分级；安全违规为 SEV1。

## Immediate Mitigation

停止扩大流量；保留旧 Stable 和已绑定 Job。若版本有严重风险，独立撤销而不是只做普通回滚。

## Recovery Procedure

在 /prompts 由有发布权限的管理员填写原因并确认 Rollback，使用当前 revision；新任务回到 Stable，已有 Job 保持 Pin。代码/数据库回滚须经过兼容性审查：010 是增量迁移，运行时发布回滚不自动删除数据库对象。禁止把代码回滚等同于数据恢复。

## Verification

重复回滚幂等、旧 Job Pin 不变、撤销不可被解除、审计写入成功、Baseline 与 pnpm check 通过。

## Escalation

发布负责人、DBA、安全负责人共同处理破坏性迁移或失效 Stable。

## Postmortem Checklist

版本/代码修订、门禁证据、批准人、原因、受影响请求、数据兼容性和后续行动。

