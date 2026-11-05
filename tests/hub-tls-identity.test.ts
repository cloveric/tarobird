import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:https";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { createSecureContext, type TLSSocket } from "node:tls";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { serverProof } from "../src/hub/auth.js";
import { authDeniedProof } from "../src/client-protocol/auth-status.js";
import { tlsIdentityProof, tlsIdentitySchema, verifyTlsIdentity } from "../src/client-protocol/tls-identity.js";

let root: string, ca: Buffer, hubPair: { key: Buffer; cert: Buffer }, alternate: typeof hubPair;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tls-identity-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=Isolated TaroCub CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  await writeFile(path.join(root, "leaf.ext"), "subjectAltName=DNS:hub.test,DNS:alternate.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  const pair = async (name: string) => {
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=hub.test"]);
    openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", "leaf.ext"]);
    return { key: await readFile(path.join(root, `${name}.key`)), cert: await readFile(path.join(root, `${name}.crt`)) };
  };
  ca = await readFile(path.join(root, "ca.crt")); hubPair = await pair("hub"); alternate = await pair("alternate");
}, 20_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const nonce = () => randomBytes(32).toString("base64url");
const verifySignature = (publicKey: string, signature: string, message: Uint8Array) => verify(null, message,
  createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(signature, "base64"));
const port = (server: { address(): unknown }) => (server.address() as { port: number }).port;
function get(target: number, challenge: string, options: { servername?: string; trust?: boolean; suffix?: string } = {}) {
  return new Promise<{ status: number; body: unknown; certificateSha256: string; cache: string | undefined }>((resolve, reject) => {
    let certificateSha256 = "";
    const req = request({ hostname: "127.0.0.1", port: target, servername: options.servername ?? "hub.test", ca: options.trust === false ? undefined : ca,
      rejectUnauthorized: true, agent: false, timeout: 3000, path: `/api/tls-identity?nonce=${encodeURIComponent(challenge)}${options.suffix ?? ""}` }, (res) => {
      certificateSha256 = createHash("sha256").update((res.socket as TLSSocket).getPeerCertificate().raw).digest("hex");
      const chunks: Buffer[] = []; res.on("data", (data) => chunks.push(data)); res.on("error", reject);
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), certificateSha256, cache: res.headers["cache-control"] }); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("test_timeout"))); req.end();
  });
}
const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections(); });

test("shutdown closes a peer that never starts the TLS handshake", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "stalled-handshake"), tls: hubPair });
  const accepted = once(hub.http, "connection");
  const socket = connect(port(hub.http), "127.0.0.1");
  socket.on("error", () => undefined);
  await accepted;
  let closed = false;
  const closing = hub.close().then(() => { closed = true; });
  try { await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1500 }); }
  finally { socket.destroy(); await closing; }
});

test("proves the actual TLS leaf and keeps proof unauthenticated, nonce-bound and non-authorizing", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "direct"), tls: hubPair });
  try {
    const n = nonce(), result = await get(port(hub.http), n), proof = tlsIdentitySchema.parse(result.body);
    expect(result.status).toBe(200); expect(result.cache).toBe("no-store");
    expect(verifyTlsIdentity(result.body, { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256 }, verifySignature)).toEqual(proof);
    expect(Object.keys(proof).sort()).toEqual(["certificateSha256", "nonce", "publicKey", "signature", "type", "v"]);
    expect(await hub.auth.authorize(proof.signature).catch((e) => e.message)).toBe("token_expired_or_invalid");
    expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='auth.accepted'")).toBeUndefined();
    const expected = { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256 };
    expect(() => verifyTlsIdentity(proof, expected, () => { throw new Error("bad_key"); })).toThrow("tls_identity_mismatch");
    expect(() => verifyTlsIdentity({ ...proof, publicKey: "\"\\\n".repeat(20) }, expected, verifySignature)).toThrow("tls_identity_mismatch");
    // Each Hub signing API has a fixed, disjoint prefix. User-controlled nonce
    // fields can never turn an authentication/revocation proof into a TLS proof.
    const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const pair = await hub.auth.pair({ deviceId: "probe", name: "Probe", platform: "web", publicKey }, "unit");
    await hub.auth.approve(pair.code, "local-owner");
    const challenge = await hub.auth.challenge("probe-connection", "probe", n, "unit");
    const tlsBytes = new TextEncoder().encode(tlsIdentityProof(proof));
    expect(verifySignature(hub.auth.publicKey, challenge.signature, tlsBytes)).toBe(false);
    expect(verifySignature(hub.auth.publicKey, proof.signature, serverProof("probe", challenge.nonce, n))).toBe(false);
    await hub.auth.revoke("probe", "local-owner");
    const denied = (await hub.auth.revocationDenial("probe", n))!;
    expect(verifySignature(hub.auth.publicKey, denied.signature, tlsBytes)).toBe(false);
    expect(verifySignature(hub.auth.publicKey, proof.signature, new TextEncoder().encode(authDeniedProof("probe", n)))).toBe(false);
    for (const changed of [{ nonce: nonce() }, { certificateSha256: "f".repeat(64) }, { publicKey: "x".repeat(60) }]) {
      expect(() => verifyTlsIdentity(proof, { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256, ...changed }, verifySignature)).toThrow("tls_identity_mismatch");
    }
    expect((await get(port(hub.http), "short")).status).toBe(400);
    const forced = await get(port(hub.http), nonce(), { suffix: `&certificateSha256=${"f".repeat(64)}` });
    expect(tlsIdentitySchema.parse(forced.body).certificateSha256).toBe(forced.certificateSha256);
    const plain = await fetch(hub.instanceUrl + `/api/tls-identity?nonce=${nonce()}`, { headers: { "X-Forwarded-Proto": "https" } });
    expect(plain.status).toBe(426); expect(await plain.json()).toEqual({ error: "tls_required" });
  } finally { await hub.close(); }
});

