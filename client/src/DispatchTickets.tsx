import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import { OPEN_TICKET_STATUSES, dispatchTicketSchema, engineHealthSchema, ticketOverviewListSchema, type EngineHealth, type TicketAction, type TicketOverview, type TicketOverviewList, type TicketStatus } from "../../src/client-protocol/dispatch.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
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
export function DispatchTickets({ connection, botId, active, online, open }: { connection: HubConnection; botId: string; active: boolean; online: boolean; open: (conversationId: string) => void }) {
  const locale = useLocale() === "en" ? "en" : "zh-CN";
  const [list, setList] = useState<TicketOverviewList>(), [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(""), [confirming, setConfirming] = useState<{ id: string; action: "cancel" | "remove" }>(), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
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
    const load = async () => {
      clearTimeout(timer);
      // A hidden window skips reads until it is visible again.
      if (reading || controller.signal.aborted || document.visibilityState === "hidden") return;
      reading = true; const read = beginTicketRead(connection, botId), local = ++reads.current, request = queueRequest([controller.signal], 8000);
      try {
        const value = ticketOverviewListSchema.parse(await request.wait(connection.http(`/api/bots/${encodeURIComponent(botId)}/tickets?summary=1&capabilities=1`, { signal: request.signal })));
        if (!controller.signal.aborted && local === reads.current) {
          // Only a read started after the action ended can show its effect.
          for (const [key, entry] of pending.current) {
            const [id, action] = key.split(":") as [string, TicketAction], ticket = value.tickets.find(item => item.id === id);
            if (entry.after !== undefined && local > entry.after && ticket && applied(ticket, action)) pending.current.delete(key);
          }
          setList(value); publishTicketSignal(connection, botId, read, value.tickets, true);
        }
      } catch { /* Keep the last list; the next poll retries. */ }
      finally { request.dispose(); reading = false; if (!controller.signal.aborted) timer = setTimeout(() => void load(), 4000); }
    };
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", visible);
    void load(); return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [connection, botId, active, online, refresh]);
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
      if (alive.current) setList(value => value && { ...value, tickets: action === "remove" ? value.tickets.filter(item => item.id !== next.id) : value.tickets.map(item => item.id === next.id ? next : item) });
    } catch (cause) {
      if (cause instanceof HubHttpError && cause.status >= 400 && cause.status < 500) pending.current.delete(key);
      else pending.current.set(key, { requestId, after: reads.current });
      if (alive.current) setError(actionError(cause, action));
    } finally { request.dispose(); reads.current++; if (alive.current) { setBusy(""); setRefresh(value => value + 1); } }
  };
  const reset = async (engine: string) => {
    if (busy) return; setBusy(engine); setError("");
    const request = queueRequest([], 20_000);
    try { const engines = engineHealthSchema.array().parse(await request.wait(connection.http(`/api/dispatch/engines/${engine}/reset`, { method: "POST", signal: request.signal }))); if (alive.current) setList(value => value && { ...value, engines }); }
    catch (cause) { if (alive.current) setError(actionError(cause)); }
    finally { request.dispose(); if (alive.current) setBusy(""); }
  };
  const tickets = [...list?.tickets ?? []].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt - a.updatedAt);
  const engines = (list?.engines ?? []).filter(health => health.state !== "ok");
  if (!tickets.length && !engines.length) return null;
  const openTickets = tickets.filter(isOpen), shown = expanded, now = Date.now();
  const counts = (["needs_answer", "needs_review", "blocked", "working", "queued"] as const).map(status => [status, openTickets.filter(ticket => displayStatus(ticket) === status).length] as const).filter(([, count]) => count);
  const summary = counts.length ? counts.map(([status, count]) => `${count} ${statusLabel(status)}`).join(" · ") : t("没有进行中的工单");
  return <section className="dispatch-tickets" aria-label={t("工单")}>
    {tickets.length > 0 && <button type="button" className="dispatch-tickets-trigger" aria-label={`${t("工单 {0}", tickets.length)} · ${summary}`} aria-expanded={shown} onClick={() => setExpanded(!shown)}><ListChecks size={15}/><span>{t("工单 {0}", tickets.length)}</span><small>{counts.length ? counts.map(([status, count], index) => <Fragment key={status}>{index > 0 && " · "}<span className={status === "needs_review" ? "dispatch-ticket-review" : undefined}>{count} {statusLabel(status)}</span></Fragment>) : summary}</small><ChevronRight size={14}/></button>}
    {engines.length > 0 && <p className="dispatch-engines">{engines.map(health => <span key={health.engine} title={health.reason}>{engineNotice(health, locale)}<button type="button" disabled={!online || !!busy} onClick={() => void reset(health.engine)}>{t("清除")}</button></span>)}</p>}
    {error && <p className="dispatch-tickets-error" role="alert">{error}</p>}
    {shown && tickets.length > 0 && <ul className="dispatch-ticket-list">{tickets.map(ticket => {
      const attempt = ticket.attempts.at(-1), stopping = !!attempt?.stopRequested && !attempt.endedAt, open_ = isOpen(ticket), disabled = !online || !!busy;
      return <li key={ticket.id} className="dispatch-ticket" data-status={ticket.status} data-ticket-id={ticket.id}>
        <div className="dispatch-ticket-heading"><strong title={ticket.title}>{ticket.title}</strong>{ticket.paused && open_ && !stopping && <span className="dispatch-ticket-paused">{t("已暂停")}</span>}<span className="dispatch-ticket-status">{stopping ? t(attempt.stopRequested === "cancel" ? "正在取消" : "正在暂停") : statusLabel(displayStatus(ticket))}</span></div>
        {attempt?.waitingFor && !attempt.endedAt && !stopping && <p role="status">{t("打开执行会话，处理问题或权限审批。")}</p>}
        {stopping && <p role="status">{t("正在等待执行停止，确认结束后才能继续。")}</p>}
        <div className="dispatch-ticket-meta">{attempt && <span>{[ENGINE_NAMES[attempt.engine] ?? attempt.engine, attempt.model || t("默认模型"), attempt.effort].filter(Boolean).join(" · ")}</span>}<time dateTime={new Date(ticket.updatedAt).toISOString()}>{when(ticket.updatedAt, locale, now)}</time></div>
        <div className="dispatch-ticket-actions">
          {attempt && <button type="button" onClick={() => open(attempt.conversationId)}>{t("打开")}</button>}
          {ticket.status === "needs_review" && <button type="button" disabled={disabled} onClick={() => void act(ticket, "accept")}>{t("验收")}</button>}
          {open_ && <button type="button" disabled={disabled || stopping} onClick={() => void act(ticket, ticket.paused ? "resume" : "pause")}>{ticket.paused && !stopping ? t("继续") : t("暂停")}</button>}
          {open_ && <button type="button" disabled={disabled} onClick={() => setConfirming({ id: ticket.id, action: "cancel" })}>{t("取消")}</button>}
          {!open_ && list?.capabilities?.remove === true && <button type="button" disabled={disabled || ticket.attempts.some(item => !item.endedAt)} onClick={() => setConfirming({ id: ticket.id, action: "remove" })}>{t("移除")}</button>}
        </div>
        {confirming?.id === ticket.id && <div className="prompt-queue-confirm" ref={confirmation}>
          <p className="prompt-queue-confirm-title">{t(confirming.action === "remove" ? "移除这张工单？" : "取消这张工单？")}</p>
          <p className="prompt-queue-confirm-description">{t(confirming.action === "remove" ? "从此幕僚长的工单列表移除，保留执行对话和生成文件。" : "正在进行的工作会停止，对话记录保留。")}</p>
          <div className="prompt-queue-confirm-actions"><button type="button" className="prompt-queue-keep" onClick={() => setConfirming(undefined)}>{t("保留")}</button><button type="button" className="primary" disabled={disabled} onClick={() => void act(ticket, confirming.action)}>{t(confirming.action === "remove" ? "确认移除工单" : "确认取消工单")}</button></div>
        </div>}
      </li>;
    })}</ul>}
  </section>;
}

/** A ticket notice folded into one quiet line; the full text opens on demand. */
export function DispatchNotice({ message }: { message: Message }) {
  useLocale();
  const text = blocksText(message.blocks);
  return <details className="dispatch-notice"><summary title={t("展开回送详情")}>{ticketNoticeSummary(text) || t("工单回送")}</summary><div className="dispatch-notice-body">{text}</div></details>;
}
