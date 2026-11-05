import { expect, it } from "vitest";
import { routesSchema, orderedRoutes } from "../src/client-protocol/routes.js";
import { hubConfigSchema } from "../src/hub/config.js";
import { configuredRelays } from "../src/relay/tunnels.js";
import { assertSafeBind } from "../src/hub/network.js";
import { deploymentMatchesRoutes } from "../src/client-protocol/routes.js";

it("requires explicit public exposure and TLS without loosening existing private listeners", () => {
  expect(hubConfigSchema.parse({}).exposure).toBe("private");
  for (const host of ["0.0.0.0", "::", "192.168.1.10", "203.0.113.10"]) {
    expect(() => assertSafeBind(host, true)).toThrow();
    expect(() => assertSafeBind(host, false, "public")).toThrow("TLS");
    expect(() => assertSafeBind(host, true, "public")).not.toThrow();
  }
  expect(() => assertSafeBind("localhost", true, "public")).toThrow();
  expect(hubConfigSchema.safeParse({ exposure: "public" }).success).toBe(false);
  expect(hubConfigSchema.safeParse({ exposure: "public", tls: { cert: "hub.pem", key: "hub.key" } }).success).toBe(true);
});

it("distinguishes direct VPS hosting from relays and preserves old Tailscale routes", () => {
  const direct = { name: "Direct" as const, url: "https://host.test" }, relay = { name: "VPS" as const, url: "https://relay.test" };
  expect(orderedRoutes(routesSchema.parse([relay, direct]))).toEqual([direct, relay]);
  expect(routesSchema.safeParse([direct, { name: "Tailscale", url: "https://private.test" }]).success).toBe(false);
  expect(deploymentMatchesRoutes("vps-direct", [direct, relay])).toBe(true);
  expect(deploymentMatchesRoutes("vps-direct", [relay])).toBe(false);
  expect(deploymentMatchesRoutes("vps-relay", [relay])).toBe(true);
  expect(deploymentMatchesRoutes("vps-relay", [direct, relay])).toBe(false);
  expect(deploymentMatchesRoutes(undefined, [relay])).toBe(true);
});

it("preserves VPS priority, validates unique endpoints and accepts legacy two-route inputs", () => {
  const routes = routesSchema.parse([{ name: "VPS", label: "主服务器", url: "https://primary.test/" }, { name: "VPS", label: "备服务器", url: "https://backup.test" }, { name: "Tailscale", url: "https://mac.test" }]);
  expect(orderedRoutes(routes).map((r) => r.url)).toEqual(["https://mac.test", "https://primary.test", "https://backup.test"]);
  expect(routesSchema.safeParse([{ name: "VPS", url: "https://a.test" }, { name: "VPS", url: "https://a.test/" }]).success).toBe(false);
  for (const url of ["not-a-url", "", "https://", "http://public.test", "https://a.test/ignored-path", "https://user:pass@a.test", "https://a.test?token=secret", "https://a.test#part"]) expect(routesSchema.safeParse([{ name: "VPS", url }]).success).toBe(false);
  expect(routesSchema.safeParse(Array.from({ length: 9 }, (_, i) => ({ name: "VPS", url: `https://v${i}.test` }))).success).toBe(false);
  expect(routesSchema.parse([{ name: "Tailscale", url: "http://127.0.0.1:8788" }, { name: "VPS", url: "https://vps.test" }])).toHaveLength(2);
});
it("migrates the legacy tunnel, rejects ambiguous fleets and checks every TLS target", () => {
  const relay = { host: "primary.test", servername: "tunnel.test", tls: { ca: "ca.pem", cert: "mac.pem", key: "mac.key" }, targetPort: 9443 };
  const listeners = [{ host: "127.0.0.1", port: 9443, tls: { cert: "hub.pem", key: "hub.key" } }];
  expect(configuredRelays(hubConfigSchema.parse({ relay, tlsListeners: listeners }))).toMatchObject([{ id: "primary", host: "primary.test" }]);
  const relays = [{ ...relay, id: "main", label: "主 VPS" }, { ...relay, host: "backup.test", id: "backup" }];
  expect(configuredRelays(hubConfigSchema.parse({ relays, tlsListeners: listeners }))).toHaveLength(2);
  expect(hubConfigSchema.safeParse({ relay, relays }).success).toBe(false);
  expect(hubConfigSchema.safeParse({ relays: [relays[0], relays[0]] }).success).toBe(false);
  expect(hubConfigSchema.safeParse({ relays: [relays[0], { ...relays[0], id: "other" }] }).success).toBe(false);
  expect(() => configuredRelays(hubConfigSchema.parse({ relays, tlsListeners: [] }))).toThrow("main target");
  expect(() => configuredRelays(hubConfigSchema.parse({ relays: [relays[0], { ...relays[1], targetPort: 9444 }], tlsListeners: listeners }))).toThrow("backup target");
});
