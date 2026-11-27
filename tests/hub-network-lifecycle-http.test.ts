import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { request } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { deviceActionProofText, deviceActionStatementSchema } from "../src/client-protocol/device-actions.js";
import { PRIVATE_NETWORK_RECOVERY_CAPABILITY, networkCanonical, networkCommandSchema, networkManifestProof, networkPeerProof, type NetworkCommandInput, type NetworkCommandResult, type NetworkPeerRequest, type NetworkView } from "../src/client-protocol/private-network.js";
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
  if (raw.operation === "remove") { const targetKey = raw.publicKey; raw = { expectedState: current.membership!.manifest.hosts.find(value => value.publicKey === targetKey)!.state, ...raw }; }
  const command = networkCommandSchema.parse(["routes", "attest", "reinstate", "remove", "leave"].includes(raw.operation) ? { networkId: current.membership?.manifest.id ?? "", ...raw } : raw);
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
  expect((await c.hub.store.db.get<{ push_json: string | null }>("SELECT push_json FROM devices WHERE id=?", [oldC.id]))?.push_json).toBeNull();
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

it("recovers a departed or removed host over signed TLS while keeping its Bots, conversations and files, and recovers a revoked device via fresh pairing", async () => {
  const a = await host("A"), b = await host("B");
  await mutation(a, { operation: "create", name: "Recovery network" });
  await join(a, b);
  const chatId = await seedChat(b);
  await b.hub.store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('file_keep',?,'owner','abc123',11,'text/plain','notes.txt','file_keep.txt',1,?)", [chatId, Date.now()]);

  // 1. Device revocation on B (while in network) preserves host membership, Bots, chats & files, and recovers via normal fresh pairing.
  const phone1 = await device(b.hub, "phone_revoke_test");
  const revokeChallenge = await http(b.hub, "/api/devices/challenge", { operation: "revoke", target: phone1.id }, b.owner.token);
  expect(revokeChallenge.status).toBe(200);
  const revokeStatement = deviceActionStatementSchema.parse(revokeChallenge.body);
  const revokeProof = { nonce: revokeStatement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(revokeStatement)), b.owner.privateKey).toString("base64") };
  expect((await http(b.hub, "/api/devices/revoke", { deviceId: phone1.id, proof: revokeProof }, b.owner.token)).status).toBe(200);
  expect((await http(b.hub, "/api/network", undefined, phone1.token)).status).toBe(401);
  expect((await view(b)).sync).toBe("current");
  const phone2 = await device(b.hub, "phone_repair_test");
  expect((await http(b.hub, "/api/network", undefined, phone2.token)).status).toBe(200);
  expect((await b.hub.store.bots("owner")).some(bot => bot.id === "resident_bot")).toBe(true);
  expect((await b.hub.store.snapshot("owner", chatId)).messages.length).toBeGreaterThan(0);

  // 2. Host B leaves voluntarily, stale rejoin fails, explicit coordinator recovery restores membership and preserves Bots/conversations/files.
  await b.hub.network.tick();
  const phoneOnA = await install(b, a, "phone2_on_a", phone2);
  await mutation(b, { operation: "leave" });
  expect((await view(b)).sync).toBe("standalone");
  expect((await http(b.hub, "/api/network", undefined, phone2.token)).status).toBe(401);
  expect((await http(a.hub, "/api/network", undefined, phoneOnA.token)).status).toBe(200);

  const afterLeave = (await view(a)).membership!.manifest;
  expect((await mutationResponse(b, { operation: "propose", networkId: afterLeave.id, authorityKey: a.hub.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(afterLeave)) })).status).toBe(403);

  const reinstated = (await mutation(a, { operation: "reinstate", publicKey: b.hub.auth.publicKey })).membership!;
  const { proposal } = await mutation(b, { operation: "propose", networkId: reinstated.manifest.id, authorityKey: a.hub.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(reinstated.manifest)), generation: 2, recover: true });
  const { membership } = await mutation(a, { operation: "admit", proposal: proposal! });
  await mutation(b, { operation: "join", membership: membership!, nonce: proposal!.proposal.nonce });
  expect((await view(b)).host).toMatchObject({ state: "active", revoked: false, generation: 2 });

  // Bots, conversations, files, and local owner on B are unchanged; phone can re-enroll onto B with a fresh key.
  expect((await b.hub.store.bots("owner")).some(bot => bot.id === "resident_bot")).toBe(true);
  expect((await b.hub.store.snapshot("owner", chatId)).messages.some(m => m.blocks.some(block => block.type === "text" && block.text === "History stays on this host"))).toBe(true);
  expect(await b.hub.store.db.get("SELECT id,name FROM attachments WHERE id='file_keep'")).toEqual({ id: "file_keep", name: "notes.txt" });
  const phoneOnB2 = await install(a, b, "phone2_on_b_gen2", phoneOnA);
  expect((await http(b.hub, "/api/network", undefined, phoneOnB2.token)).status).toBe(200);
});

