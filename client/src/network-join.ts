import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { networkCanonical, type NetworkCommand, type NetworkManifest, type NetworkView, type SignedNetworkManifest, type SignedNetworkProposal } from "../../src/client-protocol/private-network.js";

export type NetworkCommandResult = { view: NetworkView; proposal?: SignedNetworkProposal; membership?: SignedNetworkManifest };
export type NetworkCommandConnection = { networkCommand(command: Extract<NetworkCommand, { operation: "propose" | "admit" | "join" }>): Promise<NetworkCommandResult> };
export const reviewedNetworkHash = (manifest: NetworkManifest) => bytesToHex(sha256(new TextEncoder().encode(networkCanonical(manifest))));
export type NetworkJoinAttempt = {
  networkId: string;
  authorityKey: string;
  sourceKey: string;
  seenManifestHash: string;
  reviewedManifest?: NetworkManifest;
  proposal?: SignedNetworkProposal;
  membership?: SignedNetworkManifest;
};

/** Keep each acknowledged stage so a retry after a dropped join response does
 * not admit a second proposal or silently select a different destination. */
export async function joinNetworkHosts(source: NetworkCommandConnection, authority: NetworkCommandConnection, attempt: NetworkJoinAttempt, progress: (attempt: NetworkJoinAttempt) => void): Promise<NetworkView> {
  let next = { ...attempt };
  if (!next.proposal) {
    const command = { operation: "propose" as const, networkId: next.networkId, authorityKey: next.authorityKey, seenManifestHash: next.seenManifestHash };
    const result = await source.networkCommand(command);
    if (!result.proposal) throw new Error("network_proposal_missing");
    next = { ...next, proposal: result.proposal }; progress(next);
  }
  const proposal = next.proposal!;
  if (proposal.proposal.networkId !== next.networkId || proposal.proposal.authorityKey !== next.authorityKey || proposal.proposal.host.publicKey !== next.sourceKey || !("seenManifestHash" in proposal.proposal) || proposal.proposal.seenManifestHash !== next.seenManifestHash) throw new Error("network_proposal_mismatch");
  if (!next.membership) {
    const result = await authority.networkCommand({ operation: "admit", proposal });
    if (!result.membership) throw new Error("network_membership_missing");
    next = { ...next, membership: result.membership }; progress(next);
  }
  const membership = next.membership!;
  if (membership.manifest.id !== next.networkId || membership.manifest.authorityKey !== next.authorityKey || !membership.manifest.hosts.some(host => host.publicKey === next.sourceKey && !host.revoked)) throw new Error("network_membership_mismatch");
  return (await source.networkCommand({ operation: "join", membership, nonce: proposal.proposal.nonce })).view;
}
