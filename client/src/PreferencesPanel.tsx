import { WorkbenchLibrary } from "./WorkbenchLibrary.js";
import type { WorkbenchFileTarget } from "./workbench-library-context.js";
import { useDialogDrag } from "./dialog-drag.js";
import { useSceneMotion } from "./use-scene-motion.js";
import { BackupSettings } from "./BackupSettings.js";
import { WidgetSettings } from "./WidgetSettings.js";
import { GoogleDocsSettings } from "./GoogleDocsSettings.js";
import { VoiceSettings } from "./VoiceSettings.js";
import { timeoutSignal } from "./abort-signals.js";
import { useDesktopLocalHost } from "./useDesktopLocalHost.js";
import { nativePlatform } from "./native.js";
import { DeviceInviteCode } from "./DeviceInviteCode.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { DEFAULT_MONO_ACCENT, monoAccents, colorPalettes } from "./palettes.js";
import { ExpressivePreview } from "./ExpressivePreview.js";
import { FontSizeSlider } from "./FontSizeSlider.js";
import { LayoutDensityPicker } from "./LayoutDensityPicker.js";
import { useBackAction } from "./back-navigation.js";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { AudioLines, Bell, Database, FolderOpen, Check, ChevronLeft, ChevronRight, Globe, Link, Monitor, Plus, QrCode, ScanLine, Settings2, ShieldCheck, X } from "lucide-react";
import { ConnectionPanel } from "./ConnectionPanel.js";
import type { OpenNetwork } from "./network-navigation.js";
import "./network-settings.css";
import { CreationDialog } from "./CreationDialog.js";
import { useSettingsPageViewport } from "./SettingsPageHeader.js";
import { PersonalAvatarEditor } from "./Avatar.js";
import { DesktopUpdates } from "./DesktopUpdates.js";
import { AndroidUpdates } from "./AndroidUpdates.js";
import { MobileLockSettings } from "./MobileLock.js";
import { NotificationSettings, DesktopPreferences } from "./NotificationSettings.js";
import { PendingPairings } from "./PendingPairings.js";
import { PairingScanner } from "./PairingCode.js";
import { DeviceName } from "./RoutesEditor.js";
import { PlatformIcon, SettingsGroupHeading, SettingsScope, platformName } from "./SettingsParts.js";
import { deviceOperationError } from "./device-errors.js";
import { HubHttpError } from "./http-error.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";
import type { Preferences } from "./storage.js";
import { ambiguousDeviceName, deviceDisplayName, deviceRevokeScope } from "./device-presentation.js";
import "./device-settings.css";
import { BotMessageGrants } from "./BotMessageGrants.js";

type Section = "workbench" | "backups" | "general" | "network" | "notifications" | "devices" | "botMessages" | "voice";
/** `created_at`/`last_seen` come from the host; 0 or missing means never recorded. */
type Device = { id: string; name: string; nameSource?: "host"; platform: string; revoked: number; created_at?: number | string | null; last_seen?: number | string | null };
/** Messages appear beside the control that produced them, not at the page end. */
type Feedback = { area: "pair" | "devices" | "danger"; text: string | (() => string); error?: boolean; operationKind?: Operation["kind"] };
/** The device operation in flight, kept so its progress can say what and where. */
type Operation = { kind: "approve"; code: string } | { kind: "revoke"; id: string; label: string } | { kind: "rename" };
const loopback = (url: string) => { try { const host = new URL(url).hostname; return host === "localhost" || host === "[::1]" || host.startsWith("127."); } catch { return false; } };
const phoneQuery = "(max-width:760px),(hover:none) and (pointer:coarse)";
const subscribePhone = (notify: () => void) => { const query = matchMedia(phoneQuery); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify); };
const phoneLayout = () => matchMedia(phoneQuery).matches;
const pairingCode = /^[0-9]{8}$/;
const spacedCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const idTail = (id: string) => id.slice(-6);
const nameKey = (name: string) => name.trim().toLocaleLowerCase();
// Hosts record seconds, milliseconds or SQLite UTC text. Zero, empty and
// unparsable values mean "not recorded" — never "just now" or online.
const timestamp = (value: Device["last_seen"]): number | undefined => {
  const text = typeof value === "string" ? value.trim() : "";
  const sqliteUtc = /^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d(\.\d+)?)?$/.test(text);
  const raw = typeof value === "number" ? value : /^\d+(\.\d+)?$/.test(text) ? Number(text) : text ? Date.parse(sqliteUtc ? `${text.replace(" ", "T")}Z` : text) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  return raw < 1e11 ? raw * 1000 : raw;
};
const dateText = (ms: number, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);
const sinceText = (ms: number, locale: string) => {
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 60) return t("刚刚");
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return relative.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 7 * 86_400) return relative.format(-Math.floor(seconds / 86_400), "day");
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(ms);
};
// Matches deviceOperationError: without a definite 4xx answer the host may have applied the write.
const outcomeUnknown = (error: unknown) => !(error instanceof HubHttpError) || error.status < 400 || error.status >= 500 || error.status === 408;

/** A nested multi-step modal. Escape and native Back step back inside the flow
 * first; only its close button, or Back from the first step, leaves it. */
function FlowDialog({ title, closeLabel, busy, back, close, returnFocus, className, children }: { title: string; closeLabel: string; busy: boolean; back: () => void; close: () => void; returnFocus: RefObject<HTMLElement | null>; className: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), leaving = useRef(false);
  const body = useRef<HTMLDivElement>(null), header = useRef<HTMLElement>(null);
  useDialogDrag(dialog, header, true);
  useSettingsPageViewport(body);
  useBackAction(dialog, () => { if (!busy) back(); });
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null, node = dialog.current;
    leaving.current = false; node?.showModal();
    return () => { leaving.current = true; node?.close(); (returnFocus.current ?? before)?.focus({ preventScroll: true }); };
  }, [returnFocus]);
  return <dialog ref={dialog} className={`creation-dialog new-chat-panel mobile-settings-dialog is-movable ${className}`} aria-label={title} onCancel={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault(); if (!busy) back();
  }} onClose={(event) => {
    // A repeated Escape can close a dialog without a cancel event; treat it as Escape.
    if (event.target !== event.currentTarget || leaving.current || event.currentTarget.open) return;
    event.currentTarget.showModal(); if (!busy) back();
  }}>
    <header ref={header}><button type="button" className="icon-button settings-dialog-back" disabled={busy} aria-label={t("返回")} onClick={back}><ChevronLeft size={24}/></button><h2>{title}</h2><button type="button" className="icon-button" disabled={busy} aria-label={closeLabel} onClick={close}><X size={20}/></button></header>
    <div ref={body} className="settings-dialog-body">{children}</div>
  </dialog>;
}

