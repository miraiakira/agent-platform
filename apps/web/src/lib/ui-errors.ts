const labels: Record<string, string> = {
  UNAUTHENTICATED: "请先登录后继续操作。",
  TENANT_REQUIRED: "请先在顶部选择一个组织，或前往组织与权限创建组织。",
  FORBIDDEN: "当前账号没有此操作的权限，请联系组织管理员。",
  OWNER_REQUIRED: "只有组织所有者可以变更 Owner 角色。",
  LAST_OWNER: "组织至少需要保留一位有效的 Owner，无法完成此次修改。",
  RATE_LIMITED: "请求较频繁，请稍后重试。",
  CONCURRENT_RUN_LIMIT: "当前组织的运行任务已达上限，请等待任务结束后重试。",
  INVALID_ORIGIN: "请求来源不匹配，请使用配置的站点地址重新打开页面。",
  TOOL_FORBIDDEN: "当前工具未获授权，或需要人工审批。",
  MAX_MODEL_CALLS: "本次分析已达到模型调用上限，请简化问题后重试。",
  DEADLINE_EXCEEDED: "任务执行超时，请稍后重试或缩小查询范围。",
  LEASE_LOST: "任务执行权已失效，请查看任务状态后再决定是否重试。",
  WORKER_STOPPED: "后台执行服务已停止，本次任务未能完成。",
  APPROVAL_ALREADY_DECIDED: "此审批已被处理，请刷新列表。（409）",
  APPROVAL_EXPIRED: "此审批已过期，任务已终止。",
  SELF_APPROVAL_FORBIDDEN: "高风险操作需要其他所有者或管理员批准。",
  APPROVAL_POLICY_CHANGED: "工具策略已变更，此审批无法继续，请重新提交任务。",
  CHECKPOINT_MISMATCH: "恢复数据校验失败，已阻止执行。",
  NOT_FOUND: "资源不存在，或你没有访问权限。",
};
export function friendlyError(value: unknown, fallback = "操作未完成，请稍后重试。") {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const code = text.split(":", 1)[0];
  return labels[text] ?? (labels[code] ? `${labels[code]}（${code}）` : text || fallback);
}
export async function responseError(response: Response) {
  let body: { error?: string | { code?: string; message?: string } } = {};
  try { body = await response.json(); } catch { /* Non-JSON errors still retain the HTTP status. */ }
  const error = typeof body.error === "string" ? body.error : body.error?.code ?? body.error?.message;
  return friendlyError(error, response.status === 401 ? labels.UNAUTHENTICATED : response.status === 403 ? labels.FORBIDDEN : `请求失败（${response.status}），请稍后重试。`);
}
export async function requestJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}
