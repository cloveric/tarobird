import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { native } from "./desktop-notifications-bridge.js";
import { installPushActions, desktopNotification, enableNotifications, clearHostPush, clearLocalPush, type NotificationState } from "../../src/notifications.js";
import { HostApp, type WorkspaceProps } from "../../src/HostApp.js";
import { HostConnections } from "../../src/host-connections.js";
import { HubConnection } from "../../src/connection.js";
import { ClientCache } from "../../src/storage.js";
import type { RuntimeHost } from "../../src/host-registry.js";
import { navigateDeepLink } from "../../src/native.js";
import { notificationPreferencesSchema, pushPayloadSchema } from "../../../src/client-protocol/push.js";
import { desktopNotice } from "../../src/message-notification.js";
import type { Message } from "../../../src/client-protocol/index.js";
import protocolNotice from "../../src-tauri/fixtures/desktop-notification.json";
import { setLocale } from "../../src/i18n.js";
import { NotificationSettings } from "../../src/NotificationSettings.js";

let stop: (() => void) | undefined, root: Root | undefined, pool: HostConnections | undefined, accept = true, mounted = false;
const targets: unknown[] = [], errors: string[] = [], commands: unknown[] = [], caches: ClientCache[] = [];
const hosts = ["a", "b"].map((letter) => ({ id: `hub_${letter.repeat(64)}`, name: `Host ${letter}`, publicKey: "", deviceId: `device_${letter}`, databaseName: `notification-${letter}`, registrationId: letter, state: "ready", createdAt: 1 } as RuntimeHost));
let result = "idle", lastError = "";
let currentPreferences = notificationPreferencesSchema.parse({ enabled: true });
let finishPairing: (() => void) | undefined;
window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason)); event.preventDefault(); });
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("tarocub-navigate", (event) => { targets.push((event as CustomEvent).detail); if (!mounted && accept) event.preventDefault(); });
const observed = new Map<string, Set<unknown>>();
const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
window.addEventListener = ((name: string, fn: EventListener, options?: any) => {
  if (["pointerdown", "keydown", "click", "tarocub-navigate", "tarocub-navigation-ready"].includes(name)) {
    const items = observed.get(name) ?? new Set(); items.add(fn); observed.set(name, items);
  }
  add(name, fn, options);
}) as typeof window.addEventListener;
window.removeEventListener = ((name: string, fn: EventListener, options?: any) => { observed.get(name)?.delete(fn); remove(name, fn, options); }) as typeof window.removeEventListener;
function Probe({ shell }: WorkspaceProps) {
  useEffect(() => { if (shell?.command) { commands.push({ hostId: shell.host.id, ...shell.command }); shell.consumed(shell.command.serial); } }, [shell?.command]);
  return <>{shell?.controls}<button onClick={shell?.addHost}>添加主机</button><p>{shell?.host.name}</p></>;
}
const fixture = {
  start() { stop = installPushActions(); },
  stop() { stop?.(); stop = undefined; root?.unmount(); root = undefined; caches.forEach((cache) => cache.close()); },
  async mountHost(ready = true, failed = false) {
    mounted = true;
    const entries = hosts.map((host) => {
      const cache = new ClientCache(host.databaseName); caches.push(cache);
      const connection = new HubConnection({ deviceId: host.deviceId, name: host.name, publicKey: "fixture", routes: [] }, cache);
      connection.start = async () => {}; connection.resume = () => {};
      return { host, connection };
    });
    HostConnections.prototype.start = async function () { pool = this; this.state = { loading: false, hosts: entries.map((entry) => !ready && entry.host.id === hosts[0]!.id ? { host: entry.host, ...(failed ? { error: "fixture failure" } : {}) } : entry) }; (this as any).publish(); };
    fixture.ready = () => { if (pool) { pool.state = { loading: false, hosts: entries }; (pool as any).publish(); } };
    root = createRoot(document.getElementById("root")!); root.render(<HostApp Workspace={Probe} Pairing={({ cancel }) => { finishPairing = cancel; return <p>Pairing</p>; }}/>);
  },
  finishPairing() { finishPairing?.(); },
  ready() { window.dispatchEvent(new Event("tarocub-navigation-ready")); },
  activate(host = "a", message = "message", conversation = "chat") { native.activate({ hostId: `hub_${host.repeat(64)}`, conversationId: conversation, messageId: message }); },
  silentNewClick() { native.livePeek = true; native.activate({ hostId: hosts[1]!.id, conversationId: "chat", messageId: "new" }, true); },
  emit() { native.emit(); },
  deepLink(url?: string) { navigateDeepLink(url ?? `tarocub://conversation/chat?host=hub_${"b".repeat(64)}&message=external`); },
  accept(value: boolean) { accept = value; },
  hold(command: string) { native.holds[command] = true; },
  fail(command: string, count: number) { native.failures[command] = count; },
  release(command: string) { native.release(command); },
  permissions(permission: string, request: string) { native.permission = permission; native.requestResult = request; },
  permissionError(error: string, locale: "zh" | "en") { native.permissionError = error; setLocale(locale); },
  requestPermissionError(error: string) { native.requestError = error; },
  mountSettings(locale: "zh" | "en") {
    setLocale(locale);
    const subscribers = new Set<() => void>();
    const connection = {
      state: { status: "online", notifications: { preferences: { enabled: false, quietStart: "22:00", quietEnd: "07:00", timeZone: "Asia/Shanghai" }, mutedConversations: ["muted-chat"], providers: { apns: false, fcm: false, webpush: false, unifiedpush: false } } },
      subscribe(listener: () => void) { subscribers.add(listener); return () => subscribers.delete(listener); },
      async refreshNotificationPreferences() { return this.state.notifications; },
      acceptNotificationPreferences(preferences: NotificationState["preferences"]) {
        this.state = { ...this.state, notifications: { ...this.state.notifications, preferences } }; subscribers.forEach(listener => listener());
      },
      async http(path: string, init: RequestInit = {}) {
        native.calls.push({ command: `http ${path}`, args: { method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) } });
        if (path !== "/api/notifications") throw new Error("unexpected_settings_route");
        if (init.method === "PUT") this.acceptNotificationPreferences(JSON.parse(String(init.body)));
        return this.state.notifications;
      },
    };
    root = createRoot(document.getElementById("root")!); root.render(<NotificationSettings connection={connection as unknown as HubConnection}/>);
  },
  async enable() {
    result = "running";
    try {
      const connection = { http: async (path: string) => { native.calls.push({ command: `http ${path}` }); } } as unknown as HubConnection;
      await enableNotifications(connection, { preferences: { enabled: false, quietStart: "", quietEnd: "", timeZone: "UTC" }, providers: { apns: false, fcm: false, webpush: false, unifiedpush: false } }); result = "enabled";
    } catch (error) { result = "failed"; lastError = error instanceof Error ? error.message : String(error); }
  },
  async notify(host = "a") {
    try { await desktopNotification(pushPayloadSchema.parse({ ...protocolNotice, hostId: `hub_${host.repeat(64)}` })); result = "sent"; } catch { result = "failed"; }
  },
  setNoticePreferences(value: { enabled?: boolean; showPreview?: boolean; replyCompleted?: boolean }) { currentPreferences = { ...currentPreferences, ...value }; },
  async notifyCurrent() {
    const message: Message = { id: "private-message", conversationId: "chat", authorId: "bot", authorType: "bot", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "text", text: "Confidential reply" }] };
    const payload = pushPayloadSchema.parse({ ...protocolNotice, hostId: hosts[0]!.id, id: message.id });
    await desktopNotification(payload, () => {
      const notice = currentPreferences.enabled ? desktopNotice(message, currentPreferences) : undefined;
      return notice ? { ...payload, body: notice.body({ title: "Private plan", botName: "Alpha", locale: "en" }) } : undefined;
    });
    result = "settled";
  },
  async clear() { await clearHostPush(hosts[0]!); },
  async clearAll() { await clearLocalPush(); },
  snapshot: () => ({ targets, commands, errors, calls: native.calls, pending: native.pending, result, lastError, observers: [...observed.values()].reduce((sum, items) => sum + items.size, 0) }),
};
Object.assign(window, { desktopNotificationFixture: fixture });
