import { describe, expect, it } from "vitest";
import type { NetworkView } from "../../src/client-protocol/private-network.js";
import { canOfferDesktopJoin } from "../src/desktop-join-intent.js";

const member = (publicKey: string, state = "active", revoked = false, expiresAt?: number) => ({ publicKey, state, revoked, expiresAt });
const view = (authorityKey: string, hosts: ReturnType<typeof member>[]) => ({ sync: "synced", membership: { manifest: { authorityKey, hosts } } }) as NetworkView;
describe("pairing without silently proposing a network move", () => {
  it("offers an explicit join review for a standalone or new local host", () => {
    expect(canOfferDesktopJoin(undefined, "local", "target")).toBeUndefined();
    expect(canOfferDesktopJoin({ sync: "standalone" } as NetworkView, "local", "target")).toBe(true);
    expect(canOfferDesktopJoin(view("local", [member("local")]), "local", "target")).toBe(true);
  });
  it("only saves the connection when the local network already has a second host", () => {
    expect(canOfferDesktopJoin(view("local", [member("local"), member("peer")]), "local", "target")).toBe(false);
  });
  it("does not propose moving a host that belongs to another coordinator", () => {
    expect(canOfferDesktopJoin(view("coordinator", [member("local")]), "local", "target")).toBe(false);
  });
  it("does not rejoin a network when the new connection belongs to an existing member", () => {
    expect(canOfferDesktopJoin(view("local", [member("local"), member("target")]), "local", "target")).toBe(false);
  });
  it("keeps a live admission in its current network, but ignores an expired admission", () => {
    expect(canOfferDesktopJoin(view("local", [member("local"), member("peer", "pending", false, 200)]), "local", "target", 100)).toBe(false);
    expect(canOfferDesktopJoin(view("local", [member("local"), member("peer", "pending", false, 100)]), "local", "target", 100)).toBe(true);
  });
  it("does not count revoked peers as active members", () => {
    expect(canOfferDesktopJoin(view("local", [member("local"), member("peer", "active", true)]), "local", "target")).toBe(true);
  });
});
