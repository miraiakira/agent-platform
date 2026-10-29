"use client";

import {
  Button,
  Card,
  Input,
  Space,
  Tag,
  Typography,
  message,
} from "antd";
import { useRef, useState } from "react";

import {
  readSSE,
  type ChatStreamEvent,
} from "@/lib/sse";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type TokenUsage = Extract<
  ChatStreamEvent,
  { type: "usage" }
>["usage"];

export function ChatPanel({
  endpoint = "/api/chat/stream",
}: {
  endpoint?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [status, setStatus] = useState("Ready");
  const [toolActivities, setToolActivities] = useState<
    Array<{
      id: string;
      name: string;
      status: "running" | "success" | "error";
    }>
  >([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [modelIteration, setModelIteration] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  async function sendMessage() {
    setTraceId(null);
    setModelIteration(0);
    const content = input.trim();

    if (!content || loading) return;

    const previousMessages = messages;

    const nextMessages: ChatMessage[] = [
      ...previousMessages,
      { role: "user", content },
    ];

    // Create a placeholder for streaming text.
    setMessages([
      ...nextMessages,
      { role: "assistant", content: "" },
    ]);

    setInput("");
    setUsage(null);
    setLoading(true);
    setStatus("Generating");

    const controller = new AbortController();
    controllerRef.current = controller;

    let receivedText = "";
    let completed = false;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: nextMessages,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(
          `Stream request failed: ${response.status}`,
        );
      }

      for await (const event of readSSE(response.body)) {
        if (controller.signal.aborted) break;

        switch (event.type) {
          case "text-delta":
            receivedText += event.text;

            setMessages([
              ...nextMessages,
              {
                role: "assistant",
                content: receivedText,
              },
            ]);
            break;

          case "usage":
            setUsage(event.usage);
            break;

          case "done":
            completed = true;
            setStatus("Completed");
            break;

          case "tool-start":
            setToolActivities((previous) => [
              ...previous,
              {
                id: event.toolCallId,
                name: event.toolName,
                status: "running",
              },
            ]);
            break;

          case "tool-result":
            setToolActivities((previous) =>
              previous.map((activity) =>
                activity.id === event.toolCallId
                  ? {
                      ...activity,
                      status: event.success
                        ? "success"
                        : "error",
                    }
                  : activity,
              ),
            );
            break;
          
          case "run-start":
            setTraceId(event.traceId);
            break;

          case "model-start":
            setModelIteration(event.iteration);
            break;

          case "trace":
            setTraceId(event.traceId);
            break;

          case "error":
            throw new Error(
              `${event.code}: ${event.message}`,
            );
        }

        if (completed) break;
      }

      if (!completed && !controller.signal.aborted) {
        throw new Error("Stream ended without done event");
      }
    } catch (error) {
      if (controller.signal.aborted) {
        setStatus("Cancelled");
        messageApi.info("Generation stopped");
      } else {
        setStatus("Failed");
        messageApi.error(
          error instanceof Error
            ? error.message
            : "Streaming failed",
        );
      }
    } finally {
      if (!completed) {
        if (receivedText) {
          // Preserve partial output but do not reuse it as
          // completed conversation context.
          setMessages(previousMessages);
          setInput(content);
        } else {
          setMessages(previousMessages);
          setInput(content);
        }
      }

      controllerRef.current = null;
      setLoading(false);
      setToolActivities([]);
    }
  }

  const isAgentMode = endpoint === "/api/agent/stream";

  return (
    <Card
      title="AI Chat · Streaming"
      extra={
        <Tag color={loading ? "processing" : "default"}>
          {status}
        </Tag>
      }
    >
      {contextHolder}

      <div className="mb-4 flex min-h-80 flex-col gap-3">
        {messages.length === 0 && (
          <Typography.Text type="secondary">
            Ask your AI assistant a question.
          </Typography.Text>
        )}
        {toolActivities.length > 0 && (
          <div className="mb-4 space-y-2">
            {toolActivities.map((activity) => (
              <div
                key={activity.id}
                className="flex items-center gap-2 rounded-lg bg-slate-50 p-3"
              >
                <span className="text-sm font-medium">
                  {activity.name}
                </span>

                <Tag
                  color={
                    activity.status === "success"
                      ? "success"
                      : activity.status === "error"
                        ? "error"
                        : "processing"
                  }
                >
                  {activity.status}
                </Tag>
              </div>
            ))}
          </div>
        )}
        {isAgentMode && traceId && (
          <div className="mb-3 flex gap-3 text-xs text-slate-500">
            <span>Trace: {traceId.slice(0, 8)}</span>
            <span>Model iteration: {modelIteration}</span>
          </div>
        )}
        {messages.map((item, index) => (
          <div
            key={index}
            className={
              item.role === "user"
                ? "self-end rounded-lg bg-blue-50 p-3"
                : "self-start rounded-lg bg-gray-100 p-3"
            }
          >
            <Typography.Text strong>
              {item.role === "user" ? "You" : "Assistant"}
            </Typography.Text>

            <div className="mt-1 whitespace-pre-wrap">
              {item.content ||
                (loading ? "Thinking..." : "")}
            </div>
          </div>
        ))}
      </div>

      {usage && (
        <Typography.Text type="secondary">
          Input: {usage.inputTokens} · Output:{" "}
          {usage.outputTokens} · Total:{" "}
          {usage.totalTokens}
        </Typography.Text>
      )}

      <Space.Compact className="mt-4 w-full">
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={() => void sendMessage()}
          placeholder="Ask something..."
          disabled={loading}
          maxLength={8000}
        />

        {loading ? (
          <Button
            danger
            onClick={() => controllerRef.current?.abort()}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="primary"
            onClick={() => void sendMessage()}
            disabled={!input.trim()}
          >
            Send
          </Button>
        )}
      </Space.Compact>
    </Card>
  );
}