it("negotiates peer recovery capabilities over TLS, refuses reinstate while a 1.6.0 peer is active, and keeps 1.6.0 revocation delivery working", async () => {
  const a = await host("A"), b = await host("B"), c = await host("C");
  await mutation(a, { operation: "create", name: "Mixed TLS network" });
  await join(a, b);
  await join(a, c);
  const phoneA = await device(a.hub, "phone_mixed_a");
  const phoneOnC = await install(a, c, "phone_mixed_c", phoneA);
  expect((await http(c.hub, "/api/network", undefined, phoneOnC.token)).status).toBe(200);

  // 1.6.0 App calls GET /api/network without ?capabilities=1 -> omits hostCapabilities strictly.
  const legacyView = await http<NetworkView>(a.hub, "/api/network", undefined, a.owner.token);
  expect(legacyView.status).toBe(200);
  expect("hostCapabilities" in legacyView.body).toBe(false);

  // Upgraded App calls GET /api/network?capabilities=1 -> sees capability markers for all upgraded peers.
  const capView = await http<NetworkView>(a.hub, "/api/network?capabilities=1", undefined, a.owner.token);
  expect(capView.status).toBe(200);
  expect(capView.body.hostCapabilities?.[a.hub.auth.publicKey]).toEqual([PRIVATE_NETWORK_RECOVERY_CAPABILITY]);
  expect(capView.body.hostCapabilities?.[b.hub.auth.publicKey]).toEqual([PRIVATE_NETWORK_RECOVERY_CAPABILITY]);
  expect(capView.body.hostCapabilities?.[c.hub.auth.publicKey]).toEqual([PRIVATE_NETWORK_RECOVERY_CAPABILITY]);

  // WebSocket ready advertises private-network.recovery.v1 in serverCapabilities.
  const ws = new WebSocket(a.hub.url.replace("https:", "wss:") + "/ws", { ca: tls.cert, rejectUnauthorized: true });
  sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const wsNonce = randomBytes(32).toString("base64url");
  ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: a.owner.id, nonce: wsNonce, protocolVersions: [1], capabilities: ["cards.v1"], cursors: {} }));
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "challenge")).toBe(true), { timeout: 3000 });
  const challenge = frames.find(frame => frame.type === "challenge")!;
  ws.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof(a.owner.id, String(challenge.nonce), wsNonce), a.owner.privateKey).toString("base64") }));
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "ready")).toBe(true), { timeout: 3000 });
  const ready = frames.find(frame => frame.type === "ready") as { serverCapabilities?: string[] };
  expect(ready.serverCapabilities).toContain(PRIVATE_NETWORK_RECOVERY_CAPABILITY);

  // Host B leaves; drain any in-flight tick on C, then pause C's upgraded background sync timer so C behaves strictly as a 1.6.0 Host.
  await mutation(b, { operation: "leave" });
  await c.hub.network.tick();
  const pauseCTick = vi.spyOn(c.hub.network, "tick").mockResolvedValue();
  try {
    const cView = await view(c);
    const legacyPeerBody: NetworkPeerRequest = {
      v: 1, networkId: cView.membership!.manifest.id, publicKey: c.hub.auth.publicKey,
      nonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000,
      host: { publicKey: c.hub.auth.publicKey, name: cView.host.name, routes: cView.host.routes, protocol: 2 },
      devices: [], revoked: [], known: cView.membership!,
    };
    const legacyPeerSync = await http(a.hub, "/api/network/peer", { request: legacyPeerBody, signature: c.hub.auth.signNetworkPeer(legacyPeerBody) });
    expect(legacyPeerSync.status).toBe(200);

    const mixedCapView = await http<NetworkView>(a.hub, "/api/network?capabilities=1", undefined, a.owner.token);
    expect(mixedCapView.body.hostCapabilities?.[c.hub.auth.publicKey]).toBeUndefined();

    // Coordinator MUST refuse reinstate with 409 network_recovery_upgrade_required while C is 1.6.0.
    const refused = await mutationResponse(a, { operation: "reinstate", publicKey: b.hub.auth.publicKey });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "network_recovery_upgrade_required" });
    const untouchedManifest = (await view(a)).membership!.manifest;
    expect(untouchedManifest.hosts.find(item => item.publicKey === b.hub.auth.publicKey)?.reinstated).toBeUndefined();

    // Because reinstate was refused, revoking phoneA STILL produces a 1.6.0-valid manifest and revokes phoneOnC on Peer C!
    await a.hub.auth.revoke(phoneA.id, "local-owner");
    await a.hub.network.tick();
    const revokeSyncBody: NetworkPeerRequest = { ...legacyPeerBody, nonce: randomBytes(32).toString("base64url") };
    const revokeSyncRes = await http<{ manifest: { hosts: Array<Record<string, unknown>> } }>(a.hub, "/api/network/peer", { request: revokeSyncBody, signature: c.hub.auth.signNetworkPeer(revokeSyncBody) });
    expect(revokeSyncRes.status).toBe(200);
    expect(revokeSyncRes.body.manifest.hosts.every(item => item.generation === undefined && item.reinstated === undefined)).toBe(true);
    await c.hub.network.enroll(revokeSyncRes.body);
    expect((await http(c.hub, "/api/network", undefined, phoneOnC.token)).status).toBe(401);
  } finally {
    pauseCTick.mockRestore();
  }

  // Once Peer C upgrades and runs an upgraded tick(), C advertises private-network.recovery.v1 and reinstate succeeds over TLS.
  await c.hub.network.tick();
  const upgradedCapView = await http<NetworkView>(a.hub, "/api/network?capabilities=1", undefined, a.owner.token);
  expect(upgradedCapView.body.hostCapabilities?.[c.hub.auth.publicKey]).toEqual([PRIVATE_NETWORK_RECOVERY_CAPABILITY]);

  const reinstated = await mutation(a, { operation: "reinstate", publicKey: b.hub.auth.publicKey });
  const { proposal } = await mutation(b, { operation: "propose", networkId: reinstated.membership!.manifest.id, authorityKey: a.hub.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(reinstated.membership!.manifest)), generation: 2, recover: true });
  const { membership } = await mutation(a, { operation: "admit", proposal: proposal! });
  await mutation(b, { operation: "join", membership: membership!, nonce: proposal!.proposal.nonce });
  expect((await view(b)).host).toMatchObject({ state: "active", revoked: false, generation: 2 });
}, 30_000);
