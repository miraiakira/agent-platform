/** This project has no identity/ownership system. Async endpoints are local-development only. */
export function asyncAgentAccess(request: Request): Response | null {
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_ASYNC_AGENT_DEV !== "true") {
    return Response.json({ error: "Async Agent API is restricted to controlled development environments" }, { status: 403 });
  }
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const host = url.hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host) || (origin && origin !== url.origin)) {
    return Response.json({ error: "Local same-origin access required" }, { status: 403 });
  }
  return null;
}

export function validRunId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
