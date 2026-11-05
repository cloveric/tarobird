import { timeoutSignal } from "./abort-signals.js";
import { pairingClockOffset, pairingRemaining } from "./pairing-time.js";
import { defaultDeviceName } from "./device-presentation.js";
import { rememberRouteTrust } from "./route-trust.js";
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { ArrowLeft, ChevronLeft, ClipboardPaste, ImagePlus, LoaderCircle, Monitor, QrCode, ShieldCheck } from "lucide-react";
import type { PairingProps } from "./HostApp.js";
import { BrandMark, PairingIntro } from "./BrandScenes.js";
import { connectionConfiguration } from "./connection-routes.js";
import { orderedRoutes, type Deployment } from "../../src/client-protocol/routes.js";
import { createIdentity, randomNonce } from "./identity.js";
import { cache, type Route, type Identity, type PendingPairing } from "./storage.js";
import { nativePlatform, deleteNativeIdentity } from "./native.js";
import { t, useLocale } from "./i18n.js";
import { hubFetch, usesPinnedTransport } from "./transport.js";
import { connectionVerificationFailure, connectionVerificationMessage, preferredVerificationFailure, validHubPublicKey } from "./connection-verification.js";
import { pairingInviteError } from "./pairing-invite-errors.js";

const PairingCode = lazy(() => import("./PairingCode.js").then(module => ({ default: module.PairingCode })));
const PairingScanner = lazy(() => import("./PairingCode.js").then(module => ({ default: module.PairingScanner })));
const PairingRouteOptions = lazy(() => import("./PairingRouteOptions.js").then(module => ({ default: module.PairingRouteOptions })));
const DesktopWelcome = lazy(() => import("./DesktopWelcome.js").then(module => ({ default: module.DesktopWelcome })));
const RepairHostRoute = lazy(() => import("./RepairHostRoute.js").then(module => ({ default: module.RepairHostRoute })));

