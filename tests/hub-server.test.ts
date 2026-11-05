import { EventHistoryRetention } from "../src/hub/event-history.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { avatarDataUrl, avatarFixture } from "./helpers/avatar-fixture.js";
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES, MAX_FRAME_BYTES, type Json } from "../src/client-protocol/index.js";
import { deviceProof, hashSecret, parsePublicKey, serverProof } from "../src/hub/auth.js";
import { assertSafeBind } from "../src/hub/network.js";
import { HubServer } from "../src/hub/server.js";
import { HubError } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
import { backupHubState, restoreHubState } from "../src/hub/state-backup.js";
import { frameParts, nodeFrameReader, writeFrame } from "../src/client-protocol/fragments-node.js";
import { AUTH_STATUS_CAPABILITY, authDeniedProof, authDeniedSchema } from "../src/client-protocol/auth-status.js";
import { CONVERSATION_SYNC_CAPABILITY, SNAPSHOT_DELTA_CAPABILITY, SNAPSHOT_ACTIVITY_CAPABILITY, snapshotFrameSchema } from "../src/client-protocol/snapshot.js";
import { RUN_TAIL_CAPABILITY } from "../src/client-protocol/run.js";
import { PAIRING_INVITES_CAPABILITY, PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH, pairingInviteIssuedSchema, pairingInviteListSchema } from "../src/client-protocol/pairing-invites.js";
import { bootstrapTrusted, deviceFields, pairingRequestId, postPairing, testDevice } from "./helpers/pairing-invite.js";
import { signedDeviceAction } from "./helpers/device-actions.js";

