import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AudioLines, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { asrJobSchema, asrStateSchema, type AsrState } from "../../src/client-protocol/asr-setup.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import "./local-asr-setup.css";

const phaseName = (phase?: string) => ({ checking: t("检查环境"), dependencies: t("安装语音依赖"), model: t("准备语音模型"), installing: t("安装转写服务"), service: t("启动语音服务"), completed: t("安装已完成") }[phase ?? ""] ?? t("正在准备"));
const errorName = (error?: string) => ({
  python_312_required: t("主机需要 Python 3.12，请先安装后重试。"), ffmpeg_required: t("主机需要 ffmpeg 和 ffprobe，请先安装后重试。"),
  insufficient_disk_space: t("主机存储空间不足，请释放空间或让 Bot 协助选择安装位置。"),
  service_port_in_use: t("语音端口已有服务运行。请先核对现有服务，安装器不会停止它。"),
  service_already_registered: t("已有语音后台服务配置，请先核对服务状态。"), installation_busy: t("另一个安装任务正在运行，请稍后刷新。"),
  installation_interrupted: t("上次安装已中断。请先刷新核对服务状态，再决定是否重试。"),
  configured_model_incomplete: t("已配置的模型不完整，请让 Bot 协助检查。"),
  service_manager_unavailable: t("当前主机会话无法注册后台服务。Mac 请登录桌面后重试；Linux 请先启用当前用户的 systemd 会话。"),
  service_start_timeout: t("服务未能在预期时间内启动，请检查主机安装日志。"),
}[error ?? ""] ?? t("安装未完成，请检查主机的 ASR 安装日志后重试。"));

