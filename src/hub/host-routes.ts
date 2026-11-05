import { createHash, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { z } from "zod";
import { hostRoutesViewSchema, type HostRouteNotice, type HostRoutesView } from "../client-protocol/host-routes.js";
import { isLoopbackOrUnspecified } from "../client-protocol/loopback-address.js";
import { networkCanonical, sharedRoutesSchema } from "../client-protocol/private-network.js";
import { routeSchema, type Route } from "../client-protocol/routes.js";
import { isTailscaleAddress } from "./network.js";
import type { PrivateNetwork } from "./private-network.js";
import { HubError, type HubStore } from "./store.js";

/** Separate from `private-network:v1`, which older Hubs must still parse. */
export const HOST_ROUTES_KEY = "host-routes:v1";
/** Minimum spacing between published address replacements. */
export const HOST_ROUTE_COOLDOWN_MS = 5 * 60_000;
/** Consecutive listener-refresh observations required before a replacement. */
export const HOST_ROUTE_CONFIRMATIONS = 2;
export type HostRouteMode = "lan" | "tailscale";
const MODES = ["lan", "tailscale"] as const;
/** A desktop-managed TLS listener as currently configured in this Hub. */
export type ManagedListener = { host: string; port: number; listening: boolean; authority?: string; interfaceKey?: string };

export const desktopNetworkFile = (directory: string, mode: HostRouteMode): string => path.join(directory, mode === "lan" ? "desktop-network-enabled.json" : "desktop-tailscale-enabled.json");
export async function desktopNetworkOptIn(directory: string): Promise<Record<HostRouteMode, boolean>> {
  const read = (mode: HostRouteMode) => readFile(desktopNetworkFile(directory, mode), "utf8").then(value => value.trim() === "true", () => false);
  return { lan: await read("lan"), tailscale: await read("tailscale") };
}

/** The private CA that issued the leaf actually served by a managed listener.
 * Only public certificate material is returned; the leaf must verify under it. */
export function certificateAuthorityFromChain(chain: unknown): string | undefined {
  const text = Buffer.isBuffer(chain) ? chain.toString("utf8") : typeof chain === "string" ? chain : undefined;
  const blocks = text?.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length < 2) return;
  try {
    const leaf = new X509Certificate(blocks[0]!), authority = new X509Certificate(blocks.at(-1)!);
    if (!authority.ca || !leaf.checkIssued(authority) || !leaf.verify(authority.publicKey)) return;
    return authority.raw.toString("base64");
  } catch { return; }
}

/** Managed listeners are created only from detected LAN/Tailscale addresses;
 * loopback, unspecified or non-literal binds are never published. */
export function managedRouteMode(host: string): HostRouteMode | undefined {
  if (!isIP(host) || isLoopbackOrUnspecified(host)) return;
  if (isTailscaleAddress(host)) return "tailscale";
  // Match desktopLanAddresses exactly. An owner can configure a public Direct
  // IP using the same CA/port; that is not a desktop-managed LAN address.
  return isIPv4(host) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ? "lan" : undefined;
}
/** Host-private interface lineage. Never sent in route views or signed manifests.
 * Without a unique interface/MAC observation, an address change needs owner review. */
export function lanInterfaceKey(host: string, interfaces = networkInterfaces()): string | undefined {
  const matches = Object.entries(interfaces).filter(([, addresses]) => addresses?.some(address => !address.internal && address.family === "IPv4" && address.address === host));
  if (matches.length !== 1) return;
  const [name, addresses] = matches[0]!, mac = addresses?.find(address => address.address === host)?.mac.toLowerCase();
  if (!mac || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) || mac === "00:00:00:00:00:00") return;
  return createHash("sha256").update(`${name}|${mac}`).digest("hex");
}
function managedOrigin(host: string, port: number): string { return new URL(`https://${host.includes(":") ? `[${host}]` : host}:${port}`).origin; }
function managedRoute(mode: HostRouteMode, listener: ManagedListener): Route {
  return routeSchema.parse({ name: mode === "tailscale" ? "Tailscale" : "Direct", url: managedOrigin(listener.host, listener.port), certificateAuthority: listener.authority });
}

const candidateSchema = z.object({ url: z.string(), seen: z.number().int().min(1).max(HOST_ROUTE_CONFIRMATIONS) }).strict();
const modeRecordSchema = z.object({ route: routeSchema, seen: z.number().int().min(0).max(HOST_ROUTE_CONFIRMATIONS), candidate: candidateSchema.optional(), interfaceKey: z.string().min(1).max(128).optional(), replaces: z.string().optional() }).strict();
const recordSchema = z.object({
  v: z.literal(1), modes: z.object({ lan: modeRecordSchema.optional(), tailscale: modeRecordSchema.optional() }).strict(),
  changedAt: z.number().int().nonnegative(), sharedAt: z.number().int().nonnegative(), lanNeedsSelection: z.boolean().optional(),
}).strict();
export type HostRoutesRecord = z.infer<typeof recordSchema>;
export const emptyHostRoutesRecord = (): HostRoutesRecord => ({ v: 1, modes: {}, changedAt: 0, sharedAt: 0 });

