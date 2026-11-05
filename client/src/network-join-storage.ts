import { z } from "zod";
import { MAX_NETWORK_BYTES, networkManifestSchema, signedNetworkManifestSchema, signedNetworkProposalSchema } from "../../src/client-protocol/private-network.js";
import { reviewedNetworkHash, type NetworkJoinAttempt } from "./network-join.js";

const attemptSchema = z.object({
  networkId: z.string().min(1).max(128), authorityKey: z.string().length(60), sourceKey: z.string().length(60),
  seenManifestHash: z.string().length(64).regex(/^[a-f0-9]{64}$/), reviewedManifest: networkManifestSchema.optional(),
  proposal: signedNetworkProposalSchema.optional(), membership: signedNetworkManifestSchema.optional(),
}).strict();
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const keyFor = (networkId: string, authorityKey: string, sourceKey: string) => `tarobot:network-join:v1:${networkId}:${encodeURIComponent(authorityKey)}:${encodeURIComponent(sourceKey)}`;

/** This recovery record contains only public signed statements and the reviewed
 * public directory. Device credentials and private keys never enter storage. */
export function saveNetworkJoinAttempt(attempt: NetworkJoinAttempt, storage?: Store): void {
  try {
    const parsed = attemptSchema.parse(attempt), serialized = JSON.stringify(parsed);
    if (serialized.length > MAX_NETWORK_BYTES * 3) throw new Error("network_join_recovery_unavailable");
    (storage ?? localStorage).setItem(keyFor(parsed.networkId, parsed.authorityKey, parsed.sourceKey), serialized);
  } catch { throw new Error("network_join_recovery_unavailable"); }
}
export function loadNetworkJoinAttempt(networkId: string, authorityKey: string, sourceKey: string, storage?: Store): NetworkJoinAttempt | undefined {
  try {
    const raw = (storage ?? localStorage).getItem(keyFor(networkId, authorityKey, sourceKey));
    if (!raw || raw.length > MAX_NETWORK_BYTES * 3) return;
    const parsed = attemptSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const attempt = parsed.data;
    if (attempt.networkId !== networkId || attempt.authorityKey !== authorityKey || attempt.sourceKey !== sourceKey) return;
    if (attempt.reviewedManifest && (attempt.reviewedManifest.id !== networkId || attempt.reviewedManifest.authorityKey !== authorityKey || reviewedNetworkHash(attempt.reviewedManifest) !== attempt.seenManifestHash)) return;
    if (attempt.membership && (attempt.membership.manifest.id !== networkId || attempt.membership.manifest.authorityKey !== authorityKey)) return;
    const proposal = attempt.proposal?.proposal;
    if (proposal && (proposal.networkId !== networkId || proposal.authorityKey !== authorityKey || proposal.host.publicKey !== sourceKey || proposal.seenManifestHash !== attempt.seenManifestHash)) return;
    return attempt;
  } catch { return; }
}
export function clearNetworkJoinAttempt(networkId: string, authorityKey: string, sourceKey: string, storage?: Store): void {
  try { (storage ?? localStorage).removeItem(keyFor(networkId, authorityKey, sourceKey)); } catch { /* A later successful join recognizes the already-active membership. */ }
}
