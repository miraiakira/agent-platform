# security-incident

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

越权、伪造引用、敏感日志、未授权工具执行或安全 Hard Failure。

## Detection

SecurityHardFailure、不可变审计、RLS/ACL 拒绝和安全团队告警。

## Severity

SEV1。

## Immediate Mitigation

停止扩流，通过现有工具 Policy 禁用相关工具；必要时使用 Prompt Emergency Revocation、撤销 ACL/删除 Memory。不要删除审计、关闭认证或放宽评分。

## Recovery Procedure

确认受影响 Tenant/User/Version，保全受限证据。恢复时必须重新检查 Prompt Hash、当前授权、Memory/Delete 与 Tool Ledger；普通回滚不能解除 Revocation。修复后运行 pnpm reliability:test、pnpm reliability:check、pnpm reliability:browser。

## Verification

恢复仍 Fail Closed；跨租户/用户读取被拒绝；无效引用不进入 SSE；未执行操作被撤销阻断，未知效果进入对账。

## Escalation

立即联系安全负责人、数据所有者和事件指挥；对外沟通由授权负责人负责。

## Postmortem Checklist

时间线、权限边界、暴露范围、Secret 轮换、审计完整性、根因、修复与新回归。

