import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ENGINE_SETTINGS_REPAIR_HINT, engineSettingsSchema, type EngineSettingsState, type HostEngine } from "../../src/client-protocol/engine-settings.js";
import type { HubConnection } from "./connection.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { HubHttpError } from "./http-error.js";
import { timeoutSignal } from "./abort-signals.js";
import { t, useLocale } from "./i18n.js";
import "./engine-settings.css";

const labels: Record<HostEngine, string> = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", kimi: "Kimi", deepseek: "DeepSeek" };
export function EngineSettings({ connection, active, onBusy, onDirty, onSaved, onDetected }: { connection: HubConnection; active: boolean; onBusy?: (busy: boolean) => void; onDirty?: (dirty: boolean) => void; onSaved?: () => void; /** Engines the host reported as present in a completed read (not a save). */ onDetected?: (available: HostEngine[]) => void }) {
  useLocale(); const host = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner", online = state.status === "online", supported = state.engineSettingsAvailable === true;
  const [view, setView] = useState<EngineSettingsState>(), [editing, setEditing] = useState<HostEngine>(), [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [needsRead, setNeedsRead] = useState(false), [saved, setSaved] = useState(false);
  const [feedbackEngine, setFeedbackEngine] = useState<HostEngine>();
  const inputRef = useRef<HTMLInputElement>(null), editButtons = useRef(new Map<HostEngine, HTMLButtonElement>());
  const refreshButton = useRef<HTMLButtonElement>(null), recoveryButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HostEngine | "refresh" | "recovery">(undefined);
  useEffect(() => {
    if (!active || busy) return;
    const target = returnFocus.current;
    const button = target === "recovery" ? recoveryButton.current : editing ? inputRef.current : target === "refresh" ? refreshButton.current : target ? editButtons.current.get(target) : undefined;
    // Focus the replacement control in the same card/foot of the list. Browser
    // focus scrolling also reveals recovery without jumping to the panel top.
    if (button) { button.focus(); returnFocus.current = undefined; }
  }, [active, editing, busy]);
  const cancelEdit = () => { returnFocus.current = needsRead ? "recovery" : editing; setEditing(undefined); if (!needsRead) setError(""); };
  const flight = useRef<symbol | undefined>(undefined), generation = useRef(0);
  // A read can finish after the parent re-rendered; always call its latest callback.
  const detected = useRef(onDetected); detected.current = onDetected;
  const dirty = owner && supported && editing !== undefined && draft.trim() !== (view?.engines.find(engine => engine.id === editing)?.override ?? "");
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false); }, [busy, onBusy]);
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  useEffect(() => { generation.current++; flight.current = undefined; setBusy(false); setView(undefined); setEditing(undefined); setDraft(""); returnFocus.current = undefined; setError(""); setNeedsRead(false); setSaved(false); setFeedbackEngine(undefined); return () => { generation.current++; flight.current = undefined; }; }, [connection, owner, supported]);
  const read = (requestId?: string) => connection.http(`/api/settings/engines${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`, { signal: timeoutSignal(15_000) }).then(engineSettingsSchema.parse);
  async function refresh(focusAfter?: HostEngine | "refresh") {
    if (flight.current || !owner || !online || !supported) return;
    const current = generation.current, token = Symbol(); flight.current = token; setBusy(true); setSaved(false); setFeedbackEngine(focusAfter === "refresh" ? undefined : focusAfter);
    try { const value = await read(); if (current !== generation.current) return; setView(value); returnFocus.current = focusAfter; setEditing(undefined); setError(""); setNeedsRead(false); detected.current?.(value.engines.filter(engine => engine.available).map(engine => engine.id)); }
    catch (cause) { if (current === generation.current) { setError(cause instanceof HubHttpError && cause.code === "engine_settings_unavailable" ? ENGINE_SETTINGS_REPAIR_HINT : "读取失败，请重新读取。"); setNeedsRead(true); returnFocus.current = focusAfter ? "recovery" : undefined; } }
    finally { if (flight.current === token) { flight.current = undefined; if (current === generation.current) setBusy(false); } }
  }
  useEffect(() => { if (active && !view && !needsRead) void refresh(); }, [connection, active, online, supported, owner, view, needsRead]);
  async function save(engine: HostEngine, value: string | null) {
    if (!view || flight.current || !online || !owner || needsRead) return;
    const current = generation.current, token = Symbol(), command = { engine, path: value, revision: view.revision, requestId: crypto.randomUUID() };
    flight.current = token; setBusy(true); setSaved(false); setError(""); setFeedbackEngine(engine);
    try {
      await connection.http("/api/settings/engines", { method: "PUT", signal: timeoutSignal(15_000), body: JSON.stringify(command) });
      const next = await read(command.requestId);
      if (current !== generation.current) return;
      if (next.receipt?.requestId !== command.requestId || next.receipt.revision !== next.revision || next.engines.find(item => item.id === engine)?.override !== value) throw new Error("unconfirmed");
      setView(next); returnFocus.current = engine; setEditing(undefined); setSaved(true); onSaved?.();
    } catch (cause) {
      if (current !== generation.current) return;
      const code = cause instanceof HubHttpError ? cause.code : "";
      if (code === "engine_settings_unavailable") { setError(ENGINE_SETTINGS_REPAIR_HINT); setNeedsRead(true); returnFocus.current = "recovery"; }
      else if (code === "engine_path_absolute_required") setError("请填写主机上的完整绝对路径，不要填写命令参数或添加引号。");
      else if (code === "engine_path_unavailable") setError("该路径不是主机上可执行的文件，请检查位置和执行权限。");
      else { setError("保存结果未确认或设置已变化，请重新读取后再操作。"); setNeedsRead(true); returnFocus.current = "recovery"; }
    } finally { if (flight.current === token) { flight.current = undefined; if (current === generation.current) setBusy(false); } }
  }
  const recoveryFor = (engine: HostEngine) => error && feedbackEngine === engine && <div className="engine-path-recovery"><p className="settings-warning" role="alert">{t(error)}</p>{needsRead && <button ref={recoveryButton} type="button" className="secondary" disabled={busy || !online} onClick={() => void refresh(engine)}>{t(editing === engine ? "放弃修改并重新读取" : "重新读取")}</button>}</div>;
  if (!owner) return <div className="engine-settings"><p className="settings-note muted">{t("仅主机所有者可以查看和修改引擎路径。")}</p></div>;
  return <div className="engine-settings" aria-busy={busy || undefined}>
    <SettingsGroupHeading scope="host" host={host}>{t("引擎程序路径")}</SettingsGroupHeading>
    <p className="settings-note muted">{t("路径属于运行 Bot 的主机，不是当前手机或电脑。检测到程序不代表已完成登录。")}</p>
    {!supported ? <p role="status">{t("请更新主机以使用此设置。")}</p> : <>
      {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
      <p className="settings-note muted">{t("保存后，新启动的 Bot 使用新路径；已运行的 Bot 请在空闲后重启。不会中断当前任务。")}</p>
      <div className="engine-path-list">{view?.engines.map(engine => <section className="engine-path-card" key={engine.id} aria-label={labels[engine.id]}>
        <div className="engine-path-heading"><strong>{labels[engine.id]}</strong><span className={engine.available ? "muted" : "settings-warning"}>{engine.available ? t("已检测到 CLI") : t("未检测到 CLI")}</span></div>
        <p className="engine-path-source">{t(engine.source === "setting" ? "手动指定" : engine.source === "environment" ? "主机环境变量" : "自动检测")}</p>
        <code className="engine-path-value">{engine.executable ?? (engine.source !== "auto" ? engine.command : t("尚未找到可执行文件"))}</code>
        {saved && feedbackEngine === engine.id && <p className="engine-path-feedback" role="status">{t("已保存并核实。")}</p>}
        {editing !== engine.id && recoveryFor(engine.id)}
        {editing === engine.id ? <div className="engine-path-editor">
          <label>{t("CLI 程序路径")}<input ref={inputRef} aria-label={`${labels[engine.id]} ${t("CLI 程序路径")}`} value={draft} disabled={busy || needsRead} maxLength={4096} spellCheck={false} autoCapitalize="none" autoCorrect="off" placeholder={engine.executable ?? (view.platform === "win32" ? "C:\\Tools\\engine.cmd" : "/opt/tools/engine")} onChange={event => { setDraft(event.target.value); if (!needsRead) setError(""); }} onKeyDown={event => { if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); cancelEdit(); return; } if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (draft.trim()) void save(engine.id, draft.trim()); } }}/></label>
          <p className="settings-note muted">{t("填写完整程序路径，不含参数或外层引号。清除手动路径后，将重新使用主机环境变量或自动检测。")}</p>
          {recoveryFor(engine.id)}
          <div className="engine-path-actions"><button type="button" className="primary" disabled={busy || !online || needsRead || !draft.trim()} onClick={() => void save(engine.id, draft.trim())}>{t("保存路径")}</button><button type="button" className="secondary" disabled={busy} onClick={cancelEdit}>{t("取消")}</button></div>
        </div> : <div className="engine-path-actions"><button type="button" className="secondary" ref={button => { if (button) editButtons.current.set(engine.id, button); else editButtons.current.delete(engine.id); }} disabled={busy || !online || needsRead || !!editing} onClick={() => { setEditing(engine.id); setDraft(engine.override ?? ""); setSaved(false); setError(""); }}>{t("指定路径")}</button>{engine.override && <button type="button" className="secondary" disabled={busy || !online || needsRead || !!editing} onClick={() => void save(engine.id, null)}>{t("清除手动路径")}</button>}</div>}
      </section>)}</div>
      {!view && !error && online && <p role="status">{t("正在读取…")}</p>}
      {view && <details className="engine-path-diagnostics"><summary>{t("查看主机搜索目录")}</summary><ul>{view.searchPaths.map((directory, index) => <li key={`${index}:${directory}`}><code>{directory}</code></li>)}</ul></details>}
      {error && feedbackEngine === undefined && <p className="settings-warning" role="alert">{t(error)}</p>}
      {(!error || feedbackEngine === undefined) && <button ref={error ? recoveryButton : refreshButton} type="button" className="secondary" disabled={busy || !online || (dirty && !needsRead)} onClick={() => void refresh("refresh")}>{t(error ? "重新读取" : "重新检测")}</button>}
    </>}
  </div>;
}
