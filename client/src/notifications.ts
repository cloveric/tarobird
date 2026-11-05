import { clearUnifiedPush, UnifiedPush, pushScopeFor, pushScopeForHost, unifiedState, withUnifiedChange, hasUnifiedPush, enableUnifiedPush } from "./unifiedpush.js";
import { t } from "./i18n.js";
import { Capacitor } from "@capacitor/core";
import { isDesktop, isElectron } from "./desktop-bridge.js";
import { notificationLink, pushPayloadSchema, type NotificationPreferences, type PushPayload } from "../../src/client-protocol/push.js";
import type { HubConnection } from "./connection.js";
import { navigateDeepLink } from "./native.js";
import { ListenerScope } from "./listener-scope.js";
import { registerFirebasePush } from "./firebase-push.js";
import { currentSystemPushToken, systemPushResetRevision } from "./native-push-token.js";
import { stopSystemPushMaintenance } from "./system-push.js";
import { apnsTopicFor, ApnsTopicError, nativeApnsTopic } from "./apns-topic.js";
import { runtimeHostId, type RuntimeHost } from "./host-registry.js";
import { clearDesktopNotifications, DesktopNotificationPermissionError, desktopNotificationPermission, desktopNotificationsSupported, listenDesktopNotifications, observeDesktopNotificationIntent, showDesktopNotification, type DesktopNotificationIntent } from "./desktop-notifications.js";

const pushScope = (id: string) => `/push-host/${id}/`;
// Retain only in-flight work, not a permanent map of removed host identities.
const pendingDesktopSends = new Set<{ hostId: string | undefined; cancelled: boolean }>();
function cancelDesktopSends(hostId?: string): void {
  for (const pending of pendingDesktopSends) if (!hostId || !pending.hostId || pending.hostId === hostId) pending.cancelled = true;
}
async function hostPushWorker(hostId: string): Promise<ServiceWorkerRegistration> {
  const worker = await navigator.serviceWorker.register("/sw.js", { scope: pushScope(hostId) });
  if (worker.active) return worker;
  const pending = worker.installing ?? worker.waiting;
  if (!pending) throw new Error("push_worker_unavailable");
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); pending.removeEventListener("statechange", changed); error ? reject(error) : resolve(); };
    const changed = () => { if (pending.state === "activated") finish(); else if (pending.state === "redundant") finish(new Error("push_worker_unavailable")); };
    const timer = setTimeout(() => finish(new Error("push_worker_timeout")), 15_000);
    pending.addEventListener("statechange", changed); changed();
  });
  return worker;
}

