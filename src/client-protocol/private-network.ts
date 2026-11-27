import { z } from "zod";
import { isEdgeTlsRoute, MAX_CLOUDFLARE_ROUTES, routesSchema, routeSchema, type Route } from "./routes.js";
import { hostNameSchema } from "./host-profile.js";
import { deviceActionProofSchema, deviceActionStatementSchema } from "./device-actions.js";
import { isLoopbackOrUnspecified } from "./loopback-address.js";

export const PRIVATE_NETWORK_CAPABILITY = "private-network.v2";
export const PRIVATE_NETWORK_RECOVERY_CAPABILITY = "private-network.recovery.v1";
export const MAX_NETWORK_BYTES = 2 * 1024 * 1024;
const key = z.string().length(60).regex(/^[A-Za-z0-9+/]{59}=$/);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).refine(value => !/[\r\n]/.test(value));
const nonce = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().length(88).regex(/^[A-Za-z0-9+/]{86}==$/);
const deadline = z.number().int().positive().safe();
export const networkPeerCapabilitySchema = z.enum([PRIVATE_NETWORK_RECOVERY_CAPABILITY]);
export type NetworkPeerCapability = z.infer<typeof networkPeerCapabilitySchema>;
export const networkPeerCapabilitiesSchema = z.array(networkPeerCapabilitySchema).min(1).max(16)
  .refine(values => new Set(values).size === values.length, { message: "duplicate_network_peer_capability" });
export const networkHostCapabilitiesSchema = z.record(key, networkPeerCapabilitiesSchema)
  .refine(value => Object.keys(value).length <= 256, { message: "too_many_host_capabilities" });
export type NetworkHostCapabilities = z.infer<typeof networkHostCapabilitiesSchema>;
/** Legacy v1/v2 wire-compatible shared routes. Excludes Cloudflare edge-TLS
 * routes so v1.6.0 peers in the same network can always parse signed manifests. */
export const sharedRoutesSchema = z.array(routeSchema).max(9).superRefine((routes, ctx) => {
  if (routes.some(isEdgeTlsRoute)) ctx.addIssue({ code: "custom", message: "legacy_shared_routes_cannot_include_cloudflare" });
  if (routes.length && !routesSchema.safeParse(routes).success) ctx.addIssue({ code: "custom", message: "invalid_network_routes" });
  for (const route of routes) {
    const u = new URL(route.url);
    if (u.protocol !== "https:" || isLoopbackOrUnspecified(u.hostname)) ctx.addIssue({ code: "custom", message: "network_route_must_be_remote" });
  }
});
/** Additive optional edge-terminated routes (e.g. DIY Cloudflare Tunnel). Kept
 * separate from legacy `routes` so v1.6.0 peers remain unaffected when omitted. */
export const sharedEdgeRoutesSchema = z.array(routeSchema).max(MAX_CLOUDFLARE_ROUTES).superRefine((routes, ctx) => {
  if (routes.some(route => !isEdgeTlsRoute(route))) ctx.addIssue({ code: "custom", message: "invalid_edge_routes" });
  if (new Set(routes.map(route => route.url)).size !== routes.length) ctx.addIssue({ code: "custom", message: "duplicate_edge_route" });
});
export const networkHostDescriptorSchema = z.object({ publicKey: key, name: hostNameSchema, routes: sharedRoutesSchema, edgeRoutes: sharedEdgeRoutesSchema.optional(), protocol: z.literal(2).optional(), generation: z.number().int().min(2).safe().optional() }).strict();
export type NetworkHostDescriptor = z.infer<typeof networkHostDescriptorSchema>;
export const networkHostRoutes = (host: Pick<NetworkHostDescriptor, "routes" | "edgeRoutes">): Route[] => [...host.routes, ...(host.edgeRoutes ?? [])];
export const networkHostSchema = networkHostDescriptorSchema.extend({ state: z.enum(["pending", "active"]), revoked: z.boolean(), proposalNonce: nonce.optional(), expiresAt: deadline.optional(), reinstated: z.number().int().min(2).safe().optional() }).strict()
  .superRefine((host, ctx) => {
    if (host.state === "pending" ? !host.proposalNonce || !host.expiresAt : host.proposalNonce !== undefined || host.expiresAt !== undefined) ctx.addIssue({ code: "custom", message: "invalid_network_host_state" });
    if (host.reinstated !== undefined && (!host.revoked || host.reinstated !== (host.generation ?? 1) + 1)) ctx.addIssue({ code: "custom", message: "invalid_network_host_state" });
  });