type Frame = Record<string, Json>;
class Peer {
  frames: Frame[] = [];
  physicalBytes: number[] = [];
  private reader = nodeFrameReader();
  ackSnapshots = true;
  constructor(readonly ws: WebSocket) { ws.on("message", (raw) => { this.physicalBytes.push(Buffer.byteLength(raw.toString())); const frame = this.reader.read(raw.toString()) as Frame | undefined; if (!frame) return; this.frames.push(frame); if (this.ackSnapshots && frame.type === "snapshot.message") this.send({ type: "snapshot.ack", id: frame.id, count: Number(frame.index) + 1 }); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((resolve, reject) => { peer.ws.once("open", resolve); peer.ws.once("error", reject); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, predicate: (f: Frame) => boolean = () => true): Promise<Frame> {
    const until = Date.now() + 5_000;
    for (;;) { const index = this.frames.findIndex((f) => f.type === type && predicate(f)); if (index >= 0) return this.frames.splice(index, 1)[0]!; if (Date.now() > until) throw new Error(`Missing ${type}`); await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
}
describe("Hub real transport", () => {
  let directory: string; let hub: HubServer; const sockets: WebSocket[] = [];
  const keypair = generateKeyPairSync("ed25519");
  const publicKey = keypair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "hub-net-")); hub = await HubServer.start({ stateDir: directory }); });
  afterEach(async () => { sockets.splice(0).forEach((s) => s.terminate()); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  /** The first device: no owner exists yet to issue an invite, so it is
   * bootstrapped in-process. The public route must still refuse it. Later
   * devices pair over HTTP with an owner-issued invite (tests below). */
  async function paired() {
    const device = { deviceId: "device", name: "Test browser", platform: "web" as const, publicKey };
    expect(await postPairing(hub.url, device)).toEqual({ status: 403, body: { error: "pairing_invite_required" } });
    await bootstrapTrusted(hub.auth, device);
  }
  async function issueOverHttp(headers: Record<string, string>) {
    const response = await fetch(`${hub.url}${PAIRING_INVITES_PATH}`, { method: "POST", headers, body: JSON.stringify({ requestId: pairingRequestId() }) });
    expect(response.status).toBe(201);
    return pairingInviteIssuedSchema.parse(await response.json());
  }
  async function connect(cursors = {}, capabilities = ["cards.v1"], ackSnapshots = true, waitForSync = true, preferredConversationId?: string, syncLineages?: Record<string, string>) {
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    peer.ackSnapshots = ackSnapshots;
    const clientNonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: "device", nonce: clientNonce, protocolVersions: [1], capabilities, cursors, preferredConversationId, syncLineages });
    const challenge = await peer.next("challenge");
    expect(verify(null, serverProof("device", challenge.nonce as string, clientNonce), parsePublicKey(hub.auth.publicKey), Buffer.from(challenge.signature as string, "base64"))).toBe(true);
    peer.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce as string, clientNonce), keypair.privateKey).toString("base64") });
    const ready = await peer.next("ready"); if (waitForSync) await peer.next("sync.complete");
    return { peer, token: ready.sessionToken as string, uploadLimits: ready.uploadLimits, avatars: ready.avatars, bots: ready.bots, serverCapabilities: ready.serverCapabilities };
  }
  it("prepares later live projections while earlier delivery is held, without reordering revisions", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    await paired(); const { peer } = await connect();
    const project = hub.store.eventProjections.bind(hub.store);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const calls: number[] = [];
    hub.store.eventProjections = async (event, users) => {
      const first = calls.length === 0; calls.push(event.seq);
      const result = await project(event, users);
      if (first) await held;
      return result;
    };
    try {
      let message = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "FIRST" }], status: "streaming" });
      await expect.poll(() => calls.length).toBe(1);
      message = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: message.id, blocks: [{ type: "text", text: "FIRST SECOND" }], status: "streaming" });
      message = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: message.id, blocks: [{ type: "text", text: "FIRST SECOND FINAL" }], status: "complete" });
      // Deterministic scheduling contract: later committed events reserve their
      // DB reads without waiting for an earlier recipient's prepared result.
      expect(calls).toHaveLength(3);
      expect(peer.frames.filter(frame => frame.type === "event")).toHaveLength(0);
      release();
      const events = [await peer.next("event"), await peer.next("event"), await peer.next("event")];
      expect(events.map(event => event.seq)).toEqual(calls);
      expect(events.map(event => (event.payload as any).version)).toEqual([1, 2, 3]);
      expect(events.at(-1)).toMatchObject({ payload: message });
    } finally { release(); }
  });

  it("keeps prepared hidden-message projections private and reconnects from the latest revision", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    await paired(); const { peer } = await connect({}, ["cards.v1", "snapshot.v1", "streaming.v1"]);
    const message = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "PRIVATE_BEFORE_HIDE" }], status: "streaming" });
    await peer.next("event", frame => (frame.payload as any)?.id === message.id);
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [message.id] });
    await peer.next("event", frame => (frame.payload as any)?.status === "deleted");
    const project = hub.store.eventProjections.bind(hub.store);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    hub.store.eventProjections = async (event, users) => { calls++; const result = await project(event, users); await held; return result; };
    try {
      await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: message.id, blocks: [{ type: "text", text: "MUST_STAY_HIDDEN" }], status: "streaming" });
      const visible = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "VISIBLE_LATEST " + "readable ".repeat(100) }], status: "streaming" });
      expect(calls).toBe(2);
      const { peer: late } = await connect({}, ["cards.v1", "snapshot.v1", "streaming.v1"]);
      expect(JSON.stringify(late.frames)).not.toContain("MUST_STAY_HIDDEN");
      expect(JSON.stringify(late.frames)).toContain("VISIBLE_LATEST");
      release();
      const seen = await peer.next("event", frame => (frame.payload as any)?.id === visible.id);
      expect(seen).toMatchObject({ payload: visible });
      expect(JSON.stringify(peer.frames)).not.toContain("MUST_STAY_HIDDEN");
      const final = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: visible.id, blocks: [{ type: "text", text: "VISIBLE_LATEST " + "readable ".repeat(100) + " FINAL" }], status: "streaming" });
      expect(await late.next("event", frame => frame.seq === (seen.seq as number) + 1)).toMatchObject({ kind: "message.stream", payload: { messageId: visible.id, baseVersion: visible.version, version: final.version } });
    } finally { release(); }
  });

  it.each(["local", "external"] as const)("rechecks %s revocation after a live projection was prepared", async mode => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    await paired(); const { peer } = await connect();
    const project = hub.store.eventProjections.bind(hub.store);
    let release!: () => void, prepared!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { prepared = resolve; });
    hub.store.eventProjections = async (event, users) => { const result = await project(event, users); prepared(); await held; return result; };
    try {
      await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "PRIVATE_PREPARED_EVENT" }] });
      await ready;
      if (mode === "local") await hub.auth.revoke("device", "local-owner");
      else await hub.store.db.serial(() => hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='device'"));
      release();
      expect(await peer.next("notice")).toMatchObject({ code: "device_revoked" });
      await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED);
      expect(JSON.stringify(peer.frames)).not.toContain("PRIVATE_PREPARED_EVENT");
    } finally { release(); }
  });

  it("reconnects affected clients after an early projection rejection without poisoning later publications", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    await paired(); const { peer } = await connect();
    const project = hub.store.eventProjections.bind(hub.store);
    let release!: () => void, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    hub.store.eventProjections = async (event, users) => {
      const call = ++calls;
      if (call === 2) throw new Error("isolated projection fixture failure");
      const result = await project(event, users); if (call === 1) await held; return result;
    };
    try {
      const messages = [];
      for (const text of ["FIRST", "RECOVER_ON_RECONNECT", "LAST"]) messages.push(await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text }] }));
      expect(calls).toBe(3);
      // Let the second preparation reject before the first publication resumes.
      await new Promise<void>(resolve => setImmediate(resolve));
      const { peer: recovered } = await connect({}, ["cards.v1", "snapshot.v1"]);
      release();
      await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED);
      // The later connection recovered committed history independently and
      // must not be retired with the original failed broadcast recipients.
      expect(JSON.stringify(recovered.frames)).toContain("RECOVER_ON_RECONNECT");
      expect(JSON.stringify(recovered.frames)).toContain("LAST");
      recovered.send({ type: "ping" }); await recovered.next("pong");
      const next = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "NEXT" }] });
      expect(await recovered.next("event", frame => (frame.payload as any)?.id === next.id)).toMatchObject({ payload: next });
    } finally { release(); }
  });

  it.each([false, true])("recovers a failed final projection without needing another event (snapshot=%s)", async snapshot => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    await paired();
    const capabilities = ["cards.v1", ...(snapshot ? ["snapshot.v1", "streaming.v1"] : [])];
    const { peer } = await connect({}, capabilities);
    const initial = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "PARTIAL" }], status: "streaming" });
    const first = await peer.next("event", frame => (frame.payload as any)?.id === initial.id);
    const project = hub.store.eventProjections.bind(hub.store);
    let fail = true;
    hub.store.eventProjections = async (event, users) => {
      if (fail) { fail = false; throw new Error("one-shot final projection failure"); }
      return project(event, users);
    };
    const final = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: initial.id, blocks: [{ type: "text", text: "COMPLETE" }], status: "complete" });
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED);
    const { peer: recovered } = await connect({ [chat.id]: first.seq }, capabilities);
    expect(await recovered.next("event", frame => (frame.payload as any)?.id === final.id)).toMatchObject({ payload: final });
    expect((await hub.store.listMessages("owner", chat.id)).messages).toEqual([final]);
  });

  it.each(["held", "rejected"])("dispatches committed input exactly once while its App projection is %s", async mode => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream',?)", [hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "stream", secret, engine: "fake", model: "", effort: "" });
    await bot.next("instance.ready");
    await paired(); const { peer } = await connect();
    const project = hub.store.eventProjections.bind(hub.store);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    hub.store.eventProjections = async (event, users) => {
      if (event.kind === "message.created" && (event.payload as any)?.authorType === "user") {
        await held;
        if (mode === "rejected") throw new Error("one-shot input projection failure");
      }
      return project(event, users);
    };
    try {
      const input = { type: "message.send", conversationId: chat.id, clientMsgId: "same-input", text: "DELIVER_ONCE", attachments: [] };
      peer.send(input);
      const ack = await peer.next("message.ack");
      if (mode === "rejected") release();
      expect(await bot.next("instance.message")).toMatchObject({ message: { id: ack.messageId, blocks: [{ type: "text", text: "DELIVER_ONCE" }] } });
      release();
      if (mode === "rejected") await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED);
      const { peer: recovered } = await connect();
      recovered.send(input);
      expect(await recovered.next("message.ack")).toMatchObject({ messageId: ack.messageId });
      expect(bot.frames.filter(frame => frame.type === "instance.message")).toEqual([]);
      expect(bot.ws.readyState).toBe(WebSocket.OPEN);
      expect((await hub.store.listMessages("owner", chat.id)).messages).toHaveLength(1);
    } finally { release(); }
  });

  it.each([false, true])("recovers a failed projection during an ahead-cursor replacement snapshot (independent=%s)", async independent => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    const initial = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "OLD" }], status: "streaming" });
    await paired();
    const capabilities = ["cards.v1", "snapshot.v1", ...(independent ? [CONVERSATION_SYNC_CAPABILITY] : [])];
    const { peer } = await connect({ [chat.id]: 100 }, capabilities, false, false);
    expect(await peer.next("snapshot.begin")).toMatchObject({ seq: 1 });
    expect(await peer.next("snapshot.message")).toMatchObject({ message: initial });
    const project = hub.store.eventProjections.bind(hub.store);
    let fail = true;
    hub.store.eventProjections = async (event, users) => {
      if (fail) { fail = false; throw new Error("projection failed before snapshot ACK"); }
      return project(event, users);
    };
    const final = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: initial.id, blocks: [{ type: "text", text: "FINAL" }], status: "complete" });
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED);
    const { peer: recovered } = await connect({ [chat.id]: 100 }, capabilities);
    expect(await recovered.next("snapshot.message")).toMatchObject({ message: final });
  });

  it.each([false, true])("keeps a recipient connected when its completed snapshot covers a failed projection (independent=%s)", async independent => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('stream','Stream','fixture')");
    const chat = await hub.store.createConversation("owner", ["stream"], "Stream", "stream");
    const initial = await hub.store.publishBotMessage("stream", { conversationId: chat.id, blocks: [{ type: "text", text: "OLD" }], status: "streaming" });
    await paired();
    let releaseHead!: () => void, releaseProjection!: () => void;
    const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
    const projectionGate = new Promise<void>(resolve => { releaseProjection = resolve; });
    const head = hub.store.syncHead.bind(hub.store), project = hub.store.eventProjections.bind(hub.store);
    hub.store.syncHead = async (...args) => { await headGate; return head(...args); };
    try {
      const capabilities = ["cards.v1", "snapshot.v1", ...(independent ? [CONVERSATION_SYNC_CAPABILITY] : [])];
      const { peer } = await connect({ [chat.id]: 100 }, capabilities, true, false);
      hub.store.eventProjections = async (event, users) => {
        if (event.kind === "message.updated") { await projectionGate; throw new Error("failed after covering snapshot"); }
        return project(event, users);
      };
      const final = await hub.store.publishBotMessage("stream", { conversationId: chat.id, id: initial.id, blocks: [{ type: "text", text: "FINAL" }], status: "complete" });
      releaseHead(); await peer.next("sync.complete");
      expect(await peer.next("snapshot.message")).toMatchObject({ message: final });
      releaseProjection();
      await (hub as unknown as { broadcastTail: Promise<void> }).broadcastTail;
      peer.send({ type: "ping" }); await peer.next("pong");
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    } finally { releaseHead(); releaseProjection(); }
  });

  it("replaces expired cursors for new and offline clients and rechecks pruning between replay pages", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history','History','fixture')");
    const chat = await hub.store.createConversation("owner", ["history"], "History", "history");
    let message = await hub.store.publishBotMessage("history", { conversationId: chat.id, blocks: [{ type: "text", text: "start" }], status: "streaming" });
    for (let n=0;n<30;n++) message = await hub.store.publishBotMessage("history", { conversationId: chat.id, id: message.id, blocks: [{ type:"text", text:`version ${n}` }], status: "complete" });
    await paired();
    const replay = hub.store.sync.bind(hub.store); let reclaimed = false;
    hub.store.sync = async (...args) => {
      if (!reclaimed) { reclaimed = true; await new EventHistoryRetention(hub.store, { retentionDays:7,maxBytes:1,maxRows:1 }).run(Date.now(),10_000); }
      return replay(...args);
    };
    const {peer: racing} = await connect({[chat.id]:1}, ["cards.v1","snapshot.v1"]);
    expect(reclaimed).toBe(true); expect(await racing.next("snapshot.begin")).not.toHaveProperty("mode");
    expect(await racing.next("snapshot.message")).toMatchObject({message});
    for(const cursor of [0,2]) {
      const {peer} = await connect({[chat.id]:cursor}, ["cards.v1","snapshot.v1",SNAPSHOT_DELTA_CAPABILITY]);
      const begin=await peer.next("snapshot.begin");
      if(cursor===0)expect(begin).not.toHaveProperty("mode");else expect(begin.mode).toBe("merge");
      expect(await peer.next("snapshot.message")).toMatchObject({message});
    }
    const {peer: unsupported} = await connect({[chat.id]:1}, ["cards.v1"], true, false);
    expect(await unsupported.next("error")).toMatchObject({code:"client_update_required"});
  });
  it("finishes a frozen snapshot and catches concurrent updates after reclamation without losing the final version", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history','History','fixture')");
    const chat = await hub.store.createConversation("owner", ["history"], "History", "history");
    let message = await hub.store.publishBotMessage("history", {conversationId:chat.id,blocks:[{type:"text",text:"old"}],status:"streaming"});
    for(let n=0;n<20;n++)message=await hub.store.publishBotMessage("history",{conversationId:chat.id,id:message.id,blocks:[{type:"text",text:`old ${n}`}],status:"streaming"});
    await new EventHistoryRetention(hub.store,{retentionDays:7,maxBytes:1,maxRows:1}).run(Date.now(),10_000);
    await paired(); const {peer} = await connect({},["cards.v1","snapshot.v1","streaming.v1"],false,false);
    const begin=await peer.next("snapshot.begin");expect(await peer.next("snapshot.message")).toMatchObject({message});
    for(let n=0;n<20;n++)message=await hub.store.publishBotMessage("history",{conversationId:chat.id,id:message.id,blocks:[{type:"text",text:`new ${n}`}],status:n===19?"complete":"streaming"});
    await new EventHistoryRetention(hub.store,{retentionDays:7,maxBytes:1,maxRows:1}).run(Date.now(),10_000);
    peer.ackSnapshots=true;peer.send({type:"snapshot.ack",id:begin.id,count:1});
    await peer.next("sync.complete");
    const latest=peer.frames.filter(f=>f.type==="snapshot.message").map(f=>f.message);
    expect(latest).toContainEqual(message);
    const restarted=await hub.store.publishBotMessage("history",{conversationId:chat.id,id:message.id,blocks:[{type:"text",text:"after snapshot"}],status:"streaming"});
    expect(await peer.next("event",f=>Number(f.seq)>(begin.seq as number))).toMatchObject({kind:"message.updated",payload:restarted});
    message=restarted;
    expect((await hub.store.listMessages("owner",chat.id)).messages).toEqual([message]);
  });
  it("switches from replayed pages to a snapshot when retention races the next page and resets streaming bases", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history','History','fixture')");
    const chat=await hub.store.createConversation("owner",["history"],"Pages","pages");
    let text="prefix ".repeat(100);
    let message=await hub.store.publishBotMessage("history",{conversationId:chat.id,blocks:[{type:"text",text}],status:"streaming"});
    for(let n=0;n<30;n++){text+=` ${n}`;message=await hub.store.publishBotMessage("history",{conversationId:chat.id,id:message.id,blocks:[{type:"text",text}],status:"streaming"});}
    const replay=hub.store.sync.bind(hub.store);let pages=0;
    hub.store.sync=async (user,conversation,after)=>{
      if(++pages===2)await new EventHistoryRetention(hub.store,{retentionDays:7,maxBytes:1,maxRows:1}).run(Date.now(),10_000);
      return replay(user,conversation,after,8);
    };
    await paired();const {peer}=await connect({[chat.id]:1},["cards.v1","snapshot.v1","streaming.v1"]);
    expect(pages).toBe(2);
    const begin=await peer.next("snapshot.begin");
    const replayed=peer.frames.filter(f=>f.type==="event");
    expect(replayed).toHaveLength(8);expect(begin.after).toBe(replayed.at(-1)!.seq);
    expect(await peer.next("snapshot.message")).toMatchObject({message});
    const next=await hub.store.publishBotMessage("history",{conversationId:chat.id,id:message.id,blocks:[{type:"text",text:text+" continued"}],status:"streaming"});
    expect(await peer.next("event",f=>Number(f.seq)>Number(begin.seq))).toMatchObject({kind:"message.stream",payload:{messageId:message.id,baseVersion:message.version,version:next.version}});
  });
  it("isolates damaged retained-history metadata without lying about synchronization or rejecting authentication", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('history','History','fixture')");
    const damaged = await hub.store.createConversation("owner", ["history"], "Damaged", "damaged");
    const healthy = await hub.store.createConversation("owner", ["history"], "Healthy", "healthy");
    let message = await hub.store.publishBotMessage("history", {conversationId:damaged.id,blocks:[{type:"text",text:"original"}]});
    for(let n=0;n<10;n++) message=await hub.store.publishBotMessage("history",{conversationId:damaged.id,id:message.id,blocks:[{type:"text",text:`version ${n}`}]});
    await new EventHistoryRetention(hub.store,{retentionDays:7,maxBytes:1,maxRows:1}).run(Date.now(),10_000);
    const floor=(await hub.store.db.get<{seq:number}>("SELECT seq FROM event_history_floor WHERE conversation_id=?",[damaged.id]))!.seq;
    await hub.store.db.run("UPDATE conversation_activity SET through_seq=? WHERE conversation_id=?",[floor-1,damaged.id]);
    const good=await hub.store.publishBotMessage("history",{conversationId:healthy.id,blocks:[{type:"text",text:"healthy history"}]});
    await paired();
    for(const independent of [true,false]) {
      const {peer}=await connect({},["cards.v1","snapshot.v1",...(independent?[CONVERSATION_SYNC_CAPABILITY]:[])],true,false,damaged.id);
      expect(await peer.next("error")).toMatchObject({code:"history_metadata_unavailable",retryable:false,conversationId:damaged.id,message:expect.stringContaining("对话「Damaged」")});
      if(independent) await peer.next("sync.conversation",f=>f.conversationId===healthy.id);
      else await peer.next("event",f=>(f.payload as Record<string,Json>)?.id===good.id);
      peer.send({type:"ping"});await peer.next("pong");
      expect(peer.ws.readyState).toBe(WebSocket.OPEN);
      expect(peer.frames.some(f=>f.type==="sync.complete"||f.type==="sync.conversation"&&f.conversationId===damaged.id||f.type==="snapshot.begin")).toBe(false);
      peer.send({type:"message.send",conversationId:damaged.id,clientMsgId:`bad-${independent}`,text:"must not send",attachments:[]});
      expect(await peer.next("error")).toMatchObject({requestId:`bad-${independent}`,code:"history_metadata_unavailable",retryable:false});
      if(independent) {
        const reads=await hub.store.db.all("SELECT * FROM reads WHERE conversation_id=?",[damaged.id]);
        message=await hub.store.publishBotMessage("history",{conversationId:damaged.id,id:message.id,blocks:[{type:"text",text:"still durably stored"}]});
        peer.send({type:"read.mark",conversationId:damaged.id,seq:(await hub.store.syncHead("owner",damaged.id)).seq});
        expect(await peer.next("error")).toMatchObject({code:"history_metadata_unavailable",retryable:false});
        expect(await hub.store.db.all("SELECT * FROM reads WHERE conversation_id=?",[damaged.id])).toEqual(reads);
        peer.send({type:"message.send",conversationId:healthy.id,clientMsgId:"good-send",text:"normal sending",attachments:[]});
        const ack=await peer.next("message.ack");
        expect(await peer.next("event",f=>(f.payload as Record<string,Json>)?.id===ack.messageId)).toMatchObject({conversationId:healthy.id});
        expect(peer.frames.some(f=>f.type==="event"&&f.conversationId===damaged.id)).toBe(false);
      }
    }
    await hub.store.flushAudit();
    expect(await hub.store.db.all("SELECT detail_json FROM audit_log WHERE kind='sync.history_metadata_unavailable'")).toEqual([
      {detail_json:JSON.stringify({conversationId:damaged.id})},{detail_json:JSON.stringify({conversationId:damaged.id})},
    ]);
    expect((await hub.store.listMessages("owner",damaged.id)).messages).toEqual([message]);
  });
  it("gates parallel broadcasts on authenticated client capabilities while retaining explicit addressing", async () => {
    for (const id of ["alpha", "beta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, "fixture"]);
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "Parallel", "parallel");
    const settings = await hub.store.groupSettings("owner", group.id);
    await hub.store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: group.botIds, expectedBotIds: group.botIds,
      policy: { ...settings.policy, mode: "parallel" }, expectedRevision: settings.revision });
    await paired(); const legacy = await connect();
    // An untrusted payload field cannot substitute for negotiated capability.
    legacy.peer.send({ type: "message.send", conversationId: group.id, clientMsgId: "legacy-broadcast", text: "all", attachments: [], parallelCapable: true });
    expect(await legacy.peer.next("error")).toMatchObject({ code: "group_parallel_client_update_required", requestId: "legacy-broadcast", retryable: false });
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM messages WHERE client_msg_id='legacy-broadcast'")).toEqual({ n: 0 });
    legacy.peer.send({ type: "message.send", conversationId: group.id, clientMsgId: "legacy-named", text: "alpha", attachments: [], mentions: ["alpha"] });
    await legacy.peer.next("message.ack");
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(1); expect(await hub.store.pendingForBot("beta")).toHaveLength(0);
    const modern = await connect({}, ["cards.v1", "groups.parallel.v1"]);
    modern.peer.send({ type: "message.send", conversationId: group.id, clientMsgId: "modern-broadcast", text: "everyone", attachments: [] });
    const ack = await modern.peer.next("message.ack");
    for (const bot of ["alpha", "beta"]) expect(await hub.store.pendingForBot(bot)).toEqual(expect.arrayContaining([expect.objectContaining({ id: ack.messageId, mentions: ["alpha", "beta"] })]));
  });
  it("deletes managed Bots through owner HTTP, publishes retirement and rejects the old worker credential", async () => {
    await hub.close();
    hub = await HubServer.start({ stateDir: directory, managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } } });
    await paired(); const { peer, token } = await connect({}, ["cards.v1", "bots.delete.v1"]);
    const legacy = await connect();
    const legacyClosed = new Promise<number>(resolve => legacy.peer.ws.once("close", code => resolve(code)));
    const headers = { Authorization: `Bearer ${token}` };
    const created = await fetch(`${hub.url}/api/bots`, { method: "POST", headers, body: JSON.stringify({ requestId: "delete_api", name: "API Bot", engine: "codex", model: "", effort: "", workspace: "" }) });
    expect(created.status).toBe(201); const bot = await created.json() as { id: string; name: string };
    const url = `${hub.url}/api/bots/${bot.id}`, body = JSON.stringify({ expectedName: bot.name, confirm: true });
    expect((await fetch(url, { method: "DELETE", body })).status).toBe(401);
    expect((await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ expectedName: bot.name }) })).status).toBe(400);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await fetch(url, { method: "DELETE", headers, body })).status).toBe(403);
    await hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'");
    expect((await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ expectedName: "stale", confirm: true }) })).status).toBe(409);
    const chat = await hub.store.createConversation("owner", [bot.id], "API history", "delete_chat");
    const secret = (await readFile(path.join(directory, "bots", bot.id, "gateway.key"), "utf8")).trim();
    const removed = await fetch(url, { method: "DELETE", headers, body });
    expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ bot: { id: bot.id, deletedAt: expect.any(Number) }, conversations: [{ id: chat.id, archived: true }] });
    expect(await peer.next("bot.status", frame => !!(frame.bot as Record<string, Json>).deletedAt)).toMatchObject({ bot: { id: bot.id, online: 0 } });
    expect((await fetch(url, { method: "DELETE", headers, body })).status).toBe(200);
    expect((await fetch(`${hub.instanceUrl}/api/instance/uploads`, { method: "POST", headers: { Authorization: `Instance ${bot.id}:${secret}` }, body: JSON.stringify({ conversationId: chat.id }) })).status).toBe(401);
    expect(await hub.store.bots("owner")).toEqual([]);
    expect(await legacyClosed).toBe(1000);
    expect(legacy.peer.frames.filter(frame => frame.type === "bot.status").every(frame => !(frame.bot as Record<string, Json>).deletedAt)).toBe(true);
    expect((await connect()).bots).toEqual([]);
    expect((await connect({}, ["management.v1"])).bots).toEqual([]);
    expect((await connect({}, ["management.v1", "bots.delete.v1"])).bots).toEqual([expect.objectContaining({ id: bot.id, deletedAt: expect.any(Number) })]);
  }, 20000);
  it.each(["", "?tail=1", "?before=2"])("protects process details from unauthenticated reads and mid-read revocation (%s)", async query => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "Private process", "run");
    const run = createRunRecord(); recordRunEvent(run, { type: "tool_use", toolName: "Read", toolInput: { path: "/private" } });
    await new RunJournal(hub.store).write("alpha", { conversationId: chat.id, messageId: "run_msg", runId: run.id, entries: run.entries });
    await hub.store.publishBotMessage("alpha", { id: "run_msg", conversationId: chat.id, blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(run, "running"))) } }] });
    const url = `${hub.url}/api/messages/run_msg/run${query}`;
    expect((await fetch(url)).status).toBe(401);
    await paired(); const { token } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    expect((await fetch(url, { headers })).status).toBe(200);
    expect((await fetch(`${url}${query ? "&" : "?"}after=-1`, { headers })).status).toBe(400);
    let release!: () => void, read!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { read = resolve; });
    const original = RunJournal.prototype.read;
    const spy = vi.spyOn(RunJournal.prototype, "read").mockImplementationOnce(async function (...args) { const result = await original.apply(this, args); read(); await held; return result; });
    const pending = fetch(url, { headers });
    try { await ready; await hub.auth.revoke("device", "local-owner"); } finally { release(); spy.mockRestore(); }
    expect((await pending).status).toBe(401);
  });
  it("advertises latest process pages and validates reverse pagination parameters over HTTP", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "Process", "run_tail");
    const run = createRunRecord();
    for (let seq = 1; seq <= 45; seq++) recordRunEvent(run, { type: "tool_use", toolName: "Read", toolUseId: String(seq), toolInput: { path: `/file${seq}` } });
    const journal = new RunJournal(hub.store);
    for (let offset = 0; offset < run.entries.length; offset += 4) await journal.write("alpha", { conversationId: chat.id, messageId: "tail_msg", runId: run.id, entries: run.entries.slice(offset, offset + 4) });
    await hub.store.publishBotMessage("alpha", { id: "tail_msg", conversationId: chat.id, blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(run, "running"))) } }] });
    await paired(); const { token, serverCapabilities } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    expect(serverCapabilities).toContain(RUN_TAIL_CAPABILITY);
    const url = `${hub.url}/api/messages/tail_msg/run`;
    const latest = await (await fetch(`${url}?tail=1&after=0&scopes=1`, { headers })).json();
    expect(latest).toMatchObject({ previous: 6, next: null });
    expect(latest.entries.map((entry: { seq: number }) => entry.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 6));
    expect(await (await fetch(`${url}?before=6`, { headers })).json()).toMatchObject({ previous: null, next: 5, entries: Array.from({ length: 5 }, (_, index) => expect.objectContaining({ seq: index + 1 })) });
    for (const query of ["tail=0", "tail=true", "before=0", "before=2002", "before=no", "before=1.5", "tail=1&before=6", "tail=1&after=1", "before=6&after=1"]) expect((await fetch(`${url}?${query}`, { headers })).status, query).toBe(400);
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='owner'", [chat.id]);
    expect((await fetch(`${url}?tail=1`, { headers })).status).toBe(403);
    expect((await fetch(`${url}?before=6`, { headers })).status).toBe(403);
  });
  it("renames Bots over authenticated HTTP and publishes the canonical name without requiring the Bot online", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    await paired(); const { peer, token } = await connect();
    const headers = { Authorization: `Bearer ${token}` };
    const request = (body: object, id = "alpha") => fetch(`${hub.url}/api/bots/${id}/name`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect((await fetch(`${hub.url}/api/bots/alpha/name`)).status).toBe(401);
    const saved = await request({ name: "研究助手", expectedName: "Alpha" });
    expect(saved.status).toBe(200); expect(await saved.json()).toEqual({ name: "研究助手" });
    expect(await peer.next("bot.status")).toMatchObject({ bot: { id: "alpha", name: "研究助手", online: 0 } });
    expect(await (await fetch(`${hub.url}/api/bots/alpha/name`, { headers })).json()).toEqual({ name: "研究助手" });
    expect((await request({ name: "Stale", expectedName: "Alpha" })).status).toBe(409);
    expect((await request({ name: " ", expectedName: "研究助手" })).status).toBe(400);
    expect((await request({ name: "Other", expectedName: "Alpha" }, "missing")).status).toBe(404);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await request({ name: "Forbidden", expectedName: "研究助手" })).status).toBe(403);
    expect((await fetch(`${hub.url}/api/bots/alpha/name`, { headers })).status).toBe(403);
    expect(await hub.store.db.get("SELECT name FROM bots WHERE id='alpha'")).toEqual({ name: "研究助手" });
  });
  it("flushes bounded HTTP rejection counts on shutdown and never trusts a forwarded audit source", async () => {
    for (let i = 0; i < 30; i++) {
      const response = await fetch(`${hub.url}/api/devices`, { headers: { Authorization: `Bearer private-probe-${i}`, "X-Forwarded-For": "untrusted-forwarded-source" } });
      expect(response.status).toBe(401); await response.arrayBuffer();
    }
    await hub.close();
    const snapshot = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try {
      const rows = await snapshot.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log ORDER BY id");
      expect(rows).toHaveLength(11);
      expect(JSON.parse(rows[0]!.detail_json).source).toBe("127.0.0.1");
      expect(JSON.parse(rows[10]!.detail_json)).toMatchObject({ kind: "http.rejected", count: 20 });
      expect(JSON.stringify(rows)).not.toMatch(/private-probe|untrusted-forwarded-source/);
    } finally { await snapshot.close(); }
  });
  it.each(["before-hello", "after-challenge"])("returns a signed denial for revocation %s without granting a session", async (phase) => {
    await paired(); const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    const nonce = randomBytes(32).toString("base64url");
    if (phase === "before-hello") await hub.auth.revoke("device", "local-owner");
    peer.send({ type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [AUTH_STATUS_CAPABILITY], cursors: {} });
    if (phase === "after-challenge") {
      const challenge = await peer.next("challenge"); await hub.auth.revoke("device", "local-owner");
      peer.send({ type: "auth", signature: sign(null, deviceProof("device", String(challenge.nonce), nonce), keypair.privateKey).toString("base64") });
    }
    const denied = authDeniedSchema.parse(await peer.next("auth.denied"));
    expect(verify(null, Buffer.from(authDeniedProof("device", nonce)), parsePublicKey(hub.auth.publicKey), Buffer.from(denied.signature, "base64"))).toBe(true);
    await vi.waitFor(() => expect(peer.ws.readyState).toBe(WebSocket.CLOSED));
    expect(peer.frames.some((frame) => ["ready", "event", "snapshot.begin", "sync.complete"].includes(String(frame.type)))).toBe(false);
    expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='auth.accepted'")).toBeUndefined();
  });
  it("does not sign ordinary untrusted-device, rate-limit or legacy-client errors", async () => {
    await paired(); await hub.auth.revoke("device", "local-owner");
    for (const [deviceId, capabilities, limited] of [["missing", [AUTH_STATUS_CAPABILITY], false], ["device", [], false], ["device", [AUTH_STATUS_CAPABILITY], true]] as const) {
      const spy = limited ? vi.spyOn(hub.auth, "challenge").mockRejectedValueOnce(new HubError("rate_limited", 429)) : undefined;
      const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
      peer.send({ type: "hello", deviceId, nonce: randomBytes(32).toString("base64url"), protocolVersions: [1], capabilities, cursors: {} });
      expect(await peer.next("error")).toMatchObject({ code: limited ? "rate_limited" : "untrusted_device" });
      expect(peer.frames.some((frame) => frame.type === "auth.denied")).toBe(false); spy?.mockRestore();
    }
  });
  it("still closes the unauthenticated socket if the signed recovery receipt fails", async () => {
    await paired(); await hub.auth.revoke("device", "local-owner");
    const spy = vi.spyOn(hub.auth, "revocationDenial").mockRejectedValueOnce(new Error("receipt_failed"));
    try {
      const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
      peer.send({ type: "hello", deviceId: "device", nonce: randomBytes(32).toString("base64url"), protocolVersions: [1], capabilities: [AUTH_STATUS_CAPABILITY], cursors: {} });
      expect(await peer.next("error")).toMatchObject({ code: "untrusted_device" });
      await vi.waitFor(() => expect(peer.ws.readyState).toBe(WebSocket.CLOSED));
      expect(peer.frames.some((frame) => ["auth.denied", "ready", "event", "sync.complete"].includes(String(frame.type)))).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it("does not process pipelined auth frames after a rate-limited hello", async () => {
    await paired(); await hub.auth.revoke("device", "local-owner");
    const challenge = vi.spyOn(hub.auth, "challenge").mockRejectedValueOnce(new HubError("rate_limited", 429));
    const authenticate = vi.spyOn(hub.auth, "authenticate"), denial = vi.spyOn(hub.auth, "revocationDenial");
    try {
      const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
      peer.send({ type: "hello", deviceId: "device", nonce: randomBytes(32).toString("base64url"), protocolVersions: [1], capabilities: [AUTH_STATUS_CAPABILITY], cursors: {} });
      peer.send({ type: "auth", signature: "invalid" });
      expect(await peer.next("error")).toMatchObject({ code: "rate_limited" });
      await vi.waitFor(() => expect(peer.ws.readyState).toBe(WebSocket.CLOSED));
      expect(authenticate).not.toHaveBeenCalled(); expect(denial).not.toHaveBeenCalled();
    } finally { challenge.mockRestore(); authenticate.mockRestore(); denial.mockRestore(); }
  });
  it("authenticates avatar images, broadcasts revisions and returns fresh metadata on reconnect", async () => {
    await paired(); const first = await connect(), second = await connect();
    const route = `${hub.url}/api/avatars/user/owner`, headers = { Authorization: `Bearer ${first.token}` };
    expect((await fetch(route + "/1")).status).toBe(401);
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, dataUrl: avatarDataUrl() }) })).status).toBe(200);
    for (const peer of [first.peer, second.peer]) expect(await peer.next("avatar.updated")).toMatchObject({ avatar: { kind: "user", id: "owner", revision: 1, hasImage: true } });
    const image = await fetch(route + "/1", { headers }); expect(image.headers.get("Content-Type")).toBe("image/png"); expect(image.headers.get("Cache-Control")).toContain("no-store"); expect(Buffer.from(await image.arrayBuffer())).toEqual(avatarFixture());
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 0, dataUrl: null }) })).status).toBe(409);
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ expectedRevision: 1, dataUrl: null }) })).status).toBe(200);
    expect(await (await fetch(hub.url + "/api/avatars", { headers })).json()).toEqual([{ kind: "user", id: "owner", revision: 2, hasImage: false }]);
    expect((await fetch(route + "/1", { headers })).status).toBe(404);
    const third = await connect(); expect(third.avatars).toEqual([{ kind: "user", id: "owner", revision: 2, hasImage: false }]);
  });
  it("clears a selection while its Bot is offline, broadcasts it and rejects stale or unauthorized clearing", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const c = await hub.store.createConversation("owner", ["alpha"], "Recovery", "recover");
    const first = await hub.store.updateConversation("owner", c.id, { sessionId: "native_one" });
    await paired(); const { peer } = await connect(), { peer: phone } = await connect();
    const current = await hub.store.updateConversation("owner", c.id, { sessionId: "native_two" });
    peer.send({ type: "conversation.bind", conversationId: c.id, sessionId: null, expectedBindingId: first.bindingId });
    expect(await peer.next("error")).toMatchObject({ code: "binding_conflict", retryable: false });
    expect((await hub.store.conversations("owner"))[0]!.sessionId).toBe("native_two");
    peer.send({ type: "conversation.bind", conversationId: c.id, sessionId: null });
    expect(await peer.next("error")).toMatchObject({ code: "binding_revision_required" });
    peer.send({ type: "conversation.bind", conversationId: c.id, sessionId: null, expectedBindingId: current.bindingId });
    for (const client of [peer, phone]) {
      const result = await client.next("conversation.updated"); expect(result.conversation).not.toHaveProperty("sessionId"); expect(result.conversation).not.toHaveProperty("bindingId");
    }
    expect(JSON.stringify(await hub.store.db.all("SELECT * FROM audit_log"))).toContain("conversation.binding_cleared");
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [c.id]);
    await expect(hub.store.updateConversation("member", c.id, { sessionId: null, expectedBindingId: null })).rejects.toMatchObject({ status: 403 });
    await hub.store.db.run("INSERT INTO bot_grants VALUES('member','alpha')");
    const own = await hub.store.createConversation("member", ["alpha"], "Member-owned", "member_chat");
    await expect(hub.store.updateConversation("member", own.id, { sessionId: null, expectedBindingId: null })).rejects.toMatchObject({ code: "owner_required" });
  });
  it.each(["/api/search", "/api/search/page"])("validates literal search input and denies a device revoked during a queued search on %s", async (route) => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Private history", "search");
    const message = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "含有 abc%def 的历史" }] });
    await paired(); const { token } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    for (const query of ["q=" + "x".repeat(257), "from=2&to=1", "from=Infinity", "q=%00", "hasFile=yes", "botId=../bot", "conversationId=../chat"]) {
      expect((await fetch(`${hub.url}${route}?${query}`, { headers })).status).toBe(400);
    }
    const response = await fetch(`${hub.url}${route}?q=abc%25def`, { headers }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(route.endsWith("/page") ? { items: [{ id: message.id }], nextCursor: null } : [{ id: message.id }]);
    const other = await hub.store.createConversation("owner", ["alpha"], "Same Bot, another conversation", "other_search");
    await hub.store.publishBotMessage("alpha", { conversationId: other.id, blocks: [{ type: "text", text: "abc%def from another conversation" }] });
    for (const id of [conversation.id, "missing"]) {
      const scoped = await fetch(`${hub.url}${route}?q=abc%25def&conversationId=${id}`, { headers });
      expect(scoped.status).toBe(200);
      const body = await scoped.json(), items = route.endsWith("/page") ? body.items : body;
      expect(items.map((item: { id: string }) => item.id)).toEqual(id === conversation.id ? [message.id] : []);
    }
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const original = hub.store.search.bind(hub.store), originalPage = hub.store.searchPage.bind(hub.store);
    const wait = async <T>(task: Promise<T>): Promise<T> => { const results = await task; entered(); await gate; return results; };
    const search = vi.spyOn(hub.store, "search").mockImplementationOnce((...args) => wait(original(...args)));
    const page = vi.spyOn(hub.store, "searchPage").mockImplementationOnce((...args) => wait(originalPage(...args)));
    const waiting = fetch(`${hub.url}${route}?q=abc`, { headers });
    try { await ready; await hub.auth.revoke("device", "local-owner"); } finally { release(); search.mockRestore(); page.mockRestore(); }
    const denied = await waiting; expect(denied.status).toBe(401); expect(await denied.json()).toEqual({ error: "device_revoked" });
  });
  it.each([true, false])("native task controls authorize the exact conversation and negotiate worker support (%s)", async capable => {
    const secret = randomBytes(32).toString("base64url");
    for (const id of ["alpha", "foreign"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "Tasks", "tasks");
    const hidden = await hub.store.createConversation("owner", ["alpha"], "Hidden tasks", "hidden_tasks");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [hidden.id]);
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "alpha", secret, engine: "claude", model: "", effort: "", capabilities: capable ? ["conversations.tasks.v1"] : [] }); await bot.next("instance.ready");
    const url = `${hub.url}/api/conversations/${chat.id}/tasks`;
    expect((await fetch(`${url}?botId=alpha`)).status).toBe(401);
    await paired(); const { token, serverCapabilities } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    expect(serverCapabilities).toContain("conversations.tasks.v1");
    expect((await fetch(`${hub.url}/api/conversations/${hidden.id}/tasks?botId=alpha`, { headers })).status).toBe(403);
    expect((await fetch(`${url}?botId=foreign`, { headers })).status).toBe(403);
    const input = { botId: "alpha", taskId: "opaque", requestId: "stop_one" };
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...input, botId: "foreign" }) })).status).toBe(403);
    const reading = fetch(`${url}?botId=alpha`, { headers });
    if (!capable) {
      expect(await (await reading).json()).toEqual({ supported: false, tasks: [] });
      expect(await (await fetch(url, { method: "POST", headers, body: JSON.stringify(input) })).json()).toEqual({ outcome: "rejected", reason: "unsupported" });
      expect(bot.frames.some(frame => frame.type === "instance.call")).toBe(false); return;
    }
    const read = await bot.next("instance.call"); expect(read).toMatchObject({ method: "tasks.list", params: { conversationId: chat.id } });
    bot.send({ type: "instance.result", id: read.id, result: { supported: true, tasks: [], foregroundStopScope: "subagents" } });
    expect(await (await reading).json()).toEqual({ supported: true, tasks: [], foregroundStopScope: "subagents" });
    const stopping = fetch(url, { method: "POST", headers, body: JSON.stringify(input) });
    const stop = await bot.next("instance.call"); expect(stop).toMatchObject({ method: "tasks.stop", params: { conversationId: chat.id, userId: "owner", taskId: "opaque", requestId: "stop_one" } });
    bot.send({ type: "instance.result", id: stop.id, result: { outcome: "accepted" } }); expect(await (await stopping).json()).toEqual({ outcome: "accepted" });
    const recovering = fetch(`${url}/recover`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ botId: "alpha", token: "fence", requestId: "recover" }) });
    const recovery = await bot.next("instance.call"); expect(recovery).toMatchObject({ method: "tasks.recover", params: { conversationId: chat.id, userId: "owner", token: "fence", requestId: "recover" } });
    bot.send({ type: "instance.result", id: recovery.id, result: { outcome: "accepted" } });
    expect(await (await recovering).json()).toEqual({ outcome: "accepted" });
    const stale = fetch(`${url}?botId=alpha`, { headers }); const held = await bot.next("instance.call");
    await hub.auth.revoke("device", "local-owner");
    bot.send({ type: "instance.result", id: held.id, result: { supported: true, tasks: [] } }); expect((await stale).status).toBe(401);
  });
  it.each(["offline", "unresponsive"])("stops every reachable group member promptly when the first member is %s", async (mode) => {
    const secret = randomBytes(32).toString("base64url");
    for (const id of ["alpha", "beta", "foreign"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha", "beta"], "Stop all", "stop_all");
    const other = await hub.store.createConversation("owner", ["beta"], "Hidden", "hidden");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [other.id]);
    async function instance(botId: string) {
      const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
      bot.send({ type: "instance.hello", botId, secret, engine: "fake", model: "", effort: "" }); await bot.next("instance.ready"); return bot;
    }
    const alpha = mode === "unresponsive" ? await instance("alpha") : undefined, beta = await instance("beta");
    await paired(); const { peer } = await connect();
    const started = performance.now(); peer.send({ type: "turn.stop", conversationId: conversation.id });
    const call = await beta.next("instance.call"); expect(performance.now() - started).toBeLessThan(1000);
    expect(call).toMatchObject({ method: "stop", params: { conversationId: conversation.id, userId: "owner" } });
    beta.send({ type: "instance.result", id: call.id, result: { stopped: true } });
    alpha?.ws.terminate(); expect((await peer.next("error")).code).toBe("stop_incomplete");
    peer.send({ type: "turn.stop", conversationId: conversation.id, botId: "foreign" });
    expect((await peer.next("error")).code).toBe("bot_forbidden");
    peer.send({ type: "turn.stop", conversationId: other.id });
    expect((await peer.next("error")).code).toBe("conversation_forbidden");
    expect(beta.frames.some((f) => f.type === "instance.call")).toBe(false);
    peer.send({ type: "turn.stop", conversationId: conversation.id, botId: "beta" });
    const targeted = await beta.next("instance.call"); beta.send({ type: "instance.result", id: targeted.id, result: { stopped: false } });
    peer.send({ type: "ping" }); await peer.next("pong");
    expect(peer.frames.some((f) => f.type === "error")).toBe(false);
  });
  it("does not queue stop behind an unrelated stalled command RPC and still enforces authorization", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Stop while querying", "stop_rpc");
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "alpha", secret, engine: "fake", model: "", effort: "" }); await bot.next("instance.ready");
    await paired(); const { peer } = await connect();
    peer.send({ type: "command.complete", botId: "alpha", query: "/" }); const command = await bot.next("instance.call"); expect(command.method).toBe("commands");
    const start = performance.now(); peer.send({ type: "turn.stop", conversationId: conversation.id });
    const stop = await bot.next("instance.call"); expect(stop.method).toBe("stop"); expect(performance.now() - start).toBeLessThan(1000);
    bot.send({ type: "instance.result", id: stop.id, result: { stopped: true } });
    peer.send({ type: "turn.stop", conversationId: conversation.id, botId: "foreign" });
    expect((await peer.next("error")).code).toBe("bot_forbidden");
    // Even this priority lane must revalidate an expired device session.
    const session = vi.spyOn(hub.auth, "validateSession").mockRejectedValueOnce(new HubError("session_expired", 401));
    peer.send({ type: "turn.stop", conversationId: conversation.id }); expect((await peer.next("error")).code).toBe("session_expired"); session.mockRestore();
    expect(bot.frames.some((frame) => frame.type === "instance.call")).toBe(false);
    bot.send({ type: "instance.result", id: command.id, result: [] });
  });
  it("stops during snapshot catch-up and a rejected stop cannot interrupt synchronization", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Catch-up", "catchup");
    for (let i = 0; i < 9; i++) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `history ${i}` }] });
    // A stale client cursor forces a snapshot without manufacturing 1000 events.
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "alpha", secret, engine: "fake", model: "", effort: "" }); await bot.next("instance.ready");
    await paired(); const { peer } = await connect({ [conversation.id]: 1001 }, ["snapshot.v1"], false, false);
    const snapshot = await peer.next("snapshot.begin"); await peer.next("snapshot.message", (frame) => frame.index === 8);
    const start = performance.now(); peer.send({ type: "turn.stop", conversationId: conversation.id });
    const stop = await bot.next("instance.call"); expect(stop.method).toBe("stop"); expect(performance.now() - start).toBeLessThan(1000);
    bot.send({ type: "instance.result", id: stop.id, result: { stopped: true } });
    peer.send({ type: "turn.stop", conversationId: conversation.id, botId: "foreign" });
    expect((await peer.next("error")).code).toBe("bot_forbidden");
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    peer.ackSnapshots = true; peer.send({ type: "snapshot.ack", id: snapshot.id, count: 9 });
    await peer.next("sync.complete");
  });
  it("slow or offline command completion cannot block sending a message", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Commands", "commands");
    const bot = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "alpha", secret, engine: "fake", model: "", effort: "" }); await bot.next("instance.ready");
    await paired(); const { peer } = await connect();
    peer.send({ type: "command.complete", botId: "alpha", query: "res" }); const command = await bot.next("instance.call");
    peer.send({ type: "command.complete", botId: "alpha", query: "resu" }); peer.send({ type: "command.complete", botId: "alpha", query: "resume" });
    const start = performance.now(); peer.send({ type: "message.send", clientMsgId: "unblocked", conversationId: conversation.id, text: "hello", attachments: [] });
    expect(await peer.next("message.ack")).toMatchObject({ clientMsgId: "unblocked" }); expect(performance.now() - start).toBeLessThan(1000);
    bot.send({ type: "instance.result", id: command.id, result: [] });
    expect(await peer.next("command.completions")).toMatchObject({ botId: "alpha", query: "res", result: [] });
    const latest = await bot.next("instance.call"); expect(latest.params).toMatchObject({ query: "resume" });
    bot.send({ type: "instance.result", id: latest.id, result: [] });
    expect(await peer.next("command.completions")).toMatchObject({ query: "resume", result: [] });
    bot.ws.terminate(); await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(0));
    peer.send({ type: "command.complete", botId: "alpha", query: "" });
    expect(await peer.next("command.completions")).toMatchObject({ result: [] });
    expect(peer.frames.some((frame) => frame.type === "error")).toBe(false);
  });
  it("accepts fragmented publications only from authenticated instances and never persists partial or corrupt input", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Fragment trust", "trust");
    const request = { v: 1, type: "instance.request", id: "large_publish", method: "publish", params: { id: "large_message", conversationId: conversation.id, version: 1, blocks: [{ type: "text", text: "完整内容🙂".repeat(100_000) }], status: "complete" } };
    const parts = [...frameParts(JSON.stringify(request))];
    const instance = async () => { const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws); return peer; };
    const untrusted = await instance(); untrusted.ws.send(parts[0]!);
    expect((await untrusted.next("error")).code).toBe("instance_request_rejected");
    await paired(); const user = await connect({}, ["fragments.v1"]); user.peer.ws.send(parts[0]!);
    user.peer.send({ type: "ping" }); await user.peer.next("pong");
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    const hello = { type: "instance.hello", botId: "alpha", secret, engine: "codex", model: "", effort: "", capabilities: ["fragments.v1"] };
    const broken = await instance(); broken.send(hello); await broken.next("instance.ready");
    broken.ws.send(parts[0]!); broken.send({ type: "ping" }); await broken.next("pong");
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    const corrupt = JSON.parse(parts[1]!) as { data: string }; corrupt.data = "A" + corrupt.data.slice(1);
    broken.ws.send(JSON.stringify(corrupt)); for (const part of parts.slice(2)) broken.ws.send(part);
    expect((await broken.next("error")).code).toBe("instance_request_rejected");
    expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    const recovered = await instance(); recovered.send(hello); await recovered.next("instance.ready");
    await writeFrame(recovered.ws, request); const result = await recovered.next("instance.result");
    expect(result.error).toBeUndefined(); expect((await hub.store.snapshot("owner", conversation.id)).messages[0]?.blocks).toEqual(request.params.blocks);
  }, 30_000); // Several connections and multi-MiB hashing; each frame wait stays bounded at 5 s.
  it("advertises and enforces the configured upload size for devices and Gateway HTTP uploads", async () => {
    await hub.close(); hub = await HubServer.start({ stateDir: directory, maxFileBytes: 4 });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Limits", "limits");
    await paired(); const { token, uploadLimits } = await connect();
    expect(uploadLimits).toEqual({ maxFileBytes: 4, chunkBytes: CHUNK_BYTES });
    for (const [route, authorization] of [["/api/uploads", `Bearer ${token}`], ["/api/instance/uploads", `Instance alpha:${secret}`]]) {
      const metadata = { conversationId: conversation.id, name: "limit.bin", mime: "application/octet-stream", sha256: "a".repeat(64), size: 5 };
      const blocked = await fetch(hub.url + route, { method: "POST", headers: { authorization: authorization! }, body: JSON.stringify(metadata) });
      expect(blocked.status).toBe(413); expect(await blocked.json()).toMatchObject({ error: "file_too_large" });
      expect((await fetch(hub.url + route, { method: "POST", headers: { authorization: authorization! }, body: JSON.stringify({ ...metadata, size: 4 }) })).status).toBe(201);
    }
    expect((await hub.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM attachments"))?.count).toBe(1);
  });
  it("authorizes draft previews and asynchronously sends the same durable preview to both devices", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Links", "links");
    hub.linkPreviews.read = vi.fn(async (url) => ({ url, status: "ready" as const, title: "Preview title", siteName: "Example" }));
    const body = JSON.stringify({ conversationId: conversation.id, url: "https://example.org/" });
    expect((await fetch(`${hub.url}/api/link-preview`, { method: "POST", body })).status).toBe(401);
    expect(hub.linkPreviews.read).not.toHaveBeenCalled();
    await paired(); const { peer, token } = await connect(), second = await connect(); const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${hub.url}/api/link-preview`, { method: "POST", headers, body: JSON.stringify({ conversationId: "forbidden", url: "https://example.org/" }) })).status).toBe(403);
    expect(hub.linkPreviews.read).not.toHaveBeenCalled();
    const prepared = await fetch(`${hub.url}/api/link-preview`, { method: "POST", headers, body }); expect(prepared.status).toBe(200);
    const preview = await prepared.json(); expect((await hub.store.snapshot("owner", conversation.id)).messages).toHaveLength(0);
    peer.send({ type: "message.send", conversationId: conversation.id, clientMsgId: "link", text: "https://example.org/", attachments: [] });
    const ack = await peer.next("message.ack");
    for (const receiver of [peer, second.peer]) expect((await receiver.next("event", (f) => f.kind === "message.updated")).payload).toMatchObject({ id: ack.messageId, linkPreview: preview });
    expect(hub.linkPreviews.read).toHaveBeenCalledTimes(1); expect(await hub.store.pendingForBot("alpha")).toHaveLength(1);
  });
  it("confirms quick creation over authenticated HTTP and synchronizes topics to other devices", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("key")]);
    await paired(); const { peer, token } = await connect(); const second = await connect();
    const headers = { authorization: `Bearer ${token}` };
    const create = (frame: object) => fetch(`${hub.url}/api/conversations`, { method: "POST", headers, body: JSON.stringify({ v: 1, ...frame }) });
    const frame = { type: "conversation.create", conversationType: "group", botIds: ["alpha"], title: "One Bot group", clientActionId: "group" };
    expect((await fetch(`${hub.url}/api/conversations`, { method: "POST", body: JSON.stringify(frame) })).status).toBe(401);
    const response = await create(frame); expect(response.status).toBe(201); const group = await response.json() as { id: string; type: string };
    expect(group.type).toBe("group"); expect((await (await create(frame)).json()).id).toBe(group.id);
    const topicResponse = await create({ type: "topic.create", groupId: group.id, title: "Task", clientActionId: "topic" }); expect(topicResponse.status).toBe(201);
    const topic = await topicResponse.json() as { id: string; parentId: string }; expect(topic.parentId).toBe(group.id);
    await second.peer.next("conversation.updated", (f) => (f.conversation as Record<string, Json>).id === topic.id);
    peer.send({ type: "message.send", conversationId: topic.id, clientMsgId: "topic_message", text: "hello", attachments: [] }); await peer.next("message.ack");
    expect((await second.peer.next("event")).conversationId).toBe(topic.id);
    expect((await create({ type: "message.send", conversationId: group.id, clientMsgId: "bad", text: "bad", attachments: [] })).status).toBe(400);
  });
  it("acknowledges forwarding once on both devices and rejects executable interactions on forwarded cards", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("key")]);
    const source = await hub.store.createConversation("owner", ["alpha"], "Source", "source");
    const target = await hub.store.createConversation("owner", ["alpha"], "Target", "target");
    const original = await hub.store.publishBotMessage("alpha", { conversationId: source.id, blocks: [{ type: "card", title: "Approval", elements: [{ type: "button", text: "Run", actionId: "run" }] }] });
    await paired(); const { peer } = await connect(); const second = await connect();
    const frame = { type: "message.forward", clientMsgId: "forward", sourceMessageId: original.id, conversationId: target.id };
    peer.send(frame); const ack = await peer.next("message.ack");
    const event = await second.peer.next("event", (f) => f.conversationId === target.id);
    expect((event.payload as Frame).forwardedFrom).toMatchObject({ messageId: original.id });
    peer.send(frame); expect((await peer.next("message.ack")).messageId).toBe(ack.messageId);
    peer.send({ type: "interaction.submit", clientActionId: "forged_action", conversationId: target.id, messageId: ack.messageId, actionId: "run", values: {} });
    expect((await peer.next("error")).message).toBe("interaction_forbidden");
    expect((await hub.store.snapshot("owner", target.id)).messages).toHaveLength(1);
    expect(await hub.store.pendingActions("alpha")).toHaveLength(0);
  });
  it("routes only the mentioned bot, acknowledges idempotently, replays and revokes the socket", async () => {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta',?)", [hashSecret(randomBytes(32).toString("hex"))]);
    const bot = await Peer.connect(hub.url.replace("http", "ws") + "/instance"); sockets.push(bot.ws);
    bot.send({ type: "instance.hello", botId: "alpha", secret, engine: "fake", model: "test", effort: "high" }); await bot.next("instance.ready");
    await paired(); const { peer } = await connect();
    peer.send({ type: "conversation.create", clientActionId: "create", botIds: ["alpha", "beta"], title: "Group" });
    const c = (await peer.next("conversation.updated")).conversation as Record<string, Json>;
    const input = { type: "message.send", conversationId: c.id, clientMsgId: "offline_1", text: "hello", attachments: [], mentions: ["alpha"] };
    peer.send(input); const ack = await peer.next("message.ack");
    const delivered = await bot.next("instance.message"); const message = delivered.message as Record<string, Json>;
    expect(message.id).toBe(ack.messageId); expect(await hub.store.pendingForBot("beta")).toHaveLength(0);
    bot.send({ type: "instance.request", id: "reply", method: "publish", params: { conversationId: c.id, blocks: [{ type: "text", text: "answer" }], status: "complete" } });
    await bot.next("instance.result", (f) => f.id === "reply");
    const event = await peer.next("event", (f) => (f.payload as Record<string, Json>).authorType === "bot"); expect(event.seq).toBe(2);
    peer.send(input); expect((await peer.next("message.ack")).messageId).toBe(ack.messageId);
    const second = await connect({ [c.id as string]: 1 }); expect((await second.peer.next("event")).seq).toBe(2);
    peer.send({ type: "future.ignored" }); peer.send({ type: "ping" }); await peer.next("pong");
    const closed = new Promise((resolve) => peer.ws.once("close", resolve)); await hub.auth.revoke("device", "local-owner"); await closed;
    expect((await fetch(`${hub.url}/api/devices`, { headers: { authorization: `Bearer ${second.token}` } })).status).toBe(401);
  });
  it("rejects unknown devices, hostile origins, public binds and missing HTTP authorization", async () => {
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    peer.send({ type: "hello", deviceId: "unknown", nonce: randomBytes(32).toString("hex"), protocolVersions: [1], capabilities: [], cursors: {} });
    expect((await peer.next("error")).code).toBe("untrusted_device");
    expect((await fetch(`${hub.url}/api/devices`)).status).toBe(401);
    expect((await fetch(`${hub.url}/health`, { headers: { origin: "https://attacker.invalid" } })).status).toBe(403);
    for (const host of ["0.0.0.0", "::", "192.168.1.1", "1.2.3.4", "localhost"]) expect(() => assertSafeBind(host, true)).toThrow();
    expect(() => assertSafeBind("100.64.0.1", false)).toThrow(); expect(() => assertSafeBind("100.64.0.1", true)).not.toThrow();
  });
  it("pairs another device over HTTP only with an owner-issued invite and still requires the owner's signed approval", async () => {
    await paired(); const { token, serverCapabilities } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    expect(serverCapabilities).toContain(PAIRING_INVITES_CAPABILITY);
    expect((await fetch(`${hub.url}${PAIRING_INVITES_PATH}`, { method: "POST", body: JSON.stringify({ requestId: pairingRequestId() }) })).status).toBe(401);
    const issued = await issueOverHttp(headers);
    const phone = deviceFields(testDevice("phone")), requestId = pairingRequestId();
    expect(await postPairing(hub.url, phone)).toEqual({ status: 403, body: { error: "pairing_invite_required" } });
    expect(await postPairing(hub.url, { ...phone, invite: randomBytes(32).toString("base64url"), requestId })).toEqual({ status: 403, body: { error: "pairing_invite_invalid" } });
    expect(await postPairing(hub.url, { ...phone, invite: issued.invite })).toEqual({ status: 400, body: { error: "pairing_request_id_required" } });
    const admitted = await postPairing(hub.url, { ...phone, invite: issued.invite, requestId });
    expect(admitted).toEqual({ status: 201, body: { code: expect.stringMatching(/^\d{8}$/), expiresAt: expect.any(Number), hubPublicKey: hub.auth.publicKey } });
    // A lost receipt: the identical body returns the same code, even without the token.
    expect(await postPairing(hub.url, { ...phone, requestId })).toEqual(admitted);
    expect(await postPairing(hub.url, { ...deviceFields(testDevice("stranger")), invite: issued.invite, requestId: pairingRequestId() })).toEqual({ status: 409, body: { error: "pairing_invite_used" } });
    const listed = await (await fetch(`${hub.url}${PAIRING_INVITES_PATH}`, { headers })).text();
    expect(listed).not.toContain(issued.invite);
    expect(pairingInviteListSchema.parse(JSON.parse(listed)).invites).toMatchObject([{ id: issued.id, state: "claimed", device: { deviceId: "phone" } }]);
    // Admission is not enrollment: the phone cannot authenticate until approved.
    const pending = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(pending.ws);
    pending.send({ type: "hello", deviceId: "phone", nonce: randomBytes(32).toString("base64url"), protocolVersions: [1], capabilities: [], cursors: {} });
    expect((await pending.next("error")).code).toBe("untrusted_device");
    expect((await fetch(`${hub.url}/api/devices/approve`, { method: "POST", headers, body: JSON.stringify({ code: admitted.body.code }) })).status).toBe(403);
    const { body } = await signedDeviceAction(hub.url, token, keypair.privateKey, { operation: "approve", target: String(admitted.body.code) });
    const approved = await fetch(`${hub.url}/api/devices/approve`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(approved.status).toBe(200); expect(await approved.json()).toEqual({ deviceId: "phone" });
    expect(await postPairing(hub.url, { ...phone, requestId })).toEqual({ status: 409, body: { error: "device_already_registered" } });
  });
  it("revokes an owner's invite over HTTP without deleting a request it already admitted", async () => {
    await paired(); const { token } = await connect(); const headers = { Authorization: `Bearer ${token}` };
    const used = await issueOverHttp(headers), unused = await issueOverHttp(headers);
    const phone = deviceFields(testDevice("phone")), requestId = pairingRequestId();
    const admitted = await postPairing(hub.url, { ...phone, invite: used.invite, requestId });
    const revoke = (id: string) => fetch(`${hub.url}${PAIRING_INVITE_REVOKE_PATH}`, { method: "POST", headers, body: JSON.stringify({ id }) });
    for (const invite of [used, unused]) expect((await revoke(invite.id)).status).toBe(200);
    expect((await revoke(randomBytes(16).toString("base64url"))).status).toBe(404);
    expect(await postPairing(hub.url, { ...deviceFields(testDevice("tablet")), invite: unused.invite, requestId: pairingRequestId() })).toEqual({ status: 403, body: { error: "pairing_invite_invalid" } });
    expect(await postPairing(hub.url, { ...phone, invite: used.invite, requestId })).toEqual(admitted);
    expect(await hub.auth.approve(String(admitted.body.code), "local-owner")).toBe("phone");
  });
  it("uploads over HTTP by opaque id and rejects traversal with an audit receipt", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Files", "files");
    await paired(); const { token } = await connect();
    const headers = { authorization: `Bearer ${token}` };
    const file = Buffer.from("test content");
    const input = { conversationId: conv.id, name: "example.txt", size: file.length, mime: "text/plain", sha256: createHash("sha256").update(file).digest("hex") };
    expect((await fetch(`${hub.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ ...input, name: "../identity.json" }) })).status).toBe(400);
    const created = await fetch(`${hub.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify(input) }); const { id } = await created.json() as { id: string };
    expect((await fetch(`${hub.url}/api/uploads/${id}/0`, { method: "PUT", headers, body: file })).status).toBe(200);
    expect((await fetch(`${hub.url}/api/uploads/${id}/complete`, { method: "POST", headers })).status).toBe(200);
    const downloaded = await fetch(`${hub.url}/api/attachments/${id}`, { headers }); expect(await downloaded.text()).toBe(file.toString());
    expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='http.rejected'")).toBeDefined();
  });
  it("sends negotiated deltas, keeps legacy snapshots, and re-establishes a full base on replay", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Stream", "stream");
    await paired(); const { peer } = await connect({}, ["cards.v1", "streaming.v1"]), legacy = (await connect()).peer;
    const prefix = "完整正文".repeat(12_500);
    const initial = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: prefix }], status: "streaming" });
    expect((await peer.next("event")).kind).toBe("message.created"); await legacy.next("event");
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [{ type: "text", text: prefix + "新增片段" }], status: "streaming" });
    const delta = await peer.next("event"); expect(delta.kind).toBe("message.stream");
    expect(delta.payload).toEqual({ messageId: initial.id, baseVersion: 1, version: 2, ops: [{ op: "appendText", block: 0, text: "新增片段" }] });
    expect(Buffer.byteLength(JSON.stringify(delta))).toBeLessThan(512);
    const full = await legacy.next("event"); expect(full.kind).toBe("message.updated"); expect((full.payload as Record<string, Json>).blocks).toEqual([{ type: "text", text: prefix + "新增片段" }]);
    peer.ws.terminate();
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [{ type: "text", text: prefix + "新增片段断线期间" }], status: "streaming" });
    const resumed = (await connect({ [conv.id]: 2 }, ["cards.v1", "streaming.v1"])).peer;
    const replay = await resumed.next("event"); expect(replay.seq).toBe(3); expect(replay.kind).toBe("message.updated"); expect((replay.payload as Record<string, Json>).version).toBe(3);
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [{ type: "text", text: prefix + "新增片段断线期间继续" }], status: "streaming" });
    expect((await resumed.next("event")).kind).toBe("message.stream");
    const final = await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [{ type: "text", text: prefix + "最终快照" }], status: "complete" });
    const terminal = await resumed.next("event"); expect(terminal.kind).toBe("message.updated"); expect(terminal.payload).toEqual(final);
    const durable = await hub.store.sync("owner", conv.id, 0); expect(durable.events).toHaveLength(5); expect(durable.events.every((event) => event.kind !== "message.stream")).toBe(true);
  });
  it("only sends card-extra operations to peers that advertise them", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conv = await hub.store.createConversation("owner", ["alpha"], "Native", "native");
    await paired();
    const modern = (await connect({}, ["cards.v1", "streaming.v1", "streaming.card-extra.v1"])).peer;
    const old = (await connect({}, ["cards.v1", "streaming.v1"])).peer;
    const legacy = (await connect()).peer;
    const card = (revision: number) => ({ type: "card" as const, extra: { nativeRun: { revision } }, elements: [{ type: "markdown" as const, text: "正文".repeat(10000) + revision }] });
    const initial = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [card(1)], status: "streaming" });
    await Promise.all([modern.next("event"), old.next("event"), legacy.next("event")]);
    await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [card(2)], status: "streaming" });
    const current = await modern.next("event"), compat = await old.next("event"), full = await legacy.next("event");
    expect(JSON.stringify(current)).toContain("replaceCardExtra");
    expect(JSON.stringify(compat)).not.toContain("replaceCardExtra");
    expect(full.kind).toBe("message.updated");
    // A fresh connection receives a durable base, never a delta against a base it missed.
    const resumed = (await connect({ [conv.id]: 1 }, ["cards.v1", "streaming.v1", "streaming.card-extra.v1"])).peer;
    expect((await resumed.next("event")).kind).toBe("message.updated");
    const final = await hub.store.publishBotMessage("alpha", { id: initial.id, conversationId: conv.id, blocks: [card(3)], status: "complete" });
    expect((await modern.next("event")).payload).toEqual(final);
    expect((await resumed.next("event")).payload).toEqual(final);
  });
  it("replaces a large journal gap with bounded consistent snapshots, then catches concurrent writes", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Snapshot", "snapshot");
    const first = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "first" }] });
    await hub.store.markRead("owner", conv.id, 1);
    await hub.store.publishBotMessage("alpha", { id: first.id, conversationId: conv.id, blocks: [{ type: "text", text: "edited after read" }] });
    let streamingId = "";
    for (let i = 0; i < 6; i++) {
      const reply = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "正文".repeat(30_000) + i }], status: i === 5 ? "streaming" : "complete" });
      if (i === 5) streamingId = reply.id;
    }
    for (let i = 0; i < 1001; i++) await hub.store.appendBotEvent("alpha", conv.id, "turn.state", { phase: "thinking", i });
    const before = await hub.store.snapshot("owner", conv.id);
    const original = hub.store.snapshotFrames.bind(hub.store); let liveId = "";
    const spy = vi.spyOn(hub.store, "snapshotFrames").mockImplementation(async function* (...args) {
      for await (const frame of original(...args)) {
        yield frame;
        if (frame.type === "snapshot.begin") {
          liveId = (await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "arrived during snapshot" }] })).id;
          await hub.store.publishBotMessage("alpha", { id: streamingId, conversationId: conv.id, blocks: [{ type: "text", text: "正文".repeat(30_000) + "5 continued" }], status: "streaming" });
        }
      }
    });
    await paired(); const { peer } = await connect({}, ["cards.v1", "streaming.v1", "snapshot.v1"]);
    const begin = await peer.next("snapshot.begin"), end = await peer.next("snapshot.end");
    expect(begin.seq).toBe(before.seq); expect(begin.readSeq).toBe(1); expect(end.count).toBe(7);
    const entries = peer.frames.filter((frame) => frame.type === "snapshot.message");
    expect(entries.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(entries.map((f) => f.message)).toEqual(before.messages);
    expect(entries[0]).toMatchObject({ contentSeq: 3, unreadSeq: 1 });
    expect(entries.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0)).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(entries.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= MAX_FRAME_BYTES)).toBe(true);
    const live = await peer.next("event"); expect(live.seq).toBe(before.seq + 1); expect((live.payload as Record<string, Json>).id).toBe(liveId);
    const delta = await peer.next("event"); expect(delta).toMatchObject({ seq: before.seq + 2, kind: "message.stream", payload: { messageId: streamingId, baseVersion: 1, version: 2, ops: [{ op: "appendText", block: 0, text: " continued" }] } });
    peer.send({ type: "ping" }); await peer.next("pong"); spy.mockRestore();
    const legacy = (await connect()).peer;
    expect(legacy.frames.some((frame) => String(frame.type).startsWith("snapshot."))).toBe(false);
    expect(legacy.frames.filter((frame) => frame.type === "event")).toHaveLength(before.seq + 2);
  }, 30_000); // Includes 1,001 durable setup commits, beyond the transport assertions themselves.
  it("negotiates snapshot activity timestamps without breaking strict older clients", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Activity", "activity");
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "start" }], status: "streaming" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(reply.createdAt + 5000);
    try { await hub.store.publishBotMessage("alpha", { id: reply.id, conversationId: conv.id, blocks: [{ type: "text", text: "continued" }], status: "streaming" }); }
    finally { clock.mockRestore(); }
    await paired();
    for (const modern of [false, true]) {
      const { peer } = await connect({ [conv.id]: 100 }, ["snapshot.v1", ...(modern ? [SNAPSHOT_ACTIVITY_CAPABILITY] : [])]);
      const frame = await peer.next("snapshot.message");
      expect(snapshotFrameSchema.safeParse(frame).success).toBe(true);
      if (modern) expect(frame.contentAt).toBe(reply.createdAt + 5000);
      else expect(frame).not.toHaveProperty("contentAt");
    }
  });
  it("slides the bounded receipt window on partial ACKs and rejects impossible receipts", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Flow control", "flow_control");
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: `message ${i}` }] });
    await paired(); const { peer } = await connect({ [conv.id]: 100 }, ["snapshot.v1"], false, false);
    const begin = await peer.next("snapshot.begin");
    await peer.next("snapshot.message", f => f.index === 31);
    peer.send({ type: "ping" }); await peer.next("pong");
    expect(peer.frames.filter(f => f.type === "snapshot.message")).toHaveLength(31);
    expect(peer.frames.some(f => f.type === "snapshot.end")).toBe(false);
    // Releasing just one slot must advance; the remaining 31 need not drain.
    peer.send({ type: "snapshot.ack", id: begin.id, count: 1 });
    await peer.next("snapshot.message", f => f.index === 32);
    peer.send({ type: "ping" }); await peer.next("pong");
    expect(peer.frames.some(f => f.type === "snapshot.message" && Number(f.index) > 32)).toBe(false);
    peer.send({ type: "snapshot.ack", id: begin.id, count: 32 });
    await peer.next("snapshot.message", f => f.index === 39);
    peer.send({ type: "snapshot.ack", id: begin.id, count: 40 });
    expect(await peer.next("snapshot.end")).toMatchObject({ count: 40 }); await peer.next("sync.complete");
    const invalid = (await connect({ [conv.id]: 100 }, ["snapshot.v1"], false, false)).peer;
    const otherBegin = await invalid.next("snapshot.begin"); await invalid.next("snapshot.message", f => f.index === 31);
    const closed = new Promise<number>(resolve => invalid.ws.once("close", resolve));
    invalid.send({ type: "snapshot.ack", id: otherBegin.id, count: 999 });
    expect(await closed).toBe(4008);
  });
  it("caps outstanding snapshot bytes even below the message limit", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conv = await hub.store.createConversation("owner", ["alpha"], "Bytes", "byte_window");
    for (let i = 0; i < 12; i++) await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "x".repeat(180_000) }] });
    await paired(); const { peer } = await connect({ [conv.id]: 100 }, ["snapshot.v1", "fragments.v1"], false, false);
    const begin = await peer.next("snapshot.begin");
    await peer.next("snapshot.message", f => f.index === 4);
    peer.send({ type: "ping" }); await peer.next("pong");
    expect(peer.frames.some(f => f.type === "snapshot.message" && Number(f.index) > 4)).toBe(false);
    peer.send({ type: "snapshot.ack", id: begin.id, count: 1 });
    await peer.next("snapshot.message", f => f.index === 5);
    peer.ackSnapshots = true; peer.send({ type: "snapshot.ack", id: begin.id, count: 6 });
    await peer.next("sync.complete");
  });
  it("prioritizes the selected conversation and admits its live replies and sends during another stalled snapshot", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const live = await hub.store.createConversation("owner", ["alpha"], "Selected", "selected_sync");
    const history = await hub.store.createConversation("owner", ["alpha"], "History", "history_sync");
    for (let i = 0; i < 40; i++) await hub.store.publishBotMessage("alpha", { conversationId: history.id, blocks: [{ type: "text", text: `old ${i}` }] });
    await paired(); const { peer } = await connect({ [history.id]: 100 }, ["snapshot.v1", CONVERSATION_SYNC_CAPABILITY], false, false, live.id);
    expect(await peer.next("sync.conversation")).toMatchObject({ conversationId: live.id });
    const begin = await peer.next("snapshot.begin");
    await peer.next("snapshot.message", f => f.index === 31);
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: live.id, blocks: [{ type: "text", text: "live during history" }] });
    expect(await peer.next("event", f => f.conversationId === live.id)).toMatchObject({ payload: { id: reply.id }, seq: 1 });
    peer.send({ type: "message.send", conversationId: live.id, clientMsgId: "during_history", text: "send during history", attachments: [] });
    await peer.next("message.ack", f => f.clientMsgId === "during_history");
    // An ordinary rejected request is answered, not treated as a failed sync.
    peer.send({ type: "message.send", conversationId: live.id, clientMsgId: "bad_reply", text: "reply", attachments: [], replyTo: "msg_missing" });
    expect(await peer.next("error", f => f.requestId === "bad_reply")).toMatchObject({ code: "reply_not_found" });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(peer.frames.some(f => f.type === "sync.complete")).toBe(false);
    peer.ackSnapshots = true; peer.send({ type: "snapshot.ack", id: begin.id, count: 32 });
    await peer.next("sync.complete");
    expect((await hub.store.snapshot("owner", live.id)).messages).toHaveLength(2);
  });
  it("keeps the socket when a live reply arrives while one large history message is still being written", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const live = await hub.store.createConversation("owner", ["alpha"], "Selected", "selected_large");
    const history = await hub.store.createConversation("owner", ["alpha"], "History", "history_large");
    await hub.store.publishBotMessage("alpha", { conversationId: history.id, blocks: [{ type: "card", elements: [], extra: { retained: "x".repeat(6 * MAX_FRAME_BYTES) } }] });
    await paired();
    const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
    const closed = new Promise<number>(resolve => peer.ws.once("close", code => resolve(code)));
    const clientNonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: "device", nonce: clientNonce, protocolVersions: [1], capabilities: ["cards.v1", "snapshot.v1", "fragments.v1", CONVERSATION_SYNC_CAPABILITY], cursors: { [history.id]: 100 }, preferredConversationId: live.id });
    const challenge = await peer.next("challenge");
    // A slow link: the large frame stays queued while the Bot replies.
    const socket = (peer.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    peer.send({ type: "auth", signature: sign(null, deviceProof("device", challenge.nonce as string, clientNonce), keypair.privateKey).toString("base64") }); socket.pause();
    await new Promise(resolve => setTimeout(resolve, 300));
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: live.id, blocks: [{ type: "text", text: "live reply" }] });
    await new Promise(resolve => setTimeout(resolve, 200)); socket.resume();
    expect(await Promise.race([peer.next("sync.complete").then(() => "complete"), closed.then(code => `closed ${code}`)])).toBe("complete");
    expect(peer.frames.some(f => f.type === "event" && (f.payload as { id?: string }).id === reply.id) || (await peer.next("event", f => f.conversationId === live.id)).payload).toBeTruthy();
  }, 20000);
  it("negotiates only changed messages for a valid cached cursor, retaining legacy replacement snapshots", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const conv = await hub.store.createConversation("owner", ["alpha"], "Delta", "delta_sync");
    for (let i = 0; i < 12; i++) await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: `old ${i}` }] });
    const after = (await hub.store.syncHead("owner", conv.id)).seq;
    const changed = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "start" }], status: "streaming" });
    for (let i = 2; i <= 1002; i++) await hub.store.publishBotMessage("alpha", { id: changed.id, conversationId: conv.id, version: i, status: i === 1002 ? "complete" : "streaming", blocks: [{ type: "text", text: `update ${i}` }] });
    await paired(); const modern = (await connect({ [conv.id]: after }, ["snapshot.v1", SNAPSHOT_DELTA_CAPABILITY])).peer;
    expect(await modern.next("snapshot.begin")).toMatchObject({ after, mode: "merge" });
    expect(modern.frames.filter(f => f.type === "snapshot.message")).toHaveLength(1);
    expect(await modern.next("snapshot.message")).toMatchObject({ message: { id: changed.id, version: 1002 } });
    const legacy = (await connect({ [conv.id]: after }, ["snapshot.v1"])).peer;
    expect(await legacy.next("snapshot.begin")).not.toHaveProperty("mode");
    expect(legacy.frames.filter(f => f.type === "snapshot.message")).toHaveLength(13);
  }, 20000);
  it.each([0, 5, 100])("replaces discarded history after official same-path restore with %i fresh messages", async (count) => {
    const backup = directory + "-bundle", discarded = directory + "-discarded";
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
      const conv = await hub.store.createConversation("owner", ["alpha"], "Restore", "restore-lineage");
      const retained = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "retained" }] });
      await paired(); await hub.close(); await backupHubState(directory, backup);
      hub = await HubServer.start({ stateDir: directory });
      const ghosts: string[] = [];
      for (let i = 0; i < 5; i++) ghosts.push((await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: `discarded ${i}` }] })).id);
      const cursor = (await hub.store.syncHead("owner", conv.id)).seq;
      await hub.close(); await rename(directory, discarded); await restoreHubState(backup, directory);
      hub = await HubServer.start({ stateDir: directory });
      const fresh: string[] = [];
      for (let i = 0; i < count; i++) fresh.push((await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: `new ${i}` }] })).id);
      const { peer } = await connect({ [conv.id]: cursor }, ["snapshot.v1", SNAPSHOT_DELTA_CAPABILITY, "sync.lineage.v1"]);
      const begin = await peer.next("snapshot.begin");
      expect(begin).not.toHaveProperty("mode");
      expect(begin).toMatchObject({ after: cursor });
      const sent = peer.frames.filter(f => f.type === "snapshot.message").map(f => (f.message as Record<string, Json>).id);
      expect(sent.sort()).toEqual([retained.id, ...fresh].sort());
      expect(sent.some(id => ghosts.includes(String(id)))).toBe(false);
      const lineage = begin.lineage as string, head = (await hub.store.syncHead("owner", conv.id)).seq;
      expect(lineage).toMatch(/^[0-9a-f-]{36}$/);
      const current = (await connect({ [conv.id]: head }, ["snapshot.v1", SNAPSHOT_DELTA_CAPABILITY, "sync.lineage.v1"], true, true, undefined, { [conv.id]: lineage })).peer;
      expect(current.frames.some(frame => frame.type === "snapshot.begin")).toBe(false);
      const freshClient = (await connect({}, ["snapshot.v1", "sync.lineage.v1"])).peer;
      expect(await freshClient.next("snapshot.begin")).toMatchObject({ after: 0, lineage });
      // Older snapshot readers get the original strict frame and a replacement
      // on each reconnect; no new field or silently trusted cursor is required.
      for (let retry = 0; retry < 2; retry++) {
        const legacy = (await connect({ [conv.id]: head }, ["snapshot.v1", SNAPSHOT_DELTA_CAPABILITY])).peer;
        const frame = await legacy.next("snapshot.begin");
        expect(frame).not.toHaveProperty("mode"); expect(frame).not.toHaveProperty("lineage");
      }
      const unsupported = (await connect({ [conv.id]: head }, [], true, false)).peer;
      expect(await unsupported.next("error")).toMatchObject({ code: "client_update_required_after_restore", retryable: false, message: "主机已从备份恢复，请更新客户端以重新同步完整聊天记录。" });
      expect(unsupported.frames.some(frame => frame.type === "sync.complete")).toBe(false);

    } finally { await rm(backup, { recursive: true, force: true }); await rm(discarded, { recursive: true, force: true }); }
  });
  it("uses an authorized snapshot when a cursor is ahead or the journal prefix is missing", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Repair", "repair");
    await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "retained" }] });
    await hub.store.appendBotEvent("alpha", conv.id, "turn.state", { phase: "done" });
    await hub.store.db.serial(() => hub.store.db.run("DELETE FROM events WHERE conversation_id=? AND seq=1", [conv.id]));
    await expect(hub.store.snapshotFrames("stranger", conv.id, 0).next()).rejects.toThrow("conversation_forbidden");
    await paired();
    for (const cursor of [0, 20]) {
      const { peer } = await connect({ [conv.id]: cursor }, ["snapshot.v1"]);
      expect(await peer.next("snapshot.begin")).toMatchObject({ after: cursor, seq: 2 });
      expect((await peer.next("snapshot.message")).message).toMatchObject({ blocks: [{ type: "text", text: "retained" }] });
      expect(await peer.next("snapshot.end")).toMatchObject({ count: 1 });
    }
  });
  it("tells legacy clients to upgrade instead of silently accepting an unrecoverable cursor", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Repair legacy", "repair-legacy");
    await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks: [{ type: "text", text: "retained" }] });
    await paired();
    const { peer } = await connect({ [conv.id]: 20 }, ["cards.v1"], true, false);
    expect(await peer.next("error")).toMatchObject({ code: "client_update_required", retryable: false });
    expect(peer.frames.some(frame => frame.type === "sync.complete")).toBe(false);
  });
  it("transports complete oversized snapshot messages and tells an older client to upgrade", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Boundary", "boundary");
    const blocks = [{ type: "card" as const, elements: [], extra: { retained: "界🙂".repeat(MAX_FRAME_BYTES / 4) } }];
    const message = await hub.store.publishBotMessage("alpha", { conversationId: conv.id, blocks });
    expect((await hub.store.snapshot("owner", conv.id)).messages).toEqual([message]);
    await expect(hub.store.appendBotEvent("alpha", conv.id, "turn.state", { text: "x".repeat(MAX_FRAME_BYTES) })).rejects.toThrow("event_frame_too_large");
    expect((await hub.store.syncHead("owner", conv.id)).seq).toBe(1);
    await paired(); const { peer } = await connect({ [conv.id]: 100 }, ["snapshot.v1", "cards.v1", "fragments.v1"]);
    const entry = await peer.next("snapshot.message"), size = Buffer.byteLength(JSON.stringify(entry));
    expect(entry.message).toEqual(message); expect(size).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(Math.max(...peer.physicalBytes)).toBeLessThan(MAX_FRAME_BYTES);
    const older = await connect({}, ["cards.v1"], true, false);
    expect(await older.peer.next("error")).toMatchObject({ code: "client_update_required" });
  });
  it("resumes a 120 MiB upload after a Hub restart and validates the full hash", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("example")]);
    const conv = await hub.store.createConversation("owner", ["alpha"], "Large file", "large");
    const chunk = Buffer.alloc(CHUNK_BYTES, 0x5a); const digest = createHash("sha256"); for (let i = 0; i < 15; i++) digest.update(chunk);
    const sha256 = digest.digest("hex");
    const { id } = await hub.attachments.create("owner", { conversationId: conv.id, name: "sample.bin", size: 120 * 1024 * 1024, mime: "application/octet-stream", sha256 });
    for (let i = 0; i < 7; i++) await hub.attachments.putChunk("owner", id, i, chunk);
    await hub.close(); hub = await HubServer.start({ stateDir: directory });
    expect((await hub.attachments.status("owner", id)).chunks).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let i = 7; i < 15; i++) await hub.attachments.putChunk("owner", id, i, chunk);
    expect((await hub.attachments.complete("owner", id)).sha256).toBe(sha256);
    const downloaded = await hub.attachments.download({ userId: "owner" }, id);
    expect(createHash("sha256").update(await readFile(downloaded.path)).digest("hex")).toBe(sha256);
  }, 30_000);
});
