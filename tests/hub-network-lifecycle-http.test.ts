import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { request } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { deviceActionProofText, deviceActionStatementSchema } from "../src/client-protocol/device-actions.js";
import { networkCanonical, networkCommandSchema, networkManifestProof, type NetworkCommandInput, type NetworkCommandResult, type NetworkView } from "../src/client-protocol/private-network.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

type Device = { id: string; publicKey: string; privateKey: KeyObject; token: string };
type Host = { hub: HubServer; owner: Device };
let directory: string, address: string, ca: string, tls: { key: Buffer; cert: Buffer };
const hosts: Host[] = [];
const sockets: WebSocket[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "network-lifecycle-http-"));
  address = Object.values(networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)!.address;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "tls.key", "-out", "tls.crt", "-days", "1", "-subj", "/CN=Disposable network lifecycle test", "-addext", `subjectAltName=IP:${address}`, "-addext", "basicConstraints=critical,CA:TRUE"], { cwd: directory, stdio: "ignore" });
  tls = { key: await readFile(path.join(directory, "tls.key")), cert: await readFile(path.join(directory, "tls.crt")) };
  ca = new X509Certificate(tls.cert).raw.toString("base64");
});
afterEach(async () => { sockets.splice(0).forEach(socket => socket.terminate()); await Promise.allSettled(hosts.splice(0).map(host => host.hub.close())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

/** Calls the actual TLS listener with normal certificate and hostname checks. */
async function http<T>(hub: HubServer, route: string, body?: unknown, token?: string, method?: string) {
  return new Promise<{ status: number; body: T }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(new URL(route, hub.url), { method: method ?? (data ? "POST" : "GET"), ca: tls.cert, rejectUnauthorized: true,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.end(data);
  });
}
async function login(hub: HubServer, id: string, privateKey: KeyObject) {
  const nonce = randomBytes(32).toString("base64url"), socket = randomBytes(16).toString("hex");
  const challenge = await hub.auth.challenge(socket, id, nonce, "fixture");
  return (await hub.auth.authenticate(socket, sign(null, deviceProof(id, challenge.nonce, nonce), privateKey).toString("base64"))).token;
}
async function device(hub: HubServer, id: string, localDesktop = false): Promise<Device> {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const pending = await hub.auth.pair({ deviceId: id, publicKey, name: id, platform: "web" }, "fixture");
  if (localDesktop) await hub.auth.approveLocalDesktop(pending.code);
  else await hub.auth.approve(pending.code, "local-owner");
  return { id, publicKey, privateKey: keys.privateKey, token: await login(hub, id, keys.privateKey) };
}
async function view(host: Host) {
  const response = await http<NetworkView>(host.hub, "/api/network", undefined, host.owner.token); expect(response.status).toBe(200); return response.body;
}
async function mutationResponse(host: Host, raw: NetworkCommandInput, actor = host.owner) {
  const current = await view(host);
  if (raw.operation === "leave") raw = { expectedState: current.membership ? current.host.state : "standalone", ...raw };
  if (raw.operation === "remove") raw = { expectedState: current.membership!.manifest.hosts.find(value => value.publicKey === raw.publicKey)!.state, ...raw };
  const command = networkCommandSchema.parse(["routes", "attest", "remove", "leave"].includes(raw.operation) ? { networkId: current.membership?.manifest.id ?? "", ...raw } : raw);
  const challenge = await http(host.hub, "/api/devices/challenge", { operation: "network", target: hashSecret(networkCanonical(command)) }, actor.token);
  expect(challenge.status).toBe(200); const statement = deviceActionStatementSchema.parse(challenge.body);
  const proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), actor.privateKey).toString("base64") };
  return http<NetworkCommandResult>(host.hub, "/api/network/manage", { command, proof }, actor.token);
}
async function mutation(host: Host, raw: NetworkCommandInput, actor = host.owner) {
  const result = await mutationResponse(host, raw, actor); expect(result.status, JSON.stringify(result.body)).toBe(200); return result.body;
}
async function host(name: string) {
  const hub = await HubServer.start({ stateDir: path.join(directory, randomBytes(8).toString("hex")), host: address, exposure: "public", tls,
    managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { PATH: "", CODEX_EXECUTABLE: process.execPath } } });
  const value = { hub, owner: await device(hub, `${name}_owner`, true) }; hosts.push(value);
  await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
  await mutation(value, { operation: "routes", routes: [{ name: "Direct", url: hub.url, certificateAuthority: ca }] });
  return value;
}
async function join(root: Host, peer: Host) {
  const manifest = (await view(root)).membership!.manifest;
  const { proposal } = await mutation(peer, { operation: "propose", networkId: manifest.id, authorityKey: manifest.authorityKey, seenManifestHash: hashSecret(networkCanonical(manifest)) });
  const { membership } = await mutation(root, { operation: "admit", proposal: proposal! });
  await mutation(peer, { operation: "join", membership: membership!, nonce: proposal!.proposal.nonce });
}
async function install(source: Host, target: Host, id: string, actor = source.owner): Promise<Device> {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { membership } = await mutation(source, { operation: "attest", device: { id, publicKey, host: target.hub.auth.publicKey, name: id, platform: "web" } }, actor);
  expect((await http(target.hub, "/api/network/enroll", membership)).status).toBe(200);
  return { id, publicKey, privateKey: keys.privateKey, token: await login(target.hub, id, keys.privateKey) };
}