export function LocalAsrSetup({ connection }: { connection: HubConnection }) {
  useLocale();
  const state = useSyncExternalStore(f => connection.subscribe(f), () => connection.state);
  const [view, setView] = useState<AsrState>(), [error, setError] = useState(""), [confirm, setConfirm] = useState(false), [sending, setSending] = useState(false);
  const receiptKey = `tarobot.asr-install.${connection.identity.hubPublicKey}`;
  const [pending, setPending] = useState(() => { try { return localStorage.getItem(receiptKey) ?? ""; } catch { return ""; } });
  const pendingRef = useRef(pending);
  const savePending = (id: string) => {
    pendingRef.current = id; setPending(id);
    try { if (id) localStorage.setItem(receiptKey, id); else localStorage.removeItem(receiptKey); } catch { /* Server receipt still deduplicates this mount. */ }
  };
  const generation = useRef(0);
  const mounted = useRef(false), reading = useRef(false), writing = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const online = state.status === "online", owner = state.user?.role === "owner", supported = state.asrSetupAvailable === true;
  const refresh = async () => {
    if (!online || !owner || !supported || reading.current) return;
    const epoch = generation.current; reading.current = true; const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const fresh = asrStateSchema.parse(await connection.http("/api/integrations/asr", { signal: abort.signal }));
      if (mounted.current && generation.current === epoch) { setView(fresh); if (pendingRef.current && fresh.job?.requestId === pendingRef.current) savePending(""); setError(fresh.supported && fresh.error ? t("暂时无法核对语音服务状态，请刷新重试。") : ""); }
    } catch (failure) { if (mounted.current && generation.current === epoch) setError(failure instanceof HubHttpError && failure.status === 404 ? t("请更新主机后使用本地语音安装。") : t("暂时无法核对语音服务状态，请刷新重试。")); }
    finally { clearTimeout(timer); if (generation.current === epoch) reading.current = false; }
  };
  useEffect(() => {
    generation.current++; reading.current = false; mounted.current = true; setView(undefined); setError(""); setConfirm(false);
    void refresh(); const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5_000);
    return () => { generation.current++; mounted.current = false; clearInterval(timer); controller.current?.abort(); };
  }, [connection, online, owner, supported]);
  const install = async () => {
    if (writing.current || !online || !owner) return;
    const epoch = generation.current; writing.current = true; setSending(true); setConfirm(false); setError("");
    const requestId = pendingRef.current || crypto.randomUUID(); savePending(requestId);
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const job = asrJobSchema.parse(await connection.http("/api/integrations/asr/install", { method: "POST", body: JSON.stringify({ requestId, model: true, service: true }), signal: abort.signal }));
      if (mounted.current && generation.current === epoch) { savePending(""); setView(previous => previous ? { ...previous, job } : previous); }
      if (generation.current === epoch) await refresh();
    } catch { if (mounted.current && generation.current === epoch) setError(t("尚未确认安装请求的结果，请刷新查看；不会自动重复安装。")); }
    finally { clearTimeout(timer); writing.current = false; if (mounted.current) setSending(false); }
  };
  if (!owner) return null;
  const running = view?.job?.status === "running", ready = view?.running && view.managed;
  const registered = view?.autostart === "login" && !view.running;
  return <section className="local-asr-setup" aria-label={t("本地语音转写")}>
    <header><AudioLines size={18}/><strong>{t("本地语音转写")}</strong><button type="button" className="icon" aria-label={t("刷新语音服务状态")} onClick={() => void refresh()} disabled={!online || !supported}><RefreshCw size={16}/></button></header>
    {!supported ? <p>{t("请更新主机后使用本地语音安装。")}</p> : !online ? <p>{t("连接恢复后即可操作")}</p> : <>
      {!view && !error && <p>{t("正在检查语音服务…")}</p>}
      {view && <>
        <div className="asr-status-line">{ready ? <CheckCircle2 size={16}/> : running ? <LoaderCircle size={16} className="spin"/> : null}<span>{ready ? t("本地语音已启用") : view.legacyService ? t("检测到现有语音服务") : registered ? t("后台服务已注册，正在启动或暂时不可用") : running ? phaseName(view.job?.phase) : t("尚未启用本地语音")}</span></div>
        <dl><div><dt>{t("语音模型")}</dt><dd>{view.modelPresent ? t("已就绪") : t("未安装")}</dd></div><div><dt>{t("内存回收")}</dt><dd>{view.watchdog ? !view.watchdog.available ? t("看门狗不可用") : view.watchdog.enabled ? t("已开启") : t("已关闭") : t("待确认")}</dd></div>{view.watchdog?.memoryBytes != null && <div><dt>{t("当前内存")}</dt><dd>{(view.watchdog.memoryBytes / 1024 ** 3).toFixed(1)} GB</dd></div>}</dl>
        {view.job?.status === "running" && ready && <p role="status">{phaseName(view.job.phase)}</p>}
        {!ready && view.job && ["failed", "interrupted"].includes(view.job.status) && <p role="alert">{errorName(view.job.error)}</p>}
        {view.legacyService && <p>{t("现有语音服务可继续使用。如需交由 TaroBird 管理，请让 Bot 协助迁移。")}</p>}
        {!view.supported ? <p>{t("Windows 暂不支持一键安装此服务，可让 Bot 协助检查兼容环境。")}</p> : !registered && !view.legacyService && !ready && !running && !sending && !pending && !error && !confirm && <button type="button" onClick={() => setConfirm(true)}>{t("安装并启用本地语音")}</button>}
        {confirm && <div className="asr-confirm"><p>{view.modelPresent ? t("已检测到模型，将复用现有模型并启用当前用户后台服务。") : t("将在当前主机下载依赖和约 2 GB 模型，并启用当前用户后台服务。已有完整模型会复用，安装前会检查空间。")}</p><div><button type="button" className="primary" onClick={() => void install()}>{t("确认安装")}</button><button type="button" onClick={() => setConfirm(false)}>{t("取消")}</button></div></div>}
      </>}
    </>}
    {pending && !sending && online && supported && <div role="status"><p>{t("安装请求尚待确认，可刷新查看或用同一请求编号重试。")}</p><button type="button" onClick={() => void install()}>{t("确认上次安装请求")}</button></div>}
    {sending && <p role="status">{t("正在提交安装请求…")}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
