import { Capacitor } from "@capacitor/core";
import type { HubConnection } from "./connection.js";
import { maintainPushBinding, PUSH_FOREGROUND_EVENT } from "./push-maintenance.js";
import { currentSystemPushToken, observeSystemPushToken, cancelSystemPushTokenRead } from "./native-push-token.js";
import { withUnifiedChange, pushScopeFor } from "./unifiedpush.js";
import { systemPushSubscription } from "./apns-topic.js";
const owners = new Set<() => void>();
export function stopSystemPushMaintenance(): void { for (const stop of [...owners]) stop(); cancelSystemPushTokenRead(); }
export function maintainSystemPush(connection: HubConnection): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;
  const provider = Capacitor.getPlatform() === "ios" ? "apns" : "fcm";
  const dispose = maintainPushBinding(connection, { provider, token: currentSystemPushToken, observe: observeSystemPushToken,
    ...(provider === "apns" ? { subscription: (token: string, signal: AbortSignal) => systemPushSubscription(provider, token, () => connection.http("/api/notifications", { signal })) } : {}) },
    (changed) => { window.addEventListener(PUSH_FOREGROUND_EVENT, changed); return () => window.removeEventListener(PUSH_FOREGROUND_EVENT, changed); },
    provider === "fcm" ? (work) => withUnifiedChange(pushScopeFor(connection), work) : undefined);
  const stop = () => { owners.delete(stop); dispose(); }; owners.add(stop); return stop;
}
