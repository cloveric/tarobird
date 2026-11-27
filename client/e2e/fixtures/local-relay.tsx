import { mockIPC } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { cloudflareCommands, HOST_CLOUDFLARE_PATH, type CloudflareQuickAction, type CloudflareUpdate, type CloudflareView } from "../../../src/client-protocol/cloudflare.js";
import { ConnectionPanel } from "../../src/ConnectionPanel.js";
import { HubHttpError } from "../../src/http-error.js";
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
const defaultCloudflare = (): CloudflareView => ({
  v: 1,
  installed: true,
  version: "cloudflared version 2026.1.0",
  running: false,
  mode: "named",
  protocol: "http2",
  origins: [],
  loopbackTarget: "http://127.0.0.1:8790",
  commands: cloudflareCommands("http://127.0.0.1:8790"),
});
const state = {
  reads: 0, writes: [] as unknown[], updates: 0, native: [] as string[], health: [] as string[],
  failRead: false, failWrite: false, wrongHost: false, offlineRelay: false, hold: false, release: undefined as (() => void) | undefined,
  cloudflare: defaultCloudflare(),
  cloudflareReads: 0, cloudflareWrites: [] as unknown[], cloudflareQuickActions: [] as unknown[],
  cloudflare404: false, cloudflareFailQuick: "" as string,
};
const view = () => ({ host: { publicKey: key, routes: [direct] as Route[], name: "ASUS", state: "active" as const, revoked: false }, sync: "standalone" as const, lastSyncedAt: 0 });
const connection = {
  identity: { hubPublicKey: key, routes: [local], name: "ASUS", deviceId: "local" },
  state: { status: "online", route: local, user: { role: "owner" }, pairingInvitesAvailable: true, networkAvailable: true, cloudflareRoutesAvailable: true, network: view() },
  http: async (path: string, init?: RequestInit) => {
    if (path === HOST_CLOUDFLARE_PATH) {
      if (state.cloudflare404) throw new HubHttpError(404, "not_found");
      state.cloudflareReads++;
      return structuredClone(state.cloudflare);
    }
    return invites.http(path, init);
  },
  updateCloudflareSettings: async (patch: CloudflareUpdate) => {
    if (state.cloudflare404) throw new HubHttpError(404, "not_found");
    state.cloudflareWrites.push(patch);
    state.cloudflare = {
      ...state.cloudflare,
      ...(patch.mode ? { mode: patch.mode } : {}),
      ...(patch.protocol ? { protocol: patch.protocol } : {}),
      ...(patch.origins ? { origins: patch.origins } : {}),
    };
    return structuredClone(state.cloudflare);
  },
  cloudflareQuickAction: async (body: CloudflareQuickAction) => {
    if (state.cloudflare404) throw new HubHttpError(404, "not_found");
    state.cloudflareQuickActions.push(body);
    if (state.cloudflareFailQuick) throw new HubHttpError(502, state.cloudflareFailQuick);
    if (body.action === "start") {
      state.cloudflare = {
        ...state.cloudflare,
        mode: "quick",
        protocol: body.protocol ?? state.cloudflare.protocol,
        running: true,
        activeUrl: "https://demo-quick.trycloudflare.com",
      };
    } else {
      const next = { ...state.cloudflare, running: false };
      delete next.activeUrl;
      state.cloudflare = next;
    }
    return structuredClone(state.cloudflare);
  },
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