async function socket(hub: HubServer, actor: Device) {
  const ws = new WebSocket(hub.url.replace("https:", "wss:") + "/ws", { ca: tls.cert, rejectUnauthorized: true }); sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const send = (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame }));
  const next = async (type: string) => {
    await vi.waitFor(() => expect(frames.some(frame => frame.type === type)).toBe(true), { timeout: 3000, interval: 10 });
    return frames.splice(frames.findIndex(frame => frame.type === type), 1)[0]!;
  };
  const nonce = randomBytes(32).toString("base64url");
  send({ type: "hello", deviceId: actor.id, nonce, protocolVersions: [1], capabilities: ["cards.v1"], cursors: {} });
  const challenge = await next("challenge");
  send({ type: "auth", signature: sign(null, deviceProof(actor.id, String(challenge.nonce), nonce), actor.privateKey).toString("base64") });
  await next("ready"); await next("sync.complete");
  return { ws, send, next, frames };
}

async function seedChat(host: Host) {
  await host.hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('resident_bot','Resident Bot','fixture')");
  const chat = await host.hub.store.createConversation("owner", ["resident_bot"], "Resident history", "resident_chat");
  await host.hub.store.publishBotMessage("resident_bot", { conversationId: chat.id, blocks: [{ type: "text", text: "History stays on this host" }] });
  return chat.id;
}

it("an active peer leaves through signed TLS, revokes its derived keys network-wide, and retains its original local owner", async () => {
  const a = await host("A"), b = await host("B"), c = await host("C");
  await mutation(a, { operation: "create", name: "Lifecycle network" }); await join(a, b); await join(a, c); await b.hub.network.tick();
  const bOnA = await install(b, a, "b_on_a"), bOnC = await install(b, c, "b_on_c"), aOnB = await install(a, b, "a_on_b");
  for (const [target, remote] of [[a, bOnA], [b, aOnB], [c, bOnC]] as const) expect((await http(target.hub, "/api/network", undefined, remote.token)).status).toBe(200);
  const left = await mutation(b, { operation: "leave" });
  expect(left.view.sync).toBe("standalone"); expect(left.view.membership).toBeUndefined();
  const root = (await view(a)).membership!.manifest;
  expect(root.hosts.find(value => value.publicKey === b.hub.auth.publicKey)?.revoked).toBe(true);
  const revokedDevices = root.devices.filter(value => value.originHost === b.hub.auth.publicKey);
  expect(revokedDevices.length).toBeGreaterThan(0);
  expect(revokedDevices.every(value => value.revoked)).toBe(true);
  expect((await http(a.hub, "/api/network", undefined, bOnA.token)).status).toBe(401);
  expect((await http(b.hub, "/api/network", undefined, aOnB.token)).status).toBe(401);
  await c.hub.network.tick(); expect((await http(c.hub, "/api/network", undefined, bOnC.token)).status).toBe(401);
  for (const own of [a, b, c]) expect((await http(own.hub, "/api/network", undefined, own.owner.token)).status).toBe(200);
  expect((await b.hub.store.device(b.owner.id))?.revoked).toBe(0);
});

it("a removed peer learns its signed removal snapshot over TLS without seeing members added afterward", async () => {
  const a = await host("A"), b = await host("B");
  await mutation(a, { operation: "create", name: "Removal network" }); await join(a, b);
  const imported = await install(a, b, "a_on_b");
  const knownBeforeRemoval = (await view(a)).membership!;
  const removed = await mutation(a, { operation: "remove", publicKey: b.hub.auth.publicKey });
  await device(a.hub, "private_after_removal"); await a.hub.network.tick();
  expect((await view(a)).membership!.manifest.devices.some(value => value.id === "private_after_removal")).toBe(true);
  await b.hub.network.tick();
  const peer = await view(b);
  expect(peer.sync).toBe("removed"); expect(peer.membership).toEqual(removed.membership);
  expect(peer.membership!.manifest.devices.some(value => value.id === "private_after_removal")).toBe(false);
  expect((await http(b.hub, "/api/network", undefined, imported.token)).status).toBe(401);
  expect((await b.hub.store.device(b.owner.id))?.revoked).toBe(0);
  const publicEnrollment = await http(a.hub, "/api/network/enroll", knownBeforeRemoval);
  expect(publicEnrollment.status).toBe(200);
  expect(JSON.stringify(publicEnrollment.body)).not.toContain("private_after_removal");
});

