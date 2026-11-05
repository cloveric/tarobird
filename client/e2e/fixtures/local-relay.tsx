import { mockIPC } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { ConnectionPanel } from "../../src/ConnectionPanel.js";
import { RuntimeHostContext } from "../../src/RuntimeHost.js";
import { setLocale } from "../../src/i18n.js";
import { installFocusIntent } from "../../src/focus-intent.js";
import type { HubConnection } from "../../src/connection.js";
import type { Route } from "../../src/storage.js";
import { inviteApiFixture } from "./invite-api.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/viewport.css";

installFocusIntent();
Object.assign(window, { isTauri: true });
const key = `MCowBQYDK2VwAyEA${"a".repeat(43)}=`;
const direct: Route = { name: "Tailscale", url: "https://100.101.102.103:8788" };
const local: Route = { name: "Direct", url: "http://127.0.0.1:8788" };
const listeners = new Set<() => void>();
const invites = inviteApiFixture();
const state = { reads: 0, writes: [] as unknown[], updates: 0, native: [] as string[], health: [] as string[], failRead: false, failWrite: false, wrongHost: false, offlineRelay: false, hold: false, release: undefined as (() => void) | undefined };
const view = () => ({ host: { publicKey: key, routes: [direct] as Route[], name: "ASUS", state: "active" as const, revoked: false }, sync: "standalone" as const, lastSyncedAt: 0 });
const connection = {
  identity: { hubPublicKey: key, routes: [local], name: "ASUS", deviceId: "local" },
  state: { status: "online", route: local, user: { role: "owner" }, pairingInvitesAvailable: true, networkAvailable: true, network: view() },
  http: invites.http,
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  refreshNetwork: async () => { state.reads++; if (state.failRead) throw Error("fixture_read_failure"); return connection.state.network; },
  networkCommand: async (command: { routes: Route[] }) => { state.writes.push(command); if (state.hold) await new Promise<void>(resolve => { state.release = resolve; }); if (state.failWrite) throw Error("fixture_write_failure"); connection.state = { ...connection.state, network: { ...connection.state.network, host: { ...connection.state.network.host, routes: command.routes } } }; listeners.forEach(listener => listener()); return { view: connection.state.network }; },
  updateRoutes: async () => { state.updates++; throw Error("local_routes_must_not_change"); },
} as unknown as HubConnection;
mockIPC((command, args) => { if (command === "desktop_host") { state.native.push(String(args?.action)); return { running: true, publicKey: key }; } throw Error("unexpected_native_operation"); });
const fetchOriginal = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://") && url.endsWith("/health")) { state.health.push(url); if (state.offlineRelay) throw Error("offline"); return new Response(JSON.stringify({ publicKey: state.wrongHost ? "other-host" : key }), { status: 200 }); }
  return fetchOriginal(input, init);
};
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<RuntimeHostContext.Provider value="ASUS"><ConnectionPanel connection={connection} close={() => root.render(null)}/></RuntimeHostContext.Provider>);
Object.assign(window, { localRelayFixture: { state, connection, invites, render, setLocale, key, notify: () => listeners.forEach(listener => listener()) } });
render();
