import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { lookup } from "node:dns";
import { createServer, request as httpsRequest, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { tlsIdentityProof } from "../src/client-protocol/tls-identity.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { networkGenesisText, networkManifestProof, networkPeerProof, sharedRoutesSchema, type NetworkHost, type NetworkManifest, type SignedNetworkManifest, type SignedNetworkPeerRequest } from "../src/client-protocol/private-network.js";
import { exchangeNetworkPeer, loopback, MAX_NETWORK_BYTES } from "../src/hub/network-peer.js";

vi.mock("node:dns", async importOriginal => {
  const actual = await importOriginal<typeof import("node:dns")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});
const keys = generateKeyPairSync("ed25519"), requester = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const requesterKey = requester.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const genesisNonce = randomBytes(32).toString("base64url");
const networkId = `net_${createHash("sha256").update(networkGenesisText(publicKey, genesisNonce)).digest("hex")}`;
let directory: string, address: string, ca: string, tls: { key: Buffer; cert: Buffer }, wrongNameTls: typeof tls, siblingTls: typeof tls;
const servers: Server[] = [];
it("rejects IPv4-mapped unspecified addresses at both route admission and connection guards", () => {
  const url = "https://[::ffff:0.0.0.0]:8788";
  expect(loopback(new URL(url).hostname)).toBe(true);
  expect(sharedRoutesSchema.safeParse([{ name: "Direct", url }]).success).toBe(false);
});
beforeAll(async () => {
  // Exercise real Node TLS sockets with a non-loopback route. No operator CA,
  // keychain or DNS configuration is read or modified.
  address = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)!.address;
  directory = await mkdtemp(path.join(tmpdir(), "network-peer-tls-"));
  const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=Network peer fixture CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  ca = new X509Certificate(await readFile(path.join(directory, "ca.crt"))).raw.toString("base64");
  const pair = async (name: string, san: string) => {
    await writeFile(path.join(directory, `${name}.ext`), `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=network.test"]);
    openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", `${name}.ext`]);
    return { key: await readFile(path.join(directory, `${name}.key`)), cert: await readFile(path.join(directory, `${name}.crt`)) };
  };
  tls = await pair("host", `IP:${address}`); wrongNameTls = await pair("wrong", "DNS:wrong.test"); siblingTls = await pair("sibling", `IP:${address}`);
}, 20_000);
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections(); }))); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
/** The peer Hub's TLS identity proof for the certificate on this connection. */
function identity(req: IncomingMessage, res: ServerResponse) {
  const nonce = new URL(req.url!, "https://fixture").searchParams.get("nonce")!;
  const certificateSha256 = createHash("sha256").update(((req.socket as TLSSocket).getCertificate() as PeerCertificate).raw).digest("hex");
  const proof = { v: 1 as const, type: "tls.identity" as const, publicKey, nonce, certificateSha256 };
  res.end(JSON.stringify({ ...proof, signature: sign(null, Buffer.from(tlsIdentityProof(proof)), keys.privateKey).toString("base64") }));
}
async function serve(handler: Parameters<typeof createServer>[1], pair = tls) {
  const server = createServer(pair, (req, res) => { if (req.method === "GET" && req.url?.startsWith("/api/tls-identity?")) identity(req, res); else handler!(req, res); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, address, resolve));
  return `https://${address}:${(server.address() as { port: number }).port}`;
}
const host = (url: string): NetworkHost => ({ publicKey, name: "Coordinator", routes: [{ name: "Direct", url, certificateAuthority: ca }], state: "active", revoked: false });
const manifest = (): NetworkManifest => ({ v: 1, id: networkId, name: "Private network", authorityKey: publicKey, genesisNonce, revision: 2, hosts: [host(`https://${address}:8788`)], devices: [], revokedMembers: [], blockedBindings: [] });
const signedManifest = (value = manifest()): SignedNetworkManifest => ({ manifest: value, signature: sign(null, Buffer.from(networkManifestProof(value)), keys.privateKey).toString("base64") });
const request = (known?: SignedNetworkManifest): SignedNetworkPeerRequest => {
  const value = { v: 1 as const, networkId, publicKey: requesterKey, nonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 30_000,
    host: { publicKey: requesterKey, name: "Member", routes: [] }, devices: [], revoked: [], ...(known ? { known } : {}) };
  return { request: value, signature: sign(null, Buffer.from(networkPeerProof(value)), requester.privateKey).toString("base64") };
};

it("uses a supplied DER CA, validates the TLS name and separately pins the manifest authority", async () => {
  const sent = request(), response = signedManifest(); let received: unknown;
  const url = await serve((req, res) => {
    expect(req.url).toBe("/api/network/peer"); expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined();
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString()); res.end(JSON.stringify(response));
    });
  });
  expect(await exchangeNetworkPeer(host(url), sent)).toEqual(response);
  expect(received).toEqual(sent);
});

