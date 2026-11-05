import { PushNotifications } from "@capacitor/push-notifications";
import { pushBindingSchema } from "../../src/client-protocol/push.js";
import { nativePlatform } from "./native.js";
import { desktopNotificationPermission, desktopNotificationsSupported } from "./desktop-notifications.js";
import { UnifiedPush, unifiedState, pushScopeFor, withUnifiedChange } from "./unifiedpush.js";
import { unifiedSubscription } from "./unifiedpush-controller.js";
import { currentSystemPushToken, systemPushResetRevision } from "./native-push-token.js";
import { runtimeHostId } from "./host-registry.js";
import type { HubConnection } from "./connection.js";
import type { NotificationState } from "./notifications.js";
import { apnsTopicFor, ApnsTopicError, nativeApnsTopic, systemPushSubscription, type ApnsTopicIssue } from "./apns-topic.js";

export type ReadinessReason = "ready" | "denied" | "prompt" | "channel-disabled" | "channel-missing" | "unconfigured" | "unbound" | "subscription" | "unifiedpush" | "browser-subscription" | "unsupported" | "unknown" | "apns-topic";
export type NotificationReadiness = { reason: ReadinessReason; provider?: "apns" | "fcm" | "webpush" | "unifiedpush"; channelAlerts?: { sound: boolean; vibration: boolean }; apnsTopic?: ApnsTopicIssue };
/** Read only. In particular, do not obtain a token, register a worker, call
 * UnifiedPush.refresh, migrate a legacy registration, or request permission. */
export async function checkNotificationReadiness(connection: HubConnection, _savedState: NotificationState, signal: AbortSignal): Promise<NotificationReadiness> {
  const platform = nativePlatform();
  let channelAlerts: NotificationReadiness["channelAlerts"];
  const issue = (reason: ReadinessReason, provider?: NotificationReadiness["provider"]): NotificationReadiness => ({ reason, provider, channelAlerts });
  if (platform === "macos" || platform === "windows") {
    if (!await desktopNotificationsSupported()) return issue("unknown");
    const permission = await desktopNotificationPermission(false);
    return issue(permission === "granted" ? "ready" : permission === "denied" ? "denied" : "prompt");
  }
  let missingChannel = false;
  if (platform === "web") {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return issue("unsupported");
    if (Notification.permission !== "granted") return issue(Notification.permission === "denied" ? "denied" : "prompt");
  } else {
    const { receive } = await PushNotifications.checkPermissions();
    if (receive !== "granted") return issue(receive === "denied" ? "denied" : "prompt");
    if (platform === "android") {
      const status = await UnifiedPush.notificationStatus();
      if (typeof status.appEnabled !== "boolean" || !["enabled", "disabled", "missing", "not-required"].includes(status.channel)) return issue("unknown");
      if (!status.appEnabled) return issue("denied");
      if (status.channel === "disabled") return issue("channel-disabled");
      missingChannel = status.channel === "missing";
      if (status.channel === "enabled" && typeof status.soundEnabled === "boolean" && typeof status.vibrationEnabled === "boolean") {
        channelAlerts = { sound: status.soundEnabled, vibration: status.vibrationEnabled };
      }
    }
  }
  signal.throwIfAborted();
  // A saved setting is not evidence that this host still has provider credentials.
  const state = await connection.http<NotificationState>("/api/notifications", { signal });
  signal.throwIfAborted();
  const binding = pushBindingSchema.parse(await connection.http("/api/push", { signal }));
  if (!binding.enabled || !state.preferences.enabled || binding.subscribed === undefined) return issue("unknown");
  const provider = binding.provider ?? undefined;
  if (!provider) return issue("unbound");
  if (platform === "ios" && provider !== "apns" || platform === "android" && provider !== "fcm" && provider !== "unifiedpush" || platform === "web" && provider !== "webpush") return issue("unknown");
  if (!state.providers[provider] || provider === "webpush" && !state.vapidPublicKey) return issue("unconfigured", provider);
  // A stored subscription is not deliverable if this Host (older, or with a
  // changed allowlist) cannot route this installation's own APNs topic.
  if (provider === "apns") {
    try { apnsTopicFor(state, await nativeApnsTopic()); }
    catch (error) { return error instanceof ApnsTopicError ? { ...issue("apns-topic", provider), apnsTopic: error.code } : issue("unknown"); }
    signal.throwIfAborted();
  }
  if (!binding.subscribed) return issue("subscription", provider);
  if (provider === "unifiedpush") {
    const scope = { ...pushScopeFor(connection), migrateLegacy: false };
    const [local, available] = await Promise.all([unifiedState(scope), UnifiedPush.distributors()]);
    if (!local.confirmed || local.phase !== "active" || !local.registrationId || local.error || !local.distributor || !available.distributors.some(d => d.id === local.distributor)) return issue("unifiedpush", provider);
    try { if (!unifiedSubscription(local, scope)) return issue("unifiedpush", provider); } catch { return issue("unifiedpush", provider); }
  } else if (provider === "webpush") {
    const scope = new URL(`/push-host/${runtimeHostId(connection.identity.hubPublicKey!)}/`, location.origin).href;
    const worker = await navigator.serviceWorker.getRegistration(scope);
    // A root worker returned as fallback belongs to neither this host nor this subscription.
    const subscription = worker?.scope === scope ? await worker.pushManager.getSubscription() : null;
    if (!subscription || subscription.expirationTime != null && subscription.expirationTime <= Date.now()) return issue("browser-subscription", provider);
  }
  signal.throwIfAborted();
  return issue(missingChannel ? "channel-missing" : "ready", provider);
}

/** Explicit recovery preserves the chosen provider and consent. Never PUT on
 * conflict: a disabled/removed/switched binding must win over an old dialog. */
export async function reconnectSystemNotifications(connection: HubConnection, provider: "apns" | "fcm", signal: AbortSignal): Promise<void> {
  const reset = systemPushResetRevision();
  const current = () => { signal.throwIfAborted(); if (reset !== systemPushResetRevision()) throw new Error("push_recovery_cancelled"); };
  const recover = async () => {
    current();
    const binding = pushBindingSchema.parse(await connection.http("/api/push", { signal }));
    if (!binding.enabled || binding.provider !== provider || !binding.revision) throw new Error("push_binding_changed");
    current();
    // currentSystemPushToken checks permission without prompting. Recovery
    // cannot convert a system denial into an apparent successful reconnect.
    const token = await currentSystemPushToken(); current();
    const subscription = await systemPushSubscription(provider, token, () => connection.http("/api/notifications", { signal })); current();
    await connection.http("/api/push", { method: "PATCH", signal, body: JSON.stringify({ ...subscription, expectedRevision: binding.revision }) });
  };
  if (provider === "fcm") await withUnifiedChange(pushScopeFor(connection), recover); else await recover();
}
