import { flushWidgetStateWithin } from "./widget-state-lifecycle.js";
import { AgentBusDraftDialog } from "./AgentBusDraftDialog.js";
import { AgentBusPanel } from "./AgentBusPanel.js";
import { AgentBusList, type AgentBusNavigation } from "./AgentBusList.js";
import { busMemberStatus } from "./agent-bus-view.js";
import type { AgentBusRun, AgentBusWorkspace } from "../../src/client-protocol/agent-bus.js";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeft, Globe, Network, Check, Maximize2, Plus, MessageCircleQuestion, Minimize2, PanelsTopLeft, Search, ShieldCheck, X } from "lucide-react";
import type { ConnectedHost } from "./host-connections.js";
import type { HostDirectory, WorkspaceProps } from "./HostApp.js";
import type { HostRegistry } from "./host-registry.js";
import type { Preferences, SidebarLayout } from "./storage.js";
import { addAdhdPane, ADHD_FOLD_SETTLE_MS, ADHD_PANEL_LIMIT, ADHD_PHONE_CARD_MIN, ADHD_PHONE_COLUMNS, adhdColumns, adhdPaneKey, adhdPhoneBoard, emptyAdhdBoard, moveAdhdPane, type AdhdBoardState, type AdhdPaneRef } from "./adhd-board-state.js";
import { nativePlatform } from "./native.js";
import { useAdhdPaneDrag } from "./adhd-pane-drag.js";
import { CreationDialog } from "./CreationDialog.js";
import { Sidebar } from "./Sidebar.js";
import { AdhdWorkspaceTools, type AdhdToolActions } from "./AdhdWorkspaceTools.js";
import { BrandName } from "./BrandScenes.js";
import { SidebarLayoutSwitch } from "./SidebarLayoutSwitch.js";
import type { ConversationSelection } from "./ConversationList.js";
import { t, useLocale, formatList } from "./i18n.js";
import { isElectron } from "./desktop-bridge.js";
import { useSideWindowExpansion } from "./use-side-window-expansion.js";
import "./adhd-board.css";
import "./adhd-browser.css";
const AdhdBrowserDock = lazy(() => import("./AdhdBrowserDock.js").then(module => ({ default: module.AdhdBrowserDock })));

export type AdhdSidebarOptions = {
  query: string; focused?: AdhdPaneRef; visible: boolean;
  renderGroups: (hosts: AdhdHost[]) => ReactNode;
  selection: (hostId: string, registrationId: string) => ConversationSelection;
  select: (pane: AdhdPaneRef) => void;
};
export type AdhdHost = ConnectedHost & { directory?: HostDirectory; blocked?: boolean; local?: boolean };
type Props = { navigationRejected?: (serial: number) => void; busNavigation?: AgentBusNavigation; compact: boolean; agentBus: boolean; activeHostId: string; navigation?: { hostId: string; conversationId: string; messageId?: string; serial: number }; hosts: AdhdHost[]; registry: HostRegistry; preferences: Preferences; updatePreferences: (value: Preferences) => void; Workspace: ComponentType<WorkspaceProps>; sidebarControls: ReactNode; tools: AdhdToolActions; renderConversations: (options: AdhdSidebarOptions) => ReactNode; exit: (layout?: SidebarLayout, focused?: AdhdPaneRef) => void; open: (hostId: string, conversationId: string) => void };

/** Layout is device-local; each mounted pane reuses the owning host connection
 * and the ordinary conversation UI. No extra transports or message semantics. */
