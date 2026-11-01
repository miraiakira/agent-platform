import { AgentHistory } from "@/components/agent-history";
import { PageHeading } from "@/components/ui/page-heading";
import { Icon } from "@/components/ui/icon";
export default async function AgentPage({searchParams}:{searchParams:Promise<{run?:string|string[]}>}) {
  const query=await searchParams;const runId=typeof query.run==="string"?query.run:undefined;
  return <main className="conversation-page"><PageHeading eyebrow="RISK ANALYSIS AGENT" title="风控分析 Agent" description="用自然语言查询风险交易，查看分析结果与工具执行过程。" extra={<span className="quiet-badge"><Icon name="shield" size={14}/>组织权限保护</span>}/><AgentHistory runId={runId}/></main>;
}
