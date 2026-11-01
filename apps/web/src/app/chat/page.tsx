import { ChatPanel } from "@/components/chat-panel";
import { PageHeading } from "@/components/ui/page-heading";
export default function ChatPage() {
  return <main className="conversation-page"><PageHeading eyebrow="AI ASSISTANT" title="AI 对话" description="一个专注思考的空间，帮助你整理信息、理解问题和形成想法。"/><ChatPanel/></main>;
}
