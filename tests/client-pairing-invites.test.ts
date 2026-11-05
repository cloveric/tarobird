import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { pairingLink, parsePairingLink } from "../client/src/pairing-link.js";
import { hostPairingLink } from "../src/host-cli/pairing.js";
import { pairingRequestIdSchema } from "../src/client-protocol/pairing-invites.js";
const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const base = { v: 1 as const, kind: "connect" as const, hubPublicKey: key, routes: [{ name: "Direct" as const, url: "https://100.101.102.103:8788" }] };
const invite = randomBytes(32).toString("base64url");
describe("strict invitations with route-only legacy QR compatibility", () => {
  it("keeps v1 data byte-for-byte for legacy route repair while carrying a separate invitation", () => {
    const old = pairingLink(base), link = pairingLink({ ...base, invite });
    expect(new URL(link).searchParams.get("data")).toBe(new URL(old).searchParams.get("data"));
    // Old readers consume the v1 data field. The public registration endpoint,
    // independently tested, rejects requests that omit the invitation.
    expect(JSON.parse(new URL(link).searchParams.get("data")!)).toEqual(base);
    expect(parsePairingLink(link)).toEqual({ ...base, invite });
    expect(parsePairingLink(old)).toEqual(base);
    expect(parsePairingLink(hostPairingLink(key, base.routes, invite))).toEqual({ ...base, invite });
  });
  it("rejects ambiguous query parameters and invitation injection into approval codes", () => {
    const link = pairingLink({ ...base, invite });
    for (const bad of [link + "&invite=" + invite, link + "&data=%7B%7D", link + "&extra=x", link.replace(invite, "short"), link + "#fragment"]) expect(() => parsePairingLink(bad)).toThrow();
    const approval = pairingLink({ v: 1, kind: "approve", hubPublicKey: key, code: "12345678" });
    expect(parsePairingLink(approval)).toMatchObject({ kind: "approve", code: "12345678" });
    expect(() => parsePairingLink(approval + "&invite=" + invite)).toThrow();
    expect(() => hostPairingLink(key, base.routes, "")).toThrow();
    expect(pairingRequestIdSchema.safeParse(crypto.randomUUID()).success).toBe(false);
    expect(pairingRequestIdSchema.safeParse(randomBytes(32).toString("base64url")).success).toBe(true);
  });
});
