import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsScope } from "./SettingsParts.js";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AudioLines, Check, ChevronRight, Cloud, Info, RefreshCw } from "lucide-react";
import { voiceSettingsSchema, voiceSettingsUpdateSchema, type VoiceSettingsState, type VoiceSettingsUpdate, type VoiceRoutingMode } from "../../src/client-protocol/voice-settings.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { LocalAsrSetup } from "./LocalAsrSetup.js";
import { voiceThresholdSeconds } from "./voice-settings-threshold.js";
import { t, useLocale } from "./i18n.js";
import "./voice-settings.css";

type Draft = { mode: VoiceRoutingMode; adapterId: string; minutes: string; consent: boolean };
const draftOf = (view: VoiceSettingsState): Draft => ({ mode: view.mode, adapterId: view.adapterId, minutes: String(view.thresholdSeconds / 60), consent: false });
const matches = (view: VoiceSettingsState, command: VoiceSettingsUpdate) => view.mode === command.mode && view.adapterId === command.adapterId && view.thresholdSeconds === command.thresholdSeconds;

/** One owner-approved host policy. The key and receipt are host-scoped and
 * contain no API credentials; no write is retried automatically. */
export function VoiceSettings({ connection, active, onDirty, onBusy }: {
  connection: HubConnection; active: boolean; onDirty: (value: boolean) => void; onBusy: (value: boolean) => void;
}) {
  useLocale();
  const hostName = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const key = `tarobot.voice-settings.${connection.identity.hubPublicKey}`;
  const [view, setView] = useState<VoiceSettingsState>(), [draft, setDraft] = useState<Draft>();
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPendingState] = useState<VoiceSettingsUpdate | undefined>(() => {
    try { return voiceSettingsUpdateSchema.parse(JSON.parse(localStorage.getItem(key) ?? "null")); } catch { return undefined; }
  });
  const pendingRef = useRef(pending), live = useRef(true), epoch = useRef(0), working = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const online = state.status === "online", owner = state.user?.role === "owner", supported = state.voiceSettingsAvailable === true;
  const dirty = !!pending || !!(view && draft && (view.mode !== draft.mode || view.adapterId !== draft.adapterId || view.thresholdSeconds !== voiceThresholdSeconds(draft.minutes) || (!view.managed && draft.consent)));
  const savePending = (value?: VoiceSettingsUpdate) => {
    pendingRef.current = value; setPendingState(value);
    try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* Keep in-memory receipt if storage is unavailable. */ }
  };
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => () => { onDirty(false); onBusy(false); }, [onDirty, onBusy]);
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++; controller.current?.abort(); }; }, []);
  const operation = async (write?: VoiceSettingsUpdate) => {
    if (working.current || !online || !owner || !supported) return;
    working.current = true; setBusy(true); setUnavailable(false); setError(""); setNotice("");
    const generation = ++epoch.current, abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15_000);
    const valid = () => live.current && epoch.current === generation;
    try {
      if (write) {
        savePending(write);
        await connection.http("/api/integrations/voice", { method: "PUT", body: JSON.stringify(write), signal: abort.signal });
      }
      const expected = pendingRef.current;
      const fresh = voiceSettingsSchema.parse(await connection.http(`/api/integrations/voice${expected ? `?requestId=${expected.requestId}` : ""}`, { signal: abort.signal }));
      if (!valid()) return;
      setView(fresh);
      if (expected) {
        if (fresh.receipt?.requestId === expected.requestId) {
          savePending(); setDraft(draftOf(fresh));
          setNotice(fresh.receipt.revision === fresh.revision && matches(fresh, expected)
            ? fresh.workersNeedingUpdate.length ? t("已保存并核对，部分 Bot 后台尚未接入此设置。") : t("已保存并核对，从下一条语音生效。") : t("上次保存已收到，但设置随后有变化。下方显示主机的最新设置。"));
        } else { setDraft(draftOf(fresh)); setError(t("尚未确认上次保存结果。可重新核对，或使用同一请求重试。")); }
      } else { setDraft(draftOf(fresh)); }
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof HubHttpError && [400, 401, 403, 404, 409].includes(failure.status)) {
        savePending();
        setError(failure.status === 404 ? t("请更新主机后使用语音转写设置。") : failure.status === 409 ? t("配置或版本已变化，请放弃修改并重新载入。") : t("设置未获主机确认，请检查权限与配置后重新载入。"));
      } else if (failure instanceof HubHttpError && failure.code.startsWith("voice_settings_unavailable")) {
        setUnavailable(true);
        setError(failure.code.endsWith("_future") ? t("此语音配置由更新版本写入，请更新主机。原配置未被重置。") : failure.code.endsWith("_permissions") ? t("语音配置文件的属主或访问权限不符合要求，请在主机上检查。原配置未被重置。") : failure.code.endsWith("_format") ? t("语音配置文件格式无效，请先备份并在主机上修复。原配置未被重置。") : failure.code.endsWith("_oversized") ? t("语音配置文件超过大小上限，请先备份并在主机上检查。原配置未被重置。") : failure.code.endsWith("_file") ? t("语音配置必须是普通文件，不能使用符号链接。原配置未被重置。") : t("主机语音配置无法安全读取，请检查配置文件、权限或主机版本。原配置未被重置。"));
      } else setError(pendingRef.current ? t("尚未确认上次保存结果。可重新核对，或使用同一请求重试。") : t("暂时无法读取语音设置，请重试。"));
    } finally {
      clearTimeout(timer);
      if (valid()) { working.current = false; setBusy(false); }
    }
  };
  useEffect(() => { epoch.current++; controller.current?.abort(); working.current = false; setBusy(false); }, [online, owner, supported]);
  // Opening/reconnecting reads current state. A dirty draft must not be replaced
  // by an unsolicited refresh, including while browsing another settings page.
  useEffect(() => { if (active && online && owner && supported && (!dirty || !!pendingRef.current || !view)) void operation(); }, [active, online, owner, supported]);
  if (!owner) return <p>{t("只有主机所有者可以管理语音转写。")}</p>;
  const selected = view?.adapters.find(adapter => adapter.id === draft?.adapterId);
  const requestedSeconds = voiceThresholdSeconds(draft?.minutes ?? "");
  // The threshold is dormant in fixed modes. An unsupported legacy threshold
  // must never trap someone who wants to turn cloud off.
  const seconds = draft?.mode === "auto" ? requestedSeconds : Number.isInteger(requestedSeconds) && requestedSeconds >= 60 && requestedSeconds <= 7200 ? requestedSeconds : 900;
  const requiresConsent = !!(view && draft && draft.mode !== "local" && (!view.managed || view.mode === "local" || view.adapterId !== draft.adapterId || (view.mode === "auto" && (draft.mode === "cloud" || seconds < view.thresholdSeconds))));
  const consent = !!draft && draft.mode !== "local" && (!requiresConsent || draft.consent);
  const canSave = !busy && online && supported && (dirty || !view?.managed) && !pending && !error && !!view && !!draft && Number.isInteger(seconds) && seconds >= 60 && seconds <= 7200 && (draft.mode === "local" || (consent && selected?.ready));
  return <div className="voice-settings">
    <SettingsScope kind="host" host={hostName}/>
    <p className="voice-settings-intro">{t("设置作用于当前主机的所有 Bot，手机无需安装模型。")}</p>
    <section className="voice-cloud" aria-label={t("转写方式")}>
      <header><AudioLines size={20}/><div><h3>{t("转写方式")}</h3><p>{t("短语音与长录音统一设置")}</p></div><button type="button" className="icon" aria-label={t("刷新语音设置")} disabled={busy || !online || !supported || dirty} onClick={() => void operation()}><RefreshCw size={17}/></button></header>
      {!supported ? <p>{t("请更新主机后使用语音转写设置。")}</p> : <>
        {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
        {!view && !error && <p>{t("正在读取语音设置…")}</p>}
        {view && draft && <>
          <fieldset className="voice-modes"><legend className="sr-only">{t("转写方式")}</legend>
            {([
              ["local", t("全部本地"), t("录音不上传云端")],
              ["cloud", t("全部云端"), t("所有录音使用通义听悟")],
              ["auto", t("按时长自动选择"), t("短语音本地，长录音云端")],
            ] as const).map(([mode, title, detail]) => <label key={mode} className={draft.mode === mode ? "selected" : ""}><input type="radio" name="voice-routing-mode" value={mode} checked={draft.mode === mode} disabled={busy || !online || !!pending} onChange={() => { setDraft({ ...draft, mode, consent: false }); setNotice(""); }}/><span><strong>{title}</strong><small>{detail}</small></span></label>)}
          </fieldset>
          {view.legacyModeInvalid && <p role="status">{t("旧配置的转写方式无法识别，已按全部本地处理。保存后将使用这里选择的方式。")}</p>}
          {!view.managed && <p className="voice-readiness">{t("保存前，各 Bot 可能沿用各自的语音配置；保存后由当前主机统一管理。")}</p>}
          {draft.mode === "auto" && <div className="voice-setting-row"><label htmlFor="voice-threshold">{t("长语音起点")}<small>{t("达到此时长使用云端，短于此时长使用本地")}</small></label><div className="voice-duration"><input id="voice-threshold" type="number" min="1" max="120" step="any" value={draft.minutes} disabled={busy || !online || !!pending} onChange={event => { setDraft({ ...draft, minutes: event.target.value, consent: false }); setNotice(""); }}/><span>{t("分钟")}</span></div></div>}
          {draft.mode !== "local" && <>
          <div className="voice-provider">
          <div className="voice-provider-heading"><span className="voice-provider-icon"><Cloud size={19} aria-hidden="true"/></span><div><strong>{t("通义听悟")}</strong><span className="voice-provider-caption">{t("阿里云 · 云端转写")}</span></div><span className={`voice-config-badge ${selected?.ready ? "detected" : "incomplete"}`}>{selected?.ready ? t("已检测到配置") : t("待配置")}</span></div>
          <p className="voice-provider-status">{selected?.ready ? t("本机配置完整；云端可用性以实际转写为准。") : t("通义配置尚未就绪，补齐后才能启用。")}</p>
          <details className="voice-adapter-details"><summary data-disclosure-icon><span>{t("查看接入配置")}</span><ChevronRight size={15} aria-hidden="true"/></summary><div className="voice-adapter-content">
            <label>{t("主机上的通义配置")}<select aria-label={t("主机上的通义配置")} value={draft.adapterId} disabled={busy || !online || !!pending} onChange={event => { setDraft({ ...draft, adapterId: event.target.value, consent: false }); setNotice(""); }}>
              {view.adapters.map(adapter => <option key={adapter.id} value={adapter.id}>{adapter.source === "legacy" ? t("兼容配置位置") : adapter.source === "standard" ? t("标准安装位置") : t("当前配置位置")}{adapter.ready ? ` · ${t("已就绪")}` : ` · ${t("待配置")}`}</option>)}
            </select></label>
            {selected && <><code>{selected.directory}</code><ul>{[[t("转写脚本"), selected.script], [t("Python 环境"), selected.python], [t("私有凭据文件"), selected.credentials], [t("安装位置"), selected.private]].map(([label, ok]) => <li key={String(label)}><span>{label}</span><span>{ok ? t("已检测到") : t("待检查")}</span></li>)}</ul></>}
            {selected && !selected.permissionsVerified && <p>{t("Windows 文件权限需在主机上核对；此处仅确认文件和位置。")}</p>}
            <p>{t("这里只检查文件与权限，不读取或展示密钥。API 是否可用需实际转写验证。")}</p>
          </div></details>
          {!selected?.ready && <p>{t("可在「Skills 与 MCP → 语音与搜索建议」选择通义听悟，让 Bot 协助准备配置。密钥只填写在主机私有配置中，不要发送到聊天。")}</p>}
          </div>
          <div className="voice-upload-policy"><Info size={16} aria-hidden="true"/><div>
          <strong>{t("上传与费用")}</strong>
          <p>{draft.mode === "cloud" ? t("所有语音上传阿里云 OSS 与通义听悟，可能产生费用。") : t("达到设定时长的语音上传阿里云 OSS 与通义听悟，可能产生费用。")}</p>
          <p>{draft.mode === "cloud" ? t("云端失败时显示错误，不自动切回本地。") : t("云端失败时回退本地；取消任务不会重新转写。")}</p>
          {requiresConsent ? <label className="voice-consent"><input type="checkbox" checked={draft.consent} disabled={busy || !online || !!pending} onChange={event => setDraft({ ...draft, consent: event.target.checked })}/><span>{t("我同意将符合条件的语音上传云端，并了解可能产生费用。")}</span></label> : <details className="voice-consent-details"><summary data-disclosure-icon><Check size={14} aria-hidden="true"/>{t("已允许此范围的云端上传")}<ChevronRight size={14} aria-hidden="true"/></summary><p>{t("若需停止上传，请选择全部本地并保存。")}</p></details>}
          </div></div>
          </>}
          {draft.mode === "local" && <p className="voice-privacy">{t("所有语音由本地主机转写，长录音会分段处理。需要本地语音服务可用。")}</p>}
          {view.workersNeedingUpdate.length > 0 && <p role="status">{t("以下 Bot 后台尚未接入主机语音设置。仍可能沿用旧的上传设置。请在任务结束后，更新后台并通过当前主机启动：{0}", view.workersNeedingUpdate.map(bot => bot.name).join("、"))}</p>}
          {dirty && !pending && (!Number.isInteger(seconds) || seconds < 60 || seconds > 7200) && <p role="alert">{t("请输入 1 至 120 分钟。")}</p>}
        </>}
        {error && <p role="alert">{error}</p>}
        {pending && <p role="status">{pending.mode === "auto" ? pending.thresholdSeconds % 60 === 0 ? t("待核对的保存请求：{0}，长语音起点 {1} 分钟。重试只会提交这份设置。", t("按时长自动选择"), String(pending.thresholdSeconds / 60)) : t("待核对的保存请求：{0}，长语音起点 {1} 秒。重试只会提交这份设置。", t("按时长自动选择"), String(pending.thresholdSeconds)) : t("待核对的保存请求：{0}。重试只会提交这份设置。", pending.mode === "local" ? t("全部本地") : t("全部云端"))}</p>}
        {pending && unavailable && <button type="button" className="secondary" disabled={busy} onClick={() => { savePending(); if (view) setDraft(draftOf(view)); setNotice(t("已放弃本机核对记录，不会撤销主机上已经保存的设置。")); }}>{t("放弃本机核对记录")}</button>}
        <footer>
          {notice && <p className="voice-save-notice" role="status">{notice === t("已保存并核对，从下一条语音生效。") ? <Check size={16} aria-hidden="true"/> : <Info size={16} aria-hidden="true"/>}<span>{notice}</span></p>}
          <div className="voice-actions">
          <button type="button" className="secondary" disabled={busy || !online} onClick={() => void operation()}>{busy ? t("正在核对…") : pending ? t("重新核对") : dirty ? t("放弃修改并重新载入") : t("重新载入")}</button>
          {pending ? <button type="button" className="primary" disabled={busy || !online} onClick={() => void operation(pending)}>{t("重试上次保存")}</button> : <button type="button" className="primary" disabled={!canSave} onClick={() => { if (view && draft) void operation({ requestId: crypto.randomUUID(), revision: view.revision, mode: draft.mode, adapterId: draft.adapterId, thresholdSeconds: seconds, cloudConsent: consent }); }}>{busy ? t("正在保存并核对…") : t("保存语音设置")}</button>}
          </div>
        </footer>
      </>}
    </section>
    {active && draft?.mode !== "cloud" && <LocalAsrSetup connection={connection}/>}
  </div>;
}
