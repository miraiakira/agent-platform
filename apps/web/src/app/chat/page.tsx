import { ChatPanel } from "@/components/chat-panel";

export default function ChatPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">
        Enterprise AI Assistant
      </h1>

      <ChatPanel />
    </main>
  );
}