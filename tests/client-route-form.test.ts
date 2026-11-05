import { expect, it } from "vitest";
import { connectionConfiguration } from "../client/src/connection-routes.js";

const direct = { name: "Tailscale" as const, url: "https://host.test", label: "My host", certificateAuthority: "A".repeat(100) };
const relay = { name: "VPS" as const, url: "https://relay.test", label: "Backup", certificateAuthority: "B".repeat(100) };

it.each([undefined, "computer", "vps-direct"] as const)("retains compatible old deployment %s and trusted route metadata", deployment => {
  expect(connectionConfiguration(direct.url, [relay], deployment, direct)).toEqual({ routes: [direct, relay], deployment });
});
it("adding direct access to an old relay-only QR never silently drops the entered address", () => {
  expect(connectionConfiguration(direct.url, [relay], "vps-relay", direct)).toEqual({ routes: [direct, relay], deployment: undefined });
});
it("removing a direct address permits relay-only access without guessing where Bots run", () => {
  expect(connectionConfiguration("", [relay], "vps-direct", direct)).toEqual({ routes: [relay], deployment: undefined });
  expect(connectionConfiguration("", [relay], "vps-relay")).toEqual({ routes: [relay], deployment: "vps-relay" });
});
it("rejects empty and duplicate configurations and public plaintext routes", () => {
  expect(() => connectionConfiguration("", [])).toThrow();
  expect(() => connectionConfiguration(relay.url, [relay])).toThrow();
  expect(() => connectionConfiguration("http://public.test", [])).toThrow();
});
it("changing a direct address does not carry its old certificate authority to another host", () => {
  expect(connectionConfiguration("https://new.test", [relay], "computer", direct)).toEqual({ routes: [{ name: "Direct", url: "https://new.test" }, relay], deployment: "computer" });
});