/** Pure per-tick observation. The first unique listening address of a mode is
 * published at once; a later different address must be the unique candidate on
 * consecutive ticks and respect the cooldown. Absent interfaces (sleep, Wi-Fi
 * off) and ambiguous LAN candidates (VM/Docker bridges) never change anything. */
export function observeHostRoutes(previous: HostRoutesRecord, listeners: readonly ManagedListener[], enabled: Record<HostRouteMode, boolean>, now: number, shared: readonly Route[] = []): { record: HostRoutesRecord; notices: HostRouteNotice[] } {
  const record: HostRoutesRecord = structuredClone(previous), notices: HostRouteNotice[] = [];
  for (const mode of MODES) {
    if (!enabled[mode]) continue;
    let entry = record.modes[mode];
    const live = listeners.filter(listener => listener.listening && listener.authority && managedRouteMode(listener.host) === mode);
    const preferred = mode === "tailscale" && live.some(listener => isIPv4(listener.host)) ? live.filter(listener => isIPv4(listener.host)) : live;
    const routeListeners = new Map(preferred.map(listener => [managedOrigin(listener.host, listener.port), listener]));
    const routes = [...routeListeners.values()].map(listener => managedRoute(mode, listener));
    // An explicit shared LAN route wins over co-resident VM/VPN interfaces.
    // If that configured origin is absent, do not seed from a different adapter.
    const selected = mode === "lan" ? shared.find(route => route.name === "Direct" && managedRouteMode(new URL(route.url).hostname) === "lan") : undefined;
    const chosen = selected && routes.find(route => route.url === selected.url && route.certificateAuthority === selected.certificateAuthority);
    // Remember ambiguity across disconnects/restarts. A bridge becoming the
    // only remaining adapter is not evidence that the owner selected it.
    if (chosen) delete record.lanNeedsSelection;
    if (mode === "lan" && !entry && !chosen && (routes.length > 1 || record.lanNeedsSelection)) {
      record.lanNeedsSelection = true;
      notices.push("lan_selection_required");
      continue;
    }
    if (chosen && chosen.url !== entry?.route.url) {
      record.modes[mode] = { route: chosen, seen: 1, interfaceKey: routeListeners.get(chosen.url)?.interfaceKey }; record.changedAt = now;
      continue;
    }
    const current = entry && routes.find(route => route.url === entry!.route.url);
    const currentKey = current && routeListeners.get(current.url)?.interfaceKey;
    if (current && (mode !== "lan" || !entry!.interfaceKey || currentKey === entry!.interfaceKey)) {
      record.modes[mode] = { ...entry!, route: current, seen: Math.min(entry!.seen + 1, HOST_ROUTE_CONFIRMATIONS), candidate: undefined, ...(mode === "lan" ? { interfaceKey: currentKey } : {}) };
      continue;
    }
    const candidates = mode !== "lan" || !entry ? routes : entry.interfaceKey ? routes.filter(route => routeListeners.get(route.url)?.interfaceKey === entry!.interfaceKey) : [];
    if (candidates.length !== 1 || mode === "lan" && !entry && selected && !chosen) {
      if (entry) record.modes[mode] = { ...entry, seen: 0, candidate: undefined };
      notices.push(mode === "lan" && routes.length ? "lan_selection_required" : mode === "lan" ? "lan_not_listening" : "tailscale_not_listening");
    } else if (!entry) {
      record.modes[mode] = { route: candidates[0]!, seen: 1, ...(mode === "lan" ? { interfaceKey: routeListeners.get(candidates[0]!.url)?.interfaceKey } : {}) }; record.changedAt = now;
    } else {
      const candidate = candidates[0]!, seen = entry.candidate?.url === candidate.url ? Math.min(entry.candidate.seen + 1, HOST_ROUTE_CONFIRMATIONS) : 1;
      if (seen >= HOST_ROUTE_CONFIRMATIONS && now - record.changedAt >= HOST_ROUTE_COOLDOWN_MS) {
        record.modes[mode] = { route: candidate, seen: HOST_ROUTE_CONFIRMATIONS, ...(mode === "lan" ? { interfaceKey: entry.interfaceKey, replaces: entry.route.url } : {}) }; record.changedAt = now;
      } else {
        record.modes[mode] = { ...entry, seen: 0, candidate: { url: candidate.url, seen } };
        notices.push("replacement_pending");
      }
    }
  }
  return { record, notices: [...new Set(notices)] };
}

/** B7 fence for the signed single-direct descriptor. Only a stale route that
 * this desktop manages (same CA, managed port, same address class) is replaced,
 * and only by a confirmed, currently listening address. Never adds a route. */
