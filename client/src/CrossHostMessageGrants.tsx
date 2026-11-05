import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw, ShieldCheck } from "lucide-react";
import { idSchema } from "../../src/client-protocol/index.js";
import { crossHostMessageGrantsSnapshotSchema, type CrossHostMessageGrantsSnapshot, type CrossHostMessageGrantsCommand } from "../../src/client-protocol/bot-message-grants.js";
import type { HubConnection } from "./connection.js";
import { BotMessageHostsContext, isInternalMessageSource, messageSourceBots } from "./bot-message-hosts.js";
import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";

const route = "/api/bot-messages/cross-host-grants";
type Edge = { sourceHost: string; sourceBot: string; targetBot: string };
const same = (a: Edge, b: Edge) => a.sourceHost === b.sourceHost && a.sourceBot === b.sourceBot && a.targetBot === b.targetBot;
const allowed = (view: CrossHostMessageGrantsSnapshot, edge: Edge) => view.grants.some(grant => same(grant, edge));
function errorText(error: unknown): string {
  if (error instanceof HubHttpError) {
    if (["device_action_expired", "device_action_invalid"].includes(error.code)) return t("设备验证已失效，请重新载入后重试。");
    if (["bot_message_peer_revoked", "network_not_joined", "network_host_removed", "bot_message_host_not_found"].includes(error.code)) return t("授权、Bot 或网络状态已变化，请重新载入后核对。");
    if (error.status === 404 && error.code === "not_found") return t("请更新接收主机后使用跨主机消息授权。");
    if (error.status === 401 || error.status === 403) return t("只有已认证的接收主机所有者可以管理跨主机授权。");
    if (error.status === 409 || error.status === 410) return t("授权、Bot 或网络状态已变化，请重新载入后核对。");
  }
  return t("无法核对主机权限，请恢复连接后重试。");
}