export function AdhdBoard({ navigationRejected, busNavigation, compact, agentBus, activeHostId, navigation, hosts, registry, preferences, updatePreferences, Workspace, sidebarControls, tools, renderConversations, exit, open }: Props) {
  useLocale();
  const [board, setBoard] = useState<AdhdBoardState>(emptyAdhdBoard), current = useRef(board); current.current = board;
  const [ready, setReady] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const busCapacityNotice = useRef<{ registrationId: string; workspaceId: string; text: string } | undefined>(undefined);
  const [opening, setOpening] = useState<Record<string, string>>({});
  const [busSelection, setBusSelection] = useState<AgentBusNavigation>();
  const [busOpen, setBusOpen] = useState(false), [busLeave, setBusLeave] = useState<{ run: () => void }>();
  const [busWorkspace, setBusWorkspace] = useState<AgentBusWorkspace>(), [busRun, setBusRun] = useState<AgentBusRun>();
  const busToggle = useRef<HTMLButtonElement>(null), busDock = useRef<HTMLDivElement>(null);
  const browserToggle = useRef<HTMLButtonElement>(null), shellRoot = useRef<HTMLDivElement>(null);
  const [browserOpened, setBrowserOpened] = useState(false), [browserOpen, setBrowserOpen] = useState(false);
  const browserSupported = isElectron();
  const phoneBoard = adhdPhoneBoard(nativePlatform(), navigator.userAgent);
  const browserLayout = useSideWindowExpansion(shellRoot, browserOpen && !compact);
  const closeBrowser = () => { setBrowserOpen(false); browserToggle.current?.focus({ preventScroll: true }); };
  // Both top-level tools use the right edge. Keep their contents, show one dock.
  useLayoutEffect(() => { if (busOpen) setBrowserOpen(false); }, [busOpen]);

  const closeBus = () => { setBusOpen(false); busToggle.current?.focus({ preventScroll: true }); };
  const busGuardState = useRef({ dirty: false, busy: false }), handledBus = useRef(0);
  const busGuardChanged = useCallback((value: { dirty: boolean; busy: boolean }) => { busGuardState.current = value; }, []);
  const busChanged = useCallback((value: AgentBusWorkspace | undefined, run: AgentBusRun | undefined) => { setBusWorkspace(value); setBusRun(run); }, []);
  const busGuard = (run: () => void) => {
    if (busGuardState.current.busy) { setNotice(t("请等待协作操作完成。")); return; }
    if (busGuardState.current.dirty) { setBusLeave({ run }); return; }
    run();
  };
  const selectBus = (host: AdhdHost, workspaceId?: string) => {
    if (busSelection?.registrationId === host.host.registrationId && busSelection.workspaceId === workspaceId) { setBusOpen(true); if (busWorkspace) revealBus(busWorkspace); return; }
    busGuard(() => { setReveal(undefined); setBusWorkspace(undefined); setBusRun(undefined); setBusSelection({ hostId: host.host.id, registrationId: host.host.registrationId, workspaceId, serial: Date.now() }); setBusOpen(true); });
  };
  const [query, setQuery] = useState(""), [focused, setFocused] = useState(""), [expanded, setExpanded] = useState("");
  // Disclosure choices last only for this visit to ADHD. Own them above list
  // slices so filtering, pinning and host regrouping cannot reset an open group.
  const [expandedTopics, setExpandedTopics] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const busyRef = useRef(busy); busyRef.current = busy;
  const [unsaved, setUnsaved] = useState<Record<string, boolean>>({});
  const unsavedRef = useRef(unsaved); unsavedRef.current = unsaved;
  const [draftSaving, setDraftSaving] = useState<Record<string, boolean>>({});
  const draftSavingRef = useRef(draftSaving); draftSavingRef.current = draftSaving;
  const [pendingLeave, setPendingLeave] = useState<{ run: () => void; keys?: string[] }>();
  const [leaving, setLeaving] = useState<{ run: () => void }>();
  const [saving, setSaving] = useState(false), saves = useRef(Promise.resolve()), revision = useRef(0);
  const live = useRef(true), search = useRef<HTMLInputElement>(null), grid = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900), committedWidth = useRef(900);
  useLayoutEffect(() => { committedWidth.current = width; }, [width]);
  const [focusRequests, setFocusRequests] = useState<Record<string, { serial: number; messageId?: string }>>({});
  const focusSerial = useRef(0), handledNavigation = useRef(0), cancelledBusReveal = useRef(0);
  const [reveal, setReveal] = useState<{ key: string; serial: number; settleBusLayout?: boolean }>();
  useEffect(() => {
    if (!reveal?.settleBusLayout || cancelledBusReveal.current === reveal.serial) return;
    if (!busOpen || compact) { cancelledBusReveal.current = reveal.serial; return; }
    // A dock transition can change the automatic column count after the first
    // reveal. Finish only this explicit intent after its layout commits; a new
    // navigation or user interaction cancels it instead of pulling them back.
    const animations = busDock.current?.getAnimations() ?? [];
    let cancelled = false, frame = 0;
    const events = ["wheel", "touchstart", "pointerdown", "keydown", "resize"] as const;
    const cancel = () => {
      cancelled = true; cancelAnimationFrame(frame);
      for (const event of events) window.removeEventListener(event, interrupt, true);
    };
    const interrupt = () => { cancelledBusReveal.current = reveal.serial; cancel(); };
    for (const event of events) window.addEventListener(event, interrupt, { capture: true, passive: true });
    // The open dock narrows the grid; the automatic column count follows only
    // after its ResizeObserver render commits. That commit can land after
    // the dock animation, moving the target away again. Correct once the
    // committed width matches the grid (bounded).
    const measured = () => {
      const node = grid.current; if (!node) return committedWidth.current;
      const style = getComputedStyle(node); return node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    };
    let waited = 0;
    void Promise.allSettled(animations.map(animation => animation.finished)).then(function settle() {
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        if (measured() !== committedWidth.current && ++waited < 30) { settle(); return; }
        frame = requestAnimationFrame(() => {
          if (cancelled) return;
          // Commit the correction while this intent's input cancellation is
          // still active. A second React reveal can leave a passive card effect
          // queued after the user has already scrolled away.
          const target = Array.from(grid.current?.children ?? []).find(element =>
            element instanceof HTMLElement && element.dataset.paneKey === reveal.key && !element.hidden);
          if (target instanceof HTMLElement) target.scrollIntoView({ block: "nearest", inline: "nearest" });
          cancelledBusReveal.current = reveal.serial;
          cancel();
        });
      });
    });
    return cancel;
  }, [reveal, busOpen, compact]);
  const [keyboardTarget, setKeyboardTarget] = useState<{ key: string; serial: number }>();
  const microphone = useRef(""); const [microphoneOwner, setMicrophoneOwner] = useState("");
  const claimMicrophone = useCallback((key: string) => { if (microphone.current && microphone.current !== key) return false; microphone.current = key; setMicrophoneOwner(key); return true; }, []);
  const releaseMicrophone = useCallback((key: string) => { if (microphone.current === key) { microphone.current = ""; setMicrophoneOwner(""); } }, []);
  const load = useCallback(async () => {
    try { const saved = await registry.adhdBoard(); if (live.current) { current.current = saved; setBoard(saved); setReady(true); setError(""); } }
    catch { if (live.current) setError(t("面板布局未能读取，原记录已保留。请重试。")); }
  }, [registry]);
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [load]);
  const persist = (next: AdhdBoardState) => {
    const id = ++revision.current;
    current.current = next; setBoard(next); setSaving(true); setError(""); setNotice("");
    saves.current = saves.current.catch(() => undefined).then(() => registry.saveAdhdBoard(next)).then(() => {
      if (live.current && revision.current === id) setSaving(false);
    }, () => { if (live.current && revision.current === id) { setSaving(false); setError(t("面板布局尚未保存，请重试。对话和草稿不受影响。")); } });
  };
  useLayoutEffect(() => {
    const node = grid.current; if (!node) return;
    const measure = () => { const style = getComputedStyle(node); setWidth(node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)); };
    const observer = new ResizeObserver(measure); observer.observe(node); measure(); return () => observer.disconnect();
  }, [ready]);
  const locked = Object.values(busy).some(Boolean);
  const busyPanes = board.panes.filter(pane => busy[adhdPaneKey(pane)]);
  const busyNames = formatList(busyPanes.map(pane => { const host = hosts.find(host => host.host.registrationId === pane.registrationId); return `${host?.host.name ?? t("我的主机")} · ${host?.directory?.conversations.find(item => item.id === pane.conversationId)?.title ?? t("对话暂不可用")}`; }));
  const blockedTip = busyNames ? t("请先完成以下对话的发送、上传或录音：{0}", busyNames) : t("请先完成发送、上传或录音，再关闭面板。");
  const add = (pane: AdhdPaneRef, messageId?: string, restoreFocus = false, createdTitle?: string) => {
    const key = adhdPaneKey(pane), exists = current.current.panes.some(item => adhdPaneKey(item) === key);
    setNotice("");
    if (!exists && current.current.panes.length >= ADHD_PANEL_LIMIT) {
      setNotice(createdTitle ? t("已创建「{0}」。面板已满，请移除一个面板后，从左侧选择它。", createdTitle) : t("最多同时打开 {0} 个对话。请先移除一个面板。", ADHD_PANEL_LIMIT)); return false;
    }
    const serial = ++focusSerial.current;
    setReveal({ key, serial });
    if (restoreFocus) setKeyboardTarget({ key, serial });
    if (messageId) setFocusRequests(old => ({ ...old, [key]: { serial, messageId } }));
    if (exists) { setFocused(key); setExpanded(old => old ? key : ""); return true; }
    if (createdTitle) setOpening(old => ({ ...old, [key]: createdTitle }));
    persist(addAdhdPane(current.current, pane)); setFocused(key); if (expanded) setExpanded(key); return true;
  };
  useEffect(() => {
    setOpening(old => {
      const next = Object.fromEntries(Object.entries(old).filter(([key]) => {
        const pane = board.panes.find(item => adhdPaneKey(item) === key);
        return pane && !hosts.find(host => host.host.registrationId === pane.registrationId)?.directory?.conversations.some(item => item.id === pane.conversationId);
      }));
      return Object.keys(old).length === Object.keys(next).length ? old : next;
    });
  }, [board.panes, hosts]);
  const widgetLeaving = useRef(false);
  const guardLatest = useRef<(run: () => void, scope?: string[], resuming?: boolean, busAccepted?: boolean, flushed?: boolean, discardDirty?: boolean) => void>(() => {});
  const guard = (run: () => void, scope?: string[], resuming = false, busAccepted = false, flushed = false, discardDirty = false) => {
    if (widgetLeaving.current) return;
    if (!scope && !busAccepted && (busGuardState.current.busy || busGuardState.current.dirty)) { busGuard(() => guard(run, scope, resuming, true)); return; }
    // Keep the first explicit transition until it runs or the user cancels.
    if (pendingLeave && !resuming) return;
    const keys = scope ?? current.current.panes.map(adhdPaneKey);
    if (keys.some(key => busyRef.current[key])) { setNotice(blockedTip); return; }
    if (keys.some(key => draftSavingRef.current[key])) { setPendingLeave({ run, keys: scope }); return; }
    if (!discardDirty && keys.some(key => unsavedRef.current[key])) { setLeaving({ run: () => guardLatest.current(run, scope, true, true, false, true) }); return; }
    if (!flushed && grid.current) {
      const roots = [...grid.current.children].filter(node => node instanceof HTMLElement && keys.includes(node.dataset.paneKey ?? ""));
      const pending = flushWidgetStateWithin(roots);
      if (pending) {
        widgetLeaving.current = true;
        void pending.then(() => {
          widgetLeaving.current = false;
          // Removed/replaced panes or a destroyed board cannot resume an old action.
          if (live.current && (!scope || scope.every(key => current.current.panes.some(pane => adhdPaneKey(pane) === key)))) guardLatest.current(run, scope, true, busAccepted, true, discardDirty);
        });
        return;
      }
    }
    run();
  };
  guardLatest.current = guard;
  useEffect(() => {
    if (!pendingLeave || (pendingLeave.keys ?? current.current.panes.map(adhdPaneKey)).some(key => draftSaving[key])) return;
    setPendingLeave(undefined); guard(pendingLeave.run, pendingLeave.keys, true);
  }, [pendingLeave, draftSaving, busy, unsaved, board.panes]);
  const focusAfterRemoval = (key: string) => requestAnimationFrame(() => {
    const checkbox = [...document.querySelectorAll<HTMLInputElement>("[data-pane-toggle]")].find(node => node.dataset.paneToggle === key);
    (checkbox ?? grid.current?.querySelector<HTMLElement>(".adhd-card:not([hidden]) .adhd-grip") ?? search.current)?.focus({ preventScroll: true });
  });
  // Folding an unfolded iPhone shut gives the board up for 按对话 and opens the
  // focused panel's conversation. Unmounting interrupts uploads and recording
  // (by design, without a prompt) and flushes drafts; unfolding again before the
  // settle ends keeps the board.
  const folding = phoneBoard && compact;
  const focusedRef = useRef(focused); focusedRef.current = focused;
  const exitRef = useRef(exit); exitRef.current = exit;
  useEffect(() => {
    if (!folding) return;
    const timer = setTimeout(() => {
      const panes = current.current.panes;
      exitRef.current("conversations", panes.find(pane => adhdPaneKey(pane) === focusedRef.current) ?? panes[0]);
    }, ADHD_FOLD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [folding]);
  const leave = (layout?: SidebarLayout) => {
    // Capture the selected conversation before draft/Bus guards defer the exit.
    // Moving focus while a save is pending must not retarget that click.
    const target = board.panes.find(pane => adhdPaneKey(pane) === focused);
    guard(() => exit(layout, target));
  };
  const remove = (key: string) => guard(() => {
    if (busyRef.current[key]) { setNotice(blockedTip); return; }
    const next = { ...current.current, panes: current.current.panes.filter(item => adhdPaneKey(item) !== key) };
    setFocusRequests(old => { const next = { ...old }; delete next[key]; return next; });
    persist(next); focusAfterRemoval(key); if (focused === key) setFocused(next.panes[0] ? adhdPaneKey(next.panes[0]) : ""); if (expanded === key) setExpanded("");
  }, [key]);
  const replace = (pane: AdhdPaneRef, conversationId: string) => {
    const key = adhdPaneKey(pane), target = { ...pane, conversationId }, targetKey = adhdPaneKey(target);
    if (key === targetKey) return;
    guard(() => {
      const exists = current.current.panes.some(item => adhdPaneKey(item) === targetKey);
      const panes = current.current.panes.flatMap(item => adhdPaneKey(item) === key ? exists ? [] : [target] : [item]);
      persist({ ...current.current, panes }); setFocused(targetKey); if (expanded === key) setExpanded(targetKey);
      setFocusRequests(old => { const next = { ...old }; delete next[key]; return next; });
      setReveal({ key: targetKey, serial: ++focusSerial.current });
      setKeyboardTarget({ key: targetKey, serial: focusSerial.current });
    }, [key]);
  };
  const reorder = (key: string, destination: number) => { const next = moveAdhdPane(current.current, key, destination); if (next !== current.current) { prepareReorder(); persist(next); } };
  const prepareReorder = useAdhdPaneDrag(grid, board.panes.map(adhdPaneKey), ready && !compact && !expanded && board.panes.length > 1, reorder);
  const busyChanged = useCallback((key: string, value: boolean, dirty: boolean, pending: boolean) => {
    setDraftSaving(old => old[key] === pending ? old : { ...old, [key]: pending });
    setBusy(old => old[key] === value ? old : { ...old, [key]: value });
    setUnsaved(old => old[key] === dirty ? old : { ...old, [key]: dirty });
  }, []);
  const focusHandled = useCallback((key: string, serial: number) => setFocusRequests(old => {
    if (old[key]?.serial !== serial) return old;
    const next = { ...old }; delete next[key]; return next;
  }), []);
  useEffect(() => {
    if (!ready || !navigation || handledNavigation.current === navigation.serial) return;
    const host = hosts.find(item => item.host.id === navigation.hostId && !item.blocked && item.host.state === "ready");
    if (!host) return;
    handledNavigation.current = navigation.serial;
    if (!add({ hostId: host.host.id, registrationId: host.host.registrationId, conversationId: navigation.conversationId }, navigation.messageId)) navigationRejected?.(navigation.serial);
  }, [navigation, ready, hosts]);
  useEffect(() => {
    if (!ready || !busNavigation || handledBus.current === busNavigation.serial) return;
    const host = hosts.find(item => item.host.id === busNavigation.hostId && item.host.registrationId === busNavigation.registrationId && item.connection && !item.blocked);
    if (!host) return;
    handledBus.current = busNavigation.serial; selectBus(host, busNavigation.workspaceId);
  }, [busNavigation, ready, hosts]);
  const revealBus = (workspace: AgentBusWorkspace) => {
    const host = hosts.find(item => item.host.registrationId === busSelection?.registrationId);
    if (!host || host.blocked) return;
    let next = current.current, skipped = 0, target: string | undefined;
    for (const member of [workspace.coordinator, ...workspace.members]) {
      const pane = { hostId: host.host.id, registrationId: host.host.registrationId, conversationId: member.conversationId };
      const key = adhdPaneKey(pane);
      if (!next.panes.some(item => adhdPaneKey(item) === key)) {
        if (next.panes.length >= ADHD_PANEL_LIMIT) { skipped++; continue; }
        next = addAdhdPane(next, pane);
      }
      target ??= key;
    }
    if (next !== current.current) persist(next);
    // Revealing a whole Bus returns to the overview without moving keyboard
    // focus. Only explicit navigation/initial load calls this, never polling.
    if (target) { setExpanded(""); setFocused(target); setReveal({ key: target, serial: ++focusSerial.current, settleBusLayout: true }); }
    if (skipped) {
      const text = t("有 {0} 个成员窗口尚未打开，面板最多容纳 {1} 个对话。关闭其他窗口后可重新显示。", skipped, ADHD_PANEL_LIMIT);
      busCapacityNotice.current = { registrationId: host.host.registrationId, workspaceId: workspace.id, text }; setNotice(text);
    }
  };
  useEffect(() => {
    if (compact || !expanded) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
      if ([...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="menu"], .history-search-header, .command-menu')].some(node => node.getClientRects().length && !node.closest("[hidden],[inert]"))) return;
      event.preventDefault(); setExpanded("");
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [compact, expanded]);
  const count = board.panes.length, columns = phoneBoard ? adhdColumns(width, count, board.columns, ADHD_PHONE_CARD_MIN, ADHD_PHONE_COLUMNS) : adhdColumns(width, count, board.columns);
  const searchText = query.trim().toLocaleLowerCase();
  const selected = new Set(board.panes.map(adhdPaneKey));
  const focusedPane = board.panes.find(pane => adhdPaneKey(pane) === focused);
  const toolHosts = hosts.filter(host => host.connection && !host.blocked && host.host.state === "ready");
  // Keep an edited Bus mounted when its network grant disappears. Its original
  // registration owns the draft; a replaced registration cannot inherit it.
  const selectedBusHost = hosts.find(host => host.connection && host.host.registrationId === busSelection?.registrationId);
  const retainedBusHost = useRef<AdhdHost | undefined>(undefined);
  if (selectedBusHost) retainedBusHost.current = selectedBusHost;
  const busHost = selectedBusHost ?? (retainedBusHost.current && retainedBusHost.current.host.registrationId === busSelection?.registrationId ? { ...retainedBusHost.current, blocked: true } : undefined);
  const toolHost = toolHosts.find(host => host.host.id === focusedPane?.hostId && host.host.registrationId === focusedPane.registrationId) ?? toolHosts.find(host => host.host.id === activeHostId) ?? toolHosts[0];
  return <><div ref={shellRoot} className={`adhd-shell${browserOpen ? " has-browser-dock" : ""}`} data-side-window={browserLayout} data-adhd-mode="true" data-adhd-device={phoneBoard ? "phone" : undefined} hidden={compact} inert={compact}>

    <Sidebar shown active={!compact}><div className="brand"><BrandName/><span className="adhd-selection-count">{t("已选 {0}", count)}</span></div>
      {sidebarControls}
      <label className="search-box adhd-picker-search"><Search size={16}/><input ref={search} aria-label={t("筛选面板对话")} placeholder={t("搜索对话或 Bot")} value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label={t("清除筛选")} onClick={() => setQuery("")}><X size={14}/></button>}</label>

      <button className="adhd-skip" tabIndex={0} onClick={() => (grid.current?.querySelector<HTMLElement>(".adhd-card:not([hidden]) .composer textarea:not(:disabled)") ?? grid.current?.querySelector<HTMLElement>(".adhd-card:not([hidden]) .adhd-grip") ?? search.current)?.focus()}>{t("跳到对话面板")}</button>
      <SidebarLayoutSwitch value={preferences.sidebarLayout} change={leave} adhd={{ active: true, open: () => {}, disabled: locked || saving || !!pendingLeave, reason: locked ? blockedTip : undefined }}/>
      <div className="adhd-picker-list">{renderConversations({ query: searchText, visible: !compact,
        renderGroups: scopedHosts => <AgentBusList hosts={scopedHosts} visible={!compact} selected={busSelection} open={selectBus} create={() => { const target = scopedHosts.find(host => host.host.id === toolHost?.host.id) ?? scopedHosts.find(host => host.connection && !host.blocked && host.host.state === "ready"); if (target) { if (busSelection?.registrationId === target.host.registrationId && !busSelection.workspaceId) setBusOpen(true); else selectBus(target); } }}/>, focused: board.panes.find(pane => adhdPaneKey(pane) === focused), select: pane => ready && add(pane), selection: (hostId, registrationId) => ({
        selected: new Set(board.panes.filter(pane => pane.hostId === hostId && pane.registrationId === registrationId).map(pane => pane.conversationId)), ready,
        key: conversationId => adhdPaneKey({ hostId, registrationId, conversationId }),
        topics: {
          expanded: conversationId => expandedTopics.has(adhdPaneKey({ hostId, registrationId, conversationId })),
          setExpanded: (conversationId, value) => setExpandedTopics(previous => {
            const next = new Set(previous), key = adhdPaneKey({ hostId, registrationId, conversationId });
            if (value) next.add(key); else next.delete(key);
            return next;
          }),
        },
        disabled: conversationId => { const key = adhdPaneKey({ hostId, registrationId, conversationId }); return !!busy[key] || !!pendingLeave || !selected.has(key) && count >= ADHD_PANEL_LIMIT; },
        reason: conversationId => { const key = adhdPaneKey({ hostId, registrationId, conversationId }); return busy[key] ? blockedTip : !selected.has(key) && count >= ADHD_PANEL_LIMIT ? t("最多同时打开 {0} 个对话。请先移除一个面板。", ADHD_PANEL_LIMIT) : undefined; },
        toggle: conversationId => { const pane = { hostId, registrationId, conversationId }, key = adhdPaneKey(pane); if (selected.has(key)) remove(key); else add(pane); },
      }) })}</div>
      {toolHost && <AdhdWorkspaceTools key={toolHost.host.registrationId} host={toolHost} connection={toolHost.connection!} preferences={preferences} updatePreferences={updatePreferences} actions={{ manageHosts: (beforeLeave, hostKey, options) => guard(() => tools.manageHosts(beforeLeave, hostKey, options)), manageConnections: beforeLeave => guard(() => tools.manageConnections(beforeLeave)), addHost: () => guard(tools.addHost), createBot: hostId => guard(() => tools.createBot(hostId)) }} navigate={(conversationId, title) => add({ hostId: toolHost.host.id, registrationId: toolHost.host.registrationId, conversationId }, undefined, true, title)}/>}
      {!toolHost && <div className="sidebar-footer"><button onClick={() => guard(tools.manageHosts)}>{t("设备与网络")}</button><button onClick={() => guard(tools.addHost)}>{t("连接另一台主机")}</button></div>}
    </Sidebar>
    <main className="adhd-workbench" aria-label={t("ADHD 多对话面板")}>
      <header className="adhd-toolbar"><div className="adhd-mode-title"><PanelsTopLeft size={18}/><h1>ADHD</h1><span>{t("{0} 个对话", count)}</span>{busyPanes[0] && <button className="adhd-busy-link" title={blockedTip} onClick={() => add(busyPanes[0]!, undefined, true)}>{t("查看进行中的操作（{0}）", busyPanes.length)}</button>}</div><span className="screen-reader-only" role="status" aria-live="off">{saving ? t("正在保存布局…") : ""}</span>
        <div className="adhd-toolbar-actions">{agentBus && <button ref={busToggle} className="agent-bus-entry" aria-label={t("打开 Agent Bus")} aria-expanded={busOpen} disabled={!toolHost} onClick={() => { if (busSelection) setBusOpen(!busOpen); else if (toolHost) selectBus(toolHost); }}><Network size={15}/>Agent Bus</button>}{browserSupported && <button ref={browserToggle} className="adhd-browser-entry icon-button" aria-label={t("浏览器")} title={t("浏览器")} aria-expanded={browserOpen} aria-controls={browserOpened ? "adhd-personal-browser" : undefined} onClick={() => { if (browserOpen) closeBrowser(); else { setBusOpen(false); setBrowserOpened(true); setBrowserOpen(true); } }}><Globe size={17}/></button>}<label className="adhd-display-control"><span>{t("每行")}</span><select aria-label={t("ADHD 每行窗口数")} disabled={!ready || !!expanded} value={phoneBoard ? Math.min(board.columns, ADHD_PHONE_COLUMNS) : board.columns} onChange={event => persist({ ...current.current, columns: Number(event.target.value) as AdhdBoardState["columns"] })}>{(phoneBoard ? [0, 2] as const : [0, 2, 3, 4, 5, 6] as const).map(value => <option key={value} value={value}>{value ? t("{0} 列", value) : t("自动")}</option>)}</select></label>
        <label className="adhd-display-control" title={t("仅调整 ADHD 对话窗口，普通聊天字号不变。")}><span>{t("字号")}</span><select aria-label={t("ADHD 窗口字号")} disabled={!ready} value={board.fontSize} onChange={event => persist({ ...current.current, fontSize: Number(event.target.value) })}>{[11,12,13,14,15,16].map(value => <option key={value} value={value}>{value} px</option>)}</select></label>
        {expanded && <button className="adhd-overview" onClick={() => setExpanded("")}><Minimize2 size={15}/>{t("总览")}</button>}<button className="adhd-exit" disabled={locked || saving || !!pendingLeave} title={locked ? blockedTip : undefined} onClick={() => leave()}><ArrowLeft size={15}/>{t("返回聊天")}</button></div>
      </header>
      {pendingLeave && <div className="adhd-notice" role="status"><span>{t("正在保存草稿…")}</span><button onClick={() => setPendingLeave(undefined)}>{t("取消")}</button></div>}
      {notice && <div className="adhd-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice("")}>{t("关闭提示")}</button></div>}
      {error && <div className="adhd-notice" role="alert"><span>{error}</span><button onClick={() => ready ? persist(current.current) : void load()}>{t("重试")}</button></div>}
      <div ref={grid} className={`adhd-grid ${expanded ? "has-expanded" : ""} ${!count ? "is-empty" : ""}`} style={{ "--font-size": `${board.fontSize}px`, "--adhd-columns": columns, "--adhd-rows": Math.min(2, Math.ceil(count / columns)) || 1 } as React.CSSProperties}>
        {!ready ? <p className="adhd-loading" role="status">{t("正在读取面板…")}</p> : !count ? <div className="adhd-empty"><div className="adhd-empty-sketch" aria-hidden="true">{[0,1,2,3,4,5].map(i => <div key={i}><span/><i/><i/><b/></div>)}</div><span className="adhd-empty-eyebrow">{t("多线工作，从容展开")}</span><h2>{t("让每个对话，都有自己的位置")}</h2><p>{t("勾选左侧对话，放到这里。每个面板都有独立的消息、草稿和输入框。")}</p><button className="adhd-start" onClick={() => search.current?.focus()}><Plus size={16}/>{t("选择第一个对话")}</button><small>{t("移除面板不会删除对话，也不会停止 Bot。")}</small></div> : board.panes.map((pane, index) => {
          const key = adhdPaneKey(pane), host = hosts.find(host => host.host.id === pane.hostId && host.host.registrationId === pane.registrationId);
          const conversation = host?.directory?.conversations.find(c => c.id === pane.conversationId);
          const usable = !!host?.connection && host.host.state === "ready" && !host.blocked && !!conversation;
          return <AdhdCard key={key} busStatus={busWorkspace && busSelection?.registrationId === pane.registrationId ? (() => { const member = [busWorkspace.coordinator, ...busWorkspace.members].find(item => item.conversationId === pane.conversationId); return member ? busMemberStatus(busWorkspace, busRun, member) : undefined; })() : undefined} pane={pane} index={index} count={count} host={host} title={conversation?.title ?? opening[key] ?? t("对话暂不可用")} opening={!!opening[key]} focused={focused === key} restoreFocus={keyboardTarget?.key === key ? keyboardTarget.serial : 0} reveal={reveal?.key === key ? reveal.serial : 0} expanded={expanded === key} hidden={!!expanded && expanded !== key} suspended={compact} busy={!!busy[key] || !!pendingLeave} Workspace={Workspace} preferences={preferences} updatePreferences={updatePreferences} usable={usable}
            focus={() => setFocused(key)} expandForWorkbench={() => { setFocused(key); setExpanded(key); }} expand={() => { setFocused(key); setExpanded(old => old === key ? "" : key); }} remove={() => remove(key)}
            move={destination => reorder(key, destination)} busyChanged={busyChanged}
            replace={id => replace(pane, id)} navigate={(id, messageId, createdTitle) => host && add({ ...pane, conversationId: id }, messageId, !messageId, createdTitle)} focusRequest={focusRequests[key]} focusHandled={focusHandled} microphoneBusy={!!microphoneOwner && microphoneOwner !== key} claimMicrophone={claimMicrophone} releaseMicrophone={releaseMicrophone}
            open={() => { if (locked || saving) { setNotice(blockedTip); return; } guard(() => open(pane.hostId, pane.conversationId)); }}
            />
        })}
      </div>
    </main>
    {browserOpened && <Suspense fallback={null}><AdhdBrowserDock visible={browserOpen && !compact && browserLayout !== "pending"} close={closeBrowser}/></Suspense>}
    <div ref={busDock} className={`agent-bus-dock ${busOpen ? "is-open" : ""}`} aria-hidden={!busOpen} inert={!busOpen}>
      {busHost && busSelection && <AgentBusPanel key={`${busSelection.registrationId}/${busSelection.workspaceId ?? "new"}`} host={busHost} hosts={toolHosts} workspaceId={busSelection.workspaceId} visible={busOpen && !compact} close={closeBus} selectHost={host => selectBus(host)} guard={busGuardChanged} changed={busChanged} reveal={revealBus} focusMember={conversationId => {
        const memberHost = hosts.find(item => item.host.registrationId === busSelection.registrationId);
        if (!memberHost || memberHost.blocked) return;
        add({ hostId: memberHost.host.id, registrationId: memberHost.host.registrationId, conversationId });
      }} saved={workspace => { revealBus(workspace); setBusWorkspace(workspace); setBusSelection(old => old && ({ ...old, workspaceId: workspace.id })); }} removed={() => {
        const capacity = busCapacityNotice.current;
        if (capacity?.registrationId === busSelection.registrationId && capacity.workspaceId === busSelection.workspaceId) {
          setNotice(value => value === capacity.text ? "" : value); busCapacityNotice.current = undefined;
        }
        setBusSelection(undefined); setBusWorkspace(undefined); setBusRun(undefined); setBusOpen(false);
      }}/>}</div>
  </div>{busLeave && <AgentBusDraftDialog kind="leave" close={() => setBusLeave(undefined)} discard={() => { const run = busLeave.run; setBusLeave(undefined); run(); }}/>}{folding && <div className="adhd-folding" role="status"><span className="adhd-folding-mark" aria-hidden="true"><i/><i/></span><span>{t("回到单对话")}</span></div>}{compact && !phoneBoard && <div className="adhd-compact"><PanelsTopLeft size={26}/><h1>{t("拉宽窗口，继续多对话")}</h1><p>{t("面板和正在上传的文件会保留，也可以回到单对话。")}</p><button disabled={locked || saving || !!pendingLeave} title={locked ? blockedTip : undefined} onClick={() => leave()}>{t("返回聊天")}</button></div>}{leaving && <CreationDialog title={t("有草稿尚未保存")} close={() => setLeaving(undefined)} closeLabel={t("关闭")} showHost={false} className="adhd-leave-dialog"><p>{t("关闭后，未保存的文字或附件修改将丢失。已保存的内容和正在运行的任务会保留。")}</p><footer><button className="primary" onClick={() => setLeaving(undefined)}>{t("继续编辑")}</button><button disabled={locked || saving || Object.values(draftSaving).some(Boolean)} className="text-danger" onClick={() => { const run = leaving.run; setLeaving(undefined); run(); }}>{t("放弃未保存的修改")}</button></footer></CreationDialog>}</>;
}

type CardProps = { busStatus?: string; pane: AdhdPaneRef; host?: AdhdHost; title: string; opening: boolean; index: number; count: number; focused: boolean; restoreFocus: number; reveal: number; expanded: boolean; hidden: boolean; suspended: boolean; usable: boolean; busy: boolean; Workspace: Props["Workspace"]; preferences: Preferences; updatePreferences: Props["updatePreferences"]; focus: () => void; expand: () => void; expandForWorkbench: () => void; remove: () => void; move: (index: number) => void; busyChanged: (key: string, value: boolean, dirty: boolean, saving: boolean) => void; replace: (id: string) => void; focusRequest?: { serial: number; messageId?: string }; focusHandled: (key: string, serial: number) => void; microphoneBusy: boolean; claimMicrophone: (key: string) => boolean; releaseMicrophone: (key: string) => void; navigate: (id: string, messageId?: string, createdTitle?: string) => void; open: () => void };
function AdhdCard({ busStatus, pane, host, title, opening, index, count, focused, restoreFocus, reveal, expanded, hidden, suspended, usable, busy, Workspace, preferences, updatePreferences, focus, expand, expandForWorkbench, remove, move, busyChanged, replace, navigate, focusRequest, focusHandled, microphoneBusy, claimMicrophone, releaseMicrophone, open }: CardProps) {
  const key = adhdPaneKey(pane), card = useRef<HTMLElement>(null), restoredFocus = useRef(0);
  useLayoutEffect(() => {
    if (!restoreFocus || restoreFocus === restoredFocus.current || hidden || suspended || !usable) return;
    const frame = requestAnimationFrame(() => {
      restoredFocus.current = restoreFocus;
      (card.current?.querySelector<HTMLElement>(".composer-cancel-upload, .voice-recording button:not(:disabled)") ?? card.current?.querySelector<HTMLElement>(".composer textarea:not(:disabled)") ?? card.current?.querySelector<HTMLElement>(".adhd-grip"))?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [restoreFocus, hidden, suspended, usable]);
  const activity = host?.directory?.activity[pane.conversationId];
  const attention = Object.entries(activity?.attention ?? {}).sort((a,b) => a[1].at - b[1].at)[0];
  const unread = Object.keys(activity?.unread ?? {}).length;
  const claimMic = useCallback(() => claimMicrophone(key), [key, claimMicrophone]);
  const releaseMic = useCallback(() => releaseMicrophone(key), [key, releaseMicrophone]);
  const onBusy = useCallback((value: boolean, dirty: boolean, saving: boolean) => busyChanged(key, value, dirty, saving), [key, busyChanged]);
  const onFocusHandled = useCallback((serial: number) => focusHandled(key, serial), [key, focusHandled]);
  // Reveal only explicit sidebar/notification navigation. Scrolling on pointer
  // focus moves a partially visible button between pointerdown and click.
  useEffect(() => { if (reveal && !hidden) card.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [reveal, hidden]);
  const attentionLabel = attention?.[1].kind === "question" ? t("待回答") : t("待批准");
  const number = String(index + 1).padStart(2, "0");
  const headerLeading = <button className="adhd-grip" draggable={false} aria-label={t("移动面板 {0}：{1}", number, title)} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" title={t("拖动排序；Alt + 左右方向键移动")} onKeyDown={event => { if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); move(index + (event.key === "ArrowLeft" ? -1 : 1)); } }}><span className="adhd-card-number" aria-hidden="true">{number}</span></button>;
  const headerMeta = <>{busStatus && <span className="agent-bus-pane-status" title={t("Agent Bus 本次协作状态；关闭窗口不会停止任务。")}>Bus · {busStatus}</span>}<span className="adhd-card-source"><i className={`status-dot ${host?.connection?.state.status ?? "offline"}`} aria-hidden="true"/><span className="adhd-card-host" title={host?.host.name}>{host?.host.name ?? t("已移除的主机")}</span></span>{attention || unread > 0 ? <span className="adhd-card-signal">{attention ? <button className="adhd-attention" aria-label={attentionLabel} title={attentionLabel} onClick={() => { focus(); navigate(pane.conversationId, attention[0]); }}>{attention[1].kind === "question" ? <MessageCircleQuestion size={14} aria-hidden="true"/> : <ShieldCheck size={14} aria-hidden="true"/>}<span>{attentionLabel}</span></button> : unread > 0 ? <span className="adhd-unread" role="img" aria-label={t("{0} 条新消息", unread)} title={t("{0} 条新消息", unread)}>{unread > 99 ? "99+" : unread}</span> : null}</span> : null}</>;
  const headerTrailing = <span className="adhd-card-tools">
      <button className="adhd-close" aria-label={t("在单对话中打开")} title={t("在单对话中打开")} disabled={!usable || busy} onClick={open}><PanelsTopLeft size={14}/></button><button aria-label={expanded ? t("回到面板总览") : t("放大此面板")} title={expanded ? t("回到面板总览") : t("放大此面板")} onClick={expand}>{expanded ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button><button className="adhd-close" aria-label={t("移除此面板")} title={busy ? t("请先完成发送、上传或录音，再关闭面板。") : t("从面板移除，对话保留")} disabled={busy} onClick={remove}><X size={15}/></button>
    </span>;
  return <section ref={card} hidden={hidden} style={{ "--adhd-title-chars": Math.min(4, [...title].length) } as React.CSSProperties} className={`adhd-card ${focused ? "is-focused" : ""} ${expanded ? "is-expanded" : ""} ${attention ? "needs-attention" : ""}`} aria-label={t("对话面板：{0} · {1}", host?.host.name ?? t("已移除的主机"), title)} data-pane-key={key} data-pane-conversation={pane.conversationId} data-pane-host={pane.hostId}
    onFocusCapture={focus} onPointerDownCapture={focus}>
    {!usable && <header className="adhd-card-bar">{headerLeading}{headerMeta}{headerTrailing}</header>}
    {usable ? <Workspace connection={host!.connection!} forget={async () => {}} pane={{ headerLeading, headerMeta, headerTrailing, conversationId: pane.conversationId, host: host!.host, directory: host!.directory!, visible: !hidden && !suspended, focused, expanded, expandForWorkbench, focusRequest, focusHandled: onFocusHandled, microphoneBusy, claimMicrophone: claimMic, releaseMicrophone: releaseMic, preferences, updatePreferences, navigate, replace, busyChanged: onBusy, localHost: host!.local }}/> : <div className="adhd-unavailable"><PanelsTopLeft size={24}/><h2>{title}</h2><p>{host?.blocked ? t("主机授权已失效，请回到连接设置处理。") : host && (!host.directory || opening) ? t("正在读取此主机的对话…") : t("此对话或连接已移除。可从面板移除后，重新选择。")}</p><button disabled={busy} onClick={remove}>{t("移除此面板")}</button></div>}
  </section>;
}