it("accepts a schema-sized directory with route certificates beyond the old 128 KiB limit", async () => {
  const value = manifest();
  for (let index = 1; index < 32; index++) {
    const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    value.hosts.push({ publicKey: key, name: `Host ${index}`, state: "active", revoked: false, routes: Array.from({ length: 9 }, (_, route) => ({
      name: route === 0 ? "Direct" as const : "VPS" as const, url: `https://host-${index}-route-${route}.example`, certificateAuthority: ca,
    })) });
  }
  const response = signedManifest(value), sent = request(response);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(128 * 1024);
  expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(MAX_NETWORK_BYTES);
  const url = await serve((req, res) => { req.resume(); req.on("end", () => res.end(JSON.stringify(response))); });
  expect(await exchangeNetworkPeer(host(url), sent)).toEqual(response);
});

it("rejects an untrusted CA and a trusted certificate for a different host", async () => {
  const response = JSON.stringify(signedManifest());
  const untrusted = host(await serve((_req, res) => res.end(response)));
  delete untrusted.routes[0]!.certificateAuthority;
  await expect(exchangeNetworkPeer(untrusted, request())).rejects.toThrow("network_peer_unavailable");
  const wrong = host(await serve((_req, res) => res.end(response), wrongNameTls));
  await expect(exchangeNetworkPeer(wrong, request())).rejects.toThrow("network_peer_unavailable");
});

it.each(["signature", "authority", "network", "revision"])("rejects a substituted %s in an otherwise valid TLS response", async field => {
  const response = signedManifest();
  if (field === "signature") response.signature = Buffer.alloc(64).toString("base64");
  if (field === "authority") {
    response.manifest.authorityKey = requesterKey; response.manifest.hosts[0]!.publicKey = requesterKey;
    response.signature = sign(null, Buffer.from(networkManifestProof(response.manifest)), requester.privateKey).toString("base64");
  }
  if (field === "network") { response.manifest.id = "other_network"; response.signature = signedManifest(response.manifest).signature; }
  const url = await serve((_req, res) => res.end(JSON.stringify(response)));
  const known = field === "revision" ? signedManifest({ ...manifest(), revision: 3 }) : undefined;
  await expect(exchangeNetworkPeer(host(url), request(known))).rejects.toThrow("network_peer_identity_mismatch");
});

it("rejects a non-canonical signed wire response before normalization can hide the change", async () => {
  const response = signedManifest(); response.manifest.name = ` ${response.manifest.name} `;
  const url = await serve((_req, res) => res.end(JSON.stringify(response)));
  await expect(exchangeNetworkPeer(host(url), request())).rejects.toThrow("network_peer_response_invalid");
});

it("does not follow redirects or forward the signed request to their targets", async () => {
  let targetHits = 0;
  const target = await serve((_req, res) => { targetHits++; res.end(JSON.stringify(signedManifest())); });
  const redirect = await serve((_req, res) => { res.writeHead(307, { Location: target + "/api/network/peer" }); res.end(); });
  await expect(exchangeNetworkPeer(host(redirect), request())).rejects.toThrow("network_peer_rejected");
  expect(targetHits).toBe(0);
});

it("tries the configured backup route after a failed direct route without weakening trust", async () => {
  const response = signedManifest(), hits: string[] = [];
  const direct = await serve((_req, res) => { hits.push("direct"); res.writeHead(503); res.end(); });
  const backup = await serve((_req, res) => { hits.push("backup"); res.end(JSON.stringify(response)); });
  const destination = host(direct); destination.routes.push({ name: "VPS", url: backup, certificateAuthority: ca });
  expect(await exchangeNetworkPeer(destination, request())).toEqual(response);
  expect(hits).toEqual(["direct", "backup"]);
});

