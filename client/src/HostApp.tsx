import { BotMessageHostsContext } from "./bot-message-hosts.js";
import { WorkbenchLibraryContext, type WorkbenchFileRequest, type WorkbenchFileTarget, type WorkbenchLibraryHost } from "./workbench-library-context.js";
import { workbenchScope } from "./workbench-model.js";
import { GlobalPinSection } from "./GlobalPinSection.js";
import { buildConversationRows, navigationItems } from "./conversation-inbox.js";
import { conversationUnreadTotal } from './conversation-unread.js';
import { flushWidgetStateWithin } from "./widget-state-lifecycle.js";
import { ConversationBulkProvider, ConversationBulkToolbar } from './ConversationBulkSelection.js';
import { localControllerMessage } from "./local-controller-message.js";
import { coalescedReader } from "./coalesced-reader.js";
import { shareDirectory } from "./share-directory.js";
import type { OpenNetwork, NetworkNavigationGuard } from "./network-navigation.js";
import { FolderListOptions } from "./ConversationFolders.js";
import { AgentBusList, type AgentBusNavigation } from "./AgentBusList.js";
import type { AdhdSidebarOptions } from "./AdhdBoard.js";
import { adhdSupported, type AdhdPaneRef } from "./adhd-board-state.js";
import { timeoutSignal } from "./abort-signals.js";
import { DisconnectedBotsSwitch, HostGroupingSwitch } from "./SidebarLayoutSwitch.js";
import { defaultNetworkName } from "./network-name.js";
import { canOfferDesktopJoin, readDesktopJoinIntent, writeDesktopJoinIntent, type DesktopJoinIntent } from "./desktop-join-intent.js";
import { isDesktop, isElectron } from "./desktop-bridge.js";
import { clearWorkbenchBrowserData } from "./workbench-reset.js";
import { maintainSystemPush } from "./system-push.js";
import { maintainUnifiedPush, unregisterHostNotifications, migrateLegacyUnifiedPush } from "./unifiedpush.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode, type RefObject } from "react";
import { LoaderCircle, Monitor, Plus } from "lucide-react";
import { HostRegistry, type RuntimeHost } from "./host-registry.js";
import { HostConnections, networkHostBlocked, type ConnectedHost } from "./host-connections.js";
import { prepareLocalController, recoverLocalController, watchLocalHostRecovery } from "./local-controller.js";
import { LocalControllerStartupError, type StartupAttempt } from "./startup-diagnostics.js";
import { StartupFailure } from "./StartupFailure.js";
import { cache, ClientCache, defaultPreferences, type Identity, type Preferences, type SidebarLayout, type ConversationActivity } from "./storage.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { Bot, HubConnection } from "./connection.js";
import type { SidebarSlice } from "./ConversationList.js";
import { AvatarProvider } from "./Avatar.js";
import { BotReferences } from "./BotReferences.js";
import { BrandMark } from "./BrandScenes.js";
import { CreationDialog } from "./CreationDialog.js";
import { PageLoadBoundary } from "./PageLoadBoundary.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { applyAppearance, syncThemeColor } from "./appearance.js";
import { setTicketConversationsVisible, useTicketConversationsVisible } from "./dispatcher.js";
import { deleteNativeIdentity, installNativeEvents, nativePlatform, updateBadge } from "./native.js";
import { installPushActions } from "./notifications.js";
import { ListenerScope } from "./listener-scope.js";
import { clearHostPush } from "./notifications.js";
import { clearHostShares } from "./share-inbox.js";
import { setLocale, t, useLocale } from "./i18n.js";
import "./hosts.css";
import type { MobileHost, MobileInboxState, MobileScrollPositions } from "./MobileHome.js";
import { hostNameSchema, hostProfileSchema } from "../../src/client-protocol/host-profile.js";
import { HubHttpError } from "./http-error.js";

const AdhdBoard = lazy(() => import("./AdhdBoard.js").then(module => ({ default: module.AdhdBoard })));
const ConnectionPanel = lazy(() => import("./ConnectionPanel.js").then(module => ({ default: module.ConnectionPanel })));
const NetworkManager = lazy(() => import("./NetworkManager.js").then(module => ({ default: module.NetworkManager })));
const PreferencesPanel = lazy(() => import("./PreferencesPanel.js").then(module => ({ default: module.PreferencesPanel })));
const CombinedSidebar = lazy(() => import("./CombinedSidebar.js").then(module => ({ default: module.CombinedSidebar })));
const ConversationList = lazy(() => import("./ConversationList.js").then(module => ({ default: module.ConversationList })));
const LocalReset = lazy(() => import("./LocalReset.js").then(module => ({ default: module.LocalReset })));

export type HostCommand = { serial: number; kind: "archive-selection" | "connection-settings" | "bot-capabilities" | "bot-operations" | "bot-settings" | "select" | "bot" | "group" | "direct" | "schedule" | "home"; conversationId?: string; conversationIds?: string[]; messageId?: string; botId?: string };
export type HostDirectory = { conversations: Conversation[]; activity: Record<string, ConversationActivity>; pins: string[]; globalPins?: string[]; bots: Bot[] };
export type ManagedWorkspace = {
  host: RuntimeHost; active: boolean; command?: HostCommand;
  /** Verified native host identity; loopback routes alone do not establish locality. */
  localHost?: boolean;
  networkNotice?: ReactNode;
  openAdhd?: () => void;
  openAgentBus?: () => void;
  adhdBlocked?: boolean;
  lifecycleChanged: (registration: string, busy: boolean, dirty: boolean, saving: boolean) => void;
  controls: ReactNode; navigation: (current: HostDirectory & { selected: string }) => ReactNode;
  /** This host's coalesced DirectoryObserver result, once its first read completed. */
  directory?: HostDirectory;
  mobileHosts: (current: HostDirectory) => MobileHost[];
  mobileInbox: MobileInboxState;
  updateMobileInbox: (value: MobileInboxState) => void;
  mobileScrollPositions: RefObject<MobileScrollPositions>;
  mobileSelect: (id: string, value: Omit<HostCommand, "serial">) => void;
  conversationsArchived: (hostId: string, ids: string[]) => void;
  manageHosts: OpenNetwork; manageConnections: OpenNetwork; addHost: () => void;
  /** More than one paired host: host scope is shown in the sidebar and header. */
  multiHost: boolean;
  preferences: Preferences; updatePreferences: (value: Preferences) => void;
  create: (kind: "bot" | "group" | "direct" | "schedule") => void;
  selection: (id: string) => void;
  consumed: (serial: number) => void;
  shareHosts: { hubKey: string; deviceId: string; name: string; open: (conversationId: string) => void }[];
};
export type ConversationPane = {
  conversationId: string; host: RuntimeHost; visible: boolean; focused: boolean;
  expanded: boolean; expandForWorkbench: () => void;
  headerLeading?: ReactNode; headerMeta?: ReactNode; headerTrailing?: ReactNode;
  directory: HostDirectory;
  preferences: Preferences; updatePreferences: (value: Preferences) => void;
  navigate: (conversationId: string, messageId?: string, createdTitle?: string) => void;
  replace: (conversationId: string) => void;
  busyChanged: (busy: boolean, unsaved: boolean, saving: boolean) => void; localHost?: boolean;
  focusRequest?: { serial: number; messageId?: string };
  focusHandled: (serial: number) => void;
  microphoneBusy: boolean; claimMicrophone: () => boolean; releaseMicrophone: () => void;
};
export type WorkspaceProps = { connection: HubConnection; forget: () => Promise<void>; shell?: ManagedWorkspace; pane?: ConversationPane };
export type PairingProps = {
  connected: (identity: Identity) => void | Promise<void>;
  pendingConnection?: HubConnection;
  localHostReady?: boolean;
  manage?: () => void;
  save?: (identity: Identity, hostName: string) => Promise<void>;
  beforePair?: (publicKey: string) => Promise<void>;
  discard?: (identity: Identity) => Promise<void>;
  cancel?: () => void;
};

/** Directory reads never scan message bodies. Each callback retains its host and
 * registration; changing the visible host has no transport lifecycle effect. */
