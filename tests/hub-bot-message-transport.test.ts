import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { loadHubTls } from "../src/hub/tls.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { exchangeBotMessage } from "../src/hub/bot-message-transport.js";
import { networkId } from "../src/hub/private-network.js";
import type { NetworkHost, NetworkManifest } from "../src/client-protocol/private-network.js";
import type { BotPassport } from "../src/client-protocol/bot-messages.js";

let root: string, a: HubServer, b: HubServer, address: string, ca: string, tls: Awaited<ReturnType<typeof loadHubTls>>;
const servers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bot-peer-"));
  address = Object.values(networkInterfaces()).flat().find(a => a?.family === "IPv4" && !a.internal)!.address;
  const cert = await desktopTls(root, [address]); ca = cert.certificateAuthority; tls = await loadHubTls({ cert: cert.cert, key: cert.key });
  a = await HubServer.start({ stateDir: path.join(root, "a") });
  b = await HubServer.start({ stateDir: path.join(root, "b"), host: address, tls, exposure: "public" });
  const hosts = [a, b].map((h, i) => ({ publicKey: h.auth.publicKey, name: i ? "B" : "A", routes: i ? [{ name: "Direct" as const, url: b.url, certificateAuthority: ca }] : [], protocol: 2 as const, state: "active" as const, revoked: false }));
  const nonce = randomBytes(32).toString("base64url");
  const manifest: NetworkManifest = { v: 2, id: networkId(a.auth.publicKey, nonce), authorityKey: a.auth.publicKey, genesisNonce: nonce, name: "Test", revision: 1, hosts, devices: [], revokedMembers: [], blockedBindings: [] };
  for (const hub of [a, b]) {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('sender','Sender','fixture'),('receiver','Receiver','fixture')");
    await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes: hub === b ? hosts[1]!.routes : [], membership: { manifest, signature: a.auth.signNetworkManifest(manifest) }, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  }
  await b.botMessages.grant({ sourceHost: "A", sourceBot: "sender", targetBot: "receiver" }, async () => undefined);
});
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); await a?.close(); await b?.close(); await rm(root, { recursive: true, force: true }); });
const host = (url = b.url): NetworkHost => ({ publicKey: b.auth.publicKey, name: "B", state: "active", revoked: false, routes: [{ name: "Direct", url, certificateAuthority: ca }] });
/** A fixture peer answering as Hub B for the certificate on this connection. */
const identity = (req: IncomingMessage, res: ServerResponse) => {
  const nonce = new URL(req.url!, "https://fixture").searchParams.get("nonce")!;
  res.end(JSON.stringify(b.auth.tlsIdentity(nonce, ((req.socket as TLSSocket).getCertificate() as PeerCertificate).raw, "127.0.0.1")));
};
const caPem = () => `-----BEGIN CERTIFICATE-----\n${ca.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
const passport = (body: Buffer): BotPassport => ({ v: 1, sourceKey: a.auth.publicKey, targetKey: b.auth.publicKey, source: { hostId: messageHostId(a.auth.publicKey), hostName: "A", botId: "sender", botName: "Sender", hops: 1, requestId: randomUUID() }, targetBot: "receiver", method: "POST", path: "/api/bot-messages/conversations", digest: createHash("sha256").update(body).digest("hex"), expiresAt: Date.now() + 60_000, nonce: randomUUID() });

it("uses real TLS and the target's existing upload routes for text/file admission and reply retrieval", async () => {
  const invoke = (operation: any, data: Record<string, unknown> = {}, conversation?: string) => a.botMessages.local({ operation, host: messageHostId(b.auth.publicKey), bot: "receiver", requestId: randomUUID(), data, ...(conversation ? { conversation } : {}) }, "sender", async () => undefined, true) as Promise<any>;
  const c = await invoke("resolve"), data = Buffer.from("Real TLS file");
  const upload = await invoke("upload", { name: "file.txt", mime: "text/plain", size: data.length, sha256: createHash("sha256").update(data).digest("hex") }, c.conversationId);
  await invoke("chunk", { uploadId: upload.id, index: 0, bytes: data.toString("base64") }, c.conversationId);
  await invoke("complete", { uploadId: upload.id }, c.conversationId);
  const sent = await invoke("send", { text: "TLS task", attachments: [upload.id] }, c.conversationId);
  await b.store.publishBotMessage("receiver", { conversationId: c.conversationId, replyTo: sent.messageId, blocks: [{ type: "text", text: "TLS reply" }] });
  await b.store.acknowledgeDelivery("receiver", sent.messageId);
  expect(await invoke("wait", { messageId: sent.messageId }, c.conversationId)).toMatchObject({ status: "completed", text: "TLS reply" });
  expect((await b.store.messageForBot("receiver", sent.messageId)).botSource?.hostId).toBe(messageHostId(a.auth.publicKey));
});

it("rejects untrusted TLS before sending private content", async () => {
  const body = Buffer.from("{}"), p = passport(body), h = host(); delete h.routes[0]!.certificateAuthority;
  await expect(exchangeBotMessage(h, { passport: p, signature: a.auth.signBotPassport(p) }, body)).rejects.toThrow("unavailable_or_upgrade_required");
  expect(await b.store.db.all("SELECT * FROM audit_log WHERE kind='bot-message.send'")).toHaveLength(0);
});

it("allows a signed chunk exchange taking over five seconds without retransmitting", async () => {
  const body = Buffer.alloc(8 * 1024 * 1024, 42), p = passport(body);
  p.method = "PUT"; p.path = "/api/uploads/fixture/0";
  let requests = 0, received = 0;
  const server = createServer(tls, (req, res) => {
    if (req.method === "GET") { identity(req, res); return; }
    requests++;
    req.on("data", chunk => { received += chunk.length; });
    req.on("end", () => { const timer = setTimeout(() => {
      const result = { received };
      res.end(JSON.stringify({ result, signature: b.auth.signBotReply(p.nonce, result) }));
    }, 6_000); res.once("close", () => clearTimeout(timer)); });
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, address, r));
  await expect(exchangeBotMessage(host(`https://${address}:${(server.address() as any).port}`),
    { passport: p, signature: a.auth.signBotPassport(p) }, body)).resolves.toEqual({ received: body.length });
  expect(requests).toBe(1);
}, 15_000);

