import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Network, Plus } from "lucide-react";
import type { AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import { agentBusIsActive } from "../../src/client-protocol/agent-bus.js";
import type { AdhdHost } from "./AdhdBoard.js";
import type { HubConnection } from "./connection.js";
import { busModeName, busStatusName } from "./agent-bus-view.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-folders.css";
import "./agent-bus.css";

export type AgentBusNavigation = { hostId: string; registrationId: string; workspaceId?: string; serial: number };
const cache = new WeakMap<HubConnection, AgentBusWorkspace[]>();
const collapseKey = "tarobot:agent-bus-list-collapsed";
const collapseListeners = new Set<() => void>();
let listCollapsed = (() => { try { return localStorage.getItem(collapseKey) === "true"; } catch { return false; } })();
const subscribeCollapse = (listener: () => void) => { collapseListeners.add(listener); return () => { collapseListeners.delete(listener); }; };
const collapseSnapshot = () => listCollapsed;
function toggleCollapsed() {
  listCollapsed = !listCollapsed;
  try { localStorage.setItem(collapseKey, String(listCollapsed)); } catch { /* Folding still works in this window. */ }
  collapseListeners.forEach(listener => listener());
}
type ListSummary = { count: number; running: number };
export const refreshAgentBuses = () => window.dispatchEvent(new Event("tarobot:agent-buses-changed"));
export function AgentBusList({ hosts, visible, selected, open, create }: {
  hosts: AdhdHost[]; visible: boolean; selected?: AgentBusNavigation;
  open: (host: AdhdHost, id?: string) => void; create?: () => void;
}) {
  useLocale();
  const collapsed = useSyncExternalStore(subscribeCollapse, collapseSnapshot), contentId = useId();
  const [summaries, setSummaries] = useState(() => new Map<HubConnection, ListSummary>());
  const summarize = useCallback((connection: HubConnection, value: ListSummary) => setSummaries(old => {
    const previous = old.get(connection);
    return previous?.count === value.count && previous.running === value.running ? old : new Map(old).set(connection, value);
  }), []);
  const available = hosts.filter(host => host.connection && !host.blocked && host.host.state === "ready");
  const summary = available.reduce((total, host) => {
    const item = summaries.get(host.connection!);
    return { count: total.count + (item?.count ?? 0), running: total.running + (item?.running ?? 0) };
  }, { count: 0, running: 0 });
  return <section className="conversation-folder agent-bus-list" aria-label="Agent Bus" hidden={!summary.count}>
    {summary.count > 0 && <header className="agent-bus-group-heading"><button className="folder-heading agent-bus-list-toggle" aria-label={collapsed ? t("展开 Agent Bus 列表") : t("收起 Agent Bus 列表")} aria-expanded={!collapsed} aria-controls={contentId} onClick={toggleCollapsed}>{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span className="folder-label"><span className="folder-name">Agent Bus</span><span className="folder-count agent-bus-list-count" title={t("{0} 个 Bus", summary.count)}>{summary.count}</span></span>{summary.running > 0 && <span className="agent-bus-state-dot is-running" role="img" aria-label={t("{0} 个 Bus 正在运行", summary.running)} title={t("{0} 个 Bus 正在运行", summary.running)}/>}</button>{create && <button className="icon-button" aria-label={t("新建 Agent Bus")} onClick={create}><Plus size={15}/></button>}</header>}
    <div id={contentId} hidden={collapsed}>{available.map(host => <HostBuses key={host.host.registrationId} host={host} showHostName={available.length > 1} visible={visible} summarize={summarize} selected={selected?.registrationId === host.host.registrationId ? selected.workspaceId : undefined} open={id => open(host, id)}/>)}</div>
  </section>;
}
function HostBuses({ host, showHostName, visible, selected, open, summarize }: { host: AdhdHost; showHostName: boolean; visible: boolean; selected?: string; open: (id: string) => void; summarize: (connection: HubConnection, value: ListSummary) => void }) {
  const connection = host.connection!;
  const [items, setItems] = useState(() => cache.get(connection) ?? []);
  const [offline, setOffline] = useState(false);
  const running = offline ? 0 : items.filter(item => agentBusIsActive(item.latestRun?.status)).length;
  useEffect(() => { summarize(connection, { count: items.length, running }); }, [connection, items.length, running, summarize]);
  useEffect(() => {
    if (!visible) return;
    let closed = false, busy = false;
    const abort = new AbortController();
    const read = async () => {
      if (busy || closed || document.hidden) return;
      if (connection.state.status !== "online" || connection.isReadOnly) { setOffline(true); return; }
      if (connection.state.user?.role !== "owner") { setItems([]); cache.delete(connection); return; }
      busy = true;
      try { const value = await connection.http<{ items: AgentBusWorkspace[] }>("/api/agent-buses", { signal: abort.signal }); if (!closed) { cache.set(connection, value.items); setItems(value.items); setOffline(false); } }
      catch { if (!closed) setOffline(true); }
      finally { busy = false; }
    };
    void read(); const interval = setInterval(() => { void read(); }, 6000);
    const change = () => { void read(); };
    window.addEventListener("tarobot:agent-buses-changed", change); document.addEventListener("visibilitychange", change);
    return () => { closed = true; abort.abort(); clearInterval(interval); window.removeEventListener("tarobot:agent-buses-changed", change); document.removeEventListener("visibilitychange", change); };
  }, [connection, visible]);
  if (!items.length) return null;
  return <div className="agent-bus-host-list">{showHostName && <div className="agent-bus-host-label">{host.host.name}<span>{items.length}</span></div>}{items.map(item => <button key={item.id} className={`agent-bus-saved ${selected === item.id ? "is-selected" : ""}`} aria-label={t("打开 Bus：{0}", item.name)} aria-pressed={selected === item.id} onClick={() => open(item.id)}><span className="agent-bus-saved-icon"><Network size={17}/></span><span className="agent-bus-saved-copy"><strong>{item.name}</strong><small>{busModeName(item.mode)} · {t("{0} 位成员", item.members.length + 1)}</small></span><span className={`agent-bus-state-dot ${!offline && agentBusIsActive(item.latestRun?.status) ? "is-running" : ""}`} title={offline ? t("连接已断开") : busStatusName(item.latestRun?.status)}/></button>)}</div>;
}
