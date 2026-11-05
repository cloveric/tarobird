import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { HostApp } from "../../src/HostApp.js";
import { installNativeEvents } from "../../src/native.js";
import { installPushActions, enableNotifications } from "../../src/notifications.js";
import { bridge } from "./native-events-bridge.js";
import { HubConnection } from "../../src/connection.js";
import { ClientCache } from "../../src/storage.js";

let updatesRoot: Root | undefined;
let root: Root | undefined, stops: (() => void)[] = [], generation = 0, resumes = 0;
let workspaceCache: ClientCache | undefined;
let enabling = "idle";
const navigations: unknown[] = [], errors: string[] = [];
window.addEventListener("tarocub-navigate", (event) => navigations.push((event as CustomEvent).detail));
window.addEventListener("unhandledrejection", (event) => { errors.push(String(event.reason)); event.preventDefault(); });
window.addEventListener("error", (event) => errors.push(event.message));
const Empty = () => <div>empty fixture</div>;
const fixture = {
  configure(platform: string, behavior: typeof bridge.behavior = {}, launch?: string) { bridge.platform = platform; bridge.behavior = behavior; bridge.launch = launch; },
  enable() {
    enabling = "running";
    const connection = { http: async (path: string) => { bridge.calls.push(`http ${path}`); } } as unknown as HubConnection;
    void enableNotifications(connection, { preferences: { enabled: false, quietStart: "", quietEnd: "", timeZone: "UTC" }, providers: { apns: true, fcm: false, webpush: false, unifiedpush: false }, apnsTopics: ["com.tarobot.client"] }).then(() => { enabling = "enabled"; }, () => { enabling = "failed"; });
  },
  mountHost() { root = createRoot(document.getElementById("root")!); root.render(<HostApp Workspace={Empty} Pairing={Empty}/>); },
  async mountUpdates() {
    const { AndroidUpdates } = await import("../../src/AndroidUpdates.js");
    const node = document.createElement("div"); node.id = "updates"; document.body.append(node);
    updatesRoot = createRoot(node); updatesRoot.render(<AndroidUpdates/>);
  },
  unmountUpdates() { updatesRoot?.unmount(); updatesRoot = undefined; document.getElementById("updates")?.remove(); },
  async mountWorkspace() {
    const { Workspace } = await import("../../src/App.js");
    workspaceCache = new ClientCache(`native-events-${crypto.randomUUID()}`);
    await workspaceCache.saveConversations(["old", "chosen"].map((id) => ({ id, title: id, type: "direct", ownerId: "owner", botIds: [], archived: false, createdAt: 1 })));
    await workspaceCache.saveSelectedConversation("old");
    const connection = new HubConnection({ deviceId: "fixture", name: "fixture", publicKey: "fixture", routes: [] }, workspaceCache);
    // Real Workspace/cache; no connection, key, native transport, Hub or CLI activity.
    connection.start = async () => {}; connection.resume = () => { resumes++; };
    root = createRoot(document.getElementById("root")!); root.render(<Workspace connection={connection} forget={async () => {}}/>);
  },
  // Accept both old async and new synchronous public APIs for a before/after regression.
  start(kind: "native" | "push") {
    const attempt = generation, result = kind === "native" ? installNativeEvents(() => { resumes++; }) : installPushActions();
    if (typeof result === "function") stops.push(result);
    else Promise.resolve(result).then((cleanup) => { if (attempt !== generation) cleanup(); else stops.push(cleanup); }, (error) => errors.push(String(error)));
  },
  stop() { fixture.unmountUpdates(); generation++; stops.forEach((stop) => stop()); stops = []; root?.unmount(); root = undefined; workspaceCache?.close(); workspaceCache = undefined; },
  emit: (name: string, value: unknown) => bridge.emit(name, value), release: (name: string) => bridge.release(name),
  snapshot: () => ({ resumes, enabling, navigations, errors, calls: bridge.calls, handles: bridge.handles.map(({ name, removeCalls }) => ({ name, removeCalls })) }),
};
Object.assign(window, { nativeEventsFixture: fixture });
