import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import * as desktopTls from "../src/hub/desktop-tls.js";
import { refreshDesktopHostNetworks } from "../src/hub/desktop.js";
import { loadHubTls } from "../src/hub/tls.js";
import { withFileMutex } from "../src/state/file-mutex.js";

async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function health(port: number, authority: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://127.0.0.1:${port}/health`, { agent: false, ca: new X509Certificate(Buffer.from(authority, "base64")).toString(), timeout: 2000 }, response => {
      let body = ""; response.on("data", value => { body += value; }); response.on("end", () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("fixture_timeout")));
  });
}
// freePort() releases its port before the Hub binds TLS there, and the system
// may reassign it meanwhile (this Hub's own port-0 HTTP listener, or a parallel
// test). The Hub deliberately downgrades that EADDRINUSE to a warning, so an
// HTTPS probe would reach plain HTTP (EPROTO). Probe only a TLS listener that
// actually bound; after a lost race, rerun the setup on another port.
const PORT_ATTEMPTS = 4;
const tlsBound = (hub: HubServer, port: number) => hub.urls.includes(`https://127.0.0.1:${port}`);
const startingAt = (first: number) => { let used = false; return async () => used ? freePort() : (used = true, first); };
async function onBoundPort<T>(setup: (port: number) => Promise<T | undefined>, next: () => Promise<number> = freePort): Promise<{ port: number; value: T }> {
  const lost: number[] = [];
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const port = await next(), value = await setup(port);
    if (value !== undefined) return { port, value };
    lost.push(port);
  }
  throw new Error(`fixture_tls_port_unavailable: ${lost.join(",")}`);
}
const bindManaged = (hub: HubServer, tls: Awaited<ReturnType<typeof loadHubTls>>) => async (port: number) => {
  await hub.refreshTlsListeners([{ host: "127.0.0.1", port, tls }]); return tlsBound(hub, port) || undefined;
};
async function plainHttp(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => response.end("plain")); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

it("keeps local service alive while an optional address is absent, then binds and renews under the same CA", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-listener-recovery-")); let hub: HubServer | undefined;
  try {
    const files = await desktopTls.desktopTls(root, ["127.0.0.1", "192.0.2.123"]), tls = await loadHubTls(files), first = await freePort(), warning = vi.fn();
    hub = await HubServer.start({ stateDir: root, onWarning: warning, tlsListeners: [{ host: "192.0.2.123", port: first, tls, exposure: "public", managed: true }] });
    expect(await (await fetch(hub.url + "/health")).json()).toMatchObject({ ok: true });
    expect(warning).toHaveBeenCalledWith("optional_listener_unavailable");
    const publicKey = hub.auth.publicKey;
    // The same port, unless it was reassigned before the local address bound.
    const { port } = await onBoundPort(bindManaged(hub, tls), startingAt(first));
    expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true, publicKey });
    const renewed = await desktopTls.desktopTls(root, ["127.0.0.1", "127.0.0.2"]);
    expect(renewed.renewed).toBe(true); expect(renewed.certificateAuthority).toBe(files.certificateAuthority);
    await hub.refreshTlsListeners([{ host: "127.0.0.1", port, tls: await loadHubTls(renewed) }]);
    expect(tlsBound(hub, port)).toBe(true);
    expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true, publicKey });
  } finally { await hub?.close(); await rm(root, { recursive: true, force: true }); }
});

it("does not replace a custom listener while maintaining desktop-owned endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-listener-ownership-")); let hub: HubServer | undefined;
  try {
    const files = await desktopTls.desktopTls(root, ["127.0.0.1"]), tls = await loadHubTls(files);
    const { port } = await onBoundPort(async candidate => {
      const started = await HubServer.start({ stateDir: root, tlsListeners: [{ host: "127.0.0.1", port: candidate, tls }] });
      if (tlsBound(started, candidate)) return (hub = started);
      await started.close(); return undefined;
    });
    await expect(hub!.refreshTlsListeners([{ host: "127.0.0.1", port, tls }])).rejects.toThrow("managed_listener_conflict");
    expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true });
  } finally { await hub?.close(); await rm(root, { recursive: true, force: true }); }
});

