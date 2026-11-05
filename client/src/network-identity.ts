import { networkCanonical, networkGenesisText, networkManifestProof, signedNetworkManifestSchema, type SignedNetworkManifest } from "../../src/client-protocol/private-network.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { verifyEd25519 } from "./native.js";

export function verifyNetworkMembership(raw: unknown, expectedHostKey?: string, pinned?: {id:string;authorityKey:string}): SignedNetworkManifest {
  const signed = signedNetworkManifestSchema.parse(raw), m = signed.manifest;
  const blockedKeys = new Set(m.blockedKeys ?? []);
  if (networkCanonical(raw) !== networkCanonical(signed)
    || m.id !== `net_${bytesToHex(sha256(new TextEncoder().encode(networkGenesisText(m.authorityKey, m.genesisNonce))))}`
    || pinned && (m.id !== pinned.id || m.authorityKey !== pinned.authorityKey)
    || !verifyEd25519(m.authorityKey, signed.signature, new TextEncoder().encode(networkManifestProof(m)))
    || m.devices.some(device => !device.revoked && blockedKeys.has(bytesToHex(sha256(new TextEncoder().encode(device.publicKey)))))
    || expectedHostKey && !m.hosts.some(host => host.publicKey === expectedHostKey)) throw new Error("network_membership_invalid");
  return signed;
}