it("keeps a continuously progressing upload alive beyond the idle interval", async () => {
  const body = Buffer.alloc(8 * 1024 * 1024, 42), p = passport(body);
  p.method = "PUT"; p.path = "/api/uploads/slow/0";
  let requests = 0, received = 0, readTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer(tls, (req, res) => {
    if (req.method === "GET") { identity(req, res); return; }
    requests++;
    req.on("data", chunk => {
      received += chunk.length; req.pause();
      readTimer = setTimeout(() => req.resume(), Math.ceil(chunk.length / (400 * 1024) * 1000));
    });
    res.on("close", () => clearTimeout(readTimer));
    req.on("end", () => { const result = { received }; res.end(JSON.stringify({ result, signature: b.auth.signBotReply(p.nonce, result) })); });
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, address, r));
  const started = performance.now();
  await expect(exchangeBotMessage(host(`https://${address}:${(server.address() as any).port}`),
    { passport: p, signature: a.auth.signBotPassport(p) }, body)).resolves.toEqual({ received: body.length });
  expect(performance.now() - started).toBeGreaterThan(15_000); expect(requests).toBe(1);
}, 45_000);

it("admits a supported batch of 20 small files without exhausting the peer control bucket", async () => {
  const invoke = (operation: any, data: Record<string, unknown> = {}, conversation?: string) => a.botMessages.local({ operation, host: messageHostId(b.auth.publicKey), bot: "receiver", requestId: randomUUID(), data, ...(conversation ? { conversation } : {}) }, "sender", async () => undefined, true) as Promise<any>;
  const c = await invoke("resolve"), attachments: string[] = [];
  for (let i = 0; i < 20; i++) {
    const bytes = Buffer.from(`batch file ${i}`);
    const upload = await invoke("upload", { name: `file-${i}.txt`, mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, c.conversationId);
    await invoke("chunk", { uploadId: upload.id, index: 0, bytes: bytes.toString("base64") }, c.conversationId);
    await invoke("complete", { uploadId: upload.id }, c.conversationId);
    attachments.push(upload.id);
  }
  const sent = await invoke("send", { text: "Batch task", attachments }, c.conversationId);
  expect((await b.store.messageForBot("receiver", sent.messageId)).blocks.filter(block => block.type === "file")).toHaveLength(20);
}, 60_000);

it("never retries or falls back after a valid peer receives the POST and drops the response", async () => {
  let posts = 0, fallbackRequests = 0;
  const server = createServer(tls, (req, res) => {
    if (req.method === "GET") { identity(req, res); return; }
    posts++; req.resume(); req.on("end", () => res.destroy());
  }); servers.push(server);
  await new Promise<void>(r => server.listen(0, address, r));
  const fallback = createServer(tls, (_req, res) => { fallbackRequests++; res.end("{}"); }); servers.push(fallback); await new Promise<void>(r => fallback.listen(0, address, r));
  const h = host(`https://${address}:${(server.address() as any).port}`); h.routes.push({ name: "VPS", url: `https://${address}:${(fallback.address() as any).port}`, certificateAuthority: ca });
  const body = Buffer.from("{}"), p = passport(body);
  await expect(exchangeBotMessage(h, { passport: p, signature: a.auth.signBotPassport(p) }, body)).rejects.toThrow();
  expect(posts).toBe(1); expect(fallbackRequests).toBe(0);
});

// Another leaf for the same address from the same private CA: as valid for TLS
// as the Hub's own, like a relay that obtains its own public certificate.
async function siblingTls() {
  const other = path.join(root, "intermediary"); await mkdir(path.join(other, "desktop-tls"), { recursive: true });
  await copyFile(path.join(root, "desktop-tls", "authority.json"), path.join(other, "desktop-tls", "authority.json"));
  const cert = await desktopTls(other, [address]);
  return loadHubTls({ cert: cert.cert, key: cert.key });
}
/** Terminates TLS with its own certificate and forwards everything to the real Hub. */
function intermediary(credentials: Awaited<ReturnType<typeof loadHubTls>>, port = 0) {
  const seen: Array<{ method: string; path: string; passport: boolean; body: string }> = [];
  const server = createServer(credentials, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk)); req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method!, path: req.url!, passport: !!req.headers["x-tarobot-message-passport"], body: body.toString("utf8") });
      const upstream = request(new URL(req.url!, b.url), { method: req.method, headers: { ...req.headers, host: new URL(b.url).host }, ca: caPem(), agent: false }, up => { res.writeHead(up.statusCode!, up.headers); up.pipe(res); });
      upstream.on("error", () => res.destroy()); upstream.end(body);
    });
  });
  servers.push(server);
  return { seen, listening: new Promise<string>(r => server.listen(port, address, () => r(`https://${address}:${(server.address() as any).port}`))) };
}

