import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { networkGenesisText, networkManifestProof, type NetworkManifest } from "../src/client-protocol/private-network.js";
import { verifyNetworkMembership } from "../client/src/network-identity.js";

const authority = generateKeyPairSync("ed25519"), device = generateKeyPairSync("ed25519");
const rootKey = authority.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const deviceKey = device.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const nonce = randomBytes(32).toString("base64url");
function directory(changes: Partial<NetworkManifest> = {}) {
  const manifest: NetworkManifest = { v: 1, id: `net_${digest(networkGenesisText(rootKey, nonce))}`, name: "Home", authorityKey: rootKey,
    genesisNonce: nonce, revision: 1, hosts: [{ publicKey: rootKey, name: "Desktop", routes: [], state: "active", revoked: false }],
    devices: [{ id: "device_fixture", publicKey: deviceKey, host: rootKey, name: "Phone", platform: "android", memberId: "member_fixture", originHost: rootKey, attestedBy: rootKey, revoked: false }],
    revokedMembers: [], blockedBindings: [], ...changes };
  return { manifest, signature: sign(null, Buffer.from(networkManifestProof(manifest)), authority.privateKey).toString("base64") };
}

describe("client signed network directory", () => {
  it("retains the exact signature of a legacy directory without optional recovery fields", () => {
    const signed = directory();
    expect(verifyNetworkMembership(signed, rootKey)).toEqual(signed);
    expect(verifyNetworkMembership(signed).manifest).not.toHaveProperty("blockedKeys");
  });
  it("rejects a signed directory that activates a permanently blocked key in a new slot", () => {
    const signed = directory({ blockedKeys: [digest(deviceKey)] });
    expect(() => verifyNetworkMembership(signed)).toThrow("network_membership_invalid");
    signed.manifest.devices[0]!.revoked = true;
    expect(verifyNetworkMembership(directory(signed.manifest))).toEqual(directory(signed.manifest));
  });
  it("rejects altered content and a foreign genesis or pinned authority", () => {
    const signed = directory();
    expect(() => verifyNetworkMembership({ ...signed, manifest: { ...signed.manifest, name: "Changed" } })).toThrow();
    expect(() => verifyNetworkMembership(directory({ id: "net_unbound" }))).toThrow();
    expect(() => verifyNetworkMembership(signed, rootKey, { id: signed.manifest.id, authorityKey: deviceKey })).toThrow();
  });
});
