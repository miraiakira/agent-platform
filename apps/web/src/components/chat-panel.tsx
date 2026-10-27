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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type GenerateResult = {
  id: string;
  model: string;
  provider: string;
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastResult, setLastResult] =
    useState<GenerateResult | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  async function sendMessage() {
    const content = input.trim();

    if (!content || loading) return;

    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content },
    ];

    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: nextMessages,
        }),
        signal: controller.signal,
      });

      const data: unknown = await response.json();

      if (!response.ok) {
        throw new Error("Model request failed");
      }

      const result = data as GenerateResult;

      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: result.content,
        },
      ]);

      setLastResult(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      ) {
        messageApi.info("Request cancelled");
      } else {
        messageApi.error("Failed to generate response");
      }

      // 请求失败时保留之前的成功对话，
      // 恢复输入内容，避免重复提交失败的用户消息。
      setMessages(messages);
      setInput(content);
    } finally {
      controllerRef.current = null;
      setLoading(false);
    }
  }

  return (
    <Card
      title="AI Chat"
      extra={
        lastResult && (
          <Tag color="blue">
            {lastResult.provider} / {lastResult.model}
          </Tag>
        )
      }
    >
      {contextHolder}

      <div className="mb-4 flex min-h-80 flex-col gap-3">
        {messages.length === 0 && (
          <Typography.Text type="secondary">
            Ask your AI assistant a question.
          </Typography.Text>
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
              {item.content}
            </div>
          </div>
        ))}
      </div>

      {lastResult?.usage && (
        <Typography.Text type="secondary">
          Tokens: {lastResult.usage.totalTokens}
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