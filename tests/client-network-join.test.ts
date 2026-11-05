import { describe, expect, it } from "vitest";
import { joinNetworkHosts, type NetworkJoinAttempt } from "../client/src/network-join.js";
import type { NetworkCommand, NetworkView, SignedNetworkManifest, SignedNetworkProposal } from "../src/client-protocol/private-network.js";

function fixture() {
  const attempt: NetworkJoinAttempt = { networkId: "network-a", authorityKey: "authority", sourceKey: "source", seenManifestHash: "reviewed-directory" };
  const source = { publicKey: "source", name: "Source", routes: [], state: "active" as const, revoked: false };
  const proposal: SignedNetworkProposal = { proposal: { v: 1, host: source, devices: [], networkId: attempt.networkId, authorityKey: attempt.authorityKey, seenManifestHash: attempt.seenManifestHash, nonce: "one-join-nonce", expiresAt: Date.now() + 60_000 }, signature: "signature" };
  const membership: SignedNetworkManifest = { manifest: { v: 1, id: attempt.networkId, name: "My network", authorityKey: attempt.authorityKey, genesisNonce: "fixture-genesis", revokedMembers: [], blockedBindings: [], revision: 2, hosts: [{ ...source, publicKey: "authority" }, source], devices: [] }, signature: "signature" };
  const view: NetworkView = { host: source, membership, sync: "current", lastSyncedAt: Date.now() };
  return { attempt, proposal, membership, view };
}

describe("client network admission retry", () => {
  it("keeps the acknowledged admission when the final join response fails", async () => {
    const { attempt, proposal, membership, view } = fixture();
    const sourceCalls: NetworkCommand[] = [], authorityCalls: NetworkCommand[] = [];
    let saved = attempt, fail = true;
    const source = { async networkCommand(command: NetworkCommand) { sourceCalls.push(command); if (command.operation === "propose") return { view, proposal }; if (fail) { fail = false; throw new Error("connection_lost"); } return { view }; } };
    const authority = { async networkCommand(command: NetworkCommand) { authorityCalls.push(command); return { view, membership }; } };
    await expect(joinNetworkHosts(source, authority, attempt, value => { saved = value; })).rejects.toThrow("connection_lost");
    expect(saved.membership).toEqual(membership);
    expect(await joinNetworkHosts(source, authority, saved, value => { saved = value; })).toEqual(view);
    expect(sourceCalls.map(call => call.operation)).toEqual(["propose", "join", "join"]);
    expect(authorityCalls.map(call => call.operation)).toEqual(["admit"]);
    expect(sourceCalls[2]).toEqual({ operation: "join", membership, nonce: proposal.proposal.nonce });
  });

  it("never admits a proposal for a different source or network", async () => {
    const { attempt, proposal, view } = fixture(); let admitted = false;
    const source = { async networkCommand() { return { view, proposal: { ...proposal, proposal: { ...proposal.proposal, networkId: "different" } } }; } };
    const authority = { async networkCommand() { admitted = true; return { view }; } };
    await expect(joinNetworkHosts(source, authority, attempt, () => undefined)).rejects.toThrow("network_proposal_mismatch");
    expect(admitted).toBe(false);
  });

  it("never completes a join against a different authority or missing source", async () => {
    const { attempt, proposal, membership, view } = fixture(); const calls: string[] = [];
    const source = { async networkCommand(command: NetworkCommand) { calls.push(command.operation); return { view, proposal }; } };
    const authority = { async networkCommand() { return { view, membership: { ...membership, manifest: { ...membership.manifest, hosts: membership.manifest.hosts.filter(host => host.publicKey !== "source") } } }; } };
    await expect(joinNetworkHosts(source, authority, attempt, () => undefined)).rejects.toThrow("network_membership_mismatch");
    expect(calls).toEqual(["propose"]);
  });
});
