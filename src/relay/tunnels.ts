import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { MAX_VPS_ROUTES, routeLabelSchema } from "../client-protocol/routes.js";
import { loadRelayTls, relayTunnelSchema } from "./config.js";
import { RelayTunnel } from "./tunnel.js";
import { isLoopback } from "../hub/network.js";
import type { RelaySources } from "./sources.js";

export const namedRelayTunnelSchema = relayTunnelSchema.extend({ id: idSchema, label: routeLabelSchema.optional() });
export const relayTunnelsSchema = z.array(namedRelayTunnelSchema).min(1).max(MAX_VPS_ROUTES).superRefine((relays, ctx) => {
  if (new Set(relays.map((r) => r.id)).size !== relays.length) ctx.addIssue({ code: "custom", message: "Duplicate relay ID" });
  if (new Set(relays.map((r) => `${r.host.toLowerCase()}:${r.port}`)).size !== relays.length) ctx.addIssue({ code: "custom", message: "Duplicate relay tunnel endpoint" });
});
type Config = { relay?: z.infer<typeof relayTunnelSchema>; relays?: z.infer<typeof relayTunnelsSchema>; host: string; port: number; tls?: unknown; tlsListeners: { host: string; port: number }[] };
export function configuredRelays(config: Config): z.infer<typeof relayTunnelsSchema> {
  if (config.relay && config.relays) throw new Error("Use relays or legacy relay, not both");
  const values = config.relays ?? (config.relay ? [{ ...config.relay, id: "primary" }] : []);
  for (const relay of values) if (!config.tlsListeners.some((l) => isLoopback(l.host) && l.host === relay.targetHost && l.port === relay.targetPort) && !(config.tls && isLoopback(config.host) && config.host === relay.targetHost && config.port === relay.targetPort)) throw new Error(`Relay ${relay.id} target must match a configured loopback TLS listener`);
  return values;
}
/** All tunnels stay connected. Losing one VPS never closes another VPS's sockets. */
export class RelayTunnels {
  constructor(readonly entries: { id: string; label?: string; tunnel: RelayTunnel }[]) {}
  static async load(config: Config, warning: (code: string) => void = () => undefined, sources?: RelaySources): Promise<RelayTunnels> {
    const entries = await Promise.all(configuredRelays(config).map(async ({ id, label, ...relay }) => ({ id, label, tunnel: new RelayTunnel({ ...relay, tls: await loadRelayTls(relay.tls), onWarning: (code) => warning(`${id}: ${code}`), onSource: (socket, source) => sources?.register(socket, id, source) }) })));
    return new RelayTunnels(entries);
  }
  start(): void { this.entries.forEach(({ tunnel }) => tunnel.start()); }
  stop(): void { this.entries.forEach(({ tunnel }) => tunnel.stop()); }
  get status() { const servers = this.entries.map(({ id, label, tunnel }) => ({ id, ...(label ? { label } : {}), online: tunnel.online })); return { configured: !!servers.length, online: servers.some((r) => r.online), allOnline: !!servers.length && servers.every((r) => r.online), servers }; }
}
