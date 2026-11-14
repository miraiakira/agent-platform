# backup-restore

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

备份失败/缺失、备份超龄、恢复验证失败或数据疑似损坏。

## Detection

BackupFailureOrMissingEvidence、备份 Manifest、恢复报告和数据库平台告警。

## Severity

缺少可恢复备份 SEV1；单次备份失败但仍有合格副本 SEV2。

## Immediate Mitigation

禁止覆盖现有库；保留最新加密备份和独立密钥；停止删除旧备份，核对离线/异地副本。

## Recovery Procedure

从可信 Secret Store 配置 BACKUP_DATABASE_URL / BACKUP_DIRECTORY / BACKUP_ENCRYPTION_KEY，并提供 pg_dump 客户端，执行 pnpm backup:create。远端生产源须 BACKUP_PRODUCTION_AUTHORIZED=true 和 verify-full TLS。pnpm backup:restore-test 仅演练自建 fixture，在全新随机数据库执行 pg_restore 并清理。真实备份恢复也须在全新隔离库执行 pg_restore，完成审查后才安排切换；不得使用 --clean 覆盖在线库。

## Verification

认证解密、全表数据摘要、迁移、pgvector、RLS/FORCE RLS、租户隔离和应用 Smoke 均通过；记录实际恢复耗时。pnpm backup:retention 只列出到期文件，不自动删除；人工确认异地副本、恢复与法定保留后才能批准清理。

## Escalation

DBA、数据所有者、安全负责人共同批准真实恢复与切换。

## Postmortem Checklist

备份年龄/快照时间、密钥可用性、异地副本、实际 RPO/RTO、最后恢复验证和保留策略。分钟级 RPO 需要单独的 WAL Archiving/PITR 方案。

