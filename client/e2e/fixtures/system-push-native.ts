import { plugins, setPlatform } from "./system-push-core.js";
import { native } from "./system-push-notifications.js";
import { currentSystemPushToken } from "../../src/native-push-token.js";
import { maintainSystemPush, stopSystemPushMaintenance } from "../../src/system-push.js";
import { enableNotifications } from "../../src/notifications.js";
import { installNativeEvents } from "../../src/native.js";
plugins.TaroCubShareInbox = { pushTokenSnapshot: () => native.snapshot() };
plugins.TaroCubUnifiedPush = { registerFirebase: async () => { await native.stage("FCM getToken"); return { token: native.token }; } };
const results: Record<string, string> = {}, patches: any[] = [], writes: any[] = [], stops: (() => void)[] = [];
// Undefined models an older Hub without per-App APNs topic routing.
const hub: { topics?: string[] } = { topics: ["com.tarobot.client"] };
let foreground = () => {};
plugins.App = { getInfo: async () => ({ id: "com.tarobot.client" }), getLaunchUrl: async () => undefined, addListener: async (event: string, changed: (value: unknown) => void) => { native.calls.push(event); if (event === "appStateChange") foreground = () => changed({ isActive: true }); return { remove: async () => { if (event === "appStateChange") foreground = () => {}; } }; } };
const api = {
  native, results, patches, writes, hub, setPlatform,
  enable() { void enableNotifications({ http: async (_route: string, init: RequestInit = {}) => { native.calls.push("Hub write"); if (init.body) writes.push(JSON.parse(String(init.body))); } } as any, { providers: { apns: true }, preferences: { enabled: false }, ...(hub.topics ? { apnsTopics: hub.topics } : {}) } as any).then(() => { results.enable = "enabled"; }, (error) => { results.enable = "error"; results.enableError = String(error?.message ?? error); }); },
  read(key: string, refresh = true) { void currentSystemPushToken(refresh).then(token => { results[key] = token; }, () => { results[key] = "error"; }); },
  start() {
    const connection = { state: { status: "online" }, subscribe() { return () => {}; }, async http(route: string, init: RequestInit = {}) { if (init.method === "PATCH") { patches.push(JSON.parse(String(init.body))); return {}; } if (route === "/api/notifications") return { providers: { apns: true }, ...(hub.topics ? { apnsTopics: hub.topics } : {}) }; return { provider: "apns", enabled: true, revision: "binding-1" }; } } as any;
    stops.push(maintainSystemPush(connection));
    stops.push(installNativeEvents(() => {}));
  },
  foreground() { foreground(); },
  cancel() { stopSystemPushMaintenance(); stops.splice(0).forEach(stop => stop()); },
};
Object.assign(window, { systemPushFixture: api });