export function PreferencesPanel({ connection, preferences, update, close, forget, manageNetwork, manageConnections, openWorkbenchFile, returnFocus, initialSection = "general", backLabel, initialPairingStep, singleSection = false }: { openWorkbenchFile?: (file: WorkbenchFileTarget) => Promise<void>; initialPairingStep?: 0 | 1; singleSection?: boolean; returnFocus?: RefObject<HTMLElement | null>; initialSection?: Section; backLabel?: string; connection: HubConnection; preferences: Preferences; update: (next: Preferences) => void; close: () => void; forget: () => Promise<void>; manageNetwork?: OpenNetwork; manageConnections?: OpenNetwork }) {
  useLocale(); const hostName = useContext(RuntimeHostContext);
  const state = useSyncExternalStore((notify) => connection.subscribe(notify), () => connection.state);
  const intentionalClose = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null), content = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), header = useRef<HTMLElement>(null);
  useDialogDrag(dialog, header, true);
  const phone = useSyncExternalStore(subscribePhone, phoneLayout);
  const [section, setSection] = useState<Section>(initialSection), [overview, setOverview] = useState(initialSection === "general");
  const [connectionOpen, setConnectionOpen] = useState(false);
  useSceneMotion(dialog, `${overview}:${section}`, phone, overview ? -1 : 1, overview ? ".settings-navigation" : ".settings-content");
  // A category opened directly (Devices from the phone home) is the first phone page:
  // its Back returns to where it was opened, not to categories never shown.
  const [direct, setDirect] = useState(initialSection !== "general");
  const [confirmationKey, setConfirmationKey] = useState(0);
  // `hosts`: the discard was requested by opening host management, which follows it.
  const [confirmation, setConfirmation] = useState<{ kind: "discard"; next?: "hosts" | "navigate" } | { kind: "forget" } | { kind: "revoke"; device: Device }>();
  const pendingNavigation = useRef<(() => void) | undefined>(undefined);
  const [notificationDirty, setNotificationDirty] = useState(false), [notificationBusy, setNotificationBusy] = useState(false);
  const [backupDirty, setBackupDirty] = useState(false), [backupBusy, setBackupBusy] = useState(false);
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [voiceDirty, setVoiceDirty] = useState(false), [voiceBusy, setVoiceBusy] = useState(false);
  const [messageGrantsDirty, setMessageGrantsDirty] = useState(false), [messageGrantsBusy, setMessageGrantsBusy] = useState(false);
  const [deviceDrafts, setDeviceDrafts] = useState<Record<string, boolean>>({});
  const deviceDirty = Object.values(deviceDrafts).some(Boolean);
  const deviceDraftChange = useCallback((id: string, value: boolean) => setDeviceDrafts(previous => previous[id] === value ? previous : { ...previous, [id]: value }), []);
  const dirty = notificationDirty || deviceDirty || messageGrantsDirty || voiceDirty || backupDirty, settingsBusy = libraryBusy || notificationBusy || messageGrantsBusy || voiceBusy || widgetBusy || backupBusy;
  const [scan, setScan] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]), [code, setCode] = useState("");
  const [selectedDevice, setSelectedDevice] = useState<string>(), [discardDeviceDraft, setDiscardDeviceDraft] = useState(false);
  const [dismissedNames, setDismissedNames] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Feedback>(), [busy, setBusy] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [pending, setPending] = useState<{ area: Feedback["area"]; operation: Operation }>();
  const online = state.status === "online";
  const deviceRequest = useRef(0), deviceScope = useRef(0), deviceMounted = useRef(false), busyRef = useRef(false);
  const [devicesLoading, setDevicesLoading] = useState(false), [devicesLoaded, setDevicesLoaded] = useState(false), [devicesReadError, setDevicesReadError] = useState(false);
  // Pairing flow. `added` outlives the flow so the approved device stays marked;
  // `reveal` lands on it once, after the flow closes and the list contains it.
  const [wizard, setWizard] = useState(initialPairingStep !== undefined), [step, setStep] = useState<number>(initialPairingStep ?? 0), [approvedHere, setApprovedHere] = useState(false), [added, setAdded] = useState<string>();
  const addButton = useRef<HTMLButtonElement>(null), stepHeading = useRef<HTMLHeadingElement>(null), deviceList = useRef<HTMLDivElement>(null), reveal = useRef(false);
  const locale = preferences.locale === "en" ? "en" : "zh-CN";

  const sections = [
    { id: "general" as const, title: t("通用"), detail: t("语言、外观与个人头像"), icon: Settings2 },
    { id: "network" as const, title: t("网络与连接"), detail: t("连接线路、VPS 与主机组网"), icon: Globe },
    { id: "workbench" as const, title: t("工作台文件"), detail: t("集中管理白板、笔记与设计"), icon: FolderOpen },
    { id: "backups" as const, title: t("数据与备份"), detail: t("自动备份、保留天数与空间占用"), icon: Database },
    { id: "voice" as const, title: t("语音转写"), detail: t("本地语音与通义长录音转写"), icon: AudioLines },
    { id: "notifications" as const, title: t("通知"), detail: t("此设备的提醒与勿扰时段"), icon: Bell },
    { id: "devices" as const, title: t("设备与安全"), detail: t("查看设备、修改名称与撤销授权"), icon: ShieldCheck },
    { id: "botMessages" as const, title: t("Bot 消息授权"), detail: t("管理本机与跨主机 Bot 的直接消息权限"), icon: Link },
  ];
  const requestClose = () => {
    if (settingsBusy || busy) return;
    if (dirty) { setConfirmation({ kind: "discard" }); return; }
    close();
  };
  // Browsing a child page keeps this draft. Only leaving the settings context
  // (for example, to pair a host) invokes this guard.
  const guardNetworkNavigation = (navigate: () => void) => {
    if (dirty) { pendingNavigation.current = navigate; setConfirmation({ kind: "discard", next: "navigate" }); }
    else { close(); navigate(); }
  };
  const openHosts = (details = false) => {
    if (settingsBusy || busy) return;
    // This opens a child page; settings and unsaved drafts stay mounted.
    if (manageNetwork) {
      manageNetwork(guardNetworkNavigation, connection.identity.hubPublicKey, { details });
      return;
    }
    if (dirty) { setConfirmation({ kind: "discard", next: "hosts" }); return; }
    close(); void forget();
  };
  // Phones show one level at a time, titled in the header. The header button,
  // native Back and Escape all go up one level; only leaving settings asks
  // about unsaved settings. Desktop keeps its sidebar and closes from any page.
  const page = phone && !overview, upToCategories = page && !direct;
  const pageTitle = sections.find(({ id }) => id === section)?.title;
  const goBack = () => {
    if (settingsBusy || busy) return;
    if (upToCategories) setOverview(true);
    else requestClose();
  };
  useBackAction(dialog, goBack);
  useEffect(() => {
    if (initialPairingStep !== undefined) return;
    const before = document.activeElement as HTMLElement | null, node = dialog.current;
    // The phone home unmounts when rotating to desktop. Resolve its equivalent
    // entry again on exit, scoped to this workspace and independent of locale.
    const scope = before?.closest(".app-shell"), entry = before?.dataset.settingsEntry;
    intentionalClose.current = false; node?.showModal();
    // Not autoFocus: crossing the phone breakpoint swaps this button and must not steal focus.
    node?.querySelector<HTMLElement>(".preferences-header button")?.focus();
    return () => {
      intentionalClose.current = true; node?.close();
      const visible = (element: HTMLElement | null | undefined) => !!element?.isConnected && !!element.getClientRects().length && !element.closest("[hidden],[inert]");
      const preferred = returnFocus?.current ?? before;
      const replacement = entry ? [...scope?.querySelectorAll<HTMLElement>("[data-settings-entry]") ?? []].find(element => element.dataset.settingsEntry === entry && visible(element)) : undefined;
      (visible(preferred) ? preferred : replacement)?.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0; }, [section, overview]);
  // Reads can finish out of order across retries, reconnects and acknowledged
  // writes. Only the latest read in the mounted connection may replace the list.
  const load = useCallback(async () => {
    if (!deviceMounted.current || connection.state.status !== "online" || connection.state.user?.role !== "owner") return;
    const request = ++deviceRequest.current;
    setDevicesLoading(true);
    try {
      const next = await connection.http<Device[]>("/api/devices", { signal: timeoutSignal(20_000) });
      if (deviceMounted.current && request === deviceRequest.current) { setDevices(next); setDevicesLoaded(true); setDevicesReadError(false); }
    } catch {
      if (deviceMounted.current && request === deviceRequest.current) setDevicesReadError(true);
    } finally {
      if (deviceMounted.current && request === deviceRequest.current) setDevicesLoading(false);
    }
  }, [connection]);
  useLayoutEffect(() => {
    deviceMounted.current = true; ++deviceScope.current;
    return () => { deviceMounted.current = false; ++deviceScope.current; ++deviceRequest.current; };
  }, [connection]);
  useEffect(() => {
    if (online) void load();
    else { ++deviceRequest.current; setDevicesLoading(false); }
  // Read after an acknowledged directory revision, not on every token/event.
  // Device-name drafts stay separate, so a remote rename cannot erase typing.
  }, [load, online, state.user?.role, state.network?.membership?.manifest.id, state.network?.membership?.manifest.revision]);
  // `unknown` replaces the generic message when no definite answer arrived, so
  // a flow can explain how to verify its own write instead of retrying it.
  const act = async <T,>({ area, operation, action, success, accepted, inlineError = false, unknown }: { area: Feedback["area"]; operation: Operation; action: () => Promise<T>; success?: () => string; accepted?: (result: T) => void; inlineError?: boolean; unknown?: () => string }): Promise<boolean> => {
    if (busyRef.current || connection.state.status !== "online") return false;
    const scope = deviceScope.current;
    busyRef.current = true; setBusy(true); setPending({ area, operation }); setFeedback(undefined);
    try {
      const result = await action();
      if (!deviceMounted.current || scope !== deviceScope.current) return false;
      ++deviceRequest.current;
      accepted?.(result);
      if (success) setFeedback({ area, text: success, operationKind: operation.kind });
      // A failed reread cannot undo the successful write or report it as failed.
      void load();
      return true;
    } catch (e) {
      if (deviceMounted.current && scope === deviceScope.current) {
        // A lost response is not proof that the host rejected the write. Re-read
        // without resubmitting a one-use approval or another mutation.
        ++deviceRequest.current; void load();
        if (inlineError) throw e;
        setFeedback({ area, text: unknown && outcomeUnknown(e) ? unknown : () => deviceOperationError(e), error: true });
      }
      return false;
    } finally {
      if (deviceMounted.current && scope === deviceScope.current) { busyRef.current = false; setBusy(false); setPending(undefined); }
    }
  };
  const progress = (operation: Operation) => operation.kind === "approve"
    ? hostName ? t("正在主机「{0}」上确认配对码 {1} 对应的新设备…", hostName, spacedCode(operation.code)) : t("正在当前主机上确认配对码 {0} 对应的新设备…", spacedCode(operation.code))
    : operation.kind === "revoke" ? t("正在撤销「{0}」的访问授权…", operation.label) : undefined;
  // Progress becomes its result in the same live region; errors remount as alerts.
  const message = (area: Feedback["area"]) => {
    const working = pending?.area === area ? progress(pending.operation) : undefined;
    const shown = working === undefined && feedback?.area === area ? feedback : undefined;
    const text = working ?? (shown ? typeof shown.text === "function" ? shown.text() : shown.text : undefined);
    if (text === undefined) return null;
    const revoked = !phone && !!shown && !shown.error && shown.operationKind === "revoke";
    return <p key={shown?.error ? "error" : "status"} ref={feedbackNode} tabIndex={-1} role={shown?.error ? "alert" : "status"} className={shown?.error ? "error-text" : working ? "settings-feedback settings-progress" : revoked ? "settings-feedback device-revoke-result" : "settings-feedback"}>
      {revoked && <span className="device-revoke-result-mark" aria-hidden="true"><Check size={14}/></span>}
      {revoked ? <span className="device-revoke-result-text">{text}</span> : text}
    </p>;
  };
  const select = (id: Section) => { setSection(id); setOverview(false); setDirect(false); };
  const navigationChanged = useRef(false);
  useLayoutEffect(() => {
    if (!navigationChanged.current) { navigationChanged.current = true; return; }
    // Phone pages are titled in the header; returning to categories focuses the
    // row just left. Desktop pages are titled by their first h3 only: nested
    // sections (app lock, updates) keep their own h3.
    const target = page ? heading.current : overview && phone ? dialog.current?.querySelector<HTMLElement>(`.settings-navigation [data-section="${section}"]`) : content.current?.querySelector<HTMLElement>(":scope > section:not([hidden]) > h3");
    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); if (target.tagName === "BUTTON") target.removeAttribute("tabindex"); }
  }, [overview, section]);
  const feedbackNode = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Disabled submit controls and a removed revoke button can leave keyboard
    // focus on the dialog/body. Give the result a stable, meaningful landing.
    const active = document.activeElement;
    // WebKit returns focus to the nested detail dialog when its revoke button
    // disappears. Only move that empty focus, never a control the user selected.
    if (!busy && feedback && (active === document.body || active === dialog.current || active === feedbackNode.current?.closest("dialog"))) feedbackNode.current?.focus({ preventScroll: true });
  }, [busy, feedback]);
  // Each pairing step announces itself by its heading.
  useLayoutEffect(() => { if (wizard) stepHeading.current?.focus(); }, [wizard, step]);
  useEffect(() => {
    if (wizard || !reveal.current || !added) return;
    const row = [...deviceList.current?.querySelectorAll<HTMLElement>("[data-device-id]") ?? []].find(element => element.dataset.deviceId === added);
    if (!row) return;
    reveal.current = false;
    // Land on the new device only if nothing else was started since the flow closed.
    const active = document.activeElement;
    if (active === document.body || active === dialog.current || active === addButton.current) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); }
  }, [wizard, devices, added]);
  const current = connection.identity.deviceId;
  const localRoutes = connection.identity.routes.some((route) => loopback(route.url));
  const localHostIdentity = useDesktopLocalHost(connection.identity.hubPublicKey);
  const desktopLocalHost = localHostIdentity.localHost;
  const keyTail = connection.identity.hubPublicKey?.slice(-8);
  // Only the host's native enrollment receipt links a device name. Neither
  // being the current client nor claiming a desktop platform proves ownership.
  const namedDevices = devices.map(device => device.nameSource === "host" && state.hostProfile ? { ...device, name: state.hostProfile.name } : device);
  // Same-name devices are told apart by the end of their ID wherever they are named.
  const nameCount = new Map<string, number>();
  for (const device of namedDevices) nameCount.set(nameKey(deviceDisplayName(device)), (nameCount.get(nameKey(deviceDisplayName(device))) ?? 0) + 1);
  const sameName = (device: Device) => (nameCount.get(nameKey(deviceDisplayName(device))) ?? 0) > 1;
  const deviceLabel = (device: Device) => [deviceDisplayName(device), platformName(device.platform), ...(sameName(device) ? [`ID …${idTail(device.id)}`] : [])].join(" · ");
  const currentDevice = namedDevices.find(device => device.id === current);
  const otherDevices = namedDevices.filter(device => !device.revoked && device.id !== current);
  const revokedDevices = namedDevices.filter(device => !!device.revoked && device.id !== current);
  const detailDevice = namedDevices.find(device => device.id === selectedDevice);
  const closeDevice = () => {
    if (busyRef.current) return;
    if (selectedDevice && deviceDrafts[selectedDevice]) setDiscardDeviceDraft(true);
    else setSelectedDevice(undefined);
  };
  const nameHintKey = (device: Device) => `tarobot.device-name-hint:${connection.identity.hubPublicKey}:${device.id}:${device.name}`;
  const nameHintDismissed = (device: Device) => {
    const key = nameHintKey(device);
    try { return dismissedNames[key] || localStorage.getItem(key) === "dismissed"; } catch { return !!dismissedNames[key]; }
  };
  const deviceRow = (d: Device) => {
    const seen = timestamp(d.last_seen), justAdded = d.id === added, isCurrent = d.id === current;
    return <div className={`device-row${d.revoked ? " revoked" : ""}${justAdded ? " just-added" : ""}`} key={d.id} data-device-id={d.id} role="group" aria-label={deviceLabel(d)} tabIndex={justAdded ? -1 : undefined}>
      <PlatformIcon platform={d.platform}/><div><strong className="device-display-name">{deviceDisplayName(d)}</strong>
        <small>{platformName(d.platform)}{isCurrent && <span className="settings-device-tag">{d.revoked ? t("已撤销授权") : online ? t("现在已连接") : state.status === "connecting" ? t("正在连接…") : t("已断开连接")}</span>}{!!d.revoked && !isCurrent && <span className="settings-device-tag" data-tone="muted">{t("已撤销授权")}</span>}{justAdded && <span className="settings-device-tag" data-tone="new">{t("刚刚添加")}</span>}</small>
        <small className="device-meta">{!isCurrent && (seen ? <time dateTime={new Date(seen).toISOString()} title={dateText(seen, locale)}>{t("上次连接 {0}", sinceText(seen, locale))}</time> : <span>{t("暂无连接记录")}</span>)}<span className="device-id">ID …{idTail(d.id)}</span></small>
      </div><button type="button" className="secondary" disabled={busy} onClick={() => { setFeedback(undefined); setSelectedDevice(d.id); }}>{d.revoked ? t("查看记录") : t("管理")}</button>
    </div>;
  };
  const approving = pending?.operation.kind === "approve";
  const pairingSteps = [
    { title: t("让新手机或电脑扫描二维码"), short: t("新设备扫码"), device: t("新设备") },
    { title: t("输入新设备上的 8 位配对码"), short: t("核对并确认"), device: t("此设备") },
    { title: t("新设备自动连接"), short: t("完成连接"), device: t("新设备") },
  ];
  const openWizard = (firstStep = 0) => {
    if (busyRef.current) return;
    // A receipt belongs to the last flow; an unconfirmed result stays until acted on.
    if (feedback?.area === "pair" && !feedback.error) setFeedback(undefined);
    reveal.current = false; setStep(firstStep); setApprovedHere(false); setWizard(true);
  };
  const closeWizard = () => {
    if (busyRef.current || inviteBusy) return;
    reveal.current = approvedHere && !!added; setScan(false); setWizard(false); if (initialPairingStep !== undefined) close();
  };
  const wizardBack = () => {
    if (busyRef.current || inviteBusy) return;
    if (step > 0) setStep(step - 1); else closeWizard();
  };
  const approve = () => {
    const submitted = code;
    if (!online || state.user?.role !== "owner" || !pairingCode.test(submitted)) return;
    void act({
      area: "pair", operation: { kind: "approve", code: submitted },
      action: () => connection.http<{ deviceId?: unknown } | undefined>("/api/devices/approve", { method: "POST", signal: timeoutSignal(20_000), body: JSON.stringify({ code: submitted }) }),
      success: () => hostName ? t("已在主机「{0}」上确认新设备。", hostName) : t("已在当前主机上确认新设备。"),
      accepted: (result) => { const id = result?.deviceId; setCode(""); setAdded(typeof id === "string" && id ? id : undefined); setApprovedHere(true); setStep(2); },
      // The new device shows its connect button from the moment it shows the code,
      // so only an actual connection proves the approval.
      unknown: () => t("没有收到主机的确认结果，授权可能已经生效。请查看新设备是否自动进入聊天；也可以点击「重新检查连接」，无需重新扫码。"),
    });
  };
  const revokeFacts = (device: Device) => {
    const paired = timestamp(device.created_at), seen = timestamp(device.last_seen);
    return <dl className="device-facts">
      <div><dt>{t("配对时间")}</dt><dd>{paired ? dateText(paired, locale) : t("未记录")}</dd></div>
      <div><dt>{t("上次连接")}</dt><dd>{seen ? <time dateTime={new Date(seen).toISOString()} title={dateText(seen, locale)}>{sinceText(seen, locale)}</time> : t("暂无连接记录")}</dd></div>
      <div><dt>{t("设备 ID")}</dt><dd><code>…{idTail(device.id)}</code></dd></div>
    </dl>;
  };
  return <>{initialPairingStep === undefined && <dialog ref={dialog} className={`preferences-dialog is-movable ${overview ? "settings-overview" : "settings-detail"}${singleSection ? " preferences-single-section" : ""}`} aria-label={backLabel && !overview ? pageTitle : t("设置")} onClose={(event) => {
    if (event.target !== event.currentTarget || intentionalClose.current || event.currentTarget.open) return;
    if (dirty || settingsBusy || busy) {
      event.currentTarget.showModal();
      if (dirty && !settingsBusy && !busy) { setConfirmationKey((value) => value + 1); setConfirmation({ kind: "discard" }); }
    } else close();
  }} onCancel={(event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault(); if (scan) setScan(false); else goBack();
  }}>
    {/* Keep one button mounted across rotation; CSS places desktop Close last. */}
    <header ref={header} className="preferences-header"><button className={`icon-button${phone ? " settings-back" : ""}`} aria-label={upToCategories ? t("返回设置分类") : backLabel ?? t("关闭设置")} disabled={busy || settingsBusy} onClick={goBack}>{phone || backLabel ? <ChevronLeft size={24}/> : <X size={20}/>}</button><h2 ref={heading}>{page || backLabel && !overview ? pageTitle : t("设置")}</h2></header>
    <div className="preferences-body">
      {!singleSection && <nav className="settings-navigation" aria-label={t("设置分类")}>
        {sections.map(({ id, title, detail, icon: Icon }) => <button key={id} type="button" data-section={id} disabled={busy || settingsBusy} aria-current={!phone && section === id ? "page" : undefined} onClick={() => select(id)}><Icon size={20}/><span><strong>{title}</strong><small>{detail}</small></span>{((id === "notifications" && notificationDirty) || (id === "devices" && deviceDirty) || (id === "botMessages" && messageGrantsDirty) || (id === "voice" && voiceDirty) || (id === "backups" && backupDirty)) && <span role="img" className="settings-unsaved-dot" aria-label={t("有未保存的修改")}/>}<ChevronRight className="settings-chevron" size={17}/></button>)}
      </nav>}
      <div ref={content} className="settings-content">
        <section hidden={section !== "network"} aria-label={t("网络与连接")} className="network-settings">
          <h3>{t("网络与连接")}</h3>
          <p className="settings-lede">{t("添加手机或电脑，管理设备所属网络，或查看当前连接状态。")}</p>
          <div className="network-settings-current">
            <span className="network-settings-host-icon"><Monitor size={20} aria-hidden="true"/></span>
            <div><small>{t("当前主机")}</small><strong>{hostName || state.hostProfile?.name || t("当前连接的主机")}</strong></div>
            <span className="network-settings-status" data-online={online}><i aria-hidden="true"/>{online ? t("已连接") : state.status === "connecting" ? t("连接中…") : t("离线")}</span>
          </div>
          <div className="network-settings-options">
            <button type="button" className="network-settings-option" disabled={busy || !online || state.user?.role !== "owner"} onClick={() => openWizard()}><QrCode size={20}/><span><strong>{t("添加设备")}</strong><small>{t("手机、平板或电脑 · 显示连接二维码")}</small></span><ChevronRight size={17}/></button>
            <button type="button" className="network-settings-option" onClick={event => { event.currentTarget.focus({ preventScroll: true }); setConnectionOpen(true); }}>
              <Link size={20} aria-hidden="true"/><span><strong>{t("连接状态与线路")}</strong><small>{desktopLocalHost ? t("本机的局域网、Tailscale 和 VPS 中转") : t("此设备访问当前主机的直连和 VPS 中转")}</small></span><ChevronRight size={17} aria-hidden="true"/>
            </button>
            {manageNetwork && <button type="button" className="network-settings-option" onClick={event => { event.currentTarget.focus({ preventScroll: true }); openHosts(); }}>
              <Globe size={20} aria-hidden="true"/><span><strong>{t("设备与网络")}</strong><small>{t("添加手机或电脑、管理设备与主机组网")}</small></span><ChevronRight size={17} aria-hidden="true"/>
            </button>}
            <button type="button" className="network-settings-option" onClick={event => { event.currentTarget.focus({ preventScroll: true }); manageConnections?.(guardNetworkNavigation); }} disabled={!manageConnections}>
              <Monitor size={20} aria-hidden="true"/><span><strong>{t("此设备的连接")}</strong><small>{t("查看已保存的主机、改名或移除本地连接")}</small></span><ChevronRight size={17} aria-hidden="true"/>
            </button>
          </div>
          <details className="network-settings-help"><summary>{t("第一次连接，应该从哪里开始？")}</summary><p>{t("新手机或电脑：点击「添加设备」展示二维码，让新设备扫码，再输入新设备上的 8 位配对码确认。")}</p><p>{t("外出时需要访问主机：到「连接状态与线路」配置可用的 VPS 中转或 Tailscale。填写地址不会自动部署服务器和隧道。")}</p></details>
        </section>
        <section hidden={section !== "workbench"} aria-label={t("工作台文件")}><h3>{t("工作台文件")}</h3><WorkbenchLibrary connection={connection} active={section === "workbench" && (!phone || !overview)} onBusy={setLibraryBusy} onOpened={close} openLocalFile={openWorkbenchFile}/></section>
        <section hidden={section !== "backups"} aria-label={t("数据与备份")}><h3>{t("数据与备份")}</h3><BackupSettings key={connection.identity.hubPublicKey} connection={connection} active={section === "backups" && (!phone || !overview)} onDirty={setBackupDirty} onBusy={setBackupBusy}/></section>
        <section hidden={section !== "voice"} aria-label={t("语音转写")}><h3>{t("语音转写")}</h3><VoiceSettings key={connection.identity.hubPublicKey} connection={connection} active={section === "voice" && (!phone || !overview)} onDirty={setVoiceDirty} onBusy={setVoiceBusy}/></section>
        <section hidden={section !== "botMessages"} aria-label={t("Bot 消息授权")}>
          <h3>{t("Bot 消息授权")}</h3>
          {hostName && <p className="device-host-scope">{t("管理主机：{0}", hostName)}</p>}
          <BotMessageGrants key={connection.identity.hubPublicKey} connection={connection} active={section === "botMessages" && (!phone || !overview)} online={online} onDirty={setMessageGrantsDirty} onBusy={setMessageGrantsBusy}/>
        </section>
        <section hidden={section !== "general"} aria-label={t("通用")}>
          <h3>{t("通用")}</h3>
          <p className="settings-lede">{t("语言和外观只改变此设备；个人资料会同步到你的其他设备。")}</p>
          <div className="settings-group">
            <div className="settings-row">
              <div className="settings-row-text"><label htmlFor="language">{t("语言")}</label><small id="language-scope">{t("应用界面文字")}</small></div>
              <select id="language" aria-describedby="language-scope language-note" value={preferences.locale} onChange={(e) => update({ ...preferences, locale: e.target.value as Preferences["locale"] })}><option value="zh" lang="zh-CN">中文</option><option value="en" lang="en">English</option></select>
            </div>
          </div>
          <p id="language-note" className="settings-note muted">{t("切换后立即生效，草稿和当前页面都会保留。只翻译应用界面，Bot 回复和你写的内容保持原文。")}</p>
          {state.user && <><SettingsGroupHeading scope="synced">{t("个人资料")}</SettingsGroupHeading><PersonalAvatarEditor/><p className="settings-note muted">{hostName ? t("头像保存在主机「{0}」上，连接这台主机的其他设备会显示同一头像。", hostName) : t("头像保存在主机上，你的其他已配对设备会显示同一头像。")}</p></>}
          <WidgetSettings key={connection.identity.hubPublicKey} connection={connection} active={section === "general" && (!phone || !overview)} onBusy={setWidgetBusy}/>
          <GoogleDocsSettings key={`gdocs:${connection.identity.hubPublicKey}`} connection={connection} phone={phone}/>
          <SettingsGroupHeading scope="device">{t("消息")}</SettingsGroupHeading>
          <div className="settings-group">
            <div className="settings-row"><label htmlFor="link-preview-style">{t("链接预览样式")}</label><select id="link-preview-style" aria-describedby="link-preview-style-note link-preview-style-scope" value={preferences.linkPreviewStyle} onChange={event => update({ ...preferences, linkPreviewStyle: event.target.value as Preferences["linkPreviewStyle"] })}><option value="card">{t("卡片（默认）")}</option><option value="inline">{t("标题")}</option></select></div>
          </div>
          <p id="link-preview-style-note" className="settings-note muted">{t("卡片显示标题、摘要和封面（网页提供时）；标题仅显示标题和域名。")}</p>
          <p id="link-preview-style-scope" className="settings-note muted">{t("用于此设备新发送的链接，已发送消息保持原样。")}</p>
          {state.dispatchAvailable && <><div className="settings-group"><div className="settings-row"><span id="ticket-conversations-setting">{t("在列表里显示工单对话")}</span><button type="button" className="model-brand-toggle" role="switch" aria-labelledby="ticket-conversations-setting" aria-describedby="ticket-conversations-note" aria-checked={preferences.showTicketConversations === true} onClick={() => update({ ...preferences, showTicketConversations: preferences.showTicketConversations !== true })}><span className="model-brand-toggle-track" aria-hidden="true"/></button></div></div>
          <p id="ticket-conversations-note" className="settings-note muted">{t("调试用：显示幕僚长派活时开的内部对话。")}</p></>}
          <SettingsGroupHeading scope="device">{t("外观")}</SettingsGroupHeading>
          <div className="settings-group">
            {preferences.palette === "cli" ? <div className="settings-row"><span>{t("主题")}</span><span>{t("深色")}</span></div> : <div className="settings-row"><label htmlFor="theme">{t("主题")}</label><select id="theme" value={preferences.theme} onChange={(e) => update({ ...preferences, theme: e.target.value as Preferences["theme"] })}><option value="system">{t("跟随系统")}</option><option value="light">{t("浅色")}</option><option value="dark">{t("深色")}</option></select></div>}
            <FontSizeSlider value={preferences.fontSize} onChange={fontSize => update({ ...preferences, fontSize })}/>
            <div className="settings-font-preview" aria-hidden="true"><b>Aa</b><span>{t("当前字号下的示例文字")}</span></div>
            <div className="settings-row"><span id="model-brand-setting">{t("显示模型图标")}</span><button type="button" className="model-brand-toggle" role="switch" aria-labelledby="model-brand-setting" aria-checked={preferences.showModelIcons !== false} onClick={() => update({ ...preferences, showModelIcons: preferences.showModelIcons === false })}><span className="model-brand-toggle-track" aria-hidden="true"/></button></div>
            <div className="settings-row"><span id="animated-avatars-setting">{t("动态头像")}</span><button type="button" className="model-brand-toggle" role="switch" aria-labelledby="animated-avatars-setting" aria-describedby="animated-avatars-note" aria-checked={preferences.animatedAvatars !== false} onClick={() => update({ ...preferences, animatedAvatars: preferences.animatedAvatars === false })}><span className="model-brand-toggle-track" aria-hidden="true"/></button></div>
          </div>
          <p id="animated-avatars-note" className="settings-note muted">{t("让列表头像随 Bot 状态变化。关闭后头像静止，状态提示仍保留，仅影响此设备。")}</p>
          <LayoutDensityPicker value={preferences.layoutDensity} onChange={layoutDensity => update({ ...preferences, layoutDensity })}/>
          <fieldset className="palette-picker">
            <legend>{t("配色风格")}</legend>
            <p className="settings-note muted">{t("终端 CLI 固定使用深色；其他风格支持浅色、深色和跟随系统。")}</p>
            {(["expressive", "white", "classic"] as const).map(family => <div key={family} className="palette-family">
              <h4>{family === "expressive" ? t("特色主题") : family === "white" ? t("纯白底") : t("经典配色")}</h4>
              <div className="palette-options">
              {colorPalettes.filter(palette => palette.family === family).map((palette) => <label key={palette.id} className="palette-option">
                <input type="radio" name="color-palette" value={palette.id} checked={preferences.palette === palette.id} onChange={() => update({ ...preferences, palette: palette.id })}/>
                <span className="palette-card">
                  {palette.family === "expressive" ? <ExpressivePreview id={palette.id}/> : <span className="palette-preview" data-palette={palette.id} aria-hidden="true"><span className="palette-preview-sidebar"><i/><i/><i/></span><span className="palette-preview-chat"><i className="palette-preview-bot"/><i className="palette-preview-self"/><i className="palette-preview-compose"><b/></i></span></span>}
                  <span className="palette-name">{t(palette.name)}</span><span className="palette-description">{t(palette.description)}</span>
                </span>
              </label>)}
              </div>
              {family === "white" && preferences.palette === "mono" && <div className="mono-accent" role="radiogroup" aria-labelledby="mono-accent-label" aria-describedby="mono-accent-note">
                <div className="settings-row-text"><span id="mono-accent-label">{t("黑白点缀色")}</span><small id="mono-accent-note">{t("默认使用浅暖灰，点缀回复标记、运行提示、图表和浅色模式的实心控件。")}</small></div>
                <div className="mono-accent-options">{monoAccents.map(accent => <label key={accent.id} className="mono-accent-option">
                  <input type="radio" name="mono-accent" value={accent.id} checked={(preferences.monoAccent ?? DEFAULT_MONO_ACCENT) === accent.id} onChange={() => update({ ...preferences, monoAccent: accent.id })}/>
                  <span className="mono-accent-swatch" data-accent={accent.id} aria-hidden="true" style={accent.color ? { "--swatch": accent.color } as React.CSSProperties : undefined}/>
                  <span className="mono-accent-name">{t(accent.name)}</span>
                </label>)}</div>
              </div>}
            </div>)}
          </fieldset>
          <DesktopPreferences/><DesktopUpdates/><AndroidUpdates/>
        </section>
        <section hidden={section !== "notifications"} aria-label={t("通知")}><NotificationSettings connection={connection} dirtyChange={setNotificationDirty} busyChange={setNotificationBusy}/></section>
        <section hidden={section !== "devices"} aria-label={t("设备与安全")}>
          <h3>{t("设备与安全")}</h3>
          <p className="device-host-scope">{hostName ? t("管理主机：{0}", hostName) : t("管理当前连接主机的设备")}</p><p className="settings-lede">{t("查看和管理获准访问此主机的设备。主机的组网关系在「设备与网络」中管理。")}</p>
          {online && state.user && state.user.role !== "owner" && <p role="status" className="settings-note">{t("此设备没有管理权限，请用已授权的管理设备添加或确认新设备。")}</p>}
          {!online && !detailDevice && <p role="status" className="settings-offline">{t("连接恢复后即可操作")}</p>}
          {!wizard && section === "devices" && online && <PendingPairings connection={connection} confirm={() => openWizard(1)}/>}
          <div className="device-approval-actions"><button ref={addButton} type="button" className="primary" disabled={busy || !online || state.user?.role !== "owner"} onClick={() => openWizard()}><QrCode size={18}/>{t("添加设备")}</button><button type="button" className="secondary" disabled={busy || !online || state.user?.role !== "owner"} onClick={() => openWizard(1)}><ShieldCheck size={16}/>{t("输入配对码确认")}</button></div>
          <div className="settings-device-heading"><SettingsGroupHeading>{t("访问设备")}</SettingsGroupHeading><button type="button" className="secondary" disabled={!online || busy} aria-disabled={devicesLoading} onClick={() => { if (!devicesLoading) void load(); }}>{devicesLoading ? t("正在刷新…") : t("刷新设备列表")}</button></div>
          {!devicesLoaded && !devicesReadError && state.user?.role === "owner" && <p role="status" className="settings-note muted">{online ? t("正在读取设备列表…") : t("连接恢复后可查看已授权设备。")}</p>}
          {devicesReadError && state.user?.role === "owner" && !detailDevice && <p role="alert" className="settings-warning">{devicesLoaded ? t("设备列表未能刷新，已完成的操作仍然有效。") : t("暂时无法读取设备列表，请重试。")}</p>}
          <div ref={deviceList}>
            {currentDevice && <section className="device-section" aria-label={t("你正在使用")}><SettingsGroupHeading>{t("你正在使用")}</SettingsGroupHeading><div className="settings-group settings-devices">{deviceRow(currentDevice)}</div></section>}
            <section className="device-section" aria-label={t("其他可访问设备")}><SettingsGroupHeading>{t("其他可访问设备")} <span className="muted">{otherDevices.length}</span></SettingsGroupHeading>
              {otherDevices.length ? <div className="settings-group settings-devices">{otherDevices.map(deviceRow)}</div> : devicesLoaded && <p className="settings-note muted">{t("暂无其他已授权设备。")}</p>}
            </section>
            <p className="settings-note muted">{t("分不清是哪台？在那台设备上打开此页，「你正在使用」就是它。其他设备的上次连接时间不代表当前在线。")}</p>
            {!!revokedDevices.length && <details className="device-revoked"><summary>{t("已撤销记录")} <span>{revokedDevices.length}</span></summary><p className="settings-note muted">{t("这些授权已失效，记录保留以供核对。")}</p><div className="settings-group settings-devices">{revokedDevices.map(deviceRow)}</div></details>}
          </div>
          {!detailDevice && message("devices")}
          {!wizard && message("pair")}
          <MobileLockSettings/>
          {!hostName && <div className="settings-danger">
            <h4>{t("危险操作")}</h4>
            <div className="settings-danger-row">
              <div><strong>{t("断开此设备")}</strong><p className="muted">{t("清除此设备上的缓存、草稿和未发送消息，然后回到配对页。主机上的历史消息会保留；此设备的授权不会自动撤销，可在其他已授权设备上撤销。")}</p></div>
              <button className="text-danger" disabled={busy || settingsBusy} onClick={() => setConfirmation({ kind: "forget" })}>{t("断开并重新配对")}</button>
            </div>
            {message("danger")}
          </div>}
        </section>
      </div>
    </div>
    {connectionOpen && <ConnectionPanel connection={connection} close={() => setConnectionOpen(false)} backLabel={t("返回网络与连接")}/>}
    {detailDevice && <CreationDialog mobilePage title={t("管理设备")} close={closeDevice} closeLabel={t("返回设备列表")} busy={busy} back={phone} showHost={false} className="device-detail">
      {!online && <p role="status" className="settings-offline">{t("连接恢复后即可操作")}</p>}
      {devicesReadError && <p role="alert" className="settings-warning">{t("设备列表未能刷新，已完成的操作仍然有效。")}</p>}
      <div className="device-detail-heading"><PlatformIcon platform={detailDevice.platform}/><div><strong>{deviceDisplayName(detailDevice)}</strong><p className="muted">{platformName(detailDevice.platform)}{detailDevice.id === current && ` · ${t("你正在使用")}`}</p></div></div>
      {revokeFacts(detailDevice)}
      {!!detailDevice.revoked ? <p className="settings-note muted">{t("已撤销授权")}</p> : <>
        {detailDevice.nameSource === "host" ? <><p className="settings-note muted">{t("这台电脑运行当前主机，名称与主机保持一致，无需单独改名。")}</p>{!singleSection && <button type="button" disabled={busy || settingsBusy} onClick={() => openHosts(true)}>{t("修改主机名称")}</button>}</> : <>
        <p className="settings-note muted">{t("此名称用于在当前主机的设备列表中辨认设备，不会修改主机名称。")}</p>
        {ambiguousDeviceName(detailDevice.name) && !nameHintDismissed(detailDevice) && <div className="device-name-hint"><p>{t("这个旧名称在不同设备上容易混淆，建议改成你认得出的名字，例如 MacBook Pro 或 vivo 手机。")}</p><button type="button" onClick={() => { const key = nameHintKey(detailDevice); try { localStorage.setItem(key, "dismissed"); } catch {} setDismissedNames(old => ({ ...old, [key]: true })); }}>{t("不再提示")}</button></div>}
        <DeviceName label={t("修改设备名称")} id={detailDevice.id} name={deviceDisplayName(detailDevice)} disabled={busy || !online} dirtyChange={deviceDraftChange} rename={async (deviceId, name) => {
          const saved = await act({ area: "devices", operation: { kind: "rename" }, action: () => connection.http("/api/devices/rename", { method: "PATCH", signal: timeoutSignal(20_000), body: JSON.stringify({ deviceId, name }) }), success: () => t("设备名称已更新"), accepted: () => setDevices(previous => previous.map(device => device.id === deviceId ? { ...device, name } : device)), inlineError: true });
          if (!saved) throw new Error(t("重命名失败"));
        }}/></>}
        {detailDevice.id === current ? <p className="settings-note muted">{hostName ? t("这是当前使用的设备。移除已保存的连接，请到「网络与连接 → 此设备的连接」操作。") : t("这是当前使用的设备。如需断开，请返回设备列表底部操作。")}</p> : <div className="device-revoke-action"><p>{deviceRevokeScope(state.network, connection.identity.hubPublicKey, detailDevice.id)}</p><p className="muted">{t("撤销设备访问不会让电脑退出组网，也不会删除 Bot。主机退出网络请到「设备与网络」操作。")}</p><button type="button" className="text-danger" disabled={busy || !online || !!deviceDrafts[detailDevice.id]} onClick={() => { if (!busyRef.current) setConfirmation({ kind: "revoke", device: detailDevice }); }}>{pending?.operation.kind === "revoke" ? t("正在撤销…") : t("撤销授权")}</button></div>}
      </>}
      {message("devices")}
    </CreationDialog>}
    {discardDeviceDraft && <CreationDialog title={t("放弃设备名称修改？")} close={() => setDiscardDeviceDraft(false)} showHost={false} closeLabel={t("关闭确认")}><p>{t("设备名称尚未保存，返回列表会放弃这次修改。")}</p><div className="quick-actions"><button onClick={() => setDiscardDeviceDraft(false)}>{t("继续编辑")}</button><button onClick={() => { setDiscardDeviceDraft(false); setSelectedDevice(undefined); }}>{t("放弃修改")}</button></div></CreationDialog>}
    {confirmation && <CreationDialog key={confirmationKey} title={confirmation.kind === "discard" ? t("放弃未保存的修改？") : confirmation.kind === "revoke" ? t("撤销设备授权？") : t("断开并重新配对？")} close={() => setConfirmation(undefined)} closeLabel={t("关闭确认")}>
      {confirmation.kind === "revoke" && <><p><strong>{deviceLabel(confirmation.device)}</strong></p>{revokeFacts(confirmation.device)}<p>{deviceRevokeScope(state.network, connection.identity.hubPublicKey, confirmation.device.id)}</p><p className="muted">{t("撤销设备访问不会让电脑退出组网，也不会删除 Bot。主机退出网络请到「设备与网络」操作。")}</p></>}
      <p className="muted">{confirmation.kind === "discard" ? confirmation.next === "hosts" ? t("设置修改尚未保存。放弃这些修改并打开主机管理？") : confirmation.next === "navigate" ? t("设置修改尚未保存。放弃这些修改并继续？") : t("设置修改尚未保存。放弃这些修改并关闭设置？") : confirmation.kind === "revoke" ? t("该设备上已缓存的历史消息和完整文件会保留。不确定是哪台设备时，请先取消并到那台设备上核对。") : t("将清除此设备上的缓存、草稿和未发送消息，并回到配对页。主机上的历史消息会保留，此设备的授权不会自动撤销。")}</p>
      <div className="quick-actions"><button onClick={() => { setConfirmation(undefined); if (confirmation.kind === "discard") { if (notificationDirty) select("notifications"); else if (deviceDirty) select("devices"); else if (messageGrantsDirty) select("botMessages"); else if (voiceDirty) select("voice"); else if (backupDirty) select("backups"); } }}>{confirmation.kind === "discard" ? t("继续编辑") : t("取消")}</button><button className="text-danger" disabled={busy || (confirmation.kind === "revoke" && !online)} onClick={() => {
        const action = confirmation; setConfirmation(undefined);
        if (action.kind === "discard") { close(); if (action.next === "hosts") void forget(); else if (action.next === "navigate") { const navigate = pendingNavigation.current; pendingNavigation.current = undefined; navigate?.(); } }
        else if (action.kind === "revoke") {
          const target = action.device, label = deviceLabel(target);
          void act({ area: "devices", operation: { kind: "revoke", id: target.id, label }, action: () => connection.http("/api/devices/revoke", { method: "POST", signal: timeoutSignal(20_000), body: JSON.stringify({ deviceId: target.id }) }), success: () => t("已撤销「{0}」的授权", label), accepted: () => setDevices(previous => previous.map(device => device.id === target.id ? { ...device, revoked: 1 } : device)) });
        }
        else { setBusy(true); void forget().catch((e: unknown) => { setBusy(false); setFeedback({ area: "danger", text: String(e), error: true }); }).finally(() => setBusy(false)); }
      }}>{confirmation.kind === "discard" ? t("放弃修改") : confirmation.kind === "revoke" ? t("撤销授权") : t("确认断开")}</button></div>
    </CreationDialog>}
  </dialog>}
    {wizard && <FlowDialog title={t("添加设备")} closeLabel={t("关闭添加设备")} busy={busy || inviteBusy} back={wizardBack} close={closeWizard} returnFocus={addButton} className="pairing-wizard">
      <ol className="pairing-progress" aria-label={t("配对步骤")}>{pairingSteps.map((item, index) => <li key={index} aria-current={index === step ? "step" : undefined} data-state={index < step ? "done" : index === step ? "current" : "next"}>
        <span className="pairing-progress-mark" aria-hidden="true">{index < step ? <Check size={13}/> : index + 1}</span>
        <span className="pairing-progress-text">{item.short}<small>{item.device}</small></span>
      </li>)}</ol>
      <div className="pairing-step">
        <div className="pairing-step-heading">
          <h3 ref={stepHeading} tabIndex={-1}>{pairingSteps[step]?.title}</h3>
          <span className="pairing-device-chip" data-device={step === 1 ? "this" : "new"}>{step === 1 ? t("在此设备上操作") : t("在新设备上操作")}</span>
        </div>
        <p className="pairing-host"><SettingsScope kind="host" host={hostName}/>{keyTail && <span>{t("身份公钥尾号 {0}", keyTail)}</span>}</p>
        {step < 2 && online && <PendingPairings connection={connection} confirm={step === 0 && !inviteBusy ? () => setStep(1) : undefined}/>}
        <div hidden={step !== 0}>
          <p className="pairing-instruction">{t("在新手机、平板或电脑打开 TaroBird，选择「扫描连接二维码」。")}</p>
          {localRoutes && localHostIdentity.resolved && !desktopLocalHost && <p className="settings-warning">{t("已保存的线路中有本机地址（如 127.0.0.1、localhost），只有这台设备能用，新设备无法通过它连接。")}</p>}
          {connection.identity.hubPublicKey ? <div className="settings-invite">
            {!localHostIdentity.resolved ? <p role="status">{t("正在确认本机身份，暂不修改连接线路。")}{localHostIdentity.failed && <button onClick={localHostIdentity.retry}>{t("重试")}</button>}</p> : <DeviceInviteCode connection={connection} localHost={desktopLocalHost} busyChange={setInviteBusy}/> }
            <details><summary>{t("主机身份信息")}</summary><input aria-label={t("主机身份公钥")} readOnly value={connection.identity.hubPublicKey} onFocus={(event) => event.currentTarget.select()}/><p className="muted">{t("二维码包含主机地址、身份和 5 分钟有效的邀请；新设备仍需你确认授权。")}</p></details>
          </div> : <p role="alert" className="settings-warning">{t("暂时无法显示此主机的连接信息，请稍后重试。")}</p>}
        </div>
        {step === 1 && <>
          <p className="pairing-instruction">{t("新设备会显示 8 位配对码和对应的二维码，5 分钟内有效，只能使用一次。扫描它，或在下面输入这 8 位数字。")}</p>
          {!online && <p role="status" className="settings-offline">{t("连接恢复后即可操作")}</p>}
          <form className="pair-approve" onSubmit={(event) => { event.preventDefault(); approve(); }}>
            <input required inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={32} disabled={busy || !online} aria-label={t("新设备配对码")} placeholder={t("输入新设备的 8 位配对码")} pattern="[0-9]{8}" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 8))}/>
            <button type="button" className="secondary" disabled={busy || !online} onClick={(event) => { event.currentTarget.focus(); setScan(true); }}><ScanLine size={16}/>{t("扫描新设备配对码")}</button>
            <button className="primary" type="submit" disabled={!approving && (busy || !online || state.user?.role !== "owner" || !pairingCode.test(code))} aria-disabled={approving || undefined}>{approving ? t("正在确认…") : t("确认配对")}</button>
          </form>
          {message("pair")}
          <p className="settings-note muted">{hostName ? t("正在为主机「{0}」授权。新电脑如要带着自己的 Bot 加入网络，连接后还需确认加入；手机确认后即可开始使用。", hostName) : t("正在为当前主机授权。新电脑如要带着自己的 Bot 加入网络，连接后还需确认加入；手机确认后即可开始使用。")}</p>
        </>}
        {step === 2 && <>
          {message("pair")}
          <p className="pairing-instruction">{t("授权已确认。新手机或平板会自动进入聊天，无需再加入主机；若新电脑还要运行自己的 Bot，请在新电脑上继续确认加入网络。")}</p>
          <p className="settings-note muted">{t("之后可在「其他可访问设备」中点「管理」，为它改名或撤销授权。")}</p>
        </>}
      </div>
      <div className="pairing-actions">
        {step > 0 && <button type="button" className="secondary" disabled={busy} onClick={wizardBack}><ChevronLeft size={16}/>{t("上一步")}</button>}
        {step === 0 && <button type="button" className="primary pairing-forward" disabled={busy || inviteBusy} onClick={() => setStep(1)}>{t("已扫码，输入配对码")}<ChevronRight size={16}/></button>}
        {step === 1 && approvedHere && <button type="button" className="secondary pairing-forward" disabled={busy} onClick={() => setStep(2)}>{t("下一步")}<ChevronRight size={16}/></button>}
        {step === 2 && <button type="button" className="primary pairing-forward" onClick={closeWizard}>{t("完成")}</button>}
      </div>
      {scan && <PairingScanner purpose="approve" close={() => setScan(false)} receive={(payload) => {
        if (payload.kind !== "approve") throw new Error(t("这是连接二维码。请扫描新设备上显示的配对码二维码。"));
        if (payload.hubPublicKey !== connection.identity.hubPublicKey) throw new Error(t("这个配对码属于另一台主机，不能在这里确认。"));
        setCode(payload.code); setFeedback({ area: "pair", text: () => t("已读取配对码。核对与新设备上显示的数字一致后，点「确认配对」。") });
      }}/>}
    </FlowDialog>}
  </>;
}
