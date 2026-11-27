import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Activity, ChevronDown, ChevronRight, Monitor, RefreshCw, Square, X } from "lucide-react";
import {
  formatCpuPercent,
  formatMemoryBytes,
  sortResourceBots,
  sortResourceConversations,
  type HostResourceStopRequest,
  type HostResourcesSnapshot,
  type ResourceBotGroup,
  type ResourceProcess,
  type ResourceSortKey,
  type ResourceSparklinePoint,
} from "../../src/client-protocol/host-resources.js";
import { useBackAction } from "./back-navigation.js";
import type { ConnectionState, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useDialogDrag } from "./dialog-drag.js";
import { t, useLocale } from "./i18n.js";
import "./resources.css";

export type ResourceHostEntry = {
  id: string;
  name: string;
  connection: HubConnection;
};

const POLL_OPEN_MS = 3_000;

function useConnectionState(connection: HubConnection | undefined): ConnectionState | undefined {
  const subscribe = useCallback(
    (notify: () => void) => (connection ? connection.subscribe(notify) : () => {}),
    [connection],
  );
  return useSyncExternalStore(subscribe, () => connection?.state);
}

function useStableConnections(hosts: readonly ResourceHostEntry[]): readonly HubConnection[] {
  const ref = useRef<readonly HubConnection[]>([]);
  const next = hosts.map((host) => host.connection);
  if (next.length !== ref.current.length || next.some((conn, index) => conn !== ref.current[index])) {
    ref.current = next;
  }
  return ref.current;
}

export function useAnyHostResourcesAvailable(hosts: readonly ResourceHostEntry[]): boolean {
  const connections = useStableConnections(hosts);
  const subscribe = useCallback((notify: () => void) => {
    const unsubs = connections.map((conn) => conn.subscribe(notify));
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [connections]);
  return useSyncExternalStore(
    subscribe,
    () => connections.some((conn) => Boolean(conn.state.hostResourcesAvailable)),
  );
}

export function ResourceSparkline({
  points,
  metric = "memory",
  width = 84,
  height = 22,
}: {
  points: readonly ResourceSparklinePoint[];
  metric?: "memory" | "cpu";
  width?: number;
  height?: number;
}) {
  if (!points.length) return null;
  const values = points.map((p) => (metric === "cpu" ? p.cpuPercent : p.memoryBytes));
  const max = Math.max(...values, metric === "cpu" ? 10 : 1024 * 1024);
  const min = 0;
  const range = Math.max(1e-6, max - min);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((v, i) => {
    const x = values.length > 1 ? i * step : width / 2;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = values.length === 1
    ? `M 0,${coords[0]!.split(",")[1]} L ${width},${coords[0]!.split(",")[1]}`
    : `M ${coords.join(" L ")}`;
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;
  return (
    <svg className="resources-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="resources-sparkline-area" d={areaPath} />
      <path className="resources-sparkline-line" d={linePath} />
    </svg>
  );
}

type PendingStop =
  | {
    mode: "conversation";
    botId: string;
    botName: string;
    conversationId: string;
    conversationTitle: string;
  }
  | {
    mode: "process";
    botId: string;
    botName: string;
    pid: number;
    processName: string;
  };

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException
    ? cause.name === "AbortError"
    : cause instanceof Error && cause.name === "AbortError";
}

function useHostResources(connection: HubConnection | undefined, active: boolean, intervalMs: number) {
  const connState = useConnectionState(connection);
  const status = connState?.status ?? "offline";
  const available = Boolean(connState?.hostResourcesAvailable);
  const ready = Boolean(connection && status === "online" && available);

  const [snapshot, setSnapshot] = useState<HostResourcesSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const mountedRef = useRef(true);
  const activeConnectionRef = useRef<HubConnection | undefined>(connection);
  activeConnectionRef.current = connection;
  const requestSeqRef = useRef(0);
  const inflightRef = useRef<{ connection: HubConnection; seq: number; controller: AbortController } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      inflightRef.current?.controller.abort();
      inflightRef.current = null;
    };
  }, []);

  const load = useCallback(async (force = false) => {
    if (!connection || connection.state.status !== "online" || !connection.state.hostResourcesAvailable) return;
    if (!force && inflightRef.current?.connection === connection) return;
    if (inflightRef.current) {
      inflightRef.current.controller.abort();
      inflightRef.current = null;
    }
    const seq = ++requestSeqRef.current;
    const controller = new AbortController();
    inflightRef.current = { connection, seq, controller };
    setLoading(true);
    try {
      const data = await connection.hostResources({ force, signal: controller.signal });
      if (!mountedRef.current || requestSeqRef.current !== seq || activeConnectionRef.current !== connection) return;
      setSnapshot(data);
      setError("");
    } catch (cause) {
      if (!mountedRef.current || requestSeqRef.current !== seq || activeConnectionRef.current !== connection) return;
      if (controller.signal.aborted && isAbortError(cause)) return;
      setError(cause instanceof Error ? cause.message : t("无法读取资源数据"));
    } finally {
      if (inflightRef.current?.seq === seq) inflightRef.current = null;
      if (mountedRef.current && requestSeqRef.current === seq && activeConnectionRef.current === connection) {
        setLoading(false);
      }
    }
  }, [connection]);

  useEffect(() => {
    requestSeqRef.current += 1;
    inflightRef.current?.controller.abort();
    inflightRef.current = null;
    setSnapshot(undefined);
    setError("");
    setLoading(false);
  }, [connection]);

  useEffect(() => {
    if (!active || !connection || !ready) {
      requestSeqRef.current += 1;
      inflightRef.current?.controller.abort();
      inflightRef.current = null;
      setLoading(false);
      return;
    }
    void load(false);
    const timer = setInterval(() => {
      if (!document.hidden) void load(false);
    }, intervalMs);
    return () => {
      clearInterval(timer);
      requestSeqRef.current += 1;
      inflightRef.current?.controller.abort();
      inflightRef.current = null;
    };
  }, [active, connection, ready, intervalMs, load]);

  return {
    snapshot,
    loading,
    error,
    status,
    available,
    ready,
    refresh: useCallback(() => { void load(true); }, [load]),
  };
}

