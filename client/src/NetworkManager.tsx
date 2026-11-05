import { ZodError } from "zod";
import { defaultNetworkName } from "./network-name.js";
import { platformName } from "./SettingsParts.js";
import { DesktopHostInvite } from "./DesktopHostInvite.js";
import { HostAddressSyncHelp } from "./HostAddressSyncHelp.js";
import { ConnectionPanel } from "./ConnectionPanel.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { mergeNetworkInviteRoute } from "./network-routes.js";
import { canOfferDesktopJoin } from "./desktop-join-intent.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, Check, ChevronRight, Globe, Link, Monitor, MonitorSmartphone, Pencil, Plus, QrCode, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { NetworkHost, NetworkManifest, NetworkView } from "../../src/client-protocol/private-network.js";
import { sharedRoutesSchema } from "../../src/client-protocol/private-network.js";
import { hostNameSchema, hostProfileSchema, type HostProfileState } from "../../src/client-protocol/host-profile.js";
import { connectedHostName, type ConnectedHost } from "./host-connections.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { joinNetworkHosts, reviewedNetworkHash, type NetworkJoinAttempt } from "./network-join.js";
import { clearNetworkJoinAttempt, loadNetworkJoinAttempt, saveNetworkJoinAttempt } from "./network-join-storage.js";
import { t, useLocale } from "./i18n.js";
import "./network-manager.css";

type Connection = HubConnection & {
  state: HubConnection["state"] & { network?: NetworkView; networkAvailable?: boolean; hostProfile?: HostProfileState; networkChange?: NetworkView };
  refreshNetwork(): Promise<NetworkView | undefined>;
  confirmNetworkChange(review: NetworkView): Promise<void>;
};
type Tone = "ok" | "warn" | "bad" | "muted";
const connectionOf = (entry: ConnectedHost | undefined) => entry?.connection as Connection | undefined;
const canManage = (entry: ConnectedHost | undefined) => { const c = connectionOf(entry); return !!c && !entry?.host.networkBlocked && c.state.status === "online" && c.state.user?.role === "owner" && c.state.networkAvailable; };
// Used by both the overview and admission review. Permission, connectivity and
// protocol support must not be described as interchangeable failures.
const managementNotice = (entry: ConnectedHost | undefined, name: string): string => {
  const connection = connectionOf(entry);
  if (entry?.host.networkBlocked) return t("此设备对「{0}」的授权已失效，请在连接管理中重新配对。", name);
  if (!connection) return t("尚未连接「{0}」，暂时无法管理网络。", name);
  if (connection.state.status === "connecting") return t("正在连接「{0}」，暂时无法管理网络。", name);
  if (connection.state.status !== "online") return t("「{0}」暂时离线，新增主机或设备需等待它恢复。已配对设备仍可使用其他在线主机。", name);
  if (!connection.state.user) return t("正在读取网络管理权限…");
  if (connection.state.user.role !== "owner") return t("此设备没有网络管理权限，请使用已授权的管理设备添加成员。");
  if (connection.state.networkAvailable === false) return t("「{0}」尚不支持网络管理，请更新此主机。", name);
  return !connection.state.networkAvailable ? t("正在读取网络管理能力…") : "";
};
// The same facts as managementNotice, condensed into the overview's status label.
const networkState = (entry: ConnectedHost | undefined): { label: string; tone: Tone } => {
  const connection = connectionOf(entry);
  if (entry?.host.networkBlocked) return { label: t("授权已失效"), tone: "bad" };
  if (!connection) return { label: t("未连接协调主机"), tone: "muted" };
  if (connection.state.status === "connecting") return { label: t("连接中…"), tone: "muted" };
  if (connection.state.status !== "online") return { label: t("协调主机离线"), tone: "warn" };
  if (!connection.state.user || connection.state.networkAvailable === undefined) return { label: t("正在读取…"), tone: "muted" };
  if (connection.state.user.role !== "owner") return { label: t("仅可查看"), tone: "muted" };
  return connection.state.networkAvailable ? { label: t("正常"), tone: "ok" } : { label: t("需要更新"), tone: "warn" };
};
const fingerprint = (key: string) => t("公钥尾号 {0}", key.slice(-8));
const currentNetwork = (entry: ConnectedHost) => { if (entry.host.networkBlocked) return undefined; const view = connectionOf(entry)?.state.network; return view && view.sync !== "removed" ? view.membership?.manifest : undefined; };
const entryName = (entry: ConnectedHost) => connectedHostName(entry);
const newJoinAttempt = (manifest: NetworkManifest, sourceKey: string): NetworkJoinAttempt => ({ networkId: manifest.id, authorityKey: manifest.authorityKey, sourceKey, seenManifestHash: reviewedNetworkHash(manifest), reviewedManifest: structuredClone(manifest) });
const eligibleRoutes = (entry: ConnectedHost) => {
  const routes = connectionOf(entry)?.identity.routes.filter(route => sharedRoutesSchema.safeParse([route]).success) ?? [];
  // These are candidates, not a wire payload. The existing merge below projects
  // them into one direct route plus relays before the owner confirms sharing.
  return routes;
};
const errorText = (error: unknown) => {
  if (error instanceof ZodError) return t("输入内容不符合要求，请检查后重试。");
  if (error instanceof Error && ["network_peer_unavailable", "network_peer_timeout", "network_peer_cancelled", "network_peer_rejected"].includes(error.message)) return t("暂时无法联系协调主机，操作尚未完成。请检查连接后重试。");
  if (error instanceof Error && error.message === "host_profile_changed") return t("主机名称已被其他设备修改，请重新打开名称编辑后保存。");
  if (error instanceof Error && error.message === "network_host_unavailable") return t("主机状态已变化，请刷新后重试。");
  if (error instanceof Error && error.message === "network_join_recovery_unavailable") return t("无法保存加入进度，请检查设备存储空间后重试。");
  if (error instanceof Error && ["network_change_review_stale", "network_change_review_changed", "network_identity_mismatch"].includes(error.message)) return t("网络信息又有变化，请返回重新查看后确认。");
  if (error instanceof Error && error.message === "network_host_state_changed") return t("主机加入状态已变化，请查看最新状态后再确认。");
  if (error instanceof Error && error.message === "network_devices_not_ready") return t("请先让手机打开 App，连接网络中的其他主机，再退出此主机。");
  if (error instanceof Error && error.message === "network_upgrade_required") return t("请先将网络内的所有主机升级到支持独立设备成员的版本，再重试。");
  if (error instanceof Error && error.message === "network_local_desktop_required") return t("这是网络中的最后一台主机，请在该主机的桌面版中解散网络，或在该主机终端运行 tarobot network leave --yes。");
  if (error instanceof Error && error.message === "network_authority_has_peers") return t("协调主机不能直接退出仍有其他成员的网络。");
  if (error instanceof Error && error.message === "network_join_in_progress") return t("主机正在完成加入，请稍后刷新状态再操作。");
  if (error instanceof Error && error.message === "network_request_expired") return t("本次加入已超时，请重新确认后再试。");
  if (error instanceof Error && ["network_host_removed", "network_retired"].includes(error.message)) return t("此网络已撤销该主机身份的授权，再次加入需要新的主机身份。");
  if (error instanceof Error && error.message === "network_review_changed") return t("网络成员已变化，请查看最新成员并重新确认加入。");
  if (error instanceof Error && error.message === "network_local_owner_required") return t("此设备是通过网络获得这台主机的访问权，不能代表它加入或退出网络。请在该主机本机，或最初配对它的设备上操作。");
  if (error instanceof Error && error.message === "network_pending_requires_local_cancel") return t("待加入的主机需要在它自己那里取消加入。");
  if (error instanceof Error && error.message === "network_cannot_remove_authority") return t("协调主机不能被移出网络。");
  return error instanceof Error && !/^[a-z_]+$/.test(error.message) ? error.message : t("操作未完成，请重试。");
};

