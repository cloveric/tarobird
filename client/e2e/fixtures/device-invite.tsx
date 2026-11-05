import { randomNonce } from "../../src/identity.js";
import { PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH } from "../../../src/client-protocol/pairing-invites.js";
import { mockIPC } from "@tauri-apps/api/mocks";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { createRoot } from "react-dom/client";
import { decodeQrImage } from "../../src/qr-image.js";
import { HubHttpError } from "../../src/http-error.js";
import type { HubConnection } from "../../src/connection.js";
import { DeviceInviteCode } from "../../src/DeviceInviteCode.js";
import { setLocale } from "../../src/i18n.js";
import { HOST_ROUTES_PATH } from "../../../src/client-protocol/host-routes.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/device-settings.css";

// A host as the inviting device sees it. Every request and native call is
// recorded, so the spec can assert that showing a code never changes a host.
type Route = { name: "Direct" | "Tailscale" | "VPS"; url: string; certificateAuthority?: string };
type Mode = { enabled: boolean; listening: boolean };
export type HostSpec = {
  key: string;
  pairingInvitesAvailable?: boolean;
  inviteTtl?: number;
  holdInvite?: boolean;
  status?: "online" | "offline" | "connecting";
  role?: "owner" | "member";
  hostRoutesAvailable?: boolean;
  /** Routes this device itself saved for the host (its own connection). */
  identityRoutes?: Route[];
  activeUrl?: string;
  /** The host's own answer to the owner-only route view. */
  view?: { hostPublicKey?: string; routes: { source: "shared" | "managed"; route: Route }[]; lan?: Mode; tailscale?: Mode; notices?: string[] };
  /** Number of initial route reads that fail before one succeeds. */
  failures?: number;
  /** Keep the next route read pending until released. */
  hold?: boolean;
  /** Hosts that predate private-network sync cannot publish routes. */
  networkAvailable?: boolean;
};
type Fake = { connection: HubConnection; release(): void; update(patch: Record<string, unknown>): void };

const log = { http: [] as { host: string; path: string; method: string }[], network: [] as { host: string; operation: string }[], ipc: [] as string[], busy: false };
const hosts = new Map<string, Fake>();
const root = createRoot(document.getElementById("root")!);
let localKey = "", certificateAuthority = "", clipboard = "";

// `?platform=ios|android` stands in for a phone shell with a mocked Photos
// plugin. Nothing is written to a real photo library.
const nativeShell = new URLSearchParams(location.search).get("platform");
const photos = { mode: "grant" as "grant" | "deny" | "fail" | "hold", calls: [] as { data: string; name: string }[], waiting: [] as (() => void)[] };
if (nativeShell === "ios" || nativeShell === "android") {
  Capacitor.isNativePlatform = () => true; Capacitor.getPlatform = () => nativeShell;
  registerPlugin("TaroBotQrPhotos", { web: async () => ({ save: async (args: { data: string; name: string }) => {
    photos.calls.push(args);
    if (photos.mode === "hold") await new Promise<void>(resolve => photos.waiting.push(resolve));
    if (photos.mode === "deny") throw new Error("photos_permission_denied");
    if (photos.mode === "fail") throw new Error("photos_save_failed");
    return { saved: true };
  } }) });
}
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { clipboard = text; } } });
mockIPC(async (command, args) => {
  if (command !== "desktop_host") throw Error("unexpected_command");
  const action = String((args as { action?: unknown } | undefined)?.action); log.ipc.push(action);
  if (action === "status") return { running: true, publicKey: localKey };
  return { running: true, publicKey: localKey, routes: [{ name: action === "tailscale" ? "Tailscale" : "Direct", url: action === "tailscale" ? "https://100.101.102.103:8788" : "https://192.168.10.20:8788", certificateAuthority }] };
});

