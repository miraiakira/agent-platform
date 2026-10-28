import { ChatPanel } from "@/components/chat-panel";

export default function AgentPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-2xl font-semibold">
        Risk Analysis Agent
      </h1>

      <p className="mb-6 text-slate-500">
        Enterprise Agent · Function Calling Demo
      </p>

      <ChatPanel endpoint="/api/agent/stream" />
    </main>
  );
}