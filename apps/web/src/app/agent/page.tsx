import { ChatPanel } from "@/components/chat-panel";
import { PageHeading } from "@/components/ui/page-heading";
import { Icon } from "@/components/ui/icon";
export default function AgentPage() {
  return <main className="conversation-page"><PageHeading eyebrow="RISK ANALYSIS AGENT" title="风控分析 Agent" description="用自然语言查询风险交易，查看分析结果与工具执行过程。" extra={<span className="quiet-badge"><Icon name="shield" size={14}/>组织权限保护</span>}/><ChatPanel endpoint="/api/agent/stream"/></main>;
}
