import { Capacitor, registerPlugin } from "@capacitor/core";
import { checkUnifiedState, registerUnifiedDistributor, unifiedScope, unifiedSubscription, UnifiedOperations, type UnifiedScope, type UnifiedBridge, type UnifiedRegistration } from "./unifiedpush-controller.js";
import type { HubConnection } from "./connection.js";
import { runtimeHostId, type RuntimeHost } from "./host-registry.js";
import type { NotificationPreferences } from "../../src/client-protocol/push.js";
import { t } from "./i18n.js";

export class UnifiedPushRemovalError extends Error {
  constructor(cause: unknown) { super(t("清理未完成，此主机推送已暂停。请重试，或在通知设置中继续完成清理。"), { cause }); }
}

export interface UnifiedPushNative extends UnifiedBridge {
  notificationStatus(): Promise<{ appEnabled: boolean; channel: "enabled" | "disabled" | "missing" | "not-required"; soundEnabled?: boolean; vibrationEnabled?: boolean }>;
  openNotificationSettings(): Promise<void>;
  distributors(): Promise<{ distributors: { id: string; name: string }[] }>;
  unregister(scope: Pick<UnifiedScope, "instance">): Promise<void>;
  beginUnregister(scope: UnifiedScope & { remoteRemoval?: boolean }): Promise<UnifiedRegistration>;
  finishUnregister(scope: UnifiedScope & { registrationId: string }): Promise<void>;
  unregisterAll(): Promise<void>;
  clearFirebase(): Promise<void>;
  registerFirebase(): Promise<{ token: string }>;
  refresh(scope: UnifiedScope): Promise<UnifiedRegistration>;
  confirmRegistration(scope: UnifiedScope & { registrationId: string; endpoint: string }): Promise<void>;
}
export const UnifiedPush = registerPlugin<UnifiedPushNative>("TaroCubUnifiedPush");
const operations = new UnifiedOperations();
export const hasUnifiedPush = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
export const pushScopeFor = (connection: HubConnection) => unifiedScope(runtimeHostId(connection.identity.hubPublicKey!), connection.identity.deviceId, connection.cache.databaseName === "tarocub-v1");
export const pushScopeForHost = (host: RuntimeHost) => unifiedScope(host.id, host.deviceId, host.databaseName === "tarocub-v1");
export const unifiedState = async (scope: UnifiedScope) => checkUnifiedState(await UnifiedPush.state(scope), scope);
export const withUnifiedChange = <T,>(scope: UnifiedScope, work: () => Promise<T>): Promise<T> => operations.run(scope.instance, work);
export async function migrateLegacyUnifiedPush(hosts: RuntimeHost[]): Promise<void> {
  if (!hasUnifiedPush()) return;
  for (const host of hosts.filter((host) => host.databaseName === "tarocub-v1")) {
    const scope = pushScopeForHost(host); await withUnifiedChange(scope, () => unifiedState(scope));
  }
}
export async function enableUnifiedPush(connection: HubConnection, distributor: string, preferences?: NotificationPreferences): Promise<void> {
  const scope = pushScopeFor(connection);
  await unifiedState(scope); // Verify the installed interface before permission UI.
  const { PushNotifications } = await import("@capacitor/push-notifications");
  if ((await PushNotifications.requestPermissions()).receive !== "granted") throw new Error("unifiedpush_permission_required");
  await withUnifiedChange(scope, async () => {
    const previous = await unifiedState(scope);
    try {
      await registerUnifiedDistributor(UnifiedPush, scope, distributor, async (subscription, registrationId) => {
        if (subscription.provider !== "unifiedpush") throw new Error("unifiedpush_registration_invalid");
        await connection.http("/api/push", { method: "PUT", body: JSON.stringify(subscription) });
        await UnifiedPush.confirmRegistration({ ...scope, registrationId, endpoint: subscription.endpoint });
      });
    } catch (error) {
      // Failed new attempts must not silently replace the chosen provider when
      // a delayed endpoint arrives. Unconfirmed records also cannot auto-sync.
      if (!previous.registrationId) await UnifiedPush.unregister(scope).catch(() => undefined);
      throw error;
    }
    if (preferences) await connection.http("/api/notifications", { method: "PUT", body: JSON.stringify({ ...preferences, enabled: true }) });
  });
}
export async function clearUnifiedPush(scope?: UnifiedScope, clearDevice?: () => Promise<void>): Promise<void> {
  if (!hasUnifiedPush()) return;
  if (scope) await withUnifiedChange(scope, async () => { await unifiedState(scope); await UnifiedPush.unregister(scope); });
  else await operations.all(async () => { await UnifiedPush.unregisterAll(); await clearDevice?.(); });
}
/** Stop native refreshes, drain this pairing's pending PUTs, then get its DELETE
 * receipt. The same ordering is used by Settings and online host removal. */
export async function unregisterHostNotifications(connection: HubConnection, preferences?: NotificationPreferences): Promise<void> {
  const remove = () => connection.http("/api/push", { method: "DELETE" }).then(() => undefined);
  const disable = async () => { if (preferences) await connection.http("/api/notifications", { method: "PUT", body: JSON.stringify({ ...preferences, enabled: false }) }); };
  if (!hasUnifiedPush()) { await remove(); await disable(); return; }
  const scope = pushScopeFor(connection);
  await withUnifiedChange(scope, async () => {
    await unifiedState(scope);
    const pending = checkUnifiedState(await UnifiedPush.beginUnregister(scope), scope);
    try {
      await remove();
      if (pending.registrationId) await UnifiedPush.finishUnregister({ ...scope, registrationId: pending.registrationId });
      await disable();
    } catch (error) { throw pending.registrationId ? new UnifiedPushRemovalError(error) : error; }
  });
}
export async function maintainUnifiedPush(connection: HubConnection): Promise<() => void> {
  if (!hasUnifiedPush()) return () => undefined;
  const scope = pushScopeFor(connection); let stopped = false;
  const sync = (state: UnifiedRegistration) => {
    if (state.instance !== scope.instance) return;
    void withUnifiedChange(scope, async () => {
      if (stopped) return;
      const current = await unifiedState(scope);
      if (!stopped && current.phase === "removing" && !current.remoteRemoval) { await UnifiedPush.unregister(scope); return; }
      if (stopped || !current.confirmed || current.registrationId !== state.registrationId || current.endpoint !== state.endpoint) return;
      const subscription = unifiedSubscription(current, scope);
      if (subscription) await connection.http("/api/push", { method: "PUT", body: JSON.stringify(subscription) });
    }).catch(() => { /* Settings reports registration state; reconnect retries. */ });
  };
  const listener = await UnifiedPush.addListener("registrationChanged", sync);
  try { await withUnifiedChange(scope, async () => { if (!stopped) sync(checkUnifiedState(await UnifiedPush.refresh(scope), scope)); }); } catch { /* Foreground chat remains available without a distributor. */ }
  return () => { stopped = true; void listener.remove(); };
}