export function CrossHostMessageGrants({ connection, initialBotId, active, online, onDirty, onBusy }: {
  connection: HubConnection; initialBotId?: string; active: boolean; online: boolean;
  onDirty: (value: boolean) => void; onBusy: (value: boolean) => void;
}) {
  const entries = useContext(BotMessageHostsContext);
  const [view, setView] = useState<CrossHostMessageGrantsSnapshot>();
  const [sourceHost, setSourceHost] = useState(""), [sourceBot, setSourceBot] = useState("");
  const [targetBot, setTargetBot] = useState(initialBotId ?? ""), [manual, setManual] = useState(false);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false), [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [query, setQuery] = useState("");
  const mounted = useRef(true), generation = useRef(0), writing = useRef(false), reading = useRef(false);
  const manualRead = useRef(false);
  const request = useRef<AbortController | undefined>(undefined), current = useRef(view), draft = useRef(dirty);
  const failedWrite = useRef(false), unknownWrite = useRef(false), feedback = useRef<HTMLDivElement>(null);
  const focusAfter = useRef(false), focusBefore = useRef<Element | null>(null);
  const selection = useRef({ sourceHost, targetBot });
  selection.current = { sourceHost, targetBot }; current.current = view; draft.current = dirty;
  useLayoutEffect(() => { onDirty(dirty || uncertain); }, [dirty, uncertain, onDirty]);
  useLayoutEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (busy || checking || !focusAfter.current) return;
    focusAfter.current = false;
    if (document.activeElement === document.body || document.activeElement === focusBefore.current) feedback.current?.focus({ preventScroll: true });
  }, [busy, checking, error, notice]);
  const adopt = useCallback((fresh: CrossHostMessageGrantsSnapshot) => {
    current.current = fresh; draft.current = false; setView(fresh); setDirty(false); setStale(false); setUncertain(false);
    const oldHost = selection.current.sourceHost;
    const nextHost = fresh.hosts.some(host => host.id === oldHost) ? oldHost : fresh.hosts.find(host => host.available)?.id ?? "";
    setSourceHost(nextHost);
    if (nextHost !== oldHost) { setSourceBot(""); setManual(false); }
    setTargetBot(old => fresh.bots.some(bot => bot.id === old && !bot.deleted) ? old : fresh.bots.find(bot => !bot.deleted)?.id ?? "");
  }, []);
  const refresh = useCallback(async (discard = false, explicit = false) => {
    if (writing.current || reading.current && (!explicit || manualRead.current) || !online) return;
    manualRead.current = explicit;
    reading.current = true; const epoch = ++generation.current;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    if (explicit) { setChecking(true); focusBefore.current = document.activeElement; focusAfter.current = true; }
    try {
      const fresh = crossHostMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current || generation.current !== epoch) return;
      if (discard) { failedWrite.current = false; unknownWrite.current = false; setError(""); adopt(fresh); setNotice(t("已重新载入主机当前权限。")); }
      else if (!failedWrite.current) {
        setError("");
        if (fresh.revision !== current.current?.revision) setNotice("");
        if (!draft.current) adopt(fresh);
        else { setStale(fresh.revision !== current.current?.revision); setView(old => old ? { ...old, hosts: fresh.hosts, bots: fresh.bots } : fresh); }
      }
    } catch (failure) {
      if (mounted.current && generation.current === epoch && !unknownWrite.current) { setError(errorText(failure)); setNotice(""); }
    } finally {
      clearTimeout(timeout);
      if (generation.current === epoch) { reading.current = false; manualRead.current = false; if (mounted.current) setChecking(false); }
    }
  }, [adopt, connection, online]);
  useEffect(() => {
    if (!active || !online) return;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = setInterval(visible, 5_000);
    window.addEventListener("focus", visible); document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [active, online, refresh]);

  const sources = messageSourceBots(entries, sourceHost);
  const name = (bots: { id: string; name: string }[], id: string) => {
    const bot = bots.find(value => value.id === id);
    return bot ? bots.filter(value => value.name === bot.name).length > 1 ? `${bot.name} · …${id.slice(-6)}` : bot.name : id;
  };
  const hostName = (id: string) => {
    const host = view?.hosts.find(value => value.id === id);
    if (!host) return id;
    return view!.hosts.filter(value => value.name === host.name).length > 1 ? `${host.name} · …${id.slice(-6)}` : host.name;
  };
  const sourceName = (edge: Edge) => name(messageSourceBots(entries, edge.sourceHost), edge.sourceBot);
  const edgeText = (edge: Edge) => `${hostName(edge.sourceHost)} · ${sourceName(edge)} → ${view?.host.name ?? ""} · ${name(view?.bots ?? [], edge.targetBot)}`;
  const host = view?.hosts.find(value => value.id === sourceHost);
  const selectedEdge = { sourceHost, sourceBot: sourceBot.trim(), targetBot };
  const liveSource = sources.some(bot => bot.id === selectedEdge.sourceBot);
  const internalSource = isInternalMessageSource(entries, sourceHost, selectedEdge.sourceBot);
  const canAllow = !!view && !!host?.available && !!view.bots.some(bot => bot.id === targetBot && !bot.deleted)
    && idSchema.safeParse(selectedEdge.sourceBot).success && !internalSource && (manual || !sources.length || liveSource);
  const alreadyAllowed = !!view && allowed(view, selectedEdge);
  const blocked = busy || checking || !online || stale || uncertain || !!error;
  const changed = () => { draft.current = true; setDirty(true); setNotice(""); };
  const save = async (edge: Edge, allow: boolean) => {
    const snapshot = current.current;
    if (!snapshot || writing.current || manualRead.current || blocked || allow && (!canAllow || alreadyAllowed) || !allow && (draft.current || !allowed(snapshot, edge))) return;
    const command: CrossHostMessageGrantsCommand = { operation: "cross-host-message-grants", sourceHost: edge.sourceHost, sourceBot: edge.sourceBot,
      revision: snapshot.revision, changes: [{ targetBot: edge.targetBot, allowed: allow }] };
    writing.current = true; const epoch = ++generation.current; request.current?.abort(); reading.current = false;
    const controller = new AbortController(); request.current = controller; const timeout = setTimeout(() => controller.abort(), 30_000);
    focusBefore.current = document.activeElement; focusAfter.current = true; setBusy(true); setChecking(false); setError(""); setNotice("");
    let submitted = false, confirmed = false;
    try {
      await connection.saveCrossHostMessageGrants(command, controller.signal, () => { submitted = true; }); confirmed = true;
      const fresh = crossHostMessageGrantsSnapshotSchema.parse(await connection.http(route, { signal: controller.signal }));
      if (!mounted.current || generation.current !== epoch) return;
      if (allowed(fresh, edge) !== allow || allow && (!fresh.hosts.some(host => host.id === edge.sourceHost && host.available) || !fresh.bots.some(bot => bot.id === edge.targetBot && !bot.deleted))) { failedWrite.current = true; setStale(true); setError(t("授权又发生了变化，请重新载入后核对。")); }
      else { failedWrite.current = false; unknownWrite.current = false; adopt(fresh); setNotice(allow ? t("已允许发送，并从接收主机核对生效。") : t("已撤销授权，并从接收主机核对生效。")); }
    } catch (failure) {
      if (!mounted.current || generation.current !== epoch) return;
      failedWrite.current = true;
      const unknown = confirmed || submitted && (!(failure instanceof HubHttpError) || failure.code === "device_action_cancelled" || failure.status < 400 || failure.status >= 500 || failure.status === 408);
      unknownWrite.current = unknown; setUncertain(unknown); setStale(!unknown && failure instanceof HubHttpError && [409, 410].includes(failure.status));
      setError(unknown ? t("尚未确认保存结果。请重新载入并核对，系统不会自动重复提交授权。") : errorText(failure));
    } finally { clearTimeout(timeout); writing.current = false; if (mounted.current && generation.current === epoch) setBusy(false); }
  };
  const grants = view?.grants.filter(edge => edgeText(edge).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <div className="cross-host-message-grants">
    <div className="message-grants-intro"><p>{t("允许其他主机的指定 Bot 向这台主机发送协作消息与文件。")}</p>
      <button type="button" className="icon-button" aria-label={t("刷新跨主机授权")} disabled={busy || checking || !online} onClick={() => { void refresh(false, true); }}><RefreshCw size={17}/></button></div>
    {view && <p className="cross-grants-receiver"><ShieldCheck size={16}/>{t("接收主机：{0}", view.host.name)}</p>}
    <p className="message-grants-hint">{t("由接收主机的所有者确认。仅授权所选方向；原任务的结果回复无需反向授权。")}</p>
    <p className="message-grants-hint">{t("授权允许列出接收 Bot 的对话名称、发送消息与文件；只可取回自身任务的回复。")}</p>
    {!online && <p role="status">{t("连接恢复后即可操作")}</p>}
    {!view && !error && online && <p role="status">{t("正在读取主机授权…")}</p>}
    {view && <>
      {!view.hosts.some(value => value.available) ? <p className="empty-state">{t("暂无可授权的其他主机。请先在「设备与网络」中将两台主机加入同一网络。")}</p> : <div className="cross-grants-form">
        <label>{t("来源主机")}<select aria-label={t("来源主机")} value={sourceHost} disabled={blocked} onChange={event => { setSourceHost(event.target.value); setSourceBot(""); setManual(false); changed(); }}>
          {view.hosts.map(value => <option key={value.id} value={value.id} disabled={!value.available}>{hostName(value.id)}{!value.available ? ` · ${t("不可用")}` : ""}</option>)}
        </select></label>
        <label>{manual || !sources.length ? t("来源 Bot ID") : t("来源 Bot")}
          {manual || !sources.length ? <input aria-label={t("来源 Bot ID")} autoComplete="off" spellCheck={false} value={sourceBot} maxLength={128} disabled={blocked} onChange={event => { setSourceBot(event.target.value); changed(); }}/>
            : <select aria-label={t("来源 Bot")} value={sourceBot} disabled={blocked} onChange={event => { setSourceBot(event.target.value); changed(); }}><option value="">{t("选择来源 Bot")}</option>{sources.map(bot => <option key={bot.id} value={bot.id}>{name(sources, bot.id)}</option>)}</select>}
        </label>
        {!sources.length && <p className="message-grants-hint cross-grants-wide">{t("此设备尚未连接来源主机，或来源主机暂时离线。连接后可按名称选择；也可填写准确的 Bot ID。")}</p>}
        {!!sources.length && <button type="button" className="text-button cross-grants-wide" disabled={blocked} onClick={() => { setManual(!manual); setSourceBot(""); changed(); }}>{manual ? t("按名称选择 Bot") : t("使用 Bot ID")}</button>}
        <label className="cross-grants-wide">{t("本机接收 Bot")}<select aria-label={t("本机接收 Bot")} value={targetBot} disabled={blocked} onChange={event => { setTargetBot(event.target.value); changed(); }}>{view.bots.filter(bot => !bot.deleted).map(bot => <option key={bot.id} value={bot.id}>{name(view.bots, bot.id)}</option>)}</select></label>
        {!view.bots.some(bot => !bot.deleted) && <p>{t("主机还没有 Bot。创建 Bot 后即可在这里授权。")}</p>}
        {sourceBot.trim() && targetBot && <p className="cross-grants-direction cross-grants-wide"><ArrowRight size={17}/><span>{edgeText(selectedEdge)}</span></p>}
        {(manual || !sources.length) && sourceBot.trim() && <p className="message-grants-hint cross-grants-wide">{t("请核对来源 Bot ID；这里不会自动验证它的名称或创建新 Bot。")}</p>}
        {internalSource && <p role="alert" className="message-grants-error cross-grants-wide">{t("内部执行者不参与手动消息授权，请选择普通 Bot。")}</p>}
        <div className="message-grants-actions cross-grants-wide"><button type="button" className="primary" disabled={blocked || !canAllow || alreadyAllowed} onClick={() => { void save(selectedEdge, true); }}>{busy ? t("正在保存并核对…") : alreadyAllowed ? t("已授权") : t("允许发送")}</button></div>
      </div>}
      {(dirty || stale || uncertain || error) && <div className="message-grants-actions"><button type="button" disabled={busy || checking || !online} onClick={() => { void refresh(true, true); }}>{checking ? t("正在载入…") : stale || uncertain || error ? t("重新载入并核对") : t("放弃修改")}</button></div>}
      <section className="cross-grants-existing"><h4>{t("已有跨主机授权")}</h4><p className="message-grants-hint">{t("包含通过命令行设置的授权。主机离网后授权不会放行，仍可在此撤销记录。")}</p>
        {view.grants.length > 6 && <input aria-label={t("查找跨主机授权")} value={query} onChange={event => setQuery(event.target.value)}/>}
        {!grants.length && <p className="empty-state">{t("暂无匹配的跨主机授权。")}</p>}
        {grants.slice(0, 100).map(edge => <div className="cross-grants-edge" key={JSON.stringify(edge)}><div><strong>{edgeText(edge)}</strong>
          {!view.hosts.find(value => value.id === edge.sourceHost)?.available && <small>{t("来源主机当前不可用，仅可撤销")}</small>}
          {!view.bots.some(bot => bot.id === edge.targetBot && !bot.deleted) && <small>{t("接收 Bot 已不可用，仅可撤销")}</small>}</div>
          <button type="button" className="text-danger" disabled={blocked || dirty} onClick={() => { void save(edge, false); }} aria-label={t("撤销 {0}", edgeText(edge))}>{t("撤销授权")}</button></div>)}
        {grants.length > 100 && <p>{t("仅显示前 100 个，请搜索缩小范围。")}</p>}
        {!!view.grants.length && <p className="message-grants-hint">{t("取消授权将阻止后续发送和结果查询，但不会停止或取消已提交的任务。建议取回结果后再取消授权。")}</p>}
      </section>
    </>}
    {(error || stale || notice) && <div ref={feedback} tabIndex={-1} className="message-grants-feedback cross-grants-feedback" role="group" aria-label={t("跨主机授权状态")}>
      {error && <p role="alert" className="message-grants-error">{error}</p>}
      {stale && !error && <p role="alert" className="message-grants-error">{t("授权、Bot 或网络状态已变化，请重新载入后核对。")}</p>}
      {notice && !error && !stale && <p role="status" className="message-grants-notice"><Check size={15}/>{notice}</p>}
    </div>}
    {!view && error && <button type="button" disabled={busy || checking || !online} onClick={() => { void refresh(true, true); }}>{t("重新载入并核对")}</button>}
  </div>;
}
