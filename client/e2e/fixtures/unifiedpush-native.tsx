import React from "react";
import { createRoot } from "react-dom/client";
import { firebaseFixture } from "./unifiedpush-notifications.js";
import { plugins } from "./unifiedpush-core.js";
import { NotificationSettings } from "../../src/NotificationSettings.js";
import { UnifiedPushSettings } from "../../src/UnifiedPushSettings.js";
import { enableUnifiedPush, migrateLegacyUnifiedPush, maintainUnifiedPush, pushScopeFor, unregisterHostNotifications, type UnifiedPushNative } from "../../src/unifiedpush.js";
import { clearLocalPush, enableNotifications, type NotificationState } from "../../src/notifications.js";
import type { RuntimeHost } from "../../src/host-registry.js";
import type { HubConnection } from "../../src/connection.js";
import type { UnifiedScope, UnifiedRegistration } from "../../src/unifiedpush-controller.js";

// Production client orchestration and UI; connector and HTTP receipts are
// controlled substitutions. Registry durability is tested in Java separately.
const records = new Map<string, UnifiedRegistration>();
const listeners = new Set<(value: UnifiedRegistration) => void>();
const connections: HubConnection[] = [], log: string[] = [], remote: (string | undefined)[] = [];
let failRefresh = false, failDistributorRead = false;
let next = 0, failCleanupBefore = false, failPut = false, failDelete = false, failCleanup = false, holdPut = false, holdPreferences = false, oldNative = false, release: (() => void) | undefined;
const snapshot = (scope: UnifiedScope) => ({ ...scope, schemaVersion: 2, ...structuredClone(records.get(scope.instance) ?? {}), registrationCount: records.size, sharedDistributor: [...records.values()][0]?.distributor });
const emit = (state: UnifiedRegistration) => listeners.forEach((listener) => listener(structuredClone(state)));
const remove = async (scope: Pick<UnifiedScope, "instance">) => {
  const record = records.get(scope.instance); if (!record) return;
  if (failCleanupBefore) { failCleanupBefore = false; throw new Error("unifiedpush_storage_failed"); }
  record.phase = "removing"; record.remoteRemoval ??= false; delete record.endpoint; delete record.keys;
  if (failCleanup) { failCleanup = false; throw new Error("unifiedpush_storage_failed"); }
  records.delete(scope.instance); emit({ ...record, phase: "removed" });
};
const nativeCalls: UnifiedScope[] = [], preferences: Record<number, NotificationState["preferences"]> = {};
const native: UnifiedPushNative = {
  distributors: async () => { if (failDistributorRead) throw new Error("fixture_native_read_failure"); return { distributors: [{ id: "one", name: "Distributor One" }, { id: "two", name: "Distributor Two" }] }; },
  state: async (scope) => { nativeCalls.push(structuredClone(scope)); return oldNative ? { instance: scope.deviceId } : snapshot(scope); },
  register: async (scope) => {
    if ([...records.values()].some((record) => record.distributor !== scope.distributor)) throw new Error("unifiedpush_distributor_in_use");
    const existing = records.get(scope.instance);
    const record = { ...scope, schemaVersion: 2, phase: "active", confirmed: existing?.confirmed ?? false, registrationId: existing?.registrationId ?? `generation_${++next}`, endpoint: `https://push.example.test/endpoint_${next}`, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
    records.set(scope.instance, record); emit(record); return snapshot(scope);
  },
  addListener: async (_event, listener) => { listeners.add(listener); return { remove: async () => { listeners.delete(listener); } }; },
  confirmRegistration: async (scope) => { const record = records.get(scope.instance); if (!record || record.registrationId !== scope.registrationId || record.endpoint !== scope.endpoint) throw new Error("unifiedpush_registration_changed"); record.confirmed = true; },
  refresh: async (scope) => snapshot(scope),
  beginUnregister: async (scope) => { const record = records.get(scope.instance); if (record) { record.phase = "removing"; record.remoteRemoval = scope.remoteRemoval !== false || !!record.remoteRemoval; delete record.endpoint; delete record.keys; } return snapshot(scope); },
  finishUnregister: async (scope) => { if (records.get(scope.instance)?.registrationId !== scope.registrationId) throw new Error("unifiedpush_removal_conflict"); await remove(scope); },
  unregister: remove,
  unregisterAll: async () => { for (const instance of records.keys()) await remove({ instance }); },
  clearFirebase: () => firebaseFixture.clear(),
  registerFirebase: () => firebaseFixture.register(),
};
plugins.TaroCubUnifiedPush = native;
const state: NotificationState = { preferences: { enabled: true, quietStart: "", quietEnd: "", timeZone: "UTC" }, providers: { webpush: false, fcm: true, apns: false, unifiedpush: true } };
const roots = createRoot(document.getElementById("root")!);
Object.assign(window, { unifiedNativeFixture: {
  setup(keys: string[]) {
    for (const [index, key] of keys.entries()) {
      const subscribers = new Set<() => void>();
      connections.push({ identity: { deviceId: "same_device", hubPublicKey: key }, cache: { databaseName: `fixture_${index}` }, state: { status: "online" }, subscribe: (listener: () => void) => { subscribers.add(listener); return () => subscribers.delete(listener); }, acceptNotificationPreferences: (accepted: NotificationState["preferences"]) => { const connection = connections[index]!; connection.state = { ...connection.state, notifications: { ...connection.state.notifications!, preferences: accepted } }; subscribers.forEach(listener => listener()); }, refreshNotificationPreferences: async () => { if (failRefresh) throw new Error("fixture_refresh_failure"); const notifications = { ...state, preferences: preferences[index] ?? state.preferences }; connections[index]!.state = { ...connections[index]!.state, notifications }; subscribers.forEach(listener => listener()); return notifications; }, http: async (path: string, init: RequestInit) => {
      log.push(`${index} ${init.method} ${path} start`);
      if (path === "/api/push" && init.method === "PUT") { if (failPut) { failPut = false; throw new Error("endpoint_not_allowlisted"); } if (holdPut) { holdPut = false; await new Promise<void>((done) => { release = done; }); } remote[index] = JSON.parse(String(init.body)).provider; }
      if (path === "/api/push" && init.method === "DELETE") { if (failDelete) { failDelete = false; throw new Error("offline"); } remote[index] = undefined; }
      if (path === "/api/notifications" && holdPreferences) { holdPreferences = false; await new Promise<void>((done) => { release = done; }); }
      if (path === "/api/notifications") preferences[index] = JSON.parse(String(init.body));
      log.push(`${index} ${init.method} ${path} done`);
    } } as unknown as HubConnection);
    }
  },
  renderMain(index: number) { roots.render(<NotificationSettings connection={connections[index]!} />); },
  preferences(index: number) { return preferences[index] ?? state.preferences; },
  async migrateOffline() { const scope = pushScopeFor(connections[0]!); await migrateLegacyUnifiedPush([{ id: scope.hostId, deviceId: scope.deviceId, databaseName: "tarocub-v1" } as RuntimeHost]); return nativeCalls; },
  render(index: number) { roots.render(<UnifiedPushSettings key={index} connection={connections[index]!} state={state} changed={async () => undefined} />); },
  enable: (index: number) => enableUnifiedPush(connections[index]!, "one"),
  fcm: (index: number) => enableNotifications(connections[index]!, state, { systemPush: true }),
  resume: (index: number) => enableNotifications(connections[index]!, { ...state, providers: { ...state.providers, fcm: false } }),
  remove: (index: number) => unregisterHostNotifications(connections[index]!),
  async maintain() { for (const connection of connections) await maintainUnifiedPush(connection); },
  rotate(index: number) { const scope = pushScopeFor(connections[index]!); const record = records.get(scope.instance)!; record.endpoint = `https://push.example.test/rotated_${index}`; emit(record); },
  controls(options: { nativeRead?: boolean; refresh?: boolean; cleanupBefore?: boolean; put?: boolean; delete?: boolean; cleanup?: boolean; holdPut?: boolean; holdPreferences?: boolean; oldNative?: boolean }) { failDistributorRead = options.nativeRead ?? false; failRefresh = options.refresh ?? false; failCleanupBefore = options.cleanupBefore ?? false; failPut = options.put ?? false; failDelete = options.delete ?? false; failCleanup = options.cleanup ?? false; holdPut = options.holdPut ?? false; holdPreferences = options.holdPreferences ?? false; oldNative = options.oldNative ?? false; },
  firebase: firebaseFixture,
  clear: () => clearLocalPush(),
  release() { release?.(); release = undefined; },
  snapshot: () => ({ records: [...records.values()], remote, log: [...log] }),
} });