export type NetworkHost = z.infer<typeof networkHostSchema>;
export const networkEnrollmentSchema = z.object({ id, publicKey: key, host: key, name: hostNameSchema, platform: z.enum(["web", "macos", "windows", "android", "ios"]) }).strict();
export type NetworkEnrollment = z.infer<typeof networkEnrollmentSchema>;
export const networkPublishedEnrollmentSchema = networkEnrollmentSchema.extend({ scope: z.enum(["host", "network"]).optional() }).strict();
export type NetworkPublishedEnrollment = z.infer<typeof networkPublishedEnrollmentSchema>;
export const networkDeviceSchema = networkPublishedEnrollmentSchema.extend({ memberId: id, originHost: key, attestedBy: key, revoked: z.boolean(), generation: z.number().int().min(2).safe().optional(), originGeneration: z.number().int().min(2).safe().optional(), attestedGeneration: z.number().int().min(2).safe().optional() }).strict();
export type NetworkDevice = z.infer<typeof networkDeviceSchema>;
export const networkDeviceRetiredByHosts = (device: NetworkDevice, removed: ReadonlySet<string>): boolean => removed.has(device.host) || device.scope !== "network" && (removed.has(device.originHost) || removed.has(device.attestedBy));
export const networkBindingKey = (host: string, deviceId: string) => `${host}\0${deviceId}`;
export const networkManifestSchema = z.object({ v: z.union([z.literal(1), z.literal(2)]), id, name: hostNameSchema, authorityKey: key, genesisNonce: nonce,
  revision: z.number().int().nonnegative().safe(), hosts: z.array(networkHostSchema).min(1).max(256), devices: z.array(networkDeviceSchema).max(4096),
  pendingProposals: z.array(z.object({ host: key, nonce, expiresAt: deadline, generation: z.number().int().min(2).safe().optional() }).strict()).max(4096).optional(),
  cancelledProposals: z.array(z.object({ host: key, nonce }).strict()).max(4096).optional(),
  blockedKeys: z.array(z.string().length(64).regex(/^[a-f0-9]{64}$/)).max(8192).optional(),
  revokedMembers: z.array(id).max(4096), blockedBindings: z.array(z.object({ host: key, id }).strict()).max(4096),
}).strict().superRefine((m, ctx) => {
  const hosts = new Map(m.hosts.map(h => [h.publicKey, h])), bindings = m.devices.map(d => networkBindingKey(d.host, d.id));
  const revokedMembers = new Set(m.revokedMembers), unavailableHosts = new Set(m.hosts.filter(host => host.revoked || host.state !== "active").map(host => host.publicKey));
  const active = m.devices.filter(d => !d.revoked), blocked = new Set(m.blockedBindings.map(b => networkBindingKey(b.host, b.id)));
  const invalid = () => ctx.addIssue({ code: "custom", message: "invalid_network_membership" });
  const proposals = m.pendingProposals ?? [], cancelled = m.cancelledProposals ?? [];
  if (new Set(proposals.map(p => networkBindingKey(p.host, p.nonce))).size !== proposals.length
    || new Set(cancelled.map(p => networkBindingKey(p.host, p.nonce))).size !== cancelled.length
    || proposals.some(p => !hosts.has(p.host) || (p.generation ?? 1) > (hosts.get(p.host)!.generation ?? 1))
    || cancelled.some(p => !hosts.has(p.host))) invalid();
  const cancelledSlots = new Set(cancelled.map(p => networkBindingKey(p.host, p.nonce)));
  for (const host of m.hosts) if (host.state === "pending" && cancelledSlots.has(networkBindingKey(host.publicKey, host.proposalNonce!)) && host.expiresAt !== 1) invalid();
  if (new Set(m.blockedKeys ?? []).size !== (m.blockedKeys ?? []).length || hosts.size !== m.hosts.length || new Set(bindings).size !== bindings.length || new Set(m.revokedMembers).size !== m.revokedMembers.length || blocked.size !== m.blockedBindings.length
    || m.hosts.filter(h => h.state === "active" && !h.revoked).length > 32 || active.length > 256
    || !m.hosts.some(h => h.publicKey === m.authorityKey && h.state === "active" && !h.revoked)
    || new Set(active.map(d => d.publicKey)).size !== active.length) invalid();
  if (m.v === 1 && (m.devices.some(d => d.scope !== undefined || d.generation !== undefined || d.originGeneration !== undefined || d.attestedGeneration !== undefined)
    || m.hosts.some(h => h.protocol !== undefined || h.edgeRoutes !== undefined || h.generation !== undefined || h.reinstated !== undefined)
    || proposals.some(p => p.generation !== undefined))) invalid();
  if (m.v === 2 && m.hosts.some(h => !h.revoked && h.state === "active" && h.protocol !== 2)) invalid();
  const scopes = new Map<string, string>();
  for (const d of m.devices) {
    const scope = scopes.get(d.memberId);
    if (scope !== undefined && scope !== (d.scope ?? "legacy")) invalid();
    scopes.set(d.memberId, d.scope ?? "legacy");
    if (!hosts.has(d.host) || !hosts.has(d.originHost) || !hosts.has(d.attestedBy)) { invalid(); continue; }
    const hostGen = hosts.get(d.host)!.generation ?? 1;
    const originGen = hosts.get(d.originHost)!.generation ?? 1;
    const attestedGen = hosts.get(d.attestedBy)!.generation ?? 1;
    const dGen = d.generation ?? 1, dOriginGen = d.originGeneration ?? 1, dAttestedGen = d.attestedGeneration ?? 1;
    if (dGen > hostGen || dOriginGen > originGen || dAttestedGen > attestedGen) { invalid(); continue; }
    if (!d.revoked && (hosts.has(d.publicKey) || revokedMembers.has(d.memberId) || blocked.has(networkBindingKey(d.host, d.id))
      || dGen < hostGen
      || d.scope !== "network" && (dOriginGen < originGen || dAttestedGen < attestedGen)
      || networkDeviceRetiredByHosts(d, unavailableHosts))) invalid();
  }
});
export type NetworkManifest = z.infer<typeof networkManifestSchema>;
export const signedNetworkManifestSchema = z.object({ manifest: networkManifestSchema, signature }).strict();
export type SignedNetworkManifest = z.infer<typeof signedNetworkManifestSchema>;
export const networkProposalSchema = z.object({ v: z.literal(1), host: networkHostDescriptorSchema, devices: z.array(networkPublishedEnrollmentSchema).max(256),
  networkId: id, authorityKey: key, seenManifestHash: z.string().length(64).regex(/^[a-f0-9]{64}$/), nonce, expiresAt: deadline,
}).strict();
export type NetworkProposal = z.infer<typeof networkProposalSchema>;
export const signedNetworkProposalSchema = z.object({ proposal: networkProposalSchema, signature }).strict();
export type SignedNetworkProposal = z.infer<typeof signedNetworkProposalSchema>;
export const networkCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), name: hostNameSchema }).strict(),
  z.object({ operation: z.literal("routes"), networkId: z.union([id, z.literal("")]), routes: sharedRoutesSchema }).strict(),
  z.object({ operation: z.literal("propose"), networkId: id, authorityKey: key, seenManifestHash: z.string().length(64).regex(/^[a-f0-9]{64}$/), generation: z.number().int().min(2).safe().optional(), recover: z.literal(true).optional() }).strict()
    .refine(v => Boolean(v.recover) === Boolean(v.generation), { message: "invalid_network_recover_propose" }),
  z.object({ operation: z.literal("admit"), proposal: signedNetworkProposalSchema }).strict(),
  z.object({ operation: z.literal("join"), membership: signedNetworkManifestSchema, nonce }).strict(),
  z.object({ operation: z.literal("attest"), networkId: id, device: networkEnrollmentSchema }).strict(),
  z.object({ operation: z.literal("reinstate"), networkId: id, publicKey: key, expectedGeneration: z.number().int().min(1).safe().optional(), seenManifestHash: z.string().length(64).regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ operation: z.literal("remove"), networkId: id, publicKey: key, expectedState: z.enum(["pending", "active"]) }).strict(),
  z.object({ operation: z.literal("leave"), networkId: z.union([id, z.literal("")]), expectedState: z.enum(["standalone", "pending", "active"]) }).strict(),
]);
export type NetworkCommand = z.infer<typeof networkCommandSchema>;
export type NetworkCommandInput = NetworkCommand extends infer C ? C extends NetworkCommand ? C["operation"] extends "routes" | "attest" | "reinstate" | "remove" | "leave" ? Omit<C, "networkId" | "expectedState"> & { networkId?: string } & (C extends { expectedState: infer S } ? { expectedState?: S } : {}) : C : never : never;
export const networkViewSchema = z.object({ host: networkHostSchema, membership: signedNetworkManifestSchema.optional(),
  sync: z.enum(["standalone", "current", "waiting", "removed"]), lastSyncedAt: z.number().int().nonnegative(),
  hostCapabilities: networkHostCapabilitiesSchema.optional(),
}).strict();
export type NetworkView = z.infer<typeof networkViewSchema>;
export const networkPeerRequestSchema = z.object({ v: z.literal(1), networkId: id, publicKey: key, nonce, expiresAt: deadline,
  host: networkHostDescriptorSchema, devices: z.array(networkPublishedEnrollmentSchema).max(256), revoked: z.array(id).max(256), known: signedNetworkManifestSchema.optional(), commit: nonce.optional(), cancel: nonce.optional(), retire: z.literal(true).optional(),
  capabilities: networkPeerCapabilitiesSchema.optional(),
  attest: z.object({ sourceDeviceId: id, device: networkEnrollmentSchema, statement: deviceActionStatementSchema, proof: deviceActionProofSchema }).strict().optional(),
}).strict().refine(value => [value.commit, value.cancel, value.retire, value.attest].filter(Boolean).length <= 1, { message: "invalid_network_peer_action" });
export type NetworkPeerRequest = z.infer<typeof networkPeerRequestSchema>;
export const signedNetworkPeerRequestSchema = z.object({ request: networkPeerRequestSchema, signature }).strict();
export type SignedNetworkPeerRequest = z.infer<typeof signedNetworkPeerRequestSchema>;
export const networkCommandResultSchema = z.object({ view: networkViewSchema, proposal: signedNetworkProposalSchema.optional(), membership: signedNetworkManifestSchema.optional() }).strict();
export type NetworkCommandResult = z.infer<typeof networkCommandResultSchema>;
/** True when a manifest carries host-recovery generation fields that 1.6.0
 * peers/Apps reject under strict schema validation. */
