import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useWorkbenchDesignOpener } from "../../src/use-workbench-design-opener.js";
import type { HubConnection } from "../../src/connection.js";
import type { WorkbenchRegistration } from "../../../src/client-protocol/workbench.js";

const query = new URLSearchParams(location.search), listeners = new Set<(value: unknown) => void>();
const registrations = new Map<string, WorkbenchRegistration>(), sent: any[] = [], reads: Array<() => void> = [];
const changes = new Set<() => void>(), commands = new Set<(value: any) => void>();
const fixture = {
  registrations, sent, reads, opens: 0,
  emit(value: unknown) { for (const fn of listeners) fn(value); },
  resolveRead() { for (const resolve of reads.splice(0)) resolve(); },
  command() {
    const registration = [...registrations.values()][0]; if (!registration) throw new Error("No opener");
    const frame = { v: 1, type: "workbench.command", dispatchId: "queued", deadline: Date.now() + 10000,
      userId: "owner", conversationId: "chat", generation: registration.generation,
      target: { deviceId: "desktop", windowId: registration.windowId }, request: { requestId: "queued", operation: "design.open", payload: {} } };
    for (const fn of [...commands]) fn(frame);
  },
};
if (!query.has("web")) window.tarobotDesktop = {
  version: 1, engine: "electron", platform: "darwin", openSocket: async () => {},
  on(event, fn) { if (query.has("broken")) throw new Error("broken events"); if (event === "window-state") listeners.add(fn); return () => { listeners.delete(fn); }; },
  async invoke<T>(command: string) {
    if (command !== "desktop_window_read") throw new Error(command);
    if (query.has("delayed")) await new Promise<void>(resolve => reads.push(resolve));
    return { visible: !query.has("hidden"), minimized: false } as T;
  },
};
const connection = {
  identity: { deviceId: "desktop", hubPublicKey: "host" }, sessionEpoch: 1, isClosed: false, isReadOnly: false,
  state: { status: "online", user: { id: "owner" }, workbenchDesignOpenAvailable: true },
  subscribe(fn: () => void) { changes.add(fn); return () => { changes.delete(fn); }; },
  subscribeWorkbench(fn: (value: any) => void) { commands.add(fn); return () => { commands.delete(fn); }; },
  async send(value: any) {
    sent.push(value);
    if (value.type === "workbench.register") registrations.set(value.registration.windowId, value.registration);
    if (value.type === "workbench.unregister") registrations.delete(value.windowId);
  },
  async http(url: string) {
    if (url.endsWith("/targets")) return [...registrations.values()].map(value => ({ ...value, deviceId: "desktop" }));
    throw new Error("Unexpected HTTP request");
  },
} as unknown as HubConnection;
function App() {
  const opener = useWorkbenchDesignOpener(connection, "chat", true, false, async () => { fixture.opens++; throw new Error("No actual editor in visibility fixture"); });
  Object.assign(fixture, { context: opener.context });
  return <p>Visibility hook mounted</p>;
}
Object.assign(window, { designVisibility: fixture });
createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