function fake(label: string, spec: HostSpec): Fake {
  const listeners = new Set<() => void>(), waiting: (() => void)[] = [];
  let failures = spec.failures ?? 0, hold = !!spec.hold, holdInvite = !!spec.holdInvite;
  const invites = new Map<string, { id: string; invite: string; createdAt: number; expiresAt: number; state: string }>();
  const connection = {
    identity: { deviceId: `device-${label}`, hubPublicKey: spec.key, routes: spec.identityRoutes ?? [{ name: "Direct", url: "https://127.0.0.1:8788" }], deployment: "computer" },
    state: {
      status: spec.status ?? "online", pairingInvitesAvailable: spec.pairingInvitesAvailable ?? true, user: { id: "owner", name: "我", role: spec.role ?? "owner" }, hostRoutesAvailable: spec.hostRoutesAvailable ?? true, networkAvailable: spec.networkAvailable ?? true,
      route: spec.activeUrl ? { name: "Direct", url: spec.activeUrl } : undefined, network: { sync: "standalone", host: { publicKey: spec.key, name: label, routes: [] } }, bots: [], outbox: 0, cacheRevision: 0,
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Deliberately ignores the abort signal: a late transport answer must
    // still be ignored by the component, not by this fake.
    async http(path: string, init: RequestInit = {}) {
      log.http.push({ host: label, path, method: (init.method ?? "GET").toUpperCase() });
      if (path === PAIRING_INVITES_PATH) {
        if (init.method === "POST") {
          if (holdInvite) await new Promise<void>(resolve => waiting.push(resolve));
          const body = JSON.parse(String(init.body));
          if (body.replaces && invites.has(body.replaces)) invites.get(body.replaces)!.state = "closed";
          const id = randomNonce().slice(0, 22), invite = randomNonce(), serverTime = Date.now(), expiresAt = serverTime + (spec.inviteTtl ?? 300_000);
          invites.set(id, { id, invite, createdAt: serverTime, expiresAt, state: "available" });
          return { id, invite, serverTime, expiresAt };
        }
        return { invites: [...invites.values()].map(({ invite: _secret, ...item }) => ({ ...item, state: item.expiresAt <= Date.now() ? "expired" : item.state })), serverTime: Date.now() };
      }
      if (path === PAIRING_INVITE_REVOKE_PATH) {
        const item = invites.get(JSON.parse(String(init.body)).id); if (item) item.state = "closed";
        return item ? { id: item.id, state: item.state, createdAt: item.createdAt, expiresAt: item.expiresAt } : {};
      }
      if (path !== HOST_ROUTES_PATH) throw new HubHttpError(404, "not_found");
      if (hold) await new Promise<void>(resolve => waiting.push(resolve));
      if (failures > 0) { failures--; throw new HubHttpError(503, "host_routes_unavailable"); }
      const view = spec.view ?? { routes: [] };
      return { v: 1, hostPublicKey: view.hostPublicKey ?? spec.key, routes: view.routes, local: { lan: view.lan ?? { enabled: false, listening: false }, tailscale: view.tailscale ?? { enabled: false, listening: false } }, notices: view.notices ?? [], observedAt: Date.now() };
    },
    async refreshNetwork() { log.network.push({ host: label, operation: "refresh" }); return connection.state.network; },
    async networkCommand(command: { operation: string }) { log.network.push({ host: label, operation: command.operation }); return { view: connection.state.network }; },
  };
  return {
    connection: connection as unknown as HubConnection,
    release() { hold = false; holdInvite = false; waiting.splice(0).forEach(resolve => resolve()); },
    update(patch) { connection.state = { ...connection.state, ...patch } as typeof connection.state; listeners.forEach(listener => listener()); },
  };
}
function show(label: string, localHost = false) {
  const host = hosts.get(label)!;
  if (localHost) localKey = host.connection.identity.hubPublicKey!;
  root.render(<main className="settings-invite"><DeviceInviteCode connection={host.connection} localHost={localHost} busyChange={busy => { log.busy = busy; }}/></main>);
}

// Exercise the same bounded pixel samplers as an imported pairing image.
async function decodeAll(): Promise<string[]> {
  const images = [...document.querySelectorAll<HTMLImageElement>(".pair-qr")].filter(image => image.getClientRects().length);
  const links = await Promise.all(images.map(image => decodeQrImage(image.src, () => true)));
  // An undecodable code is reported, not silently dropped.
  return links.map(link => link ?? "undecodable");
}

Object.assign(window, { inviteFixture: {
  configure(ca: string) { certificateAuthority = ca; },
  add(label: string, spec: HostSpec) { hosts.set(label, fake(label, spec)); },
  show, decodeAll, setLocale,
  photos: { mode(mode: typeof photos.mode) { photos.mode = mode; }, calls: () => structuredClone(photos.calls), release() { photos.waiting.splice(0).forEach(resolve => resolve()); } },
  release(label: string) { hosts.get(label)!.release(); },
  update(label: string, patch: Record<string, unknown>) { hosts.get(label)!.update(patch); },
  calls: () => structuredClone(log),
  copied: () => clipboard,
} });
