"use client";

import { Alert, Button, Input, Select, Tag, Typography, message } from "antd";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { Icon } from "./ui/icon";
import { friendlyError, responseError } from "@/lib/ui-errors";
import { subscribeRun } from "@/lib/async-agent-client";

import {
  readSSE,
  type ChatStreamEvent,
} from "@/lib/sse";

class StreamFailure extends Error {
  constructor(readonly code: string, text: string) { super(`${code}: ${text}`); }
}

const statusLabels: Record<string, string> = { Ready: "准备就绪", Generating: "正在分析", Queued: "等待执行", Completed: "已完成", Failed: "执行失败", Cancelled: "已取消", Cancelling: "正在取消" };

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
  const { session, sessionPending, tenant, canExecute, tenantsPending } = useWorkspace();
  const [failure, setFailure] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [lastMode, setLastMode] = useState<"stream" | "async" | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followOutput = useRef(true);
  const [mode, setMode] = useState<"stream" | "async">("stream");
  const conversationRef = useRef<string | undefined>(undefined);
  const runRef = useRef<string | undefined>(undefined);
  const pendingSubmissionRef = useRef<{ key: string; body: string } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [cost, setCost] = useState<{ usd: number | null; coverage: string } | null>(null);
  const [status, setStatus] = useState("Ready");
  const [toolActivities, setToolActivities] = useState<
    Array<{
      id: string;
      name: string;
      status: "running" | "success" | "error" | "interrupted";
    }>
  >([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [modelIteration, setModelIteration] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (scrollRef.current && followOutput.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, toolActivities]);

  async function sendMessage() {
    const content = input.trim();

    if (!content || loading || !session || !tenant || !canExecute) return;
    setTraceId(null);
    setModelIteration(0);
    setLastRunId(null);
    setLastMode(mode);
    setFailure("");
    setToolActivities([]);
    followOutput.current = true;

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
    setCost(null);
    setLoading(true);
    setStatus("Generating");

    const controller = new AbortController();
    controllerRef.current = controller;

    let receivedText = "";
    let completed = false;

    try {
      let events: AsyncIterable<ChatStreamEvent>;
      if (mode === "async" && endpoint === "/api/agent/stream") {
        const body = JSON.stringify({ conversationId: conversationRef.current, messages: nextMessages });
        if (pendingSubmissionRef.current?.body !== body) {
          pendingSubmissionRef.current = { key: crypto.randomUUID(), body };
        }
        const requestKey = pendingSubmissionRef.current.key;
        const submit = () => fetch("/api/agent/jobs", {
          method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey },
          body, signal: controller.signal,
        });
        let response: Response;
        try { response = await submit(); } catch (error) {
          if (controller.signal.aborted) throw error;
          response = await submit();
        }
        if (!response.ok) throw new Error(await responseError(response));
        const job = await response.json();
        pendingSubmissionRef.current = null;
        conversationRef.current = job.conversationId;
        runRef.current = job.runId;
        setLastRunId(job.runId);
        setStatus("Queued");
        events = subscribeRun(job.eventsUrl, controller.signal);
      } else {
        const response = await fetch(endpoint, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextMessages }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(await responseError(response));
        if (!response.body) throw new Error("暂时无法读取回复，请重试。");
        events = readSSE(response.body);
      }

      for await (const event of events) {
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
            setStatus("Generating");
            setTraceId(event.traceId);
            break;

          case "model-start":
            setModelIteration(event.iteration);
            break;

          case "trace":
            setTraceId(event.traceId);
            setUsage(event.usage);
            setCost(event.cost ?? null);
            break;

          case "error":
            throw new StreamFailure(event.code, event.message);
        }

        if (completed) break;
      }

      if (!completed && !controller.signal.aborted) {
        throw new Error("Stream ended without done event");
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof StreamFailure && error.code === "CANCELLED")) {
        setStatus("Cancelled");
        messageApi.info("任务已停止");
      } else {
        setStatus("Failed");
        const reason = friendlyError(error, "回复未完成，请稍后重试。");
        setFailure(reason);
        messageApi.error(reason);
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

      runRef.current = undefined;
      controllerRef.current = null;
      setLoading(false);
      setCancelling(false);
      if (!completed) setToolActivities(previous => previous.map(activity => activity.status === "running" ? { ...activity, status: "interrupted" } : activity));
    }
  }

  const isAgentMode = endpoint === "/api/agent/stream";
  const ready = !!session && !!tenant && canExecute && !sessionPending && !tenantsPending;
  const prompts = isAgentMode ? ["查询今天风险最高的 3 笔交易", "分析今天高风险交易的风险原因", "汇总高风险交易，并说明判断依据"] : ["帮我梳理一份清晰的工作计划", "如何更有条理地分析一个复杂问题？", "帮我把一段文字整理成简明摘要"];
  const statusClass = loading ? "status-processing" : status === "Completed" ? "status-success" : status === "Failed" ? "status-error" : "status-neutral";
  return <div className={`conversation-layout ${isAgentMode ? "with-inspector" : ""}`}>
    {contextHolder}
    <section className="surface chat-workspace" aria-label={isAgentMode ? "Agent 分析会话" : "AI 对话会话"}>
      <div className="chat-toolbar"><div className="chat-toolbar-title"><span className="chat-toolbar-icon"><Icon name={isAgentMode ? "agent" : "chat"} size={18}/></span><strong>{isAgentMode ? "业务分析会话" : "与 AI 对话"}</strong><span className={`status-pill ${statusClass}`} role="status"><span/>{statusLabels[status] ?? status}</span></div><Button type="text" size="small" icon={<Icon name="plus" size={16}/>} disabled={loading || messages.length === 0} onClick={() => {
        setMessages([]); setInput(""); setFailure(""); setUsage(null); setCost(null); setToolActivities([]); setTraceId(null); setLastRunId(null); setLastMode(null); setModelIteration(0); setStatus("Ready"); conversationRef.current = undefined; pendingSubmissionRef.current = null;
      }}>新会话</Button></div>
      {isAgentMode && <div className="execution-mode-row"><label id="execution-mode-label">执行方式</label><Select aria-labelledby="execution-mode-label" aria-label="Execution mode" value={mode} disabled={loading} onChange={setMode} options={[{ value: "stream", label: "实时执行 · Stream" }, { value: "async", label: "后台任务 · Async" }]} className="execution-mode-select"/><span>{mode === "async" ? "任务在后台执行，断开连接不会自动取消。" : "实时接收分析与工具执行结果。"}</span></div>}
      {!ready && !sessionPending && !tenantsPending && <div className="chat-access-note"><Icon name="lock" size={17}/><span>{!session ? "登录后开始与你的 AI 助手交流。" : !tenant ? "先选择一个组织，再开始你的会话。" : "当前角色为只读成员，执行任务需要更多权限。"}</span><Link href={!session ? "/login" : "/security"}>{!session ? "前往登录" : "组织与权限"}<Icon name="arrow" size={14}/></Link></div>}
      <div className="chat-messages" ref={scrollRef} aria-label="会话消息" aria-busy={loading} onScroll={() => { const element = scrollRef.current; if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {messages.length === 0 ? <div className="chat-empty"><span className="chat-empty-mark"><Icon name={isAgentMode ? "agent" : "chat"} size={35}/></span><span className="eyebrow">{isAgentMode ? "FROM QUESTION TO INSIGHT" : "A LITTLE SPACE TO THINK"}</span><h2>{isAgentMode ? "今天，想了解哪些风险？" : "有什么想一起思考的？"}</h2><p>{isAgentMode ? "提出你的问题，Agent 会结合业务工具开展分析。" : "写下一个问题，或从下面的灵感开始。"}</p><div className="suggestion-list">{prompts.map(prompt => <button type="button" key={prompt} disabled={!ready} onClick={() => setInput(prompt)}><span>{prompt}</span><Icon name="arrow" size={15}/></button>)}</div></div> : <div className="message-list">{messages.map((item, index) => <article key={index} className={`message-row message-${item.role}`}><span className={`message-avatar ${item.role === "user" ? "message-avatar-user" : ""}`}>{item.role === "user" ? (session?.user.name || "你").slice(0, 1).toUpperCase() : <Icon name="agent" size={17}/>}</span><div className="message-content"><span className="message-author">{item.role === "user" ? "你" : isAgentMode ? "风控 Agent" : "AI 助手"}</span><div className="message-bubble">{item.content || (loading ? <span className="thinking-indicator"><i/><i/><i/><span>{status === "Queued" ? "等待后台执行…" : "正在思考…"}</span></span> : "")}</div></div></article>)}</div>}
      </div>
      {failure && <div className="chat-error"><Alert showIcon type="error" title="本次回复未完成" description={failure} closable onClose={() => setFailure("")}/></div>}
      <div className="composer"><Input.TextArea aria-label="消息内容" value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder={!session ? "登录后开始对话" : !tenant ? "选择组织后开始对话" : isAgentMode ? "描述你想查询的交易或风险问题…" : "输入你的问题…"} disabled={loading || !ready} maxLength={8000} autoSize={{ minRows: 2, maxRows: 6 }} variant="borderless"/><div className="composer-bottom"><span>{loading ? status === "Queued" ? "等待任务执行，请确认 Worker 已启动。" : "正在接收回复…" : "Enter 发送 · Shift + Enter 换行"}</span><div className="composer-actions"><small>{input.length > 0 ? `${input.length.toLocaleString()} / 8,000` : ""}</small>{loading ? <Button danger loading={cancelling} icon={<Icon name="stop" size={15}/>} onClick={async () => {
        const runId = runRef.current;
        if (mode === "async" && runId) {
          setCancelling(true);
          try { const response = await fetch(`/api/agent/runs/${runId}/cancel`, { method: "POST" }); if (!response.ok) throw new Error(await responseError(response)); if (runRef.current === runId) setStatus("Cancelling"); }
          catch (error) { if (runRef.current === runId) { setCancelling(false); messageApi.error(friendlyError(error, "暂时无法取消任务，请稍后重试。")); } }
        } else controllerRef.current?.abort();
      }}>停止</Button> : <Button type="primary" icon={<Icon name="send" size={17}/>} onClick={() => void sendMessage()} disabled={!input.trim() || !ready}>发送</Button>}</div></div></div>
      <div className="chat-disclaimer"><Icon name="shield" size={12}/><span>AI 的回答可能不完整，请结合业务依据判断。</span></div>
      {!isAgentMode && usage && <div className="chat-usage-inline"><span>输入 {usage.inputTokens.toLocaleString()}</span><span>输出 {usage.outputTokens.toLocaleString()}</span><span>总计 {usage.totalTokens.toLocaleString()} Tokens</span></div>}
    </section>
    {isAgentMode && <aside className="execution-inspector" aria-label="执行详情"><section className="surface inspector-section"><div className="section-heading"><h2>执行概览</h2><Icon name="activity" size={17}/></div><div className="inspector-row"><span>任务状态</span><strong className={`inspector-status ${statusClass}`}>{statusLabels[status] ?? status}</strong></div><div className="inspector-row"><span>执行方式</span><strong>{(lastMode ?? mode) === "async" ? "后台任务" : "实时执行"}</strong></div><div className="inspector-row"><span>模型调用</span><strong>{modelIteration > 0 ? `${modelIteration} 次` : "—"}</strong></div>{lastRunId && <div className="inspector-identifier"><span>Run ID</span><Typography.Text copyable={{ text: lastRunId }}>{lastRunId}</Typography.Text></div>}{traceId && <div className="inspector-identifier"><span>Trace ID</span><Typography.Text copyable={{ text: traceId }}>{traceId}</Typography.Text></div>}</section><section className="surface inspector-section"><div className="section-heading"><h2>工具活动</h2><span className="count-badge">{toolActivities.length}</span></div>{toolActivities.length === 0 ? <div className="inspector-empty"><Icon name="shield" size={23}/><p>工具执行后，过程将在这里展示。</p></div> : <div className="tool-activity-list">{toolActivities.map(activity => <div className="tool-activity" key={activity.id}><span className={`tool-dot tool-dot-${activity.status}`}/><div><strong>{activity.name === "get_high_risk_transactions" ? "高风险交易查询" : activity.name}</strong><Tag color={activity.status === "success" ? "success" : activity.status === "error" ? "error" : activity.status === "running" ? "processing" : "default"}>{({ running: "执行中", success: "已完成", error: "执行失败", interrupted: "结果未确认" })[activity.status]}</Tag></div></div>)}</div>}</section><section className="surface inspector-section"><div className="section-heading"><h2>用量与成本</h2><span className="quiet-small">TOKENS</span></div><div className="inspector-row"><span>输入</span><strong>{usage ? usage.inputTokens.toLocaleString() : "—"}</strong></div><div className="inspector-row"><span>输出</span><strong>{usage ? usage.outputTokens.toLocaleString() : "—"}</strong></div><div className="inspector-row usage-total"><span>Token 总计</span><strong>{usage ? usage.totalTokens.toLocaleString() : "—"}</strong></div><div className="cost-summary"><span>估算模型成本</span><strong>{cost?.usd != null ? `$${cost.usd.toFixed(6)}` : "未提供"}</strong>{cost && cost.coverage !== "reported" && <small>仅基于已报告用量，统计可能不完整。</small>}</div></section><p className="inspector-footnote"><Icon name="lock" size={13}/>工具执行前会重新检查组织与角色权限。</p></aside>}
  </div>;
}