export function sharedRouteReplacement(shared: readonly Route[], record: HostRoutesRecord, listeners: readonly ManagedListener[]): Route[] | undefined {
  const direct = shared.find(route => route.name !== "VPS");
  if (!direct) return;
  const url = new URL(direct.url), mode = managedRouteMode(url.hostname.replace(/^\[|\]$/g, ""));
  const entry = mode && record.modes[mode];
  if (!entry || entry.seen < HOST_ROUTE_CONFIRMATIONS || entry.route.url === direct.url) return;
  if (mode === "lan" && (!entry.interfaceKey || entry.replaces !== direct.url || !listeners.some(listener => listener.listening && managedOrigin(listener.host, listener.port) === entry.route.url && listener.interfaceKey === entry.interfaceKey))) return;
  if (url.port !== new URL(entry.route.url).port || !direct.certificateAuthority || direct.certificateAuthority !== entry.route.certificateAuthority) return;
  const listening = new Set(listeners.filter(listener => listener.listening).map(listener => managedOrigin(listener.host, listener.port)));
  // The owner's chosen address is still served: never second-guess it.
  if (listening.has(direct.url) || !listening.has(entry.route.url)) return;
  return sharedRoutesSchema.parse(shared.map(route => route === direct ? { ...direct, url: entry.route.url } : route));
}

export type HostRoutesOptions = { store: HubStore; network: PrivateNetwork; publicKey: string; stateDir: string; listeners: () => ManagedListener[]; now?: () => number };
/** Host-owned route publication for its own owner devices (C3) and its own
 * signed descriptor (B7). Runs only after listener maintenance releases the
 * desktop mutex; performs DB work only and never a network exchange. */
export class HostRoutes {
  private running?: Promise<void>;
  private observedAt = 0;
  private readonly now: () => number;
  constructor(private readonly options: HostRoutesOptions) { this.now = options.now ?? Date.now; }
  private async read(): Promise<HostRoutesRecord> {
    const row = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [HOST_ROUTES_KEY]);
    if (!row) return emptyHostRoutesRecord();
    // Observations are derived state; an unreadable record restarts them.
    try { return recordSchema.parse(JSON.parse(row.value)); } catch { return emptyHostRoutesRecord(); }
  }
  private async write(record: HostRoutesRecord): Promise<void> {
    await this.options.store.db.serial(() => this.options.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_ROUTES_KEY, JSON.stringify(recordSchema.parse(record))]));
  }
  private async enabled(listeners: readonly ManagedListener[]): Promise<Record<HostRouteMode, boolean>> {
    const optIn = await desktopNetworkOptIn(this.options.stateDir);
    return { lan: optIn.lan || listeners.some(listener => managedRouteMode(listener.host) === "lan"), tailscale: optIn.tailscale || listeners.some(listener => managedRouteMode(listener.host) === "tailscale") };
  }
  refresh(): Promise<void> {
    return this.running ??= this.observe().finally(() => { this.running = undefined; });
  }
  private async observe(): Promise<void> {
    const now = this.now(), listeners = this.options.listeners(), enabled = await this.enabled(listeners);
    const previous = await this.options.store.db.serial(() => this.read());
    let shared: Route[];
    try { shared = await this.options.network.sharedRoutes(); }
    catch (error) { if (error instanceof HubError && error.code === "network_closed") return; throw error; }
    const { record } = observeHostRoutes(previous, listeners, enabled, now, shared);
    if (networkCanonical(record) !== networkCanonical(previous)) await this.write(record);
    this.observedAt = now;
    if (now - record.sharedAt < HOST_ROUTE_COOLDOWN_MS) return;
    try {
      const next = sharedRouteReplacement(shared, record, listeners);
      // Compare-and-swap inside the network transaction: a concurrent owner
      // `routes` command always wins and this tick simply observes it next time.
      if (next && await this.options.network.replaceManagedRoutes(shared, next)) await this.write({ ...record, sharedAt: now });
    } catch (error) {
      // Shutdown closes the directory first; an interrupted tick retries at next start.
      if (!(error instanceof HubError && error.code === "network_closed")) throw error;
    }
  }
  /** Owner-scoped disclosure of this host's own routes; not an authorization. */
  async view(validate?: () => Promise<unknown>): Promise<HostRoutesView> {
    const shared = await this.options.network.sharedRoutes(validate);
    const record = await this.options.store.db.serial(() => this.read());
    const listeners = this.options.listeners(), enabled = await this.enabled(listeners);
    const { notices } = observeHostRoutes(record, listeners, enabled, this.now(), shared);
    if (MODES.some(mode => enabled[mode] && record.modes[mode]?.candidate) && !notices.includes("replacement_pending")) notices.push("replacement_pending");
    const routes: HostRoutesView["routes"] = shared.map(route => ({ source: "shared", route }));
    for (const mode of MODES) {
      const entry = record.modes[mode];
      if (enabled[mode] && entry && !routes.some(item => item.route.url === entry.route.url)) routes.push({ source: "managed", route: entry.route });
    }
    const listening = (mode: HostRouteMode) => listeners.some(listener => listener.listening && managedRouteMode(listener.host) === mode);
    return hostRoutesViewSchema.parse({ v: 1, hostPublicKey: this.options.publicKey, routes,
      local: { lan: { enabled: enabled.lan, listening: listening("lan") }, tailscale: { enabled: enabled.tailscale, listening: listening("tailscale") } },
      notices, observedAt: this.observedAt });
  }
}
