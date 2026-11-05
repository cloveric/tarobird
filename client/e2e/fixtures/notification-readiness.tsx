import React from "react";
import { createRoot } from "react-dom/client";
import { NotificationSettings } from "../../src/NotificationSettings.js";
import { RuntimeHostContext } from "../../src/RuntimeHost.js";
import { nativeState, plugins } from "./notification-readiness-core.js";
import { pushScopeFor } from "../../src/unifiedpush.js";
import { setLocale } from "../../src/i18n.js";
import { maintainSystemPush } from "../../src/system-push.js";
import { maintainPushBinding } from "../../src/push-maintenance.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/bot-name.css";
const params = new URLSearchParams(location.search);
const subscribers = new Set<() => void>();
const configured = params.get("configured") !== "false";
const state = { customization: params.get("customization") !== "false", preferences: { enabled: params.get("enabled") !== "false", quietStart: "", quietEnd: "", timeZone: "Asia/Shanghai" }, providers: { apns: configured, fcm: configured, unifiedpush: configured, webpush: false }, ...(configured && params.get("apnsTopics") !== "none" ? { apnsTopics: params.get("apnsTopics")?.split(",") ?? ["com.tarobot.client"] } : {}) };
const fixture = { holdSystem: false, systemReleases: [] as (() => void)[], holdPreferences: false, rejectPreferences: false, preferenceReleases: [] as (() => void)[], fail: false, failSettings: false, hold: false, holdLocal: false, holdPatch: false, patchReleases: [] as (() => void)[], localReleases: [] as (() => void)[], releases: [] as (() => void)[], writes: [] as any[], binding: { provider: nativeState.platform === "ios" ? "apns" : "fcm", revision: "fixture-1", enabled: true, subscribed: params.get("subscribed") !== "false" } as any };
const connection = { cache: { databaseName: "fixture" }, state: { status: "online", notifications: state }, identity: { hubPublicKey: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", deviceId: "phone" },
  subscribe(listener: () => void) { subscribers.add(listener); return () => subscribers.delete(listener); },
  async refreshNotificationPreferences() { this.state = { ...this.state, notifications: { ...this.state.notifications } }; subscribers.forEach(f => f()); return this.state.notifications; },
  async http(route: string, init: RequestInit = {}) {
    const method = init.method ?? "GET";
    if (method !== "GET") fixture.writes.push({ route, method, body: JSON.parse(String(init.body)) });
    if (route === "/api/push") {
      if (method === "PATCH") { if (fixture.holdPatch) { fixture.holdPatch = false; await new Promise<void>(r => fixture.patchReleases.push(r)); } const body = JSON.parse(String(init.body)); if (!fixture.binding.enabled || fixture.binding.provider !== body.provider || fixture.binding.revision !== body.expectedRevision) throw { status: 409 }; fixture.binding.subscribed = true; fixture.binding.revision += "next"; return {}; }
      if (method === "PUT") { fixture.binding = { ...fixture.binding, provider: JSON.parse(String(init.body)).provider, subscribed: true, revision: "registered" }; return {}; }
      if (fixture.fail) throw new Error("fixture_failure");
      const snapshot = { ...fixture.binding };
      if (fixture.hold) await new Promise<void>(resolve => fixture.releases.push(resolve));
      return snapshot;
    }
    if (method === "PUT") { if (fixture.holdPreferences) await new Promise<void>(resolve => fixture.preferenceReleases.push(resolve)); if (fixture.rejectPreferences) throw new Error("preferences_write_failed"); fixture.binding.enabled = JSON.parse(String(init.body)).enabled; this.acceptNotificationPreferences(JSON.parse(String(init.body))); }
    if (fixture.failSettings) throw new Error("settings_failure");
    return this.state.notifications;
  },
  acceptNotificationPreferences(value: typeof state.preferences) { this.state = { ...this.state, notifications: { ...this.state.notifications, preferences: value } }; subscribers.forEach(f => f()); },
};
let local: any = { ...pushScopeFor(connection as any), schemaVersion: 2 };
const openSystemSettings = async () => { nativeState.calls.push("settings"); if (fixture.holdSystem) await new Promise<void>(resolve => fixture.systemReleases.push(resolve)); if (nativeState.settingsFail) throw new Error("settings_unavailable"); };
plugins.TaroBotNotificationSettings = { open: openSystemSettings };
plugins.App = { getInfo: async () => ({ id: "com.tarobot.client" }) };
plugins.TaroCubShareInbox = { openNotificationSettings: openSystemSettings, pushTokenSnapshot: async () => ({ revision: nativeState.revision, token: nativeState.token }) };
plugins.TaroCubUnifiedPush = {
 register: async () => { local = { ...local, phase: "active", registrationId: "registration-new", distributor: "ntfy", endpoint: "https://ntfy.example.test/abcdefghijklmnop", keys: {p256dh: "p".repeat(88), auth: "a".repeat(22)} }; return local; },
 confirmRegistration: async () => { local.confirmed = true; },
 addListener: async () => ({remove: async () => {}}),
 notificationStatus: async () => { nativeState.calls.push("status"); if (nativeState.old) throw { code: "UNIMPLEMENTED" }; return { appEnabled: nativeState.appEnabled, channel: nativeState.channel, soundEnabled: nativeState.soundEnabled, vibrationEnabled: nativeState.vibrationEnabled }; },
 openNotificationSettings: openSystemSettings,
 state: async (scope: any) => { nativeState.calls.push(scope.migrateLegacy ? "MIGRATE" : "state"); const snapshot = { ...local }; if (fixture.holdLocal) { fixture.holdLocal = false; await new Promise<void>(r => fixture.localReleases.push(r)); } return snapshot; },
 distributors: async () => ({ distributors: [{ id: "ntfy", name: "ntfy" }] }),
 registerFirebase: async () => { nativeState.calls.push("TOKEN"); if (nativeState.holdToken) await new Promise<void>(resolve => nativeState.releases.push(resolve)); return { token: nativeState.token }; },
};
if (["macos", "windows"].includes(nativeState.platform)) {
  Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args?: { request?: boolean }) => {
    nativeState.calls.push(command);
    if (command === "desktop_notifications_supported") return true;
    if (command === "desktop_notification_permission") {
      nativeState.calls.push(args?.request ? "permission-request" : "permission-read");
      if (params.get(args?.request ? "requestError" : "permissionError")) throw params.get(args?.request ? "requestError" : "permissionError");
      return nativeState.permission;
    }
    if (command === "desktop_notification_settings") return openSystemSettings();
    if (nativeState.settingsFail) throw new Error("settings_unavailable");
  } } });
  if (nativeState.platform === "windows") Object.defineProperty(navigator, "userAgent", { value: "Windows notification fixture", configurable: true });
}
const root = createRoot(document.getElementById("root")!);
function render() { root.render(<RuntimeHostContext.Provider value="Mac mini"><main className="settings-content" style={{ margin: "24px auto", width: `min(100%, ${["macos", "windows"].includes(nativeState.platform) ? "760px" : "420px"})`, height: "auto", overflow: "visible", padding: "24px" }}><section><NotificationSettings connection={connection as any}/></section></main></RuntimeHostContext.Provider>); }
document.documentElement.dataset.theme = params.get("theme") ?? "light";
document.body.style.overflow = "auto";
setLocale(params.get("lang") === "en" ? "en" : "zh"); render();
Object.assign(window, { readinessFixture: { connection, nativeState, fixture, setLocale, unmount: () => root.unmount(), setLocal(value: any) { local = { ...local, ...value }; }, publish() { connection.state = { ...connection.state }; subscribers.forEach(f => f()); }, foreground() { window.dispatchEvent(new Event("tarocub:push-foreground")); },
 startNativeMaintenance: () => maintainSystemPush(connection as any), startMaintenance: () => maintainPushBinding(connection as any, { provider: nativeState.platform === "ios" ? "apns" : "fcm", token: async () => { nativeState.calls.push("MAINTENANCE TOKEN"); return nativeState.token; }, observe: () => () => {} }, () => () => {}) } });
