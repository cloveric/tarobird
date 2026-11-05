// Isolated adversarial peers for the Rust transport test. No OS trust changes.
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:https";
import type { TLSSocket } from "node:tls";
import { createInterface } from "node:readline";
import path from "node:path";
import { WebSocketServer } from "ws";
import { enrollTrusted, issueInvite, testDevice } from "./pairing-invite.js";
import { HubServer } from "../../src/hub/server.js";

const root = process.argv[2]!;
const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=Native Transport Test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
await writeFile(path.join(root, "leaf.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
async function leaf(name: string) {
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", "/CN=Test Hub"]);
  openssl(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.crt`, "-days", "1", "-extfile", "leaf.ext"]);
  return { key: await readFile(path.join(root, `${name}.key`)), cert: await readFile(path.join(root, `${name}.crt`)) };
}
const good = await leaf("hub"), evil = await leaf("alternate"), ca = await readFile(path.join(root, "ca.crt"));
await writeFile(path.join(root, "ca.der"), new X509Certificate(ca).raw);
const hub = await HubServer.start({ stateDir: path.join(root, "state"), tls: good });
let sensitive = 0, proofs = 0, stalledUploads = 0, suppressedCloseReplies = 0, acceptedDroppedUploads = 0;
const proxy = createServer(evil, (req, res) => {
  if (req.url?.startsWith("/api/tls-identity?")) proofs++;
  else sensitive++;
  const upstream = request(hub.url + req.url, { ca, method: req.method, headers: req.headers }, (result) => {
    res.writeHead(result.statusCode!, result.headers); result.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
});
proxy.on("upgrade", (_req, socket) => { sensitive++; socket.destroy(); });
let upgradeMode = "normal", rawUpgrades = 0, peerCloseConfirmed = 0, peerCloseAborted = 0, clientCloseFrames = 0;
const rawUpgradeSockets = new Set<import("node:stream").Duplex>();
const sockets = new WebSocketServer({ noServer: true });
sockets.on("connection", (socket) => socket.on("message", (data) => {
  const text = data.toString();
  if (text === "$audit:burst" || text === "$audit:burst-close") {
    for (let i = 0; i < 9; i++) socket.send(`receipt-${i}`);
    if (text.endsWith("-close")) socket.close(3333, "peer done");
  } else if (text === "$audit:oversize") socket.send("x".repeat(1024 * 1024 + 1));
  else if (text === "$audit:oversize-header") {
    const header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(1024n * 1024n * 1024n, 2);
    (socket as unknown as { _socket: import("node:net").Socket })._socket.write(header);
  }
  else if (text === "$audit:fragment-overflow") { socket.send("x".repeat(600 * 1024), { fin: false }); socket.send("x".repeat(600 * 1024), { fin: false }); }
  else if (text === "$audit:fragment-empty") { for (let i = 0; i < 4097; i++) socket.send("", { fin: false }); }
  else if (text === "$audit:fragment-valid") { socket.send("x".repeat(512 * 1024), { fin: false }); socket.send("x".repeat(512 * 1024), { fin: true }); }
  else if (text === "$audit:fragment-unicode") { const bytes = Buffer.from("你好"); socket.send(bytes.subarray(0, 1), { binary: false, fin: false }); socket.send(bytes.subarray(1), { binary: false, fin: true }); }
  else if (text === "$audit:stall-writes") { socket.send("stall-ready"); (socket as unknown as { _socket: import("node:net").Socket })._socket.pause(); }
  else if (text === "$audit:masked" || text === "$audit:masked-split") {
    // Invalid server masking, including a header split across TCP writes.
    const frame = Buffer.from([0x81, 0x83, 1, 2, 3, 4, 0x63, 0x63, 0x67]);
    const wire = (socket as unknown as { _socket: import("node:net").Socket })._socket;
    if (text.endsWith("-split")) { wire.write(frame.subarray(0, 1)); setTimeout(() => { if (!wire.destroyed) wire.write(frame.subarray(1)); }, 15); }
    else wire.write(frame);
  }
  else if (text === "$audit:count-close") {
    let pending = Buffer.alloc(0);
    (socket as unknown as { _socket: import("node:net").Socket })._socket.on("data", (bytes) => {
      if (pending.length + bytes.length > 4096) return;
      pending = Buffer.concat([pending, bytes]);
      while (pending.length >= 2) {
        const size = pending[1]! & 127; if (size >= 126) return;
        const total = 2 + ((pending[1]! & 128) ? 4 : 0) + size; if (pending.length < total) return;
        if ((pending[0]! & 15) === 8) clientCloseFrames++;
        pending = pending.subarray(total);
      }
    });
    socket.send("count-ready");
  }
  else if (text === "$audit:peer-close") {
    socket.once("close", (code) => { if (code === 3333) peerCloseConfirmed++; else peerCloseAborted++; });
    socket.close(3333, "peer done");
  }
  else if (text === "$audit:byte-burst") { for (let i = 0; i < 3; i++) socket.send("x".repeat(600 * 1024)); }
  else if (text === "$audit:ignore-close") {
    const receiver = (socket as unknown as { _receiver: import("node:events").EventEmitter })._receiver;
    receiver.removeAllListeners("conclude");
    receiver.on("conclude", () => { suppressedCloseReplies++; });
    socket.send("ignore-ready");
  }
  else if (text === "$audit:terminate") socket.terminate();
  else socket.send(text);
}));
const rotating = createServer(good, async (req, res) => {
  // Close HTTP connections to force the next request through a new TLS check.
  res.setHeader("Connection", "close");
  if (req.url?.startsWith("/api/tls-identity?")) {
    const nonce = new URL(req.url, "https://localhost").searchParams.get("nonce")!;
    const certificate = (req.socket as TLSSocket).getCertificate()!;
    if (!("raw" in certificate)) throw new Error("missing_test_certificate");
    res.end(JSON.stringify(await hub.auth.tlsIdentity(nonce, certificate.raw, "native-fixture"))); return;
  }
  if (req.url === "/api/redirect") { res.writeHead(307, { Location: proxyUrl + "/api/stolen" }); res.end(); return; }
  if (req.url === "/api/large") {
    res.writeHead(200, { "Content-Length": 512 * 1024 * 1024 });
    const chunk = Buffer.alloc(64 * 1024, 0x61); let left = 8192;
    const send = () => { while (left > 0) { left--; if (!res.write(chunk)) { res.once("drain", send); return; } } res.end(); };
    send(); return;
  }
  if (req.url === "/api/echo") {
    // Production uploads acknowledge after consumption. HTTP/1 clients need
    // not support a full-duplex request/response echo while still uploading.
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(Buffer.from(chunk)); }
    res.end(Buffer.concat(chunks)); return;
  }
  if (req.url === "/api/hang") { res.writeHead(200); res.flushHeaders(); return; }
  if (req.url === "/api/drop-after-upload") { for await (const _ of req) { /* consume without response */ } acceptedDroppedUploads++; req.socket.destroy(); return; }
  if (req.url === "/api/hang-prefix") { res.writeHead(200, { "Content-Length": 262145 }); res.write(Buffer.alloc(64 * 1024, 0x61)); return; }
  if (req.url === "/api/stalled-upload") { stalledUploads++; req.pause(); return; }
  res.end(JSON.stringify({ ok: true }));
});
rotating.on("upgrade", (req, socket, head) => {
  const mode = upgradeMode; upgradeMode = "normal";
  if (mode === "normal") { sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws, req)); return; }
  rawUpgrades++; rawUpgradeSockets.add(socket); socket.on("error", () => {}); socket.on("close", () => rawUpgradeSockets.delete(socket)); socket.resume();
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  const header = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`;
  if (mode === "large-header") socket.write(header + "X-Large: " + "x".repeat(32 * 1024));
  else if (mode === "extension") socket.write(header + "Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n");
  else if (mode === "redirect") socket.write(`HTTP/1.1 307 Temporary Redirect\r\nLocation: ${proxyUrl}/stolen\r\nContent-Length: 0\r\n\r\n`);
});
const listen = async (server: Server) => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); return `https://127.0.0.1:${(server.address() as { port: number }).port}`; };
const proxyUrl = await listen(proxy), rotatingUrl = await listen(rotating);
const invitationOwner = await enrollTrusted(hub.auth, testDevice("native_fixture_owner", "Native transport fixture issuer"));
const invitation = await issueInvite(hub.auth, invitationOwner);
console.log(JSON.stringify({ hub: hub.url, key: hub.auth.publicKey, proxy: proxyUrl, rotating: rotatingUrl, invite: invitation.invite }));
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "rotate") { rotating.setSecureContext(evil); rotating.closeIdleConnections(); console.log("ok"); }
  else if (line === "rotate-back") { rotating.setSecureContext(good); rotating.closeIdleConnections(); console.log("ok"); }
  else if (/^approve:\d{8}$/.test(line)) { await hub.auth.approve(line.slice(8), "local-owner"); console.log("ok"); }
  else if (["large-header", "extension", "redirect", "hang"].some((mode) => line === "ws-mode:" + mode)) { upgradeMode = line.slice(8); console.log("ok"); }
  else if (line === "ws-close-all") { for (const socket of sockets.clients) if (socket.readyState === 1) socket.close(3333, "peer done"); console.log("ok"); }
  else if (line === "stats") console.log(JSON.stringify({ sensitive, proofs, stalledUploads, suppressedCloseReplies, acceptedDroppedUploads, rawUpgrades, peerCloseConfirmed, peerCloseAborted, clientCloseFrames }));
  else if (line === "stop") break;
}
for (const socket of rawUpgradeSockets) socket.destroy();
for (const client of sockets.clients) client.terminate();
await Promise.all([hub.close(), new Promise<void>((r) => { proxy.close(() => r()); proxy.closeAllConnections(); }), new Promise<void>((r) => { rotating.close(() => r()); rotating.closeAllConnections(); })]);
