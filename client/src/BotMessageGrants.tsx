import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, RefreshCw, Search } from "lucide-react";
import { botMessageGrantsSnapshotSchema, type BotMessageGrantsSnapshot } from "../../src/client-protocol/bot-message-grants.js";
import type { HubConnection } from "./connection.js";
import { Avatar } from "./Avatar.js";
import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";
import "./bot-message-grants.css";

const route = "/api/bot-messages/grants";
const allows = (view: BotMessageGrantsSnapshot, source: string, target: string) => view.grants.some(grant => grant.sourceBot === source && grant.targetBot === target);
function errorText(error: unknown): string {
  if (error instanceof HubHttpError) {
    if (error.status === 404) return t("请更新主机后使用 Bot 消息授权。");
    if (error.status === 403 || error.status === 401) return t("只有已认证的主机所有者可以管理消息授权。");
    if (error.status === 409 || error.status === 410) return t("授权或 Bot 列表已变化，请重新载入后核对。");
  }
  return t("无法核对主机权限，请恢复连接后重试。");
}

export function BotMessageGrants({ connection, initialBotId, active, online, onDirty, onBusy }: {
  connection: HubConnection; initialBotId?: string; active: boolean; online: boolean; onDirty: (value: boolean) => void; onBusy: (value: boolean) => void;
}) {
  const [view, setView] = useState<BotMessageGrantsSnapshot>();
  const [selected, setSelected] = useState(initialBotId ?? ""), [query, setQuery] = useState("");
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mounted = useRef(true), writing = useRef(false), reading = useRef(false), generation = useRef(0);
  const draft = useRef(edits), currentView = useRef(view), request = useRef<AbortController | undefined>(undefined);
  const feedbackNode = useRef<HTMLDivElement>(null), saveFocus = useRef<Element | null>(null), restoreSaveFocus = useRef(false);
  const writeFailure = useRef(false), manualRead = useRef(false), titleId = useId();
  const dirty = Object.keys(edits).length > 0;
  draft.current = edits; currentView.current = view;
  // Parent navigation must see the current draft/write before the next input.
  useLayoutEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useLayoutEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => {
    if (busy || loading || !restoreSaveFocus.current) return;
    restoreSaveFocus.current = false;
    // Disabling a submitted button can drop keyboard focus to body. Preserve
    // the result context, but don't steal focus if the user moved elsewhere.
    if (document.activeElement === document.body || document.activeElement === saveFocus.current) feedbackNode.current?.focus({ preventScroll: true });
  }, [busy, loading, error, notice]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; request.current?.abort(); }; }, []);
  const adopt = useCallback((fresh: BotMessageGrantsSnapshot) => {
    currentView.current = fresh; draft.current = {}; setView(fresh); setEdits({}); setStale(false); setUncertain(false);
    setSelected(previous => fresh.bots.some(bot => bot.id === previous) ? previous : fresh.bots[0]?.id ?? "");
  }, []);
  const refresh = useCallback(async (discard = false, manual = false, focusResult = false) => {
    if (writing.current || (reading.current && (!manual || manualRead.current)) || !online) return;
    if (focusResult) { saveFocus.current = document.activeElement; restoreSaveFocus.current = true; }
    manualRead.current = manual; setChecking(manual);
    reading.current = true; const epoch = ++generation.current;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000); setLoading(true);
    try {
      const fresh = botMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current || generation.current !== epoch) return;
      // Polls update live grants, but a successful GET is not a write receipt.
      // Explicit rechecking can acknowledge a known rejection, never an unknown
      // outcome; that requires discarding the draft and adopting server state.
      if (discard || (!uncertain && (manual || !writeFailure.current))) { setError(""); writeFailure.current = false; }
      if (discard || !Object.keys(draft.current).length) { if (fresh.revision !== currentView.current?.revision) setNotice(""); adopt(fresh); if (discard) setNotice(t("已重新载入主机当前权限。")); }
      else {
        setStale(fresh.revision !== currentView.current?.revision);
        // Keep unsaved choices and their revision; names/online state can refresh.
        setView(previous => previous ? { ...previous, bots: fresh.bots } : fresh);
      }
    } catch (failure) { if (mounted.current && generation.current === epoch && (!writeFailure.current || manual)) { setError(errorText(failure)); setNotice(""); } }
    finally { clearTimeout(timeout); if (generation.current === epoch) { reading.current = false; manualRead.current = false; if (mounted.current) { setLoading(false); setChecking(false); } } }
  }, [adopt, connection, online, uncertain]);
  useEffect(() => {
    if (!active || !online) return;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(visible, 5_000);
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [active, online, refresh]);
  const save = async () => {
    if (!view || writing.current || manualRead.current || !dirty || stale || uncertain || error || !online) return;
    const command = { operation: "local-message-grants" as const, sourceBot: selected, revision: view.revision,
      changes: Object.entries(edits).map(([targetBot, allowed]) => ({ targetBot, allowed })) };
    writing.current = true; generation.current++; request.current?.abort(); reading.current = false; writeFailure.current = false;
    saveFocus.current = document.activeElement; restoreSaveFocus.current = true;
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setBusy(true); setLoading(false); setNotice(""); setError("");
    let submitted = false, confirmed = false;
    try {
      await connection.saveBotMessageGrants(command, controller.signal, () => { submitted = true; });
      confirmed = true;
      const fresh = botMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current) return;
      if (command.changes.some(change => change.targetBot === selected && !fresh.selfTargetSupported || allows(fresh, selected, change.targetBot) !== change.allowed)) {
        writeFailure.current = true; setStale(true); setError(t("授权又发生了变化，请重新载入后核对。"));
      } else { adopt(fresh); setNotice(t("已保存，并从主机核对生效。")); }
    } catch (failure) {
      if (!mounted.current) return;
      writeFailure.current = true;
      const unknown = confirmed || submitted && (!(failure instanceof HubHttpError) || failure.code === "device_action_cancelled" || failure.status < 400 || failure.status >= 500 || failure.status === 408);
      setUncertain(unknown); setStale(!unknown && submitted && !confirmed && failure instanceof HubHttpError && [409, 410].includes(failure.status));
      setError(unknown ? t("尚未确认保存结果。重新载入会清除本页草稿，已生效的授权不会撤回；不会自动重复保存。") : errorText(failure));
    } finally { clearTimeout(timeout); writing.current = false; if (mounted.current) setBusy(false); }
  };
  const source = view?.bots.find(bot => bot.id === selected);
  const peers = source ? [source, ...view!.bots.filter(bot => bot.id !== selected)] : [];
  const incoming = view?.bots.filter(bot => bot.id !== selected && allows(view, bot.id, selected)) ?? [];
  const duplicateName = (name: string) => (view?.bots.filter(bot => bot.name === name).length ?? 0) > 1;
  const label = (bot: { id: string; name: string }) => duplicateName(bot.name) ? `${bot.name} · …${bot.id.slice(-6)}` : bot.name;
  const visible = peers.filter(bot => `${label(bot)} ${bot.id === selected ? t("自身其他对话") : ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selectedCount = view ? peers.filter(bot => edits[bot.id] ?? allows(view, selected, bot.id)).length : 0;
  const visibleError = uncertain && error ? error : stale ? t("其他位置已修改授权或 Bot 列表。重新载入会放弃本页未保存的修改，并显示主机当前权限。") : error;
  const feedback = (visibleError || notice) ? <div ref={feedbackNode} className="message-grants-feedback" tabIndex={-1} role="group" aria-label={t("消息授权状态")}>
    {visibleError && <p className="message-grants-error" role="alert">{visibleError}</p>}
    {notice && !visibleError && <p className="message-grants-notice" role="status"><Check size={15}/>{notice}</p>}</div> : null;
  return <div className="bot-message-grants">
    <div className="message-grants-intro"><p>{t("设置当前主机的 Bot 可以向谁直接发送协作消息与文件。")}</p>
      <button type="button" className="icon-button" aria-label={t("刷新消息授权")} aria-busy={checking} disabled={busy || !online} onClick={() => { void refresh(false, true); }}><RefreshCw size={17} className={checking ? "is-loading" : ""}/></button></div>
    <p className="message-grants-scope">{t("仅影响 Bot 直接消息；Agent Bus 与跨主机授权保持独立。")}</p>
    {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
    {(!view || !view.bots.length) && feedback}
    {online && !view && !error && <p role="status">{t("正在读取主机授权…")}</p>}
    {view && !view.bots.length && <p className="empty-state">{t("主机还没有 Bot。创建 Bot 后即可在这里授权。")}</p>}
    {view && view.bots.length > 0 && <>
      <label className="message-grants-source"><span className="message-grants-source-title"><span>{t("发起方 Bot")}</span>{dirty && <small>{t("有未保存的修改")}</small>}</span><select aria-label={t("发起方 Bot")} title={dirty ? t("保存或放弃修改后，可以切换发起方。") : undefined} value={selected} disabled={busy || dirty || checking} onChange={event => { setSelected(event.target.value); setQuery(""); setNotice(""); }}>
        {view.bots.map(bot => <option key={bot.id} value={bot.id}>{label(bot)}</option>)}
      </select></label>
      <div className="message-grants-heading"><h4 id={titleId}><ArrowUpRight size={17}/>{t("它可以请求谁")}</h4><span>{t("已选择 {0} 个", selectedCount)}</span></div>
      <p className="message-grants-hint">{t("只设置这个方向；接收方可以返回原任务结果，无需反向授权。")}</p>
      {peers.length > 6 && <label className="message-grants-search"><Search size={16}/><input aria-label={t("查找接收方 Bot")} placeholder={t("查找接收方 Bot")} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }}/></label>}
      <div className="message-grants-targets" role="group" aria-labelledby={titleId}>
        {visible.slice(0, 100).map(bot => <label className="message-grants-target" key={bot.id} data-bot-id={bot.id}>
          <Avatar kind="bot" id={bot.id} name={bot.name} size={30}/>
          <span className="message-grants-target-name"><strong>{label(bot)}</strong><small id={`${titleId}-${bot.id}`}>
            {bot.id === selected && <span className="message-grants-self">{t("自身其他对话")}</span>}
            <i data-online={bot.online}/>{bot.online ? t("当前在线") : t("当前离线")}
            {bot.id === selected && !view.selfTargetSupported && <span>{t("请更新主机后设置自身消息授权。")}</span>}
            {bot.id !== selected && allows(view, bot.id, selected) && <span>{t("可请求发起方")}</span>}
          </small></span>
          <input type="checkbox" aria-describedby={`${titleId}-${bot.id}`} aria-label={t("允许 {0} → {1}", source ? label(source) : selected, label(bot))} checked={edits[bot.id] ?? allows(view, selected, bot.id)} disabled={busy || checking || !online || stale || uncertain || bot.id === selected && !view.selfTargetSupported} onChange={event => {
            const next = { ...edits }; if (event.target.checked === allows(view, selected, bot.id)) delete next[bot.id]; else next[bot.id] = event.target.checked;
            draft.current = next; setEdits(next); setNotice("");
          }}/>
        </label>)}
        {!visible.length && <p className="message-grants-hint">{t("没有找到匹配的 Bot。")}</p>}
        {visible.length > 100 && <p>{t("仅显示前 100 个，请搜索缩小范围。")}</p>}
      </div>
      {Object.values(edits).includes(false) && <p className="message-grants-caution">{t("取消授权将阻止后续发送和结果查询，但不会停止或取消已提交的任务。建议取回结果后再取消授权。")}</p>}
      {Object.keys(edits).length > 256 && <p role="alert">{t("一次最多修改 256 个接收方，请减少本次修改后保存。")}</p>}
      {feedback}
      <div className="message-grants-actions">
        <button type="button" className="secondary" disabled={busy || checking || !online || (!dirty && !stale && !uncertain && !error)} onClick={() => { void refresh(stale || uncertain || !error, true, true); }}>{checking ? t("正在载入…") : stale || uncertain ? t("重新载入并核对") : error ? t("重新核对") : t("放弃修改")}</button>
        <button type="button" className="primary" disabled={busy || checking || !online || !dirty || stale || uncertain || !!error || Object.keys(edits).length > 256} onClick={() => { void save(); }}>{busy ? t("正在保存并核对…") : t("保存授权")}</button>
      </div>
      <section className="message-grants-incoming"><h4><ArrowDownLeft size={17}/>{t("哪些其他 Bot 可以请求它")}</h4><div>{incoming.length ? incoming.map(bot => <span key={bot.id}>{label(bot)}</span>) : <p>{t("暂无其他 Bot 获得此方向的授权。")}</p>}</div><p className="message-grants-hint">{t("这是主机当前的反向授权。选择对应 Bot 后，可以修改。")}</p></section>
    </>}
  </div>;
}
