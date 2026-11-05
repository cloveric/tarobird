import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { HubConnection } from "./connection.js";
import type { Route } from "./storage.js";
import type { NetworkView } from "../../src/client-protocol/private-network.js";
import { VpsRouteFields, routeTitle } from "./RouteFields.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { hubFetch } from "./transport.js";
import { connectionVerificationFailure } from "./connection-verification.js";
import { localRelayRoutes, sameRelayConfiguration } from "./local-relay-routes.js";
import { t, useLocale } from "./i18n.js";

/** The owner manages advertised access on the host itself. No listener,
 * tunnel, pairing identity, or desktop loopback route is changed here. */
export function LocalRelaySettings({ connection, dirtyChange, busyChange }: { connection: HubConnection; dirtyChange: (dirty: boolean) => void; busyChange: (busy: boolean) => void }) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [snapshot, setSnapshot] = useState<NetworkView>();
  const [editSnapshot, setEditSnapshot] = useState<NetworkView>();
  const [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false), [relays, setRelays] = useState<Route[]>([]), [baseline, setBaseline] = useState("[]");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [share, setShare] = useState<string>();
  const operation = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const available = state.status === "online" && state.networkAvailable && state.user?.role === "owner";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, [connection]);
  useEffect(() => {
    if (!available) { setLoading(false); return; }
    let active = true;
    setLoading(true); setError("");
    void connection.refreshNetwork().then(view => {
      if (!active) return;
      if (!view || view.host.publicKey !== connection.identity.hubPublicKey) throw new Error("network_view_unavailable");
      setSnapshot(view);
    }).catch(() => { if (active) setError(t("未能读取本机中转配置，请重试。")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection, available, attempt]);
  useEffect(() => { if (!editing && state.network?.host.publicKey === connection.identity.hubPublicKey) setSnapshot(state.network); }, [editing, state.network, connection]);
  const dirty = editing && JSON.stringify(relays) !== baseline;
  useLayoutEffect(() => { dirtyChange(dirty); }, [dirty, dirtyChange]);
  useLayoutEffect(() => { busyChange(busy); }, [busy, busyChange]);
  useLayoutEffect(() => () => { dirtyChange(false); busyChange(false); }, [dirtyChange, busyChange]);
  const saved = snapshot?.host.routes.filter(route => route.name === "VPS") ?? [];
  const begin = () => {
    const next = saved.length ? saved.map(route => ({ ...route })) : [{ name: "VPS" as const, url: "" }];
    setEditSnapshot(snapshot);
    setBaseline(JSON.stringify(next)); setRelays(next);
    setEditing(true); setError(""); setNotice(""); setShare(undefined);
  };
  async function save() {
    if (operation.current || !editSnapshot || !available) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setNotice("");
    try {
      const proposed = localRelayRoutes(editSnapshot.host.routes, relays);
      // Check public HTTPS and pinned host identity without sending credentials.
      for (const route of proposed.filter(route => route.name === "VPS")) {
        const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 8000);
        const abort = () => timeout.abort(); controller.signal.addEventListener("abort", abort, { once: true });
        try {
          const response = await hubFetch(route.url, "/health", connection.identity.hubPublicKey, { signal: timeout.signal, cache: "no-store" });
          if (!response.ok) throw new Error("relay_unreachable");
          const health = await response.json() as { publicKey?: string };
          if (health.publicKey !== connection.identity.hubPublicKey) throw new Error("relay_wrong_host");
        } catch (cause) {
          const mismatch = cause instanceof Error && cause.message === "relay_wrong_host" || connectionVerificationFailure(cause) === "identity-mismatch";
          throw new Error(mismatch ? t("中转地址属于另一台主机，未保存。请填写当前主机的独立入口。") : t("暂时无法验证中转地址，未保存。请确认云端隧道已部署、证书有效并且本机在线。"));
        } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
        if (controller.signal.aborted) return;
      }
      const fresh = await connection.refreshNetwork();
      if (controller.signal.aborted) return;
      if (!fresh || !sameRelayConfiguration(editSnapshot, fresh)) throw new Error(t("中转配置已在其他窗口更改。请取消编辑，重新读取后再保存。"));
      // Preserve the latest LAN/Tailscale route even if it changed during probing.
      const routes = localRelayRoutes(fresh.host.routes, relays);
      const result = await connection.networkCommand({ operation: "routes", networkId: fresh.membership?.manifest.id ?? "", routes });
      if (!mounted.current || controller.signal.aborted) return;
      setSnapshot(result.view); setEditing(false); setShare(undefined);
      setNotice(t("中转入口已保存。本机继续直连；网络成员将在同步后获得新线路。"));
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error && /[\u3400-\u9fff]|[ .]/.test(cause.message) ? cause.message : t("未能确认保存结果。请重新读取本机配置后再操作。"));
    } finally { if (operation.current === controller) operation.current = undefined; if (mounted.current) setBusy(false); }
  }
  return <section className="local-relay-settings" aria-label={t("本机 VPS 中转")}>
    <SettingsGroupHeading>{t("本机 VPS 中转")}</SettingsGroupHeading>
    <p className="settings-note">{t("在这台电脑填写自己的 VPS 入口，供手机和其他电脑访问本机。")}</p>
    {!available ? <p role="status">{state.status !== "online" ? t("请等待本机连接恢复后设置中转。") : !state.user ? t("正在读取网络管理权限…") : state.user.role !== "owner" ? t("需要主机所有者权限才能设置本机中转。") : state.networkAvailable === false ? t("此主机需要更新后才能设置本机中转。") : t("正在读取网络管理能力…")}</p> : loading ? <p role="status">{t("正在读取本机中转配置…")}</p> : editing ? <form className="routes-editor" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <VpsRouteFields routes={relays} change={value => { setRelays(value); setError(""); }} disabled={busy}/>
      <div className="route-save-bar"><button type="button" disabled={busy} onClick={() => { setEditing(false); setError(""); setAttempt(value => value + 1); }}>{t("取消")}</button><button type="submit" className="primary" disabled={busy || !dirty}>{busy ? t("正在验证并保存…") : t("验证并保存中转")}</button></div>
    </form> : <>
      {!!saved.length && <ol className="saved-routes">{saved.map((route, index) => <li key={route.url}><span className="saved-route-index" aria-hidden="true">{index + 1}</span><div><strong>{routeTitle(route, saved)}</strong><span>{route.url}</span></div><button type="button" onClick={() => setShare(share === route.url ? undefined : route.url)}>{share === route.url ? t("收起连接码") : t("连接码")}</button></li>)}</ol>}
      {share && saved.some(route => route.url === share) && <div className="local-relay-share"><ConnectionInviteCode connection={connection} payload={{ v: 1, kind: "connect", hubPublicKey: connection.identity.hubPublicKey!, routes: saved.filter(route => route.url === share), deployment: "computer" }}/></div>}
      {snapshot && <button type="button" className="secondary" onClick={begin}>{saved.length ? t("管理 VPS 中转") : t("添加 VPS 中转")}</button>}
    </>}
    {error && <p role="alert" className="error-text">{error}{!editing && <button type="button" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button>}</p>}
    {notice && <p role="status" className="settings-feedback">{notice}</p>}
    <p className="route-entry-help">{t("这里保存已部署的 HTTPS 入口，不安装云端隧道。单独配对或手动改过线路的设备，仍需在各自的「连接」中添加此地址。")}</p>
  </section>;
}