/** `apnsTopics`: present only on Hubs that route APNs per declared App topic. */
export type NotificationState = { customization?: boolean; preferences: NotificationPreferences; mutedConversations?: string[]; providers: Record<"apns" | "fcm" | "webpush" | "unifiedpush", boolean>; vapidPublicKey?: string; apnsTopics?: string[] };
export async function updateNotificationPreferences(connection: HubConnection, preferences: NotificationPreferences): Promise<void> {
  const write = () => connection.http("/api/notifications", { method: "PUT", body: JSON.stringify(preferences) }).then(() => undefined);
  if (hasUnifiedPush()) await withUnifiedChange(pushScopeFor(connection), write); else await write();
}
export async function enableNotifications(connection: HubConnection, state: NotificationState, options: { systemPush?: boolean } = {}): Promise<void> {
  if (isDesktop()) {
    if (await desktopNotificationsSupported()) {
      const permission = await desktopNotificationPermission(false);
      // A denied permission must be changed in System Settings. Requesting it
      // again can reject with a native error instead of showing another prompt.
      if (permission === "denied" || permission !== "granted" && await desktopNotificationPermission(true) !== "granted") throw new DesktopNotificationPermissionError(t("系统通知已关闭。请在系统设置中允许 TaroBird 通知。"));
    } else {
      if (isElectron()) throw new Error("native_notifications_unavailable");
      const notification = await import("@tauri-apps/plugin-notification");
      if (!await notification.isPermissionGranted() && await notification.requestPermission() !== "granted") throw new Error(t("通知权限未开启，请在系统设置中允许 TaroBird 通知。"));
    }
  } else if (Capacitor.isNativePlatform()) {
    const reset = systemPushResetRevision();
    const stillCurrent = () => { if (reset !== systemPushResetRevision()) throw new Error(t("无法注册推送服务。")); };
    const provider = Capacitor.getPlatform() === "ios" ? "apns" : "fcm";
    if (provider === "fcm" && !options.systemPush) {
      const current = await unifiedState(pushScopeFor(connection)); stillCurrent();
      if (current.phase === "active" && current.registrationId && current.distributor) {
        await enableUnifiedPush(connection, current.distributor, state.preferences); return;
      }
    }
    if (!state.providers[provider]) throw new Error(provider === "apns" ? t("Hub 尚未配置 APNs。") : t("Hub 尚未配置 FCM；无谷歌服务设备可使用下方 UnifiedPush 配置。"));
    // Before any permission prompt or token: never register an APNs token
    // that this Hub would send under another App's topic.
    let apnsTopic: string | undefined;
    if (provider === "apns") {
      try { apnsTopic = apnsTopicFor(state, await nativeApnsTopic()); }
      catch (error) {
        if (error instanceof ApnsTopicError) throw new Error(error.code === "apns_topic_unsupported" ? t("此主机版本无法为当前 App 路由 iOS 推送，请先更新主机。") : t("主机的 APNs 配置未包含当前 App，请在主机推送设置中允许此 App 的标识。"));
        throw error;
      }
      stillCurrent();
    }
    const { PushNotifications } = await import("@capacitor/push-notifications");
    stillCurrent();
    const permission = await PushNotifications.requestPermissions(); stillCurrent(); if (permission.receive !== "granted") throw new Error(t("通知权限未开启。"));
    const scope = provider === "fcm" ? pushScopeFor(connection) : undefined;
    const register = async () => {
      stillCurrent();
      if (scope) {
        const current = await unifiedState(scope); stillCurrent();
        if (current.phase === "removing" && current.remoteRemoval) throw new Error(t("请先完成此主机的推送清理，再重新连接。"));
      }
      const token = provider === "fcm" ? await registerFirebasePush() : await currentSystemPushToken();
      stillCurrent();
      // The per-host operation stays pending until its HTTP write has settled.
      // A late native callback after timeout cannot start a new registration PUT.
      // Fence the old endpoint before changing the server provider. If the app
      // exits after PUT, foreground refresh must not reinstall the old UP entry.
      if (scope) await UnifiedPush.beginUnregister({ ...scope, remoteRemoval: false });
      stillCurrent();
      await connection.http("/api/push", { method: "PUT", body: JSON.stringify(apnsTopic ? { provider, token, topic: apnsTopic } : { provider, token }) });
      if (scope) await UnifiedPush.unregister(scope);
      stillCurrent();
      await connection.http("/api/notifications", { method: "PUT", body: JSON.stringify({ ...state.preferences, enabled: true }) });
    };
    if (scope) await withUnifiedChange(scope, register); else await register();
    return;
  } else {
    if (!state.providers.webpush || !state.vapidPublicKey) throw new Error(t("Hub 尚未配置 Web Push。"));
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error(t("此浏览器不支持后台推送。"));
    if (await Notification.requestPermission() !== "granted") throw new Error(t("通知权限未开启。"));
    const worker = await hostPushWorker(runtimeHostId(connection.identity.hubPublicKey!)); const bytes = Uint8Array.from(atob(state.vapidPublicKey.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
    const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await connection.http("/api/push", { method: "PUT", body: JSON.stringify({ provider: "webpush", ...subscription.toJSON(), expirationTime: undefined }) });
  }
  await updateNotificationPreferences(connection, { ...state.preferences, enabled: true });
}
export function installPushActions(scope = new ListenerScope()): () => void {
  const navigate = (value: unknown) => { const payload = pushPayloadSchema.safeParse(value); if (payload.success) navigateDeepLink(notificationLink(payload.data)); };
  if (isDesktop()) {
    const intent: DesktopNotificationIntent = { supersededAt: -1, routing: false };
    const stopEarlyIntent = scope.listen<void>((emit) => observeDesktopNotificationIntent(emit), () => {
      if (!intent.routing) { intent.supersededAt = performance.now(); intent.changed?.(); }
    });
    scope.listen<unknown>(async (emit, active) => {
      const supported = await desktopNotificationsSupported(); if (!active()) return;
      if (supported) {
        return listenDesktopNotifications(scope, active, (target) => navigateDeepLink(notificationLink(target)), intent);
      }
      stopEarlyIntent();
      if (isElectron()) throw new Error("native_notifications_unavailable");
      const { onAction } = await import("@tauri-apps/plugin-notification"); if (!active()) return;
      // Unsupported desktop platforms retain one legacy compatibility attempt;
      // native listener/setup failures use ListenerScope's bounded recovery.
      try {
        const listener = await onAction((action) => {
          // New plugin versions wrap the notification; older native shells sent
          // the notification itself. An explicit missing notification is ignored.
          emit("notification" in action ? action.notification?.extra : (action as { extra?: unknown }).extra);
        });
        return () => listener.unregister();
      } catch { return; }
    }, navigate);
  }
  else if (Capacitor.isNativePlatform()) scope.listen<unknown>(async (emit, active) => {
    const { PushNotifications } = await import("@capacitor/push-notifications"); if (!active()) return;
    const listener = await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      // Native provider envelopes include APNs' aps and may add SDK metadata.
      // Project only the wire fields here; their values still pass the strict
      // shared schema, including host identity and the legacy wire title.
      const data: unknown = action.notification.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const source = data as Record<string, unknown>;
      emit(Object.fromEntries(Object.keys(pushPayloadSchema.shape).filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]])));
    }); return () => listener.remove();
  }, navigate);
  return scope.close;
}
export async function desktopNotification(payload: PushPayload, resolve: () => PushPayload | undefined = () => payload): Promise<void> {
  if (!isDesktop()) return;
  if (pendingDesktopSends.size >= 128) throw new Error("native_notification_busy");
  const pending = { hostId: payload.hostId, cancelled: false }; pendingDesktopSends.add(pending);
  try {
    const supported = await desktopNotificationsSupported();
    if (pending.cancelled) return;
    if (supported) { await showDesktopNotification(payload, () => pending.cancelled ? undefined : resolve()); return; }
    if (isElectron()) throw new Error("native_notifications_unavailable");
      const notification = await import("@tauri-apps/plugin-notification");
    if (await notification.isPermissionGranted() && !pending.cancelled) {
      const current = resolve();
      if (current) notification.sendNotification({ title: "TaroBird", body: current.body, extra: current });
    }
  } finally { pendingDesktopSends.delete(pending); }
}


