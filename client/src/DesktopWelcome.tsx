import { defaultDeviceName } from "./device-presentation.js";
import { useEffect, useRef, useState } from "react";
import { invoke } from "./desktop-bridge.js";
import { ArrowLeft, ArrowRight, LoaderCircle, Monitor, Network, ShieldCheck } from "lucide-react";
import { BrandMark } from "./BrandScenes.js";
import type { PairingProps } from "./HostApp.js";
import { createIdentity } from "./identity.js";
import { cache, type Identity } from "./storage.js";
import { deleteNativeIdentity, nativePlatform } from "./native.js";
import { t } from "./i18n.js";
import { hostNameSchema } from "../../src/client-protocol/host-profile.js";
import { startupAttempt } from "./startup-diagnostics.js";
import { localControllerMessage } from "./local-controller-message.js";
import type { LocalControllerIssue } from "./local-controller.js";
import "./desktop-host.css";

export type DesktopHostStatus = { available: boolean; running: boolean; url?: string; publicKey?: string; hostName?: string; directoryState?: string };
export function DesktopWelcome({ remote, connected, save, beforePair, discard, cancel, pending = false, localHostReady = false }: PairingProps & { remote: () => void; pending?: boolean; localHostReady?: boolean }) {
  const [joiningExisting, setJoiningExisting] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [hostName, setHostName] = useState(() => defaultDeviceName(nativePlatform()));
  const nameEdited = useRef(false);
  useEffect(() => {
    let active = true;
    void invoke<DesktopHostStatus>("desktop_host", { action: "status" }).then(host => {
      const name = hostNameSchema.safeParse(host?.hostName);
      if (active && !nameEdited.current && name.success) setHostName(name.data);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const start = async (joinExisting = false) => {
    const name = hostNameSchema.safeParse(hostName);
    if (!name.success || busy) return;
    nameEdited.current = true;
    setJoiningExisting(joinExisting); setBusy(true); setError(""); let device: Identity | undefined;
    try {
      const host = await invoke<DesktopHostStatus>("desktop_host", { action: "start", device: { hostName: name.data } });
      if (!host.running || !host.url || !host.publicKey) throw new Error(`desktop_host_operation_failed${host.directoryState ? `|reason=state_${host.directoryState}` : ""}`);
      const authoritativeName = hostNameSchema.safeParse(host.hostName);
      const savedName = authoritativeName.success ? authoritativeName.data : name.data;
      await beforePair?.(host.publicKey);
      device = await createIdentity(savedName, [{ name: "Direct", url: host.url }]);
      device.hubPublicKey = host.publicKey; device.deployment = "computer";
      await invoke("desktop_host", { action: "pair", device: { deviceId: device.deviceId, keyRef: device.keyRef, name: device.name, platform: device.platform, publicKey: device.publicKey } });
      if (save) await save(device, savedName); else await cache.saveIdentity(device);
      if (joinExisting) remote();
      else await connected(device);
    } catch (e) {
      if (device) { if (discard) await discard(device).catch(() => undefined); else if (device.keyRef) await deleteNativeIdentity(device.keyRef).catch(() => undefined); }
      const diagnostic = startupAttempt("start", e), directoryIssue = diagnostic.reason?.startsWith("state_") && diagnostic.reason !== "state_validation_failed" ? diagnostic.reason.slice(6) as LocalControllerIssue : undefined;
      setError(directoryIssue ? localControllerMessage(directoryIssue) : String(e).includes("runtime_missing") ? t("此安装包缺少主机组件，请下载包含主机的桌面版本。") : e instanceof Error && !e.message.startsWith("desktop_host_") ? e.message : t("主机未能启动，请重试。已有数据不会被覆盖。"));
    } finally { setBusy(false); }
  };
  return <main className="pairing-page"><section className="pairing-card desktop-welcome"><BrandMark/>
    <header className="pairing-heading"><h1>{t("从这台电脑开始")}</h1><p>{t("给这台电脑起个名字。即使还没有 Bot，也可以加入已有网络。")}</p></header>
    <div className="desktop-host-name">
      <label htmlFor="desktop-host-name">{t("主机名称")}</label>
      <input id="desktop-host-name" value={hostName} maxLength={100} required autoComplete="off" disabled={busy || localHostReady} aria-describedby="desktop-host-name-help" onChange={event => { nameEdited.current = true; setHostName(event.target.value); }}/>
      <small id="desktop-host-name-help">{t("其他设备会用这个名称识别 Bot 所在的主机。")}</small>
    </div>
    <div className="host-choices">
      <button type="button" className="host-role host-role-primary" aria-label={t("将这台电脑设为主机")} disabled={busy || localHostReady && !cancel || !hostNameSchema.safeParse(hostName).success} onClick={() => { if (localHostReady) cancel?.(); else void start(); }}>
        <span className="host-role-icon" aria-hidden="true"><Monitor size={24} strokeWidth={1.6}/></span>
        <span className="host-role-copy"><strong>{busy && !joiningExisting ? t("正在准备主机…") : localHostReady ? t("返回本机") : t("将这台电脑设为主机")}</strong><small>{t("运行 Bot 前，请先在本机安装 AI 命令行工具（CLI），如 Codex 或 Claude Code，并完成登录或 API 密钥配置。")}</small><span className="host-role-action">{busy && !joiningExisting ? t("首次启动可能需要一点时间") : t("开始使用")}{busy && !joiningExisting ? <LoaderCircle className="spin" size={16}/> : <ArrowRight size={16}/>}</span></span>
      </button>
      <button type="button" className="host-role" aria-label={pending ? t("继续连接已有主机") : t("连接已有主机")} disabled={busy || !pending && !localHostReady && !hostNameSchema.safeParse(hostName).success} onClick={() => { if (pending || localHostReady) remote(); else void start(true); }}>
        <span className="host-role-icon" aria-hidden="true"><Network size={24} strokeWidth={1.6}/></span>
        <span className="host-role-copy"><strong>{busy && joiningExisting ? t("正在准备这台电脑…") : pending ? t("继续连接已有主机") : t("连接已有主机")}</strong><small>{pending ? t("配对信息已保留，可以继续确认连接。") : t("先准备本机，再用手机确认连接，最后确认加入网络。没有 Bot 也能加入；以后可在这台电脑运行 Bot。")}</small></span>{busy && joiningExisting ? <LoaderCircle className="spin" size={18}/> : <ArrowRight size={18} aria-hidden="true"/>}
      </button>
    </div>
    {error && <><p role="alert" className="error-text">{error}</p><button type="button" disabled={busy} onClick={remote}>{t("先连接已有主机")}</button><p className="muted">{t("此方式先使用远程 Bot，本机尚未加入网络；准备好本机后可继续加入。")}</p></>}
    <p className="host-welcome-note">{t("运行 Bot 的主机需保持在线。手机和仅连接已有主机的电脑无需安装 CLI。")}</p>
    <footer><ShieldCheck size={14} aria-hidden="true"/>{t("只有经过你确认的设备才能访问 Bot。")}</footer>
    {cancel && <button type="button" className="pairing-host-cancel pairing-return-conversations" disabled={busy} onClick={cancel}><ArrowLeft size={16} aria-hidden="true"/>{t("返回会话")}</button>}
  </section></main>;
}