export function manifestUsesGenerations(manifest: NetworkManifest): boolean {
  return manifest.hosts.some(host => host.generation !== undefined || host.reinstated !== undefined)
    || manifest.devices.some(device => device.generation !== undefined || device.originGeneration !== undefined || device.attestedGeneration !== undefined)
    || (manifest.pendingProposals ?? []).some(proposal => proposal.generation !== undefined);
}
/** Active non-coordinator hosts in `manifest` that have not advertised
 * generation-aware manifest support (`private-network.recovery.v1`). */
export function unreadyRecoveryHosts(manifest: NetworkManifest, hostCapabilities?: NetworkHostCapabilities): NetworkHost[] {
  return manifest.hosts.filter(host =>
    !host.revoked
    && host.state === "active"
    && host.publicKey !== manifest.authorityKey
    && !hostCapabilities?.[host.publicKey]?.includes(PRIVATE_NETWORK_RECOVERY_CAPABILITY),
  );
}
/** Stable JavaScript key order. Native devices only sign the SHA256 digest. */
export function networkCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(networkCanonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${networkCanonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const networkGenesisText = (authorityKey: string, genesisNonce: string) => networkCanonical(["tarocub/network/v1", authorityKey, genesisNonce]);
export const networkMemberText = (hostKey: string, deviceId: string, generation = 1) => generation > 1
  ? networkCanonical(["tarocub/network-member/v1", hostKey, deviceId, generation])
  : networkCanonical(["tarocub/network-member/v1", hostKey, deviceId]);
export const networkManifestProof = (m: NetworkManifest) => `tarocub/network-manifest/v1\0${networkCanonical(networkManifestSchema.parse(m))}`;
export const networkProposalProof = (p: NetworkProposal) => `tarocub/network-proposal/v1\0${networkCanonical(networkProposalSchema.parse(p))}`;
export const networkPeerProof = (p: NetworkPeerRequest) => `tarocub/network-peer/v1\0${networkCanonical(networkPeerRequestSchema.parse(p))}`;
