import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { botDashboardSchema, type BotDashboard as Dashboard, type DashboardUsageBucket } from "../../src/client-protocol/dashboard.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { DashboardCronList } from "./DashboardCronList.js";
import { t, useLocale } from "./i18n.js";

function UsageMetrics({ value }: { value: DashboardUsageBucket | undefined }) {
  if (!value) return <p className="dashboard-empty">{t("此期间没有用量记录，消耗未知。")}</p>;
  const measured = value.requestCount > 0 || value.totalInputTokens + value.totalOutputTokens + value.totalCachedTokens > 0;
  const token = (n: number) => measured ? n.toLocaleString() : t("未知");
  const metrics = [
    [t("输入 tokens"), token(value.totalInputTokens)], [t("输出 tokens"), token(value.totalOutputTokens)], [t("缓存 tokens"), token(value.totalCachedTokens)],
    [t("已记录费用"), value.totalCostUsd > 0 ? `$${value.totalCostUsd.toFixed(4)}` : t("费用未知")],
    [t("有用量记录的轮次"), value.requestCount.toLocaleString()], [t("未上报用量的轮次"), value.unmeteredRequestCount.toLocaleString()],
    [t("每轮平均 tokens"), value.requestCount ? Math.round((value.totalInputTokens + value.totalOutputTokens) / value.requestCount).toLocaleString() : t("未知")],
    [t("缓存占输入与缓存之比"), value.totalInputTokens + value.totalCachedTokens > 0 ? `${(100 * value.totalCachedTokens / (value.totalInputTokens + value.totalCachedTokens)).toFixed(1)}%` : t("未知")],
  ];
  return <div className="dashboard-metrics">{metrics.map(([label, amount]) => <div key={label}><small>{label}</small><strong>{amount}</strong></div>)}</div>;
}
const stageNames = () => ({ decomposition: t("任务拆解"), research: t("研究"), analysis: t("分析"), writing: t("撰写"), review: t("审阅"), completed: t("已完成") });
function recordedStatus(status: string) { return status === "running" ? t("记录为运行中") : status === "completed" ? t("已完成") : status === "failed" ? t("失败") : status; }
export function BotDashboard({ connection, botId, name, back, records }: { connection: HubConnection; botId: string; name: string; back: () => void; records: () => void }) {
  const locale = useLocale();
  const [data, setData] = useState<Dashboard>(), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [view, setView] = useState<"activity" | "cron" | "crew" | "usage">("activity");
  const [period, setPeriod] = useState<"daily" | "monthly" | "total">("daily"), [selected, setSelected] = useState("");
  const sequence = useRef(0);
  const date = useMemo(() => {
    const formats = new Map<string, Intl.DateTimeFormat>();
    return (value: string | null, timezone?: string | null) => {
      if (!value) return t("未知");
      const key = timezone ?? "";
      if (!formats.has(key)) formats.set(key, new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", ...(timezone ? { timeZone: timezone } : {}),
      }));
      return formats.get(key)!.format(new Date(value));
    };
  }, [locale]);
  async function load() {
    const request = ++sequence.current; setBusy(true); setError("");
    try {
      const next = botDashboardSchema.parse(await connection.http(`/api/bots/${botId}/dashboard`));
      if (sequence.current === request) setData(next);
    } catch (e) {
      if (sequence.current === request) {
        setData((previous) => previous ? { ...previous, live: null } : previous);
        setError(e instanceof HubHttpError && e.code === "bot_offline" ? t("Bot 当前离线，重新上线后可读取详细概览。") : t("无法读取详细概览，请检查连接后重试。"));
      }
    } finally { if (sequence.current === request) setBusy(false); }
  }
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [botId, connection]);
  const currentPeriod = new Date().toISOString().slice(0, period === "monthly" ? 7 : 10);
  const periodKey = selected || currentPeriod;
  const buckets = period === "total" ? {} : data?.usage?.[period] ?? {};
  const periodKeys = [...new Set([currentPeriod, periodKey, ...Object.keys(buckets)])].sort().reverse();
  return <div className="bot-dashboard">
    <div className="dashboard-heading"><button className="file-action" onClick={back}><ArrowLeft size={16}/>{t("返回运行概览")}</button><h3>{name} · {t("详细概览")}</h3><button className="file-action" disabled={busy} onClick={() => { void load(); }}><RefreshCw size={15}/>{t("刷新概览")}</button></div>
    <nav className="dashboard-nav" aria-label={t("概览分类")}>{([ ["activity", t("当前活动")], ["cron", t("定时任务")], ["crew", t("协作流程")], ["usage", t("日/月用量")] ] as const).map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</nav>
    {error && <p className="error-text" role="alert">{error}</p>}{busy && <p role="status">{t("正在读取概览…")}</p>}
    {data && <>
      <p className="dashboard-caption">{t("读取时间：")}{date(data.generatedAt)} · {t("点击刷新查看最新状态。")}</p>
      {!data.live && <p className="dashboard-notice" role="status">{t("实时状态无法确认，以下仅展示已保存的数据。")}</p>}
      {!!data.warnings.length && <details className="diagnostic-warnings"><summary>{t("部分数据未能完整读取")}</summary><p>{t("缺失或损坏的记录不会自动修复；无法确认的部分显示未知。")}</p>{data.warnings.map((v) => <p key={v}>{v}</p>)}</details>}
      {view === "activity" && <section aria-label={t("当前活动")}>
        {data.live && <><p className="dashboard-caption">{t("在线进程采样：")}{date(data.live.sampledAt)}</p><div className="dashboard-metrics">{[[t("正在执行"), data.live.activeCount], [t("排队消息"), data.live.queued], [t("等待审批"), data.live.approvals], [t("等待选择"), data.live.choices], [t("合并待处理会话"), data.live.batches]].map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        {data.live.active.length ? data.live.active.map((run, index) => <article className="dashboard-card" key={index}><strong>{run.conversation}</strong><p>{t("开始时间：")}{date(run.startedAt)}</p></article>) : <p className="dashboard-empty">{t("采样时没有正在执行的会话。")}</p>}
        <p className="dashboard-caption">{t("活动统计来自当前 Bot 的运行进程；其他独立进程的任务不计入。")}</p></>}
        <h4>{t("已保存配置")}</h4><dl className="dashboard-config">{[[t("引擎"), data.config?.engine], [t("模型"), data.config?.model], ["Effort", data.config?.effort], [t("审批模式"), data.config?.permissionLabel ? t(data.config.permissionLabel) : data.config?.approvalMode], [t("美元预算"), data.config?.budgetUsd ? `$${data.config.budgetUsd}` : null], [t("已绑定会话数"), data.sessions?.toLocaleString()]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? t("未记录")}</dd></div>)}</dl>
        <p className="dashboard-caption">{t("配置显示保存值，未记录的选项由引擎采用默认设置；已绑定会话数不代表运行中任务数。")}</p><button onClick={records}>{t("查看任务时间线")}</button>
      </section>}
      {view === "cron" && <section aria-label={t("定时任务")}>
        <p className="dashboard-caption">{t("计划时间按任务时区显示；实际执行取决于 Bot 在线及调度器状态。")}</p>
        <p>{data.live?.schedulerAvailable ? t("此进程已接入定时调度器。") : t("此进程的定时调度器状态无法确认。")}</p>
        <DashboardCronList jobs={data.cron} date={date}/>
      </section>}
      {view === "crew" && <section aria-label={t("协作流程")}>
        <p className="dashboard-caption">{t("展示最近保存的协作流程，不代表此刻仍有任务运行。完整事件可在任务时间线中查看。")}</p>
        {data.crew ? <><article className="dashboard-card"><header><strong>{data.crew.prompt || data.crew.workflow}</strong><span className="dashboard-badge">{recordedStatus(data.crew.status)}</span></header><p>{t("协调者：")}{data.crew.coordinator} · {t("当前阶段：")}{stageNames()[data.crew.currentStage as keyof ReturnType<typeof stageNames>] ?? data.crew.currentStage}</p><p>{t("更新时间：")}{date(data.crew.updatedAt)}</p>{data.crew.lastError && <p className="error-text">{data.crew.lastError}</p>}<small>{data.crew.runId} · {t("会话：")}{data.crew.chatId}</small></article>
          <ol className="dashboard-stages">{data.crew.stages.map((stage) => <li key={stage.stage}><header><strong>{stageNames()[stage.stage as keyof ReturnType<typeof stageNames>] ?? stage.stage}</strong><span>{recordedStatus(stage.status)}</span></header><p>{date(stage.updatedAt)}{stage.verdict && ` · ${stage.verdict === "pass" ? t("通过") : t("需要修订")}`}{stage.revisionCount !== null && ` · ${t("修订次数：")}${stage.revisionCount}`}</p>{stage.detail && <p>{stage.detail}</p>}</li>)}</ol></> : <p className="dashboard-empty">{t("尚无可读取的协作流程。")}</p>}<button onClick={records}>{t("查看任务时间线")}</button>
      </section>}
      {view === "usage" && <section className="dashboard-usage" aria-label={t("日/月用量")}>
        <p className="dashboard-caption">{t("用量按原账本的 UTC 日期统计，包含此 Bot 曾使用过的引擎。缺失的期间不会补成零。")}</p>
        {data.usage?.source === "last-good" && <p className="dashboard-notice">{t("当前账本不可读，正在展示最近有效备份，数据可能较旧。")}</p>}
        <div className="dashboard-period"><label>{t("统计周期")}<select aria-label={t("统计周期")} value={period} onChange={(e) => { setPeriod(e.target.value as typeof period); setSelected(""); }}><option value="daily">{t("按日")}</option><option value="monthly">{t("按月")}</option><option value="total">{t("累计")}</option></select></label>{period !== "total" && <label>{t("统计期间（UTC）")}<select aria-label={t("统计期间（UTC）")} value={periodKey} onChange={(e) => setSelected(e.target.value)}>{periodKeys.map((key) => <option key={key} value={key}>{key}{key === currentPeriod ? t("（当前）") : ""}</option>)}</select></label>}</div>
        <UsageMetrics value={period === "total" ? data.usage?.total : buckets[periodKey]}/>
        <p className="dashboard-caption">{t("已记录费用可能不完整；零金额不能证明免费。部分引擎不提供美元费用，美元预算无法约束其消耗。")}</p>
        <p className="dashboard-caption">{t("账本最后更新：")}{data.usage?.total.lastUpdatedAt ? date(data.usage.total.lastUpdatedAt) : t("未知")}</p>
      </section>}
    </>}
  </div>;
}
