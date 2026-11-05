import { mockIPC } from "@tauri-apps/api/mocks";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { decodeQrImage } from "../../src/qr-image.js";
import type { HubConnection } from "../../src/connection.js";
import type { Route } from "../../src/storage.js";
import { LocalConnectionSettings } from "../../src/LocalConnectionSettings.js";
import { DesktopHostInvite } from "../../src/DesktopHostInvite.js";
import { CreationDialog as FlowDialog } from "../../src/CreationDialog.js";
import { setLocale } from "../../src/i18n.js";
import { HOST_ROUTES_PATH } from "../../../src/client-protocol/host-routes.js";
import { inviteApiFixture } from "./invite-api.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/device-settings.css";

const key = `MCowBQYDK2VwAyEA${"h".repeat(44)}`;
const root = createRoot(document.getElementById("root")!);
const invites = inviteApiFixture();
const inviteConnection = { identity: { deviceId: "tailscale-fixture", hubPublicKey: key },
  state: { status: "online", user: { role: "owner" }, pairingInvitesAvailable: true, networkAvailable: false },
  subscribe: () => () => {}, http: invites.http } as unknown as HubConnection;
const state = { calls: [] as string[], fail: false, unpublished: false, wrongHost: false, statusFail: false, statusWrongHost: false, legacy: false, reads: 0, local: { lan: { enabled: true, listening: true }, tailscale: { enabled: false, listening: false } }, certificateAuthority: "", hold: undefined as undefined | (() => void) };
mockIPC(async (command, args) => {
  if (command !== "desktop_host") throw Error("unexpected_command");
  const action = String(args?.action); state.calls.push(action);
  if (action === "status") return { running: true, publicKey: state.wrongHost ? "wrong-host" : key };
  if (state.hold) await new Promise<void>(resolve => { state.hold = resolve; });
  if (state.fail) throw Error("desktop_host_operation_failed");
  state.local[action === "tailscale" ? "tailscale" : "lan"] = { enabled: true, listening: true };
  return { running: true, publicKey: key, routes: [{ name: action === "tailscale" ? "Tailscale" : "Direct", url: action === "tailscale" ? "https://100.101.102.103:8788" : "https://192.168.10.20:8788", certificateAuthority: state.certificateAuthority }] };
});
const render = () => root.render(<FlowDialog title="添加设备" close={() => root.render(null)} className="pairing-wizard"><div className="settings-invite"><DesktopHostInvite hubKey={key} connection={inviteConnection}/></div></FlowDialog>);
const shared: Route[] = [{ name: "Tailscale", url: "https://100.101.102.103:8788" }];
const networkCalls: unknown[] = [];
let routeRelease: (() => void) | undefined;
let holdRoutes = false;
const renderNetwork = (purpose: "pairing" | "network" = "network") => {
  const connection = { identity: { deviceId: "tailscale-network-fixture", hubPublicKey: key }, state: { status: "online", user: { role: "owner" }, pairingInvitesAvailable: true, hostRoutesAvailable: true, networkAvailable: true, network: { host: { routes: shared } } }, subscribe: () => () => {}, http: async (path: string, init?: RequestInit) => path !== HOST_ROUTES_PATH ? invites.http(path, init) : ({ v: 1, hostPublicKey: key,
    routes: state.unpublished ? [] : [{ source: "managed", route: { name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority: state.certificateAuthority } }],
    local: { lan: { enabled: true, listening: true }, tailscale: { enabled: true, listening: true } }, notices: [], observedAt: Date.now() }), refreshNetwork: async () => ({ host: { routes: shared } }), networkCommand: async (command: { routes: Route[] }) => { networkCalls.push(command); if (holdRoutes) await new Promise<void>(resolve => { routeRelease = resolve; }); shared.splice(0, shared.length, ...command.routes); } } as unknown as HubConnection;
  root.render(<FlowDialog title="本机连接" close={() => root.render(null)}><DesktopHostInvite key="network" hubKey={key} connection={connection} purpose={purpose}/></FlowDialog>);
};
const settingsConnection = {
  identity: { hubPublicKey: key }, state: { status: "online", user: { role: "owner" }, hostRoutesAvailable: true, networkAvailable: true },
  subscribe: () => () => {},
  http: async () => { ++state.reads; if (state.statusFail) throw Error("read_failed"); return { v: 1, hostPublicKey: state.statusWrongHost ? "other-host" : key,
    routes: [{ source: "shared", route: shared[0] }, { source: "managed", route: { name: "Direct", url: "https://192.168.10.20:8788" } }], local: state.local, notices: [], observedAt: Date.now() }; },
  refreshNetwork: async () => ({ host: { routes: shared } }),
  networkCommand: async (command: { routes: Route[] }) => { networkCalls.push(command); if (holdRoutes) await new Promise<void>(resolve => { routeRelease = resolve; }); }
} as unknown as HubConnection;
function SettingsDialog() {
  const [busy, setBusy] = useState(false);
  return <FlowDialog title="局域网与 Tailscale" busy={busy} closeLabel="关闭本机对外连接" close={() => root.render(null)}><LocalConnectionSettings connection={settingsConnection} busyChange={setBusy}/></FlowDialog>;
}
const renderSettings = () => { settingsConnection.state.hostRoutesAvailable = !state.legacy; root.render(<SettingsDialog/>); };
// Exercise the same bounded pixel samplers as a real imported pairing image.
const decode = async () => {
  const image = document.querySelector(".pair-qr") as HTMLImageElement;
  return await decodeQrImage(image.src, () => true);
};
Object.assign(window, { tailscaleFixture: { state, invites, render, renderNetwork, renderSettings, networkCalls, decode, setLocale, holdRoutes() { holdRoutes = true; }, releaseRoutes() { holdRoutes = false; routeRelease?.(); } } });
