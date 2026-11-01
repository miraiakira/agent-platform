import type { CSSProperties } from "react";
export type IconName = "grid" | "agent" | "chat" | "shield" | "arrow" | "plus" | "users" | "check" | "logout" | "send" | "stop" | "activity" | "refresh" | "lock" | "building" | "chevron";
const paths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  agent: <><path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z"/><path d="M19 2v4m-2-2h4"/></>,
  chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 11.5 2.5 2.5 4.5-5"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  logout: <><path d="M9 4H4v16h5m5-13 5 5-5 5m-6-5h11"/></>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  activity: <path d="M2 12h4l3-8 5 16 3-8h5"/>,
  refresh: <><path d="M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5m-4 9a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4M8 7h1m6 0h1M8 11h1m6 0h1"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
};
export function Icon({ name, size = 20, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={{ flexShrink: 0, ...style }}>{paths[name]}</svg>;
}
