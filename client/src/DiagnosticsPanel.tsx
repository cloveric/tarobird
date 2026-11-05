import { useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { diagnosticPageSchema, type DiagnosticPage, type DiagnosticQuery } from "../../src/client-protocol/diagnostics.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";

const counterNames = () => ({ retryCount: t("任务重试"), budgetBlockedCount: t("预算拦截"), serviceErrorCount: t("服务错误"),
  serviceHealthCount: t("健康记录"), fileRejectedCount: t("文件拒绝"), workflowFailedCount: t("工作流失败"),
  turnPoolWaitCount: t("等待执行位"), crewRunsStartedCount: t("协作启动"), crewRunsCompletedCount: t("协作完成"), crewRunsFailedCount: t("协作失败") });
const channelNames = () => ({ gateway: "App", lark: t("飞书"), telegram: "Telegram", bus: "Agent Bus", hub: "Hub" });
function diagnosticError(error: unknown) {
  if (error instanceof HubHttpError && error.code === "bot_offline") return t("Bot 当前离线，重新上线后可查看它的运行记录。");
  if (error instanceof HubHttpError && error.code === "bot_timeout") return t("读取记录超时，请稍后重试。");
  return t("无法读取运行记录，请检查连接后重试。");
}
export function DiagnosticsPanel({ connection, botId, name, back }: { connection: HubConnection; botId: string | null; name: string; back: () => void }) {
  const locale = useLocale();
  const [advanced, setAdvanced] = useState(() => window.matchMedia("(min-width: 701px)").matches);
  const [statistics, setStatistics] = useState(() => window.matchMedia("(min-width: 701px)").matches);
  const [source, setSource] = useState<"timeline" | "audit">(botId ? "timeline" : "audit");
  const [type, setType] = useState(""), [outcome, setOutcome] = useState(""), [channel, setChannel] = useState(""), [chat, setChat] = useState(""), [search, setSearch] = useState("");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [page, setPage] = useState<DiagnosticPage>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [applied, setApplied] = useState<DiagnosticQuery>({ source: botId ? "timeline" : "audit", limit: 30 });
  const sequence = useRef(0);
  const date = (value: string | undefined) => value ? new Date(value).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : "—";
  async function load(query: DiagnosticQuery, more = false) {
    const id = ++sequence.current; setBusy(true); setError("");
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    try {
      const result = diagnosticPageSchema.parse(await connection.http(`${botId ? `/api/bots/${botId}/diagnostics` : "/api/ops/audit"}?${params}`));
      if (id !== sequence.current) return;
      setApplied({ ...query, before: undefined });
      setPage((previous) => more && previous && !result.cursorExpired ? { ...result, events: [...previous.events, ...result.events] } : result);
    } catch (e) { if (id === sequence.current) setError(diagnosticError(e)); }
    finally { if (id === sequence.current) setBusy(false); }
  }
  useEffect(() => { void load({ source: botId ? "timeline" : "audit", limit: 30 }); return () => { sequence.current++; }; }, [connection, botId]);
  function apply() {
    if (from && to && from > to) { setError(t("开始时间不能晚于结束时间。")); return; }
    void load({ source, limit: 30, ...(type ? { type } : {}), ...(outcome ? { outcome } : {}), ...(channel ? { channel: channel as DiagnosticQuery["channel"] } : {}),
      ...(chat ? { chat } : {}), ...(search ? { search } : {}), ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}) });
  }
  return <div className="diagnostics-panel">
    <div className="diagnostic-heading"><button className="file-action" onClick={back}><ArrowLeft size={16}/>{t("返回运行概览")}</button><h3>{name} · {t("运行记录")}</h3><button className="file-action" disabled={busy} onClick={() => { void load(applied); }}><RefreshCw size={15}/>{t("刷新记录")}</button></div>
    <p className="muted">{botId ? t("时间线展示任务执行过程，审计展示操作结果。统计覆盖当前日志及仍保留的轮转文件，并非全部历史。") : t("Hub 审计记录设备配对、登录、审批、重启及其他管理操作。")}</p>
    <form className="diagnostic-filters" onSubmit={(e) => { e.preventDefault(); apply(); }}>
      <fieldset disabled={busy}>
        {botId && <label>{t("记录来源")}<select aria-label={t("记录来源")} value={source} onChange={(e) => { setSource(e.target.value as "audit" | "timeline"); setType(""); setOutcome(""); setChannel(""); }}><option value="timeline">{t("任务时间线")}</option><option value="audit">{t("操作审计")}</option></select></label>}
        <label className="diagnostic-search">{t("关键词")}<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("搜索事件、详情或执行者")}/></label>
        <details className="diagnostic-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}><summary>{t("更多筛选")}</summary><div className="diagnostic-advanced-fields"><label>{t("事件类型")}<input aria-label={t("事件类型")} list="diagnostic-types" value={type} onChange={(e) => setType(e.target.value)} placeholder={t("全部事件")}/><datalist id="diagnostic-types">{page?.types.map((v) => <option key={v} value={v}/>)}</datalist></label>
        <label>{t("执行结果")}<select aria-label={t("执行结果")} value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">{t("全部结果")}</option>{[...new Set(["success", "error", "pending", ...(page?.outcomes ?? [])])].map((v) => <option key={v} value={v}>{v === "success" ? t("成功") : v === "error" ? t("错误") : v === "pending" ? t("待处理") : v}</option>)}</select></label>
        {botId && <><label>{t("消息通道")}<select aria-label={t("消息通道")} value={channel} onChange={(e) => setChannel(e.target.value)}><option value="">{t("全部通道")}</option>{Object.entries(channelNames()).filter(([key]) => key !== "hub").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>{t("会话标识")}<input value={chat} onChange={(e) => setChat(e.target.value)} placeholder={t("会话键或数字 ID")}/></label></>}
        <label>{t("开始时间")}<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}/></label><label>{t("结束时间")}<input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}/></label>
        </div></details><button className="primary file-action" type="submit">{t("应用筛选")}</button>
      </fieldset>
    </form>
    {error && <p className="error-text" role="alert">{error}</p>}
    {page && <>
      <p className="diagnostic-count" role="status">{t("有效记录 {0} 条 · 匹配 {1} 条 · 已显示 {2} 条", page.total, page.matched, page.events.length)}<span>{t("读取时间：")}{date(page.generatedAt)}</span></p>
      {!!page.warnings.length && <details className="diagnostic-warnings"><summary>{t("记录读取有 {0} 项提示", page.warnings.length)}</summary>{page.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
      {page.cursorExpired && <p role="status">{t("历史位置已失效，日志可能已轮转清理。请刷新记录后继续。")}</p>}
      {applied.source === "timeline" && <details className="diagnostic-statistics" open={statistics} onToggle={(e) => setStatistics(e.currentTarget.open)}><summary>{t("筛选统计")}</summary><div className="diagnostic-metrics">{Object.entries(counterNames()).map(([key, label]) => <div key={key}><small>{label}</small><strong>{page.counts[key] ?? 0}</strong></div>)}</div></details>}
      <p className="muted">{t("筛选内最近成功：")}{date(page.lastSuccessAt)} · {t("最近错误：")}{date(page.lastErrorAt)}</p>
      <div className="diagnostic-events">{page.events.map((event) => <article className={`diagnostic-event outcome-${event.outcome === "error" ? "error" : "other"}`} key={event.id}>
        <header><strong>{event.type}</strong><time>{date(event.timestamp)}</time></header>
        <div className="diagnostic-tags"><span>{event.outcome === "success" ? t("成功") : event.outcome === "error" ? t("错误") : event.outcome === "pending" ? t("待处理") : event.outcome === "info" ? t("信息") : event.outcome || t("未记录结果")}</span>{event.channel && <span>{channelNames()[event.channel as keyof ReturnType<typeof channelNames>] ?? event.channel}</span>}{event.conversation && <code>{event.conversation}</code>}</div>
        {event.detail && <p>{event.detail}</p>}
        <details><summary>{t("查看记录详情")}</summary>{event.actor && <p>{t("执行者：")}{event.actor}</p>}{event.chatId && <p>{t("数字会话 ID：")}{event.chatId}</p>}<code>{event.id}</code><pre>{event.metadata}</pre>{event.truncated && <p>{t("这条记录较长，详情显示已截短；原日志未改动。")}</p>}</details>
      </article>)}</div>
      {!page.events.length && !page.cursorExpired && <p className="diagnostic-empty">{page.missing ? t("尚无可读取的记录。") : t("没有符合筛选条件的记录。")}</p>}
      {page.next && <button className="file-action diagnostic-more" disabled={busy} onClick={() => { void load({ ...applied, before: page.next! }, true); }}>{t("加载更早记录")}</button>}
    </>}{busy && <p role="status">{t("正在读取记录…")}</p>}
  </div>;
}
