import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Plus, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import type { TerminalPolicy, TerminalSessionInfo, TerminalStatus } from "../../src/client-protocol/host-terminal.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import { platformName } from "./SettingsParts.js";
import { parseAnsiOutput, type AnsiSegment } from "./terminal-ansi.js";
import "./terminal.css";

export { parseAnsiOutput, type AnsiSegment };

interface ScopedTabsState {
  connection: HubConnection;
  conversationId: string;
  tabs: TerminalSessionInfo[];
  activeId?: string;
}

// Single-flight lock per (connection, conversationId) so React StrictMode double
// effects or rapid visibility toggles never spawn duplicate auto-created shells.
const inFlightLoads = new WeakMap<HubConnection, Map<string, Promise<TerminalSessionInfo[]>>>();

function loadConversationTabs(
  connection: HubConnection,
  conversationId: string,
  autoCreate: boolean,
  cols: number,
  rows: number,
): Promise<TerminalSessionInfo[]> {
  let byConversation = inFlightLoads.get(connection);
  if (!byConversation) {
    byConversation = new Map();
    inFlightLoads.set(connection, byConversation);
  }
  const existing = byConversation.get(conversationId);
  if (existing) return existing;
  const work = (async () => {
    const list = await connection.terminalList(conversationId);
    if (list.length === 0 && autoCreate) {
      const created = await connection.terminalCreate({ conversationId, cols, rows });
      return [created];
    }
    return list;
  })().finally(() => {
    const map = inFlightLoads.get(connection);
    if (map?.get(conversationId) === work) map.delete(conversationId);
  });
  byConversation.set(conversationId, work);
  return work;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isAuthError(error: unknown): boolean {
  return error instanceof HubHttpError && (error.status === 401 || error.status === 403);
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function measureTerminalSize(node: HTMLDivElement | null): { cols: number; rows: number } {
  if (!node) return { cols: 100, rows: 28 };
  const width = Math.max(0, node.clientWidth - 24);
  const height = Math.max(0, node.clientHeight - 20);
  if (width < 40 || height < 40) return { cols: 100, rows: 28 };
  const cols = Math.max(20, Math.min(320, Math.floor(width / 7.5)));
  const rows = Math.max(6, Math.min(120, Math.floor(height / 18.75)));
  return { cols, rows };
}

export function TerminalPanel({
  connection,
  conversationId,
  hostName,
  visible,
  close,
  onUnauthorized,
}: {
  connection: HubConnection;
  conversationId: string;
  hostName: string;
  visible: boolean;
  close: () => void;
  onUnauthorized?: () => void;
}) {
  useLocale();
  const connectionState = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state);
  const online = connectionState.status === "online";
  const hostScope = connection.identity.hubPublicKey ?? "";

  const [tabsState, setTabsState] = useState<ScopedTabsState>(() => ({
    connection,
    conversationId,
    tabs: [],
    activeId: undefined,
  }));
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [closingIds, setClosingIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [commandInput, setCommandInput] = useState("");

  const seqRef = useRef<Record<string, number>>({});
  const lastSizeRef = useRef<Record<string, string>>({});
  const closingIdsRef = useRef(new Set<string>());
  const loadGenRef = useRef(0);
  const scopeRef = useRef({ connection, conversationId });
  scopeRef.current = { connection, conversationId };
  const sizeRef = useRef({ cols: 100, rows: 28 });
  const screenRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sameScope = tabsState.connection === connection && tabsState.conversationId === conversationId;
  const tabs = sameScope ? tabsState.tabs : [];
  const activeId = sameScope ? tabsState.activeId : undefined;
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? tabs[0], [tabs, activeId]);
  const bufferKey = (termId: string) => `${hostScope}:${termId}`;

  // Clear stale scope input/errors synchronously on conversation or Host change.
  useEffect(() => {
    ++loadGenRef.current;
    setTabsState({ connection, conversationId, tabs: [], activeId: undefined });
    setError("");
    setCommandInput("");
    setBusy(false);
    closingIdsRef.current.clear();
    setClosingIds({});
  }, [connection, conversationId]);

  const refreshTabs = useCallback(async (autoCreate: boolean) => {
    if (!conversationId || connection.state.status !== "online") return;
    const generation = ++loadGenRef.current;
    const targetConnection = connection;
    const targetConversationId = conversationId;
    const isCurrent = () =>
      loadGenRef.current === generation
      && scopeRef.current.connection === targetConnection
      && scopeRef.current.conversationId === targetConversationId;

    setBusy(true);
    setError("");
    try {
      const { cols, rows } = sizeRef.current;
      const list = await loadConversationTabs(targetConnection, targetConversationId, autoCreate, cols, rows);
      if (!isCurrent()) return;
      setTabsState((prev) => {
        const prevActive = prev.connection === targetConnection && prev.conversationId === targetConversationId
          ? prev.activeId
          : undefined;
        const nextActive = prevActive && list.some((item) => item.id === prevActive) ? prevActive : list[0]?.id;
        return { connection: targetConnection, conversationId: targetConversationId, tabs: list, activeId: nextActive };
      });
    } catch (cause) {
      if (!isCurrent() || isAbortError(cause)) return;
      if (isAuthError(cause)) {
        setError(t("此设备尚未获得主机终端权限。"));
        onUnauthorized?.();
      } else if (cause instanceof HubHttpError && cause.code === "conversation_archived") {
        setError(t("当前对话已归档，无法打开主机终端。"));
      } else if (cause instanceof HubHttpError && cause.code === "terminal_workspace_unavailable") {
        setError(t("当前对话暂无可用的主机工作区目录。"));
      } else {
        setError(t("无法连接到主机终端，请确认主机在线且已启用终端权限。"));
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [connection, conversationId, onUnauthorized]);

  useEffect(() => {
    if (!visible || !online) return;
    void refreshTabs(true);
  }, [visible, online, conversationId, refreshTabs]);

  // Keep PTY dimensions synced with the rendered panel container.
  useEffect(() => {
    if (!visible) return;
    const node = screenRef.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const activeTabId = activeTab?.id;
    const activeTabRunning = !!activeTab?.running;

    const sendSize = () => {
      const next = measureTerminalSize(node);
      sizeRef.current = next;
      if (!activeTabId || !activeTabRunning || !online) return;
      const key = bufferKey(activeTabId);
      const token = `${next.cols}x${next.rows}`;
      if (lastSizeRef.current[key] === token) return;
      lastSizeRef.current[key] = token;
      void connection.terminalResize(activeTabId, next.cols, next.rows).catch((cause) => {
        if (lastSizeRef.current[key] === token) delete lastSizeRef.current[key];
        if (isAuthError(cause)) onUnauthorized?.();
      });
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(sendSize, 150);
    };
    sendSize();
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [visible, activeTab?.id, activeTab?.running, online, connection, hostScope, onUnauthorized]);

  // Stream output for the active tab while panel is visible; hiding panel aborts
  // the in-flight long-poll immediately without stopping the Host shell.
  useEffect(() => {
    if (!visible || !activeTab || !activeTab.running || !online) return;
    const controller = new AbortController();
    let cancelled = false;
    const termId = activeTab.id;
    const key = bufferKey(termId);
    const targetConnection = connection;
    const targetConversationId = conversationId;

    const poll = async () => {
      while (!cancelled && !controller.signal.aborted) {
        try {
          const after = seqRef.current[key] ?? 0;
          const out = await targetConnection.terminalReadOutput(termId, after, after === 0 ? 500 : 6000, controller.signal);
          if (cancelled || controller.signal.aborted) return;
          if (out.chunks.length > 0) {
            seqRef.current[key] = out.seq;
            const appended = out.chunks.map((c) => c.data).join("");
            setBuffers((old) => ({ ...old, [key]: ((old[key] ?? "") + appended).slice(-120_000) }));
          }
          setTabsState((prev) => {
            if (prev.connection !== targetConnection || prev.conversationId !== targetConversationId) return prev;
            return {
              ...prev,
              tabs: prev.tabs.map((item) => item.id === termId ? { ...item, running: out.running, exitCode: out.exitCode } : item),
            };
          });
          if (!out.running) return;
        } catch (cause) {
          if (cancelled || controller.signal.aborted || isAbortError(cause)) return;
          if (isAuthError(cause)) {
            setError(t("此设备尚未获得主机终端权限。"));
            onUnauthorized?.();
            return;
          }
          if (cause instanceof HubHttpError && cause.status === 404) {
            delete seqRef.current[key];
            delete lastSizeRef.current[key];
            setTabsState((prev) => {
              if (prev.connection !== targetConnection || prev.conversationId !== targetConversationId) return prev;
              const remaining = prev.tabs.filter((item) => item.id !== termId);
              return {
                ...prev,
                tabs: remaining,
                activeId: prev.activeId === termId ? remaining[0]?.id : prev.activeId,
              };
            });
            setError(t("此终端已关闭。"));
            return;
          }
          if (targetConnection.state.status !== "online") return;
          await abortableDelay(1500, controller.signal);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [visible, activeTab?.id, activeTab?.running, online, connection, conversationId, hostScope, onUnauthorized]);

  const activeBuffer = activeTab ? (buffers[bufferKey(activeTab.id)] ?? "") : "";

  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight;
  }, [activeBuffer, activeTab?.id]);

  const createTab = async () => {
    if (busy || !conversationId || !online) return;
    const targetConnection = connection;
    const targetConversationId = conversationId;
    setBusy(true);
    setError("");
    try {
      const { cols, rows } = sizeRef.current;
      const created = await targetConnection.terminalCreate({ conversationId: targetConversationId, cols, rows });
      if (scopeRef.current.connection !== targetConnection || scopeRef.current.conversationId !== targetConversationId) return;
      setTabsState((prev) => {
        const baseTabs = prev.connection === targetConnection && prev.conversationId === targetConversationId ? prev.tabs : [];
        return {
          connection: targetConnection,
          conversationId: targetConversationId,
          tabs: [...baseTabs, created],
          activeId: created.id,
        };
      });
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (cause) {
      if (scopeRef.current.connection !== targetConnection || scopeRef.current.conversationId !== targetConversationId) return;
      if (isAuthError(cause)) {
        setError(t("此设备尚未获得主机终端权限。"));
        onUnauthorized?.();
      } else if (cause instanceof HubHttpError && cause.code === "conversation_archived") {
        setError(t("当前对话已归档，无法打开主机终端。"));
      } else if (cause instanceof HubHttpError && cause.code === "terminal_workspace_unavailable") {
        setError(t("当前对话暂无可用的主机工作区目录。"));
      } else {
        setError(t("无法新建终端标签页。"));
      }
    } finally {
      if (scopeRef.current.connection === targetConnection && scopeRef.current.conversationId === targetConversationId) {
        setBusy(false);
      }
    }
  };

  const closeTab = async (id: string) => {
    if (closingIdsRef.current.has(id)) return;
    closingIdsRef.current.add(id);
    setClosingIds((old) => ({ ...old, [id]: true }));
    setError("");
    const targetConnection = connection;
    const targetConversationId = conversationId;
    const key = bufferKey(id);
    try {
      try {
        await targetConnection.terminalClose(id);
      } catch (cause) {
        if (cause instanceof HubHttpError && cause.status === 404) {
          // Already closed on the Host; remove the stale tab cleanly.
        } else {
          throw cause;
        }
      }
      delete seqRef.current[key];
      delete lastSizeRef.current[key];
      setBuffers((old) => { const next = { ...old }; delete next[key]; return next; });
      setTabsState((prev) => {
        if (prev.connection !== targetConnection || prev.conversationId !== targetConversationId) return prev;
        const remaining = prev.tabs.filter((item) => item.id !== id);
        return {
          ...prev,
          tabs: remaining,
          activeId: prev.activeId === id ? remaining[0]?.id : prev.activeId,
        };
      });
    } catch (cause) {
      if (scopeRef.current.connection === targetConnection && scopeRef.current.conversationId === targetConversationId) {
        if (isAuthError(cause)) {
          setError(t("此设备尚未获得主机终端权限。"));
          onUnauthorized?.();
        } else {
          setError(t("关闭终端失败，请重试。"));
        }
      }
    } finally {
      closingIdsRef.current.delete(id);
      setClosingIds((old) => { const next = { ...old }; delete next[id]; return next; });
    }
  };

  const sendRaw = async (data: string) => {
    if (!activeTab || !activeTab.running || !online) return;
    const termId = activeTab.id;
    const targetConnection = connection;
    const targetConversationId = conversationId;
    try {
      await targetConnection.terminalWriteInput(termId, data);
    } catch (cause) {
      if (scopeRef.current.connection !== targetConnection || scopeRef.current.conversationId !== targetConversationId) return;
      if (isAuthError(cause)) {
        setError(t("此设备尚未获得主机终端权限。"));
        onUnauthorized?.();
      } else if (cause instanceof HubHttpError && (cause.status === 404 || cause.status === 409)) {
        setTabsState((prev) => {
          if (prev.connection !== targetConnection || prev.conversationId !== targetConversationId) return prev;
          if (cause.status === 404) {
            const remaining = prev.tabs.filter((item) => item.id !== termId);
            return { ...prev, tabs: remaining, activeId: prev.activeId === termId ? remaining[0]?.id : prev.activeId };
          }
          return { ...prev, tabs: prev.tabs.map((item) => item.id === termId ? { ...item, running: false } : item) };
        });
        setError(t("此终端已关闭。"));
      } else {
        setError(t("发送终端输入失败。"));
      }
    }
  };

  const submitCommand = async () => {
    if (!activeTab || !activeTab.running || !online) return;
    const text = commandInput;
    setCommandInput("");
    await sendRaw(text + "\r");
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCommand();
    } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void sendRaw("\x03");
    } else if (event.ctrlKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void sendRaw("\x04");
    } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      if (activeTab) setBuffers((old) => ({ ...old, [bufferKey(activeTab.id)]: "" }));
    }
  };

  const rendered = useMemo(() => parseAnsiOutput(activeBuffer), [activeBuffer]);

  return (
    <aside className="terminal-panel conversation-side-panel" aria-label={t("主机终端")} hidden={!visible}>
      <header className="terminal-header">
        <div className="terminal-heading">
          <TerminalIcon size={16} aria-hidden="true" />
          <strong>{t("终端")}</strong>
          <span className="terminal-host-badge">{hostName}</span>
        </div>
        <div className="terminal-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("新建终端")}
            title={t("新建终端")}
            disabled={busy || !online}
            onClick={() => void createTab()}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("隐藏终端面板")}
            title={t("隐藏面板（终端继续在后台运行）")}
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="terminal-tabs" role="tablist" aria-label={t("终端标签页")}>
        {tabs.map((tab) => {
          const selected = tab.id === activeTab?.id;
          return (
            <div key={tab.id} className={`terminal-tab${selected ? " is-active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="terminal-tab-select"
                onClick={() => setTabsState((prev) => prev.connection === connection && prev.conversationId === conversationId ? { ...prev, activeId: tab.id } : prev)}
              >
                <i className={`terminal-tab-dot ${tab.running ? "is-live" : "is-exited"}`} aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                disabled={!!closingIds[tab.id]}
                aria-label={t("关闭并结束 {0}", tab.title)}
                title={t("关闭标签页并结束该终端")}
                onClick={() => void closeTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab && (
        <div className="terminal-meta">
          <span className="terminal-cwd" title={activeTab.cwd}>{activeTab.cwd}</span>
          <span className="terminal-state">
            {activeTab.running ? t("运行中") : t("已退出 ({0})", activeTab.exitCode ?? 0)}
          </span>
        </div>
      )}

      {error && <p className="terminal-error" role="alert">{error}</p>}

      <div
        ref={screenRef}
        className="terminal-screen"
        tabIndex={0}
        onClick={() => inputRef.current?.focus()}
      >
        {!activeTab ? (
          <div className="terminal-empty">
            <p>{t("当前对话尚无运行中的终端。")}</p>
            <button type="button" className="primary" disabled={busy || !online} onClick={() => void createTab()}>
              <Plus size={14} />{t("新建终端")}
            </button>
          </div>
        ) : (
          <pre className="terminal-output">
            {rendered.length > 0 ? rendered.map((seg, i) => (
              <span
                key={i}
                style={{
                  ...(seg.color ? { color: seg.color } : {}),
                  ...(seg.background ? { backgroundColor: seg.background } : {}),
                  ...(seg.bold ? { fontWeight: 600 } : {}),
                  ...(seg.dim ? { opacity: 0.7 } : {}),
                }}
              >
                {seg.text}
              </span>
            )) : <span className="terminal-placeholder">{t("已连接到主机工作区，输入命令并按回车执行…")}</span>}
          </pre>
        )}
      </div>

      {activeTab && (
        <div className="terminal-input-bar">
          <span className="terminal-prompt" aria-hidden="true">$</span>
          <input
            ref={inputRef}
            type="text"
            className="terminal-input"
            aria-label={t("终端命令输入")}
            placeholder={activeTab.running ? t("输入命令，按回车执行（Ctrl+C 中断）") : t("此终端已退出")}
            disabled={!activeTab.running || !online}
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className="terminal-ctrl-btn"
            disabled={!activeTab.running || !online}
            title="Ctrl+C"
            onClick={() => void sendRaw("\x03")}
          >
            Ctrl+C
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("清空输出")}
            title={t("清空输出")}
            onClick={() => setBuffers((old) => ({ ...old, [bufferKey(activeTab.id)]: "" }))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </aside>
  );
}

/** Local-controller owner per-device Host terminal permission control (off by default). */
export function HostTerminalSettings({
  connection,
  active = true,
  refreshKey = "",
  busyChange,
  onChanged,
}: {
  connection: HubConnection;
  active?: boolean;
  refreshKey?: string;
  busyChange?: (busy: boolean) => void;
  onChanged?: (status: TerminalStatus) => void;
}) {
  useLocale();
  const state = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state);
  const online = state.status === "online";
  const [snapshot, setSnapshot] = useState<{ connection: HubConnection; status?: TerminalStatus; loadError?: string }>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const readGenRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      busyChange?.(false);
    };
  }, [connection, busyChange]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (connection.state.status !== "online" || !connection.state.hostTerminalAvailable) return;
    const gen = ++readGenRef.current;
    const targetConnection = connection;
    try {
      const next = await targetConnection.terminalStatus(signal);
      if (!mountedRef.current || readGenRef.current !== gen || signal?.aborted) return;
      setSnapshot({ connection: targetConnection, status: next, loadError: undefined });
      onChanged?.(next);
    } catch (cause) {
      if (!mountedRef.current || readGenRef.current !== gen || signal?.aborted || isAbortError(cause)) return;
      setSnapshot((prev) => ({
        connection: targetConnection,
        status: prev?.connection === targetConnection ? prev.status : undefined,
        loadError: t("暂时无法读取主机终端权限设置。"),
      }));
    }
  }, [connection, onChanged]);

  useEffect(() => {
    setSaveError("");
    if (!active || !online || !state.hostTerminalAvailable) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { controller.abort(); };
  }, [active, online, state.hostTerminalAvailable, refreshKey, load]);

  if (!state.hostTerminalAvailable) return null;

  const current = snapshot?.connection === connection ? snapshot : undefined;
  const status = current?.status;
  const loadError = current?.loadError;

  if (status && !status.canManage) return null;
  if (!status || !status.policy) {
    if (loadError && state.user?.role === "owner") {
      return (
        <section className="terminal-settings-card" aria-label={t("主机终端权限")}>
          <div className="terminal-settings-head">
            <div>
              <strong>{t("主机终端")}</strong>
              <p className="error-text" role="alert">{loadError}</p>
            </div>
            <button type="button" className="secondary" disabled={!online} onClick={() => void load()}>
              {t("重试")}
            </button>
          </div>
        </section>
      );
    }
    return null;
  }

  const policy: TerminalPolicy = status.policy;
  const allDevices = status.devices ?? [];
  const isMobilePlatform = (platform: string) => platform === "ios" || platform === "android";
  const listedDevices = allDevices.filter(
    (device) => !isMobilePlatform(device.platform)
      || policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.publicKey),
  );
  const controlsDisabled = saving || !online;
  const errorMessage = saveError || loadError || "";

  const savePolicy = async (enabled: boolean, grants: TerminalPolicy["grants"]) => {
    if (!online || saving) return;
    setSaving(true);
    busyChange?.(true);
    setSaveError("");
    const targetConnection = connection;
    try {
      await targetConnection.terminalConfigure({
        expectedRevision: policy.revision,
        enabled,
        grants,
        requestId: crypto.randomUUID(),
      });
      await load();
    } catch {
      if (mountedRef.current) setSaveError(t("保存主机终端权限失败，请重试。"));
    } finally {
      if (mountedRef.current) setSaving(false);
      busyChange?.(false);
    }
  };

  const toggleDevice = (device: { id: string; publicKey: string }) => {
    const exists = policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.publicKey);
    const nextGrants = exists
      ? policy.grants.filter((g) => !(g.deviceId === device.id && g.publicKey === device.publicKey))
      : [...policy.grants.filter((g) => g.deviceId !== device.id), { deviceId: device.id, publicKey: device.publicKey }];
    void savePolicy(policy.enabled, nextGrants);
  };

  return (
    <section className="terminal-settings-card" aria-label={t("主机终端权限")}>
      <div className="terminal-settings-head">
        <div>
          <strong>{t("主机终端")}</strong>
          <p className="settings-note muted">
            {t("默认关闭。开启后仅被授权的电脑设备可在对话工作区中打开主机 Shell，所有开启和关闭记录均写入审计日志。")}
          </p>
        </div>
        <label className="terminal-settings-toggle">
          <input
            type="checkbox"
            checked={policy.enabled}
            disabled={controlsDisabled}
            onChange={(e) => void savePolicy(e.target.checked, policy.grants)}
          />
          <span>{t("允许主机终端")}</span>
        </label>
      </div>
      {!online && <p className="settings-note muted" role="status">{t("离线时无法修改主机终端权限。")}</p>}
      {errorMessage && <p className="error-text" role="alert">{errorMessage}</p>}
      {policy.enabled && (
        <div className="terminal-settings-devices">
          <small className="muted">{t("按设备授权（仅电脑端显示终端入口）")}</small>
          {listedDevices.length === 0 ? (
            <p className="settings-note muted">{t("暂无可授权的电脑设备。")}</p>
          ) : listedDevices.map((device) => {
            const granted = policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.publicKey);
            const mobile = isMobilePlatform(device.platform);
            return (
              <label key={device.id} className="terminal-settings-device-row">
                <input
                  type="checkbox"
                  checked={granted}
                  disabled={controlsDisabled || (mobile && !granted)}
                  onChange={() => toggleDevice(device)}
                />
                <span>{device.name}</span>
                <small className="muted">
                  {mobile ? `${platformName(device.platform)} · ${t("移动设备仅可撤销，不支持打开终端")}` : platformName(device.platform)}
                </small>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