function DirectoryObserver({ entry, changed }: { entry: ConnectedHost; changed: (id: string, registration: string, value: HostDirectory) => void }) {
  const connection = entry.connection!;
  const requestDirectory = useRef<() => void>(() => {});
  const revision = useSyncExternalStore((f) => connection.subscribe(f), () => connection.state.cacheRevision);
  const bots = connection.state.bots, status = connection.state.status;
  useEffect(() => maintainSystemPush(connection), [connection]);
  useEffect(() => {
    if (status !== "online") return;
    let disposed = false; let stop: (() => void) | undefined;
    void maintainUnifiedPush(connection).then((cleanup) => { if (disposed) cleanup(); else stop = cleanup; }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, [connection, status]);
  useEffect(() => {
    const reader = coalescedReader(
      () => Promise.all([connection.cache.conversations(), connection.cache.activity(), connection.cache.pins(), connection.cache.botNames(), connection.cache.pins("global")]),
      ([conversations, activity, pins, saved, globalPins]) => changed(entry.host.id, entry.host.registrationId, { conversations, activity, pins, globalPins, bots: connection.state.bots.length || connection.state.status === "online" ? connection.state.bots : saved.filter(bot => !bot.deletedAt).map((bot) => ({ engine: "", model: "", effort: "", ...bot, online: 0 })) }),
    );
    requestDirectory.current = reader.request;
    return () => { reader.close(); requestDirectory.current = () => {}; };
  }, [connection, entry.host.id, entry.host.registrationId, changed]);
  useEffect(() => requestDirectory.current(), [connection, revision, bots, status, entry.host.id, entry.host.registrationId, changed]);
  return null;
}

type HostAppProps = { Workspace: ComponentType<WorkspaceProps>; Pairing: ComponentType<PairingProps> };
// Fast Refresh preserves useState but reruns effect cleanup. The inner shell
// owns permanently closable registry/cache handles, so a dev module update must
// remount it. Vite timestamps import.meta.url for both direct and propagated
// dependency updates. Ordinary renders and production always keep a stable key.
const hostLifetimeKey = import.meta.hot ? import.meta.url : "production";
export function HostApp(props: HostAppProps) {
  return <HostAppSession key={hostLifetimeKey} {...props}/>;
}

function HostAppSession({ Workspace, Pairing }: HostAppProps) {
  useLocale();
  const [registry] = useState(() => new HostRegistry());
  const desktopBoard = useSyncExternalStore(notify => {
    const media = matchMedia("(min-width:761px)"); media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, () => adhdSupported(nativePlatform(), innerWidth));
  const [adhd, setAdhd] = useState(false);
  const [busNavigation, setBusNavigation] = useState<AgentBusNavigation>();
  const adhdRef = useRef(adhd); adhdRef.current = adhd;
  const [boardNavigation, setBoardNavigation] = useState<{ hostId: string; conversationId: string; messageId?: string; serial: number }>();
  const [pool] = useState(() => new HostConnections(registry));
  const state = useSyncExternalStore((f) => pool.subscribe(f), () => pool.state);
  const [loading, setLoading] = useState(true), [legacyReset, setLegacyReset] = useState(false), [error, setError] = useState("");
  const [localStartupError, setLocalStartupError] = useState("");
  const nativeBootAttempted = useRef(false);
  const localControllerEpoch = useRef(0);
  const lastLocalNotice = useRef("");
  const showLocalIssue = (issue?: Parameters<typeof localControllerMessage>[0]) => {
    const message = issue ? localControllerMessage(issue) : "";
    if (message !== lastLocalNotice.current) { lastLocalNotice.current = message; setLocalStartupError(message); }
  };
  const [startupAttempts, setStartupAttempts] = useState<StartupAttempt[]>();
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [activeId, setActiveId] = useState(""), [filter, setFilter] = useState("");
  const [historyHostId, setHistoryHostId] = useState("");
  const [mobileInbox, setMobileInbox] = useState<MobileInboxState>({ query: "", filter: "all" });
  const mobileScrollPositions = useRef<MobileScrollPositions>({ messages: 0, bots: 0, me: 0 });
  const [localHostKey, setLocalHostKey] = useState("");
  pool.localHostKey = localHostKey;
  const [connections, setConnections] = useState(false);
  const [workbenchFileRequest, setWorkbenchFileRequest] = useState<WorkbenchFileRequest>();
  const [boardConnectionSettings, setBoardConnectionSettings] = useState("");
  const connectionNavigationGuard = useRef<NetworkNavigationGuard | undefined>(undefined);
  const openConnections: OpenNetwork = beforeLeave => { connectionNavigationGuard.current = beforeLeave; setConnections(true); };
  const leaveConnectionPage = (navigate: () => void) => {
    const guard = connectionNavigationGuard.current; connectionNavigationGuard.current = undefined; setConnections(false);
    if (guard) guard(navigate); else navigate();
  };
  const [joinIntent, setJoinIntent] = useState<DesktopJoinIntent | undefined>(readDesktopJoinIntent);
  const rememberJoin = (intent?: DesktopJoinIntent) => { writeDesktopJoinIntent(intent); setJoinIntent(intent); };
  const [initialJoin, setInitialJoin] = useState<{hostId:string;networkHostId:string}>();
  const [pairingEpoch, setPairingEpoch] = useState(0);
  const [pairing, setPairing] = useState(false), [managing, setManaging] = useState(false);
  const networkNavigationGuard = useRef<NetworkNavigationGuard | undefined>(undefined);
  const [networkInitialHostKey, setNetworkInitialHostKey] = useState<string>();
  const [networkInitialHostDetails, setNetworkInitialHostDetails] = useState(false);
  const [networkDeviceHostKey, setNetworkDeviceHostKey] = useState<string>();
  const [networkDeviceMode, setNetworkDeviceMode] = useState<"invite" | "approve" | "manage">("invite");
  const openNetwork: OpenNetwork = (beforeLeave, hostKey, options) => { setNetworkInitialHostDetails(!!options?.details); networkNavigationGuard.current = beforeLeave; setNetworkInitialHostKey(hostKey ?? state.hosts.find(entry => entry.host.id === activeId)?.host.publicKey); setManaging(true); };
  const leaveNetworkPage = (navigate: () => void) => {
    const guard = networkNavigationGuard.current; networkNavigationGuard.current = undefined;
    setManaging(false); setInitialJoin(undefined); setNetworkInitialHostKey(undefined); setNetworkInitialHostDetails(false);
    if (guard) guard(navigate); else navigate();
  };
  const pendingEntry = state.hosts.find((entry) => entry.host.id === activeId && entry.connection?.identity.pendingPairing) ?? state.hosts.find((entry) => entry.connection?.identity.pendingPairing);
  const pendingConnection = pendingEntry?.connection;
  const pairingVisible = pairing || !!pendingConnection && activeId === pendingEntry?.host.id;
  const pairingRef = useRef(pairingVisible); pairingRef.current = pairingVisible;
  const [chooseCreation, setChooseCreation] = useState<"bot" | "group" | "direct" | "schedule">();
  const [commands, setCommands] = useState<Record<string, HostCommand>>({}), [selected, setSelected] = useState<Record<string, string>>({});
  const [directories, setDirectories] = useState<Record<string, HostDirectory & { registration: string }>>({});
  const directoriesRef = useRef(directories); directoriesRef.current = directories;
  const pairingRegistration = state.hosts.find((entry) => entry.connection?.identity.pendingPairing)?.host.registrationId;
  const previousPairingRegistration = useRef<string | undefined>(undefined);
  const sequence = useRef(0), activeRef = useRef(activeId); activeRef.current = activeId;
  const entriesRef = useRef(state.hosts); entriesRef.current = state.hosts;
  const [visited, setVisited] = useState<string[]>([]);
  const [workspaceLocks, setWorkspaceLocks] = useState<Record<string, { busy: boolean; dirty: boolean; saving: boolean }>>({});
  const lifecycleChanged = useCallback((registration: string, busy: boolean, dirty: boolean, saving: boolean) => setWorkspaceLocks(old => old[registration]?.busy === busy && old[registration]?.dirty === dirty && old[registration]?.saving === saving ? old : { ...old, [registration]: { busy, dirty, saving } }), []);
  const workspaceLocked = state.hosts.some(entry => workspaceLocks[entry.host.registrationId]?.busy);
  const [boardEntryPending, setBoardEntryPending] = useState(false), [boardEntryConfirm, setBoardEntryConfirm] = useState(false);
  const widgetEntry = useRef<object | undefined>(undefined);
  const boardEntryLatest = useRef<(discardDirty?: boolean, flushed?: boolean) => void>(() => {});
  useEffect(() => () => { widgetEntry.current = undefined; }, []);
  const continueBoardEntry = (discardDirty = false, flushed = false) => {
    if (widgetEntry.current) return;
    if (workspaceLocked) { setBusNavigation(undefined); setBoardEntryPending(false); setError(t("请先完成各对话的发送、上传或录音。")); return; }
    if (state.hosts.some(entry => workspaceLocks[entry.host.registrationId]?.saving)) { setBoardEntryPending(true); return; }
    setBoardEntryPending(false);
    if (!discardDirty && state.hosts.some(entry => workspaceLocks[entry.host.registrationId]?.dirty)) { setBoardEntryConfirm(true); return; }
    if (!flushed) {
      const pending = flushWidgetStateWithin([...document.querySelectorAll(".host-workspace")]);
      if (pending) {
        const token = {}, host = activeRef.current;
        widgetEntry.current = token;
        void pending.then(() => {
          if (widgetEntry.current !== token) return;
          widgetEntry.current = undefined;
          if (activeRef.current === host && entriesRef.current.some(entry => entry.host.id === host && entry.connection && !entry.connection.isReadOnly)) boardEntryLatest.current(discardDirty, true);
        });
        return;
      }
    }
    setBoardNavigation(undefined); setAdhd(true);
  };
  boardEntryLatest.current = continueBoardEntry;
  const enterBoard = () => { setBusNavigation(undefined); continueBoardEntry(); };
  const cancelBoardEntry = () => { widgetEntry.current = undefined; setBoardEntryConfirm(false); setBusNavigation(undefined); };
  const openAgentBus = (hostId: string, registrationId: string, workspaceId?: string) => {
    setBusNavigation({ hostId, registrationId, workspaceId, serial: ++sequence.current }); continueBoardEntry();
  };
  useEffect(() => { if (boardEntryPending) continueBoardEntry(); }, [workspaceLocks, boardEntryPending]);
  const initialized = useRef(false);
  const changed = useCallback((id: string, registration: string, value: HostDirectory) => {
    if (entriesRef.current.some((entry) => entry.host.id === id && entry.host.registrationId === registration)) setDirectories(old => {
      const previous = old[id]?.registration === registration ? old[id] : undefined;
      const shared = shareDirectory(previous, value);
      return shared === previous ? old : { ...old, [id]: { ...shared, registration } };
    });
  }, []);
  const selectHost = useCallback((id: string) => { setHistoryHostId(old => old === id ? old : ""); setActiveId(id); void registry.selectHost(id).catch(() => undefined); setVisited((old) => old.includes(id) ? old : [...old, id]); }, [registry]);
  const command = (id: string, value: Omit<HostCommand, "serial">) => { selectHost(id); setCommands((old) => ({ ...old, [id]: { ...value, serial: ++sequence.current } })); };
  const conversationsArchived = (id: string, ids: string[]) => setCommands(old => ({ ...old, [id]: { kind: "archive-selection", conversationIds: ids, serial: ++sequence.current } }));
  const exitBoard = (layout?: SidebarLayout, pane?: AdhdPaneRef) => {
    if (layout) setPreferences(old => ({ ...old, sidebarLayout: layout }));
    // Revalidate after any delayed save: a removed/re-paired host must not
    // inherit a pane's target, even when its conversation IDs happen to match.
    const host = pane && entriesRef.current.find(entry => entry.host.id === pane.hostId && entry.host.registrationId === pane.registrationId);
    const directory = pane && directoriesRef.current[pane.hostId];
    const target = pane && host?.connection && host.host.state === "ready" && !networkHostBlocked(host, localHostKey)
      && directory?.registration === pane.registrationId && directory.conversations.some(chat => chat.id === pane.conversationId) ? pane : undefined;
    setAdhd(false);
    if (target) command(target.hostId, { kind: "select", conversationId: target.conversationId });
    else if (selected[activeId]) command(activeId, { kind: "select", conversationId: selected[activeId] });
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      const prefs = await registry.preferences(); if (!alive) return; setPreferences(prefs);
      // Complete old single-host cleanup before importing its database. It is
      // never reused as the multi-host removal path.
      if (await cache.pendingReset() && !(await registry.list()).length) { setLegacyReset(true); return; }
      try { await registry.importLegacy(t("我的主机")); } catch { if (alive) setError(t("旧版主机记录存在冲突，原数据已保留。其他主机仍可使用。")); }
      await migrateLegacyUnifiedPush(await registry.list()).catch(() => { if (alive) setError(t("旧版推送配置迁移未完成，请在通知设置中检查或更新 Android 客户端。")); });
      await registry.recoverPreparations();
      const records = await registry.list();
      const pending = records.find(record => record.state === "ready" && record.publicKey === readDesktopJoinIntent()?.targetKey);
      const saved = await registry.selectedHost(); if (alive && (pending || saved)) selectHost(pending?.id ?? saved!);
      if (!alive) return;
      const migrationRepair = await registry.migrationRepairHosts();
      if (migrationRepair.length && alive) setError(t("部分桌面配对凭据无法迁移，请在连接设置中重新配对。历史和草稿已保留。"));
      // Repair is host-scoped. Native bootstrap must still identify and prove
      // a healthy local controller before any connection starts. Registry.open
      // fences a damaged local record without blocking independently paired hosts.
      if (isDesktop()) {
        try {
          nativeBootAttempted.current = true;
          const local = await prepareLocalController(registry);
          if (!alive) return;
          pool.localHostKey = local.publicKey ?? "";
          pool.localControllerPending = local.pending;
          setLocalHostKey(pool.localHostKey);
          showLocalIssue(local.issue);
        } catch (error) {
          if (alive) {
            setStartupAttempts(error instanceof LocalControllerStartupError ? error.attempts : undefined);
            showLocalIssue(error instanceof LocalControllerStartupError
              ? (error.attempts.find(a => a.reason?.startsWith("state_"))?.reason?.slice(6) as Parameters<typeof localControllerMessage>[0]) ?? "background"
              : "background");
          }
          return;
        }
      }
      await pool.start(); initialized.current = true;
    })().catch(() => { if (alive) setError(t("无法读取本地数据，请重试。")); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; pool.close(); registry.close(); };
  }, [pool, registry, selectHost]);
  useEffect(() => {
    if (loading || !nativeBootAttempted.current || !isDesktop()) return;
    let alive = true;
    const stop = watchLocalHostRecovery(async () => {
      const expectedKey = pool.localHostKey, epoch = localControllerEpoch.current;
      const current = () => alive && pool.localHostKey === expectedKey && localControllerEpoch.current === epoch;
      try {
        const applied = await recoverLocalController(registry, pool, local => {
          setLocalHostKey(pool.localHostKey);
          showLocalIssue(local.issue);
          setStartupAttempts(undefined);
        }, () => alive && localControllerEpoch.current === epoch);
        if (applied && !initialized.current) { await pool.start(); if (alive) initialized.current = true; }
      } catch (error) {
        if (current()) {
          setStartupAttempts(error instanceof LocalControllerStartupError ? error.attempts : undefined);
          showLocalIssue(error instanceof LocalControllerStartupError ? (error.attempts.find(a => a.reason?.startsWith("state_"))?.reason?.slice(6) as Parameters<typeof localControllerMessage>[0]) ?? "background" : "background");
        }
      }
      return {};
    });
    return () => { alive = false; stop(); };
  }, [loading, pool, registry]);
  useEffect(() => {
    if (loading) return;
    setLocale(preferences.locale); applyAppearance(preferences); setTicketConversationsVisible(preferences.showTicketConversations); document.documentElement.style.setProperty("--font-size", `${preferences.fontSize}px`);
    void registry.savePreferences(preferences).catch(() => setError(t("无法保存外观设置。")));
  }, [preferences, loading, registry]);
  useEffect(() => { const query = matchMedia("(prefers-color-scheme: dark)"); query.addEventListener("change", syncThemeColor); return () => query.removeEventListener("change", syncThemeColor); }, []);
  useEffect(() => {
    if (!isDesktop() && nativePlatform() !== "android") return;
    let disposed = false, stop: (() => void) | undefined;
    void import("./DesktopUpdates.js").then(module => { if (!disposed) stop = module.startDesktopUpdateChecks(); }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (loading) return;
    const ready = state.hosts.filter((entry) => entry.connection && (!networkHostBlocked(entry, localHostKey) || entry.host.id === historyHostId));
    if (!ready.some((entry) => entry.host.id === activeId) && ready[0]) selectHost(ready[0].host.id);
    if (filter && !state.hosts.some((entry) => entry.host.id === filter && !networkHostBlocked(entry, localHostKey))) setFilter("");
  }, [state.hosts, activeId, filter, loading, selectHost, historyHostId, localHostKey]);
  const hiddenPairCompletions = useRef(new Set<string>());
  useEffect(() => {
    // Approval can arrive while the user is in a different workspace. Finish
    // durable pairing without stealing focus; the join-intent banner remains.
    for (const entry of state.hosts) {
      const connection = entry.connection;
      if (!connection?.identity.pendingPairing || connection.state.status !== "online" || pairingVisible && entry === pendingEntry || hiddenPairCompletions.current.has(entry.host.registrationId)) continue;
      hiddenPairCompletions.current.add(entry.host.registrationId);
      void connection.cache.savePendingPairing(connection.identity).then(() => {
        delete connection.identity.pendingPairing; connection.refreshCache();
      }).catch(() => setError(t("配对已批准，但本地进度尚未保存，请重新打开 App 重试。"))).finally(() => hiddenPairCompletions.current.delete(entry.host.registrationId));
    }
  }, [state.hosts, pairingVisible, pendingEntry]);
  useTicketConversationsVisible(); // Re-render badges and lists when the device shows ticket conversations.
  const unreadCount = state.hosts.filter(entry => !networkHostBlocked(entry, localHostKey)).reduce((sum, entry) => {
      const value = directories[entry.host.id];
      return sum + (value?.registration === entry.host.registrationId ? conversationUnreadTotal(value.conversations, value.activity) : 0);
    }, 0);
  const badgeRequest = useRef<{ count: number; pending: boolean; applied: boolean } | undefined>(undefined);
  useEffect(() => {
    document.title = unreadCount ? `(${unreadCount}) TaroBird` : "TaroBird";
  }, [unreadCount]);
  useEffect(() => {
    const previous = badgeRequest.current;
    if (previous?.count === unreadCount && (previous.applied || previous.pending)) return;
    const request = { count: unreadCount, pending: true, applied: false }; badgeRequest.current = request;
    // Deduplicate successful/in-flight calls; a failed native bridge still gets
    // another attempt on the next directory or host update, as before.
    void updateBadge(unreadCount).then(() => { request.applied = true; }).catch(() => undefined).finally(() => { request.pending = false; });
  }, [unreadCount, directories, state.hosts]);
  useEffect(() => {
    if (loading) return;
    const navigate = (event: Event) => {
      const target = (event as CustomEvent<{ conversationId?: string; messageId?: string; hostId?: string }>).detail;
      if (!target?.conversationId) return;
      if (pairingRef.current) return;
      const candidates = entriesRef.current.filter((entry) => entry.host.state === "ready" && !networkHostBlocked(entry, pool.localHostKey) && (!target.hostId || entry.host.id === target.hostId));
      // Legacy links have no trustworthy host identity. Never guess among two
      // Hubs even when one cache currently lacks the requested conversation.
      if (candidates.length !== 1) {
        if (target.hostId && entriesRef.current.some((entry) => entry.host.id === target.hostId && entry.host.state === "preparing")) return;
        setError(t("无法确定这条通知所属的主机，请从会话列表选择。")); event.preventDefault(); return;
      }
      const entry = candidates[0]!;
      if (!entry.connection) {
        if (entry.error) { setError(t("目标主机尚未连接，请在主机管理中重试。")); event.preventDefault(); }
        return;
      }
      if (adhdRef.current) {
        setBoardNavigation({ hostId: entry.host.id, conversationId: target.conversationId, messageId: target.messageId, serial: ++sequence.current });
        event.preventDefault(); return;
      }
      selectHost(entry.host.id); setFilter("");
      setCommands((old) => ({ ...old, [entry.host.id]: { serial: ++sequence.current, kind: "select", conversationId: target.conversationId, messageId: target.messageId } }));
      event.preventDefault();
    };
    window.addEventListener("tarocub-navigate", navigate);
    const scope = new ListenerScope();
    installNativeEvents(() => pool.resume(), scope); installPushActions(scope);
    return () => { scope.close(); window.removeEventListener("tarocub-navigate", navigate); };
  }, [loading, pool, selectHost]);
  useEffect(() => {
    const previous = previousPairingRegistration.current;
    if (previous && !state.hosts.some((entry) => entry.host.registrationId === previous)) { setPairing(false); setManaging(false); setConnections(false); setInitialJoin(undefined); setPairingEpoch((value) => value + 1); }
    previousPairingRegistration.current = pairingRegistration ?? (state.hosts.some((entry) => entry.host.registrationId === previous && entry.host.state === "removing") ? previous : undefined);
  }, [pairingRegistration, state.hosts]);
  const navigationAvailability = state.hosts.map((entry) => `${entry.host.id}:${entry.host.state}:${!!entry.connection}`).join("|");
  useEffect(() => { if (!loading && !pairing) window.dispatchEvent(new Event("tarocub-navigation-ready")); }, [loading, pairing, navigationAvailability]);
  const create = (kind: "bot" | "group" | "direct" | "schedule") => {
    const hosts = state.hosts.filter((entry) => entry.connection && !networkHostBlocked(entry, localHostKey) && (kind === "bot" || !filter || entry.host.id === filter));
    if (hosts.length === 1 && hosts[0]!.connection?.state.status === "online" && (!(kind === "bot" || kind === "schedule") || hosts[0]!.connection?.state.user?.role === "owner")) command(hosts[0]!.host.id, { kind }); else setChooseCreation(kind);
  };
  const allHosts = state.hosts.map((entry) => ({ ...entry, host: { ...entry.host, name: state.hosts.filter((other) => other.host.name === entry.host.name).length > 1 ? `${entry.host.name} · ${entry.host.id.slice(4, 12)}` : entry.host.name } }));
  const hosts = allHosts.filter(entry => !networkHostBlocked(entry, localHostKey));
  const viewingHistory = (entry: ConnectedHost) => historyHostId === entry.host.id && networkHostBlocked(entry, localHostKey);
  // One host: no scope chrome at all (the workspace menu names it and manages
  // hosts). Several: one filter row; host sections are an optional presentation.
  const multiHost = hosts.length > 1;
  const libraryHosts = hosts.flatMap(entry => entry.host.state === "ready" && entry.connection && !entry.connection.isReadOnly
    ? [{ id: entry.host.id, name: entry.host.name, connection: entry.connection }] : []);
  const openLibraryFile = async (target: WorkbenchLibraryHost, file: WorkbenchFileTarget) => {
    const valid = () => entriesRef.current.some(entry => entry.host.id === target.id && entry.host.state === "ready"
      && entry.connection === target.connection && !networkHostBlocked(entry, localHostKey))
      && !target.connection.isClosed && !target.connection.isReadOnly && !!target.connection.state.user
      && file.scope === workbenchScope(target.connection.identity.hubPublicKey!, target.connection.state.user.id, file.conversationId);
    if (!valid()) throw new Error("workbench_scope_unavailable");
    const conversation = await target.connection.cache.conversation(file.conversationId);
    if (!valid()) throw new Error("workbench_scope_unavailable");
    if (!conversation || conversation.archived) throw new Error("workbench_library_conversation_unavailable");
    const serial = ++sequence.current;
    setWorkbenchFileRequest({ serial, host: target, file });
    if (adhd) setBoardNavigation({ hostId: target.id, conversationId: file.conversationId, serial });
    else command(target.id, { kind: "select", conversationId: file.conversationId });
  };
  const controls = multiHost ? <div className="host-controls"><label><Monitor size={15}/><select aria-label={t("筛选运行主机")} value={filter} onChange={(event) => { const id = event.target.value; setFilter(id); if (id) selectHost(id); }}><option value="">{t("全部主机")}</option>{hosts.map((entry) => <option key={entry.host.id} value={entry.host.id}>{entry.host.name}</option>)}</select></label></div> : null;
  const navigation = (currentId: string, current: HostDirectory & { selected: string }, board?: AdhdSidebarOptions) => {
    const layout = board ? "conversations" : preferences.sidebarLayout;
    const entries = (board ? hosts : historyHostId === currentId ? allHosts.filter(entry => entry.host.id === currentId || !networkHostBlocked(entry, localHostKey)) : hosts).filter(entry => !filter || entry.host.id === filter);
    const dataFor = (id: string) => {
      const data = board ? directories[id]?.registration === entries.find(entry => entry.host.id === id)?.host.registrationId ? directories[id] : undefined : id === currentId ? current : directories[id];
      if (!data || !board?.query) return data;
      const host = entries.find(entry => entry.host.id === id);
      const matches = new Set(data.conversations.filter(c => [c.title, host?.host.name, ...c.botIds.map(id => data.bots.find(bot => bot.id === id)?.name ?? id)].join(" ").toLocaleLowerCase().includes(board.query)).map(c => c.id));
      const parents = new Set(data.conversations.filter(c => matches.has(c.id)).map(c => c.parentId));
      return { ...data, conversations: data.conversations.filter(c => matches.has(c.id) || !!c.parentId && matches.has(c.parentId) || parents.has(c.id)) };
    };
    const toolbarHost = entries.find(entry => entry.host.id === activeId && entry.connection && dataFor(entry.host.id)) ?? entries.find(entry => entry.connection && dataFor(entry.host.id));
    const grouping = <>{multiHost && <HostGroupingSwitch menu checked={preferences.sidebarGroupByHost} change={sidebarGroupByHost => setPreferences({ ...preferences, sidebarGroupByHost })}/>}<DisconnectedBotsSwitch menu checked={preferences.showDisconnectedBots} change={showDisconnectedBots => setPreferences({ ...preferences, showDisconnectedBots })}/></>;
    const leadingSection = desktopBoard ? board ? board.renderGroups(entries) : <AgentBusList hosts={entries.map(host => ({ ...host, blocked: networkHostBlocked(host, localHostKey) }))} visible={!adhd && !pairingVisible && currentId === activeId} open={(host, id) => openAgentBus(host.host.id, host.host.registrationId, id)}/> : undefined;
    const render = (id: string, slice?: SidebarSlice, showHostBadge = false) => {
      const entry = entries.find(entry => entry.host.id === id)!;
      const data = dataFor(id);
      if (!entry.connection || !data) return null;
      return <div data-host-id={entry.host.id}><AvatarProvider connection={entry.connection} conversations={data.conversations} directory={data.bots}><BotReferences bots={data.bots}><Suspense fallback={null}><ConversationList showDisconnectedBots={preferences.showDisconnectedBots || viewingHistory(entry)} layout={layout} slice={slice} selection={board?.selection(entry.host.id, entry.host.registrationId)} filtered={!!board?.query} openBot={(botId, destination) => { if (!board) command(entry.host.id, { kind: destination === "capabilities" ? "bot-capabilities" : "bot-operations", botId }); }} connection={entry.connection} hostName={entry.host.name} showHostBadge={showHostBadge} visible={board ? board.visible : !pairingVisible && currentId === activeId} conversations={data.conversations} bots={data.bots} pins={data.pins} globalPins={data.globalPins} showGlobalPins={false} activity={data.activity} selected={board ? board.focused?.hostId === entry.host.id && board.focused.registrationId === entry.host.registrationId ? board.focused.conversationId : "" : entry.host.id === activeId ? currentId === entry.host.id ? current.selected : selected[entry.host.id] ?? "" : ""} select={(id) => { if (board) { if (id && entry.host.state === "ready") board.select({ hostId: entry.host.id, registrationId: entry.host.registrationId, conversationId: id }); } else command(entry.host.id, { kind: "select", conversationId: id }); }} newChat={(botId) => { if (!board) command(entry.host.id, { kind: "direct", botId }); }}/></Suspense></BotReferences></AvatarProvider></div>;
    };
    const bulkHosts = entries.flatMap(entry => {
      const data = entry.host.id === currentId && !board ? current : directories[entry.host.id];
      return entry.connection && data ? [{ id: entry.host.id, name: entry.host.name, connection: entry.connection, conversations: data.conversations }] : [];
    });
    const bulkScope = (children: ReactNode) => <ConversationBulkProvider hosts={bulkHosts} showGroupHint={layout !== "conversations"} visible={board ? board.visible : !pairingVisible && currentId === activeId && !adhd} scopeKey={`${layout}:${filter}:${!!board}`} archived={(host, ids) => { if (!board) conversationsArchived(host.id, ids); }}><div className="host-directory"><ConversationBulkToolbar/><FolderListOptions hosts={bulkHosts} defaultConnection={toolbarHost?.connection} visible={board ? board.visible : !pairingVisible && currentId === activeId && !adhd} scope={`${layout}:${filter}:${!!board}:${preferences.sidebarGroupByHost}`} options={grouping}>{children}</FolderListOptions></div></ConversationBulkProvider>;
    if (board?.query && !entries.some(entry => dataFor(entry.host.id)?.conversations.some(c => !c.archived))) return bulkScope(<><p className="empty-sidebar">{t("没有找到对话，换个关键词试试。")}</p></>);
    const unavailable = (entry: ConnectedHost) => <button className="host-unavailable" onClick={() => setManaging(true)}>{entry.host.name} · {entry.host.state === "removing" ? t("等待完成移除") : entry.error ? t("无法打开主机，请重试") : t("正在连接主机…")}</button>;
    if (!preferences.sidebarGroupByHost && entries.length > 1) {
      const ready = entries.flatMap(entry => {
        const data = dataFor(entry.host.id);
        return entry.connection && data ? [{ id: entry.host.id, name: entry.host.name, connection: entry.connection, ...data, viewingHistory: viewingHistory(entry) }] : [];
      });
      return bulkScope(<div className="host-directory-content"><Suspense fallback={null}><CombinedSidebar showDisconnectedBots={preferences.showDisconnectedBots} leadingSection={leadingSection} hosts={ready} layout={layout} retained={board ? id => board.selection(id, entries.find(entry => entry.host.id === id)!.host.registrationId).selected : undefined} render={render}/></Suspense>{entries.filter(entry => !entry.connection || !dataFor(entry.host.id)).map(entry => <div key={entry.host.id}>{unavailable(entry)}</div>)}</div>);
    }
    const globalRows = buildConversationRows(entries.flatMap(entry => {
      const data = dataFor(entry.host.id); if (!entry.connection || !data) return [];
      const host = { id: entry.host.id, name: entry.host.name, connection: entry.connection, ...data, viewingHistory: viewingHistory(entry) };
      return [{ ...host, ...navigationItems(host, preferences.showDisconnectedBots, board?.selection(entry.host.id, entry.host.registrationId).selected) }];
    })).filter(row => row.globallyPinned);
    return bulkScope(<div className="host-directory-content">{globalRows.length > 0 && <GlobalPinSection>{globalRows.map(row => <div key={row.key}>{render(row.hostId, { kind: "conversation", id: row.conversation.id, ...(layout === "conversations" ? { inbox: row } : {}) }, entries.length > 1)}</div>)}</GlobalPinSection>}<div className="sidebar-directory-groups">{leadingSection}</div>{entries.map(entry => <section key={entry.host.id} data-host-id={entry.host.id} className="host-directory-section" aria-label={t("主机：{0}", entry.host.name)}>{entries.length > 1 && <div className="host-heading-row"><button className="host-heading" aria-label={t("{0}，{1}", entry.host.name, entry.connection?.state.status === "online" ? t("已连接") : t("离线"))} onClick={() => selectHost(entry.host.id)}><Monitor size={13}/><strong>{entry.host.name}</strong><i className={`status-dot ${entry.connection?.state.status === "online" ? "online" : ""}`}/></button></div>}{entry.connection && dataFor(entry.host.id) ? render(entry.host.id) : unavailable(entry)}</section>)}</div>);
  };
  const savePairing = async (identity: Identity, name: string) => {
    localControllerEpoch.current++;
    setPairing(true);
    if (isDesktop() && !identity.pendingPairing && identity.deployment === "computer") {
      pool.localHostKey = identity.hubPublicKey ?? ""; pool.localControllerPending = false;
      setLocalHostKey(pool.localHostKey); showLocalIssue();
      if (pool.localHostKey) await registry.rememberNativeLocalHost(pool.localHostKey);
    }
    await navigator.locks.request("tarocub-first-pairing", async () => {
      const legacy = new ClientCache();
      try {
        if (!(await registry.list()).length && !await legacy.identity()) { await legacy.initializeIdentity(identity); await registry.importLegacy(name); }
        else await registry.add(identity, name);
      } finally { legacy.close(); }
    });
    if (isDesktop() && identity.pendingPairing && pool.localHostKey && identity.hubPublicKey !== pool.localHostKey) {
      const local = state.hosts.find(entry => entry.host.publicKey === pool.localHostKey);
      if (canOfferDesktopJoin(local?.connection?.state.network, pool.localHostKey, identity.hubPublicKey!) !== false) rememberJoin({ sourceKey: pool.localHostKey, targetKey: identity.hubPublicKey! });
      const target = (await registry.list()).find(item => item.publicKey === identity.hubPublicKey); if (target) selectHost(target.id);
    }
  };
  const discardPairing = async (identity: Identity) => { if (identity.keyRef && (await cache.identity())?.deviceId !== identity.deviceId && !(await registry.list()).some((host) => host.deviceId === identity.deviceId && host.publicKey === identity.hubPublicKey)) await deleteNativeIdentity(identity.keyRef); };
  const onConnected = async (identity: Identity) => {
    const hosts = await registry.list();
    const host = hosts.find((item) => item.deviceId === identity.deviceId && item.publicKey === identity.hubPublicKey);
    if (!host) throw new Error(t("主机连接尚未就绪。其他主机的配对和数据会保留。"));
    const connection = pool.connection(host.id);
    if (identity.pendingPairing) {
      if (!connection || connection.state.status !== "online") return;
      await connection.cache.savePendingPairing(identity);
      delete identity.pendingPairing; delete connection.identity.pendingPairing;
      connection.refreshCache();
    }
    selectHost(host.id); connection?.resume(); setPairing(false);
    // Pairing proves direct ownership first. Network membership is a separate,
    // visible confirmation; never silently merge two existing networks.
    const local = hosts.find(item => item.publicKey === localHostKey);
    if (local && local.id !== host.id) {
      const offer = canOfferDesktopJoin(pool.connection(local.id)?.state.network, local.publicKey, host.publicKey);
      if (offer !== false) {
        rememberJoin({ sourceKey: local.publicKey, targetKey: host.publicKey });
        if (offer) { setInitialJoin({ hostId: local.id, networkHostId: host.id }); setManaging(true); }
      } else if (joinIntent?.sourceKey === local.publicKey && joinIntent.targetKey === host.publicKey) rememberJoin(undefined);
    }
    else if (isDesktop() && identity.hubPublicKey === pool.localHostKey) {
      const existing = hosts.find(item => item.id !== host.id && item.state === "ready" && !item.networkBlocked);
      if (existing) { rememberJoin({ sourceKey: host.publicKey, targetKey: existing.publicKey }); setInitialJoin({ hostId: host.id, networkHostId: existing.id }); setManaging(true); return; }
      void (async () => {
        await pool.refresh();
        const c = pool.connection(host.id); if (!c) return;
        if (c.state.status !== "online") await new Promise<void>(resolve => { const timer = setTimeout(() => { stop(); resolve(); }, 10000); const stop = c.subscribe(() => { if (c.state.status === "online" || c.isClosed) { clearTimeout(timer); stop(); resolve(); } }); });
        const view = await c.refreshNetwork();
        if (view?.sync === "standalone" && !view.membership) await c.networkCommand({ operation: "create", name: defaultNetworkName(host.name) });
        await pool.refreshNetwork();
      })().catch(() => setError(t("本机已准备好，网络尚未创建。请在「设备与网络」中重试。")));
    }
  };
  const beforePair = async (publicKey: string) => { const existing = (await registry.list()).find(host => host.publicKey === publicKey); if (existing) throw new Error(existing.networkBlocked ? t("请先在「此设备的连接」移除此旧连接，再重新配对。历史和草稿会在移除前提示。") : t("此主机已经添加。请在「设置 → 网络与连接 → 此设备的连接」中选择对应主机，打开连接设置并更新线路。")); };
  const joinSource = state.hosts.find(entry => entry.host.publicKey === joinIntent?.sourceKey && entry.host.publicKey === localHostKey);
  const joinTarget = state.hosts.find(entry => entry.host.publicKey === joinIntent?.targetKey && !entry.host.networkBlocked);
  const destination = joinTarget?.connection?.state.network?.membership?.manifest;
  const sourceMembership = joinSource?.connection?.state.network?.membership?.manifest;
  const joinedIntent = !!destination && sourceMembership?.id === destination.id && sourceMembership.authorityKey === destination.authorityKey && !!sourceMembership.hosts.some(host => host.publicKey === localHostKey && host.state === "active" && !host.revoked);
  useEffect(() => { if (joinedIntent) rememberJoin(undefined); }, [joinedIntent]);
  const continueJoin = () => { if (!joinSource || !joinTarget) return; setInitialJoin({ hostId: joinSource.host.id, networkHostId: joinTarget.host.id }); setManaging(true); };
  const unfinishedJoin = joinSource && joinTarget && !joinedIntent && canOfferDesktopJoin(joinSource.connection?.state.network, joinSource.host.publicKey, joinTarget.host.publicKey) && !joinTarget.connection?.identity.pendingPairing;
  const networkNotice = unfinishedJoin ? <div className="network-change-notice" role="status"><span>{t("这台电脑尚未加入「{0}」的网络。本机 Bot 尚未向该网络开放；已配对的远程主机在线时仍可使用。", joinTarget!.host.name)}</span><button onClick={continueJoin}>{t("继续加入网络")}</button><button onClick={() => rememberJoin(undefined)}>{t("暂不加入")}</button></div> : state.hosts.some(entry => entry.connection?.state.networkChange) ? <div className="network-change-notice" role="status"><span>{t("主机网络已变更，请确认后同步其他主机。")}</span><button onClick={() => setManaging(true)}>{t("查看变更")}</button></div> : undefined;
  const boardSettingsHost = allHosts.find(entry => entry.host.registrationId === boardConnectionSettings && entry.connection && !networkHostBlocked(entry, localHostKey));
  const networkDeviceHost = state.hosts.find(entry => entry.host.publicKey === networkDeviceHostKey && entry.connection && !entry.host.networkBlocked);
  if (loading) return <div className="loading-screen"><BrandMark/><span><LoaderCircle className="spin" size={16}/>{t("正在打开 TaroBird…")}</span></div>;
  if (legacyReset) return <Suspense fallback={<div className="loading-screen" role="status"><LoaderCircle className="spin"/></div>}><LocalReset complete={() => location.reload()}/></Suspense>;
  if ((error || localStartupError) && !initialized.current) return <StartupFailure message={localStartupError || error} attempts={startupAttempts}/>;
  return <BotMessageHostsContext.Provider value={state.hosts}><WorkbenchLibraryContext.Provider value={{ hosts: libraryHosts, open: openLibraryFile, request: workbenchFileRequest, consumed: serial => setWorkbenchFileRequest(old => old?.serial === serial ? undefined : old) }}>{state.hosts.filter((entry) => entry.connection).map((entry) => <DirectoryObserver key={entry.host.registrationId} entry={entry} changed={changed}/>)}
    {!!localStartupError && <div className="host-error" role="alert">{localStartupError}<button onClick={() => setLocalStartupError("")}>{t("关闭")}</button></div>}
    {!!error && <div className="host-error" role="alert">{error}<button onClick={() => setError("")}>{t("关闭")}</button></div>}
    {adhd && !pairingVisible && <Suspense fallback={<div className="loading-screen">{t("正在读取面板…")}</div>}><AdhdBoard navigationRejected={serial => setWorkbenchFileRequest(old => old?.serial === serial ? undefined : old)} busNavigation={busNavigation} compact={!desktopBoard} activeHostId={activeId} navigation={boardNavigation} registry={registry} preferences={preferences} updatePreferences={setPreferences} Workspace={Workspace} sidebarControls={controls} tools={{ manageHosts: openNetwork, manageConnections: openConnections, addHost: () => { setAdhd(false); setPairing(true); }, createBot: hostId => { setAdhd(false); command(hostId, { kind: "bot" }); } }} renderConversations={options => navigation(activeId, { ...(directories[activeId] ?? { conversations: [], bots: [], pins: [], activity: {} }), selected: selected[activeId] ?? "" }, options)}
      hosts={allHosts.map(entry => ({ ...entry, directory: directories[entry.host.id]?.registration === entry.host.registrationId ? directories[entry.host.id] : undefined, blocked: networkHostBlocked(entry, localHostKey), local: isDesktop() && entry.host.publicKey === localHostKey }))}
      exit={exitBoard} open={(hostId, conversationId) => { setAdhd(false); command(hostId, { kind: "select", conversationId }); }}/></Suspense>}
    {!adhd && allHosts.filter((entry) => entry.connection && visited.includes(entry.host.id)).map((entry) => <section key={entry.host.registrationId} hidden={pairingVisible || activeId !== entry.host.id} style={pairingVisible || activeId !== entry.host.id ? { display: "none" } : undefined} className="host-workspace" data-active-host={entry.host.id}><Workspace connection={entry.connection!} forget={async () => { setManaging(true); }} shell={{ host: entry.host, lifecycleChanged, openAgentBus: desktopBoard && !networkHostBlocked(entry, localHostKey) ? () => openAgentBus(entry.host.id, entry.host.registrationId) : undefined, adhdBlocked: workspaceLocked, openAdhd: desktopBoard && !networkHostBlocked(entry, localHostKey) ? enterBoard : undefined, localHost: isDesktop() && !!localHostKey && entry.host.publicKey === localHostKey, active: !pairingVisible && activeId === entry.host.id, command: commands[entry.host.id], directory: directories[entry.host.id]?.registration === entry.host.registrationId ? directories[entry.host.id] : undefined, networkNotice: networkHostBlocked(entry, localHostKey) ? <div className="network-change-notice" role="status"><span>{t("这是已停用连接的本机历史。历史和草稿保留。")}</span><button onClick={() => setConnections(true)}>{t("此设备的连接")}</button></div> : networkNotice, controls, navigation: (current) => navigation(entry.host.id, current), mobileHosts: (current) => (historyHostId === entry.host.id ? allHosts.filter(other => other.host.id === entry.host.id || !networkHostBlocked(other, localHostKey)) : hosts).flatMap((other) => {
        const data = other.host.id === entry.host.id ? current : directories[other.host.id];
        return other.connection && data ? [{ id: other.host.id, name: other.host.name, connection: other.connection, ...data, viewingHistory: viewingHistory(other) }] : [];
      }), mobileInbox, mobileScrollPositions, updateMobileInbox: setMobileInbox, mobileSelect: command, conversationsArchived, manageHosts: openNetwork, manageConnections: openConnections, addHost: () => setPairing(true), multiHost, preferences, updatePreferences: setPreferences, create, selection: (id) => setSelected((old) => old[entry.host.id] === id ? old : { ...old, [entry.host.id]: id }), consumed: (serial) => setCommands((old) => { if (old[entry.host.id]?.serial !== serial) return old; const next = { ...old }; delete next[entry.host.id]; return next; }), shareHosts: hosts.map((other) => ({ hubKey: other.host.publicKey, deviceId: other.host.deviceId, name: other.host.name, open: (conversationId) => command(other.host.id, { kind: "select", conversationId }) })) }}/></section>)}
    {(pairingVisible || !state.hosts.length) && <Pairing localHostReady={!!localHostKey && state.hosts.some(entry => entry.host.publicKey === localHostKey && !entry.connection?.identity.pendingPairing)} key={pairingEpoch} manage={() => setManaging(true)} pendingConnection={pendingConnection} save={savePairing} beforePair={beforePair} discard={discardPairing} connected={onConnected} cancel={state.hosts.some((entry) => entry.connection && !entry.connection.identity.pendingPairing) ? () => { const ready = state.hosts.find((entry) => entry.connection && !entry.connection.identity.pendingPairing); if (ready) selectHost(ready.host.id); setPairing(false); } : undefined}/>}
    {!pairingVisible && !!state.hosts.length && !hosts.some((entry) => entry.connection) && !historyHostId && <main className="pairing-page"><BrandMark/><p>{t("主机连接尚未就绪。其他主机的配对和数据会保留。")}</p><button onClick={() => { void registry.recoverPreparations().then(() => pool.refresh()); }}>{t("重试")}</button><button onClick={() => setManaging(true)}>{t("设备与网络")}</button><button onClick={() => setPairing(true)}>{t("连接另一台主机")}</button></main>}
    {boardEntryPending && <div className="adhd-entry-notice" role="status"><span>{t("正在保存草稿…")}</span><button onClick={() => setBoardEntryPending(false)}>{t("取消")}</button></div>}
    {boardEntryConfirm && <CreationDialog title={t("有草稿尚未保存")} close={cancelBoardEntry} showHost={false} className="adhd-leave-dialog"><p>{state.hosts.filter(entry => workspaceLocks[entry.host.registrationId]?.dirty).map(entry => entry.host.name).join(" · ")}</p><p>{t("关闭后，未保存的文字或附件修改将丢失。已保存的内容和正在运行的任务会保留。")}</p><footer><button className="primary" onClick={cancelBoardEntry}>{t("继续编辑")}</button><button className="text-danger" disabled={workspaceLocked || state.hosts.some(entry => workspaceLocks[entry.host.registrationId]?.saving)} onClick={() => { setBoardEntryConfirm(false); continueBoardEntry(true); }}>{t("放弃未保存的修改")}</button></footer></CreationDialog>}
    {chooseCreation && <CreationDialog title={t("选择运行主机")} close={() => setChooseCreation(undefined)}><p>{t("Bot、工作区和会话将保存在所选主机上。群组只能加入这台主机的 Bot。")}</p><div className="host-choices">{hosts.map((entry) => <button key={entry.host.id} disabled={!entry.connection || entry.connection.state.status !== "online" || (chooseCreation === "bot" || chooseCreation === "schedule") && entry.connection.state.user?.role !== "owner"} onClick={() => { command(entry.host.id, { kind: chooseCreation }); setChooseCreation(undefined); }}><Monitor size={20}/><span><strong>{entry.host.name}</strong><small>{(chooseCreation === "bot" || chooseCreation === "schedule") && entry.connection?.state.user?.role !== "owner" ? t("需要管理员权限") : entry.connection?.state.status === "online" ? t("已连接") : t("离线")}</small></span></button>)}</div></CreationDialog>}
    {managing && <PageLoadBoundary close={() => { setManaging(false); setInitialJoin(undefined); setNetworkInitialHostKey(undefined); setNetworkInitialHostDetails(false); networkNavigationGuard.current = undefined; }}><Suspense fallback={null}><NetworkManager entries={state.hosts} localHostKey={localHostKey} initialJoin={initialJoin} initialHostKey={networkInitialHostKey} initialHostDetails={networkInitialHostDetails} close={() => { setManaging(false); setInitialJoin(undefined); setNetworkInitialHostKey(undefined); setNetworkInitialHostDetails(false); networkNavigationGuard.current = undefined; }} addHost={() => leaveNetworkPage(() => setPairing(true))} manageConnections={() => openConnections(navigate => leaveNetworkPage(navigate))} confirmDevice={(hostKey, mode = "invite") => { setNetworkDeviceMode(mode); setNetworkDeviceHostKey(hostKey); }} onChanged={() => { void pool.refreshNetwork(); }}/></Suspense></PageLoadBoundary>}
    {networkDeviceHost && <RuntimeHostContext.Provider value={networkDeviceHost.host.name}><Suspense fallback={null}><PreferencesPanel key={`${networkDeviceHost.host.registrationId}:${networkDeviceMode}`} connection={networkDeviceHost.connection!} preferences={preferences} update={setPreferences} initialSection="devices" initialPairingStep={networkDeviceMode === "manage" ? undefined : networkDeviceMode === "approve" ? 1 : 0} singleSection backLabel={t("返回设备与网络")} close={() => setNetworkDeviceHostKey(undefined)} forget={async () => { setNetworkDeviceHostKey(undefined); openConnections(navigate => leaveNetworkPage(navigate)); }} manageNetwork={(beforeLeave, hostKey) => {
      const navigate = () => { setNetworkDeviceHostKey(undefined); setNetworkInitialHostKey(hostKey ?? networkDeviceHost.host.publicKey); };
      if (beforeLeave) beforeLeave(navigate); else navigate();
    }} manageConnections={beforeLeave => openConnections(navigate => { const leave = () => { setNetworkDeviceHostKey(undefined); leaveNetworkPage(navigate); }; if (beforeLeave) beforeLeave(leave); else leave(); })}/></Suspense></RuntimeHostContext.Provider>}
    {boardSettingsHost && <RuntimeHostContext.Provider value={boardSettingsHost.host.name}><Suspense fallback={null}><ConnectionPanel key={boardSettingsHost.host.registrationId} connection={boardSettingsHost.connection!} close={() => setBoardConnectionSettings("")} backLabel={t("返回此设备的连接")}/></Suspense></RuntimeHostContext.Provider>}
    {connections && <HostManager registry={registry} entries={state.hosts} pool={pool} close={() => { setConnections(false); connectionNavigationGuard.current = undefined; }} history={id => leaveConnectionPage(() => { setHistoryHostId(id); selectHost(id); })} settings={id => { const entry = allHosts.find(entry => entry.host.id === id); if (entry) setBoardConnectionSettings(entry.host.registrationId); }} add={() => leaveConnectionPage(() => setPairing(true))}/>}</WorkbenchLibraryContext.Provider></BotMessageHostsContext.Provider>;
}

function HostManager({ registry, entries, pool, close, add, settings, history }: { registry: HostRegistry; entries: ConnectedHost[]; pool: HostConnections; close: () => void; add: () => void; settings: (id:string) => void; history: (id:string) => void }) {
  const [names, setNames] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const [savedName, setSavedName] = useState("");
  const [editingName, setEditingName] = useState<string>(), [discardName, setDiscardName] = useState(false);
  const renameEntry = entries.find(entry => entry.host.registrationId === editingName);
  const clearRename = () => { if (renameEntry) setNames(old => { const next = { ...old }; delete next[renameEntry.host.id]; return next; }); setEditingName(undefined); setDiscardName(false); };
  const closeRename = () => { if (busy || saving.current) return; if (renameEntry && (names[renameEntry.host.id] ?? renameEntry.host.name) !== renameEntry.host.name) setDiscardName(true); else clearRename(); };
  const canRename = (entry: ConnectedHost) => entry.host.state === "ready" && !networkHostBlocked(entry, pool.localHostKey)
    && entry.connection?.state.status === "online" && entry.connection.state.user?.role === "owner";
  async function saveName(entry: ConnectedHost) {
    if (saving.current || busy || !canRename(entry)) return;
    saving.current = true; setBusy(true); setError(""); setSavedName("");
    try {
      const name = hostNameSchema.parse(names[entry.host.id] ?? entry.host.name), c = entry.connection!;
      const profile = hostProfileSchema.parse(await c.http("/api/host-profile", { signal: timeoutSignal(20_000) }));
      if (!canRename(entry)) throw new Error(t("连接恢复后即可操作"));
      const saved = hostProfileSchema.parse(await c.http("/api/host-profile", { method: "PATCH", signal: timeoutSignal(20_000), body: JSON.stringify({ name, revision: profile.revision }) }));
      setSavedName(saved.name); setEditingName(undefined);
      setNames(old => { const next = { ...old }; delete next[entry.host.id]; return next; });
      // The host receipt is success. A cache/directory failure cannot turn it
      // into a failed rename or make the next attempt submit the old revision.
      await registry.cacheHostProfile(entry.host.id, entry.host.registrationId, saved).catch(() => undefined);
      void c.refreshNetwork().catch(() => undefined);
    } catch (e) {
      setError(e instanceof HubHttpError && e.status === 404 ? t("此主机尚不支持共享改名，请先更新主机。名称未改变。")
        : e instanceof HubHttpError && e.status === 409 ? t("主机名称已被其他设备修改，请重新打开名称编辑后保存。")
        : e instanceof Error ? e.message : t("操作失败"));
    } finally { saving.current = false; setBusy(false); }
  }
  const [removal, setRemoval] = useState<{ entry: ConnectedHost; drafts?: number; queued?: number }>();
  const [localOnly, setLocalOnly] = useState(false);
  async function inspect(entry: ConnectedHost) {
    setLocalOnly(false); setError("");
    try { const handle = await registry.open(entry.host.id); try { setRemoval({ entry, drafts: await handle.cache.draftCount(), queued: (await handle.cache.outbox()).length }); } finally { handle.cache.close(); } } catch { setRemoval({ entry }); }
  }
  async function remove(entry: ConnectedHost) {
    setBusy(true); setError("");
    try {
      const current = (await registry.list()).find((host) => host.id === entry.host.id); if (!current) { setRemoval(undefined); return; }
      if (current.state !== "removing") {
        const revoked = entry.connection && await entry.connection.cache.identityRevoked(entry.connection.identity);
        // Remote push removal must be acknowledged before credentials are fenced.
        // An already revoked identity cannot receive server push deliveries.
        const authenticated = entry.connection && (entry.connection.state.user || (await entry.connection.cache.profiles()).user);
        if (!revoked && authenticated && !localOnly) { if (entry.connection?.state.status !== "online") throw new Error(t("请先连接此主机，以注销它的推送。其他主机仍可正常使用。")); await unregisterHostNotifications(entry.connection); }
        await registry.beginRemoval(entry.host.id); setRemoval(undefined);
      }
      await pool.refresh();
      await registry.finishRemoval(entry.host.id, entry.host.registrationId, { shared: clearHostShares, push: clearHostPush, browser: (host, scopes) => clearWorkbenchBrowserData(host.publicKey, scopes), key: deleteNativeIdentity });
      setRemoval(undefined);
    } catch (e) { setError(e instanceof Error ? e.message : t("操作失败")); } finally { setBusy(false); }
  }
  return <CreationDialog mobilePage title={t("此设备的连接")} close={close} closeLabel={t("关闭连接管理")} busy={busy} showHost={false} className="saved-host-manager">
    <p className="muted">{t("这些连接保存在此设备。移除连接不会让主机退出网络，也不会删除主机上的 Bot。")}</p>
    {!entries.length && <p className="settings-note">{t("还没有保存的主机连接。")}</p>}
    {entries.map(entry => <section className="host-manager-row" aria-label={entry.host.name} key={entry.host.registrationId}>
      <div className="saved-host-heading"><Monitor size={20} aria-hidden="true"/><div><strong>{entry.host.name}</strong><small>{t("公钥尾号 {0}", entry.host.publicKey.slice(-8))}</small></div><span className="saved-host-state">{networkHostBlocked(entry, pool.localHostKey) ? t("网络授权已失效") : entry.connection?.state.status === "online" ? t("已连接") : t("离线")}</span></div>
      {networkHostBlocked(entry, pool.localHostKey) && <p className="muted">{t("历史和草稿仍保留。再次连接需先移除此旧连接，再扫描新的配对二维码。")}</p>}
      <div className="quick-actions">
        {networkHostBlocked(entry, pool.localHostKey) && <button disabled={busy || !entry.connection} onClick={() => history(entry.host.id)}>{t("查看历史记录")}</button>}
        <button disabled={busy || !canRename(entry)} onClick={() => { setSavedName(""); setError(""); setEditingName(entry.host.registrationId); }}>{t("修改名称")}</button>
        <button disabled={!entry.connection || busy || networkHostBlocked(entry, pool.localHostKey)} onClick={event => { event.currentTarget.focus({ preventScroll: true }); settings(entry.host.id); }}>{t("设置连接")}</button>
        <button className="text-danger" disabled={busy} onClick={event => { event.currentTarget.focus({ preventScroll: true }); if (entry.host.state === "removing") void remove(entry); else void inspect(entry); }}>{entry.host.state === "removing" ? t("重试清理") : t("从此设备移除")}</button>
      </div>
    </section>)}
    {renameEntry && <CreationDialog mobilePage title={t("修改主机名称")} close={closeRename} closeLabel={t("返回此设备的连接")} busy={busy} showHost={false}>
      <form className="network-form" onSubmit={event => { event.preventDefault(); void saveName(renameEntry); }}><label className="network-field">{t("主机名称")}<input maxLength={100} disabled={busy} value={names[renameEntry.host.id] ?? renameEntry.host.name} onChange={event => setNames(old => ({ ...old, [renameEntry.host.id]: event.target.value }))}/></label><p className="muted">{t("名称会同步到连接这台主机的其他设备。")}</p>{error && <p role="alert" className="error-text">{error}</p>}<footer className="network-actions"><button type="button" disabled={busy} onClick={closeRename}>{t("取消")}</button><button type="submit" className="primary" disabled={busy || !canRename(renameEntry) || !hostNameSchema.safeParse(names[renameEntry.host.id] ?? renameEntry.host.name).success}>{t("保存名称")}</button></footer></form>
    </CreationDialog>}
    {discardName && <CreationDialog title={t("放弃主机名称修改？")} close={() => setDiscardName(false)} showHost={false} closeLabel={t("关闭确认")}><p>{t("主机名称尚未保存。")}</p><div className="quick-actions"><button onClick={() => setDiscardName(false)}>{t("继续编辑")}</button><button onClick={clearRename}>{t("放弃修改")}</button></div></CreationDialog>}
    {savedName && <p role="status">{t("主机名称已保存为「{0}」，其他设备连接后会同步。", savedName)}</p>}{error && !renameEntry && !removal && <p role="alert" className="error-text">{error}</p>}<button disabled={busy} onClick={add}><Plus size={16}/>{t("连接另一台主机")}</button>
    {removal && <CreationDialog title={t("从此设备移除「{0}」？", removal.entry.host.name)} close={() => setRemoval(undefined)} closeLabel={t("关闭确认")} busy={busy} showHost={false}><p>{t("将清除此主机的 {0} 份草稿和 {1} 条待发送内容。其他主机的数据保留。", removal.drafts ?? t("未知"), removal.queued ?? t("未知"))}</p><p className="muted">{removal.entry.connection?.state.status === "online" ? t("主机上的历史记录和设备授权不会删除。将先注销此主机的推送，再清理本地连接。") : t("此主机当前离线，无法确认远端注销。只有明确选择仅移除本机连接后才会继续。")}</p><p className="muted">{t("此主机正在进行的上传会取消，未发送的附件草稿、本机笔记和白板也会移除。笔记和白板仅存于本机，请先导出需要保留的内容。")}</p>{isElectron() && <p className="muted">{t("此设备上属于该主机的工作台网页登录状态和网站缓存也会清除。其他主机的网站数据保留。")}</p>}{removal.entry.connection?.state.status !== "online" && <label className="settings-row"><input type="checkbox" checked={localOnly} onChange={(event) => setLocalOnly(event.target.checked)}/>{t("仅移除本机连接；该主机的推送与授权未撤销，恢复连接后请在主机端撤销此设备。")}</label>}{error && <p role="alert">{error}</p>}<footer className="network-actions"><button type="button" disabled={busy} onClick={() => setRemoval(undefined)}>{t("取消")}</button><button type="button" disabled={busy || removal.entry.connection?.state.status !== "online" && !localOnly} className="text-danger" onClick={() => { void remove(removal.entry); }}>{busy ? t("处理中…") : t("确认移除")}</button></footer></CreationDialog>}
  </CreationDialog>;
}
