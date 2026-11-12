import { afterEach, describe, expect, it, vi } from "vitest";
import * as desktopTlsModule from "../src/hub/desktop-tls.js";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import net from "node:net";
import { desktopHost } from "../src/hub/desktop.js";
import { desktopTls, desktopLanAddresses } from "../src/hub/desktop-tls.js";
import { HubServer } from "../src/hub/server.js";
import { loadHubTls } from "../src/hub/tls.js";
import { HubStore } from "../src/hub/store.js";
import { HostProfile } from "../src/hub/host-profile.js";
import { desktopControllerChallengeSchema, desktopControllerProofText } from "../src/hub/local-controller.js";

const directories: string[] = [];
const entry = path.resolve("dist/src/index.js");
async function directory() { const value = await mkdtemp(path.join(os.tmpdir(), "tb-host-")); directories.push(value); return value; }
afterEach(async () => { for (const dir of directories.splice(0)) { await desktopHost("stop", dir, entry).catch(() => undefined); await rm(dir, { recursive: true, force: true }); } });
describe("desktop first installation", () => {
  it("does not create a host merely by opening a client", async () => {
    const dir = path.join(await directory(), "untouched");
    expect(await desktopHost("resume", dir, entry)).toMatchObject({ available: true, running: false });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await desktopHost("status", dir, entry)).toMatchObject({ running: false, hostName: os.hostname() });
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects invalid setup names without creating any host state", async () => {
    const dir = path.join(await directory(), "untouched");
    for (const hostName of [" ", "a".repeat(101), "Host\nName"]) await expect(desktopHost("start", dir, entry, { hostName })).rejects.toThrow();
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("starts packaged entry, enrolls only an explicitly supplied local device, and resumes the same host", async () => {
    const dir = await directory();
    const started = await desktopHost("start", dir, entry, { hostName: "  我的 Mac mini  " });
    expect(started).toMatchObject({ running: true, hostName: "我的 Mac mini" });
    expect(await desktopHost("start", dir, entry)).toEqual(started);
    expect(await desktopHost("start", dir, entry, { hostName: "Unrelated client alias" })).toEqual(started);
    expect(await desktopHost("status", dir, entry)).toEqual(started);
    const keys = generateKeyPairSync("ed25519");
    const device = { deviceId: "device_first_install", name: "Desktop", platform: "macos", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
    const response = await desktopHost("pair-challenge", dir, entry, device);
    const challenge = desktopControllerChallengeSchema.parse((response as { desktopControllerChallenge: unknown }).desktopControllerChallenge);
    await desktopHost("pair", dir, entry, { ...device, nativeProof: { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), keys.privateKey).toString("base64") } });
    const store = await HubStore.open(dir);
    try {
      expect(await store.db.get("SELECT id FROM devices WHERE id=?", ["device_first_install"])).toEqual({ id: "device_first_install" });
      expect(await new HostProfile(store.db).read()).toEqual({ name: "我的 Mac mini", revision: 0 });
    } finally { await store.db.close(); }
    expect(await desktopHost("resume", dir, entry)).toEqual(started);
    expect(await desktopHost("stop", dir, entry)).toMatchObject({ running: false });
    expect(await desktopHost("resume", dir, entry)).toMatchObject({ running: false });
  }, 30_000);
  it("creates a stable private CA and an actual HTTPS listener with host identity proof", async () => {
    const dir = await directory();
    const first = await desktopTls(dir, ["127.0.0.1"]), next = await desktopTls(dir, ["127.0.0.1"]);
    expect(next.certificateAuthority).toBe(first.certificateAuthority);
    expect(first.renewed).toBe(true);
    expect(next.renewed).toBe(false);
    if (process.platform !== "win32") expect((await stat(path.join(dir, "desktop-tls/authority.json"))).mode & 0o777).toBe(0o600);
    const hub = await HubServer.start({ stateDir: dir, port: 0, tls: await loadHubTls(next) });
    try {
      const request = (ca?: Buffer) => new Promise<string>((resolve, reject) => {
        https.get(hub.url + "/api/tls-identity?nonce=" + "A".repeat(43), { ca }, (res) => { let text = ""; res.on("data", (v) => text += v); res.on("end", () => resolve(text)); }).on("error", reject);
      });
      await expect(request()).rejects.toBeDefined();
      const ca = new X509Certificate(Buffer.from(next.certificateAuthority, "base64")).toString();
      expect(JSON.parse(await request(Buffer.from(ca)))).toMatchObject({ publicKey: hub.auth.publicKey, type: "tls.identity" });
    } finally { await hub.close(); }
  });
  it("can start locally after a previously configured Wi-Fi address disappears", async () => {
    const dir = await directory();
    const started = await desktopHost("start", dir, entry);
    await desktopHost("stop", dir, entry);
    const file = path.join(dir, "config.json"), config = JSON.parse(await readFile(file, "utf8"));
    const tls = await desktopTls(dir, ["192.0.2.123"]);
    const socket = net.createServer(); await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const port = (socket.address() as net.AddressInfo).port; await new Promise<void>((resolve) => socket.close(() => resolve()));
    config.tlsListeners = [{ host: "192.0.2.123", port, exposure: "public", tls: { cert: tls.cert, key: tls.key } }];
    await writeFile(file, JSON.stringify(config));
    expect(await desktopHost("start", dir, entry)).toMatchObject({ running: true, publicKey: "publicKey" in started ? started.publicKey : undefined });
    const renewed = JSON.parse(await readFile(file, "utf8"));
    expect(renewed.tlsListeners.every((listener: { host: string }) => desktopLanAddresses().includes(listener.host))).toBe(true);
  }, 30_000);
  it.runIf(desktopLanAddresses().length > 0)("enables real LAN HTTPS and reopens the same invite without restarting the host", async () => {
    const dir = await directory(); await desktopHost("start", dir, entry);
    const first = await desktopHost("network", dir, entry);
    const again = await desktopHost("network", dir, entry);
    expect(again).toEqual(first);
    if (!("routes" in again)) throw Error("missing LAN routes");
    const route = again.routes[0]!;
    const ca = new X509Certificate(Buffer.from(route.certificateAuthority, "base64")).toString();
    const result = await new Promise<string>((resolve, reject) => {
      https.get(route.url + "/health", { ca }, (response) => { let body = ""; response.on("data", (part) => body += part); response.on("end", () => resolve(body)); }).on("error", reject);
    });
    expect(JSON.parse(result)).toMatchObject({ ok: true, publicKey: "publicKey" in again ? again.publicKey : undefined });
  }, 30_000);
  it.runIf(desktopLanAddresses().length > 0)("does not select a loopback-free port already occupied on the LAN interface", async () => {
    const dir = await directory(); await desktopHost("start", dir, entry);
    const address = desktopLanAddresses()[0]!;
    const occupied = net.createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(0, address, resolve); });
    const port = (occupied.address() as net.AddressInfo).port;
    const originalListen = net.Server.prototype.listen;
    // Force the first explicit LAN candidate to conflict. The Hub and HTTPS
    // request use real sockets, and the allocator must select another port.
    let candidates = 0;
    const listening = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: any[]) {
      if (args[1] === address && candidates++ === 0) args[0] = port;
      return Reflect.apply(originalListen, this, args);
    });
    try {
      const result = await desktopHost("network", dir, entry);
      expect(candidates).toBeGreaterThan(1);
      listening.mockRestore();
      if (!("routes" in result)) throw Error("missing LAN routes");
      const route = result.routes[0]!;
      expect(new URL(route.url).port).not.toBe(String(port));
      expect(JSON.parse(await readFile(path.join(dir, "desktop-network-port.json"), "utf8"))).toBe(Number(new URL(route.url).port));
      const ca = new X509Certificate(Buffer.from(route.certificateAuthority, "base64")).toString();
      const body = await new Promise<string>((resolve, reject) => {
        https.get(route.url + "/health", { ca }, response => { let text = ""; response.on("data", part => text += part); response.on("end", () => resolve(text)); }).on("error", reject);
      });
      expect(JSON.parse(body)).toMatchObject({ ok: true, publicKey: "publicKey" in result ? result.publicKey : undefined });
    } finally {
      listening.mockRestore();
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  }, 30_000);
  it.runIf(Object.values(os.networkInterfaces()).flat().some(address => address?.address === "::1"))("checks the same new port on every interface before saving it", async () => {
    const dir = await directory(); await desktopHost("start", dir, entry);
    // Real IPv4/IPv6 loopback interfaces keep this regression independent of Wi-Fi.
    const addresses = vi.spyOn(desktopTlsModule, "desktopLanAddresses").mockReturnValue(["127.0.0.1", "::1"]);
    const occupied = net.createServer(socket => socket.destroy());
    await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(0, "::1", resolve); });
    const port = (occupied.address() as net.AddressInfo).port;
    const originalListen = net.Server.prototype.listen;
    let candidates = 0;
    const listening = vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: any[]) {
      if (args[0] === 0 && args[1] === "127.0.0.1" && candidates++ === 0) args[0] = port;
      return Reflect.apply(originalListen, this, args);
    });
    try {
      const result = await desktopHost("network", dir, entry);
      expect(candidates).toBeGreaterThan(1);
      if (!("routes" in result)) throw Error("missing routes");
      expect(result.routes).toHaveLength(2);
      const ports = result.routes.map(route => Number(new URL(route.url).port));
      expect(ports[0]).not.toBe(port);
      expect(ports[1]).toBe(ports[0]);
      expect(JSON.parse(await readFile(path.join(dir, "desktop-network-port.json"), "utf8"))).toBe(ports[0]);
    } finally {
      listening.mockRestore(); addresses.mockRestore();
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  }, 30_000);
  it("starts locally if an opted-in interface disappears before its first port allocation", async () => {
    const dir = await directory();
    const first = await desktopHost("start", dir, entry);
    await desktopHost("stop", dir, entry);
    await writeFile(path.join(dir, "desktop-network-enabled.json"), "true\n");
    const addresses = vi.spyOn(desktopTlsModule, "desktopLanAddresses").mockReturnValue(["192.0.2.123"]);
    try {
      expect(await desktopHost("start", dir, entry)).toMatchObject({ running: true, publicKey: "publicKey" in first ? first.publicKey : undefined });
      await expect(readFile(path.join(dir, "desktop-network-port.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readFile(path.join(dir, "desktop-network-enabled.json"), "utf8")).trim()).toBe("true");
    } finally { addresses.mockRestore(); }
  }, 30_000);
  it("prepares the reachable LAN candidate when another interface vanished before the first port allocation", async () => {
    const dir = await directory(); const started = await desktopHost("start", dir, entry);
    const publicKey = "publicKey" in started ? started.publicKey : undefined;
    // 192.0.2.123 is never assigned: its probe, its listener and its health
    // check all fail for real, while the loopback candidate is served for real.
    const addresses = vi.spyOn(desktopTlsModule, "desktopLanAddresses").mockReturnValue(["192.0.2.123", "127.0.0.1"]);
    try {
      const result = await desktopHost("network", dir, entry);
      if (!("routes" in result)) throw Error("missing route");
      expect(result.routes.map(route => new URL(route.url).hostname)).toEqual(["127.0.0.1"]);
      expect(result).toMatchObject({ running: true, publicKey, unavailableRouteCount: 1 });
      const port = Number(new URL(result.routes[0]!.url).port);
      expect(JSON.parse(await readFile(path.join(dir, "desktop-network-port.json"), "utf8"))).toBe(port);
      // An explicit CLI choice of the absent address is never replaced by the reachable one.
      await expect(desktopHost("network", dir, entry, undefined, { selectAddress: () => "192.0.2.123" })).rejects.toThrow("desktop_host_lan_not_listening");
      const selected = await desktopHost("network", dir, entry, undefined, { selectAddress: () => "127.0.0.1" });
      expect(selected).toMatchObject({ routes: result.routes }); expect(selected).not.toHaveProperty("unavailableRouteCount");
      expect(await desktopHost("status", dir, entry)).toMatchObject({ running: true, publicKey });
      expect(JSON.parse(await readFile(path.join(dir, "desktop-network-port.json"), "utf8"))).toBe(port);
    } finally { addresses.mockRestore(); }
  }, 60_000);
  it("rejects an occupied saved route without changing its port or stopping the local host", async () => {
    const dir = await directory(); await desktopHost("start", dir, entry);
    const addresses = vi.spyOn(desktopTlsModule, "desktopLanAddresses").mockReturnValue(["127.0.0.1"]);
    const occupied = net.createServer(socket => socket.destroy());
    try {
      const first = await desktopHost("network", dir, entry);
      if (!("routes" in first)) throw Error("missing route");
      const port = Number(new URL(first.routes[0]!.url).port);
      await desktopHost("stop", dir, entry);
      await new Promise<void>((resolve, reject) => { occupied.once("error", reject); occupied.listen(port, "127.0.0.1", resolve); });
      await expect(desktopHost("network", dir, entry)).rejects.toThrow("desktop_host_lan_not_listening");
      expect(await desktopHost("status", dir, entry)).toMatchObject({ running: true, publicKey: first.publicKey });
      expect(JSON.parse(await readFile(path.join(dir, "desktop-network-port.json"), "utf8"))).toBe(port);
    } finally {
      addresses.mockRestore();
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  }, 30_000);
  it.runIf(desktopLanAddresses().length > 0)("retains the LAN port through an offline startup", async () => {
    const dir = await directory(); await desktopHost("start", dir, entry);
    const first = await desktopHost("network", dir, entry);
    if (!("routes" in first)) throw Error("missing LAN routes");
    await desktopHost("stop", dir, entry);
    const addresses = vi.spyOn(desktopTlsModule, "desktopLanAddresses").mockReturnValue([]);
    try {
      await desktopHost("start", dir, entry);
      expect(JSON.parse(await readFile(path.join(dir, "config.json"), "utf8")).tlsListeners.length).toBeGreaterThan(0);
    } finally { addresses.mockRestore(); }
    const restored = await desktopHost("network", dir, entry);
    if (!("routes" in restored)) throw Error("missing restored routes");
    expect(restored.routes[0]!.url).toBe(first.routes[0]!.url);
    expect(restored.routes[0]!.certificateAuthority).toBe(first.routes[0]!.certificateAuthority);
  }, 30_000);
});