/** Unregister local delivery before forgetting identity; Hub history/access is
 * intentionally unchanged. Do not wait on serviceWorker.ready when none exists. */
export async function clearLocalPush(): Promise<void> {
  stopSystemPushMaintenance();
  cancelDesktopSends();
  if (hasUnifiedPush()) {
    // Hold the device-wide operation barrier through Firebase deletion and
    // notification removal, not just through UnifiedPush unregisterAll.
    await clearUnifiedPush(undefined, async () => {
      await UnifiedPush.clearFirebase();
      const { PushNotifications } = await import("@capacitor/push-notifications");
      await PushNotifications.removeAllDeliveredNotifications();
    });
    return;
  }
  await clearUnifiedPush();
  if (isDesktop()) { if (await desktopNotificationsSupported()) await clearDesktopNotifications(); }
  else if (Capacitor.isNativePlatform()) {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    await PushNotifications.unregister();
    await PushNotifications.removeAllDeliveredNotifications();
  } else if (!isDesktop() && "serviceWorker" in navigator) {
    const worker = await navigator.serviceWorker.getRegistration();
    // WebKit exposes partial notification APIs in unsupported contexts. Only
    // query them when this origin can actually have an active subscription.
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const subscription = "PushManager" in window ? await worker?.pushManager?.getSubscription() : undefined;
    if (subscription) {
      await subscription.unsubscribe();
      if (await worker!.pushManager.getSubscription()) throw new Error("push_unsubscribe_failed");
    }
    for (const notification of await worker?.getNotifications() ?? []) notification.close();
  }
}

/** Shared APNs/FCM device tokens must survive removing one Hub. Its authenticated
 * server DELETE happens before the registry retires its credentials. */
export async function clearHostPush(host: RuntimeHost): Promise<void> {
  cancelDesktopSends(host.id);
  if (isDesktop()) { if (await desktopNotificationsSupported()) await clearDesktopNotifications(host.id); return; }
  if (Capacitor.isNativePlatform()) {
    if (Capacitor.getPlatform() === "android") await clearUnifiedPush(pushScopeForHost(host));
    return;
  }
  if (isDesktop() || !("serviceWorker" in navigator)) return;
  const scope = new URL(pushScope(host.id), location.origin).href;
  const worker = await navigator.serviceWorker.getRegistration(scope);
  // getRegistration may return the root worker controlling this path. Never
  // unsubscribe that shared/legacy registration on another host's behalf.
  if (!worker || worker.scope !== scope) return;
  if ("PushManager" in window) { const subscription = await worker.pushManager.getSubscription(); if (subscription && !await subscription.unsubscribe()) throw new Error("push_unsubscribe_failed"); }
  if ("Notification" in window && Notification.permission === "granted") for (const notification of await worker.getNotifications()) notification.close();
  if (!await worker.unregister()) throw new Error("push_worker_unregister_failed");
}