export function NetworkManager({ entries, close, addHost, manageConnections, confirmDevice, joined, onChanged, initialJoin, initialHostKey, initialHostDetails = false, localHostKey = "" }: {
  entries: ConnectedHost[];
  close: () => void;
  /** This device pairs with another host (the existing pairing screen). */
  addHost: () => void;
  /** All host connections saved on this device, including their removal. */
  manageConnections: () => void;
  /** Optional: open device approval on this host: the selected network's
   * coordinator, otherwise the opening host or the only manageable host. */
  confirmDevice?: (hostKey: string, mode?: "invite" | "approve" | "manage") => void;
  joined?: () => void | Promise<void>;
  onChanged?: () => void;
  initialJoin?: { hostId: string; networkHostId: string };
  /** Optional: on first open, select the network that contains this host. */
  initialHostKey?: string;
  /** With initialHostKey: also open that host's details once. */
  initialHostDetails?: boolean;
  /** Set only after the desktop shell confirms its native local controller. */
  localHostKey?: string;
}) {
  useLocale();
  const snapshot = useSyncExternalStore(notify => { const cleanups = entries.map(entry => entry.connection?.subscribe(notify)); return () => cleanups.forEach(cleanup => cleanup?.()); }, () => JSON.stringify(entries.map(entry => { const state = connectionOf(entry)?.state; return [state?.status, state?.network, state?.hostProfile, state?.networkAvailable, state?.user?.role, state?.networkChange]; })));
  const [confirmedNames, setConfirmedNames] = useState<Record<string, HostProfileState>>({});
  const hostName = (entry: ConnectedHost) => { const confirmed = confirmedNames[entry.host.publicKey], current = connectionOf(entry)?.state.hostProfile; return confirmed && (!current || current.revision < confirmed.revision) ? confirmed.name : entryName(entry); };
  const [selectedNetwork, setSelectedNetwork] = useState("");
  const [joinSuccess, setJoinSuccess] = useState("");
  const [preparingLocal, setPreparingLocal] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState("");
  const refreshingRef = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [create, setCreate] = useState(false), [createHost, setCreateHost] = useState("");
  const [networkName, setNetworkName] = useState(t("我的网络"));
  const [joining, setJoining] = useState<NetworkJoinAttempt>();
  const attempt = useRef<NetworkJoinAttempt | undefined>(undefined);
  const [consent, setConsent] = useState(false);
  const joinRouteHintId = useId(), connectionsScopeId = useId();
  const [details, setDetails] = useState<string>();
  // `original` is the host name read when editing began; only the user's own
  // edits make the draft dirty, never a rename arriving from another device.
  const [rename, setRename] = useState<{ publicKey: string; name: string; revision: number; original: string }>();
  const [discardRename, setDiscardRename] = useState(false), [leaveDetails, setLeaveDetails] = useState(false);
  const overviewHeading = useRef<HTMLHeadingElement>(null), detailsWereOpen = useRef(false);
  const [routesFor, setRoutesFor] = useState<string>();
  // The overview chooses a host explicitly, without following a different
  // network if membership changes while the address review is open.
  const [routesOverview, setRoutesOverview] = useState<{ id: string; authorityKey: string }>();
  const routesOverviewTrigger = useRef<HTMLButtonElement>(null);
  const restoreRoutesFocus = useRef(false);
  const [routesSuccess, setRoutesSuccess] = useState<{ id: string; authorityKey: string; text: string }>();
  // Connection settings open for one entry's own connection, above the page
  // that opened them. Closing them returns there; drafts below stay mounted.
  const [connectionFor, setConnectionFor] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState<Record<string, boolean>>({});
  const [networkChange, setNetworkChange] = useState<{ sourceKey: string; view: NetworkView }>();
  const [changeConsent, setChangeConsent] = useState(false);
  const [confirm, setConfirm] = useState<{ operation: "leave" | "remove"; publicKey: string; networkId: string; authorityKey: string; name: string; state: "pending" | "active"; dissolve?: boolean }>();
  const networkMap = new Map<string, NetworkManifest>();
  for (const entry of entries) {
    const manifest = currentNetwork(entry); if (!manifest) continue;
    const key = `${manifest.authorityKey}:${manifest.id}`, old = networkMap.get(key);
    if (!old || old.revision < manifest.revision) networkMap.set(key, manifest);
  }
  const networks = [...networkMap.values()];
  // The opening target applies once, when networks first become known; later
  // refreshes never take the selection away from the user.
  const initialHostApplied = useRef(!initialHostKey);
  const preferredNetwork = !initialHostApplied.current ? networks.find(value => value.hosts.some(host => host.publicKey === initialHostKey && !host.revoked)) : undefined;
  const network = networks.find(value => `${value.authorityKey}:${value.id}` === selectedNetwork) ?? preferredNetwork ?? networks[0];
  const authority = entries.find(entry => entry.host.publicKey === network?.authorityKey);
  const authorityName = authority ? hostName(authority) : network?.hosts.find(host => host.publicKey === network.authorityKey)?.name ?? t("协调主机");
  const authorityNotice = network ? managementNotice(authority, authorityName) : "";
  const standalone = entries.filter(entry => !entry.host.networkBlocked && !currentNetwork(entry));
  const eligible = (entry: ConnectedHost, destination: NetworkManifest) => {
    if (entry.host.networkBlocked || !canManage(entry) || !connectionOf(entry)?.state.network || entry.host.publicKey === destination.authorityKey || destination.hosts.some(host => host.publicKey === entry.host.publicKey && (host.revoked || host.state === "active"))) return false;
    const current = currentNetwork(entry);
    if (!current) return true;
    if (current.id === destination.id && current.authorityKey === destination.authorityKey) return false;
    return current.authorityKey === entry.host.publicKey && current.hosts.filter(host => !host.revoked && (host.state === "active" || host.expiresAt! > Date.now())).length === 1;
  };
  const candidates = network ? entries.filter(entry => eligible(entry, network)) : [];
  // Standalone hosts that cannot join right now stay visible with a reason.
  const unjoined = network ? standalone.filter(entry => !candidates.includes(entry)) : [];
  const authorityNoticeId = useId();
  const ready = standalone.filter(entry => canManage(entry) && connectionOf(entry)?.state.network?.sync === "standalone");
  const source = joining && entries.find(entry => entry.host.publicKey === joining.sourceKey);
  const joinAuthority = joining && entries.find(entry => entry.host.publicKey === joining.authorityKey);
  const joiningNetwork = networks.find(value => value.id === joining?.networkId && value.authorityKey === joining.authorityKey);
  const detailEntry = entries.find(entry => entry.host.publicKey === details);
  const detailHost = network?.hosts.find(host => host.publicKey === details && !host.revoked);
  const authorityHasPeers = !!network?.hosts.some(host => host.publicKey !== network.authorityKey && !host.revoked && (host.state === "active" || (host.expiresAt ?? 0) > Date.now()));
  const singletonAuthority = !!network && details === network.authorityKey && !authorityHasPeers;
  const routesEntry = entries.find(entry => entry.host.publicKey === routesFor);
  const routesNetwork = routesOverview && networks.find(value => value.id === routesOverview.id && value.authorityKey === routesOverview.authorityKey);
  const routesHosts = routesNetwork?.hosts.filter(host => !host.revoked && host.state === "active") ?? [];
  const syncNotice = (entry: ConnectedHost) => {
    const c = connectionOf(entry), name = hostName(entry);
    if (entry.host.networkBlocked || !c || c.state.status === "connecting" || !c.state.user || c.state.networkAvailable === undefined) return managementNotice(entry, name);
    if (c.state.status !== "online") return t("「{0}」离线，恢复连接后才能同步地址。", name);
    if (c.state.user.role !== "owner") return t("此设备没有「{0}」的管理权限，不能同步地址。", name);
    return c.state.networkAvailable ? "" : t("「{0}」需要更新后才能同步地址。", name);
  };
  const routesTargetMatches = (entry: ConnectedHost | undefined) => {
    if (!routesOverview) return true;
    const current = entry && currentNetwork(entry);
    return !!entry && !!current && !connectionOf(entry)?.state.networkChange && current.id === routesOverview.id && current.authorityKey === routesOverview.authorityKey && routesHosts.some(host => host.publicKey === entry.host.publicKey) && current.hosts.some(host => host.publicKey === entry.host.publicKey && !host.revoked && host.state === "active");
  };
  const routesTargetChanged = !!routesOverview && (!routesNetwork || !!routesFor && (!routesHosts.some(host => host.publicKey === routesFor) || !!routesEntry && !routesTargetMatches(routesEntry)));
  function closeRoutes() { restoreRoutesFocus.current = !!routesOverview; setRoutesFor(undefined); setRoutesOverview(undefined); setError(""); }
  // On a successful write the trigger was disabled when the dialog unmounted.
  // Restore after React has enabled it, not in the child removal cleanup.
  useLayoutEffect(() => {
    if (routesOverview || busy || !restoreRoutesFocus.current) return;
    restoreRoutesFocus.current = false;
    (routesOverviewTrigger.current ?? overviewHeading.current)?.focus({ preventScroll: true });
  }, [routesOverview, busy]);
  const connectionEntry = entries.find(entry => entry.host.publicKey === connectionFor && !entry.host.networkBlocked && entry.connection);
  const changedEntry = entries.find(entry => entry.host.publicKey === networkChange?.sourceKey);
  const changedManifest = networkChange?.view.sync === "removed" ? undefined : networkChange?.view.membership?.manifest;
  let routeMergeError = false;
  const routes = (() => { try { return routesEntry ? eligibleRoutes(routesEntry).reduce((all, route) => mergeNetworkInviteRoute(all, route), connectionOf(routesEntry)?.state.network?.host.routes ?? []) : []; } catch { routeMergeError = true; return []; } })();
  const publicRoutes = (entry: ConnectedHost | undefined) => connectionOf(entry)?.state.network?.host.routes ?? [];
  const replacedRoutes = publicRoutes(routesEntry).filter(old => !routes.some(route => route.url === old.url));
  const initialJoinApplied = useRef("");
  useEffect(() => {
    if (!initialJoin || initialJoinApplied.current === `${initialJoin.hostId}:${initialJoin.networkHostId}`) return;
    const source = entries.find(entry => entry.host.id === initialJoin.hostId), target = entries.find(entry => entry.host.id === initialJoin.networkHostId);
    const manifest = target && currentNetwork(target);
    if (!source || !target || !connectionOf(source)?.state.network) return;
    if (!manifest) return;
    const member = manifest.hosts.find(host => host.publicKey === source.host.publicKey && !host.revoked);
    if (member?.state === "active") { initialJoinApplied.current = `${initialJoin.hostId}:${initialJoin.networkHostId}`; return; }
    if (member?.state === "pending" && currentNetwork(source)?.id === manifest.id) { initialJoinApplied.current = `${initialJoin.hostId}:${initialJoin.networkHostId}`; setDetails(source.host.publicKey); return; }
    if (!eligible(source, manifest)) { setError(!canManage(source) ? t("主机当前不可用，请恢复连接或管理权限后再加入。") : t("这台主机已属于另一个网络。请先在原网络处理成员关系，再发起加入。")); return; }
    initialJoinApplied.current = `${initialJoin.hostId}:${initialJoin.networkHostId}`;
    setSelectedNetwork(`${manifest.authorityKey}:${manifest.id}`);
    setError("");
    const saved = loadNetworkJoinAttempt(manifest.id, manifest.authorityKey, source.host.publicKey);
    const value = saved?.proposal && saved.proposal.proposal.expiresAt > Date.now() ? saved : newJoinAttempt(manifest, source.host.publicKey);
    attempt.current = value; setJoining(value); setConsent(false);
  }, [initialJoin?.hostId, initialJoin?.networkHostId, snapshot, entries]);
  const initialTarget = entries.find(entry => entry.host.id === initialJoin?.networkHostId);
  const initialTargetView = connectionOf(initialTarget)?.state.network;
  const initialMissingNetwork = !!initialTarget && !!initialTargetView && !currentNetwork(initialTarget);
  // Keep the review current while it is still being read. After consent, a
  // changed directory must go through the existing explicit re-review path.
  useEffect(() => {
    if (!joining || consent || busy || joining.proposal || !joiningNetwork) return;
    if (reviewedNetworkHash(joiningNetwork) === joining.seenManifestHash) return;
    const value = newJoinAttempt(joiningNetwork, joining.sourceKey);
    attempt.current = value; setJoining(value);
  }, [joiningNetwork, consent, busy, joining]);
  const nextJoinRoute = [source, joinAuthority].find((entry): entry is ConnectedHost => !!entry && !publicRoutes(entry).length);
  const joinRoutesReady = !!source && !!joinAuthority && !nextJoinRoute;
  const changed = async () => { await joined?.(); onChanged?.(); };

  async function run(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); setRefreshError(""); } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function refresh() {
    const results = await Promise.allSettled(entries.filter(entry => connectionOf(entry)?.state.status === "online" && connectionOf(entry)?.state.networkAvailable).map(entry => connectionOf(entry)!.refreshNetwork()));
    const failed = results.find(result => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
  }
  async function refreshOverview() {
    if (refreshingRef.current || busyRef.current) return;
    setRoutesSuccess(undefined);
    refreshingRef.current = true; setRefreshing(true); setRefreshError("");
    try { await refresh(); }
    catch (cause) { if (mounted.current) setRefreshError(errorText(cause)); }
    finally { refreshingRef.current = false; if (mounted.current) setRefreshing(false); }
  }
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  useEffect(() => {
    if (initialHostApplied.current || !initialHostKey || (!networks.length && !entries.some(entry => entry.host.publicKey === initialHostKey && connectionOf(entry)?.state.network))) return;
    initialHostApplied.current = true;
    if (preferredNetwork) setSelectedNetwork(`${preferredNetwork.authorityKey}:${preferredNetwork.id}`);
    if (initialHostDetails && (preferredNetwork || entries.some(entry => entry.host.publicKey === initialHostKey))) openDetails(initialHostKey);
  }, [snapshot]);
  function startJoin(entry: ConnectedHost) {
    if (!network) return;
    setRoutesSuccess(undefined);
    const local = attempt.current;
    const prior = local?.networkId === network.id && local.authorityKey === network.authorityKey && local.sourceKey === entry.host.publicKey ? local : loadNetworkJoinAttempt(network.id, network.authorityKey, entry.host.publicKey);
    const value = prior?.networkId === network.id && prior.authorityKey === network.authorityKey && prior.sourceKey === entry.host.publicKey && (!prior.proposal || prior.proposal.proposal.expiresAt > Date.now()) ? prior : newJoinAttempt(network, entry.host.publicKey);
    attempt.current = value; setJoining(value); setConsent(false); setError("");
  }
  function openDetails(key: string) { initialHostApplied.current = true; setDetails(key); setRename(undefined); setRoutesSuccess(undefined); setError(""); }
  async function renameHost(entry: ConnectedHost) {
    const c = connectionOf(entry)!;
    const profile = hostProfileSchema.parse(await c.http("/api/host-profile"));
    // Reopening after a conflict refreshes the revision but keeps typed text.
    setRename(old => ({ publicKey: entry.host.publicKey, name: old?.publicKey === entry.host.publicKey && old.name !== old.original ? old.name : profile.name, revision: profile.revision, original: profile.name }));
  }
  const renameDirty = !!rename && rename.publicKey === details && rename.name !== rename.original;
  function closeDetails() {
    if (busyRef.current) return;
    if (renameDirty) { setDiscardRename(true); return; }
    setDetails(undefined); setRename(undefined); setError("");
  }
  // Close a confirmation before the page beneath it, so each restores focus
  // to a control that is still present and no longer inert.
  useLayoutEffect(() => { if (!leaveDetails) return; setLeaveDetails(false); setDetails(undefined); setRename(undefined); setError(""); }, [leaveDetails]);
  useLayoutEffect(() => {
    if (details) { detailsWereOpen.current = true; return; }
    if (!detailsWereOpen.current) return;
    detailsWereOpen.current = false;
    const active = document.activeElement, sheet = overviewHeading.current?.closest("dialog");
    if (!active || active === document.body || active === sheet || !sheet?.contains(active)) overviewHeading.current?.focus({ preventScroll: true });
  }, [details]);
  async function completeJoin() {
    if (!source || !attempt.current || !canManage(source) || !canManage(joinAuthority)) throw new Error("network_host_unavailable");
    if (attempt.current.proposal && attempt.current.proposal.proposal.expiresAt <= Date.now()) {
      const updated = await connectionOf(source)!.refreshNetwork();
      const own = updated?.membership?.manifest.hosts.find(host => host.publicKey === source.host.publicKey);
      if (updated?.membership?.manifest.id === attempt.current.networkId && own?.state === "pending") {
        setJoining(undefined); attempt.current = undefined; setDetails(source.host.publicKey);
        throw new Error("network_request_expired");
      }
    }
    try {
      await joinNetworkHosts(connectionOf(source)!, connectionOf(joinAuthority)!, attempt.current, value => { saveNetworkJoinAttempt(value); attempt.current = value; setJoining(value); });
    } catch (cause) {
      if (cause instanceof Error && ["network_review_changed", "network_request_expired"].includes(cause.message)) {
        setConsent(false);
        const updated = await connectionOf(joinAuthority)!.refreshNetwork().catch(() => undefined);
        const manifest = updated?.membership?.manifest;
        if (manifest && manifest.id === joining?.networkId && manifest.authorityKey === joining.authorityKey) {
          clearNetworkJoinAttempt(manifest.id, manifest.authorityKey, source.host.publicKey);
          const value = newJoinAttempt(manifest, source.host.publicKey); attempt.current = value; setJoining(value);
        }
      }
      throw cause;
    }
    const completed = attempt.current!;
    clearNetworkJoinAttempt(completed.networkId, completed.authorityKey, completed.sourceKey);
    setJoining(undefined); attempt.current = undefined;
    setJoinSuccess(t("「{0}」已加入「{1}」。可在新建 Bot 时选择运行主机；Bot、对话和文件仍保存在各自的电脑上。", hostName(source), joiningNetwork?.name ?? t("我的网络")));
    // The signed join already succeeded. Other hosts can be briefly unavailable;
    // a background refresh must not turn that success into a failed admission.
    await Promise.allSettled([refresh(), changed()]);
  }
  const visibleHosts = (network?.hosts.filter(host => !host.revoked) ?? []).sort((a, b) => Number(b.publicKey === network!.authorityKey) - Number(a.publicKey === network!.authorityKey));
  const displayNames = new Map<string, string>();
  for (const host of visibleHosts) {
    const entry = entries.find(value => value.host.publicKey === host.publicKey);
    displayNames.set(host.publicKey, entry ? hostName(entry) : host.name);
  }
  for (const entry of network ? [...candidates, ...unjoined] : standalone) displayNames.set(entry.host.publicKey, hostName(entry));
  const comparableName = (name: string) => name.normalize("NFKC").trim().toLowerCase();
  const duplicateName = (name: string) => [...displayNames.values()].filter(value => comparableName(value) === comparableName(name)).length > 1;
  const entryOf = (publicKey: string) => entries.find(entry => entry.host.publicKey === publicKey);
  const isOnline = (host: NetworkHost, entry?: ConnectedHost) => !entry?.host.networkBlocked && host.state === "active" && entry?.connection?.state.status === "online";
  const activeCount = visibleHosts.filter(host => host.state === "active").length;
  const onlineCount = visibleHosts.filter(host => isOnline(host, entryOf(host.publicKey))).length;
  const pendingCount = visibleHosts.filter(host => host.state === "pending").length;
  const state = networkState(authority);
  // Spaces keep tags separate in accessible names; flex layout drops them visually.
  const tags = (publicKey: string) => <>
    {network?.authorityKey === publicKey && <>{" "}<span className="network-tag" data-kind="authority">{t("协调")}</span></>}
    {!!localHostKey && localHostKey === publicKey && <>{" "}<span className="network-tag" data-kind="local">{t("本机")}</span></>}
  </>;
  const joinReason = (entry: ConnectedHost) => {
    const c = connectionOf(entry);
    if (!c || c.state.status !== "online") return "";
    if (c.state.user && c.state.user.role !== "owner") return t("此设备没有这台主机的管理权限");
    if (c.state.networkAvailable === false) return t("需要更新后才能组网");
    return !c.state.network ? t("正在读取网络状态…") : "";
  };
  const row = (host: NetworkHost, entry?: ConnectedHost, note = "") => {
    const name = entry ? hostName(entry) : host.name;
    const online = isOnline(host, entry);
    const blocked = !!entry?.host.networkBlocked;
    const status = host.state === "pending" ? t("待完成加入") : blocked ? t("授权已失效") : online ? t("已连接") : entry?.connection?.state.status === "connecting" ? t("连接中…") : entry?.connection ? t("离线") : t("未连接");
    const tone: Tone = host.state === "pending" ? "warn" : blocked ? "bad" : online ? "ok" : "muted";
    return <button type="button" className="network-member" key={host.publicKey} disabled={busy} onClick={() => openDetails(host.publicKey)}>
      <span className="network-member-icon"><Monitor size={18} aria-hidden="true"/></span>
      <span className="network-member-name"><span className="network-member-title"><strong>{name}</strong>{tags(host.publicKey)}</span>{duplicateName(name) && <small>{fingerprint(host.publicKey)}</small>}{note && <small className="network-member-note">{note}</small>}</span>
      <span className={`network-member-status${online ? " is-online" : ""}`} data-tone={tone}><i aria-hidden="true"/>{status}</span><ChevronRight size={15} aria-hidden="true"/>
    </button>;
  };
  const refreshButton = <button type="button" className="icon-button network-refresh" aria-disabled={busy || refreshing} aria-busy={refreshing} aria-label={t("刷新网络")} title={t("刷新网络")} onClick={() => void refreshOverview()}><RefreshCw size={16} className={refreshing ? "spin" : undefined} aria-hidden="true"/></button>;
  // The desktop that owns its local host can join it into another network; a
  // phone or companion desktop only adds a connection for itself.
  const localEntry = localHostKey ? entryOf(localHostKey) : undefined;
  const localNetwork = localEntry && currentNetwork(localEntry);
  // New devices are approved on the selected network's coordinator. Without a
  // network, use the opening host or the only manageable one; never guess.
  const manageableHosts = entries.filter(entry => canManage(entry));
  const approvalKey = network ? network.authorityKey : initialHostKey && entryOf(initialHostKey) ? initialHostKey : manageableHosts.length === 1 ? manageableHosts[0]!.host.publicKey : "";
  const approvalEntry = approvalKey ? entryOf(approvalKey) : undefined;
  const approvalName = approvalEntry ? hostName(approvalEntry) : network ? authorityName : "";
  const approvalReason = (() => {
    if (!approvalKey) return t("请先连接一台有管理权限的主机，再为新设备显示二维码。");
    const c = connectionOf(approvalEntry);
    if (approvalEntry?.host.networkBlocked || !c || c.state.status === "connecting") return managementNotice(approvalEntry, approvalName);
    if (c.state.status !== "online") return t("「{0}」离线，恢复连接后才能确认新设备。", approvalName);
    if (!c.state.user) return t("正在读取网络管理权限…");
    return c.state.user.role !== "owner" ? t("此设备没有「{0}」的管理权限，不能确认新设备。", approvalName) : "";
  })();
  // On this desktop, pairing with another host continues into a request for
  // the local host to join that host's network; it still needs confirmation.
  // Same rule HostApp uses before offering a join after pairing.
  const localJoins = !!localEntry && canOfferDesktopJoin(connectionOf(localEntry)?.state.network, localHostKey, "");
  const otherHost = !localEntry ? { title: t("此设备连接另一台主机"), detail: t("扫描那台主机的连接码，只为此设备添加连接，不改变组网。") }
    : localJoins ? { title: t("本机加入另一个网络"), detail: t("扫描对方主机的连接码。连接后会申请让本机及其 Bot 加入对方网络，确认后才会加入。") }
    : { title: t("连接另一台主机"), detail: t("只为本机添加连接。本机已在「{0}」中，不会因此改变组网。", localNetwork?.name ?? t("我的网络")) };
  // Detail actions. A reachable host leaves on its own, which checks that its
  // devices keep access elsewhere; coordinator removal is the fallback.
  const detailName = detailEntry ? hostName(detailEntry) : detailHost?.name ?? "";
  // The host decides whether this device may act for it; a refusal is shown
  // and then the coordinator path is offered (see leaveFailed).
  const canSelfAct = !!network && !!detailEntry && canManage(detailEntry) && currentNetwork(detailEntry)?.id === network.id;
  const resumable = detailHost?.state === "pending" && !!detailEntry && candidates.includes(detailEntry);
  const removable = !!network && detailHost?.state === "active" && details !== network.authorityKey && canManage(authority) && (!canSelfAct || !!leaveFailed[details!]);
  const confirmLeave = (publicKey: string, name: string, hostState: "pending" | "active", dissolve = false) => { if (!network) return; setConfirm({ operation: "leave", publicKey, networkId: network.id, authorityKey: network.authorityKey, name, state: hostState, dissolve }); setError(""); };
  const dangerRow = (title: string, detail: string, action: string, onClick: () => void, disabled = false) => <div className="network-danger-row"><div><strong>{title}</strong><p>{detail}</p></div><button type="button" className="text-danger" disabled={busy || disabled} onClick={onClick}>{action}</button></div>;
  const danger = (() => {
    if (!network || !detailHost || !details) return null;
    if (details === network.authorityKey) {
      if (authorityHasPeers) return <p className="network-note">{t("协调主机不能直接退出仍有其他成员的网络。")}</p>;
      if (localHostKey === network.authorityKey) return dangerRow(t("解散网络"), t("这是网络中的最后一台主机。解散后，其他设备对它的访问授权将撤销。"), t("解散网络"), () => confirmLeave(network.authorityKey, network.name, "active", true), !canManage(detailEntry));
      return <p className="network-note">{t("此网络只剩协调主机。请在「{0}」电脑的桌面版中解散网络，或在该主机终端运行 tarobot network leave --yes。", detailName)}</p>;
    }
    if (detailHost.state === "pending") {
      return canSelfAct ? dangerRow(t("取消加入"), t("撤回这次加入申请，之后可以重新申请。"), t("取消加入"), () => confirmLeave(details, detailName, "pending")) : null;
    }
    const rows = <>
      {canSelfAct && dangerRow(t("退出网络"), t("Bot 和对话保留在这台主机上；网络中的其他设备将不能再访问它。"), t("退出网络"), () => confirmLeave(details, detailName, "active"))}
      {removable && dangerRow(t("移出网络"), t("由协调主机「{0}」直接移出，不等待这台主机确认。", authorityName), t("移出网络"), () => { setConfirm({ operation: "remove", publicKey: details, networkId: network.id, authorityKey: network.authorityKey, name: detailName, state: "active" }); setError(""); })}
    </>;
    if (canSelfAct || removable) return rows;
    return <p className="network-note">{t("需要这台主机或协调主机在线，且此设备有管理权限，才能让它离开网络。")}</p>;
  })();
  const connectionButton = (entry: ConnectedHost) => <button type="button" className="network-option" disabled={busy || preparingLocal || !entry.connection || entry.host.networkBlocked} onClick={() => setConnectionFor(entry.host.publicKey)}>
    <SlidersHorizontal size={18} aria-hidden="true"/><span><strong>{t("连接状态与线路")}</strong><small>{entry.host.publicKey === localHostKey ? t("本机的局域网、Tailscale 和 VPS 中转") : t("此设备访问这台主机的直连和中转线路")}</small></span><ChevronRight size={15} aria-hidden="true"/>
  </button>;

  return <CreationDialog mobilePage title={t("设备与网络")} close={close} busy={busy || preparingLocal} closeLabel={t("关闭设备与网络")} showHost={false} className="network-manager">
    {!!entries.length && <section className="network-device-entry" aria-label={t("添加与管理设备")}>
      <button type="button" className="primary network-invite-button" aria-label={t("添加设备")} disabled={busy || preparingLocal} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setError(""); if (confirmDevice && approvalKey && !approvalReason) confirmDevice(approvalKey, "invite"); else setAdding(true); }}><span className="network-invite-icon" aria-hidden="true"><QrCode size={22}/></span><span className="network-invite-copy"><strong>{t("添加设备")}</strong><small>{t("手机、平板或电脑 · 显示连接二维码")}</small></span><ChevronRight size={18} aria-hidden="true"/></button>
      {approvalName && <p className="network-note">{network ? t("通过「{0}」为此网络添加设备。", approvalName) : t("连接主机：{0}", approvalName)}</p>}
      {confirmDevice && approvalKey && <div className="network-device-shortcuts"><button type="button" disabled={busy || !!approvalReason} onClick={() => confirmDevice(approvalKey, "approve")}><ShieldCheck size={16} aria-hidden="true"/>{t("输入配对码确认")}</button><button type="button" disabled={busy || !approvalEntry?.connection || !!approvalEntry?.host.networkBlocked} onClick={() => confirmDevice(approvalKey, "manage")}><MonitorSmartphone size={16} aria-hidden="true"/>{t("管理访问设备")}</button></div>}
    </section>}
    {joinSuccess && <p role="status" className="settings-feedback">{joinSuccess}</p>}
    {routesSuccess && network?.id === routesSuccess.id && network.authorityKey === routesSuccess.authorityKey && <p role="status" className="settings-feedback">{routesSuccess.text}</p>}
    {initialTarget && !initialTargetView && <p role="status" className="network-note">{connectionOf(initialTarget)?.state.status !== "online" ? t("请等待目标主机恢复连接，再继续加入。") : connectionOf(initialTarget)?.state.networkAvailable === false ? t("请确认目标主机已升级到支持组网的版本，且当前设备拥有管理权限。") : t("正在读取目标主机的网络信息…")}</p>}
    {initialMissingNetwork && <section className="network-onboarding-note"><h3>{t("连接已确认，主机尚未组网")}</h3><p>{t("已连接「{0}」，但这台主机还没有可加入的网络。", hostName(initialTarget!))}</p>{canManage(initialTarget) && initialTargetView?.sync === "standalone" ? <button type="button" className="primary" disabled={busy} onClick={() => { setCreateHost(initialTarget!.host.publicKey); setNetworkName(defaultNetworkName(hostName(initialTarget!))); setCreate(true); }}>{t("在「{0}」创建网络", hostName(initialTarget!))}</button> : <p>{connectionOf(initialTarget)?.state.status !== "online" ? t("请等待目标主机恢复连接，再继续加入。") : t("请确认目标主机已升级到支持组网的版本，且当前设备拥有管理权限。")}</p>}</section>}
    {(refreshError || error) && !create && !joining && !details && !routesFor && !routesOverview && !confirm && !networkChange && <p role="alert" className="error-text network-overview-error">{error || refreshError}</p>}
    {entries.filter(entry => !entry.host.networkBlocked && connectionOf(entry)?.state.networkChange).map(entry => <div className="network-notice" key={entry.host.publicKey}><span>{hostName(entry)} · {connectionOf(entry)!.state.networkChange!.membership && connectionOf(entry)!.state.networkChange!.sync !== "removed" ? t("主机的网络已变更") : t("已退出网络")}</span><button type="button" className="network-secondary" disabled={busy} onClick={() => { setNetworkChange({ sourceKey: entry.host.publicKey, view: structuredClone(connectionOf(entry)!.state.networkChange!) }); setChangeConsent(false); setError(""); }}>{t("查看变更")}</button></div>)}
    {network ? <>
      {networks.length > 1 && <label className="network-field network-switch">{t("网络")}<select value={`${network.authorityKey}:${network.id}`} disabled={busy} onChange={event => { initialHostApplied.current = true; setSelectedNetwork(event.target.value); }}>{networks.map(value => <option key={`${value.authorityKey}:${value.id}`} value={`${value.authorityKey}:${value.id}`}>{value.name} · {fingerprint(value.authorityKey)}</option>)}</select></label>}
      <section className="network-summary" aria-label={t("网络概况")}>
        <div className="network-summary-main">
          <h3 ref={overviewHeading} tabIndex={-1}><span className="network-summary-label">{t("网络")}</span>{" "}<span className="network-summary-name">{network.name}</span></h3>
          <span className="network-state" data-tone={state.tone}><i aria-hidden="true"/>{state.label}</span>
          {refreshButton}
        </div>
        <p className="network-summary-meta">
          <span>{t("协调 {0}", authorityName)}</span>
          <span>{t("{0} 台主机", activeCount)}</span>
          <span>{t("{0} 台在线", onlineCount)}</span>
          {!!pendingCount && <span>{t("{0} 台待加入", pendingCount)}</span>}
        </p>
        {authorityNotice && <p className="network-availability" id={authorityNoticeId} role="status">{authorityNotice}</p>}
        <div className="network-sync-shortcut">
          <button ref={routesOverviewTrigger} type="button" disabled={busy || preparingLocal} onClick={event => {
            event.currentTarget.focus({ preventScroll: true });
            const hosts = visibleHosts.filter(host => host.state === "active");
            setRoutesOverview({ id: network.id, authorityKey: network.authorityKey });
            setRoutesFor(visibleHosts.length === 1 && hosts.length === 1 ? hosts[0]!.publicKey : undefined); setRoutesSuccess(undefined); setError("");
          }}><Link size={17} aria-hidden="true"/><span><strong>{t("同步主机地址")}</strong><small>{t("让网络成员获取新地址")}</small></span><ChevronRight size={16} aria-hidden="true"/></button>
          <HostAddressSyncHelp/>
        </div>
      </section>
      <section className="network-members" aria-label={t("网络成员")}>
        <header><h3>{t("已加入的主机")}</h3></header>
        <div className="network-member-list">{visibleHosts.map(host => row(host, entryOf(host.publicKey)))}</div>
      </section>
      {!!candidates.length && <section className="network-members network-candidates" aria-label={t("可加入的主机")}>
        <header><h3>{t("可加入的主机")}</h3></header>
        <div className="network-member-list">{candidates.map(entry => <div className="network-candidate" key={entry.host.publicKey}>
          <span className="network-member-icon"><Monitor size={18} aria-hidden="true"/></span>
          <span className="network-member-name"><span className="network-member-title"><strong>{hostName(entry)}</strong>{tags(entry.host.publicKey)}</span>{duplicateName(hostName(entry)) && <small>{fingerprint(entry.host.publicKey)}</small>}</span>
          <button type="button" className="network-secondary" disabled={busy || !canManage(authority)} aria-describedby={authorityNotice ? authorityNoticeId : undefined} onClick={() => startJoin(entry)}>{t("加入网络")}</button>
        </div>)}</div>
      </section>}
      {!!unjoined.length && <section className="network-members" aria-label={t("未加入网络")}>
        <header><h3>{t("未加入网络")}</h3></header>
        <div className="network-member-list">{unjoined.map(entry => row(connectionOf(entry)?.state.network?.host ?? { publicKey: entry.host.publicKey, name: hostName(entry), routes: [], state: "active", revoked: false }, entry, joinReason(entry)))}</div>
      </section>}
    </> : <>
      <section className="network-empty">
        <div className="network-empty-head"><Globe size={20} aria-hidden="true"/><h3 ref={overviewHeading} tabIndex={-1}>{standalone.length ? t("还没有组网") : t("还没有连接主机")}</h3>{!!entries.length && refreshButton}</div>
        <p>{standalone.length ? t("组网后，各主机的 Bot 会出现在同一个列表里；Bot、对话和文件仍保存在原来的电脑上。") : t("先连接一台运行 TaroBird 的电脑，再创建网络。")}</p>
        {standalone.length || entries.length ? <button type="button" className="primary" disabled={!ready.length || busy} onClick={() => { const preferred = initialTarget && ready.includes(initialTarget) ? initialTarget : ready.find(entry => entry.host.publicKey === initialHostKey) ?? ready[0]!; setCreateHost(preferred.host.publicKey); setNetworkName(defaultNetworkName(hostName(preferred))); setCreate(true); setError(""); }}>{t("创建网络")}</button>
          : <button type="button" className="primary" disabled={busy} onClick={addHost}><Plus size={16} aria-hidden="true"/>{t("连接主机")}</button>}
        {(standalone.length || entries.length) && !ready.length ? <p className="network-note">{!standalone.length ? t("先添加一台运行 TaroBird 的电脑，再创建网络。") : !standalone.some(entry => entry.connection?.state.status === "online") ? t("暂无已连接的主机，请先恢复连接。") : standalone.some(entry => entry.connection?.state.status === "online" && entry.connection.state.user && entry.connection.state.user.role !== "owner") ? t("此设备没有网络管理权限，请使用已授权的管理设备创建网络。") : standalone.some(entry => entry.connection?.state.status === "online" && entry.connection.state.networkAvailable === false) ? t("已连接的主机需要更新后才能创建网络。") : t("正在读取主机状态，请稍后刷新。")}</p> : null}
      </section>
      {!!standalone.length && <section className="network-members" aria-label={t("已配对主机")}><header><h3>{t("已配对主机")}</h3></header><div className="network-member-list">{standalone.map(entry => row(connectionOf(entry)?.state.network?.host ?? { publicKey: entry.host.publicKey, name: hostName(entry), routes: [], state: "active", revoked: false }, entry))}</div></section>}
    </>}
    <footer className="network-overview-footer">
      <button type="button" className="network-option" disabled={busy || preparingLocal} onClick={addHost}><Link size={18} aria-hidden="true"/><span><strong>{otherHost.title}</strong><small>{otherHost.detail}</small></span><ChevronRight size={15} aria-hidden="true"/></button>
      <button type="button" className="network-connections" disabled={busy} aria-label={t("此设备的连接")} aria-describedby={connectionsScopeId} onClick={event => { event.currentTarget.focus({ preventScroll: true }); manageConnections(); }}><Link size={16} aria-hidden="true"/><span>{t("此设备的连接")}</span><small id={connectionsScopeId}>{t("仅此设备")}</small><ChevronRight size={15} aria-hidden="true"/></button>
      <details className="network-help" key={network ? `${network.authorityKey}:${network.id}` : "standalone"}>
        <summary data-disclosure-icon><Globe size={16} aria-hidden="true"/><span>{t("网络如何工作")}</span><ChevronRight size={15} aria-hidden="true"/></summary>
        <div><p>{t("Bot、对话和文件保存在各自的电脑上，组网不会搬移数据。")}</p>{network && <p>{t("「{0}」是协调主机，负责确认新主机和新设备。添加成员时需保持它在线；已配对设备可直接连接其他在线主机。", authorityName)}</p>}</div>
      </details>
    </footer>

    {adding && <CreationDialog mobilePage title={t("添加设备")} close={() => setAdding(false)} closeLabel={t("返回设备与网络")} back showHost={false} className="network-subpage">
      {!approvalKey && !network && manageableHosts.length > 1 ? <><p>{t("选择新设备要连接的主机。二维码会使用所选主机的身份。")}</p>{manageableHosts.map(entry => <button key={entry.host.publicKey} type="button" className="network-option" onClick={() => { setAdding(false); confirmDevice?.(entry.host.publicKey, "invite"); }}><Monitor size={18}/><span><strong>{hostName(entry)}</strong><small>{fingerprint(entry.host.publicKey)}</small></span><QrCode size={18}/></button>)}</> : <>
        <p role="status" className="network-note">{approvalReason || t("请在已连接主机的设备设置中打开「添加设备」。")}</p>
        <button type="button" onClick={() => void refreshOverview()} disabled={refreshing}>{t("重试")}</button>
        {confirmDevice && approvalKey && !approvalReason && <button type="button" className="primary" onClick={() => { setAdding(false); confirmDevice(approvalKey, "invite"); }}><QrCode size={18}/>{t("显示连接二维码")}</button>}
      </>}
    </CreationDialog>}

    {create && <CreationDialog mobilePage title={t("创建网络")} busy={busy} close={() => { setCreate(false); setError(""); }} closeLabel={t("返回设备与网络")} back showHost={false} className="network-subpage"><form className="network-form" onSubmit={event => { event.preventDefault(); void run(async () => { const entry = entries.find(value => value.host.publicKey === createHost); if (!canManage(entry) || currentNetwork(entry!)) throw new Error("network_host_unavailable"); const result = await connectionOf(entry)!.networkCommand({ operation: "create", name: networkName.trim() }); const created = result.view.membership?.manifest; if (created) setSelectedNetwork(`${created.authorityKey}:${created.id}`); setCreate(false); await Promise.allSettled([changed()]); }); }}>
      <label className="network-field">{t("网络名称")}<input value={networkName} maxLength={100} disabled={busy} onChange={event => setNetworkName(event.target.value)}/></label>
      <label className="network-field">{t("协调主机")}<select value={createHost} disabled={busy} onChange={event => setCreateHost(event.target.value)}>{ready.map(entry => <option key={entry.host.publicKey} value={entry.host.publicKey}>{hostName(entry)} · {fingerprint(entry.host.publicKey)}</option>)}</select></label>
      <p className="network-note">{t("请选择经常在线的主机。新增成员和同步新设备时会通过它确认权限。")}</p>{error && <p role="alert" className="error-text">{error}</p>}
      <footer className="network-actions"><button type="button" disabled={busy} onClick={() => { setCreate(false); setError(""); }}>{t("取消")}</button><button type="submit" className="primary" disabled={busy || !networkName.trim() || !ready.some(entry => entry.host.publicKey === createHost)}>{busy ? t("处理中…") : t("创建网络")}</button></footer>
    </form></CreationDialog>}

    {joining && source && <CreationDialog mobilePage title={t("加入网络")} close={() => { setJoining(undefined); setError(""); }} closeLabel={t("返回设备与网络")} back showHost={false} busy={busy || preparingLocal} className="network-subpage">
      {initialJoin && <p className="network-note">{t("手机已确认连接。最后一步：让这台电脑作为主机加入网络。")}</p>}
      <div className="network-direction">
        <div><small>{t("主机")}</small><strong>{hostName(source)}</strong><span>{fingerprint(source.host.publicKey)}</span></div>
        <ArrowRight size={18} aria-hidden="true"/>
        <div><small>{t("网络")}</small><strong>{joiningNetwork?.name ?? t("我的网络")}</strong><span>{t("协调 {0}", joinAuthority ? hostName(joinAuthority) : t("协调主机"))} · {fingerprint(joining.authorityKey)}</span></div>
      </div>
      <p className="network-note">{t("加入后，两边已授权的设备都能访问网络内的 Bot 和对话。主机上的历史和文件保留原位。")}</p>
      {currentNetwork(source)?.authorityKey === source.host.publicKey && <p className="network-note network-caution">{t("「{0}」将离开原来的单主机网络，改由「{1}」协调。请确认加入方向正确。", hostName(source), joinAuthority ? hostName(joinAuthority) : t("协调主机"))}</p>}
      {joining.reviewedManifest && <details open={!!initialJoin} className="network-review-members"><summary>{t("查看网络成员和已授权设备")}</summary><ul>{joining.reviewedManifest.hosts.filter(host => !host.revoked).map(host => <li key={host.publicKey}>{host.name} · {fingerprint(host.publicKey)}{host.state === "pending" ? " · " + t("待完成加入") : ""}</li>)}{joining.reviewedManifest.devices.filter(device => !device.revoked).map(device => <li key={`${device.host}:${device.id}`}>{device.name} · {platformName(device.platform)}</li>)}</ul></details>}
      <section className="network-join-routes" aria-label={t("连接线路")}>
        <h4>{t("连接线路")}</h4>
        {[source, joinAuthority].filter((entry): entry is ConnectedHost => !!entry).map(entry => <div className="network-join-route" key={entry.host.publicKey}>
          <div className="network-join-route-head"><strong>{hostName(entry)}</strong>{tags(entry.host.publicKey)}<span className="network-route-state" data-ready={!!publicRoutes(entry).length}>{publicRoutes(entry).length ? <><Check size={13} aria-hidden="true"/>{t("已共享 {0} 条线路", publicRoutes(entry).length)}</> : t("尚未共享线路")}</span></div>
          {!publicRoutes(entry).length && entry.host.publicKey === localHostKey
            ? <DesktopHostInvite hubKey={entry.host.publicKey} connection={connectionOf(entry)} purpose="network" disabled={busy} busyChange={setPreparingLocal}/>
            : <><div className="network-sync-actions"><button type="button" className="network-secondary" disabled={busy || preparingLocal} onClick={() => { setRoutesFor(entry.host.publicKey); setError(""); }}>{t("检查或同步地址")}</button><HostAddressSyncHelp/></div>{entry.host.publicKey === localHostKey && <details><summary>{t("更换本机连接方式")}</summary><DesktopHostInvite hubKey={entry.host.publicKey} connection={connectionOf(entry)} purpose="network" disabled={busy} busyChange={setPreparingLocal}/></details>}</>}
        </div>)}
        <p className="network-note">{t("这台设备能连上，不代表主机之间互通。共享只是把地址告诉网络成员，不检测连通，也不部署中转。")}</p>
      </section>
      {!joinAuthority ? <p className="network-note" role="status">{t("尚未连接协调主机。请检查它是否在线，并刷新网络；已有授权会自动恢复。若从未连接过它，请先通过「连接另一台主机」完成配对。")}</p> : !canManage(joinAuthority) ? <p className="network-note" role="status">{managementNotice(joinAuthority, hostName(joinAuthority))}</p> : null}
      <p className="network-note">{t("手机将自动发现这台主机，无需再次扫码。")}</p>
      {!joinRoutesReady && <p id={joinRouteHintId} role="status" className="network-note">{nextJoinRoute ? t("还差一步：请先准备或共享「{0}」的连接线路。", hostName(nextJoinRoute)) : t("还差一步：请先准备或共享上方缺少的连接线路。")}</p>}
      <label className="network-consent"><input type="checkbox" checked={consent} disabled={busy || !joinRoutesReady} aria-describedby={!joinRoutesReady ? joinRouteHintId : undefined} onChange={event => setConsent(event.target.checked)}/><span>{t("允许两边已授权的设备访问同一网络中的主机")}</span></label>
      {joining.membership && <p role="status" className="network-note">{t("已保存加入批准，但主机之间的连接确认尚未完成。请检查两台主机共享的线路，再重试；无需重新配对。")}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
      <footer className="network-actions"><button type="button" disabled={busy || preparingLocal} onClick={() => { setJoining(undefined); setError(""); }}>{t("返回")}</button>{nextJoinRoute
        ? <button type="button" className="primary network-prepare-route" disabled={busy || preparingLocal || !canManage(nextJoinRoute)} aria-describedby={joinRouteHintId} onClick={() => { setRoutesFor(nextJoinRoute.host.publicKey); setError(""); }}><Link size={16}/><span>{t("准备「{0}」的连接线路", hostName(nextJoinRoute))}</span></button>
        : <button type="button" className="primary" disabled={busy || preparingLocal || !consent || !canManage(source) || !canManage(joinAuthority) || !joinRoutesReady} onClick={() => void run(completeJoin)}><ShieldCheck size={16}/>{busy ? t("正在加入…") : joining.proposal ? t("重试加入") : t("确认加入")}</button>}</footer>
    </CreationDialog>}

    {details && (detailEntry || detailHost) && <CreationDialog mobilePage title={detailName} busy={busy || preparingLocal} close={closeDetails} closeLabel={t("返回设备与网络")} back showHost={false} className="network-subpage network-detail">
      <div className="network-detail-head">
        <span className="network-member-icon"><Monitor size={18} aria-hidden="true"/></span>
        <div><span className="network-member-title">{tags(details)}{detailHost ? <span className="network-detail-state">{detailHost.state === "pending" ? t("待完成加入") : t("网络成员")}</span> : <span className="network-detail-state">{t("未加入网络")}</span>}</span><p className="network-fingerprint">{t("主机身份")} · {fingerprint(details)}</p></div>
      </div>
      {network && details === network.authorityKey && <p className="network-note">{t("协调主机：负责确认新主机和新设备，日常对话无需通过它转发。")}</p>}
      {!canManage(detailEntry) && <p className="network-note" role="status">{!detailEntry?.connection ? t("此设备尚未连接这台主机。") : detailEntry.host.networkBlocked ? t("此设备的授权已失效，请重新配对后管理这台主机。") : detailEntry.connection.state.status !== "online" ? t("连接这台主机后，才能修改名称或共享线路。") : !detailEntry.connection.state.user ? t("正在读取网络管理权限…") : detailEntry.connection.state.user.role !== "owner" ? t("此设备没有这台主机的管理权限，无法修改名称或共享线路。") : detailEntry.connection.state.networkAvailable === false ? t("这台主机需要更新后，才能在此修改名称或共享线路。") : t("正在读取网络管理能力…")}</p>}
      {detailHost?.state === "pending" && <div className="network-pending"><p className="network-note">{detailHost.expiresAt! <= Date.now() ? t("本次加入已超时。请在待加入主机上取消，再重新发起加入。") : t("正在等待协调主机确认，连接恢复后会自动继续；完成前不会向其他设备开放此主机。")}</p>{resumable && <button type="button" className="primary" disabled={busy || !canManage(authority)} onClick={() => startJoin(detailEntry!)}>{t("继续加入")}</button>}</div>}
      {detailEntry && <section className="network-detail-section">
        <div className="network-detail-row"><span>{t("主机名称")}</span><strong className="network-detail-name">{hostName(detailEntry)}</strong><button type="button" className="network-secondary" aria-label={t("修改主机名称")} disabled={busy || !canManage(detailEntry)} onClick={() => void run(() => renameHost(detailEntry))}><Pencil size={15} aria-hidden="true"/>{t("修改")}</button></div>
        {rename?.publicKey === details && <form className="network-form network-rename" onSubmit={event => { event.preventDefault(); void run(async () => { const c = connectionOf(detailEntry)!; if (!canManage(detailEntry)) throw new Error("network_host_unavailable"); const name = hostNameSchema.parse(rename.name); const saved = hostProfileSchema.parse(await c.http("/api/host-profile", { method: "PATCH", body: JSON.stringify({ name, revision: rename.revision }) })); setConfirmedNames(old => ({ ...old, [detailEntry.host.publicKey]: saved })); setRename(undefined); await Promise.allSettled([c.refreshNetwork(), changed()]); }); }}><label className="network-field"><span className="network-visually-hidden">{t("主机名称")}</span><input maxLength={100} value={rename.name} disabled={busy} onChange={event => setRename({ ...rename, name: event.target.value })}/></label><p className="network-note">{t("名称会同步到连接这台主机的其他设备。")}</p><button type="submit" className="primary" disabled={busy || !hostNameSchema.safeParse(rename.name).success}>{t("保存名称")}</button></form>}
      </section>}
      <section className="network-detail-section">
        <h4>{t("连接")}</h4>
        {detailEntry && connectionButton(detailEntry)}
        <div className="network-detail-row"><span>{t("网络线路")}</span><strong>{(detailEntry ? publicRoutes(detailEntry) : detailHost?.routes ?? []).length ? t("已共享 {0} 条线路", (detailEntry ? publicRoutes(detailEntry) : detailHost!.routes).length) : t("尚未共享线路")}</strong>{detailEntry && <div className="network-sync-actions"><button type="button" className="network-secondary" disabled={busy || !canManage(detailEntry)} onClick={() => { setRoutesFor(details); setError(""); }}><Link size={15} aria-hidden="true"/>{t("同步主机地址")}</button><HostAddressSyncHelp/></div>}</div>
        {!!(detailEntry ? publicRoutes(detailEntry) : detailHost?.routes ?? []).length && <ul className="network-route-list">{(detailEntry ? publicRoutes(detailEntry) : detailHost!.routes).map(route => <li key={route.url}>{route.url}</li>)}</ul>}
        <p className="network-note">{t("共享只是把地址告诉网络成员，不检测连通，也不部署中转。")}</p>
      </section>
      {error && <p role="alert" className="error-text">{error}</p>}
      {danger && <section className="network-danger" aria-label={t("危险操作")}><h4>{t("危险操作")}</h4>{danger}</section>}
    </CreationDialog>}

    {discardRename && details && <CreationDialog title={t("放弃未保存的修改？")} close={() => setDiscardRename(false)} closeLabel={t("继续编辑")} showHost={false} className="network-subpage network-confirm">
      <p className="network-note">{t("主机名称尚未保存，返回会放弃这次修改。")}</p>
      <footer className="network-actions"><button type="button" className="primary" onClick={() => setDiscardRename(false)}>{t("继续编辑")}</button><button type="button" className="text-danger" onClick={() => { setDiscardRename(false); setLeaveDetails(true); }}>{t("放弃修改")}</button></footer>
    </CreationDialog>}

    {(routesOverview || routesFor && routesEntry) && <CreationDialog mobilePage title={t("同步主机地址")} busy={busy || preparingLocal} close={closeRoutes} returnFocus={routesOverview ? routesOverviewTrigger : undefined} closeLabel={joining ? t("返回加入网络") : details ? t("返回主机详情") : t("返回设备与网络")} back showHost={false} className="network-subpage">
      {routesOverview && <>
        <p className="network-note">{t("同步到「{0}」的网络成员", routesNetwork?.name ?? t("我的网络"))}</p>
        <label className="network-field">{t("要同步的主机")}<select value={routesFor ?? ""} disabled={busy || preparingLocal || !routesNetwork} onChange={event => { setRoutesFor(event.target.value || undefined); setError(""); }}>
          <option value="">{t("请选择主机")}</option>
          {!!routesFor && !routesHosts.some(host => host.publicKey === routesFor) && <option value={routesFor} disabled>{t("原主机已不在此网络")}</option>}
          {routesHosts.map(host => { const entry = entryOf(host.publicKey); return <option key={host.publicKey} value={host.publicKey}>{entry ? hostName(entry) : host.name} · {fingerprint(host.publicKey)}</option>; })}
        </select></label>
        {routesNetwork?.hosts.some(host => !host.revoked && host.state === "pending") && <p className="network-note">{t("待加入主机的地址请在「继续加入」中设置。")}</p>}
      </>}
      {routesTargetChanged ? <p role="alert" className="network-note">{t("主机的网络归属已变化，请返回设备与网络，重新选择后再同步。")}</p> : routesFor && !routesEntry ? <p role="status" className="network-note">{t("此设备尚未连接这台主机。")}</p> : routesEntry && <>
        <div className="network-sync-heading"><h3>{hostName(routesEntry)}</h3><HostAddressSyncHelp/></div>
        {!canManage(routesEntry) && <p role="status" className="network-note">{syncNotice(routesEntry)}</p>}
        {routesEntry.host.publicKey === localHostKey && !!routes.length && <details><summary>{t("更换本机连接方式")}</summary><DesktopHostInvite hubKey={routesEntry.host.publicKey} connection={connectionOf(routesEntry)} purpose="network" disabled={busy || !!routesOverview && !canManage(routesEntry)} busyChange={setPreparingLocal}/></details>}
        {routeMergeError && <p role="alert">{t("合并后超过线路数量上限。原线路未改变，请先在连接设置中整理线路。")}</p>}
        <p className="network-note">{t("把下列主机地址同步给同一 TaroBird 网络的其他成员，供它们连接这台主机。请先核对地址，再确认同步。")}</p>
        {routesEntry.host.publicKey === localHostKey && !routes.length ? <DesktopHostInvite hubKey={routesEntry.host.publicKey} connection={connectionOf(routesEntry)} purpose="network" disabled={busy || !!routesOverview && !canManage(routesEntry)} busyChange={setPreparingLocal}/> : routes.length ? <>
          {!!replacedRoutes.length && <div className="network-sync-replacement"><h4>{t("将被替换的已共享地址")}</h4><ul className="network-route-list">{replacedRoutes.map(route => <li key={route.url}>{route.url}</li>)}</ul><p className="network-note">{t("这些已共享地址会被下方地址替换。请核对，避免把此设备保存的过期地址重新同步到网络。")}</p></div>}
          {!!replacedRoutes.length && <h4 className="network-sync-result-label">{t("确认后同步的地址")}</h4>}
          <ul className="network-route-list">{routes.map(route => <li key={route.url}>{route.url}</li>)}</ul>
          {error && <p role="alert" className="error-text">{error}</p>}
          <footer className="network-actions"><button type="button" disabled={busy || preparingLocal} onClick={closeRoutes}>{t("取消")}</button><button type="button" className="primary" disabled={busy || preparingLocal || !canManage(routesEntry)} onClick={() => void run(async () => {
            if (!canManage(routesEntry) || !routesTargetMatches(routesEntry)) throw new Error("network_host_unavailable");
            const result = await connectionOf(routesEntry)!.networkCommand({ operation: "routes", networkId: routesOverview?.id ?? currentNetwork(routesEntry)?.id ?? "", routes });
            if (routesOverview) setRoutesSuccess({ ...routesOverview, text: result.view.sync === "waiting" ? t("「{0}」的地址已保存，正在等待协调主机同步给网络成员。", hostName(routesEntry)) : t("「{0}」的地址已保存到网络，其他成员更新网络信息后会收到新地址。", hostName(routesEntry)) });
            closeRoutes(); await Promise.allSettled([refresh(), changed()]);
          })}><Check size={16}/>{t("确认同步")}</button></footer>
        </> : <><p className="network-note">{t("尚未配置可共享的 HTTPS 线路。请先配置局域网、Tailscale 或 VPS 的 HTTPS 线路，再共享给网络成员。")}</p>{connectionButton(routesEntry)}</>}
      </>}
    </CreationDialog>}

    {networkChange && changedEntry && <CreationDialog mobilePage title={t("查看网络变更")} busy={busy} close={() => { setNetworkChange(undefined); setError(""); }} closeLabel={t("返回设备与网络")} back showHost={false} className="network-subpage">
      <h3>{hostName(changedEntry)}</h3><p className="network-note">{changedManifest ? t("这台主机已改为连接下面的网络。确认后，此设备会更新网络成员和授权关系。") : t("这台主机已退出原网络。原网络设备的访问已解除，Bot、对话和文件保留在本机。")}</p>
      {changedManifest && <><div className="network-join-review"><Globe size={22}/><strong>{changedManifest.name}</strong><small>{t("协调主机")} · {changedManifest.hosts.find(host => host.publicKey === changedManifest.authorityKey)?.name} · {fingerprint(changedManifest.authorityKey)}</small></div><ul className="network-route-list">{changedManifest.hosts.filter(host => !host.revoked).map(host => <li key={host.publicKey}>{host.name} · {fingerprint(host.publicKey)}{host.state === "pending" ? " · " + t("待完成加入") : ""}</li>)}</ul><details className="network-review-members"><summary>{t("查看已授权设备")}</summary><ul>{changedManifest.devices.filter(device => !device.revoked).map(device => <li key={`${device.host}:${device.id}`}>{device.name} · {platformName(device.platform)}</li>)}</ul></details><label className="network-consent"><input type="checkbox" checked={changeConsent} disabled={busy} onChange={event => setChangeConsent(event.target.checked)}/><span>{t("确认使用这个网络及其已授权设备")}</span></label></>}
      <p className="network-note">{changedManifest ? t("确认只会更新网络信息，不会删除 Bot、对话或文件。") : t("手机继续留在原网络。要再次访问这台主机，需要重新扫码配对。")}</p>{error && <p role="alert" className="error-text">{error}</p>}
      <footer className="network-actions"><button type="button" disabled={busy} onClick={() => setNetworkChange(undefined)}>{t("返回")}</button><button type="button" className="primary" disabled={busy || changedManifest && !changeConsent || connectionOf(changedEntry)?.state.status !== "online"} onClick={() => void run(async () => { try { await connectionOf(changedEntry)!.confirmNetworkChange(networkChange.view); }
        catch (cause) {
          if (cause instanceof Error && cause.message === "network_review_changed") { await connectionOf(changedEntry)!.refreshNetwork().catch(() => undefined); setNetworkChange(undefined); throw new Error(t("网络信息又有变化，请重新查看后确认。")); }
          throw cause;
        }
        setNetworkChange(undefined); await Promise.allSettled([refresh(), changed()]); })}>{busy ? t("处理中…") : t("确认变更")}</button></footer>
    </CreationDialog>}

    {confirm && <CreationDialog title={confirm.dissolve ? t("解散「{0}」？", confirm.name) : confirm.state === "pending" ? t("取消「{0}」的加入申请？", confirm.name) : confirm.operation === "remove" ? t("将「{0}」移出网络？", confirm.name) : t("让「{0}」退出网络？", confirm.name)} close={() => { setConfirm(undefined); setError(""); }} closeLabel={t("返回")} showHost={false} busy={busy} className="network-subpage network-confirm">
      {confirm.dissolve ? <ul className="network-departure-effects"><li>{t("本机的 Bot、对话和文件保留，本机桌面端可继续使用。")}</li><li>{t("手机和其他设备对这台主机的访问授权将撤销，再次连接需要重新扫码配对。")}</li></ul> : confirm.state === "pending" ? <p className="network-note">{t("取消需要协调主机在线确认。这台主机尚未向网络开放，取消后可以重新申请加入；Bot、对话和文件保留。")}</p> : <>
        <ul className="network-departure-effects">
          <li>{t("主机上的 Bot、对话和文件保留，可在本机继续使用。")}</li>
          <li>{t("手机和其他网络设备留在原网络，不能再访问这台主机。")}</li>
          <li>{t("这台主机如需手机访问，需要重新扫码配对。")}</li>
        </ul>
        <p className="network-note">{t("此网络不再接受该主机身份；再次加入需要新的主机身份。")}</p>
      </>}
      {!confirm.dissolve && confirm.operation === "leave" && confirm.state === "active" && <p className="network-note">{t("退出需要协调主机在线确认，确认完成前会保留当前网络关系。")}</p>}
      {confirm.operation === "remove" && <p className="network-note">{t("由协调主机直接移出，不等待这台主机确认。离线主机需要重新连接后才能获知成员变更。")}</p>}
      {!confirm.dissolve && confirm.state === "active" && <button type="button" className="network-text-button" disabled={busy} onClick={event => { event.currentTarget.focus({ preventScroll: true }); manageConnections(); }}>{t("只想从此设备移除这台主机的连接？")}</button>}
      {error && <p role="alert" className="error-text">{error}</p>}
      <footer className="network-actions"><button type="button" disabled={busy} onClick={() => { setConfirm(undefined); setError(""); }}>{t("返回")}</button><button type="button" className="text-danger" disabled={busy} onClick={() => void run(async () => {
        const owner = entries.find(entry => entry.host.publicKey === (confirm.operation === "remove" ? confirm.authorityKey : confirm.publicKey));
        if (!canManage(owner) || currentNetwork(owner!)?.id !== confirm.networkId) throw new Error("network_host_unavailable");
        if (confirm.dissolve) {
          const latest = currentNetwork(owner!);
          if (localHostKey !== confirm.publicKey || latest?.authorityKey !== confirm.publicKey || latest.hosts.some(host => host.publicKey !== confirm.publicKey && !host.revoked && (host.state === "active" || (host.expiresAt ?? 0) > Date.now()))) throw new Error(t("网络成员已变化，请返回查看最新状态后再操作。"));
        }
        try {
          await connectionOf(owner)!.networkCommand(confirm.operation === "remove" ? { operation: "remove", networkId: confirm.networkId, publicKey: confirm.publicKey, expectedState: confirm.state } : { operation: "leave", networkId: confirm.networkId, expectedState: confirm.state });
        } catch (cause) {
          // A refused self-departure keeps its reason and offers the coordinator
          // path, except where waiting (devices, upgrades) is the actual remedy.
          if (confirm.operation === "leave" && confirm.state === "active" && !confirm.dissolve && !(cause instanceof Error && ["network_devices_not_ready", "network_upgrade_required"].includes(cause.message))) setLeaveFailed(old => ({ ...old, [confirm.publicKey]: true }));
          if (cause instanceof Error && cause.message === "network_host_state_changed") { await refresh().catch(() => undefined); setConfirm(undefined); }
          throw cause;
        }
        clearNetworkJoinAttempt(confirm.networkId, confirm.authorityKey, confirm.publicKey);
        setConfirm(undefined); setLeaveDetails(true); await Promise.allSettled([refresh(), changed()]);
      })}>{busy ? t("处理中…") : confirm.dissolve ? t("解散网络") : confirm.state === "pending" ? t("取消加入") : confirm.operation === "remove" ? t("移出网络") : t("退出网络")}</button></footer>
    </CreationDialog>}

    {connectionEntry && <RuntimeHostContext.Provider value={hostName(connectionEntry)}><ConnectionPanel key={connectionEntry.host.registrationId} connection={connectionEntry.connection!} close={() => setConnectionFor(undefined)} backLabel={routesFor === connectionFor ? t("返回地址同步") : t("返回主机详情")}/></RuntimeHostContext.Provider>}
  </CreationDialog>;
}
