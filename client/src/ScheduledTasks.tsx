import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CalendarClock, Check, ChevronRight, Clock3, Info, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import { scheduledTasksSchema, scheduleSettingsSchema, type ScheduledTask, type ScheduleMutation, type ScheduleSettings } from "../../src/client-protocol/schedules.js";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { Avatar } from "./Avatar.js";
import { useBotLabels } from "./BotReferences.js";
import { scheduleCadence } from "./schedule-cadence.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import "./scheduled-tasks.css";

type Frequency = "daily" | "weekdays" | "weekly" | "once" | "custom";
type Draft = { title: string; prompt: string; conversationId: string; frequency: Frequency; time: string; day: string; at: string; expression: string; timezone: string; sessionMode: ScheduleSettings["sessionMode"] };
// IANA names for the timezone suggestions; older WebViews simply get none.
const timeZones: readonly string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

function fresh(conversationId = ""): Draft {
  return { title: "", prompt: "", conversationId, frequency: "daily", time: "09:00", day: "1", at: "", expression: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", sessionMode: "new_per_run" };
}
function localDate(value: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function editDraft(job: ScheduledTask): Draft {
  const result = { ...fresh(job.conversationId), title: job.title, prompt: job.prompt, timezone: job.timezone, sessionMode: job.sessionMode };
  if (job.timing.kind === "once") return { ...result, frequency: "once", at: job.timing.at ? localDate(job.timing.at, job.timezone) : "" };
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(job.timing.expression);
  // Daily/workday cron tokens are not valid weekday choices. Retain the
  // default weekday so switching frequency cannot silently keep that cadence.
  return m ? { ...result, frequency: m[3] === "*" ? "daily" : m[3] === "1-5" ? "weekdays" : "weekly", time: `${m[2]!.padStart(2,"0")}:${m[1]!.padStart(2,"0")}`, day: m[3] === "*" || m[3] === "1-5" ? result.day : m[3]!, expression: job.timing.expression }
    : { ...result, frequency: "custom", expression: job.timing.expression };
}
function settings(draft: Draft): ScheduleSettings {
  const [hour, minute] = draft.time.split(":").map(Number);
  return { title: draft.title.trim(), prompt: draft.prompt.trim(), timezone: draft.timezone.trim(), sessionMode: draft.sessionMode,
    timing: draft.frequency === "once" ? { kind: "once", at: draft.at } : { kind: "cron", expression: draft.frequency === "custom" ? draft.expression.trim() : `${minute} ${hour} * * ${draft.frequency === "daily" ? "*" : draft.frequency === "weekdays" ? "1-5" : draft.day}` } };
}
// Only "save" keeps its request ID for "重试保存". Each enable/pause/delete click
// is a new request, so an unconfirmed one is checked against the list instead.
function errorText(error: unknown, operation: "load" | "save" | "mutate") {
  const code = error instanceof HubHttpError ? error.code : "";
  if (code === "bot_offline" || code === "scheduler_unavailable") return t("Bot 的调度器尚未连接，请启动 Bot 后重试。");
  if (code === "invalid_schedule") return t("执行时间或时区无效，请检查；单次任务必须安排在未来。");
  if (code === "schedule_conflict") return t("任务已在其他设备或运行过程中更新，请刷新后重新编辑。");
  if (code === "conversation_archived") return t("结果对话已归档，请先恢复对话。");
  if (code === "schedule_not_found") return t("任务已被移除，请刷新列表。");
  if (operation === "mutate") {
    // A rejection, or a request never sent while offline, did not apply. Only a
    // lost or failed response leaves the result unknown.
    const uncertain = !(error instanceof HubHttpError) || error.status === 408 || error.status >= 500 || code === "operation_uncertain";
    return uncertain ? t("未能确认操作结果，请核对最新状态后再试。") : t("操作未完成，请重试。");
  }
  if (code === "operation_uncertain") return t("执行结果尚未确认，请刷新任务列表核对，避免重复创建。");
  return operation === "save" ? t("暂时无法连接主机，请重试。重试会沿用同一次请求。") : t("暂时无法读取定时任务，请检查连接后刷新。");
}
export function ScheduledTasks({ connection, bots, conversations, initialBot, initialConversation, startCreating = false, close, openConversation, newBot }: {
  connection: HubConnection; bots: Bot[]; conversations: Conversation[]; initialBot?: string; initialConversation?: string; startCreating?: boolean;
  close: () => void; openConversation: (id: string) => void; newBot: () => void;
}) {
  const locale = useLocale();
  const botLabels = useBotLabels(), botName = (b: Bot) => botLabels.get(b.id) ?? b.name;
  const [botId, setBotId] = useState(initialBot ?? bots[0]?.id ?? "");
  const [draft, setDraft] = useState<Draft | undefined>(() => startCreating ? fresh(initialConversation) : undefined);
  const [editing, setEditing] = useState<ScheduledTask>();
  const [jobs, setJobs] = useState<ScheduledTask[]>([]), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [removeId, setRemoveId] = useState("");
  const sequence = useRef(0), alive = useRef(true);
  const submission = useRef<{ id: string; botId: string; conversationId?: string; mutation?: ScheduleMutation }>(undefined);
  const [retry, setRetry] = useState(false);
  const [choosingBot, setChoosingBot] = useState(false), [botQuery, setBotQuery] = useState(""), [botLimit, setBotLimit] = useState(50);
  const botTrigger = useRef<HTMLButtonElement>(null), restoreBotFocus = useRef(false), taskScroll = useRef(0);
  const botDescription = useId(), botRestriction = useId(), timeZoneListId = useId();
  const botRestrictionText = editing ? t("编辑时不能更换执行 Bot") : retry ? t("保存尚未确认，暂不能更换 Bot") : "";
  const bot = bots.find(b => b.id === botId);
  const matchingBots = bots.filter(b => botName(b).toLocaleLowerCase().includes(botQuery.trim().toLocaleLowerCase()));
  const selectedBot = matchingBots.find(b => b.id === botId);
  const visibleBots = (selectedBot ? [selectedBot, ...matchingBots.filter(b => b.id !== botId)] : matchingBots).slice(0, botLimit);
  const online = connection.state.status === "online" && !!bot?.online;
  const owner = connection.state.user?.role === "owner";
  const eligible = conversations.filter(c => c.botIds.includes(botId) && !c.archived && !conversations.some(p => p.id === c.parentId && p.archived));
  const change = (patch: Partial<Draft>) => setDraft(old => old ? { ...old, ...patch } : old);
  const finishChoosingBot = () => { restoreBotFocus.current = true; setChoosingBot(false); };
  useLayoutEffect(() => {
    if (choosingBot) {
      const dialog = botTrigger.current?.closest("dialog");
      dialog?.querySelector<HTMLElement>(":scope > header h2")?.focus({ preventScroll: true });
      if (dialog) dialog.scrollTop = 0;
    } else if (restoreBotFocus.current) {
      restoreBotFocus.current = false;
      botTrigger.current?.focus({ preventScroll: true });
      const dialog = botTrigger.current?.closest("dialog");
      if (dialog) dialog.scrollTop = taskScroll.current;
    }
  }, [choosingBot]);
  const chooseBot = (id: string) => {
    if (busy || retry || editing || !owner || !bots.some(b => b.id === id)) return;
    if (id !== botId) {
      // Invalidate the previous Bot's pending read before the next effect runs.
      sequence.current++; setJobs([]); setLoading(true); setBotId(id);
      setError(""); setNotice(""); setRemoveId("");
      if (draft) change({ conversationId: "" });
    }
    finishChoosingBot();
  };
  /** Resolves false only when this read failed and the list may be stale. */
  const load = async () => {
    const request = ++sequence.current; setLoading(true);
    try {
      const result = scheduledTasksSchema.parse(await connection.http(`/api/bots/${botId}/schedules`));
      if (alive.current && request === sequence.current) { setJobs(result.jobs); setError(""); }
      return true;
    } catch (e) { if (alive.current && request === sequence.current) setError(errorText(e, "load")); return false; }
    finally { if (alive.current && request === sequence.current) setLoading(false); }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  // A different Bot, host or role starts a fresh list. A connection blip keeps
  // the last result (a failed read shows its error beside it) and rereads once
  // the host is back online, instead of blanking the list on every transition.
  useEffect(() => { setJobs([]); if (botId && owner) void load(); return () => { sequence.current++; }; }, [botId, connection, owner]);
  const hostOnline = connection.state.status === "online", wasOffline = useRef(!hostOnline);
  useEffect(() => {
    if (hostOnline && wasOffline.current && botId && owner) void load();
    wasOffline.current = !hostOnline;
  }, [hostOnline]);
  const request = async (mutation: ScheduleMutation, targetBotId = botId) => {
    await connection.http(`/api/bots/${targetBotId}/schedules`, { method: "POST", body: JSON.stringify({ mutation, locale }) });
  };
  const save = async () => {
    if (!draft || busy || !online) return;
    const parsed = scheduleSettingsSchema.safeParse(settings(draft));
    if (!parsed.success) { setError(t("请填写任务名称、内容和有效的计划时间。")); return; }
    setBusy(true); setError(""); setNotice("");
    const receipt = submission.current ??= { id: `schedule_${crypto.randomUUID()}`, botId };
    try {
      if (!receipt.conversationId) {
        receipt.conversationId = editing?.conversationId || draft.conversationId || (await connection.createConversation({ v: 1, type: "conversation.create", conversationType: "direct", botIds: [receipt.botId], title: draft.title.trim(), clientActionId: receipt.id })).id;
      }
      receipt.mutation ??= editing ? { action: "update", id: editing.id, expectedUpdatedAt: editing.updatedAt, requestId: receipt.id, conversationId: receipt.conversationId, settings: parsed.data }
        : { action: "create", requestId: receipt.id, conversationId: receipt.conversationId, settings: parsed.data };
      await request(receipt.mutation, receipt.botId);
      if (!alive.current) return;
      submission.current = undefined; setRetry(false); setDraft(undefined); setEditing(undefined); setNotice(t("定时任务已保存。"));
      await load();
    } catch (e) {
      if (!alive.current) return;
      setError(errorText(e, "save"));
      const code = e instanceof HubHttpError ? e.code : "";
      if (["invalid_schedule", "schedule_conflict", "conversation_archived", "schedule_not_found"].includes(code)) {
        // Keep a newly created result conversation when correcting validation.
        setDraft(old => old ? { ...old, conversationId: receipt.conversationId ?? old.conversationId } : old);
        submission.current = undefined; setRetry(false);
      } else setRetry(true);
    } finally { if (alive.current) setBusy(false); }
  };
  const mutate = async (job: ScheduledTask, action: "enabled" | "remove") => {
    setBusy(true); setError(""); setNotice("");
    try {
      await request({ action, id: job.id, conversationId: job.conversationId, expectedUpdatedAt: job.updatedAt, requestId: `schedule_${crypto.randomUUID()}`, ...(action === "enabled" ? { enabled: !job.enabled } : {}) } as ScheduleMutation);
      if (alive.current) { setRemoveId(""); await load(); }
    } catch (e) {
      if (!alive.current) return;
      // Never replay: a lost response may already have applied this change, and
      // its expectedUpdatedAt is now stale. Read the actual tasks, then explain.
      setRemoveId(""); const refreshed = await load();
      if (alive.current) setError(refreshed ? errorText(e, "mutate") : `${errorText(e, "mutate")} ${t("暂时无法读取定时任务，请检查连接后刷新。")}`);
    } finally { if (alive.current) setBusy(false); }
  };
  const date = (value: string | null, timezone: string) => value ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("尚无执行记录");
  return <CreationDialog title={choosingBot ? t("选择执行 Bot") : draft ? editing ? t("编辑定时任务") : t("新建定时任务") : t("定时任务")} close={choosingBot ? finishChoosingBot : close} back={choosingBot} busy={busy} closeLabel={choosingBot ? t("返回定时任务") : t("关闭定时任务")} movable className={`scheduled-tasks${choosingBot ? " choosing-bot" : ""}`}>
    {!owner ? <p role="alert">{t("需要管理员权限")}</p> : <>
      {choosingBot && <section className="schedule-bot-picker" aria-label={t("选择执行 Bot")}>
        <label className="schedule-bot-search"><Search size={18} aria-hidden="true"/><input type="search" enterKeyHint="search" autoComplete="off" aria-label={t("搜索 Bot")} placeholder={t("搜索 Bot")} value={botQuery} maxLength={200} onChange={e => { setBotQuery(e.target.value); setBotLimit(50); }}/></label>
        <ul className="schedule-bot-options">{visibleBots.map(b => <li key={b.id}>
          <button type="button" className="schedule-bot-option" aria-current={b.id === botId ? "true" : undefined} onClick={() => chooseBot(b.id)}>
            <span aria-hidden="true"><Avatar kind="bot" id={b.id} name={b.name} size={36}/></span>
            <span className="schedule-bot-copy"><strong>{botName(b)}</strong><small className={b.online ? "is-online" : ""}><i aria-hidden="true"/>{b.online ? t("在线") : t("离线")}</small></span>
            {b.id === botId && <span className="schedule-bot-check" role="img" aria-label={t("已选择")}><Check size={18} aria-hidden="true"/></span>}
          </button>
        </li>)}</ul>
        {!matchingBots.length && <p className="schedule-picker-empty" role="status">{t("没有匹配的 Bot")}</p>}
        {matchingBots.length > botLimit && <button className="schedule-bot-more" type="button" onClick={() => setBotLimit(limit => limit + 50)}>{t("显示更多 Bot")}</button>}
      </section>}
      <div className="schedule-task-page" hidden={choosingBot}>
      <button ref={botTrigger} type="button" className="schedule-bot-panel" aria-label={t("执行 Bot")} aria-describedby={`${botDescription}${botRestrictionText ? ` ${botRestriction}` : ""}`} title={botRestrictionText || undefined} disabled={busy || retry || !!editing || !bots.length} onClick={event => {
        taskScroll.current = event.currentTarget.closest("dialog")?.scrollTop ?? 0;
        setBotQuery(""); setBotLimit(50); setChoosingBot(true);
      }}>
        {bot && <span aria-hidden="true"><Avatar kind="bot" id={bot.id} name={bot.name} size={36}/></span>}
        <span className="schedule-bot-selected" id={botDescription}><span className="schedule-bot-copy"><small>{t("执行 Bot")}</small><strong>{bot ? botName(bot) : botId ? t("所选 Bot 已不可用，请重新选择") : t("选择 Bot")}</strong></span>
        {bot && <span className={`schedule-bot-presence ${bot.online ? "is-online" : ""}`}><i aria-hidden="true"/>{bot.online ? t("在线") : t("离线")}</span>}</span><ChevronRight size={17} aria-hidden="true"/>
      </button>
      {botRestrictionText && <p id={botRestriction} className="schedule-bot-restriction">{botRestrictionText}</p>}
      <p className="schedule-runtime-note"><Info size={15} aria-hidden="true"/>{t("主机和 Bot 在线时执行，结果会同步到你的设备。")}</p>
      {!bots.length && <button onClick={newBot}>{t("新建 Bot")}</button>}
      {!online && bot && !error && <p className="schedule-notice">{t("Bot 的调度器尚未连接，请启动 Bot 后重试。")}</p>}
      {error && <p role="alert" className="schedule-feedback error-text">{error}</p>}{notice && <p role="status" className="schedule-feedback schedule-success"><Check size={16} aria-hidden="true"/>{notice}</p>}
      {draft ? <form onSubmit={e => { e.preventDefault(); void save(); }}>
        <fieldset disabled={busy || retry} className="schedule-form-section">
          <legend>{t("任务信息")}</legend>
          <label>{t("任务名称")}<input required maxLength={200} value={draft.title} placeholder={t("例如：每日工作简报")} onChange={e => change({ title: e.target.value })}/></label>
          <label>{t("任务内容")}<textarea required rows={3} maxLength={4000} value={draft.prompt} placeholder={t("告诉 Bot 每次需要完成什么，以及期望的结果。") } onChange={e => change({ prompt: e.target.value })}/></label>
        </fieldset>
        <fieldset disabled={busy || retry} className="schedule-form-section">
          <legend>{t("执行计划")}</legend>
          <div className="schedule-fields"><label>{t("执行频率")}<select aria-label={t("执行频率")} value={draft.frequency} onChange={e => change({ frequency: e.target.value as Frequency })}><option value="daily">{t("每天")}</option><option value="weekdays">{t("工作日（周一至周五）")}</option><option value="weekly">{t("每周")}</option><option value="once">{t("只执行一次")}</option><option value="custom">{t("自定义 Cron")}</option></select></label>
          {draft.frequency !== "once" && draft.frequency !== "custom" && <label>{t("执行时间")}<input type="time" required value={draft.time} onChange={e => change({ time: e.target.value })}/></label>}</div>
          {draft.frequency === "weekly" && <label>{t("星期")}<select aria-label={t("星期")} value={draft.day} onChange={e => change({ day: e.target.value })}>{[t("周日"),t("周一"),t("周二"),t("周三"),t("周四"),t("周五"),t("周六")].map((v,i)=><option key={i} value={i}>{v}</option>)}</select></label>}
          {draft.frequency === "once" && <label>{t("执行日期与时间")}<input type="datetime-local" required value={draft.at} onChange={e => change({ at: e.target.value })}/></label>}
          {draft.frequency === "custom" && <label>{t("Cron 表达式")}<input aria-label={t("Cron 表达式")} required maxLength={120} value={draft.expression} placeholder="0 9 * * 1-5" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" onChange={e => change({ expression: e.target.value })}/><small>{t("五段格式：分钟、小时、日、月、星期。例如 0 9 * * 1-5 表示工作日 09:00。")}</small></label>}
          <label>{t("任务时区")}<input aria-label={t("任务时区")} required maxLength={100} value={draft.timezone} placeholder="Asia/Shanghai" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" list={timeZoneListId} onChange={e => change({ timezone: e.target.value })}/><small>{t("以上日期与时间均按这个时区执行。")}</small>{timeZones.length > 0 && <datalist id={timeZoneListId}>{timeZones.map(zone => <option key={zone} value={zone}/>)}</datalist>}</label>
        </fieldset>
        <fieldset disabled={busy || retry} className="schedule-form-section">
          <legend>{t("结果与上下文")}</legend>
          <label>{t("结果发送到")}<select aria-label={t("结果发送到")} value={editing?.conversationId ?? draft.conversationId} disabled={!!editing} onChange={e => change({ conversationId: e.target.value })}><option value="">{t("新建专用对话")}</option>{eligible.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}{editing && !eligible.some(c => c.id === editing.conversationId) && <option value={editing.conversationId}>{t("原结果对话（已归档）")}</option>}</select></label>
          <details><summary>{t("上下文设置")}</summary><label>{t("执行上下文")}<select aria-label={t("执行上下文")} value={draft.sessionMode} onChange={e => change({ sessionMode: e.target.value as Draft["sessionMode"] })}><option value="new_per_run">{t("每次独立上下文（推荐）")}</option><option value="reuse">{t("沿用结果对话的上下文")}</option></select><small>{t("两种方式都使用这个 Bot 的工作区、人设和记忆。")}</small></label></details>
        </fieldset>
        <div className="schedule-actions schedule-form-actions"><button type="button" disabled={busy} onClick={() => { setDraft(undefined); setEditing(undefined); setRetry(false); submission.current = undefined; void load(); }}>{t("查看任务列表")}</button><button className="primary" disabled={busy || !online || !botId}>{busy ? t("正在保存…") : retry ? t("重试保存") : editing ? t("保存修改") : t("创建定时任务")}</button></div>
      </form> : <>
        <div className="schedule-list-toolbar">
          <h3>{t("任务列表")}<span className="schedule-count">{jobs.length}</span></h3>
          <div className="schedule-toolbar-actions"><button className="icon-button" aria-label={t("刷新")} title={t("刷新")} disabled={busy || loading || !botId} onClick={() => void load()}><RefreshCw size={16}/></button><button className="primary" disabled={busy || !botId} onClick={() => { setDraft(fresh()); setError(""); setNotice(""); }}><Plus size={16} aria-hidden="true"/>{t("新建定时任务")}</button></div>
        </div>
        {loading && <p role="status" className="schedule-notice">{t("正在读取定时任务…")}</p>}
        {!loading && !jobs.length && !error && <div className="schedule-empty"><span><CalendarClock size={28} aria-hidden="true"/></span><strong>{t("尚未创建定时任务。")}</strong><p>{t("让 Bot 按计划整理信息、检查进展或发送提醒。")}</p></div>}
        <div className="schedule-list">{jobs.map(job => <article key={job.id} className="schedule-item">
          <header className="schedule-item-heading"><div className="schedule-item-title"><span className="schedule-task-icon"><CalendarClock size={19} aria-hidden="true"/></span><h3>{job.title}</h3></div><span className={`schedule-state ${job.enabled && !job.validationError ? "is-enabled" : "is-paused"}`}>{job.validationError ? <Info size={12} aria-hidden="true"/> : job.enabled ? <Check size={12} aria-hidden="true"/> : <Pause size={12} aria-hidden="true"/>}{job.validationError ? t("需要修复") : job.enabled ? t("已启用") : t("已停用")}</span></header>
          {job.validationError && <p role="alert" className="error-text">{t("执行时间缺失，请编辑或删除此任务。")}</p>}
          <p className="schedule-cadence"><Clock3 size={14} aria-hidden="true"/>{scheduleCadence(job.timing)}<span>{job.timezone}</span></p>
          <div className="schedule-next"><span>{t("下次计划")}</span><strong>{job.validationError ? t("需要修复") : job.enabled ? job.nextRunAt ? date(job.nextRunAt,job.timezone) : t("等待下次计划") : t("已停用")}</strong></div>
          <p className="schedule-prompt-preview">{job.prompt}</p>
          <button className="schedule-conversation" aria-label={t("结果对话：{0}", conversations.find(c => c.id === job.conversationId)?.title ?? job.title)} onClick={() => openConversation(job.conversationId)}><MessageSquare size={16} aria-hidden="true"/><span><small>{t("结果对话")}</small><strong>{conversations.find(c => c.id === job.conversationId)?.title ?? job.title}</strong></span><ChevronRight size={16} aria-hidden="true"/></button>
          <details className="schedule-details"><summary data-disclosure-icon><ChevronRight size={14} aria-hidden="true"/>{t("任务详情")}</summary><div className="schedule-detail-body"><h4>{t("任务内容")}</h4><p className="schedule-prompt">{job.prompt}</p>{job.deliveryMode === "notify" && <p>{t("此任务直接发送提醒，不调用模型。")}</p>}<dl><div><dt>{t("计划表达式：")}</dt><dd>{job.timing.kind === "cron" ? <code>{job.timing.expression}</code> : job.timing.at ? date(job.timing.at,job.timezone) : t("需要修复")}</dd></div><div><dt>{t("最近执行：")}</dt><dd>{date(job.lastRunAt,job.timezone)}</dd></div></dl>{job.lastError && <p className="error-text">{job.lastError}</p>}</div></details>
          <div className="schedule-actions schedule-item-actions"><button disabled={busy || !online} onClick={() => { setEditing(job); setDraft(editDraft(job)); setError(""); setNotice(""); }}><Pencil size={14} aria-hidden="true"/>{t("编辑")}</button><button disabled={busy || !online || (!job.enabled && !!job.validationError)} onClick={() => void mutate(job,"enabled")}>{job.enabled ? <Pause size={14} aria-hidden="true"/> : <Play size={14} aria-hidden="true"/>}{job.enabled ? t("暂停任务") : t("启用任务")}</button><button className="schedule-delete" disabled={busy || !online} onClick={() => setRemoveId(job.id)}><Trash2 size={14} aria-hidden="true"/>{t("删除")}</button></div>
          {removeId === job.id && <div className="schedule-remove"><p>{t("删除这个定时任务？已有对话和执行结果会保留。")}</p><div className="schedule-actions"><button disabled={busy} onClick={() => setRemoveId("")}>{t("取消")}</button><button className="danger" disabled={busy} onClick={() => void mutate(job,"remove")}>{t("确认删除任务")}</button></div></div>}
        </article>)}</div>
      </>}
    </div></>}
  </CreationDialog>;
}
