import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronRight, ListChecks, Paperclip, Server } from "lucide-react";
import { OPEN_TICKET_STATUSES, dispatchTicketSchema, engineHealthSchema, ticketOverviewListSchema, type DispatchTicket, type EngineHealth, type TicketAction, type TicketOverview, type TicketOverviewList, type TicketStatus } from "../../src/client-protocol/dispatch.js";
import type { HubConnection } from "./connection.js";
import { botMessageHostId } from "./bot-message-hosts.js";
import { HubHttpError } from "./http-error.js";
import { localeIntlTag, t, useLocale } from "./i18n.js";
import "./dispatch.css";
import { ENGINE_NAMES } from "./DispatcherSettings.js";
import { blocksText, type Message } from "../../src/client-protocol/index.js";
import { ticketNoticeSummary } from "./dispatcher.js";
import { beginTicketRead, publishTicketSignal } from "./dispatcher-signal.js";
import { queueRequest } from "./prompt-queue-request.js";

const statusLabel = (status: TicketStatus) => t(status === "queued" ? "排队" : status === "working" ? "进行中" : status === "needs_answer" ? "待你回答" : status === "needs_review" ? "待你验收" : status === "blocked" ? "卡住" : status === "done" ? "完成" : "已取消");
const isOpen = (ticket: TicketOverview) => OPEN_TICKET_STATUSES.includes(ticket.status);
const displayStatus = (ticket: TicketOverview): TicketStatus => ticket.status === "working" && ticket.attempts.at(-1)?.waitingFor && !ticket.attempts.at(-1)?.stopRequested ? "needs_answer" : ticket.status;
/** What an action leaves visible on the ticket once the Host has applied it. */
const applied = (ticket: TicketOverview, action: TicketAction) => action === "pause" ? ticket.paused : action === "resume" ? !ticket.paused
  : action === "cancel" ? ticket.status === "cancelled" || ticket.attempts.at(-1)?.stopRequested === "cancel" : action === "accept" && ticket.status === "done";
