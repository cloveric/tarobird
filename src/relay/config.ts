import { readFile } from "node:fs/promises";
import { z } from "zod";

export const relayTlsFiles = z.object({ ca: z.string().min(1), cert: z.string().min(1), key: z.string().min(1) }).strict();
export const relayTunnelSchema = z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535).default(7443), servername: z.string().min(1), tls: relayTlsFiles, targetHost: z.string().default("127.0.0.1"), targetPort: z.number().int().min(1).max(65535) }).strict();
export const localTlsRouteSchema = z.object({ serverName: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i).max(253), targetPort: z.number().int().min(1).max(65535) }).strict();
const fingerprint256 = z.string().regex(/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i);
/** One more computer on the same relay: its own public port for its devices,
 * and the certificate its tunnel presents on the shared tunnel port. */
export const relayHostSchema = z.object({ publicPort: z.number().int().min(1).max(65535), clientFingerprint256: fingerprint256 }).strict();
export const RELAY_MAX_HOSTS = 32;
export const relayScreenUdpSchema = z.object({
  address: z.ipv4().refine(value => value !== "0.0.0.0"),
  /** Limit the pilot to selected mTLS hosts; absent means all configured hosts. */
  hosts: z.array(fingerprint256).min(1).max(RELAY_MAX_HOSTS).optional(),
}).strict();
/** `publicPort` and `clientFingerprint256` are the first computer, as they
 * always were. `additionalHosts` adds more computers to the same process: all
 * tunnels arrive on `tunnelPort` and are told apart by their certificate; a
 * device reaches a computer through that computer's own public port. */
export const relayServerSchema = z.object({ publicHost: z.string().default("0.0.0.0"), publicPort: z.number().int().min(1).max(65535).default(443), tunnelHost: z.string().default("0.0.0.0"), tunnelPort: z.number().int().min(1).max(65535).default(7443), serverName: z.string().regex(/^[a-z0-9.-]+$/i), clientFingerprint256: fingerprint256, additionalHosts: z.array(relayHostSchema).min(1).max(RELAY_MAX_HOSTS - 1).optional(), tls: relayTlsFiles, maxConnections: z.number().int().min(1).max(4096).default(256), healthPort: z.number().int().min(1).max(65535).optional(), localTls: localTlsRouteSchema.optional(), screenUdp: relayScreenUdpSchema.optional() }).strict().superRefine((value, ctx) => { if (value.localTls && (value.localTls.serverName.toLowerCase() === value.serverName.toLowerCase() || [value.publicPort, value.tunnelPort, value.healthPort].includes(value.localTls.targetPort))) ctx.addIssue({ code: "custom", message: "Local TLS route must use a separate domain and port" });
  // The first computer's own ports are judged as they always were; these rules are for the ones added to it.
  const hosts = relayHosts(value), added = (value.additionalHosts ?? []).map(host => host.publicPort);
  if (new Set([value.publicPort, ...added]).size !== added.length + 1 || added.some(port => port === value.tunnelPort || port === value.healthPort || port === value.localTls?.targetPort)) ctx.addIssue({ code: "custom", message: "Each computer needs its own public port, apart from the tunnel, health and local TLS ports" });
  if (value.screenUdp?.hosts?.some(id => !hosts.some(host => host.clientFingerprint256.toUpperCase() === id.toUpperCase()))) ctx.addIssue({ code: "custom", message: "Screen UDP pilot hosts must use configured tunnel certificates" });
  if (new Set(hosts.map(host => host.clientFingerprint256.toUpperCase())).size !== hosts.length) ctx.addIssue({ code: "custom", message: "Each computer needs its own tunnel certificate" });
});
/** Every computer a relay serves, the first one included. */
export function relayHosts(config: { publicPort?: number; clientFingerprint256: string; additionalHosts?: { publicPort?: number; clientFingerprint256: string }[] }): { publicPort: number; clientFingerprint256: string }[] {
  return [{ publicPort: config.publicPort ?? 443, clientFingerprint256: config.clientFingerprint256 }, ...(config.additionalHosts ?? []).map(host => ({ publicPort: host.publicPort ?? 0, clientFingerprint256: host.clientFingerprint256 }))];
}
export async function loadRelayTls(files: z.infer<typeof relayTlsFiles>): Promise<{ ca: Buffer; cert: Buffer; key: Buffer }> { return { ca: await readFile(files.ca), cert: await readFile(files.cert), key: await readFile(files.key) }; }