it("an offline coordinator prevents active leave from silently discarding the network", async () => {
  const a = await host("A"), b = await host("B");
  await mutation(a, { operation: "create", name: "Offline leave network" }); await join(a, b);
  const imported = await install(a, b, "a_on_b"), before = await view(b);
  await a.hub.close();
  const response = await mutationResponse(b, { operation: "leave" });
  expect(response.status).toBeGreaterThanOrEqual(500);
  expect((await view(b)).membership).toEqual(before.membership);
  expect((await http(b.hub, "/api/network", undefined, imported.token)).status).toBe(200);
  expect((await b.hub.store.device(b.owner.id))?.revoked).toBe(0);
});

it.each(["A", "C"])("a phone first paired with %s stays with A/B when C leaves, while C requires a new pairing", async first => {
  const a = await host("A"), b = await host("B"), c = await host("C");
  const chats = new Map<Host, string>(); for (const target of [a, b, c]) chats.set(target, await seedChat(target));
  await mutation(a, { operation: "create", name: "Phone remains in the network" }); await join(a, b); await join(a, c); await b.hub.network.tick();
  const source = first === "A" ? a : c, initial = await device(source.hub, `phone_first_${first}`);
  const phone = new Map<Host, Device>([[source, initial]]);
  for (const target of [a, b, c]) if (target !== source) phone.set(target, await install(source, target, `phone_on_${target === a ? "a" : target === b ? "b" : "c"}`, initial));
  const localOnA = await install(c, a, "c_desktop_on_a"), localOnB = await install(c, b, "c_desktop_on_b");
  const phonePeers = new Map<Host, Awaited<ReturnType<typeof socket>>>();
  for (const target of [a, b, c]) phonePeers.set(target, await socket(target.hub, phone.get(target)!));
  const localPeer = await socket(c.hub, c.owner), oldDesktopPeer = await socket(a.hub, localOnA);
  const before = (await view(a)).membership!.manifest;
  const phoneMembers = before.devices.filter(entry => [...phone.values()].some(value => value.id === entry.id && value.publicKey === entry.publicKey));
  expect(phoneMembers).toHaveLength(3); expect(new Set(phoneMembers.map(entry => entry.memberId)).size).toBe(1);
  expect(phoneMembers.every(entry => entry.scope === "network")).toBe(true);
  expect(before.devices.find(entry => entry.id === localOnA.id)?.scope).toBe("host");

  const oldC = phone.get(c)!;
  expect((await http(c.hub, "/api/push", { provider: "fcm", token: "network_retirement_push_" + "x".repeat(40) }, oldC.token, "PUT")).status).toBe(200);
  expect((await http(c.hub, "/api/notifications", { enabled: true }, oldC.token, "PUT")).status).toBe(200);
  await c.hub.store.publishBotMessage("resident_bot", { conversationId: chats.get(c)!, blocks: [{ type: "text", text: "Queued before leaving" }] });
  await c.hub.store.db.run("UPDATE push_outbox SET next_at=? WHERE device_id=? AND status='pending'", [Date.now() + 60_000, oldC.id]);
  expect(await c.hub.store.db.get("SELECT 1 FROM push_outbox WHERE device_id=? AND status='pending'", [oldC.id])).toBeDefined();
  const pendingKeys = generateKeyPairSync("ed25519");
  const pending = await c.hub.auth.pair({ deviceId: "pending_before_leave", name: "Pending phone", platform: "android", publicKey: pendingKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
  const residentBots = await c.hub.store.bots("owner"), residentMessages = (await c.hub.store.snapshot("owner", chats.get(c)!)).messages;

  const left = await mutation(c, { operation: "leave" });
  expect(left.view.sync).toBe("standalone"); expect(left.view.membership).toBeUndefined();
  await b.hub.network.tick();
  expect((await http(c.hub, "/api/network", undefined, oldC.token)).status).toBe(401);
  await vi.waitFor(() => expect(phonePeers.get(c)!.ws.readyState).toBe(WebSocket.CLOSED));
  expect(phonePeers.get(c)!.frames.some(frame => frame.type === "notice" && frame.code === "device_revoked")).toBe(true);
  expect((await c.hub.store.device(oldC.id))?.push_json).toBeNull();
  expect(await c.hub.store.db.get("SELECT 1 FROM push_bindings WHERE device_id=?", [oldC.id])).toBeUndefined();
  expect(await c.hub.store.db.get("SELECT 1 FROM push_outbox WHERE device_id=? AND status='pending'", [oldC.id])).toBeUndefined();
  expect(await c.hub.store.db.get("SELECT 1 FROM push_outbox WHERE device_id=? AND status='cancelled'", [oldC.id])).toBeDefined();
  await expect(c.hub.auth.approve(pending.code, "local-owner")).rejects.toThrow("pairing_expired_or_invalid");

  for (const target of [a, b]) {
    const identity = phone.get(target)!, peer = phonePeers.get(target)!;
    expect((await http(target.hub, "/api/network", undefined, identity.token)).status).toBe(200);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    const clientMsgId = `after_c_left_${target === a ? "a" : "b"}`;
    peer.send({ type: "message.send", conversationId: chats.get(target)!, clientMsgId, text: "Phone remains authorized", attachments: [] });
    expect((await peer.next("message.ack")).clientMsgId).toBe(clientMsgId);
    expect((await target.hub.store.snapshot("owner", chats.get(target)!)).messages.some(message => message.clientMsgId === clientMsgId)).toBe(true);
    const answer = await target.hub.store.publishBotMessage("resident_bot", { conversationId: chats.get(target)!, blocks: [{ type: "text", text: "Still receiving replies" }] });
    await vi.waitFor(() => expect(JSON.stringify(peer.frames)).toContain(answer.id));
    const created = await http<{ id: string }>(target.hub, "/api/bots", { requestId: `create_after_c_${target === a ? "a" : "b"}`, name: "After C leaves", engine: "codex", model: "gpt-6-astra", effort: "high", workspace: "" }, identity.token);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await vi.waitFor(async () => expect((await target.hub.store.bots("owner")).find(bot => bot.id === created.body.id)?.online).toBe(1), { timeout: 8000 });
  }
  expect((await http(a.hub, "/api/network", undefined, localOnA.token)).status).toBe(401);
  expect((await http(b.hub, "/api/network", undefined, localOnB.token)).status).toBe(401);
  await vi.waitFor(() => expect(oldDesktopPeer.ws.readyState).toBe(WebSocket.CLOSED));
  expect((await http(c.hub, "/api/network", undefined, c.owner.token)).status).toBe(200);
  expect(localPeer.ws.readyState).toBe(WebSocket.OPEN);
  expect(await c.hub.store.bots("owner")).toEqual(residentBots);
  expect((await c.hub.store.snapshot("owner", chats.get(c)!)).messages).toEqual(residentMessages);

  const fresh = await device(c.hub, "phone_fresh_c");
  expect((await http(c.hub, "/api/network", undefined, fresh.token)).status).toBe(200);
  const freshPeer = await socket(c.hub, fresh);
  freshPeer.send({ type: "message.send", conversationId: chats.get(c)!, clientMsgId: "fresh_c_message", text: "New pairing restores access", attachments: [] });
  await freshPeer.next("message.ack"); await c.hub.network.tick();
  expect((await view(c)).membership).toBeUndefined();
  expect((await view(a)).membership!.manifest.devices.some(entry => entry.id === fresh.id)).toBe(false);
  expect((await http(c.hub, "/api/network", undefined, oldC.token)).status).toBe(401);
  await expect(login(c.hub, oldC.id, oldC.privateKey)).rejects.toThrow("untrusted_device");
  expect((await http(c.hub, "/api/network", undefined, fresh.token)).status).toBe(200);
}, 60_000);

it("a phone receives a signed departure receipt even when its own C session is revoked by the completed leave", async () => {
  const a = await host("A"), c = await host("C");
  await mutation(a, { operation: "create", name: "Phone initiated departure" }); await join(a, c);
  const phoneC = await device(c.hub, "phone_initiates_leave"), phoneA = await install(c, a, "phone_remains_on_a", phoneC);
  const departed = await mutationResponse(c, { operation: "leave" }, phoneC);
  expect(departed.status, JSON.stringify(departed.body)).toBe(200);
  expect(departed.body.view.sync).toBe("standalone"); expect(departed.body.view.membership).toBeUndefined();
  const receipt = departed.body.membership!;
  expect(receipt).toBeDefined();
  expect(receipt.manifest.authorityKey).toBe(a.hub.auth.publicKey);
  expect(verify(null, Buffer.from(networkManifestProof(receipt.manifest)), createPublicKey({ key: Buffer.from(a.hub.auth.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(receipt.signature, "base64"))).toBe(true);
  expect(receipt.manifest.hosts.find(entry => entry.publicKey === c.hub.auth.publicKey)?.revoked).toBe(true);
  expect(receipt.manifest.devices.find(entry => entry.id === phoneA.id)?.revoked).not.toBe(true);
  expect((await http(c.hub, "/api/network", undefined, phoneC.token)).status).toBe(401);
  expect((await http(a.hub, "/api/network", undefined, phoneA.token)).status).toBe(200);
  expect((await http(c.hub, "/api/network", undefined, c.owner.token)).status).toBe(200);
});
