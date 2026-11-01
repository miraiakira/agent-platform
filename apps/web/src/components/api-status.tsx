"use client";
import { Alert, Button, Skeleton } from "antd";
import { useEffect, useState } from "react";
import { Icon } from "./ui/icon";
type HealthStatus = { status: "ok" | "error"; service: string };
async function fetchHealth(): Promise<HealthStatus> {
  try { const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(); return await response.json(); }
  catch { return { status: "error", service: "business-api" }; }
}
export function ApiStatus() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { let active = true; void fetchHealth().then(data => { if (active) { setHealth(data); setLoading(false); } }); return () => { active = false; }; }, []);
  const healthy = health?.status === "ok";
  return <div className="surface connection-card"><div className="section-heading"><h2>业务服务连接</h2><Button type="text" size="small" aria-label="重新检查业务服务" icon={<Icon name="refresh" size={16}/>} loading={loading} onClick={async () => { setLoading(true); setHealth(await fetchHealth()); setLoading(false); }}/></div><div className="connection-status"><span className={`connection-icon ${!loading && healthy ? "is-healthy" : ""}`}><Icon name="activity" size={23}/></span><div><h3>Business API</h3>{loading ? <Skeleton.Input active size="small" style={{ width: 96 }}/> : <span className={`status-pill ${healthy ? "status-success" : "status-error"}`}><span/>{healthy ? "连接正常" : "暂时不可用"}</span>}</div></div>{!loading && !healthy && <Alert type="warning" title="暂时无法连接业务服务，请稍后重试。"/>}<p className="connection-note">此状态仅表示业务 API 的可达性。模型与 Worker 的执行状态可在任务中查看。</p></div>;
}