function actionError(error: unknown, action?: TicketAction) {
  if (action === "remove" && error instanceof HubHttpError && error.status === 400 && error.code === "invalid_request") return t("此主机尚不支持移除工单，请更新主机后重试。");
  switch (error instanceof Error ? error.message : "") {
    case "ticket_not_finished": return t("只能移除已完成或已取消的工单。");
    case "dispatch_worker_permissions_unsafe": return t("接收主机上的旧执行 Bot 权限过宽。请接收方主人运行 tarobot logs，按其中的指引删除该执行 Bot，再重新派发。");
    case "ticket_closed": return t("这张工单已经结束。");
    case "ticket_not_reviewable": return t("这张工单现在不需要验收。");
    case "ticket_stop_pending": return t("正在等待执行停止，确认结束后才能继续。");
    default: return t("操作结果未确认，请稍后重试。");
  }
}
function when(at: number, locale: string, now: number) {
  const age = Math.max(0, now - at), unit: Intl.RelativeTimeFormatUnit = age >= 86_400_000 ? "day" : age >= 3_600_000 ? "hour" : "minute";
  return age < 60_000 ? t("刚刚") : new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(age / (unit === "day" ? 86_400_000 : unit === "hour" ? 3_600_000 : 60_000)), unit);
}
function engineNotice(health: EngineHealth, locale: string) {
  const name = ENGINE_NAMES[health.engine] ?? health.engine;
  if (health.state === "login_required") return t("{0} 需要登录", name);
  if (!health.until) return t("{0} 冷却中", name);
  const until = new Date(health.until), today = until.toDateString() === new Date().toDateString();
  return t("{0} 冷却到 {1}", name, until.toLocaleString(locale, today ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
}

/** The dispatcher conversation's ticket list. Polls only while this conversation
 * and the window are visible, and shares each read with the list avatar; worker
 * conversations stay hidden and open from here. */
export function DispatchTickets({ connection, botId, conversationId, botLabel, conversationTitles, active, online, open }: { connection: HubConnection; botId: string; conversationId: string; botLabel?: string; conversationTitles?: ReadonlyMap<string, string>; active: boolean; online: boolean; open: (conversationId: string) => void }) {
  const locale = localeIntlTag(useLocale());
  const ownHostId = (() => {
    const key = connection.identity?.hubPublicKey;
    if (!key) return undefined;
    try { return botMessageHostId(key); } catch { return undefined; }
  })();
  const [fetched, setFetched] = useState<{ scope: "conversation" | "all"; conversationId: string; data: TicketOverviewList }>(), [expanded, setExpanded] = useState(false);
  const [scope, setScope] = useState<"conversation" | "all">("conversation");
  const [busy, setBusy] = useState(""), [confirming, setConfirming] = useState<{ id: string; action: "cancel" | "remove" }>(), [confirmBulkCancel, setConfirmBulkCancel] = useState(false), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [detailId, setDetailId] = useState(""), [details, setDetails] = useState<Record<string, DispatchTicket>>({});
  // An unconfirmed action keeps its request ID until a later read shows its
  // effect or a later action on the ticket succeeds. Progress such as a new
  // question or note is not proof either way, so it never changes the ID.
  const pending = useRef(new Map<string, { requestId: string; after?: number }>()), reads = useRef(0), alive = useRef(true);
  const confirmation = useRef<HTMLDivElement>(null);
  useEffect(() => { confirmation.current?.scrollIntoView({ block: "nearest" }); }, [confirming]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!active || !online) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reading = false;
    const query = new URLSearchParams({ summary: "1", capabilities: "1" });
    if (scope === "conversation") query.set("conversationId", conversationId);
    if (expanded && connection.state?.crossHostDispatchAvailable) query.set("excerpts", "1");
    const load = async () => {
      clearTimeout(timer);
      // A hidden window skips reads until it is visible again.
      if (reading || controller.signal.aborted || document.visibilityState === "hidden") return;
      reading = true; const read = beginTicketRead(connection, botId), local = ++reads.current, request = queueRequest([controller.signal], 8000);
      try {
        const value = ticketOverviewListSchema.parse(await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets?${query}`, { signal: request.signal })));
        if (!controller.signal.aborted && local === reads.current) {
          // Only a read started after the action ended can show its effect.
          for (const [key, entry] of pending.current) {
            const [id, action] = key.split(":") as [string, TicketAction], ticket = value.tickets.find(item => item.id === id);
            if (entry.after !== undefined && local > entry.after && ticket && applied(ticket, action)) pending.current.delete(key);
          }
          setFetched({ scope, conversationId, data: value });
          if (scope === "conversation" && value.otherCount !== undefined && value.otherCount > 0) {
            publishTicketSignal(connection, botId, read, value.tickets, false, conversationId);
          } else {
            publishTicketSignal(connection, botId, read, value.tickets, true);
          }
        }
      } catch { /* Keep the last list; the next poll retries. */ }
      finally { request.dispose(); reading = false; if (!controller.signal.aborted) timer = setTimeout(() => void load(), 4000); }
    };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    void load(); return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [connection, botId, conversationId, scope, active, online, expanded, refresh]);
  const act = async (ticket: TicketOverview, action: TicketAction) => {
    if (busy) return;
    // A retry after an unconfirmed result repeats the same request.
    const key = `${ticket.id}:${action}`, requestId = pending.current.get(key)?.requestId ?? `ticket_${crypto.randomUUID()}`;
    pending.current.set(key, { requestId }); setBusy(ticket.id); setError(""); setConfirming(undefined);
    // Discard list reads started before this mutation, including late replies.
    reads.current++;
    // Bounded even when the transport never settles; a timeout leaves the result unknown.
    const request = queueRequest([], 20_000);
    try {
      const next = dispatchTicketSchema.parse(await request.wait(connection.http(`/api/tickets/${ticket.id}/action`, { method: "POST", body: JSON.stringify({ requestId, action }), signal: request.signal })));
      // A confirmed action supersedes every earlier unconfirmed one on this ticket.
      for (const other of [...pending.current.keys()]) if (other.startsWith(`${ticket.id}:`)) pending.current.delete(other);
      if (alive.current) setFetched(value => value && { ...value, data: { ...value.data, tickets: action === "remove" ? value.data.tickets.filter(item => item.id !== next.id) : value.data.tickets.map(item => item.id === next.id ? next : item) } });
    } catch (cause) {
      if (cause instanceof HubHttpError && cause.status >= 400 && cause.status < 500) pending.current.delete(key);
      else pending.current.set(key, { requestId, after: reads.current });
      if (alive.current) setError(actionError(cause, action));
    } finally { request.dispose(); reads.current++; if (alive.current) { setBusy(""); setRefresh(value => value + 1); } }
  };
  const reset = async (engine: string) => {
    if (busy) return; setBusy(engine); setError("");
    const request = queueRequest([], 20_000);
    try { const engines = engineHealthSchema.array().parse(await request.wait(connection.http(`/api/dispatch/engines/${engine}/reset`, { method: "POST", signal: request.signal }))); if (alive.current) setFetched(value => value && { ...value, data: { ...value.data, engines } }); }
    catch (cause) { if (alive.current) setError(actionError(cause)); }
    finally { request.dispose(); if (alive.current) setBusy(""); }
  };
  const bulkScopeReady = fetched?.scope === scope && fetched.conversationId === conversationId
    && (scope === "all" || fetched.data.otherCount !== undefined);
  const bulk = async (action: "pause" | "resume" | "cancel") => {
    if (busy || !bulkScopeReady) return;
    const requestId = `bulk_${crypto.randomUUID()}`;
    setBusy(`bulk:${action}`); setError(""); setConfirmBulkCancel(false); reads.current++;
    const request = queueRequest([], 25_000);
    try {
      await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets/bulk-action`, { method: "POST", body: JSON.stringify({ requestId, action, ...(scope === "conversation" ? { conversationId } : {}) }), signal: request.signal }));
    } catch (cause) {
      if (alive.current) setError(actionError(cause, action));
    } finally { request.dispose(); reads.current++; if (alive.current) { setBusy(""); setRefresh(value => value + 1); } }
  };
  const reassign = async (ticket: TicketOverview) => {
    const attempt = ticket.attempts.at(-1);
    if (busy || !attempt) return;
    const requestId = `reassign_${crypto.randomUUID()}`;
    setBusy(ticket.id); setError(""); reads.current++;
    const request = queueRequest([], 25_000);
    try {
      const next = dispatchTicketSchema.parse(await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets/dispatch`, {
        method: "POST",
        body: JSON.stringify({ requestId, ticketId: ticket.id, engine: attempt.engine, ...(attempt.model ? { model: attempt.model } : {}), ...(attempt.effort ? { effort: attempt.effort } : {}), hostId: "auto" }),
        signal: request.signal,
      })));
      if (alive.current) setFetched(value => value && { ...value, data: { ...value.data, tickets: value.data.tickets.map(item => item.id === next.id ? next : item) } });
    } catch (cause) {
      if (alive.current) setError(actionError(cause));
    } finally { request.dispose(); reads.current++; if (alive.current) { setBusy(""); setRefresh(value => value + 1); } }
  };
  const fetchDetail = async (ticketId: string) => {
    try {
      const full = dispatchTicketSchema.parse(await connection.http(`/api/tickets/${encodeURIComponent(ticketId)}`));
      if (alive.current) setDetails(prev => ({ ...prev, [ticketId]: full }));
    } catch { /* Excerpt stays visible even if detail fetch fails. */ }
  };
  const toggleDetail = async (ticket: TicketOverview) => {
    if (detailId === ticket.id) { setDetailId(""); return; }
    setDetailId(ticket.id);
    const cached = details[ticket.id];
    if (cached && cached.updatedAt >= ticket.updatedAt) return;
    await fetchDetail(ticket.id);
  };
  const list = fetched?.data;
  const openDetailUpdatedAt = detailId ? list?.tickets.find(item => item.id === detailId)?.updatedAt : undefined;
  const cachedDetailUpdatedAt = detailId ? details[detailId]?.updatedAt : undefined;
  useEffect(() => {
    if (!detailId || !online || openDetailUpdatedAt === undefined) return;
    if (cachedDetailUpdatedAt !== undefined && cachedDetailUpdatedAt >= openDetailUpdatedAt) return;
    void fetchDetail(detailId);
  }, [detailId, online, openDetailUpdatedAt, cachedDetailUpdatedAt]);
  const sorted = [...list?.tickets ?? []].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt - a.updatedAt);
  const chatTickets = sorted.filter(ticket => ticket.conversationId === conversationId);
  const otherTicketsCount = fetched?.scope === "conversation" && list?.otherCount !== undefined ? list.otherCount : sorted.length - chatTickets.length;
  const totalTicketsCount = chatTickets.length + otherTicketsCount;
  const tickets = scope === "all" ? sorted : chatTickets;
  const engines = (list?.engines ?? []).filter(health => health.state !== "ok");
  if (!totalTicketsCount && !engines.length) return null;
  const openTickets = tickets.filter(isOpen), shown = expanded, now = Date.now();
  const hasPausedOpen = openTickets.some(ticket => ticket.paused), hasActiveOpen = openTickets.some(ticket => !ticket.paused);
  const counts = (["needs_answer", "needs_review", "blocked", "working", "queued"] as const).map(status => [status, openTickets.filter(ticket => displayStatus(ticket) === status).length] as const).filter(([, count]) => count);
  const summary = counts.length ? counts.map(([status, count]) => `${count} ${statusLabel(status)}`).join(" · ") : scope === "conversation" && !chatTickets.length && otherTicketsCount > 0 ? (otherTicketsCount === 1 ? t("其他对话有 1 张工单") : t("其他对话有 {0} 张工单", otherTicketsCount)) : t("没有进行中的工单");
  const triggerPrefix = botLabel ? `${botLabel} · ` : "";
  const triggerCount = scope === "all" ? totalTicketsCount : chatTickets.length;
  const hasCrossHost = tickets.some(ticket => !!(ticket.hostId ?? ticket.attempts.at(-1)?.hostId));
  const nodeGroups = hasCrossHost ? (() => {
    const groups = new Map<string, { key: string; hostName: string; items: TicketOverview[] }>();
    for (const ticket of tickets) {
      const attempt = ticket.attempts.at(-1);
      const hostId = ticket.hostId ?? attempt?.hostId ?? ownHostId ?? "local";
      const hostName = ticket.hostName ?? attempt?.hostName ?? t("本机");
      const existing = groups.get(hostId);
      if (existing) existing.items.push(ticket);
      else groups.set(hostId, { key: hostId, hostName, items: [ticket] });
    }
    return [...groups.values()];
  })() : undefined;
  const crossHostSupported = !!connection.state?.crossHostDispatchAvailable;
  const renderTicket = (ticket: TicketOverview) => {
    const attempt = ticket.attempts.at(-1), stopping = !!attempt?.stopRequested && !attempt.endedAt, open_ = isOpen(ticket), disabled = !online || !!busy;
    const ticketHostId = ticket.hostId ?? attempt?.hostId;
    const ticketHostName = ticket.hostName ?? attempt?.hostName;
    const isRemote = !!(ticketHostId && (!ownHostId || ticketHostId !== ownHostId));
    const canReassign = !!(open_ && crossHostSupported && attempt && (ticket.status === "blocked" || (ticket.status === "queued" && !!attempt.failure)));
    const detail = detailId === ticket.id ? details[ticket.id] : undefined;
    const foreignTitle = scope === "all" && ticket.conversationId !== conversationId ? conversationTitles?.get(ticket.conversationId) : undefined;
    const artifactsCount = ticket.artifacts?.length ?? 0;
    return <li key={ticket.id} className="dispatch-ticket" data-status={ticket.status} data-ticket-id={ticket.id}>
      <div className="dispatch-ticket-heading"><strong title={ticket.title}>{ticket.title}</strong>{foreignTitle && <button type="button" className="dispatch-ticket-origin" title={t("前往来源对话：{0}", foreignTitle)} onClick={() => open(ticket.conversationId)}>{foreignTitle}</button>}{ticket.batchIndex !== undefined && ticket.batchTotal !== undefined && <span className="dispatch-ticket-batch">{t("批次 {0}/{1}", ticket.batchIndex + 1, ticket.batchTotal)}</span>}{!nodeGroups && ticketHostName && <span className="dispatch-ticket-host">{ticketHostName}</span>}{ticket.paused && open_ && !stopping && <span className="dispatch-ticket-paused">{t("已暂停")}</span>}<span className="dispatch-ticket-status">{stopping ? t(attempt.stopRequested === "cancel" ? "正在取消" : "正在暂停") : statusLabel(displayStatus(ticket))}</span></div>
      {attempt?.waitingFor && !attempt.endedAt && !stopping && <p role="status">{isRemote ? t("接收主机的主人会收到通知。请在接收主机的对话列表里打开与工单同名的对话，处理审批或问题。") : t("打开执行会话，处理问题或权限审批。")}</p>}
      {stopping && <p role="status">{t("正在等待执行停止，确认结束后才能继续。")}</p>}
      {attempt?.failure && !stopping && <p className="dispatch-ticket-failure" role="status">{attempt.failure.message || attempt.failure.category}</p>}
      {ticket.resultExcerpt && <p className="dispatch-ticket-excerpt">{ticket.resultExcerpt}</p>}
      <div className="dispatch-ticket-meta"><span>{[attempt ? [ENGINE_NAMES[attempt.engine] ?? attempt.engine, attempt.model || t("默认模型"), attempt.effort].filter(Boolean).join(" · ") : "", artifactsCount === 1 ? t("1 个文件") : artifactsCount > 1 ? t("{0} 个文件", artifactsCount) : ""].filter(Boolean).join(" · ")}</span><time dateTime={new Date(ticket.updatedAt).toISOString()}>{when(ticket.updatedAt, locale, now)}</time></div>
      <div className="dispatch-ticket-actions">
        {attempt && !isRemote && <button type="button" onClick={() => open(attempt.conversationId)}>{t("打开")}</button>}
        {isRemote && <button type="button" onClick={() => void toggleDetail(ticket)}>{detailId === ticket.id ? t("收起详情") : t("查看结果")}</button>}
        {canReassign && <button type="button" disabled={disabled} onClick={() => void reassign(ticket)}>{t("改派重试")}</button>}
        {ticket.status === "needs_review" && <button type="button" disabled={disabled} onClick={() => void act(ticket, "accept")}>{t("验收")}</button>}
        {open_ && <button type="button" disabled={disabled || stopping} onClick={() => void act(ticket, ticket.paused ? "resume" : "pause")}>{ticket.paused && !stopping ? t("继续") : t("暂停")}</button>}
        {open_ && <button type="button" disabled={disabled} onClick={() => setConfirming({ id: ticket.id, action: "cancel" })}>{t("取消")}</button>}
        {!open_ && list?.capabilities?.remove === true && <button type="button" disabled={disabled || ticket.attempts.some(item => !item.endedAt)} onClick={() => setConfirming({ id: ticket.id, action: "remove" })}>{t("移除")}</button>}
      </div>
      {detailId === ticket.id && <div className="dispatch-ticket-detail">
        <p>{detail?.result || ticket.resultExcerpt || detail?.note || t("暂无结果摘要。")}</p>
        {!!(detail?.artifacts?.length ?? ticket.artifacts?.length) && <ul className="dispatch-ticket-artifacts">
          {(detail?.artifacts ?? ticket.artifacts ?? []).map(file => <li key={file.id}><Paperclip size={11}/><span>{file.name}</span></li>)}
        </ul>}
      </div>}
      {confirming?.id === ticket.id && <div className="prompt-queue-confirm" ref={confirmation}>
        <p className="prompt-queue-confirm-title">{t(confirming.action === "remove" ? "移除这张工单？" : "取消这张工单？")}</p>
        <p className="prompt-queue-confirm-description">{t(confirming.action === "remove" ? "从此幕僚长的工单列表移除，保留执行对话和生成文件。" : "正在进行的工作会停止，对话记录保留。")}</p>
        <div className="prompt-queue-confirm-actions"><button type="button" className="prompt-queue-keep" onClick={() => setConfirming(undefined)}>{t("保留")}</button><button type="button" className="primary" disabled={disabled} onClick={() => void act(ticket, confirming.action)}>{t(confirming.action === "remove" ? "确认移除工单" : "确认取消工单")}</button></div>
      </div>}
    </li>;
  };
  return <section className="dispatch-tickets" aria-label={t("工单")}>
    {totalTicketsCount > 0 && <button type="button" className="dispatch-tickets-trigger" aria-label={`${triggerPrefix}${t("工单 {0}", triggerCount)} · ${summary}`} aria-expanded={shown} onClick={() => setExpanded(!shown)}><ListChecks size={15}/><span>{triggerPrefix}{t("工单 {0}", triggerCount)}</span><small>{counts.length ? counts.map(([status, count], index) => <Fragment key={status}>{index > 0 && " · "}<span className={status === "needs_review" ? "dispatch-ticket-review" : undefined}>{count} {statusLabel(status)}</span></Fragment>) : summary}</small><ChevronRight size={14}/></button>}
    {engines.length > 0 && <p className="dispatch-engines">{engines.map(health => <span key={health.engine} title={health.reason}>{engineNotice(health, locale)}<button type="button" disabled={!online || !!busy} onClick={() => void reset(health.engine)}>{t("清除")}</button></span>)}</p>}
    {error && <p className="dispatch-tickets-error" role="alert">{error}</p>}
    {shown && totalTicketsCount > 0 && <>
      {otherTicketsCount > 0 && <div className="dispatch-ticket-scope" role="group" aria-label={t("工单范围")}>
        <button type="button" aria-pressed={scope === "conversation"} onClick={() => { setConfirmBulkCancel(false); setScope("conversation"); }}>{t("当前对话")} ({chatTickets.length})</button>
        <button type="button" aria-pressed={scope === "all"} onClick={() => { setConfirmBulkCancel(false); setScope("all"); }}>{t("全部")} ({totalTicketsCount})</button>
      </div>}
      {openTickets.length > 1 && crossHostSupported && bulkScopeReady && <div className="dispatch-bulk-actions">
        <span>{t("全部 {0} 张进行中", openTickets.length)}</span>
        <div className="dispatch-bulk-buttons">
          {hasActiveOpen && <button type="button" disabled={!online || !!busy} onClick={() => void bulk("pause")}>{t("全部暂停")}</button>}
          {hasPausedOpen && <button type="button" disabled={!online || !!busy} onClick={() => void bulk("resume")}>{t("全部继续")}</button>}
          <button type="button" disabled={!online || !!busy} onClick={() => setConfirmBulkCancel(true)}>{t("全部取消")}</button>
        </div>
        {confirmBulkCancel && <div className="prompt-queue-confirm">
          <p className="prompt-queue-confirm-title">{t("取消全部 {0} 张未完成工单？", openTickets.length)}</p>
          <p className="prompt-queue-confirm-description">{t("所有主机上正在执行的子任务会停止，已完成的结果保持保留。")}</p>
          <div className="prompt-queue-confirm-actions"><button type="button" className="prompt-queue-keep" onClick={() => setConfirmBulkCancel(false)}>{t("保留")}</button><button type="button" className="primary" disabled={!online || !!busy} onClick={() => void bulk("cancel")}>{t("确认全部取消")}</button></div>
        </div>}
      </div>}
      {tickets.length === 0 ? <p className="dispatch-ticket-empty">{t("当前对话暂无工单，可切换到「全部」查看其他对话的工单。")}</p> : nodeGroups ? <div className="dispatch-node-groups">
        {nodeGroups.map(group => {
          const groupOpen = group.items.filter(isOpen).length;
          return <div key={group.key} className="dispatch-node-group">
            <div className="dispatch-node-header"><Server size={12}/><span>{group.hostName}</span><small>{t("{0} 张 · {1} 未完", group.items.length, groupOpen)}</small></div>
            <ul className="dispatch-ticket-list dispatch-node-tickets">{group.items.map(renderTicket)}</ul>
          </div>;
        })}
      </div> : <ul className="dispatch-ticket-list">{tickets.map(renderTicket)}</ul>}
    </>}
  </section>;
}

/** A ticket notice folded into one quiet line; the full text opens on demand. */
export function DispatchNotice({ message }: { message: Message }) {
  useLocale();
  const text = blocksText(message.blocks);
  return <details className="dispatch-notice"><summary title={t("展开回送详情")}>{ticketNoticeSummary(text) || t("工单回送")}</summary><div className="dispatch-notice-body">{text}</div></details>;
}