test("rotation requires a fresh proof matching the new leaf while preserving the Hub identity", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "rotation"), tls: hubPair });
  try {
    const oldNonce = nonce(), old = await get(port(hub.http), oldNonce);
    (hub.http as Server).setSecureContext(alternate);
    const newNonce = nonce(), current = await get(port(hub.http), newNonce);
    expect(current.certificateSha256).not.toBe(old.certificateSha256);
    const expected = { publicKey: hub.auth.publicKey, nonce: newNonce, certificateSha256: current.certificateSha256 };
    verifyTlsIdentity(current.body, expected, verifySignature);
    expect(() => verifyTlsIdentity(old.body, expected, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyTlsIdentity(current.body, { ...expected, certificateSha256: old.certificateSha256 }, verifySignature)).toThrow("tls_identity_mismatch");
  } finally { await hub.close(); }
});

test("documents that a proxy sharing the Hub TLS private key is outside the certificate-binding guarantee", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "shared-key"), tls: hubPair });
  const proxy = createServer(hubPair, (req, res) => {
    const upstream = request({ hostname: "127.0.0.1", port: port(hub.http), servername: "hub.test", ca, rejectUnauthorized: true, agent: false, path: req.url }, (response) => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); upstream.end();
  });
  await listen(proxy);
  try {
    const n = nonce(), result = await get(port(proxy), n);
    // Both endpoints hold the same certificate key. No certificate-only pin
    // can tell them apart; Hub TLS keys must never be copied to the relay.
    expect(verifyTlsIdentity(result.body, { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256 }, verifySignature)).toBeDefined();
  } finally { await close(proxy); await hub.close(); }
});

test("refuses a real same-CA same-host replacement certificate even when its proxy forwards the signed proof", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "intercept"), tls: hubPair });
  const proxy = createServer(alternate, (req, res) => {
    const upstream = request({ hostname: "127.0.0.1", port: port(hub.http), servername: "hub.test", ca, rejectUnauthorized: true, agent: false, path: req.url }, (response) => {
      res.writeHead(response.statusCode!, response.headers); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); req.on("aborted", () => upstream.destroy()); upstream.end();
  });
  await listen(proxy);
  try {
    const n = nonce(), result = await get(port(proxy), n), proof = tlsIdentitySchema.parse(result.body);
    expect(result.status).toBe(200); // Ordinary hostname/CA verification succeeds.
    expect(verifySignature(proof.publicKey, proof.signature, new TextEncoder().encode(tlsIdentityProof(proof)))).toBe(true);
    expect(proof.certificateSha256).not.toBe(result.certificateSha256);
    const expected = { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256 };
    expect(() => verifyTlsIdentity(proof, expected, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyTlsIdentity({ ...proof, certificateSha256: result.certificateSha256 }, expected, verifySignature)).toThrow("tls_identity_mismatch");
    await expect(get(port(proxy), nonce(), { trust: false })).rejects.toThrow();
    await expect(get(port(proxy), nonce(), { servername: "wrong.test" })).rejects.toThrow();
  } finally { await close(proxy); await hub.close(); }
});

test("accepts TLS passthrough and uses the selected SNI leaf instead of the listener default", async () => {
  const alternateContext = createSecureContext(alternate);
  const hub = await HubServer.start({ stateDir: path.join(root, "passthrough"), tls: { ...hubPair, SNICallback: (name, done) => done(null, name === "alternate.test" ? alternateContext : createSecureContext(hubPair)) } });
  const sockets = new Set<Socket>();
  const relay = createTcpServer((downstream) => {
    const upstream = connect(port(hub.http), "127.0.0.1");
    for (const socket of [downstream, upstream]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => { downstream.destroy(); upstream.destroy(); }); }
    downstream.pipe(upstream).pipe(downstream);
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  try {
    const fingerprints = [];
    for (const servername of ["hub.test", "alternate.test"]) {
      const n = nonce(), result = await get(port(relay), n, { servername });
      verifyTlsIdentity(result.body, { publicKey: hub.auth.publicKey, nonce: n, certificateSha256: result.certificateSha256 }, verifySignature);
      fingerprints.push(result.certificateSha256);
    }
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => relay.close(() => resolve())); await hub.close(); }
});

test("rate limits proof signatures independently of device authentication", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "limited"), tls: hubPair });
  try {
    for (let i = 0; i < 60; i++) expect((await get(port(hub.http), nonce())).status).toBe(200);
    expect((await get(port(hub.http), nonce())).status).toBe(429);
    expect((await fetch(hub.instanceUrl + "/health")).status).toBe(200);
  } finally { await hub.close(); }
});
