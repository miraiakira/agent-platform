"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { friendlyError, requestJson } from "@/lib/ui-errors";
export type Role = "owner" | "admin" | "member" | "viewer";
export type Tenant = { id: string; name: string; role: Role };
export const roleLabels: Record<Role, string> = { owner: "所有者", admin: "管理员", member: "成员", viewer: "只读成员" };
type AuthState = ReturnType<typeof authClient.useSession>;
type Workspace = {
  session: AuthState["data"]; sessionPending: boolean; sessionError: string;
  tenants: Tenant[]; tenant: Tenant | undefined; tenantsPending: boolean; tenantError: string;
  canExecute: boolean; canManage: boolean;
  selectTenant: (id: string) => void; refreshTenants: () => Promise<void>;
};
const WorkspaceContext = createContext<Workspace | null>(null);
export function persistTenant(id: string) {
  document.cookie = `eap_tenant=${id}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
function selectedTenant() { return document.cookie.match(/(?:^|;\s*)eap_tenant=([0-9a-f-]+)/)?.[1] ?? ""; }
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, error } = authClient.useSession();
  const userId = session?.user.id;
  const [state, setState] = useState<{ userId?: string; tenants: Tenant[]; selected: string; error: string }>({ tenants: [], selected: "", error: "" });
  useEffect(() => {
    if (!userId) return;
    let active = true;
    requestJson<{ tenants: Tenant[] }>("/api/tenants").then(({ tenants }) => {
      if (active) setState({ userId, tenants, selected: selectedTenant(), error: "" });
    }).catch(error => { if (active) setState({ userId, tenants: [], selected: "", error: friendlyError(error) }); });
    return () => { active = false; };
  }, [userId]);
  const refreshTenants = useCallback(async () => {
    if (!userId) return;
    try {
      const { tenants } = await requestJson<{ tenants: Tenant[] }>("/api/tenants");
      setState({ userId, tenants, selected: selectedTenant(), error: "" });
    } catch (error) { setState({ userId, tenants: [], selected: "", error: friendlyError(error) }); }
  }, [userId]);
  const current = state.userId === userId ? state : { tenants: [], selected: "", error: "" };
  const tenant = current.tenants.find(t => t.id === current.selected);
  return <WorkspaceContext.Provider value={{
    session, sessionPending: isPending, sessionError: error ? "登录状态暂时无法获取，请稍后重试。" : "",
    tenants: current.tenants, tenant, tenantsPending: !!userId && state.userId !== userId, tenantError: current.error,
    canExecute: !!tenant && tenant.role !== "viewer", canManage: tenant?.role === "owner" || tenant?.role === "admin",
    selectTenant(id) { if (current.tenants.some(t => t.id === id)) { persistTenant(id); location.reload(); } },
    refreshTenants,
  }}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceProvider is required");
  return context;
}