it("recovers an opted-in network after an offline boot without restarting the Hub", async () => {
  const roots: string[] = []; let hub: HubServer | undefined;
  const addresses = vi.spyOn(desktopTls, "desktopLanAddresses");
  try {
    // The saved desktop port is reused by later refreshes, so a lost race reruns
    // the whole boot on fresh state rather than editing the configuration.
    const { port, value: root } = await onBoundPort(async candidate => {
      const root = await mkdtemp(path.join(os.tmpdir(), "hub-network-wake-")); roots.push(root);
      addresses.mockReturnValue([]);
      await writeFile(path.join(root, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 8788, tlsListeners: [] }));
      await writeFile(path.join(root, "desktop-network-port.json"), JSON.stringify(candidate));
      await writeFile(path.join(root, "desktop-network-enabled.json"), "true\n");
      const started = hub = await HubServer.start({ stateDir: root }); const publicKey = started.auth.publicKey, url = started.url;
      const apply = async (listeners: Parameters<Parameters<typeof refreshDesktopHostNetworks>[1]>[0]) => started.refreshTlsListeners(await Promise.all(listeners.map(async listener => ({ ...listener, tls: await loadHubTls(listener.tls) }))));
      await refreshDesktopHostNetworks(root, apply); expect(started.urls).toEqual([url]);
      addresses.mockReturnValue(["127.0.0.1"]); await refreshDesktopHostNetworks(root, apply);
      expect(started.url).toBe(url); expect(started.auth.publicKey).toBe(publicKey);
      if (tlsBound(started, candidate)) return root;
      hub = undefined; await started.close(); return undefined;
    });
    const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")); expect(config.tlsListeners).toHaveLength(1); expect(config.tlsListeners[0].port).toBe(port);
    const files = await desktopTls.desktopTls(root, ["127.0.0.1"]); expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true, publicKey: hub!.auth.publicKey });
  } finally { addresses.mockRestore(); await hub?.close(); for (const root of roots) await rm(root, { recursive: true, force: true }); }
});

it.each(["a plain HTTP server", "this Hub's own HTTP listener"] as const)("probes a desktop TLS endpoint only after it binds, moving off a port held by %s", async occupant => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-listener-collision-")); let hub: HubServer | undefined, plain: Awaited<ReturnType<typeof plainHttp>> | undefined;
  try {
    const files = await desktopTls.desktopTls(root, ["127.0.0.1"]), tls = await loadHubTls(files), warning = vi.fn();
    hub = await HubServer.start({ stateDir: root, onWarning: warning }); const publicKey = hub.auth.publicKey;
    // A port-0 HTTP listener is invisible to the configured-endpoint conflict check.
    let taken = Number(new URL(hub.url).port);
    if (occupant === "a plain HTTP server") { plain = await plainHttp(); taken = plain.port; }
    const { port } = await onBoundPort(bindManaged(hub, tls), startingAt(taken));
    expect(port).not.toBe(taken); expect(warning).toHaveBeenCalledWith("optional_listener_unavailable");
    expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true, publicKey });
    expect(await (await fetch(hub.url + "/health")).json()).toMatchObject({ ok: true });
  } finally { await hub?.close(); await plain?.close(); await rm(root, { recursive: true, force: true }); }
});

it("restarts a custom TLS listener on another port when its first port is taken", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-listener-restart-")); let hub: HubServer | undefined; const plain = await plainHttp();
  try {
    const files = await desktopTls.desktopTls(root, ["127.0.0.1"]), tls = await loadHubTls(files);
    const { port } = await onBoundPort(async candidate => {
      const started = await HubServer.start({ stateDir: root, tlsListeners: [{ host: "127.0.0.1", port: candidate, tls }] });
      if (tlsBound(started, candidate)) return (hub = started);
      await started.close(); return undefined;
    }, startingAt(plain.port));
    expect(port).not.toBe(plain.port);
    expect(await health(port, files.certificateAuthority)).toMatchObject({ ok: true, publicKey: hub!.auth.publicKey });
  } finally { await hub?.close(); await plain.close(); await rm(root, { recursive: true, force: true }); }
});

it("fails explicitly instead of probing plain HTTP when every attempted port stays taken", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-listener-exhausted-")); let hub: HubServer | undefined;
  try {
    const files = await desktopTls.desktopTls(root, ["127.0.0.1"]), tls = await loadHubTls(files);
    hub = await HubServer.start({ stateDir: root, onWarning: () => undefined });
    const taken = Number(new URL(hub.url).port), bind = vi.fn(bindManaged(hub, tls));
    await expect(onBoundPort(bind, async () => taken)).rejects.toThrow(`fixture_tls_port_unavailable: ${Array(PORT_ATTEMPTS).fill(taken).join(",")}`);
    expect(bind).toHaveBeenCalledTimes(PORT_ATTEMPTS);
    expect(await (await fetch(hub.url + "/health")).json()).toMatchObject({ ok: true });
  } finally { await hub?.close(); await rm(root, { recursive: true, force: true }); }
});

it("does not deadlock a native stop that already owns the desktop mutex", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-network-mutex-"));
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const owner = withFileMutex(path.join(root, "desktop-start"), async () => { entered(); await held; });
  const apply = vi.fn(async () => {});
  try { await ready; await refreshDesktopHostNetworks(root, apply); expect(apply).not.toHaveBeenCalled(); }
  finally { release(); await owner; await rm(root, { recursive: true, force: true }); }
});
