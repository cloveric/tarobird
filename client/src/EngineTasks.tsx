import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, CircleStop, GitBranch, MoreHorizontal, RefreshCw, Terminal } from "lucide-react";
import { engineTaskControlResultSchema, engineTaskSnapshotSchema, type EngineTask, type EngineTaskSnapshot } from "../../src/client-protocol/engine-tasks.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { randomNonce } from "./identity.js";
import { queueRequest } from "./prompt-queue-request.js";
import { affectedBackgroundTasks } from "./turn-stop.js";
import { t, useLocale } from "./i18n.js";
import "./engine-tasks.css";

type StopReceipt = { requestId: string; state: "waiting" | "accepted" | "unknown" | "rejected"; retryable?: boolean };
const receipts = new WeakMap<HubConnection, Map<string, StopReceipt>>();
function requestStore(connection: HubConnection) { let values = receipts.get(connection); if (!values) { values = new Map(); receipts.set(connection, values); } return values; }
export function engineTaskStatus(task: EngineTask) {
  return t(task.status === "running" ? "执行中" : task.status === "done" ? "已完成" : task.status === "stopped" ? "已停止" : task.status === "error" ? "失败" : "状态待确认");
}

/** Small conversation-local task switcher. Poll only while this pane is visible;
 * a missing/failed poll never manufactures a task completion. */
