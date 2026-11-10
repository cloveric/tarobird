// The host's own 本机连接 list: loopback plus the LAN/Tailscale entries that
// other devices use. Addresses are reserved/example values only.
import { createRoot } from "react-dom/client";
import { RoutesEditor } from "../../src/RoutesEditor.js";
import type { HubConnection } from "../../src/connection.js";
import type { HostRouteNotice } from "../../../src/client-protocol/host-routes.js";
import { setLocale } from "../../src/i18n.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/device-settings.css";
import "../../src/connection-panel.css";

const loopback = { name: "Direct" as const, url: "http://127.0.0.1:8788" };
const authority = "A".repeat(120);
const listeners = new Set<() => void>();
const local = { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } };
let notices: HostRouteNotice[] = [];
const connection = {
  identity: { deviceId: "fixture", publicKey: "fixture-device", name: "Host", hubPublicKey: `MCowBQYDK2VwAyEA${"h".repeat(44)}`, routes: [loopback], deployment: "computer" },
  state: { cacheRevision: 0, bots: [], avatars: [], outbox: 0, status: "online", route: loopback, latency: 3, routeHealth: [], hostRoutesAvailable: true, user: { id: "owner", name: "Owner", role: "owner" } },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async http() {
    return { v: 1, hostPublicKey: connection.identity.hubPublicKey, observedAt: Date.now(), notices: [...notices, ...(local.tailscale.enabled && !local.tailscale.listening ? ["tailscale_not_listening"] : [])], local: structuredClone(local), routes: [
      { source: "managed", route: { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: authority } },
      { source: "shared", route: { name: "Tailscale", url: "https://100.64.0.1:8788", certificateAuthority: authority } },
    ] };
  },
};
const root = createRoot(document.getElementById("root")!);
const render = () => root.render(<main style={{ maxWidth: 800, margin: "24px auto", padding: 16 }}><RoutesEditor key={JSON.stringify([local, notices])} connection={connection as unknown as HubConnection} localHost configureLocal={() => undefined}/></main>);
render();
Object.assign(window, { hostEntriesFixture: { setLocale, set(next: Partial<typeof local>) { Object.assign(local, next); render(); }, setNotices(value: HostRouteNotice[]) { notices = value; render(); } } });
