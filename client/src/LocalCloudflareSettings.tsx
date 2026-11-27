import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, Cloud, Copy, LoaderCircle, Play, Plus, Square, Trash2 } from "lucide-react";
import {
  cloudflareOriginSchema,
  cloudflareViewSchema,
  HOST_CLOUDFLARE_PATH,
  type CloudflareMode,
  type CloudflareProtocol,
  type CloudflareView,
} from "../../src/client-protocol/cloudflare.js";
import { MAX_CLOUDFLARE_ROUTES } from "../../src/client-protocol/routes.js";
import type { HubConnection } from "./connection.js";
import { writeClipboardText } from "./clipboard-write.js";
import { ConnectionInviteCode } from "./ConnectionInviteCode.js";
import { HubHttpError } from "./http-error.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { t, useLocale } from "./i18n.js";

function isUnsupportedHostError(cause: unknown): boolean {
  if (cause instanceof HubHttpError) return cause.status === 404 || cause.code === "not_found";
  return cause instanceof Error && (cause.message === "not_found" || cause.message === "404");
}

function saveErrorMessage(cause: unknown): string {
  if (cause instanceof HubHttpError) {
    if (cause.code === "local_controller_required") return t("仅主机本机的已登记控制器可修改 Cloudflare 隧道配置，请在这台主机上操作。");
    if (cause.code.startsWith("device_action_")) return t("设备签名验证未完成或已过期，请重试。");
    if (cause.status === 401 || cause.status === 403) return t("当前设备没有修改 Cloudflare 隧道配置的权限，请重新连接后重试。");
    if (cause.status === 404 || cause.code === "not_found") return t("此主机需要更新后才能设置 Cloudflare 隧道。");
  }
  return t("保存失败，请确认地址为公网 HTTPS 域名且未重复。");
}

function quickTunnelErrorMessage(cause: unknown): string {
  const code = cause instanceof HubHttpError ? cause.code : cause instanceof Error ? cause.message : "";
  if (code === "local_controller_required") return t("仅主机本机的已登记控制器可修改 Cloudflare 隧道配置，请在这台主机上操作。");
  if (code.startsWith("device_action_")) return t("设备签名验证未完成或已过期，请重试。");
  if (code.includes("cloudflared_not_installed")) return t("未检测到 cloudflared，请先在主机安装 cloudflared（例如 brew install cloudflared）。");
  if (code.includes("cloudflared_start_timeout")) return t("Quick Tunnel 启动超时，请检查网络连接或切换为 HTTP/2（--protocol http2）后重试。");
  if (code.includes("cloudflared_stopped")) return t("Quick Tunnel 已停止。");
  return t("Quick Tunnel 操作失败，请检查网络连接或切换为 HTTP/2（--protocol http2）后重试。");
}

/** First-class DIY Cloudflare Tunnel entry on the Host (zero hosted relay cost).
 * Lets the owner detect cloudflared, choose Quick vs Named Tunnel and HTTP/2 vs QUIC,
 * run a loopback-only Quick Tunnel or save Named Tunnel HTTPS origins for edge-identity verification. */