export function EngineTasks({ connection, conversationId, botId, active, online, available, activity, openRequest = 0, onOpenRequestConsumed, dock, hasActiveGroups = false, compactLabel = false }: {
  connection: HubConnection; conversationId: string; botId: string; active: boolean; online: boolean; available: boolean; activity: string; openRequest?: number; onOpenRequestConsumed?: (id: number) => void; dock?: ReactNode; hasActiveGroups?: boolean; compactLabel?: boolean;
}) {
  useLocale();
  const [snapshot, setSnapshot] = useState<EngineTaskSnapshot>(), [opened, setOpened] = useState(false), [refresh, setRefresh] = useState(0);
  const [stale, setStale] = useState(false), [error, setError] = useState(""), [revision, setRevision] = useState(0), [bulk, setBulk] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), alive = useRef(true), busy = useRef(new Set<string>());
  const route = `/api/conversations/${conversationId}/tasks`, stops = requestStore(connection), receiptKey = (id: string) => `${conversationId}:${botId}:${id}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!active) setOpened(false); }, [active]);
  // Opening is a one-shot UI request. Retaining it in App would reopen a closed
  // dialog when this keyed conversation remounts after navigation or search.
  useEffect(() => { if (openRequest && active) { setOpened(true); onOpenRequestConsumed?.(openRequest); } }, [openRequest, active, onOpenRequestConsumed]);
  useEffect(() => {
    if (!active || !available || !online) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let unsupported = false, hasRunning = false;
    const load = async () => {
      const request = queueRequest([controller.signal], 8000);
      try {
        const value = engineTaskSnapshotSchema.parse(await request.wait(connection.http(`${route}?botId=${encodeURIComponent(botId)}`, { signal: request.signal })));
        if (!controller.signal.aborted) {
          // Only an explicit terminal event can retire a stop receipt. An empty
          // snapshot during reconnect must not permit a duplicate mutation.
          for (const task of value.tasks) if (["done", "error", "stopped"].includes(task.status)) stops.delete(receiptKey(task.id));
          for (const task of value.tasks) { const receipt = stops.get(receiptKey(task.id)); if (receipt?.state === "unknown") receipt.retryable = task.status === "running"; }
          setSnapshot(value); setStale(false); unsupported = !value.supported; hasRunning = value.tasks.some(task => task.status === "running") || !!value.recovery;
        }
      } catch { if (!controller.signal.aborted) setStale(true); }
      finally {
        request.dispose();
        if (!controller.signal.aborted && !unsupported) timer = setTimeout(() => void load(), opened ? 1500 : activity || hasRunning ? 4000 : 30_000);
      }
    };
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [connection, conversationId, botId, active, online, available, activity, opened, refresh]);

  const stop = async (task: EngineTask, retry = false) => {
    if (!online || !active || stale || !task.canStop || task.status !== "running" || busy.current.has(task.id)) return;
    const key = receiptKey(task.id), previous = stops.get(key);
    if (retry && !previous?.retryable) return;
    const entry: StopReceipt = { requestId: previous && !retry && previous.state !== "rejected" ? previous.requestId : randomNonce(), state: "waiting" };
    stops.set(key, entry); busy.current.add(task.id); setRevision(value => value + 1); setError("");
    const request = queueRequest([], 15_000);
    try {
      const result = engineTaskControlResultSchema.parse(await request.wait(connection.http(route, { method: "POST", body: JSON.stringify({ botId, taskId: task.id, requestId: entry.requestId }), signal: request.signal })));
      entry.state = result.outcome;
      if (result.outcome === "rejected" && alive.current) setError(t("此任务已结束或当前无法停止，请刷新状态。"));
    } catch { entry.state = "unknown"; }
    finally {
      request.dispose(); busy.current.delete(task.id);
      if (alive.current) { setRevision(value => value + 1); setRefresh(value => value + 1); }
    }
  };
  const tasks = snapshot?.tasks ?? [], running = tasks.filter(task => task.status === "running"), background = running.filter(task => task.mode === "background" && !task.parentId && task.canStop);
  const affected = activity ? affectedBackgroundTasks(snapshot) : [];
  const stopNotice = affected.length ? t("停止当前轮次也会结束 {0} 个后台{1}；可在任务列表单独停止。", affected.length, t(snapshot?.foregroundStopScope === "all" ? "任务" : "子代理")) : "";
  const stopBackground = async () => {
    // Capture this explicit selection. Tasks started after the click are not
    // implicitly added to a destructive operation or its retry.
    const selected = [...background]; setBulk(true);
    await Promise.allSettled(selected.map(task => stop(task)));
    if (alive.current) setBulk(false);
  };
  const showNative = available && (snapshot?.supported !== false || opened) && (tasks.length > 0 || !!snapshot?.recovery || opened);
  if (!showNative && !dock) return null;
  // The dock counts one saved group; native tasks cover the whole conversation.
  // Do not sum them or guess correspondence from labels, time, or task counts.
  const compact = !!dock || hasActiveGroups;
  const uncertain = !online || stale;
  const shellCount = running.filter(task => task.kind === "shell" && task.mode === "background" && !task.parentId).length;
  const managementDescription = [t("查看全部任务"), snapshot?.recovery ? t("停止尚未确认") : running.length ? t("{0} 个任务执行中", running.length) : "", uncertain && t("状态待确认")].filter(Boolean).join(" · ");
  return <div className="engine-tasks" data-revision={revision}>
    <div className={`conversation-task-bar${dock ? " has-dock" : ""}${compact ? " is-compact" : ""}`}>
      {dock}
      {showNative && <button key="management" ref={trigger} type="button" className={`engine-tasks-trigger${compact ? " is-compact" : ""}`} aria-label={t("子代理与后台任务")} aria-description={managementDescription} title={managementDescription} aria-haspopup="dialog" onClick={() => setOpened(true)}>
        {compact ? <>
          {snapshot?.recovery ? <span>{t("停止尚未确认")}</span> : uncertain ? <span>{t("状态待确认")}</span> : shellCount ? <span>{t("{0} 个后台命令", shellCount)}</span> : !dock ? <span>{t("全部任务")}</span> : null}
          {snapshot?.recovery && uncertain && <small>{t("状态待确认")}</small>}
          {running.length > 0 && !uncertain && !snapshot?.recovery && <i className="engine-tasks-activity" aria-hidden="true"/>}<MoreHorizontal size={17}/>
        </> : <>
          <GitBranch size={14}/><span>{snapshot?.recovery ? t("停止尚未确认") : running.length ? t(compactLabel ? "{0} 运行中" : "{0} 个任务执行中", running.length) : t(compactLabel ? "任务" : "子代理与后台任务")}</span>{uncertain && <small>{t("状态待确认")}</small>}<ChevronRight size={13}/>
        </>}
      </button>}
    </div>
    {available && opened && active && createPortal(<CreationDialog title={t("子代理与后台任务")} close={() => setOpened(false)} closeLabel={t("关闭任务列表")} returnFocus={trigger} className="engine-tasks-dialog">
      <div className="engine-tasks-body">
      <div className="engine-tasks-toolbar"><p>{t("主对话可以继续，后台任务会独立返回结果。")}</p><button type="button" aria-label={t("刷新任务列表")} disabled={!online} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15}/></button></div>
      {(!online || stale) && <p role="status" className="engine-tasks-notice">{t("连接中断，当前状态待确认")}</p>}
      {stopNotice && <p className="engine-tasks-notice">{stopNotice}</p>}
      {snapshot?.recovery && <SessionRecovery key={snapshot.recovery.token} connection={connection} conversationId={conversationId} botId={botId} token={snapshot.recovery.token} enabled={online && !stale} tasks={running}/>}
      {error && <p role="alert" className="engine-tasks-notice">{error}</p>}
      {!snapshot ? <p className="engine-tasks-empty">{t("正在加载…")}</p> : !snapshot.supported ? <p className="engine-tasks-empty">{t("当前 Bot 尚不支持原生任务列表。")}</p> : !tasks.length ? <p className="engine-tasks-empty">{t("当前会话还没有子代理或后台任务。")}</p> : <div className="engine-tasks-list">{[...tasks].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (a.startedAt ?? a.updatedAt) - (b.startedAt ?? b.updatedAt)).map(task => {
        const receipt = stops.get(receiptKey(task.id)), pending = busy.current.has(task.id), parent = task.parentId && tasks.find(candidate => candidate.id === task.parentId);
        return <article className={`engine-task is-${task.status}`} key={task.id} aria-label={task.label}>
          <div className="engine-task-title">{task.kind === "shell" ? <Terminal size={16}/> : <GitBranch size={16}/>}<strong>{task.label}</strong><span className="engine-task-status">{task.status === "done" && <Check size={12}/>} {engineTaskStatus(task)}</span></div>
          <div className="engine-task-meta"><span>{t(task.mode === "background" ? "后台执行" : task.status === "running" ? parent ? "父代理正在等待" : "主代理正在等待" : "前台任务")}</span>{task.startedAt && <time dateTime={new Date(task.startedAt).toISOString()}>{new Date(task.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
          {parent && <p className="engine-task-parent">{t("所属任务：{0}", parent.label)}</p>}
          {task.progress && <details className="engine-task-progress"><summary>{t("最近进展")}</summary><p>{task.progress}</p></details>}
          {task.status === "running" && receipt?.state === "accepted" && <p role="status" className="engine-tasks-notice">{t("停止请求已接收，等待任务结束。")}</p>}
          {task.status === "running" && receipt?.state === "unknown" && <p role="status" className="engine-tasks-notice">{t("停止结果待确认，可核对同一请求。")}</p>}
          {task.parentId && task.canStop && task.status === "running" && <p className="engine-task-parent">{t("要结束此工作，请停止所属子代理；只停止步骤可能被自动重试。")}</p>}
          {!task.parentId && task.canStop && task.status === "running" && <button type="button" className="engine-task-stop" disabled={!online || stale || pending || receipt?.state === "accepted"} onClick={() => void stop(task)}><CircleStop size={14}/>{pending ? t("等待停止确认") : receipt?.state === "unknown" ? t("核对停止结果") : t("停止此任务")}</button>}
          {!task.parentId && task.canStop && task.status === "running" && receipt?.state === "unknown" && receipt.retryable && <button type="button" className="engine-task-stop" disabled={!online || stale || pending} onClick={() => void stop(task, true)}>{t("重新请求停止")}</button>}
        </article>;
      })}</div>}
      </div>
      {background.length > 1 && <footer><button type="button" className="engine-task-stop" disabled={!online || stale || bulk} onClick={() => void stopBackground()}><CircleStop size={15}/>{t("停止全部后台任务")}</button></footer>}
    </CreationDialog>, document.body)}
  </div>;
}

/** Deliberate recovery is restricted to the unconfirmed worker shown here. */
function SessionRecovery({ connection, conversationId, botId, token, enabled, tasks }: { connection: HubConnection; conversationId: string; botId: string; token: string; enabled: boolean; tasks: EngineTask[] }) {
  const [confirming, setConfirming] = useState(false), [revision, setRevision] = useState(0);
  const alive = useRef(true), busy = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const store = requestStore(connection), key = `${conversationId}:${botId}:recovery:${token}`, receipt = store.get(key);
  const recover = async (retry = false) => {
    if (!enabled || busy.current) return;
    busy.current = true;
    const previous = store.get(key), entry: StopReceipt = { requestId: previous && !retry && previous.state !== "rejected" ? previous.requestId : randomNonce(), state: "waiting" };
    store.set(key, entry); setRevision(value => value + 1);
    const request = queueRequest([], 15_000);
    try { entry.state = engineTaskControlResultSchema.parse(await request.wait(connection.http(`/api/conversations/${conversationId}/tasks/recover`, { method: "POST", signal: request.signal, body: JSON.stringify({ botId, token, requestId: entry.requestId }) }))).outcome; }
    catch { entry.state = "unknown"; }
    finally { busy.current = false; request.dispose(); if (alive.current) setRevision(value => value + 1); }
  };
  return <section className="engine-tasks-recovery" data-revision={revision} aria-label={t("恢复停止未确认的会话")}>
    <p>{t("Claude 尚未确认停止，新的消息暂不能执行。")}</p>
    {!confirming ? <button type="button" disabled={!enabled} onClick={() => setConfirming(true)}>{t("强制结束此会话进程…")}</button> : <>
      <p>{t("将强制结束此会话的 Claude 进程及其全部后台任务。聊天记录保留；之后发送消息可继续会话。")}</p>
      {tasks.length > 0 && <ul>{tasks.map(task => <li key={task.id}>{task.label}</li>)}</ul>}
      {receipt?.state === "unknown" && <p role="status">{t("强制结束结果待确认，请核对原请求。")}</p>}
      {receipt?.state === "accepted" && <p role="status">{t("强制结束请求已接收，等待状态更新。")}</p>}
      {receipt?.state === "rejected" && <p role="status">{t("会话状态已改变，此次强制结束未执行。请刷新。")}</p>}
      <button type="button" disabled={!enabled || busy.current || receipt?.state === "accepted"} onClick={() => void recover()}>{receipt?.state === "unknown" ? t("核对强制结束结果") : t("确认强制结束")}</button>
      {receipt?.state === "unknown" && <button type="button" disabled={!enabled || busy.current} onClick={() => void recover(true)}>{t("重新请求强制结束")}</button>}
      <button type="button" disabled={busy.current} onClick={() => setConfirming(false)}>{t("取消")}</button>
    </>}
  </section>;
}