it("refuses a TLS-terminating intermediary with its own valid certificate before sending the passport or body", async () => {
  const mitm = intermediary(await siblingTls()), url = await mitm.listening;
  const body = Buffer.from(JSON.stringify({ secret: "cross-host task text" })), p = passport(body);
  await expect(exchangeBotMessage(host(url), { passport: p, signature: a.auth.signBotPassport(p) }, body)).rejects.toThrow("unavailable_or_upgrade_required");
  expect(mitm.seen.filter(request => request.passport || request.body.includes("cross-host task text"))).toEqual([]);
  expect(await b.store.db.all("SELECT * FROM audit_log WHERE kind IN ('bot-message.send','bot-message.rejected')")).toHaveLength(0);
});

it("re-proves a rotated certificate once and still sends exactly once", async () => {
  let posts = 0;
  const serve = (credentials: Awaited<ReturnType<typeof loadHubTls>>, port = 0) => {
    const server = createServer(credentials, (req, res) => {
      if (req.method === "GET") { identity(req, res); return; }
      posts++; req.resume(); req.on("end", () => { const result = { ok: true }; res.end(JSON.stringify({ result, signature: b.auth.signBotReply(p.nonce, result) })); });
    }); servers.push(server);
    return new Promise<Server>(r => server.listen(port, address, () => r(server)));
  };
  const body = Buffer.from("{}"), p = passport(body), signed = () => ({ passport: p, signature: a.auth.signBotPassport(p) });
  const first = await serve(tls), port = (first.address() as any).port, h = host(`https://${address}:${port}`);
  await expect(exchangeBotMessage(h, signed(), body)).resolves.toEqual({ ok: true });
  first.closeAllConnections(); await new Promise<void>(r => first.close(() => r()));
  await serve(await siblingTls(), port);
  await expect(exchangeBotMessage(h, signed(), body)).resolves.toEqual({ ok: true });
  expect(posts).toBe(2);
});

it("rejects an intermediary that replaces a previously proved endpoint, without transmitting", async () => {
  const body = Buffer.from(JSON.stringify({ secret: "cached route task" })), p = passport(body);
  // Prove Hub B on this origin first, so a pin is cached for it.
  const real = createServer(tls, (req, res) => { if (req.method === "GET") identity(req, res); else res.destroy(); }); servers.push(real);
  const port = await new Promise<number>(r => real.listen(0, address, () => r((real.address() as any).port)));
  const h = host(`https://${address}:${port}`);
  await expect(exchangeBotMessage(h, { passport: p, signature: a.auth.signBotPassport(p) }, body)).rejects.toThrow();
  real.closeAllConnections(); await new Promise<void>(r => real.close(() => r()));
  const mitm = intermediary(await siblingTls(), port); await mitm.listening;
  await expect(exchangeBotMessage(h, { passport: p, signature: a.auth.signBotPassport(p) }, body)).rejects.toThrow("unavailable_or_upgrade_required");
  expect(mitm.seen.filter(request => request.passport || request.body.includes("cached route task"))).toEqual([]);
});

