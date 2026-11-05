import { enableNotifications, clearHostPush, type NotificationState } from "../../src/notifications.js";
import { runtimeHostId, type RuntimeHost } from "../../src/host-registry.js";
import type { HubConnection } from "../../src/connection.js";

// Protocol fixture only: browser push services and Hub receipts are substituted.
// This does not claim actual OS/background push delivery.
const workers = new Map<string, ServiceWorkerRegistration>();
const receipts: { key: string; path: string; body: unknown }[] = [];
const removed: string[] = [], registrations: string[] = [];
const root = new URL("/", location.href).href;
const makeWorker = (scope: string): ServiceWorkerRegistration => {
  let subscription: PushSubscription | null = null;
  return { scope, active: {}, pushManager: {
    getSubscription: async () => subscription,
    subscribe: async () => { subscription = { toJSON: () => ({ endpoint: `https://push.example.test/${scope.split("/").filter(Boolean).at(-1)}`, keys: { auth: "test-auth", p256dh: "test-key" } }), unsubscribe: async () => { removed.push(scope); subscription = null; return true; } } as unknown as PushSubscription; return subscription; },
  }, getNotifications: async () => [], unregister: async () => workers.delete(scope) } as unknown as ServiceWorkerRegistration;
};
workers.set(root, makeWorker(root));
Object.defineProperty(navigator, "serviceWorker", { value: {
  register: async (_script: string, options: RegistrationOptions) => { const scope = new URL(options.scope!, location.href).href; registrations.push(scope); if (!workers.has(scope)) workers.set(scope, makeWorker(scope)); return workers.get(scope); },
  getRegistration: async (scope: string) => workers.get(scope) ?? workers.get(root),
} });
Object.assign(window, { PushManager: class {}, Notification: { permission: "granted", requestPermission: async () => "granted" } });
const state: NotificationState = { preferences: { enabled: false, quietStart: "", quietEnd: "", timeZone: "UTC" }, providers: { webpush: true, fcm: false, apns: false, unifiedpush: false }, vapidPublicKey: "AQID" };
Object.assign(window, { hostPushFixture: {
  enable: (key: string) => enableNotifications({ identity: { hubPublicKey: key }, http: async (path: string, init: RequestInit) => { receipts.push({ key, path, body: JSON.parse(String(init.body)) }); } } as unknown as HubConnection, state),
  remove: (key: string) => clearHostPush({ id: runtimeHostId(key) } as RuntimeHost),
  snapshot: () => ({ scopes: [...workers.keys()], removed, registrations, receipts }),
} });
