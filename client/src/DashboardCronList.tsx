import { useEffect, useMemo, useState } from "react";
import type { BotDashboard } from "../../src/client-protocol/dashboard.js";
import { t } from "./i18n.js";

type Job = NonNullable<BotDashboard["cron"]>[number];
type FormatDate = (value: string | null, timezone?: string | null) => string;
const PAGE_SIZE = 25;

function CronTask({ job, date }: { job: Job; date: FormatDate }) {
  const [expanded, setExpanded] = useState(false);
  return <article className="dashboard-card dashboard-cron">
    <header><strong>{job.title}</strong><span className={`dashboard-badge ${job.enabled ? "enabled" : ""}`}>{job.enabled ? t("已启用") : t("已停用")}</span></header>
    <p>{job.kind === "once" ? t("单次提醒") : t("循环任务")} · {job.channel === "gateway" ? "App" : job.channel === "lark" ? t("飞书") : "Telegram"} · {job.timezone}</p>
    <p>{t("下次计划：")}{job.enabled ? date(job.nextRunAt, job.timezone) : t("已停用")}</p>
    <p>{t("最近执行：")}{job.lastRunAt ? date(job.lastRunAt, job.timezone) : t("尚无执行记录")}</p>
    {job.lastError && <p className="error-text">{t("最近错误：")}{job.lastError}</p>}
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>{t("任务设置与执行历史")}</summary>{expanded && <>
      <p>{t("任务内容：")}{job.prompt}</p><p>{t("会话：")}{job.conversation}</p><p>{t("计划表达式：")}{job.schedule}</p>
      <p>{job.sessionMode === "reuse" ? t("复用会话") : t("每次新建会话")} · {job.deliveryMode === "notify" ? t("直接提醒") : t("交给 Agent 执行")}</p>
      <p>{job.mute ? t("不发送执行结果") : t("发送执行结果")} · {job.silent ? t("静默通知") : t("普通通知")} · {t("超时分钟：")}{job.timeoutMins}</p>
      <p>{t("连续失败：")}{job.failureCount} / {job.maxFailures} · {t("最近成功：")}{job.lastSuccessAt ? date(job.lastSuccessAt, job.timezone) : t("尚无执行记录")}</p>
      {job.history.length ? <ol className="dashboard-history">{job.history.slice().reverse().map((row, index) => <li key={index}><time>{date(row.ranAt, job.timezone)}</time> · {row.success ? t("成功") : t("失败")}{row.error && <p className="error-text">{row.error}</p>}</li>)}</ol> : <p>{t("尚无执行记录")}</p>}
      <small>{t("最多显示最近 10 次执行。任务 ID：")}{job.id}</small>
    </>}</details>
  </article>;
}

export function DashboardCronList({ jobs, date }: { jobs: BotDashboard["cron"]; date: FormatDate }) {
  const [query, setQuery] = useState(""), [status, setStatus] = useState("all"), [page, setPage] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (jobs ?? []).filter((job) => (status === "all" || job.enabled === (status === "enabled")) &&
      (!needle || [job.title, job.prompt, job.id, job.conversation].some((value) => value.toLocaleLowerCase().includes(needle))));
  }, [jobs, query, status]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  useEffect(() => { setPage((previous) => Math.min(previous, pages - 1)); }, [pages]);
  const visible = matches.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  if (jobs === null) return <p className="dashboard-empty">{t("没有可读取的定时任务记录。")}</p>;
  if (!jobs.length) return <p className="dashboard-empty">{t("尚未创建定时任务。")}</p>;
  return <>
    <div className="dashboard-cron-filters">
      <label>{t("搜索定时任务")}<input type="search" value={query} maxLength={200} placeholder={t("名称、内容、任务 ID 或会话")} onChange={(event) => { setQuery(event.target.value); setPage(0); }}/></label>
      <label>{t("任务状态")}<select aria-label={t("任务状态")} value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }}><option value="all">{t("全部任务")}</option><option value="enabled">{t("已启用")}</option><option value="disabled">{t("已停用")}</option></select></label>
    </div>
    <div className="dashboard-cron-pages">
      <p role="status">{t("显示 {0}–{1}，共 {2} 项", matches.length ? current * PAGE_SIZE + 1 : 0, current * PAGE_SIZE + visible.length, matches.length)}</p>
      {pages > 1 && <nav className="file-pagination" aria-label={t("定时任务分页")}>
        <button disabled={current === 0} onClick={() => setPage(current - 1)}>{t("上一页")}</button>
        <select aria-label={t("任务页码")} value={current} onChange={(event) => setPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index} value={index}>{index + 1} / {pages}</option>)}</select>
        <button disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>{t("下一页")}</button>
      </nav>}
    </div>
    {!matches.length && <p className="dashboard-empty">{t("没有匹配的任务，试试调整筛选条件。")}</p>}
    {visible.map((job) => <CronTask key={job.id} job={job} date={date}/>)}
  </>;
}