export function LocalCloudflareSettings({ connection, dirtyChange, busyChange }: { connection: HubConnection; dirtyChange: (dirty: boolean) => void; busyChange: (busy: boolean) => void }) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const available = state.status === "online" && state.cloudflareRoutesAvailable === true && state.user?.role === "owner";
  const [view, setView] = useState<CloudflareView>();
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<CloudflareMode>("named");
  const [protocol, setProtocol] = useState<CloudflareProtocol>("http2");
  const [origins, setOrigins] = useState<string[]>([]);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<string>();
  const [shareUrl, setShareUrl] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [connection]);

  const applyView = (next: CloudflareView) => {
    setView(next);
    setMode(next.mode);
    setProtocol(next.protocol);
    setOrigins(next.origins);
    setBaseline(JSON.stringify({ mode: next.mode, protocol: next.protocol, origins: next.origins }));
  };

  useEffect(() => {
    if (!available) { setLoading(false); setError(""); setNotice(""); return; }
    let active = true;
    setLoading(true);
    setUnsupported(false);
    setError("");
    void connection.http(HOST_CLOUDFLARE_PATH).then(raw => {
      if (!active) return;
      applyView(cloudflareViewSchema.parse(raw));
    }).catch((cause: unknown) => {
      if (!active) return;
      if (isUnsupportedHostError(cause)) setUnsupported(true);
      else setError(t("未能读取 Cloudflare 隧道配置，请重试。"));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection, available, attempt]);

  const dirty = !!view && JSON.stringify({ mode, protocol, origins }) !== baseline;
  useLayoutEffect(() => { dirtyChange(dirty); }, [dirty, dirtyChange]);
  useLayoutEffect(() => { busyChange(busy); }, [busy, busyChange]);
  useLayoutEffect(() => () => { dirtyChange(false); busyChange(false); }, [dirtyChange, busyChange]);

  const copyCommand = async (key: string, text: string) => {
    try { await writeClipboardText(text); setCopied(key); setTimeout(() => { if (mounted.current) setCopied(prev => prev === key ? undefined : prev); }, 2000); }
    catch { setError(t("复制失败，请手动选中命令复制。")); }
  };

  const save = async () => {
    if (busy || !available || unsupported) return;
    setError(""); setNotice("");
    const cleaned = origins.map(item => item.trim()).filter(Boolean);
    const normalized: string[] = [];
    for (const rawOrigin of cleaned) {
      const parsed = cloudflareOriginSchema.safeParse(rawOrigin);
      if (!parsed.success) {
        setError(t("Cloudflare Tunnel 必须使用公网 HTTPS 地址（不能使用 HTTP 或本机回环地址）。"));
        return;
      }
      if (normalized.includes(parsed.data)) {
        setError(t("保存失败，请确认地址为公网 HTTPS 域名且未重复。"));
        return;
      }
      normalized.push(parsed.data);
    }
    setBusy(true);
    try {
      const updated = await connection.updateCloudflareSettings({ mode, protocol, origins: normalized });
      if (!mounted.current) return;
      applyView(updated);
      setNotice(t("Cloudflare 隧道配置已保存。已授权域名可在配对和远程访问时通过身份验证。"));
    } catch (cause) {
      if (mounted.current) {
        if (isUnsupportedHostError(cause)) setUnsupported(true);
        else setError(saveErrorMessage(cause));
      }
    } finally { if (mounted.current) setBusy(false); }
  };

  const toggleQuick = async (action: "start" | "stop") => {
    if (busy || !available || unsupported) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await connection.cloudflareQuickAction({ action, protocol });
      if (!mounted.current) return;
      // Preserve unsaved domain edits while updating live runtime status and baseline.
      setView(updated);
      setBaseline(JSON.stringify({ mode: updated.mode, protocol: updated.protocol, origins: updated.origins }));
      if (action === "start") {
        setMode(updated.mode);
        setProtocol(updated.protocol);
      }
      setNotice(action === "start" ? t("Quick Tunnel 已启动，可使用下方临时 HTTPS 地址或二维码测试连接。") : t("Quick Tunnel 已停止。"));
    } catch (cause) {
      if (mounted.current) {
        if (isUnsupportedHostError(cause)) setUnsupported(true);
        else setError(quickTunnelErrorMessage(cause));
      }
    } finally { if (mounted.current) setBusy(false); }
  };

  const recommendedCommand = view
    ? (mode === "named"
        ? (protocol === "http2" ? view.commands.namedHttp2 : view.commands.namedQuic)
        : (protocol === "http2" ? view.commands.quickHttp2 : view.commands.quickQuic))
    : "";
  const shareableUrls = view ? [...new Set([...(view.activeUrl ? [view.activeUrl] : []), ...view.origins])] : [];

  return <section className="local-cloudflare-settings" aria-label={t("自建 Cloudflare 隧道（DIY）")}>
    <SettingsGroupHeading>{t("自建 Cloudflare 隧道（DIY）")}</SettingsGroupHeading>
    <p className="settings-note">{t("使用你自己的 cloudflared 与 Cloudflare 免费隧道暴露本机，无需公网 IP 或自购 VPS；与局域网、Tailscale 和自建 VPS 可同时保留。")}</p>

    {!available || unsupported ? <p role="status">{
      state.status !== "online" ? t("请等待本机连接恢复后设置 Cloudflare 隧道。")
      : !state.user ? t("正在读取主机管理权限…")
      : state.user.role !== "owner" ? t("需要主机所有者权限才能设置 Cloudflare 隧道。")
      : state.cloudflareRoutesAvailable === false || unsupported ? t("此主机需要更新后才能设置 Cloudflare 隧道。")
      : t("正在读取 Cloudflare 隧道能力…")
    }</p>
      : loading ? <p role="status"><LoaderCircle className="spin" size={15}/> {t("正在检测 cloudflared 状态…")}</p>
      : view ? <>
        <div className="cf-status-bar">
          <span className="cf-status-pill" data-ok={view.installed || undefined}><Cloud size={14} aria-hidden="true"/> {view.installed ? t("已检测到 cloudflared") : t("未检测到 cloudflared")}</span>
          {view.version && <small className="muted">{view.version}</small>}
          {view.running && <span className="cf-status-pill is-running">{t("Quick Tunnel 运行中")}</span>}
        </div>

        <div className="cf-controls-grid">
          <fieldset className="cf-mode-group" disabled={busy}>
            <legend>{t("隧道模式")}</legend>
            <div className="cf-segmented" role="group" aria-label={t("隧道模式")}>
              <button type="button" aria-pressed={mode === "named"} onClick={() => setMode("named")}>{t("Named Tunnel（固定域名）")}</button>
              <button type="button" aria-pressed={mode === "quick"} onClick={() => setMode("quick")}>{t("Quick Tunnel（临时测试）")}</button>
            </div>
            <p className="route-entry-help">{mode === "quick"
              ? t("免账号快速测试（*.trycloudflare.com）。注意：重启后地址会变化，上限 200 并发请求，且不支持 SSE。")
              : t("使用自己的 Cloudflare 免费账号与域名获取稳定固定地址（单账号免费支持最多 1,000 条隧道，可搭配 Cloudflare Access）。")}</p>
          </fieldset>

          <fieldset className="cf-mode-group" disabled={busy}>
            <legend>{t("传输协议")}</legend>
            <div className="cf-segmented" role="group" aria-label={t("传输协议")}>
              <button type="button" aria-pressed={protocol === "http2"} onClick={() => setProtocol("http2")}>{t("HTTP/2（推荐 · TCP/443）")}</button>
              <button type="button" aria-pressed={protocol === "quic"} onClick={() => setProtocol("quic")}>{t("QUIC（UDP/7844）")}</button>
            </div>
            <p className="route-entry-help">{t("中国大陆运营商及严格企业防火墙常限速或阻断 UDP/7844，推荐显式使用 --protocol http2（TCP/443）。")}</p>
          </fieldset>
        </div>

        <div className="cf-command-box">
          <div className="cf-command-head">
            <strong>{t("主机启动命令（仅指向本机回环地址）")}</strong>
            <button type="button" onClick={() => void copyCommand("cmd", recommendedCommand)}>
              {copied === "cmd" ? <Check size={14}/> : <Copy size={14}/>} {copied === "cmd" ? t("已复制") : t("复制命令")}
            </button>
          </div>
          <code>{recommendedCommand}</code>
        </div>

        {mode === "quick" && <div className="cf-quick-actions">
          {view.running
            ? <button type="button" className="secondary" disabled={busy} onClick={() => void toggleQuick("stop")}><Square size={14}/> {t("停止 Quick Tunnel")}</button>
            : <button type="button" className="secondary" disabled={busy || !view.installed} onClick={() => void toggleQuick("start")}>{busy ? <LoaderCircle className="spin" size={14}/> : <Play size={14}/>} {t("启动 Quick Tunnel")}</button>}
          {view.activeUrl && <code className="cf-active-url">{view.activeUrl}</code>}
        </div>}

        <div className="cf-origins-editor">
          <div className="cf-command-head">
            <strong>{t("已授权的 Cloudflare HTTPS 入口")}</strong>
            <button type="button" className="secondary" disabled={busy || origins.length >= MAX_CLOUDFLARE_ROUTES} onClick={() => setOrigins([...origins, ""])}>
              <Plus size={14}/> {t("添加域名")}
            </button>
          </div>
          <p className="route-entry-help">{t("只有在这里授权（或当前主机正在运行的 Quick Tunnel）的 HTTPS 域名，主机才会签发边缘身份证明；防止任意第三方代理转发冒充。")}</p>
          {origins.map((origin, index) => <div className="direct-route-entry" key={index}>
            <input type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={2048}
              aria-label={t("Cloudflare 域名 {0}", index + 1)} placeholder="https://hub.example.com"
              value={origin} disabled={busy} onChange={e => { setOrigins(origins.map((v, i) => i === index ? e.target.value : v)); setError(""); }}/>
            <button type="button" className="icon-button" disabled={busy} aria-label={t("移除 Cloudflare 域名 {0}", index + 1)} onClick={() => { setOrigins(origins.filter((_, i) => i !== index)); setError(""); }}><Trash2 size={16}/></button>
          </div>)}
          <div className="route-save-bar">
            <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t("正在保存…") : t("保存 Cloudflare 配置")}</button>
          </div>
        </div>

        {shareableUrls.length > 0 && <ol className="saved-routes">
          {shareableUrls.map((url, index) => <li key={url}>
            <span className="saved-route-index" aria-hidden="true">{index + 1}</span>
            <div><strong>{url === view.activeUrl ? t("Cloudflare Quick Tunnel") : "Cloudflare Tunnel"}</strong><span>{url}</span></div>
            <button type="button" onClick={() => setShareUrl(shareUrl === url ? undefined : url)}>{shareUrl === url ? t("收起连接码") : t("连接码")}</button>
          </li>)}
        </ol>}

        {shareUrl && shareableUrls.includes(shareUrl) && <div className="local-relay-share">
          <ConnectionInviteCode connection={connection} payload={{ v: 1, kind: "connect", hubPublicKey: connection.identity.hubPublicKey!, routes: [{ name: "Cloudflare", url: shareUrl }], deployment: "computer" }}/>
        </div>}

        <p className="cf-expectation-note">{t("延迟与场景说明：Cloudflare 免费线路经由境外 Anycast 节点（中国大陆通常增加约 150–350 ms 往返延迟），适合聊天、Bot 控制、通知和 CLI 工作流；高帧率远程屏幕控制建议优先使用局域网、Tailscale 直连或就近自建 VPS。")}</p>
      </> : null}

    {available && !unsupported && error && <p role="alert" className="error-text">{error}{!view && <> <button type="button" onClick={() => setAttempt(v => v + 1)}>{t("重试")}</button></>}</p>}
    {available && !unsupported && notice && <p role="status" className="settings-feedback">{notice}</p>}
  </section>;
}
