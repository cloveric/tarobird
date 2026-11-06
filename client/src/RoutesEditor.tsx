import { ExplanationList } from "./ExplanationList.js";
import { deviceOperationError } from "./device-errors.js";
import { connectionVerificationLabel } from "./connection-verification.js";
import { orderedRoutes } from "../../src/client-protocol/routes.js";
import { DeploymentGuide } from "./DeploymentGuide.js";
import { multipathConfiguration } from "./connection-routes.js";
import { DirectRouteFields, RelaySetupNote, VpsRouteFields, routeTitle } from "./RouteFields.js";
import { HostRoutesStatus, hostEntries, useHostRoutesView } from "./HostRoutesStatus.js";
import { RepairHostRoute } from "./RepairHostRoute.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { Pencil } from "lucide-react";
import { t, useLocale } from "./i18n.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";

export function RoutesEditor({ connection, dirtyChange, busyChange, localHost = false, identityPending = false, retryIdentity, configureLocal, localBusy = false }: { localBusy?: boolean; identityPending?: boolean; retryIdentity?: () => void; localHost?: boolean; configureLocal?: () => void; connection: HubConnection; dirtyChange?: (dirty: boolean) => void; busyChange?: (busy: boolean) => void }) {
  useLocale();
  const state = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state);
  const [editing, setEditing] = useState(false);
  const [direct, setDirect] = useState<Route[]>(connection.identity.routes.filter((r) => r.name !== "VPS"));
  const [relays, setRelays] = useState<Route[]>(connection.identity.routes.filter((r) => r.name === "VPS"));
  const [status, setStatus] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [repairBusy, setRepairBusy] = useState(false);
  const serialized = JSON.stringify({ direct, relays });
  const [baseline, setBaseline] = useState(serialized);
  const savedRoutes = useRef(JSON.stringify(connection.identity.routes));
  const dirty = editing && !localHost && !identityPending && serialized !== baseline;
  useEffect(() => { if (localHost || identityPending) setEditing(false); }, [localHost, identityPending]);
  // Publish exit guards in the same commit as an edit/save. A native Back can
  // arrive before passive effects and must not silently discard a fresh edit.
  useLayoutEffect(() => { dirtyChange?.(dirty); }, [dirty, dirtyChange]);
  useLayoutEffect(() => { busyChange?.(busy || repairBusy); }, [busy, repairBusy, busyChange]);
  const reset = () => {
    savedRoutes.current = JSON.stringify(connection.identity.routes);
    const identity = connection.identity, nextDirect = identity.routes.filter((r) => r.name !== "VPS"), next = identity.routes.filter((r) => r.name === "VPS");
    setDirect(nextDirect); setRelays(next);
    setBaseline(JSON.stringify({ direct: nextDirect, relays: next })); setError("");
  };
  const changed = () => { setStatus(""); setError(""); };
  const online = state.status === "online", title = (route: Route) => routeTitle(route, connection.identity.routes, connection.identity.deployment);
  const hostView = useHostRoutesView(connection);
  // On the host itself the saved list is only loopback; also list the LAN and
  // Tailscale entries other devices use, with the host's own listener state.
  const entries = localHost && hostView ? hostEntries(hostView) : [];
  // Same labels as the editor's per-route status, from the client's own probes.
  const routeState = (route: Route): { label: string; tone: string } | undefined => {
    if (online && state.route?.url === route.url) return { label: t("当前使用"), tone: "current" };
    const probe = state.routeHealth?.find((h) => h.url === route.url);
    if (!probe) return undefined;
    const verificationLabel = connectionVerificationLabel(probe.failure);
    if (verificationLabel) return { label: verificationLabel, tone: "bad" };
    return probe.status === "reachable" ? { label: t("可达 · 待连接验证"), tone: "ok" } : probe.status === "wrong-hub" ? { label: t("主机身份不匹配"), tone: "bad" } : probe.status === "cooldown" ? { label: t("连接失败，稍后重试"), tone: "warn" } : { label: t("暂不可用"), tone: "bad" };
  };
  return <div className="routes-settings">
    <div className="connection-summary" data-status={state.status}>
      <span className="connection-dot" aria-hidden="true"/>
      <div><strong>{online ? t("已连接") : state.status === "connecting" ? t("正在连接…") : t("未连接")}</strong><span>{online && state.route ? <>{t("正在使用「{0}」", title(state.route))}{state.latency !== undefined && t(" · 延迟 {0} ms", state.latency)}</> : state.error ? state.error : t("正在检测已保存线路的可达性与主机身份。")}</span></div>
      {!online && <button type="button" className="secondary connection-retry" disabled={state.status === "connecting"} onClick={() => connection.resume(true)}>{t("重新连接")}</button>}
    </div>
    {online && state.routeSelection && !localHost && <p className="settings-note muted" role="status">{state.routeSelection.reason === "quality" ? t("已在空闲时切换：这条线路近期持续响应更快。") : state.routeSelection.reason === "failover" ? t("原连接中断，已通过另一条线路恢复。") : state.routeSelection.reason === "reconnected" ? t("已恢复原线路连接。") : t("已通过主机与设备身份验证。")}</p>}
    {!editing || localHost || identityPending ? <>
      {!localHost && !identityPending && <RepairHostRoute connection={connection} online={online} busyChange={setRepairBusy}/>}
      <SettingsGroupHeading>{localHost ? t("本机连接") : t("已保存的线路")}</SettingsGroupHeading>
      {!localHost && <p className="settings-note muted">{t("局域网、Tailscale 与中转可同时保留，自动选择稳定、响应更快的线路。")}</p>}
      {!localHost && <details className="settings-help"><summary>{t("线路如何切换")}</summary><ExplanationList items={[
        { label: t("自动选择"), description: t("同时检查多条线路，结合近期稳定性和响应速度选择；消息只通过当前线路发送。") },
        { label: t("稳定切换"), description: t("更快的线路持续稳定后，在空闲时切换；发送消息、保存设置或传输文件时不会主动切换。") },
      ]}/></details>}
      <HostRoutesStatus connection={connection} view={hostView}/>
      <ol className="saved-routes">{orderedRoutes(connection.identity.routes).map((route, index) => { const routeStatus = routeState(route); return <li key={route.url}><span className="saved-route-index" aria-hidden="true">{index + 1}</span><div><strong>{title(route)}</strong><span>{route.url}</span></div>{routeStatus && <small className="route-state" data-tone={routeStatus.tone}>{routeStatus.label}</small>}</li>; })}{entries.map((entry, index) => <li key={`host-entry-${entry.route.url}`} data-host-entry={entry.mode}><span className="saved-route-index" aria-hidden="true">{connection.identity.routes.length + index + 1}</span><div><strong>{entry.mode === "lan" ? t("局域网") : "Tailscale"}</strong><span>{entry.route.url}</span></div><small className="route-state" data-tone={entry.listening ? "current" : "warn"}>{entry.listening ? t("已就绪") : t("等待网络连接")}</small></li>)}</ol>
      {identityPending ? <p role="status">{t("正在确认本机身份，暂不修改连接线路。")}{retryIdentity && <button type="button" onClick={retryIdentity}>{t("重试")}</button>}</p> : localHost ? <>{configureLocal && <button type="button" className="secondary" disabled={localBusy} onClick={configureLocal}>{t("局域网与 Tailscale")}</button>}</> : <button className="secondary" disabled={repairBusy} onClick={() => { reset(); setEditing(true); setStatus(""); }}>{t("编辑线路")}</button>}
      {!localHost && <RelaySetupNote/>}
    </> :
      <form noValidate className="routes-editor" onSubmit={(e) => { e.preventDefault(); if (busy || localHost || identityPending) return; setBusy(true); setStatus(""); setError(""); void (async () => {
        if (savedRoutes.current !== JSON.stringify(connection.identity.routes)) throw new Error(t("主机线路刚刚更新。请取消编辑，再重新打开核对后保存。"));
        const { routes, deployment } = multipathConfiguration(direct, relays, connection.identity.routes, connection.identity.deployment);
        await connection.updateRoutes(routes, { deployment, expected: connection.identity.routes, reason: "user" }); reset(); setStatus(t("线路已保存。将自动检测可用性，并在合适时机选择更稳定的线路。"));
      })().catch((e: unknown) => setError(e instanceof Error && e.message === "routes_changed" ? t("主机线路刚刚更新。请取消编辑，再重新打开核对后保存。") : e instanceof Error ? e.message : t("保存失败"))).finally(() => setBusy(false)); }}>
        <p className="settings-note muted">{t("通常只在主机换了地址，或要增加备用中转时才需要修改。保存之前，当前连接不受影响。")}</p>
        <DirectRouteFields routes={direct} change={value => { setDirect(value); changed(); }} disabled={busy}/>
        <VpsRouteFields routes={relays} change={(value) => { setRelays(value); changed(); }} current={state.status === "online" ? state.route?.url : undefined} health={state.routeHealth} disabled={busy}/>
        <DeploymentGuide/>
        {error && <p role="alert" className="error-text">{error}</p>}
        <div className="route-save-bar"><span>{dirty ? t("有未保存的修改") : t("尚未修改")}</span><button type="button" disabled={busy} onClick={() => { reset(); setEditing(false); setStatus(""); }}>{t("取消")}</button><button className="primary" type="submit" disabled={busy}>{busy ? t("正在保存…") : t("保存线路")}</button></div>
      </form>}
    {status && <p role="status" className="settings-feedback">{status}</p>}
    {!localHost && <p className="connection-footnote muted">{t("连接状态不代表 Tailscale 内部的直连或中继方式。所有线路都需要主机在线，并通过 TaroBird 身份验证。")}</p>}
  </div>;
}
export function DeviceName({ id, name, rename, disabled = false, dirtyChange, label }: { label?: string; disabled?: boolean; id: string; name: string; rename: (id: string, name: string) => Promise<void>; dirtyChange?: (id: string, dirty: boolean) => void }) {
  useLocale();
  const [editing, setEditing] = useState(false), [original, setOriginal] = useState(name), [value, setValue] = useState(name);
  const [error, setError] = useState<unknown>(), [saving, setSaving] = useState(false);
  const savingRef = useRef(false), input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => { if (error && !saving && !disabled) input.current?.focus(); }, [error, saving, disabled]);
  useLayoutEffect(() => { dirtyChange?.(id, editing && value !== original); }, [id, editing, value, original, dirtyChange]);
  useLayoutEffect(() => () => { dirtyChange?.(id, false); }, [id, dirtyChange]);
  // The name button is replaced by the form; return focus to it afterwards.
  const button = useRef<HTMLButtonElement>(null), restore = useRef(false);
  useEffect(() => { if (!editing && !disabled && restore.current) { restore.current = false; button.current?.focus(); } }, [editing, disabled]);
  const finish = () => { restore.current = true; setEditing(false); };
  return editing ? <form className="device-rename" onSubmit={(e) => {
    e.preventDefault(); if (savingRef.current || disabled || !value.trim()) return;
    if (value.trim() === name) { finish(); return; }
    savingRef.current = true; setSaving(true); setError(undefined);
    void rename(id, value.trim()).then(finish).catch((error: unknown) => setError(() => error)).finally(() => { savingRef.current = false; setSaving(false); });
  }}><input ref={input} autoFocus aria-invalid={!!error} aria-describedby={error ? errorId : undefined} aria-label={t("设备新名称")} value={value} maxLength={100} required disabled={saving || disabled} onChange={(e) => { setValue(e.target.value); setError(undefined); }}/><button type="submit" disabled={saving || disabled || !value.trim()}>{saving ? t("正在保存…") : t("保存")}</button><button type="button" disabled={saving} onClick={() => { setValue(name); finish(); }}>{t("取消")}</button>{!!error && <small id={errorId} role="alert" className="error-text">{deviceOperationError(error)}</small>}</form> : <button ref={button} disabled={disabled} className="device-name" aria-label={t("重命名设备 {0}", name)} onClick={() => { setValue(name); setOriginal(name); setError(undefined); setEditing(true); }}>{label ?? name}<Pencil size={13} aria-hidden="true"/></button>;
}
