import { invoke } from "./desktop-bridge.js";
import { listen } from "./desktop-bridge.js";
import { z } from "zod";
import { idSchema } from "../../src/client-protocol/index.js";
import type { PushPayload } from "../../src/client-protocol/push.js";
import type { ListenerScope } from "./listener-scope.js";
import { t } from "./i18n.js";

const targetSchema = z.object({ hostId: z.string().regex(/^hub_[0-9a-f]{64}$/), conversationId: idSchema, messageId: idSchema }).strict();
const actionSchema = z.object({ id: z.uuid(), ageMs: z.number().finite().nonnegative(), target: targetSchema }).strict();
export type DesktopNotificationTarget = z.infer<typeof targetSchema>;
export type DesktopNotificationIntent = { supersededAt: number; routing: boolean; changed?: () => void };
/** Permission recovery is distinct from installation and Host write failures. */
export class DesktopNotificationPermissionError extends Error {}
let supported: Promise<boolean> | undefined;
let lastHandled: string | undefined;
export function desktopNotificationsSupported(): Promise<boolean> {
  return supported ??= invoke<boolean>("desktop_notifications_supported").catch((error) => { supported = undefined; throw error; });
}
export async function desktopNotificationPermission(request: boolean): Promise<"granted" | "prompt" | "denied"> {
  try { return await invoke("desktop_notification_permission", { request }); }
  catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "native_notification_install_required") throw new Error(t("请重新安装 TaroBird，并保留开始菜单快捷方式，才能使用 Windows 通知。"));
    if (code === "native_notification_windows_version") throw new Error(t("桌面通知需要 Windows 10 1703 或更新版本。"));
    if (code === "native_notification_bundle_required") throw new Error(t("请从安装后的 TaroBird 应用中开启系统通知。"));
    if (request && code === "native_notification_timeout") throw new DesktopNotificationPermissionError(t("系统通知授权尚未完成，请检查系统通知设置。"));
    if (request) throw new DesktopNotificationPermissionError(t("无法完成系统通知授权，请检查系统通知设置。"));
    throw new DesktopNotificationPermissionError(t("无法读取系统通知权限，请检查系统设置后重试。"));
  }
}
// Tauri schedules async commands independently. Enforce ordering before IPC:
// a clear must run after earlier show RPCs settle, including a not-yet-polled
// native show. A later send waits for the clear, and other hosts remain free.
const hostOperations = new Map<string, Promise<void>>();
let allHostsBarrier: Promise<void> = Promise.resolve();
function desktopOperation(hostId: string | undefined, action: () => Promise<void>): Promise<void> {
  const previous = hostId ? [allHostsBarrier, hostOperations.get(hostId)] : [allHostsBarrier, ...hostOperations.values()];
  const result = Promise.all(previous.map((promise) => promise?.catch(() => undefined))).then(action);
  if (hostId) {
    hostOperations.set(hostId, result);
    const remove = () => { if (hostOperations.get(hostId) === result) hostOperations.delete(hostId); };
    void result.then(remove, remove);
  } else {
    allHostsBarrier = result;
    const remove = () => { if (allHostsBarrier === result) allHostsBarrier = Promise.resolve(); };
    void result.then(remove, remove);
  }
  return result;
}
let documentContext: Promise<string> | undefined;
const desktopDocument = () => documentContext ??= invoke<string>("desktop_notification_context").catch((error) => { documentContext = undefined; throw error; });
export const showDesktopNotification = (notice: PushPayload, resolve: () => PushPayload | undefined = () => notice) => desktopOperation(notice.hostId, async () => {
  // Each WebView document gets its own cached native generation. A queued old
  // async command cannot become a new submission after the page has reloaded.
  const documentId = await desktopDocument();
  // Capability discovery and earlier native operations can delay this send.
  // Resolve the current consent/preview only after those waits, just before IPC.
  const current = resolve();
  if (current) await invoke<void>("desktop_notification_show", { notice: current, documentId });
});
export const clearDesktopNotifications = (hostId?: string) => desktopOperation(hostId, async () => {
  const documentId = await desktopDocument();
  await invoke<void>("desktop_notification_clear", hostId ? { hostId, documentId } : { documentId });
});