it.each(["content-length", "stream"])("bounds oversized %s responses", async mode => {
  const url = await serve((_req, res) => {
    if (mode === "content-length") res.setHeader("Content-Length", MAX_NETWORK_BYTES + 1);
    res.end("x".repeat(MAX_NETWORK_BYTES + 1));
  });
  await expect(exchangeNetworkPeer(host(url), request())).rejects.toThrow("network_peer_response_too_large");
});

it("aborts pending requests and bounds a peer that never finishes its response", async () => {
  let hits = 0;
  const url = await serve((_req, res) => { hits++; res.writeHead(200); res.write("{"); });
  await expect(exchangeNetworkPeer(host(url), request(), { timeoutMs: 100 })).rejects.toThrow("network_peer_timeout");
  // The first exchange may spend its budget proving the peer's TLS identity
  // before its POST; abort only once this exchange's POST is pending.
  const before = hits, controller = new AbortController();
  const pending = exchangeNetworkPeer(host(url), request(), { signal: controller.signal });
  const cancelled = expect(pending).rejects.toThrow("network_peer_cancelled");
  await vi.waitFor(() => expect(hits).toBe(before + 1)); controller.abort(); await cancelled;
});

it("rejects expired requests, plaintext, loopback routes and malformed DER before sending", async () => {
  let hits = 0;
  const url = await serve((_req, res) => { hits++; res.end(JSON.stringify(signedManifest())); });
  const expired = request(); expired.request.expiresAt = Date.now() - 1;
  await expect(exchangeNetworkPeer(host(url), expired)).rejects.toThrow("network_peer_timeout");
  for (const url of ["http://127.0.0.1:8788", "https://127.0.0.1:8788", "https://[::ffff:7f00:1]:8788", "https://localhost:8788", "https://localhost.:8788"]) {
    await expect(exchangeNetworkPeer(host(url), request())).rejects.toThrow();
  }
  const malformed = host(url); malformed.routes[0]!.certificateAuthority = "a".repeat(100);
  await expect(exchangeNetworkPeer(malformed, request())).rejects.toThrow("network_peer_certificate_invalid");
  malformed.routes[0]!.certificateAuthority = Buffer.concat([Buffer.from(ca, "base64"), Buffer.from("trailing-data")]).toString("base64");
  await expect(exchangeNetworkPeer(malformed, request())).rejects.toThrow("network_peer_certificate_invalid");
  expect(hits).toBe(0);
});

it("rejects DNS aliases that resolve to loopback before opening a TLS connection", async () => {
  vi.mocked(lookup).mockImplementationOnce(((_hostname: string, _options: unknown, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) => {
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }) as typeof lookup);
  await expect(exchangeNetworkPeer(host("https://network-alias.example"), request())).rejects.toThrow("network_peer_unavailable");
  expect(lookup).toHaveBeenCalledWith("network-alias.example", expect.anything(), expect.any(Function));
});

it("never sends peer requests to revoked or pending authority hosts", async () => {
  let hits = 0;
  const url = await serve((_req, res) => { hits++; res.end(JSON.stringify(signedManifest())); });
  await expect(exchangeNetworkPeer({ ...host(url), revoked: true }, request())).rejects.toThrow("network_peer_unavailable");
  await expect(exchangeNetworkPeer({ ...host(url), state: "pending", proposalNonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 30_000 }, request())).rejects.toThrow("network_peer_unavailable");
  expect(hits).toBe(0);
});

it("does not send membership to a TLS-terminating intermediary holding another valid certificate", async () => {
  const real = await serve((_req, res) => res.end(JSON.stringify(signedManifest())));
  const seen: string[] = [];
  const intermediary = createServer(siblingTls, (req, res) => {
    const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString()}`);
      const upstream = httpsRequest(new URL(req.url!, real), { method: req.method, headers: req.headers, ca: new X509Certificate(Buffer.from(ca, "base64")).toString(), agent: false }, up => { res.writeHead(up.statusCode!, up.headers); up.pipe(res); });
      upstream.on("error", () => res.destroy()); upstream.end(Buffer.concat(chunks));
    });
  }); servers.push(intermediary);
  await new Promise<void>(resolve => intermediary.listen(0, address, resolve));
  const url = `https://${address}:${(intermediary.address() as { port: number }).port}`;
  await expect(exchangeNetworkPeer(host(url), request(signedManifest()))).rejects.toThrow();
  expect(seen.filter(entry => entry.startsWith("POST"))).toEqual([]);
});

