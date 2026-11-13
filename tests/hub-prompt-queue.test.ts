import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY, PROMPT_QUEUE_ENGINES, promptQueueSnapshotSchema, type PromptQueueAction, type PromptQueueMutation, type PromptQueueSnapshot } from "../src/client-protocol/prompt-queue.js";
import { nodeFrameReader } from "../src/client-protocol/fragments-node.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
// Cold runtime transformation is suite setup, not time spent handling /stop.
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { JsonStore } from "../src/state/json-store.js";
import type { Message } from "../src/client-protocol/index.js";
import type { CodexThreadGoal } from "../src/codex/adapter.js";

class Peer {
  frames: any[] = []; messages: Message[] = [];
  private reader = nodeFrameReader();
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const frame = this.reader.read(raw.toString()); if (frame) { this.frames.push(frame); if ((frame as any).type === "instance.message") this.messages.push((frame as any).message); } }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((resolve, reject) => { peer.ws.once("open", resolve); peer.ws.once("error", reject); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string) { return until(() => { const index = this.frames.findIndex(frame => frame.type === type); return index < 0 ? undefined : this.frames.splice(index, 1)[0]; }); }
}
async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) { const result = await read(); if (result !== undefined) return result; if (Date.now() > deadline) throw new Error("condition_not_met"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
describe("durable host prompt queue", () => {
  let directory: string, hub: HubServer, chatId: string, token: string;
  const channels: GatewayChannel[] = [];
  const sockets: WebSocket[] = [], secret = "queue-test-credential-" + "q".repeat(32);
  const key = generateKeyPairSync("ed25519");
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-prompt-queue-"));
    hub = await HubServer.start({ stateDir: directory });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Queue Bot',?,'codex')", [hashSecret(secret)]);
    chatId = (await hub.store.createConversation("owner", ["bot"], "Queue", "create_queue")).id;
    token = await client();
  });
  afterEach(async () => { vi.restoreAllMocks(); for (const channel of channels.splice(0)) await channel.disconnect(); for (const ws of sockets.splice(0)) ws.terminate(); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  async function client(id = "device") {
    const pair = await hub.auth.pair({ deviceId: id, name: "Queue device", platform: "web", publicKey: key.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "127.0.0.1");
    await hub.auth.approve(pair.code, "local-owner");
    const peer = await Peer.connect(`${hub.url.replace(/^http/, "ws")}/ws`); sockets.push(peer.ws);
    const nonce = randomBytes(32).toString("base64url");
    peer.send({ type: "hello", deviceId: id, nonce, protocolVersions: [1], capabilities: ["cards.v1", PROMPT_QUEUE_CAPABILITY], cursors: {} });
    const challenge = await peer.next("challenge");
    peer.send({ type: "auth", signature: sign(null, deviceProof(id, challenge.nonce, nonce), key.privateKey).toString("base64") });
    const ready = await peer.next("ready"); await peer.next("sync.complete");
    expect(ready.serverCapabilities).toContain(PROMPT_QUEUE_CAPABILITY);
    return ready.sessionToken as string;
  }
  async function worker(capabilities = [PROMPT_QUEUE_CAPABILITY], engine = "codex", botId = "bot") {
    const peer = await Peer.connect(`${hub.instanceUrl.replace(/^http/, "ws")}/instance`); sockets.push(peer.ws);
    peer.send({ type: "instance.hello", botId, secret, engine, model: "", effort: "", capabilities });
    await peer.next("instance.ready"); return peer;
  }
  async function send(text: string, options: { attachments?: string[]; replyTo?: string } = {}) {
    return (await hub.store.sendMessage("owner", { conversationId: chatId, clientMsgId: `input_${randomBytes(8).toString("hex")}`, text, attachments: options.attachments ?? [], ...(options.replyTo ? { replyTo: options.replyTo } : {}) })).message;
  }
  const headers = () => ({ Authorization: `Bearer ${token}` });
  const url = () => `${hub.url}/api/conversations/${chatId}/queue`;
  async function read() { const res = await fetch(`${url()}?botId=bot`, { headers: headers() }); expect(res.status).toBe(200); return promptQueueSnapshotSchema.parse(await res.json()); }
  const post = (input: PromptQueueMutation, bearer = token) => fetch(url(), { method: "POST", headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(input) });
  const mutation = (snapshot: PromptQueueSnapshot, action: PromptQueueAction): PromptQueueMutation => ({ botId: "bot", requestId: `change_${randomBytes(8).toString("hex")}`, revision: snapshot.revision, action });
  async function change(action: PromptQueueAction) { const res = await post(mutation(await read(), action)); expect(res.status).toBe(200); return promptQueueSnapshotSchema.parse(await res.json()); }
  async function ack(peer: Peer, messageId: string, fail = false) { peer.send({ type: "instance.request", id: `ack_${randomBytes(8).toString("hex")}`, method: fail ? "delivery.fail" : "ack", params: { messageId, ...(fail ? { reason: "failed" } : {}) } }); await peer.next("instance.result"); }
  async function waitItems(count: number) { return until(async () => { const snapshot = await read(); return snapshot.items.length === count ? snapshot : undefined; }); }
  async function waitSent(peer: Peer, count: number) { return until(() => peer.messages.length >= count ? peer.messages : undefined); }

  it("keeps personal deletion separate from cancellation without exposing hidden queue text", async () => {
    const peer = await worker(); const active = await send("Running"); await waitSent(peer, 1);
    const hidden = await send("Private deleted input"), before = await read();
    await hub.store.deleteMessages("owner", chatId, { messageIds: [hidden.id] });
    const after = await read(), item = after.items.find(item => item.message.id === hidden.id)!;
    expect(item).toMatchObject({ message: { status: "deleted", blocks: [] }, canEdit: false, canCancel: true });
    expect(JSON.stringify(after)).not.toContain("Private deleted input");
    expect(after.revision).not.toBe(before.revision);
    await ack(peer, active.id); await waitSent(peer, 2);
    expect(peer.messages[1]!.blocks).toEqual(hidden.blocks);
  });

  it("pulls only the latest editable head and recovers a lost claim without unlocking or claiming a second input", async () => {
    const peer = await worker([PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY]);
    const a = await send("First"), b = await send("Second");
    await peer.next("instance.queue");
    expect(peer.messages).toEqual([]);
    expect((await read()).items.every(item => item.state === "queued" && item.canMove && item.canEdit)).toBe(true);
    await change({ type: "move", messageId: b.id, beforeId: a.id });
    await change({ type: "edit", messageId: b.id, text: "Revised head" });
    const take = async (p: Peer, conversationId = chatId) => { p.send({ type: "instance.request", id: `pull_${randomBytes(8).toString("hex")}`, method: "queue.take", params: { conversationId } }); return p.next("instance.result"); };
    const claimed = await take(peer);
    expect(claimed.result.message).toMatchObject({ id: b.id, blocks: [{ type: "text", text: "Revised head" }] });
    expect((await take(peer)).result).toBeNull();
    expect((await read()).items[0]).toMatchObject({ state: "dispatched", canEdit: false });
    peer.ws.terminate();
    const replacement = await worker([PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY]);
    await waitSent(replacement, 1);
    expect(replacement.messages.map(m => m.id)).toEqual([b.id]);
    await ack(replacement, b.id);
    await change({ type: "cancel", messageId: a.id });
    expect((await take(replacement)).result).toBeNull();
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('foreign','Foreign','fixture')");
    const other = await hub.store.createConversation("owner", ["foreign"], "Foreign conversation", "foreign_pull");
    expect((await take(replacement, other.id)).error).toBe("bot_forbidden");
  });

  it("dispatches exactly one, edits and reorders authoritative pending inputs, keeps files/replies, and never executes a cancelled prompt", async () => {
    const peer = await worker(); const a = await send("First"); await waitSent(peer, 1);
    await hub.store.db.run("INSERT INTO attachments VALUES('attachment',?,'owner',?,3,'application/pdf','file.pdf','attachment.blob',1,?)", [chatId, "a".repeat(64), Date.now()]);
    const b = await send("Cancel me"), c = await send("Old https://example.org/old", { attachments: ["attachment"], replyTo: a.id });
    let snapshot = await waitItems(3);
    expect(peer.messages.map(m => m.id)).toEqual([a.id]);
    expect(snapshot.items.map(item => item.state)).toEqual(["dispatched", "queued", "queued"]);
    expect(snapshot.items[0]).toMatchObject({ canEdit: false, canMove: false, canCancel: false });
    snapshot = await change({ type: "move", messageId: c.id, beforeId: b.id });
    expect(snapshot.items.map(item => item.message.id)).toEqual([a.id, c.id, b.id]);
    await change({ type: "edit", messageId: c.id, text: "Use this updated PDF" });
    await change({ type: "cancel", messageId: b.id });
    const cancelled = await hub.store.messageForUser("owner", b.id);
    expect(cancelled.blocks[0]).toEqual({ type: "text", text: "Cancel me" });
    expect(cancelled.blocks[1]).toMatchObject({ type: "card", extra: { promptQueue: { state: "cancelled" } } });
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [b.id])).toEqual({ status: "cancelled" });
    expect(await hub.store.db.get("SELECT body FROM messages_fts WHERE message_id=?", [c.id])).toMatchObject({ body: expect.stringContaining("Use this updated PDF") });
    await ack(peer, a.id); await waitSent(peer, 2);
    expect(peer.messages.map(m => m.id)).toEqual([a.id, c.id]);
    expect(peer.messages[1]).toMatchObject({ replyTo: a.id, createdAt: c.createdAt, version: 2, blocks: [{ type: "text", text: "Use this updated PDF" }, { type: "file", attachmentId: "attachment", name: "file.pdf" }] });
    expect(peer.messages[1]!.previewUrl).toBeUndefined();
    await ack(peer, c.id); expect((await read()).items).toEqual([]);
    expect(peer.messages).toHaveLength(2);
  });

  it("shares pause across authenticated devices, skips it on worker pull and resumes without interrupting current input", async () => {
    const peer = await worker([PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY]);
    const a = await send("Hold me"), b = await send("Run next"), initial = await read();
    const otherToken = await client("pause_phone");
    expect((await post(mutation(initial, { type: "pause", messageId: a.id }), otherToken)).status).toBe(200);
    expect((await read()).items[0]).toMatchObject({ paused: true, canResume: true, canPause: false });
    const take = async () => { peer.send({ type: "instance.request", id: `pull_${randomBytes(8).toString("hex")}`, method: "queue.take", params: { conversationId: chatId } }); return peer.next("instance.result"); };
    expect((await take()).result.message.id).toBe(b.id);
    const latePause = await post(mutation(await read(), { type: "pause", messageId: b.id }));
    expect(latePause.status).toBe(409); expect(await latePause.json()).toEqual({ error: "queue_already_dispatched" });
    const beforeResume = await read();
    expect((await post(mutation(beforeResume, { type: "resume", messageId: a.id }), otherToken)).status).toBe(200);
    expect((await take()).result).toBeNull();
    await ack(peer, b.id);
    expect((await take()).result.message.id).toBe(a.id);
    expect((await read()).items[0]).toMatchObject({ paused: false, state: "dispatched", canPause: false, canResume: false });
  });

  it("CASes changes across devices and resolves a lost mutation receipt idempotently without applying it twice", async () => {
    const peer = await worker(); await send("Running"); await waitSent(peer, 1);
    const b = await send("Second"), c = await send("Third"); const snapshot = await waitItems(3);
    const otherToken = await client("second_device");
    const edit = mutation(snapshot, { type: "edit", messageId: b.id, text: "Changed" });
    expect((await post(edit)).status).toBe(200);
    const stale = await post(mutation(snapshot, { type: "move", messageId: c.id, beforeId: b.id }), otherToken);
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "queue_changed" });
    const replay = await post(edit, otherToken); expect(replay.status).toBe(200);
    expect((await hub.store.messageForUser("owner", b.id)).version).toBe(2);
    expect((await post({ ...edit, action: { type: "cancel", messageId: b.id } })).status).toBe(409);
  });

  it("never revives a rejected request when another device restores the old queue order", async () => {
    await new HubPromptQueue(hub.store).registerWorker("bot", true);
    const a = await send("First"), b = await send("Second");
    const before = await read(), delayed = mutation(before, { type: "cancel", messageId: a.id });
    await change({ type: "move", messageId: b.id, beforeId: a.id });
    const rejected = await post(delayed);
    expect(rejected.status).toBe(409); expect(await rejected.json()).toEqual({ error: "queue_changed" });
    await change({ type: "move", messageId: a.id, beforeId: b.id });
    expect((await read()).items.map(item => item.message.id)).toEqual([a.id, b.id]);
    // This can be the original request arriving after its retry was rejected.
    const late = await post(delayed);
    expect(late.status).toBe(409); expect(await late.json()).toEqual({ error: "queue_changed" });
    expect((await read()).items.map(item => item.message.id)).toEqual([a.id, b.id]);
    for (const ws of sockets.splice(0)) ws.terminate(); await hub.close();
    hub = await HubServer.start({ stateDir: directory }); token = await client("after_rejection_restart");
    const afterRestart = await post(delayed);
    expect(afterRestart.status).toBe(409); expect(await afterRestart.json()).toEqual({ error: "queue_changed" });
    const changedBody = await post({ ...delayed, action: { type: "cancel", messageId: b.id } });
    expect(changedBody.status).toBe(409); expect(await changedBody.json()).toEqual({ error: "idempotency_conflict" });
    expect((await read()).items.map(item => item.message.id)).toEqual([a.id, b.id]);
  });

  it("atomically fences dispatch racing an edit and refuses to make an in-flight input editable", async () => {
    await new HubPromptQueue(hub.store).registerWorker("bot", true);
    const a = await send("Not delivered yet"); const before = await waitItems(1);
    const peer = await worker(); await waitSent(peer, 1);
    const stale = await post(mutation(before, { type: "edit", messageId: a.id, text: "Too late" }));
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "queue_already_dispatched" });
    const now = await read();
    expect(now.items[0]).toMatchObject({ state: "dispatched", canCancel: false, canEdit: false, canMove: false });
    const late = await post(mutation(now, { type: "cancel", messageId: a.id })); expect(await late.json()).toEqual({ error: "queue_already_dispatched" });
    expect(peer.messages[0]!.blocks).toEqual([{ type: "text", text: "Not delivered yet" }]);
  });

  it("persists order/text/cancellation over Hub restart, replays only fenced delivery and advances after failure", async () => {
    const first = await worker(), a = await send("Active"); await waitSent(first, 1);
    const b = await send("Second"), c = await send("Third"), d = await send("Cancel"); await waitItems(4);
    await change({ type: "move", messageId: c.id, beforeId: b.id });
    await change({ type: "edit", messageId: c.id, text: "Edited before restart" });
    await change({ type: "cancel", messageId: d.id });
    for (const ws of sockets.splice(0)) ws.terminate(); await hub.close();
    hub = await HubServer.start({ stateDir: directory }); token = await client("after_restart");
    const offline = await read(); expect(offline.supported).toBe(true);
    expect(offline.items.map(item => [item.message.id, item.state])).toEqual([[a.id, "dispatched"], [c.id, "queued"], [b.id, "queued"]]);
    const resumed = await worker(); await waitSent(resumed, 1); expect(resumed.messages.map(m => m.id)).toEqual([a.id]);
    await ack(resumed, a.id, true); await waitSent(resumed, 2);
    expect(resumed.messages[1]).toMatchObject({ id: c.id, blocks: [{ type: "text", text: "Edited before restart" }] });
    await ack(resumed, c.id); await waitSent(resumed, 3); expect(resumed.messages[2]!.id).toBe(b.id);
    await ack(resumed, b.id); expect((await read()).items).toEqual([]);
  });

  it("keeps unsupported workers and engines on legacy delivery and denies their queue mutations", async () => {
    const old = await worker([]); const a = await send("Old one"), b = await send("Old two"); await waitSent(old, 2);
    const snapshot = await read(); expect(snapshot).toMatchObject({ supported: false, reason: "worker_update_required" });
    expect(snapshot.items.every(item => !item.canEdit && item.state === "dispatched")).toBe(true);
    expect((await post(mutation(snapshot, { type: "cancel", messageId: b.id }))).status).toBe(409);
    const unsupported = await worker([PROMPT_QUEUE_CAPABILITY], "other_engine"); await waitSent(unsupported, 2);
    expect((await read()).reason).toBe("unsupported_engine");
    expect(unsupported.messages.map(m => m.id)).toEqual([a.id, b.id]);
  });

  it("keeps slash controls ahead of later ordinary work and never permits edits to become slash or addressed controls", async () => {
    const peer = await worker(), a = await send("Running"); await waitSent(peer, 1);
    const b = await send("Before control"); await waitItems(2);
    for (const text of ["/stop", "/stop@QueueBot", " /new@bot "]) {
      const response = await post(mutation(await read(), { type: "edit", messageId: b.id, text }));
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "queue_command_edit_forbidden" });
    }
    const control = await send("/stop@QueueBot"), later = await send("After control");
    await waitSent(peer, 3); expect(peer.messages.map(m => m.id)).toEqual([a.id, b.id, control.id]);
    await ack(peer, control.id); expect(peer.messages).toHaveLength(3);
    await ack(peer, a.id); expect(peer.messages).toHaveLength(3);
    await ack(peer, b.id); await waitSent(peer, 4); expect(peer.messages[3]!.id).toBe(later.id);
  });

  it("a slash stop interrupts the real handler while every flushed prompt settles once and the queue advances", async () => {
    const stateDir = path.join(directory, "slash-stop-worker");
    await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
    const seen: string[] = []; let interrupted = false, release = () => {};
    const gateway = await attachGateway({ stateDir, url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "claude", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => {
        seen.push(input.text);
        if (seen.length === 1) await new Promise<void>(resolve => { release = resolve; input.abortSignal?.addEventListener("abort", () => { interrupted = true; resolve(); }, { once: true }); });
        return { text: "Complete" };
      },
    } });
    try {
      await until(async () => (await read()).supported || undefined);
      const a = await send("Active before slash stop"); await until(() => seen.length === 1 || undefined);
      const b = await send("Queued second"), c = await send("Queued third"); await waitItems(3);
      const stop = await send("/stop");
      await until(() => interrupted || undefined);
      await until(async () => !(await read()).items.length || undefined);
      const d = await send("After slash stop");
      await until(async () => !(await read()).items.length || undefined);
      expect(seen).toEqual(["Active before slash stop", "Queued second", "Queued third", "After slash stop"]);
      for (const message of [a, b, c, stop, d]) expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [message.id])).toEqual({ status: "accepted" });
    } finally { release(); await gateway.disconnect(); }
  });

  it("routes Codex goal controls around a running ordinary turn and settles their durable deliveries once", async () => {
    const stateDir = path.join(directory, "goal-control-worker");
    await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    const seen: string[] = [], mutations: Array<Partial<CodexThreadGoal>> = [];
    let interrupted = false, release = () => {}, goal: CodexThreadGoal | null = null;
    const gateway = await attachGateway({ stateDir, url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => {
        seen.push(input.text);
        if (seen.length === 1) await new Promise<void>(resolve => { release = resolve; input.abortSignal?.addEventListener("abort", () => { interrupted = true; resolve(); }, { once: true }); });
        return { text: "Complete" };
      },
      getThreadGoal: async () => ({ goal }),
      updateThreadGoal: async input => {
        mutations.push({ ...(input.status ? { status: input.status } : {}), ...(input.objective ? { objective: input.objective } : {}) });
        if (goal) goal = { ...goal, ...(input.status ? { status: input.status } : {}), ...(input.objective ? { objective: input.objective } : {}) };
        return { goal };
      },
      clearThreadGoal: async () => { const cleared = goal !== null; goal = null; return { cleared }; },
    } });
    try {
      await until(async () => (await read()).supported || undefined);
      const active = await send("Ordinary turn remains running"); await until(() => seen.length === 1 || undefined);
      goal = { threadId: "goal-native-fixture", objective: "Existing goal", status: "active", tokenBudget: 1000, tokensUsed: 50, timeUsedSeconds: 1, createdAt: 1, updatedAt: 1 };
      const queued = await send("Keep queued ordinary order"); await waitItems(2);
      const controls: Message[] = [];
      for (const text of ["/goal pause", "/goal status", "/goal edit Updated objective", "/goal clear"]) {
        const control = await send(text); controls.push(control);
        await until(async () => (await hub.store.db.get<{ status: string }>("SELECT status FROM deliveries WHERE message_id=?", [control.id]))?.status === "accepted" || undefined);
        expect(interrupted).toBe(false); expect(seen).toEqual(["Ordinary turn remains running"]);
      }
      expect(mutations).toEqual([{ status: "paused" }, { objective: "Updated objective" }]);
      expect(goal).toBeNull();
      release();
      await until(async () => !(await read()).items.length || undefined);
      expect(seen).toEqual(["Ordinary turn remains running", "Keep queued ordinary order"]);
      for (const message of [active, queued, ...controls]) {
        expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [message.id])).toEqual({ status: "accepted" });
      }
    } finally { release(); await gateway.disconnect(); }
  });

  it("forbids crossing queued command barriers and permits empty edit only when an attachment remains", async () => {
    await new HubPromptQueue(hub.store).registerWorker("bot", true);
    const a = await send("Before"), control = await send("/new"), c = await send("After"); await waitItems(3);
    const crossed = await post(mutation(await read(), { type: "move", messageId: c.id, beforeId: a.id }));
    expect(await crossed.json()).toEqual({ error: "queue_control_barrier" });
    expect((await read()).items.find(item => item.message.id === control.id)).toMatchObject({ canEdit: false, canCancel: false, canMove: false });
    expect((await post(mutation(await read(), { type: "edit", messageId: a.id, text: "  " }))).status).toBe(400);
    await hub.store.db.run("INSERT INTO attachments VALUES('only_file',?,'owner',?,3,'application/pdf','file.pdf','file.blob',1,?)", [chatId, "a".repeat(64), Date.now()]);
    const file = await send("Description", { attachments: ["only_file"] });
    await change({ type: "edit", messageId: file.id, text: "" });
    expect((await hub.store.messageForUser("owner", file.id)).blocks).toEqual([expect.objectContaining({ type: "file", attachmentId: "only_file" })]);
  });

  it.each(["cancel", "pause", "resume"] as const)("checks authentication, membership and in-transaction revocation before %s", async type => {
    await new HubPromptQueue(hub.store).registerWorker("bot", true); const a = await send("Private queued input");
    expect((await fetch(`${url()}?botId=bot`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/conversations/other/queue?botId=bot`, { headers: headers() })).status).toBe(403);
    const input = mutation(await read(), { type, messageId: a.id });
    const session = await hub.auth.authorize(token, "127.0.0.1");
    await hub.auth.revoke("device", "local-owner");
    await expect(new HubPromptQueue(hub.store).mutate("owner", chatId, input, () => hub.auth.validateSessionInTransaction(session))).rejects.toThrow("device_revoked");
    expect((await post(input)).status).toBe(401);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [a.id])).toEqual({ status: "pending" });
  });

  it("does not expose queue editing for groups or multi-recipient inputs", async () => {
    await worker(); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Other',?,'codex')", [hashSecret(secret)]);
    const group = await hub.store.createConversation("owner", ["bot", "other"], "Group", "group_queue", { type: "group" });
    chatId = group.id; await send("Two recipients");
    const snapshot = await read(); expect(snapshot).toMatchObject({ supported: false, reason: "group_unsupported" });
    expect(snapshot.items.every(item => !item.canEdit && !item.canMove && !item.canCancel)).toBe(true);
  });

  it.each(PROMPT_QUEUE_ENGINES)("%s Gateway receives only dispatched text and replay never runs an active input twice", async engine => {
    const instance = path.join(directory, "worker"), transport = new GatewayTransport({ stateDir: instance, url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine });
    const channel = new GatewayChannel(transport); channels.push(channel);
    const seen: { id: string; text: string }[] = [];
    let release!: () => void; const running = new Promise<void>(resolve => { release = resolve; });
    channel.on("error", () => undefined);
    channel.on("message", async message => { seen.push({ id: message.messageId, text: message.content }); if (seen.length === 1) await running; });
    await channel.connect();
    try {
      await until(async () => (await read()).supported || undefined);
      const a = await send("Native first"); await until(() => seen.length === 1 || undefined);
      const b = await send("Never reach CLI"), c = await send("Queued original"); await waitItems(3);
      const receipt = path.join(instance, "gateway-receipts", createHash("sha256").update(`message:${c.id}`).digest("hex") + ".json");
      await expect(readFile(receipt, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(seen).toEqual([{ id: a.id, text: "Native first" }]);
      await change({ type: "move", messageId: c.id, beforeId: b.id });
      await change({ type: "edit", messageId: c.id, text: "Actual reordered text" });
      await change({ type: "cancel", messageId: b.id });
      // Replaying the same fenced input while it is active is an at-most-once operation.
      await transport.onMessage!(a, await hub.store.conversationForBot("bot", chatId));
      expect(seen).toHaveLength(1);
      release(); await until(() => seen.length === 2 || undefined);
      await until(async () => !(await read()).items.length || undefined);
      expect(seen).toEqual([{ id: a.id, text: "Native first" }, { id: c.id, text: "Actual reordered text" }]);
      expect(await readFile(receipt, "utf8")).toContain('"complete"');
    } finally { release(); }
  });

  it("recovers a restarted Gateway's fenced running receipt without executing it again, then starts the next queued input", async () => {
    await new HubPromptQueue(hub.store).registerWorker("bot", true);
    const a = await send("Previously running"), b = await send("Run after recovery");
    await new HubPromptQueue(hub.store).claim("bot", true, false);
    const instance = path.join(directory, "restarted-worker");
    await mkdir(path.join(instance, "gateway-receipts"), { recursive: true });
    await writeFile(path.join(instance, "gateway-receipts", createHash("sha256").update(`message:${a.id}`).digest("hex") + ".json"), JSON.stringify({ state: "running" }));
    const channel = new GatewayChannel(new GatewayTransport({ stateDir: instance, url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "claude" }));
    channels.push(channel); const seen: string[] = [];
    channel.on("error", () => undefined); channel.on("message", async message => { seen.push(message.messageId); });
    await channel.connect(); await until(async () => !(await read()).items.length || undefined);
    expect(seen).toEqual([b.id]);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [a.id])).toEqual({ status: "failed" });
  });

  it("a replacement handshake cannot be overwritten by an older capability registration stalled before SQLite", async () => {
    const original = HubPromptQueue.prototype.registerWorker;
    let entered!: () => void, release!: () => void;
    const registering = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const registration = vi.spyOn(HubPromptQueue.prototype, "registerWorker").mockImplementationOnce(async function (this: HubPromptQueue, ...args) { entered(); await held; return original.apply(this, args); });
    const stale = await Peer.connect(`${hub.instanceUrl.replace(/^http/, "ws")}/instance`); sockets.push(stale.ws);
    const closed = new Promise<void>(resolve => stale.ws.once("close", () => resolve()));
    stale.send({ type: "instance.hello", botId: "bot", secret, engine: "codex", model: "old", effort: "", capabilities: [PROMPT_QUEUE_CAPABILITY] });
    try {
      await registering;
      const replacement = await worker([], "claude"); await closed;
      release(); await registration.mock.results[0]!.value;
      const a = await send("Only the replacement receives this"); await waitSent(replacement, 1);
      expect(replacement.messages[0]!.id).toBe(a.id);
      expect(stale.messages).toEqual([]); expect(stale.frames.some(frame => frame.type === "instance.ready")).toBe(false);
      expect(await hub.store.db.get("SELECT engine,online FROM bots WHERE id='bot'")).toEqual({ engine: "claude", online: 1 });
      expect((await read()).reason).toBe("worker_update_required");
    } finally { release(); registration.mockRestore(); }
  });

  it("retains the delivery fence if draining begins after claim and replays it after drain cancellation", async () => {
    const peer = await worker();
    const original = HubPromptQueue.prototype.claim;
    let claimed!: () => void, release!: () => void;
    const fenced = new Promise<void>(resolve => { claimed = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const claim = vi.spyOn(HubPromptQueue.prototype, "claim").mockImplementation(async function (this: HubPromptQueue, ...args) { const messages = await original.apply(this, args); if (messages.length) { claimed(); await held; } return messages; });
    const a = await send("Drain at fence");
    try {
      await fenced;
      const drain = vi.spyOn(hub, "hostDrainStatus").mockReturnValue({ draining: true, drained: false });
      release(); await Promise.all([...(hub as unknown as { dispatchTails: Map<string, Promise<void>> }).dispatchTails.values()]);
      expect(peer.messages).toEqual([]);
      expect((await read()).items[0]).toMatchObject({ state: "dispatched", canEdit: false });
      drain.mockRestore(); claim.mockRestore();
      await hub.cancelHostDrain(); await waitSent(peer, 1); expect(peer.messages.map(m => m.id)).toEqual([a.id]);
      await ack(peer, a.id); expect((await read()).items).toEqual([]);
    } finally { release(); claim.mockRestore(); }
  });

  it("continues serialized dispatch after a claim failure by reattaching without skipping the waiting input", async () => {
    const peer = await worker(), original = HubPromptQueue.prototype.claim;
    const closed = new Promise<void>(resolve => peer.ws.once("close", () => resolve()));
    let failed = false;
    const claim = vi.spyOn(HubPromptQueue.prototype, "claim").mockImplementation(async function (this: HubPromptQueue, ...args) {
      if (!failed && (await hub.store.pendingForBot("bot")).length) { failed = true; throw new Error("isolated_claim_fault"); }
      return original.apply(this, args);
    });
    const a = await send("First survives fault"); await closed;
    expect((await read()).items[0]).toMatchObject({ state: "queued" });
    const replacement = await worker(); await waitSent(replacement, 1);
    const b = await send("Next arrival");
    expect(replacement.messages.map(m => m.id)).toEqual([a.id]);
    await ack(replacement, a.id); await waitSent(replacement, 2); expect(replacement.messages.map(m => m.id)).toEqual([a.id, b.id]);
    claim.mockRestore();
  });

  it.each(["metadata", "send"])("recovers a post-claim %s failure by replacing the socket and replaying the durable fence", async stage => {
    const peer = await worker();
    const closed = new Promise<void>(resolve => peer.ws.once("close", () => resolve()));
    const sender = hub as unknown as { send(ws: WebSocket, value: any): Promise<void> }, original = sender.send;
    let failed = false;
    const metadata = stage === "metadata" ? vi.spyOn(hub.store, "conversationForBot").mockRejectedValueOnce(new Error("isolated_metadata_fault")) : undefined;
    const sendFault = stage === "send" ? vi.spyOn(sender, "send").mockImplementation(function (this: HubServer, ws, value) {
      if (value?.type === "instance.message" && !failed) { failed = true; return Promise.reject(new Error("isolated_send_fault")); }
      return original.call(this, ws, value);
    }) : undefined;
    try {
      const a = await send("Recover after fenced failure"); await closed;
      expect(peer.messages).toEqual([]);
      expect((await read()).items[0]).toMatchObject({ state: "dispatched", canEdit: false });
      metadata?.mockRestore(); sendFault?.mockRestore();
      const replacement = await worker(); await waitSent(replacement, 1);
      expect(replacement.messages.map(message => message.id)).toEqual([a.id]);
      await ack(replacement, a.id); expect((await read()).items).toEqual([]);
    } finally { metadata?.mockRestore(); sendFault?.mockRestore(); }
  });

  it("shutdown waits for an accepted claim then a fresh Hub replays that fenced input", async () => {
    const peer = await worker(), original = HubPromptQueue.prototype.claim;
    let claimed!: () => void, release!: () => void;
    const fenced = new Promise<void>(resolve => { claimed = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const claim = vi.spyOn(HubPromptQueue.prototype, "claim").mockImplementation(async function (this: HubPromptQueue, ...args) { const messages = await original.apply(this, args); if (messages.length) { claimed(); await held; } return messages; });
    const a = await send("Close at fence");
    try {
      await fenced; const closing = hub.close(); release(); await closing;
      expect(peer.messages).toEqual([]); claim.mockRestore();
      hub = await HubServer.start({ stateDir: directory }); token = await client("reopened");
      expect((await read()).items[0]).toMatchObject({ state: "dispatched", canEdit: false });
      const replacement = await worker(); await waitSent(replacement, 1); expect(replacement.messages.map(m => m.id)).toEqual([a.id]);
    } finally { release(); claim.mockRestore(); }
  });

  it("treats absolute paths as editable prompts without flushing the command barrier", async () => {
    const peer = await worker(), a = await send("Running"); await waitSent(peer, 1);
    const b = await send("/Users/example/work.ts"), c = await send("/tmp/log read this");
    expect((await waitItems(3)).items.slice(1).every(item => item.canEdit && item.state === "queued")).toBe(true);
    await change({ type: "edit", messageId: b.id, text: "/tmp/updated.log" });
    await change({ type: "move", messageId: c.id, beforeId: b.id });
    expect(peer.messages.map(m => m.id)).toEqual([a.id]);
    await ack(peer, a.id); await waitSent(peer, 2); expect(peer.messages[1]!.id).toBe(c.id);
    await ack(peer, c.id); await waitSent(peer, 3); expect(peer.messages[2]!.blocks).toEqual([{ type: "text", text: "/tmp/updated.log" }]);
  });

  it("cancels undispatched tombstones atomically and refuses deletion after the dispatch fence", async () => {
    const peer = await worker(), a = await send("Active"); await waitSent(peer, 1);
    const b = await send("Recalled while queued"), c = await send("Next"), stale = await send("Legacy tombstone");
    await waitItems(4);
    await expect(hub.store.db.transaction(() => hub.store.updateQueuedMessageInTransaction({ ...a, status: "deleted", blocks: [], version: 2 }))).rejects.toMatchObject({ code: "queue_already_dispatched" });
    expect((await hub.store.messageForUser("owner", a.id)).status).toBe("complete");
    await hub.store.db.transaction(() => hub.store.updateQueuedMessageInTransaction({ ...b, status: "deleted", blocks: [], version: 2 }));
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [b.id])).toEqual({ status: "cancelled" });
    // Simulate a tombstone written by an older writer which did not settle delivery.
    await hub.store.db.run("UPDATE messages SET status='deleted' WHERE id=?", [stale.id]);
    expect((await read()).items.map(item => item.message.id)).toEqual([a.id, c.id]);
    await ack(peer, a.id); await waitSent(peer, 2); await ack(peer, c.id);
    expect(peer.messages.map(m => m.id)).toEqual([a.id, c.id]);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [stale.id])).toEqual({ status: "cancelled" });
  });

  it("checks legacy tombstones by pending message id without scanning historical bodies", async () => {
    const queued = await send("Legacy deleted"), live = await send("Keep waiting"), dispatched = await send("Already dispatched"), accepted = await send("Already accepted"), hidden = await send("Personally hidden");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('other','Other','fixture')");
    const other = await hub.store.createConversation("owner", ["other"], "Other", "other_tombstone");
    const foreign = (await hub.store.sendMessage("owner", { conversationId: other.id, clientMsgId: "foreign_deleted", text: "Other Bot", attachments: [] })).message;
    await hub.store.db.run(`WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM history WHERE n<2000)
      INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at)
      SELECT 'claim_history_'||n,?,'bot','bot','[]',CASE WHEN n%10=0 THEN 'deleted' ELSE 'complete' END,1,n FROM history`, [chatId]);
    for (const id of [queued.id, dispatched.id, accepted.id, foreign.id]) await hub.store.db.run("UPDATE messages SET status='deleted' WHERE id=?", [id]);
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [dispatched.id]);
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [accepted.id]);
    await hub.store.deleteMessages("owner", chatId, { messageIds: [hidden.id] });

    const calls = vi.spyOn(hub.store.db, "run"), pull = { ready: new Set<string>() };
    try {
      expect(await new HubPromptQueue(hub.store).claim("bot", true, false, () => true, true, true, true, pull)).toEqual([]);
      expect(pull.ready.has(chatId)).toBe(true);
      const rows = await hub.store.db.all<{ message_id: string; status: string; dispatched: number }>("SELECT message_id,status,dispatched FROM deliveries");
      const states = Object.fromEntries(rows.map(row => [row.message_id, { status: row.status, dispatched: row.dispatched }]));
      expect(states).toMatchObject({
        [queued.id]: { status: "cancelled", dispatched: 0 },
        [live.id]: { status: "pending", dispatched: 0 },
        [hidden.id]: { status: "pending", dispatched: 0 },
        [dispatched.id]: { status: "pending", dispatched: 1 },
        [accepted.id]: { status: "accepted", dispatched: 0 },
        [foreign.id]: { status: "pending", dispatched: 0 },
      });
      const [sql, params] = calls.mock.calls.find(([sql]) => sql.startsWith("UPDATE deliveries SET status='cancelled'") && sql.includes("status='deleted'"))!;
      const plan = await hub.store.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      expect(plan.some(row => /SCAN (?:messages|m)\b/.test(row.detail))).toBe(false);
      expect(plan.some(row => /SEARCH (?:messages|m) USING INDEX sqlite_autoindex_messages_1/.test(row.detail))).toBe(true);
    } finally { calls.mockRestore(); }
  });

  it("forwards cancelled prompt content without the source delivery's cancelled receipt", async () => {
    const peer = await worker(), a = await send("Active"); await waitSent(peer, 1);
    const b = await send("Forward this readable content"); await waitItems(2); await change({ type: "cancel", messageId: b.id });
    const target = await hub.store.createConversation("owner", ["bot"], "Forward target", "forward_target");
    const forwarded = await hub.store.forwardMessage("owner", { v: 1, type: "message.forward", conversationId: target.id, sourceMessageId: b.id, clientMsgId: "forward_cancelled", mentions: ["bot"] }, async () => undefined);
    await waitSent(peer, 2);
    expect(forwarded.message.blocks).toEqual([{ type: "text", text: "Forward this readable content" }]);
    expect(peer.messages[1]!.blocks).toEqual(forwarded.message.blocks);
    await ack(peer, forwarded.message.id);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [forwarded.message.id])).toEqual({ status: "accepted" });
    expect((await hub.store.messageForUser("owner", b.id)).blocks[1]).toMatchObject({ extra: { promptQueue: { state: "cancelled" } } });
    await ack(peer, a.id);
  });

  it("appends forwards behind existing inputs and preserves unique positions when moved in both directions", async () => {
    const peer = await worker(), a = await send("Running"); await waitSent(peer, 1);
    const b = await send("Second"), c = await send("Third");
    const forwarded = (await hub.store.forwardMessage("owner", { conversationId: chatId, sourceMessageId: b.id, clientMsgId: "forward_queue", mentions: ["bot"] }, async () => {})).message;
    const assertOrder = async (ids: string[]) => {
      expect((await read()).items.map(item => item.message.id)).toEqual(ids);
      expect(await hub.store.db.all("SELECT bot_id,queue_position,COUNT(*) AS count FROM deliveries WHERE status='pending' GROUP BY bot_id,queue_position HAVING COUNT(*)>1")).toEqual([]);
    };
    await assertOrder([a.id, b.id, c.id, forwarded.id]);
    await change({ type: "move", messageId: forwarded.id, beforeId: b.id });
    await assertOrder([a.id, forwarded.id, b.id, c.id]);
    await change({ type: "move", messageId: forwarded.id, beforeId: null });
    await assertOrder([a.id, b.id, c.id, forwarded.id]);
    await ack(peer, a.id); await waitSent(peer, 2);
    expect(peer.messages.map(message => message.id)).toEqual([a.id, b.id]);
    await assertOrder([b.id, c.id, forwarded.id]);
  });

  it("does not let a backpressured Bot socket block another Bot or the ack which advances its own queue", async () => {
    const peer = await worker();
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Other',?,'codex')", [hashSecret(secret)]);
    const other = await worker([PROMPT_QUEUE_CAPABILITY], "codex", "other");
    const otherChat = await hub.store.createConversation("owner", ["other"], "Independent", "independent");
    const sender = hub as unknown as { send(ws: WebSocket, value: any): Promise<void> }, original = sender.send;
    let blocked!: () => void, release!: () => void;
    let entered = new Promise<void>(resolve => { blocked = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(sender, "send").mockImplementation(async function (this: HubServer, ws, value) {
      if (value?.type === "instance.message" && value.message.conversationId === chatId) { blocked(); await held; }
      return original.call(this, ws, value);
    });
    try {
      const a = await send("Slow socket"); await entered;
      const b = (await hub.store.sendMessage("owner", { conversationId: otherChat.id, clientMsgId: "independent_input", text: "Other Bot still runs", attachments: [] })).message;
      await waitSent(other, 1); await ack(other, b.id);
      expect(peer.messages).toEqual([]); expect(other.messages[0]!.id).toBe(b.id);
      release(); await waitSent(peer, 1);
      entered = new Promise<void>(resolve => { blocked = resolve; }); held = new Promise<void>(resolve => { release = resolve; });
      const c = await send("Next slow write"); await waitItems(2);
      await ack(peer, a.id); // This receipt must not wait for c's socket write.
      await entered; expect(peer.messages.map(m => m.id)).toEqual([a.id]);
      release(); await waitSent(peer, 2); expect(peer.messages[1]!.id).toBe(c.id);
    } finally { release(); spy.mockRestore(); }
  });

  it("drains active Gateway work while leaving undispatched prompts durable for resume", async () => {
    const transport = new GatewayTransport({ stateDir: path.join(directory, "drain-worker"), url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex" });
    const channel = new GatewayChannel(transport); channels.push(channel); const seen: string[] = [];
    let release!: () => void; const running = new Promise<void>(resolve => { release = resolve; });
    channel.on("error", () => undefined); channel.on("message", async message => { seen.push(message.messageId); if (seen.length === 1) await running; });
    await channel.connect(); await until(async () => (await read()).supported || undefined);
    const a = await send("Active before drain"); await until(() => seen.length === 1 || undefined);
    const b = await send("Wait through drain"); await waitItems(2);
    const drain = vi.spyOn(hub, "hostDrainStatus").mockReturnValue({ draining: true, drained: false });
    try {
      release(); await until(() => !channel.isBusy() || undefined);
      expect((await read()).items.map(item => [item.message.id, item.state])).toEqual([[b.id, "queued"]]);
      expect(seen).toEqual([a.id]);
      drain.mockRestore(); await hub.cancelHostDrain();
      await until(async () => !(await read()).items.length || undefined); expect(seen).toEqual([a.id, b.id]);
    } finally { release(); drain.mockRestore(); }
  });

  it.each(["handler", "attachment", "rejected"])("settles %s outcomes and advances the next prompt", async mode => {
    const transport = new GatewayTransport({ stateDir: path.join(directory, "failure-worker"), url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex" });
    const channel = new GatewayChannel(transport); channels.push(channel); const seen: string[] = [];
    channel.on("error", () => undefined); channel.on("message", async message => {
      seen.push(message.messageId);
      if (seen.length === 1) {
        if (mode === "handler") throw new Error("handler_failed");
        if (mode === "attachment") await channel.downloadMessageResource(message.messageId, "missing_file");
        return; // A policy rejection returns without invoking an engine.
      }
    });
    await channel.connect(); await until(async () => (await read()).supported || undefined);
    if (mode === "attachment") await hub.store.db.run("INSERT INTO attachments VALUES('missing_file',?,'owner',?,3,'application/pdf','file.pdf','missing.blob',1,?)", [chatId, "a".repeat(64), Date.now()]);
    const a = await send("First outcome", { attachments: mode === "attachment" ? ["missing_file"] : [] }), b = await send("Next still runs");
    await until(async () => !(await read()).items.length || undefined);
    expect(seen).toEqual([a.id, b.id]);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [a.id])).toEqual({ status: mode === "rejected" ? "accepted" : "failed" });
  });

  it.each(["receipt", "ack-write", "ack-receipt"])("recovers a local %s persistence failure without executing the input twice or stranding the queue", async stage => {
    const instance = path.join(directory, "persistence-worker"), warnings: string[] = [];
    const transport = new GatewayTransport({ stateDir: instance, url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex", onWarning: code => warnings.push(code) });
    const channel = new GatewayChannel(transport); channels.push(channel); const seen: string[] = [];
    channel.on("error", () => undefined); channel.on("message", async message => { seen.push(message.messageId); });
    await channel.connect(); await until(async () => (await read()).supported || undefined);
    const original = JsonStore.prototype.write; let failed = false, sawAck = false;
    const write = vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (this: JsonStore<unknown>, value: any) {
      const file = (this as unknown as { filePath: string }).filePath;
      const receiptComplete = file.startsWith(path.join(instance, "gateway-receipts")) && value?.state === "complete";
      const outbox = file === path.join(instance, "gateway-outbox.json");
      if (outbox && value?.requests?.some((request: any) => request.method === "ack")) sawAck = true;
      const fault = stage === "receipt" ? receiptComplete : stage === "ack-write" ? outbox && value?.requests?.some((request: any) => request.method === "ack") : outbox && sawAck && value?.requests?.length === 0;
      if (!failed && fault) { failed = true; throw new Error("isolated_persistence_failure"); }
      return original.call(this, value);
    });
    try {
      const a = await send("Execute once across persistence failure"), b = await send("Next after recovery");
      await until(async () => !(await read()).items.length && !channel.isBusy() || undefined);
      expect(failed).toBe(true); expect(seen).toEqual([a.id, b.id]);
      expect(warnings.some(code => ["gateway_delivery_recovery", "gateway_receive_failed"].includes(code))).toBe(true);
      expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [a.id])).toEqual({ status: stage === "receipt" ? "failed" : "accepted" });
    } finally { write.mockRestore(); }
  });

  it("does not reconnect a Gateway during explicit shutdown while the active receipt is finishing", async () => {
    const warnings: string[] = [];
    const transport = new GatewayTransport({ stateDir: path.join(directory, "closing-worker"), url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex", onWarning: code => warnings.push(code) });
    const channel = new GatewayChannel(transport); channels.push(channel);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    channel.on("error", () => undefined); channel.on("message", async () => { started(); await held; });
    await channel.connect(); await until(async () => (await read()).supported || undefined);
    await send("Stop the host while finishing"); await entered;
    const disconnect = channel.disconnect(); release(); await disconnect;
    expect(warnings).not.toContain("gateway_delivery_recovery");
    expect((transport as unknown as { reconnect?: unknown }).reconnect).toBeUndefined();
  });

  it("real group updates reject removal with pending deliveries and the offline Bot can still attach and finish", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Other',?,'codex')", [hashSecret(secret)]);
    const group = await hub.store.createConversation("owner", ["bot", "other"], "Membership", "membership", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "Inherited topic", "membership_topic", { parentId: group.id });
    const pending = (await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "mention_offline", text: "Offline member task", attachments: [], mentions: ["bot"] })).message;
    const update = () => fetch(`${hub.url}/api/groups/${group.id}/settings`, { method: "PUT", headers: headers(), body: JSON.stringify({ title: "Membership", botIds: ["other"], expectedTitle: "Membership", expectedBotIds: ["bot", "other"] }) });
    const denied = await update(); expect(denied.status).toBe(409); expect(await denied.json()).toEqual({ error: "group_bot_busy" });
    expect((await hub.store.conversationForBot("bot", topic.id)).botIds).toContain("bot");
    const peer = await worker(); await waitSent(peer, 1); expect(peer.messages[0]!.id).toBe(pending.id);
    await ack(peer, pending.id); expect((await update()).status).toBe(200);
    await expect(hub.store.conversationForBot("bot", topic.id)).rejects.toMatchObject({ code: "bot_forbidden" });
    const next = await send("Other direct chat keeps working"); await waitSent(peer, 2); await ack(peer, next.id);
    expect(peer.ws.readyState).toBe(WebSocket.OPEN); expect(peer.messages.map(m => m.id)).toEqual([pending.id, next.id]);
  });

  it.each([false, true])("settles stale removed-member delivery (already dispatched=%s) without reconnecting or blocking a valid chat", async dispatched => {
    const group = await hub.store.createConversation("owner", ["bot"], "Imported old group", "old_group", { type: "group" });
    const stale = (await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "orphan", text: "Must not execute after membership was removed", attachments: [], mentions: ["bot"] })).message;
    if (dispatched) await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [stale.id]);
    // This invalid state cannot be created through updateGroup's busy guard.
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [group.id]);
    const valid = await send("Still authorized direct input"), peer = await worker();
    await waitSent(peer, 1); expect(peer.messages.map(m => m.id)).toEqual([valid.id]);
    await ack(peer, valid.id); expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [stale.id])).toEqual({ status: dispatched ? "failed" : "cancelled" });
    expect(await hub.store.pendingForBot("bot")).toEqual([]);
  });

  it("preserves the group busy guard after claim and skips an externally removed membership before sending without losing another chat", async () => {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other','Other',?,'codex')", [hashSecret(secret)]);
    const group = await hub.store.createConversation("owner", ["bot", "other"], "Claim race", "claim_race", { type: "group" });
    const stale = (await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "race", text: "Fenced member input", attachments: [], mentions: ["bot"] })).message;
    const valid = await send("Unrelated valid conversation");
    const original = HubPromptQueue.prototype.claim; let entered!: () => void, release!: () => void;
    const claimed = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const claim = vi.spyOn(HubPromptQueue.prototype, "claim").mockImplementationOnce(async function (this: HubPromptQueue, ...args) { const messages = await original.apply(this, args); entered(); await held; return messages; });
    const peer = await worker();
    try {
      await claimed;
      await expect(hub.store.updateGroup("owner", group.id, { title: "Claim race", botIds: ["other"], expectedTitle: "Claim race", expectedBotIds: ["bot", "other"] })).rejects.toMatchObject({ code: "group_bot_busy" });
      await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id='bot'", [group.id]);
      release(); await waitSent(peer, 1); expect(peer.messages.map(m => m.id)).toEqual([valid.id]);
      await ack(peer, valid.id); expect(peer.ws.readyState).toBe(WebSocket.OPEN);
      expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [stale.id])).toEqual({ status: "failed" });
    } finally { release(); claim.mockRestore(); }
  });

  it("backs off repeated Hub dispatch failures across successful hellos, then recovers the original input once", async () => {
    const transport = new GatewayTransport({ stateDir: path.join(directory, "hub-fault-worker"), url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex" });
    const channel = new GatewayChannel(transport); channels.push(channel); const seen: string[] = [];
    channel.on("error", () => undefined); channel.on("message", async message => { seen.push(message.messageId); });
    await channel.connect(); await until(async () => (await read()).supported || undefined);
    const original = HubPromptQueue.prototype.claim, failedAt: number[] = []; let succeededAt = 0;
    const claim = vi.spyOn(HubPromptQueue.prototype, "claim").mockImplementation(async function (this: HubPromptQueue, ...args) {
      if ((await hub.store.pendingForBot("bot")).length) {
        if (failedAt.length < 3) { failedAt.push(Date.now()); throw new Error("isolated_repeated_hub_dispatch_fault"); }
        succeededAt ||= Date.now();
      }
      return original.apply(this, args);
    });
    try {
      const a = await send("Recover without repeated side effects");
      await until(async () => !(await read()).items.length && !channel.isBusy() || undefined);
      expect(seen).toEqual([a.id]); expect(failedAt).toHaveLength(3);
      expect(failedAt[1]! - failedAt[0]!).toBeGreaterThanOrEqual(200);
      expect(failedAt[2]! - failedAt[1]!).toBeGreaterThanOrEqual(400);
      expect(succeededAt - failedAt[2]!).toBeGreaterThanOrEqual(800);
      expect((transport as unknown as { attempt: number }).attempt).toBe(0);
    } finally { claim.mockRestore(); }
  }, 10_000);

  it("does not reset unsettled delivery recovery backoff merely because a connection was stable", async () => {
    const transport = new GatewayTransport({ stateDir: path.join(directory, "stable-disk-fault-worker"), url: `${hub.instanceUrl.replace(/^http/, "ws")}/instance`, botId: "bot", secret, engine: "codex" });
    const channel = new GatewayChannel(transport); channels.push(channel); channel.on("error", () => undefined);
    const state = transport as unknown as { ready: boolean; readyAt: number; attempt: number; deliveryRecoveryAttempt: number; reconnect?: unknown };
    await channel.connect(); await until(() => state.ready || undefined);
    state.readyAt = Date.now() - 31_000; state.attempt = 3; state.deliveryRecoveryAttempt = 3;
    transport.reconnectAfterDeliveryFailure();
    await until(() => !state.ready && !!state.reconnect || undefined);
    expect(state.attempt).toBe(4);
    await channel.disconnect();
  });

  it("the public worker recall path cannot delete a user input and still recalls the Bot's own reply", async () => {
    const peer = await worker(), input = await send("Keep this user input"); await waitSent(peer, 1);
    peer.send({ type: "instance.request", id: "recall_user", method: "publish", params: { id: input.id, conversationId: chatId, blocks: [], status: "deleted", version: 2 } });
    expect(await peer.next("instance.result")).toMatchObject({ id: "recall_user", error: "message_forbidden" });
    expect((await hub.store.messageForUser("owner", input.id)).status).toBe("complete");
    const reply = await hub.store.publishBotMessage("bot", { conversationId: chatId, blocks: [{ type: "text", text: "Temporary Bot reply" }], replyTo: input.id });
    peer.send({ type: "instance.request", id: "recall_reply", method: "publish", params: { id: reply.id, conversationId: chatId, blocks: [], status: "deleted", version: 2 } });
    expect(await peer.next("instance.result")).toMatchObject({ id: "recall_reply", result: { id: reply.id, status: "deleted" } });
    await ack(peer, input.id); expect((await read()).items).toEqual([]);
  });

  it("migrates pre-queue deliveries conservatively and never unlocks work the previous worker may have received", async () => {
    const legacyDir = await mkdtemp(path.join(os.tmpdir(), "hub-queue-migration-"));
    let legacy = await HubStore.open(legacyDir);
    try {
      await legacy.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Legacy','test','codex')");
      const conv = await legacy.createConversation("owner", ["bot"], "Legacy", "legacy");
      const a = (await legacy.sendMessage("owner", { conversationId: conv.id, clientMsgId: "a", text: "Unknown delivery", attachments: [] })).message;
      await legacy.db.exec("DROP INDEX deliveries_queue; DROP INDEX deliveries_queue_tail; ALTER TABLE deliveries DROP COLUMN queue_position; ALTER TABLE deliveries DROP COLUMN dispatched; DROP TABLE prompt_queue_workers; DROP TABLE prompt_queue_mutations; UPDATE meta SET value='14' WHERE key='schema_version';");
      await legacy.db.close(); legacy = await HubStore.open(legacyDir);
      const queue = new HubPromptQueue(legacy); await queue.registerWorker("bot", true);
      const snapshot = await queue.read("owner", "bot", conv.id);
      expect(snapshot.items).toEqual([expect.objectContaining({ state: "dispatched", canEdit: false, message: expect.objectContaining({ id: a.id }) })]);
      expect(await queue.claim("bot", true, false)).toEqual([]);
      expect((await queue.claim("bot", true, true)).map(m => m.id)).toEqual([a.id]);
    } finally { await legacy.db.close(); await rm(legacyDir, { recursive: true, force: true }); }
  });
});
