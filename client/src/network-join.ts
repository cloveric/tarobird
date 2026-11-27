import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { networkBindingKey, networkCanonical, type NetworkCommand, type NetworkManifest, type NetworkView, type SignedNetworkManifest, type SignedNetworkProposal } from "../../src/client-protocol/private-network.js";

export type NetworkCommandResult = { view: NetworkView; proposal?: SignedNetworkProposal; membership?: SignedNetworkManifest };
export type NetworkCommandConnection = { networkCommand(command: Extract<NetworkCommand, { operation: "propose" | "admit" | "join" }>): Promise<NetworkCommandResult> };
export const reviewedNetworkHash = (manifest: NetworkManifest) => bytesToHex(sha256(new TextEncoder().encode(networkCanonical(manifest))));

/** Verify that a post-reinstate manifest changed nothing except reinstating the
 * reviewed target host (plus protocol v2 normalization and key-block tombstones). */
export function isOnlyReinstatementChange(before: NetworkManifest, after: NetworkManifest, targetKey: string, nextGen: number): boolean {
  if (after.id !== before.id || after.authorityKey !== before.authorityKey || after.genesisNonce !== before.genesisNonce || after.name !== before.name) return false;
  if (after.v !== 2 || (after.revision !== before.revision && after.revision !== before.revision + 1)) return false;
  if (after.hosts.length !== before.hosts.length || after.devices.length !== before.devices.length) return false;
  const afterHosts = new Map(after.hosts.map(host => [host.publicKey, host]));
  for (const host of before.hosts) {
    const next = afterHosts.get(host.publicKey);
    if (!next) return false;
    const expected = host.publicKey === targetKey
      ? (host.revoked ? { ...host, reinstated: nextGen } : null)
      : { ...host, ...(before.v === 1 && !host.revoked && host.state === "active" ? { protocol: 2 as const } : {}) };
    if (!expected || networkCanonical(expected) !== networkCanonical(next)) return false;
  }
  const afterDevices = new Map(after.devices.map(device => [networkBindingKey(device.host, device.id), device]));
  const knownMembers = new Set(before.devices.map(device => device.memberId));
  for (const device of before.devices) {
    const next = afterDevices.get(networkBindingKey(device.host, device.id));
    if (!next || (device.revoked && !next.revoked)) return false;
    if (networkCanonical({ ...device, revoked: false }) !== networkCanonical({ ...next, revoked: false })) return false;
  }
  if (networkCanonical(before.pendingProposals ?? []) !== networkCanonical(after.pendingProposals ?? [])
    || networkCanonical(before.cancelledProposals ?? []) !== networkCanonical(after.cancelledProposals ?? [])
    || networkCanonical(before.blockedBindings) !== networkCanonical(after.blockedBindings)) return false;
  const beforeRevoked = new Set(before.revokedMembers), afterRevoked = new Set(after.revokedMembers);
  if (before.revokedMembers.some(id => !afterRevoked.has(id))
    || after.revokedMembers.some(id => !beforeRevoked.has(id) && !knownMembers.has(id))) return false;
  const afterBlockedKeys = new Set(after.blockedKeys ?? []);
  if ((before.blockedKeys ?? []).some(key => !afterBlockedKeys.has(key))) return false;
  return true;
}
export type NetworkJoinAttempt = {
  networkId: string;
  authorityKey: string;
  sourceKey: string;
  seenManifestHash: string;
  generation?: number;
  recover?: boolean;
  reviewedManifest?: NetworkManifest;
  proposal?: SignedNetworkProposal;
  membership?: SignedNetworkManifest;
};

/** Keep each acknowledged stage so a retry after a dropped join response does
 * not admit a second proposal or silently select a different destination. */
export async function joinNetworkHosts(source: NetworkCommandConnection, authority: NetworkCommandConnection, attempt: NetworkJoinAttempt, progress: (attempt: NetworkJoinAttempt) => void): Promise<NetworkView> {
  let next = { ...attempt };
  if (!next.proposal) {
    const command = {
      operation: "propose" as const,
      networkId: next.networkId,
      authorityKey: next.authorityKey,
      seenManifestHash: next.seenManifestHash,
      ...(next.recover && next.generation ? { generation: next.generation, recover: true as const } : {}),
    };
    const result = await source.networkCommand(command);
    if (!result.proposal) throw new Error("network_proposal_missing");
    next = { ...next, proposal: result.proposal }; progress(next);
  }
  const proposal = next.proposal!;
  if (proposal.proposal.networkId !== next.networkId || proposal.proposal.authorityKey !== next.authorityKey || proposal.proposal.host.publicKey !== next.sourceKey || !("seenManifestHash" in proposal.proposal) || proposal.proposal.seenManifestHash !== next.seenManifestHash || (proposal.proposal.host.generation ?? 1) !== (next.generation ?? 1)) throw new Error("network_proposal_mismatch");
  if (!next.membership) {
    const result = await authority.networkCommand({ operation: "admit", proposal });
    if (!result.membership) throw new Error("network_membership_missing");
    next = { ...next, membership: result.membership }; progress(next);
  }
  const membership = next.membership!;
  if (membership.manifest.id !== next.networkId || membership.manifest.authorityKey !== next.authorityKey || !membership.manifest.hosts.some(host => host.publicKey === next.sourceKey && !host.revoked)) throw new Error("network_membership_mismatch");
  return (await source.networkCommand({ operation: "join", membership, nonce: proposal.proposal.nonce })).view;
}