class PairingRequestError extends Error { constructor(readonly code: string, message: string) { super(message); } }
const idle = { status: "offline" as const, error: undefined as string | undefined, awaitingApproval: false };
const noopSubscribe = () => () => undefined;
export function Pairing({ connected, save, beforePair, discard, cancel, pendingConnection, manage, localHostReady = false }: PairingProps) {
  useLocale();
  const [preparedLocal, setPreparedLocal] = useState<Identity>();
  const saveLocal = async (identity: Identity, name: string) => { if (save) await save(identity, name); else await cache.saveIdentity(identity); setPreparedLocal(identity); setName(name); };
  const platform = nativePlatform(), desktop = platform === "macos" || platform === "windows";
  const [remote, setRemote] = useState(!!pendingConnection?.identity.pendingPairing), [manual, setManual] = useState(platform === "web");
  const [hostName, setHostName] = useState(t("我的主机"));
  const [scan, setScan] = useState(false), [inputMode, setInputMode] = useState<"scan" | "text" | "image">("scan"), [optionsOpen, setOptionsOpen] = useState(false), [expectedKey, setExpectedKey] = useState<string>();
  const [invite, setInvite] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const [manualKey, setManualKey] = useState(""); const trustedKey = expectedKey ?? (manualKey.replace(/\s/g, "") || undefined);
  const [deployment, setDeployment] = useState<Deployment>(), [legacyDirect, setLegacyDirect] = useState<Route>();
  const [address, setAddress] = useState(nativePlatform() === "web" && location.origin.startsWith("http") ? location.origin : ""), [relays, setRelays] = useState<Route[]>([]);
  const [name, setName] = useState(() => defaultDeviceName(platform));
  const [createdIdentity, setIdentity] = useState<Identity>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const identity = createdIdentity ?? pendingConnection?.identity;
  const joiningDesktop = desktop && (localHostReady || !!preparedLocal);
  const pending = identity?.pendingPairing;
  const directHost = (() => { try { return address ? new URL(address).hostname : ""; } catch { return ""; } })();
  const tailscaleRoute = legacyDirect?.name === "Tailscale" || directHost.endsWith(".ts.net") || /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(directHost);
  const lanRoute = /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(directHost);
  const status = useSyncExternalStore(pendingConnection ? (notify) => pendingConnection.subscribe(notify) : noopSubscribe, () => pendingConnection?.state ?? idle);
  const [now, setNow] = useState(Date.now), completing = useRef(false), admission = useRef(false);
  const remaining = pending ? pairingRemaining(pending.expiresAt, now, pending.serverTimeOffset) : 0;
  useEffect(() => { if (!pending) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [pending]);
  // Actual authenticated readiness is the only success signal. Keep the code
  // durable across backgrounding/reload, and never enter a disconnected chat.
  useEffect(() => {
    // Returning to the start screen keeps enrollment intact, but a late host
    // approval must not pull the user out of their newly selected setup flow.
    if (desktop && !remote) return;
    if (status.status !== "online") { completing.current = false; return; }
    if (!identity || !pending || completing.current) return;
    completing.current = true;
    void Promise.resolve(connected(identity)).catch((e: unknown) => { setError(e instanceof Error ? e.message : t("连接失败")); });
  }, [identity, pending, status.status, connected, desktop, remote]);

  const requestPair = async (device: Identity, route: Route, key: string, request: NonNullable<PendingPairing["request"]>): Promise<PendingPairing> => {
    const response = await hubFetch(route.url, "/api/pair", key, { method: "POST", signal: timeoutSignal(10_000), body: JSON.stringify({ deviceId: device.deviceId, name: device.name, platform: device.platform ?? "web", publicKey: device.publicKey, ...request }) });
    const result = await response.json() as { code: string; expiresAt: number; hubPublicKey: string; serverTime?: number; error?: string };
    if (!response.ok) {
      const invitationError = pairingInviteError(result.error); if (invitationError) throw new PairingRequestError(result.error!, invitationError);
      if (result.error === "pairing_already_pending") throw new PairingRequestError(result.error, t("主机上仍有这台设备的申请，但这里尚未收到配对码。旧申请最多 5 分钟后过期；请稍后重新扫码，或先用「核对上次申请」重试。"));
      if (response.status === 429) throw new PairingRequestError("rate_limited", t("操作过于频繁，请稍后重试。"));
      throw new PairingRequestError(result.error ?? "pair_failed", result.error === "device_already_registered" ? result.error : t("配对请求失败"));
    }
    if (key !== result.hubPublicKey) throw new Error("tls_identity_mismatch");
    if (!/^\d{8}$/.test(result.code) || !Number.isFinite(result.expiresAt)) throw new Error(t("配对请求失败"));
    return { code: result.code, expiresAt: result.expiresAt, request: { requestId: request.requestId }, serverTimeOffset: Number.isFinite(result.serverTime) ? result.serverTime! - Date.now() : pairingClockOffset(response.headers.get("date"), Date.now()) };
  };
  const pair = async (event: FormEvent) => {
    event.preventDefault(); if (admission.current) return; admission.current = true; setBusy(true); setError(""); let created: Identity | undefined, persisted = false;
    try {
      if (!invite) throw new Error(pairingInviteError("invite_required"));
      const { routes, deployment: routeDeployment } = connectionConfiguration(address, relays, deployment, legacyDirect);
      if (usesPinnedTransport() && routes.some((route) => route.url.startsWith("https:")) && !trustedKey) throw new Error(t("请扫描可信设备上的 Hub 二维码，或填写主机身份公钥。"));
      if (usesPinnedTransport() && trustedKey && !validHubPublicKey(trustedKey)) throw new Error("invalid_hub_key");
      rememberRouteTrust(routes, trustedKey);
      const probes = await Promise.allSettled(orderedRoutes(routes).map(async (route) => {
        const response = await hubFetch(route.url, "/health", trustedKey, { signal: timeoutSignal(usesPinnedTransport() ? 6000 : 2000), cache: "no-store" });
        const health = await response.json() as { ok?: boolean; publicKey?: string; pairingInvites?: number };
        if (!response.ok || health.ok !== true || typeof health.publicKey !== "string") throw new Error("hub_unavailable");
        if (trustedKey && health.publicKey !== trustedKey) throw new Error("tls_identity_mismatch");
        return { route, publicKey: health.publicKey, supportsInvites: health.pairingInvites === 1 };
      }));
      const available = probes.find((result) => result.status === "fulfilled");
      if (!available || available.status !== "fulfilled") {
        const failure = preferredVerificationFailure(probes.map((result) => result.status === "rejected" ? connectionVerificationFailure(result.reason) : undefined));
        throw new Error(connectionVerificationMessage(failure) ?? t("没有可用且身份匹配的线路，请检查地址后重试。"));
      }
      if (!available.value.supportsInvites) throw new Error(t("请先更新此主机，才能使用限时连接码配对新设备。"));
      await beforePair?.(available.value.publicKey);
      const device = await createIdentity(name.trim(), routes); device.deployment = routeDeployment; device.hubPublicKey = available.value.publicKey; created = device;
      device.pendingPairing = { code: "", expiresAt: 0, request: { invite, requestId: randomNonce() } };
      if (save) await save(device, hostName); else await cache.saveIdentity(device);
      persisted = true;
      setIdentity(device); setNow(Date.now());
    } catch (e) {
      if (created && !persisted) { if (discard) await discard(created).catch(() => undefined); else if (created.keyRef) await deleteNativeIdentity(created.keyRef).catch(() => undefined); }
      setError(connectionVerificationMessage(connectionVerificationFailure(e)) ?? (e instanceof Error ? e.message : t("连接失败")));
    } finally { admission.current = false; setBusy(false); }
  };
  const submitPending = async () => {
    if (!identity?.hubPublicKey || !pendingConnection || admission.current || pendingConnection.identity.deviceId !== identity.deviceId || pendingConnection.identity.hubPublicKey !== identity.hubPublicKey) return;
    const request = identity.pendingPairing?.request; if (!request) return;
    const expected = { requestId: request.requestId, code: identity.pendingPairing!.code };
    admission.current = true; setBusy(true); setError(""); setRequestError(undefined);
    try {
      const routes = [pendingConnection.state.route, ...orderedRoutes(identity.routes)].filter((route): route is Route => !!route);
      let next: PendingPairing | undefined, failure: unknown;
      for (const route of routes.filter((route, index) => routes.findIndex(other => other.url === route.url) === index)) {
        try { next = await requestPair(identity, route, identity.hubPublicKey, request); break; }
        catch (e) { if (e instanceof PairingRequestError) throw e; failure = e; }
      }
      if (!next) throw failure ?? new Error("pairing_response_unknown");
      await pendingConnection.cache.savePendingPairing(identity, next, expected);
      identity.pendingPairing = next; pendingConnection.identity.pendingPairing = next;
      setNow(Date.now()); pendingConnection.refreshCache(); pendingConnection.resume(true);
    } catch (e) {
      if (e instanceof Error && e.message === "device_already_registered") { setError(t("已批准，正在重新连接。无需再次配对。")); pendingConnection.resume(true); }
      else if (!(e instanceof Error && e.message === "pairing_request_changed")) {
        if (e instanceof PairingRequestError && ["pairing_invite_invalid", "pairing_invite_expired", "pairing_invite_used"].includes(e.code)) {
          const cleared = { ...identity.pendingPairing!, request: { requestId: request.requestId } };
          try {
            await pendingConnection.cache.savePendingPairing(identity, cleared, expected);
            identity.pendingPairing = cleared; pendingConnection.identity.pendingPairing = cleared;
            pendingConnection.refreshCache();
          } catch { return; /* A newer request or approval must never be overwritten. */ }
        }
        setRequestError(e instanceof PairingRequestError ? e.code : undefined);
        setError(connectionVerificationMessage(connectionVerificationFailure(e)) ?? (e instanceof PairingRequestError ? e.message : t("配对申请结果待确认，请核对上次申请，不要重复创建设备。")));
      }
    } finally { admission.current = false; setBusy(false); }
  };
  const attempted = useRef(new Set<string>()), submitRef = useRef(submitPending); submitRef.current = submitPending;
  useEffect(() => {
    const requestId = pending?.request?.requestId;
    if (!busy && !admission.current && !(desktop && !remote) && pendingConnection?.identity.deviceId === identity?.deviceId && pendingConnection?.identity.hubPublicKey === identity?.hubPublicKey && !pending?.code && requestId && !attempted.current.has(requestId)) {
      attempted.current.add(requestId); void submitRef.current();
    }
  }, [pendingConnection, pending?.code, pending?.request?.requestId, busy, desktop, remote]);
  if (desktop && !remote) return <Suspense fallback={<div className="loading-screen"><BrandMark/><LoaderCircle className="spin" size={16}/></div>}><DesktopWelcome localHostReady={localHostReady || !!preparedLocal} connected={connected} save={saveLocal} beforePair={beforePair} discard={discard} cancel={cancel ?? (preparedLocal ? () => { void Promise.resolve(connected(preparedLocal)).catch(e => setError(String(e))); } : undefined)} pending={!!pending} remote={() => setRemote(true)}/></Suspense>;
  return <main className="pairing-page"><div className="pairing-layout"><div className={`pairing-card${!pending && (platform === "ios" || platform === "android") ? " pairing-phone-welcome" : ""}`}>
    {(desktop || cancel) && <nav className="pairing-navigation">
      {desktop && <button type="button" className="pairing-host-cancel" disabled={busy} onClick={() => { setRemote(false); setError(""); }}><ChevronLeft size={16}/>{t("返回开始")}</button>}
      {cancel && <button type="button" className="pairing-host-cancel pairing-return-conversations" disabled={busy} onClick={cancel}><ArrowLeft size={16} aria-hidden="true"/>{t("返回会话")}</button>}
    </nav>}
    <BrandMark/>{joiningDesktop && <ol className="pairing-journey" aria-label={t("加入步骤")}><li>{t("准备电脑")}</li><li aria-current="step">{t("手机确认连接")}</li><li>{t("确认加入网络")}</li></ol>}<h1>{pending ? t("用已配对设备确认") : t("连接你的 TaroBird")}</h1>
    {pending ? <section className="pairing-waiting">
      <p>{!pending.code ? t("正在核对这台设备的配对申请。回执丢失时会复用原申请，设备身份不会重新生成。") : joiningDesktop ? t("打开已配对手机的「设备与网络 › 输入配对码确认」，输入下方 8 位配对码。手机确认后，这里会继续设置本机线路并确认加入网络。") : t("打开已配对手机或电脑的「设备与网络」，选择「输入配对码确认」，输入下方 8 位配对码。无需回到主机旁，确认后这里会自动进入聊天。")}</p>
      {identity?.hubPublicKey && <p className="muted">{t("目标主机身份尾号：{0}。请与手机上显示的尾号核对。", identity.hubPublicKey.slice(-8))}</p>}
      <p className="muted">{t("新设备：{0}", identity?.name ?? name)}</p>
      {pending.code && <><div className="pair-code" aria-label={t("配对码")}>{pending.code}</div>
      <p className="pairing-countdown">{remaining ? t("有效时间 {0}:{1}", Math.floor(remaining / 60), String(remaining % 60).padStart(2, "0")) : t("配对码已过期，请扫描新的限时连接码。")}</p></>}
      <div role="status" className="pairing-connection-status">{remaining > 0 && <LoaderCircle className="spin" size={18}/>}<span>{status.status === "online" ? joiningDesktop ? t("已连接，正在继续加入网络…") : t("已连接，正在打开聊天…") : !pending.code ? busy ? t("正在核对申请…") : t("配对申请结果待确认，请核对上次申请。") : !remaining ? t("配对码已过期，请扫描新的限时连接码。") : status.awaitingApproval ? t("等待已配对设备确认…") : t("正在连接主机…")}</span></div>
      {status.error && <p className="error-text" role="alert">{status.error}</p>}
      <button className="secondary full" disabled={busy || status.status === "connecting"} onClick={() => { setError(""); completing.current = false; pendingConnection?.resume(true); }}>{t("重新检查连接")}</button>
      {!pending.code && pending.request && <button className="primary full" disabled={busy} onClick={() => void submitPending()}>{busy ? t("正在核对申请…") : t("核对上次申请")}</button>}
      {((!!pending.code && !remaining) || ["pairing_invite_invalid", "pairing_invite_expired", "pairing_invite_used", "pairing_invite_required"].includes(requestError ?? "")) && <button className="secondary full" disabled={busy} onClick={() => { setInputMode("scan"); setScan(true); }}>{t("扫描新的连接码")}</button>}
      {!pending.code && requestError && <p className="settings-note">{t("若主机地址也已改变，请先在下方「无法连接？更新主机地址」更新线路。")}</p>}
      {pending.code && <details className="pairing-options"><summary>{t("其他确认方式")}</summary>
        {remaining > 0 && identity?.hubPublicKey && <Suspense fallback={null}><PairingCode payload={{ v: 1, kind: "approve", code: pending.code, hubPublicKey: identity.hubPublicKey }}/></Suspense>}
        <p className="muted">{t("也可以用已配对手机扫描此码，核对后点「确认配对」。")}</p>
        <p className="muted">{t("CLI 主机也支持手机确认；没有已配对设备时，可在主机终端运行 tarobot devices approve 加上上方的配对码。")}</p>
      </details>}
      {pendingConnection && <details className="pairing-options"><summary>{t("无法连接？更新主机地址")}</summary><Suspense fallback={null}><RepairHostRoute connection={pendingConnection} online={status.status === "online"} busyChange={setBusy}/></Suspense>{manage && <button type="button" disabled={busy} onClick={manage}>{t("设备与网络")}</button>}</details>}
    </section> : <>
      <p className="muted">{t("二维码在哪里？在已连接的手机或电脑打开「设备与网络 → 添加设备」。也可以复制那里的连接信息，在此粘贴。")}</p>
      <form onSubmit={(e) => { void pair(e); }}>
        <div className="pairing-import-actions">
        <button type="button" className="primary full" disabled={busy} onClick={() => { setInputMode("text"); setScan(true); }}><ClipboardPaste size={18}/>{t("粘贴连接信息")}</button>
        <button type="button" className="pairing-scan full" disabled={busy} onClick={() => { setInputMode("image"); setScan(true); }}><ImagePlus size={18}/>{t("导入二维码图片")}</button>
        <button type="button" className="pairing-scan full" disabled={busy} onClick={(event) => { event.currentTarget.focus(); setInputMode("scan"); setScan(true); }}><QrCode size={20} aria-hidden="true"/>{t("扫描连接二维码")}</button>
        </div>
        {expectedKey && <div className="pairing-import"><Monitor size={18}/><div><strong>{t("已读取主机信息")}</strong><p className="muted">{address ? new URL(address).hostname : t("VPS 中转")}</p></div><button type="button" disabled={busy} onClick={() => { setInputMode("text"); setScan(true); }}>{t("更换连接信息")}</button></div>}
        {expectedKey && (tailscaleRoute || lanRoute) && <p className="pairing-route-hint">{tailscaleRoute ? t("此连接使用 Tailscale。这台电脑也需连接同一 Tailscale 网络，并允许访问目标主机；仅复制地址不会自动建立连接。") : t("此连接包含局域网地址。人在外面时需有可用的 Tailscale 或 VPS 线路；家里的 Wi-Fi 地址通常无法从外部直接访问。")}</p>}
        {(manual || expectedKey) && <>
          <label>{t("设备名称")}<input value={name} required maxLength={100} disabled={busy} aria-describedby="pairing-device-name-help" onChange={(e) => setName(e.target.value)}/></label><p id="pairing-device-name-help" className="settings-note muted">{t("确认一个其他设备也能认出的名称，例如 MacBook Pro 或 vivo 手机。")}</p>
          <details className="pairing-options" open={manual} onToggle={(e) => setManual(e.currentTarget.open)}><summary>{t("手动连接与高级选项")}</summary>
            {save && <label>{t("主机名称")}<input value={hostName} required maxLength={100} disabled={busy} onChange={(e) => setHostName(e.target.value)}/></label>}
            <label>{t("Hub 地址")}<input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} value={address} placeholder="https://192.168.1.100:8788" onChange={(e) => setAddress(e.target.value)}/></label>
            {usesPinnedTransport() && !expectedKey && <label>{t("主机身份公钥")}<input disabled={busy} value={manualKey} maxLength={120} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setManualKey(e.target.value)} placeholder="MCowBQYDK2VwAyEA…"/></label>}
            <details className="pairing-options" open={optionsOpen} onToggle={(e) => setOptionsOpen(e.currentTarget.open)}><summary>{t("连接选项与备用中转（可选）")}</summary>{optionsOpen && <Suspense fallback={null}><PairingRouteOptions relays={relays} busy={busy} setRelays={setRelays}/></Suspense>}</details>
          </details>
          <button className="primary full" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <ShieldCheck size={17}/>}{busy ? t("正在请求连接…") : t("配对此设备")}</button>
        </>}
        {!manual && !expectedKey && <button type="button" className="pairing-manual full" disabled={busy} onClick={() => setManual(true)}>{t("手动连接与高级选项")}</button>}
      </form>
    </>}
    {error && <p role="alert" className="error-text">{error}</p>}
    <footer><ShieldCheck size={13} aria-hidden="true"/>{t("只有经过你确认的设备才能访问 Bot。")}</footer>
  </div>{!pending && <PairingIntro/>}</div>
  {scan && <Suspense fallback={null}><PairingScanner initialMode={inputMode} close={() => setScan(false)} receive={(payload) => {
    if (payload.kind !== "connect") throw new Error(t("请扫描已信任设备显示的 Hub 二维码"));
    if (!payload.invite) throw new Error(pairingInviteError("invite_required"));
    if (pending && identity && pendingConnection) {
      if (payload.hubPublicKey !== identity.hubPublicKey) throw new Error(t("这不是当前主机的二维码。请扫描此主机显示的连接二维码。"));
      if (admission.current) throw new Error(t("正在核对上一份申请，请稍候。"));
      admission.current = true; setBusy(true); setError("");
      const next: PendingPairing = { code: "", expiresAt: 0, request: { invite: payload.invite, requestId: randomNonce() } };
      void pendingConnection.cache.savePendingPairing(identity, next, { code: pending.code, requestId: pending.request?.requestId })
        .then(() => { identity.pendingPairing = next; pendingConnection.identity.pendingPairing = next; setNow(Date.now()); pendingConnection.refreshCache(); })
        .catch(() => setError(t("配对状态已变化，请重新检查连接。")))
        .finally(() => { admission.current = false; setBusy(false); });
      return;
    }
    setInvite(payload.invite);
    setDeployment(payload.deployment); setLegacyDirect(payload.routes.find((r) => r.name !== "VPS")); setAddress(payload.routes.find((r) => r.name !== "VPS")?.url ?? ""); setRelays(payload.routes.filter((r) => r.name === "VPS")); setExpectedKey(payload.hubPublicKey); setManual(false); setOptionsOpen(false); setError("");
  }}/></Suspense>}</main>;
}