/** Observe immediately, including while the native capability query is pending. */
export function observeDesktopNotificationIntent(supersede: () => void): () => void {
  const interact = (event: Event) => { if (event.isTrusted) supersede(); };
  window.addEventListener("tarocub-navigate", supersede);
  for (const name of ["pointerdown", "keydown", "click"]) window.addEventListener(name, interact, true);
  return () => {
    window.removeEventListener("tarocub-navigate", supersede);
    for (const name of ["pointerdown", "keydown", "click"]) window.removeEventListener(name, interact, true);
  };
}

/** The OS owns a one-item latest-click inbox. Listen before peeking; acknowledge
 * only an accepted/discarded route, not a dispatch with no receiver. Events are
 * wakeups, never a second source of routing payloads. */
export async function listenDesktopNotifications(scope: ListenerScope, active: () => boolean, navigate: (target: DesktopNotificationTarget) => boolean, intent: DesktopNotificationIntent): Promise<() => void> {
  let stopped = false, busy = false, dirty = false, revision = 0, deferred = false, failures = 0, uncertain = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => !stopped && active();
  const retry = () => {
    if (!alive() || timer || failures >= 7) return;
    timer = setTimeout(() => { timer = undefined; wake(false); }, [1_000, 2_000, 5_000, 15_000, 30_000][Math.min(failures++, 4)]!);
  };
  const acknowledge = (id: string) => { void invoke("desktop_notification_ack", { id }).catch(retry); };
  const drain = async () => {
    if (busy || !alive()) return; busy = true;
    try {
      while (alive() && dirty) {
        dirty = false; const version = revision;
        const start = performance.now();
        const value = await invoke<unknown>("desktop_notification_peek");
        const end = performance.now();
        if (!alive()) return;
        // A newer OS wakeup can overtake a previously captured IPC result.
        if (version !== revision) { dirty = true; continue; }
        if (value == null) { deferred = false; continue; }
        const action = actionSchema.parse(value);
        // Rust Instant supplies the click age at IPC serialization. With a
        // monotonic JS clock its time lies in [start-age, end-age]. Wall-clock
        // changes cannot swallow a new click or revive a superseded one.
        let handled = action.id === lastHandled;
        if (!handled && intent.supersededAt >= 0) {
          if (end - action.ageMs < intent.supersededAt) handled = true;
          else if (start - action.ageMs < intent.supersededAt) {
            // A delayed response can straddle the user's input. Take at most
            // three fresh snapshots; if still uncertain, retain without ACK.
            deferred = true; if (++uncertain < 3) dirty = true; continue;
          }
        }
        if (!handled) { intent.routing = true; try { handled = navigate(action.target); } finally { intent.routing = false; } }
        deferred = !handled;
        if (handled) { lastHandled = action.id; acknowledge(action.id); }
      }
    } catch { retry(); } finally { busy = false; }
  };
  const wake = (native: boolean) => {
    if (!alive()) return;
    if (native) { ++revision; failures = 0; uncertain = 0; }
    dirty = true; void drain();
  };
  const ready = () => { if (deferred) wake(false); };
  const supersede = () => { if (alive()) { ++revision; uncertain = 0; if (busy || deferred) wake(false); } };
  intent.changed = supersede;
  // Own DOM cleanup synchronously, even if native listen never settles.
  const stop = scope.listen<Event>((emit) => {
    window.addEventListener("tarocub-navigation-ready", emit);
    return () => {
      stopped = true; clearTimeout(timer);
      if (intent.changed === supersede) intent.changed = undefined;
      window.removeEventListener("tarocub-navigation-ready", emit);
    };
  }, ready);
  try {
    const remove = await listen("tarocub-notification-action", () => wake(true));
    if (!alive()) { stop(); remove(); return () => undefined; }
    wake(false);
    return () => { stop(); remove(); };
  } catch (error) { stop(); throw error; }
}