function ResourceTreeBody({
  hostName,
  status,
  available,
  snapshot,
  loading,
  error,
  sort,
  forceReadOnly = false,
  stoppingKey,
  onRequestStop,
}: {
  hostName: string;
  status: ConnectionState["status"];
  available: boolean;
  snapshot?: HostResourcesSnapshot;
  loading: boolean;
  error: string;
  sort: ResourceSortKey;
  forceReadOnly?: boolean;
  stoppingKey?: string;
  onRequestStop?: (target: PendingStop) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sortedBots = useMemo(() => sortResourceBots(snapshot?.bots ?? [], sort), [snapshot?.bots, sort]);

  if (status === "connecting") {
    return <p className="resources-empty muted" role="status">{t("正在连接「{0}」…", hostName)}</p>;
  }
  if (status !== "online") {
    return <p className="resources-empty muted" role="status">{t("主机「{0}」当前离线，恢复连接后可查看资源占用。", hostName)}</p>;
  }
  if (!available) {
    return <p className="resources-empty muted" role="status">{t("主机「{0}」暂不支持资源管理，请更新主机后查看。", hostName)}</p>;
  }
  if (error && !snapshot) {
    return <p className="resources-empty error-text" role="alert">{t("暂时无法读取资源使用情况。")}</p>;
  }
  if (!snapshot) {
    return <p className="resources-empty muted" role="status">{loading ? t("正在采样进程资源…") : t("暂无资源数据")}</p>;
  }

  const readOnly = forceReadOnly || !snapshot.canStop;
  const canStop = !readOnly;
  const toggleBot = (botId: string) => setCollapsed((old) => ({ ...old, [botId]: !old[botId] }));

  return (
    <div className="resources-body">
      <section className="resources-card" aria-label={t("TaroBird 自身占用")}>
        <header className="resources-card-head">
          <div>
            <strong>TaroBird</strong>
            <span className="resources-card-sub">
              {t("{0} 个进程 · {1} 个运行中任务", snapshot.summary.processCount, snapshot.summary.activeTasks)}
            </span>
          </div>
          <div className="resources-card-totals">
            <span className="resources-metric-pill">{formatCpuPercent(snapshot.summary.totalCpuPercent)} CPU</span>
            <span className="resources-metric-pill">{formatMemoryBytes(snapshot.summary.totalMemoryBytes)}</span>
          </div>
        </header>
        <div className="resources-sparkline-row">
          <div className="resources-sparkline-box">
            <span>{t("内存趋势")}</span>
            <ResourceSparkline points={snapshot.history} metric="memory" width={144} height={28} />
          </div>
          <div className="resources-sparkline-box">
            <span>{t("CPU 趋势")}</span>
            <ResourceSparkline points={snapshot.history} metric="cpu" width={144} height={28} />
          </div>
        </div>
        <div className="resources-breakdown">
          <div className="resources-breakdown-card">
            <small>{t("主机服务")}</small>
            <span>{formatCpuPercent(snapshot.summary.hostCpuPercent)} · {formatMemoryBytes(snapshot.summary.hostMemoryBytes)}</span>
          </div>
          {snapshot.summary.appMemoryBytes > 0 && (
            <div className="resources-breakdown-card">
              <small>{t("桌面应用")}</small>
              <span>{formatCpuPercent(snapshot.summary.appCpuPercent)} · {formatMemoryBytes(snapshot.summary.appMemoryBytes)}</span>
            </div>
          )}
          <div className="resources-breakdown-card">
            <small>{t("引擎与 Bot")}</small>
            <span>{formatCpuPercent(snapshot.summary.engineCpuPercent)} · {formatMemoryBytes(snapshot.summary.engineMemoryBytes)}</span>
          </div>
        </div>
      </section>

      <section className="resources-section" aria-label={t("Bot 与引擎进程")}>
        <header className="resources-section-head">
          <h3>{t("Bot 与对话进程")}</h3>
          {readOnly && <span className="resources-readonly-badge">{t("只读")}</span>}
        </header>
        {!sortedBots.length ? (
          <p className="resources-empty muted">{t("当前没有运行中的 Bot 进程。")}</p>
        ) : (
          <ul className="resources-bot-list">
            {sortedBots.map((bot: ResourceBotGroup) => {
              const isCollapsed = !!collapsed[bot.botId];
              const conversations = sortResourceConversations(bot.conversations, sort);
              return (
                <li key={bot.botId} className="resources-bot-group">
                  <button
                    type="button"
                    className="resources-bot-row"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleBot(bot.botId)}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <span className="resources-bot-name">{bot.botName}</span>
                    {bot.engine && <span className="resources-engine-tag">{bot.engine}</span>}
                    {bot.activeTurns > 0 && <span className="resources-active-tag">{t("{0} 运行中", bot.activeTurns)}</span>}
                    <span className="resources-row-metrics">
                      <span>{formatCpuPercent(bot.cpuPercent)}</span>
                      <span>{formatMemoryBytes(bot.memoryBytes)}</span>
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="resources-bot-children">
                      {(() => {
                        const hasSharedMultiTurn = bot.activeTurns > 1
                          && conversations.some((conv) => conv.processes.length === 0)
                          && bot.unattributed.some((proc) => proc.kind === "engine");
                        return (
                          <>
                            {conversations.map((conv) => {
                              const convStopKey = `${bot.botId}:${conv.conversationId}`;
                              const isSharedMetrics = hasSharedMultiTurn
                                && conv.processes.length === 0
                                && conv.cpuPercent === 0
                                && conv.memoryBytes === 0;
                              return (
                                <div key={conv.conversationId} className="resources-conv-group">
                                  <div className="resources-conv-row">
                                    <span className="resources-conv-title" title={conv.title}>{conv.title}</span>
                                    <span className="resources-row-metrics">
                                      {isSharedMetrics ? (
                                        <span className="resources-shared-tag">{t("共享进程")}</span>
                                      ) : (
                                        <>
                                          <span>{formatCpuPercent(conv.cpuPercent)}</span>
                                          <span>{formatMemoryBytes(conv.memoryBytes)}</span>
                                        </>
                                      )}
                                    </span>
                                    {canStop && conv.stoppable && (
                                      <button
                                        type="button"
                                        className="resources-stop-btn"
                                        disabled={stoppingKey === convStopKey}
                                        aria-label={t("停止 {0} 中的运行", conv.title)}
                                        onClick={() => onRequestStop?.({
                                          mode: "conversation",
                                          botId: bot.botId,
                                          botName: bot.botName,
                                          conversationId: conv.conversationId,
                                          conversationTitle: conv.title,
                                        })}
                                      >
                                        <Square size={11} aria-hidden="true" />
                                        <span>{t("停止")}</span>
                                      </button>
                                    )}
                                  </div>
                                  {conv.processes.length > 0 && (
                                    <ul className="resources-proc-list">
                                      {conv.processes.map((proc: ResourceProcess) => {
                                        const procKey = `${bot.botId}:pid:${proc.pid}`;
                                        return (
                                          <li key={proc.id} className="resources-proc-row">
                                            <span className="resources-proc-name">{proc.name}</span>
                                            <span className="resources-proc-pid">PID {proc.pid}</span>
                                            <span className="resources-row-metrics">
                                              <span>{formatCpuPercent(proc.cpuPercent)}</span>
                                              <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                                            </span>
                                            {canStop && proc.stoppable && conv.processes.length > 1 && (
                                              <button
                                                type="button"
                                                className="resources-stop-btn is-subtle"
                                                disabled={stoppingKey === procKey}
                                                aria-label={t("停止进程 {0}", proc.pid)}
                                                onClick={() => onRequestStop?.({
                                                  mode: "process",
                                                  botId: bot.botId,
                                                  botName: bot.botName,
                                                  pid: proc.pid,
                                                  processName: proc.name,
                                                })}
                                              >
                                                <Square size={10} aria-hidden="true" />
                                              </button>
                                            )}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </div>
                              );
                            })}
                            {hasSharedMultiTurn && (
                              <p className="resources-shared-note">
                                {t("多个并发对话共享此 Bot 的引擎进程，进程占用汇总列在下方；仍可按对话分别停止。")}
                              </p>
                            )}
                          </>
                        );
                      })()}
                      {bot.unattributed.length > 0 && (
                        <ul className="resources-proc-list is-bot-other">
                          {bot.unattributed.map((proc: ResourceProcess) => {
                            const procKey = `${bot.botId}:pid:${proc.pid}`;
                            return (
                              <li key={proc.id} className="resources-proc-row">
                                <span className="resources-proc-name">{proc.name}</span>
                                <span className="resources-proc-pid">PID {proc.pid}</span>
                                <span className="resources-row-metrics">
                                  <span>{formatCpuPercent(proc.cpuPercent)}</span>
                                  <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                                </span>
                                {canStop && proc.stoppable && (
                                  <button
                                    type="button"
                                    className="resources-stop-btn is-subtle"
                                    disabled={stoppingKey === procKey}
                                    aria-label={t("停止进程 {0}", proc.pid)}
                                    onClick={() => onRequestStop?.({
                                      mode: "process",
                                      botId: bot.botId,
                                      botName: bot.botName,
                                      pid: proc.pid,
                                      processName: proc.name,
                                    })}
                                  >
                                    <Square size={10} aria-hidden="true" />
                                    <span>{t("停止")}</span>
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {snapshot.unattributed.length > 0 && (
        <section className="resources-section" aria-label={t("未归属进程")}>
          <header className="resources-section-head">
            <h3>{t("未归属进程")}</h3>
          </header>
          <ul className="resources-proc-list resources-unattributed-list">
            {snapshot.unattributed.map((proc) => (
              <li key={proc.id} className="resources-proc-row">
                <span className="resources-proc-name">{proc.name}</span>
                <span className="resources-proc-pid">PID {proc.pid}</span>
                <span className="resources-row-metrics">
                  <span>{formatCpuPercent(proc.cpuPercent)}</span>
                  <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Centered desktop Resource Manager modal dialog. */
function ResourcesDialog({
  id,
  hosts,
  targetHost,
  onSelectHost,
  status,
  available,
  ready,
  snapshot,
  loading,
  error,
  sort,
  onSortChange,
  stopNotice,
  stopError,
  stoppingKey,
  pendingStop,
  onRequestStop,
  onConfirmStop,
  onCancelStop,
  onRefresh,
  onClose,
  returnFocus,
}: {
  id: string;
  hosts: readonly ResourceHostEntry[];
  targetHost: ResourceHostEntry;
  onSelectHost: (hostId: string) => void;
  status: ConnectionState["status"];
  available: boolean;
  ready: boolean;
  snapshot?: HostResourcesSnapshot;
  loading: boolean;
  error: string;
  sort: ResourceSortKey;
  onSortChange: (sort: ResourceSortKey) => void;
  stopNotice: string;
  stopError: string;
  stoppingKey?: string;
  pendingStop?: PendingStop;
  onRequestStop: (target: PendingStop) => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
  onRefresh: () => void;
  onClose: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const intentionalClose = useRef(false);
  const titleId = useId();
  const busy = !!pendingStop || !!stoppingKey;

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useBackAction(dialogRef, requestClose);
  useDialogDrag(dialogRef, headerRef, true);

  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    intentionalClose.current = false;
    node?.showModal();
    if (document.activeElement === closeButtonRef.current || !node?.contains(document.activeElement)) {
      headingRef.current?.focus({ preventScroll: true });
    }
    return () => {
      intentionalClose.current = true;
      node?.close();
      const target = returnFocus?.current?.isConnected ? returnFocus.current : before?.isConnected ? before : null;
      target?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  return (
    <>
      <dialog
        ref={dialogRef}
        id={id}
        className="resources-dialog is-movable"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onCancel={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onClose={(event) => {
          if (event.target !== event.currentTarget || intentionalClose.current || event.currentTarget.open) return;
          if (busy) {
            event.currentTarget.showModal();
          } else {
            onClose();
          }
        }}
        onPointerDown={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          backdropPress.current = event.button === 0 && event.target === event.currentTarget
            && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
        }}
        onClick={(event) => {
          const startedOutside = backdropPress.current;
          backdropPress.current = false;
          if (startedOutside && event.target === event.currentTarget && !busy) {
            const r = event.currentTarget.getBoundingClientRect();
            if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
              onClose();
            }
          }
        }}
      >
        <header ref={headerRef} className="resources-dialog-header">
          <div className="resources-dialog-title">
            <Activity size={17} aria-hidden="true" />
            <h2 id={titleId} ref={headingRef} tabIndex={-1}>{t("资源管理")}</h2>
          </div>
          <div className="resources-dialog-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t("刷新资源")}
              title={t("刷新资源")}
              disabled={loading || !ready}
              onClick={onRefresh}
            >
              <RefreshCw size={15} className={loading ? "spin" : undefined} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button"
              aria-label={t("关闭资源面板")}
              onClick={requestClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="resources-toolbar">
          {hosts.length > 1 ? (
            <label className="resources-select-wrap">
              <Monitor size={14} aria-hidden="true" />
              <select
                aria-label={t("切换主机")}
                disabled={!!stoppingKey}
                value={targetHost.id}
                onChange={(e) => onSelectHost(e.target.value)}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>{host.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="resources-host-label"><Monitor size={14} aria-hidden="true" />{targetHost.name}</span>
          )}
          <label className="resources-select-wrap">
            <span className="screen-reader-only">{t("排序方式")}</span>
            <select aria-label={t("排序方式")} value={sort} onChange={(e) => onSortChange(e.target.value as ResourceSortKey)}>
              <option value="memory">{t("按内存排序")}</option>
              <option value="cpu">{t("按 CPU 排序")}</option>
              <option value="name">{t("按名称排序")}</option>
            </select>
          </label>
        </div>

        {stopNotice && <p className="resources-notice" role="status">{stopNotice}</p>}

        <ResourceTreeBody
          hostName={targetHost.name}
          status={status}
          available={available}
          snapshot={snapshot}
          loading={loading}
          error={error}
          sort={sort}
          stoppingKey={stoppingKey}
          onRequestStop={onRequestStop}
        />
      </dialog>

      {pendingStop && (
        <CreationDialog
          title={pendingStop.mode === "conversation" ? t("确认停止当前运行？") : t("确认终止进程？")}
          closeLabel={t("取消")}
          close={onCancelStop}
          busy={!!stoppingKey}
          showHost={false}
        >
          <p>
            {pendingStop.mode === "conversation"
              ? t("将停止「{0}」在对话「{1}」中的当前运行，效果与在聊天中点击停止相同，对话中会显示已停止。", pendingStop.botName, pendingStop.conversationTitle)
              : t("将直接终止「{0}」的子进程树（PID {1}）。若该进程为共享引擎进程，同一 Bot 的其他运行中对话也可能受影响。", pendingStop.botName, pendingStop.pid)}
          </p>
          {pendingStop.mode === "process" && (
            <p className="muted">{t("目标进程：{0} (PID {1})", pendingStop.processName, pendingStop.pid)}</p>
          )}
          {stopError && <p className="error-text" role="alert">{stopError}</p>}
          <div className="quick-actions">
            <button type="button" disabled={!!stoppingKey} onClick={onCancelStop}>{t("取消")}</button>
            <button type="button" className="text-danger" disabled={!!stoppingKey} onClick={onConfirmStop}>
              {stoppingKey
                ? t("正在停止…")
                : pendingStop.mode === "conversation"
                  ? t("确认停止")
                  : t("确认终止")}
            </button>
          </div>
        </CreationDialog>
      )}
    </>
  );
}

/** Standalone Resource Manager modal mounted at desktop Workspace / ADHD level. */
export function ResourcesManagerDialog({
  id,
  hosts,
  activeHostId,
  visible,
  onClose,
  returnFocus,
}: {
  id?: string;
  hosts: readonly ResourceHostEntry[];
  activeHostId: string;
  visible: boolean;
  onClose: () => void;
  returnFocus?: RefObject<HTMLButtonElement | null>;
}) {
  useLocale();
  const fallbackId = useId();
  const dialogId = id ?? fallbackId;
  const [selectedHostId, setSelectedHostId] = useState(activeHostId);
  const [sort, setSort] = useState<ResourceSortKey>("memory");
  const [pendingStop, setPendingStop] = useState<PendingStop>();
  const [stoppingKey, setStoppingKey] = useState<string>();
  const [stopNotice, setStopNotice] = useState("");
  const [stopError, setStopError] = useState("");
  const postStopTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const selectedHostIdRef = useRef(selectedHostId);

  const targetHost = hosts.find((h) => h.id === selectedHostId)
    ?? hosts.find((h) => h.id === activeHostId)
    ?? hosts[0];
  selectedHostIdRef.current = targetHost?.id ?? "";

  useEffect(() => () => {
    if (postStopTimerRef.current) clearTimeout(postStopTimerRef.current);
  }, []);

  useEffect(() => {
    if (!visible) onClose();
  }, [visible, onClose]);

  const { snapshot, loading, error, status, available, ready, refresh } = useHostResources(
    targetHost?.connection,
    visible,
    POLL_OPEN_MS,
  );

  if (!targetHost) return null;

  const selectHost = (hostId: string) => {
    if (postStopTimerRef.current) {
      clearTimeout(postStopTimerRef.current);
      postStopTimerRef.current = undefined;
    }
    setPendingStop(undefined);
    setStopError("");
    setStopNotice("");
    setSelectedHostId(hostId);
  };

  const confirmStop = async () => {
    if (!pendingStop || !targetHost) return;
    const stopTarget = pendingStop;
    const stopHost = targetHost;
    const key = stopTarget.mode === "conversation"
      ? `${stopTarget.botId}:${stopTarget.conversationId}`
      : `${stopTarget.botId}:pid:${stopTarget.pid}`;
    setStoppingKey(key);
    setStopNotice("");
    setStopError("");
    try {
      const payload: HostResourceStopRequest = stopTarget.mode === "conversation"
        ? { botId: stopTarget.botId, conversationId: stopTarget.conversationId }
        : { botId: stopTarget.botId, pid: stopTarget.pid };
      const result = await stopHost.connection.stopHostResource(payload);
      if (selectedHostIdRef.current !== stopHost.id) return;
      setPendingStop(undefined);
      setStopError("");
      setStopNotice(
        stopTarget.mode === "conversation"
          ? (result.stopped
            ? t("已请求停止「{0}」中的运行。", stopTarget.conversationTitle)
            : t("「{0}」当前没有进行中的运行。", stopTarget.conversationTitle))
          : t("已终止进程 {0}（PID {1}）。", stopTarget.processName, stopTarget.pid),
      );
      if (postStopTimerRef.current) clearTimeout(postStopTimerRef.current);
      postStopTimerRef.current = setTimeout(() => {
        postStopTimerRef.current = undefined;
        if (selectedHostIdRef.current === stopHost.id) refresh();
      }, 300);
    } catch {
      if (selectedHostIdRef.current !== stopHost.id) return;
      setStopError(t("停止进程失败，请确认此设备具有管理员权限且主机在线。"));
    } finally {
      setStoppingKey(undefined);
    }
  };

  return (
    <ResourcesDialog
      id={dialogId}
      hosts={hosts}
      targetHost={targetHost}
      onSelectHost={selectHost}
      status={status}
      available={available}
      ready={ready}
      snapshot={snapshot}
      loading={loading}
      error={error}
      sort={sort}
      onSortChange={setSort}
      stopNotice={stopNotice}
      stopError={stopError}
      stoppingKey={stoppingKey}
      pendingStop={pendingStop}
      onRequestStop={(target) => {
        setStopError("");
        setPendingStop(target);
      }}
      onConfirmStop={() => void confirmStop()}
      onCancelStop={() => {
        if (!stoppingKey) {
          setStopError("");
          setPendingStop(undefined);
        }
      }}
      onRefresh={refresh}
      onClose={onClose}
      returnFocus={returnFocus}
    />
  );
}

/** Responsive read-only phone Resource Manager page mounted from the Host's tools page. */
export function MobileResourcesDialog({
  hosts,
  activeHostId,
  visible,
  onClose,
}: {
  hosts: readonly ResourceHostEntry[];
  activeHostId: string;
  visible: boolean;
  onClose: () => void;
}) {
  useLocale();
  const [selectedHostId, setSelectedHostId] = useState(activeHostId);
  const [sort, setSort] = useState<ResourceSortKey>("memory");

  const targetHost = hosts.find((h) => h.id === selectedHostId)
    ?? hosts.find((h) => h.id === activeHostId)
    ?? hosts[0];

  useEffect(() => {
    if (!visible) onClose();
  }, [visible, onClose]);

  const { snapshot, loading, error, status, available, ready, refresh } = useHostResources(
    targetHost?.connection,
    visible,
    POLL_OPEN_MS,
  );

  if (!targetHost) return null;

  return (
    <CreationDialog
      mobilePage
      showHost={false}
      title={t("资源管理")}
      closeLabel={t("返回")}
      close={onClose}
      className="resources-mobile-dialog"
      headerActions={(
        <button
          type="button"
          className="icon-button"
          aria-label={t("刷新资源")}
          title={t("刷新资源")}
          disabled={loading || !ready}
          onClick={refresh}
        >
          <RefreshCw size={17} className={loading ? "spin" : undefined} />
        </button>
      )}
    >
      <div className="resources-toolbar">
        {hosts.length > 1 ? (
          <label className="resources-select-wrap">
            <Monitor size={14} aria-hidden="true" />
            <select
              aria-label={t("切换主机")}
              value={targetHost.id}
              onChange={(e) => setSelectedHostId(e.target.value)}
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>{host.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <span className="resources-host-label"><Monitor size={14} aria-hidden="true" />{targetHost.name}</span>
        )}
        <label className="resources-select-wrap">
          <span className="screen-reader-only">{t("排序方式")}</span>
          <select aria-label={t("排序方式")} value={sort} onChange={(e) => setSort(e.target.value as ResourceSortKey)}>
            <option value="memory">{t("按内存排序")}</option>
            <option value="cpu">{t("按 CPU 排序")}</option>
            <option value="name">{t("按名称排序")}</option>
          </select>
        </label>
      </div>
      <p className="resources-mobile-note">
        {t("手机端仅支持查看资源占用；如需停止异常引擎进程，请在电脑端操作。")}
      </p>
      <ResourceTreeBody
        hostName={targetHost.name}
        status={status}
        available={available}
        snapshot={snapshot}
        loading={loading}
        error={error}
        sort={sort}
        forceReadOnly
      />
    </CreationDialog>
  );
}

/** Lightweight Workspace Rail footer icon button that opens the shared Resource Manager dialog.
 * Does not poll in the background while the dialog is closed. */
export const ResourcesTriggerButton = forwardRef<HTMLButtonElement, {
  open: boolean;
  controlsId?: string;
  onOpen: () => void;
}>(function ResourcesTriggerButton({ open, controlsId, onOpen }, ref) {
  useLocale();

  return (
    <button
      ref={ref}
      type="button"
      className={`icon-button resources-footer-button${open ? " is-open" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      aria-label={t("资源")}
      title={t("资源管理")}
      onClick={onOpen}
    >
      <Activity size={15} aria-hidden="true" />
    </button>
  );
});

/** Self-contained desktop status bar entry + centered Resource Manager modal dialog. */
export function DesktopResourcesBar({
  hosts,
  activeHostId,
  visible,
}: {
  hosts: readonly ResourceHostEntry[];
  activeHostId: string;
  visible: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anyAvailable = useAnyHostResourcesAvailable(hosts);
  const activeHost = hosts.find((h) => h.id === activeHostId) ?? hosts[0];

  useEffect(() => {
    if (!visible && open) setOpen(false);
  }, [visible, open]);

  if (!activeHost || (!open && !anyAvailable)) return null;

  return (
    <>
      <ResourcesTriggerButton
        ref={triggerRef}
        open={open}
        controlsId={dialogId}
        onOpen={() => setOpen(true)}
      />
      {open && (
        <ResourcesManagerDialog
          id={dialogId}
          hosts={hosts}
          activeHostId={activeHostId}
          visible={visible}
          onClose={() => setOpen(false)}
          returnFocus={triggerRef}
        />
      )}
    </>
  );
}
