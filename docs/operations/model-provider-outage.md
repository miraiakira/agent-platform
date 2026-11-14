# model-provider-outage

所有命令从仓库根目录执行。隔离测试使用 `.env.day14.local`；生产 Secret 不进入终端输出或 Git。

## Symptoms

模型 TIMEOUT、429、500/503、流中断或部分 Tool Call。

## Detection

模型请求/延迟、JobFailureSpike 和代码级错误分类；不可把输出为空视为成功。

## Severity

模型能力整体不可用 SEV2；异常输出造成授权风险 SEV1。

## Immediate Mitigation

暂停 Prompt 灰度；保留 Deadline 和有限重试，不自动切换为未批准模型或放宽质量门禁。

## Recovery Procedure

检查服务商状态、配额和受保护凭据。CLI 测试 pnpm reliability:test 使用可控 HTTP Fixture，无付费调用。需要更换模型时重新完成绑定评测、兼容 Baseline 和独立发布审批。

## Verification

429/500/503 均有明确失败；SDK 不无限重试；中断的部分调用不能执行工具；修复后 Gate 和实际受控请求通过。

## Escalation

模型平台负责人、采购/配额负责人；安全问题联系安全负责人。

## Postmortem Checklist

服务商故障窗口、实际用量/费用、重试预算、Deadline、模型版本及降级审批。

