import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotMessages } from "../src/hub/bot-messages.js";
import { HubError } from "../src/hub/store.js";
import { hashSecret } from "../src/hub/auth.js";
import { networkId } from "../src/hub/private-network.js";
import { networkManifestSchema } from "../src/client-protocol/private-network.js";
import { blocksText, type Block } from "../src/client-protocol/index.js";
import type { BotLocalRequest } from "../src/client-protocol/bot-messages.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import type { BotMessageSteeringHooks } from "../src/hub/bot-message-steering.js";

let root: string, a: HubServer, b: HubServer, source: BotMessages, bodies: Record<string, unknown>[];
const guard = async () => undefined;
type Fake = { capable: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> };
let fake: Fake;
/** One live run per conversation, as a Gateway reports it. */
let runs: Map<string, { targetId: string; sourceMessageId: string }>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-steer-"));
  a = await HubServer.start({ stateDir: path.join(root, "a") }); b = await HubServer.start({ stateDir: path.join(root, "b") });
  await a.profile.update({ name: "Mac", revision: 0 }); await b.profile.update({ name: "Windows", revision: 0 });
  for (const hub of [a, b]) for (const [id, name] of [["source", "Source"], ["target", "Target"]]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id!, name!, hashSecret("test-".repeat(10))]);
  const nonce = randomBytes(32).toString("base64url");
  const manifest = networkManifestSchema.parse({ v: 2, id: networkId(a.auth.publicKey, nonce), name: "Test", authorityKey: a.auth.publicKey, genesisNonce: nonce, revision: 1,
    hosts: [a, b].map((hub, index) => ({ publicKey: hub.auth.publicKey, name: index ? "Windows" : "Mac", routes: [], protocol: 2, state: "active", revoked: false })), devices: [], revokedMembers: [], blockedBindings: [] });
  const membership = { manifest, signature: a.auth.signNetworkManifest(manifest) };
  for (const hub of [a, b]) await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  bodies = [];
  source = new BotMessages(a.store, a.auth, a.network, a.attachments, async (_host, signed, body) => {
    if (signed.passport.path === "/api/bot-messages/send") bodies.push(JSON.parse(body.toString("utf8")));
    return b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body);
  });
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target" }, guard);
  runs = new Map();
  fake = {
    capable: vi.fn(() => true),
    status: vi.fn(async (_bot: string, conversationId: string) => { const run = runs.get(conversationId); return run ? { supported: true, ...run, receiptEpoch: "epoch_1" } : { supported: true, reason: "no_active_turn" }; }),
    steer: vi.fn(async (_bot: string, call: { targetId: string; conversationId: string }) => {
      const run = runs.get(call.conversationId);
      return run?.targetId === call.targetId ? { outcome: "accepted", sourceMessageId: run.sourceMessageId } : { outcome: "rejected", reason: "stale" };
    }),
    reconcile: vi.fn(async () => ({ outcome: "unknown", reason: "uncertain" })),
    dispatch: vi.fn(),
  };
  b.botMessages.steering = fake as unknown as BotMessageSteeringHooks;
});
afterEach(async () => { vi.restoreAllMocks(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); });

const input = (operation: BotLocalRequest["operation"], data: Record<string, unknown> = {}, conversation?: string, requestId = randomUUID()): BotLocalRequest => ({ operation, host: "Windows", bot: "target", requestId, data, ...(conversation ? { conversation } : {}) });
const call = (request: BotLocalRequest) => source.local(request, "source", guard, true) as Promise<any>;
const resolve = async () => call(input("resolve"));
const send = (conversation: string, text: string, data: Record<string, unknown> = {}, requestId = randomUUID()) => call(input("send", { text, attachments: [], ...data }, conversation, requestId));
const wait = (conversation: string, messageId: string) => call(input("wait", { messageId }, conversation));
const deliveries = (messageId: string) => b.store.db.all<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=?", [messageId]);
/** A queued task from the source, claimed by the target's worker: a live run. */
async function liveTurn(conversation: string, text = "Long task") {
  const receipt = await send(conversation, text);
  await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [receipt.messageId]);
  const run = { targetId: `run_${randomUUID().slice(0, 8)}`, sourceMessageId: receipt.messageId as string };
  runs.set(conversation, run); return run;
}
const blocks = async (messageId: string): Promise<Block[]> => (await b.store.messageForUser("owner", messageId)).blocks;
/** The pre-existing 10 messages/minute source limit is covered elsewhere. */
const resetRate = () => b.store.db.run("DELETE FROM meta WHERE key LIKE 'bot-messages:rate:%'");

describe("legacy and explicit queue delivery", () => {
  it("keeps a send without delivery byte-identical: same body, same receipt keys, no steering calls", async () => {
    const chat = await resolve();
    await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Plain");
    expect(Object.keys(receipt).sort()).toEqual(["botId", "botName", "conversationId", "conversationName", "duplicate", "hostId", "hostName", "messageId", "requestId", "status"]);
    expect(receipt.status).toBe("queued");
    expect(bodies.at(-1)).toEqual({ text: "Plain", attachments: [] });
    expect(fake.status).not.toHaveBeenCalled(); expect(fake.steer).not.toHaveBeenCalled();
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
  });

  it("pins the legacy receipt and wait result bytes across the cross-host path", async () => {
    const chat = await resolve();
    const receipt = await send(chat.conversationId, "Plain", {}, "legacy_request");
    const target = { hostId: chat.hostId, hostName: "Windows", botId: "target", botName: "Target", conversationId: chat.conversationId, conversationName: chat.conversationName };
    expect(JSON.stringify(receipt)).toBe(JSON.stringify({ ...target, requestId: "legacy_request", messageId: receipt.messageId, duplicate: false, status: "queued" }));
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Answer" }] });
    await b.store.acknowledgeDelivery("target", receipt.messageId);
    expect(JSON.stringify(await wait(chat.conversationId, receipt.messageId))).toBe(JSON.stringify({ ...target, messageId: receipt.messageId, status: "completed", text: "Answer", files: [], truncated: false }));
    expect(fake.status).not.toHaveBeenCalled(); expect(fake.reconcile).not.toHaveBeenCalled();
  });

  it("omits delivery on the wire for an explicit queue and still reports what happened", async () => {
    const chat = await resolve();
    const receipt = await send(chat.conversationId, "Queued", { delivery: "queue" });
    expect(receipt).toMatchObject({ status: "queued", delivery: { requested: "queue", actual: "queued" } });
    // R14: an older receiving Host's strict schema would refuse the field, so the sending Host never puts queue on the wire.
    expect(bodies.at(-1)).toEqual({ text: "Queued", attachments: [] });
    expect(fake.steer).not.toHaveBeenCalled();
    expect(await deliveries(receipt.messageId)).toHaveLength(1);
  });
});

describe("steered delivery", () => {
  it("merges into the live turn the sender started, reports it, and waits for that turn's final reply", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Use the staging database", { delivery: "steer" });
    expect(receipt).toMatchObject({ status: "steered", duplicate: false, delivery: { requested: "steer", actual: "steered", turn: { messageId: run.sourceMessageId } } });
    expect(fake.steer).toHaveBeenCalledTimes(1);
    expect(fake.steer.mock.calls[0]![1]).toMatchObject({ conversationId: chat.conversationId, userId: "owner", targetId: run.targetId, sourceMessageId: run.sourceMessageId, text: "Use the staging database", source: { botId: "source", hostName: "Mac" } });
    // Never a second queued task: the record has no delivery row.
    expect(await deliveries(receipt.messageId)).toEqual([]);
    const record = await b.store.messageForUser("owner", receipt.messageId);
    expect(record.botSource).toMatchObject({ botId: "source", hostName: "Mac" });
    expect(record.blocks.find(block => block.type === "steering")).toMatchObject({ botId: "target", targetId: run.targetId, outcome: "accepted" });
    expect(await new HubPromptQueue(b.store).claim("target", true, false)).toEqual([]);
    // The turn is still answering.
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, status: "streaming", blocks: [{ type: "text", text: "Working" }] });
    const pending = await wait(chat.conversationId, receipt.messageId);
    expect(pending).toMatchObject({ status: "pending", delivery: { actual: "steered", turn: { messageId: run.sourceMessageId } } });
    const reply = await b.store.db.get<{ id: string }>("SELECT id FROM messages WHERE reply_to=? AND author_type='bot'", [run.sourceMessageId]);
    await b.store.publishBotMessage("target", { id: reply!.id, conversationId: chat.conversationId, replyTo: run.sourceMessageId, status: "complete", blocks: [{ type: "text", text: "Done on staging" }] });
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    const done = await wait(chat.conversationId, receipt.messageId);
    expect(done).toMatchObject({ status: "completed", text: "Done on staging", reply: { kind: "merged_turn", turnMessageId: run.sourceMessageId }, delivery: { requested: "steer", actual: "steered" } });
    const audit = await b.store.db.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log WHERE kind LIKE 'bot-message.%' ORDER BY id");
    expect(audit.map(row => row.kind)).toContain("bot-message.steer");
    expect(JSON.parse(audit.find(row => row.kind === "bot-message.steer")!.detail_json)).toMatchObject({ outcome: "steered", sourceBot: "source", turn: run.sourceMessageId });
  });

  it("still forbids control text for steer, before any steering call", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (const text of ["/stop", "/approve all", " /new"]) await expect(send(chat.conversationId, text, { delivery: "steer" })).rejects.toThrow("bot_message_control_forbidden");
    expect(fake.status).not.toHaveBeenCalled(); expect(fake.steer).not.toHaveBeenCalled();
  });

  it("returns the existing outcome for a repeated request ID, whatever delivery it names, without steering again", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const requestId = randomUUID();
    const first = await send(chat.conversationId, "Fix A", { delivery: "steer" }, requestId);
    for (const data of [{ delivery: "steer" }, { delivery: "queue" }, {}]) {
      const again = await send(chat.conversationId, "Fix A", data, requestId);
      expect(again).toMatchObject({ messageId: first.messageId, duplicate: true, status: "steered", delivery: { actual: "steered" } });
    }
    expect(fake.steer).toHaveBeenCalledTimes(1);
    await expect(send(chat.conversationId, "Fix B", { delivery: "steer" }, requestId)).rejects.toThrow("bot_message_request_conflict");
  });
});

describe("fallback to the queue", () => {
  const expectQueuedOnce = async (receipt: any, reason: string) => {
    expect(receipt).toMatchObject({ status: "queued", delivery: { requested: "steer", actual: "fell_back_to_queue", reason } });
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    const record = await blocks(receipt.messageId);
    expect(record.some(block => block.type === "steering")).toBe(false);
    expect(record.find(block => block.type === "card")).toMatchObject({ extra: { promptQueue: { state: "steer_fallback", botId: "target", reason } } });
    // The engine prompt never includes the Host's notice.
    expect(blocksText(record)).not.toContain("已改为排队");
  };

  it("queues when the recipient has no live turn in this conversation (idle, or busy in another conversation)", async () => {
    const chat = await resolve();
    await expectQueuedOnce(await send(chat.conversationId, "Idle", { delivery: "steer" }), "no_active_turn");
    const other = await call(input("resolve", { newConversation: "Other task" }));
    await liveTurn(other.conversationId);
    await expectQueuedOnce(await send(chat.conversationId, "Busy elsewhere", { delivery: "steer" }), "no_active_turn");
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("queues when the receiving owner turned steering off for this Bot", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    await b.botMessages.setSteering("owner", { botId: "target", allowed: false }, guard, guard, "owner");
    await expectQueuedOnce(await send(chat.conversationId, "Fix", { delivery: "steer" }), "steering_disabled");
    expect(fake.status).not.toHaveBeenCalled();
    await b.botMessages.setSteering("owner", { botId: "target", allowed: true }, guard, guard, "owner");
    expect((await send(chat.conversationId, "Fix again", { delivery: "steer" })).status).toBe("steered");
  });

  it("queues for engines other than Codex and Claude", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (const engine of ["pi", "kimi", "deepseek", "antigravity"]) {
      await b.store.db.run("UPDATE bots SET engine=? WHERE id='target'", [engine]);
      await expectQueuedOnce(await send(chat.conversationId, `Fix ${engine}`, { delivery: "steer" }), "unsupported_engine");
    }
    await b.store.db.run("UPDATE bots SET engine='claude' WHERE id='target'");
    expect((await send(chat.conversationId, "Fix claude", { delivery: "steer" })).status).toBe("steered");
    expect(fake.status).toHaveBeenCalledTimes(1);
  });

  it("queues when the worker is offline or predates the steer capability", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    fake.capable.mockReturnValue(undefined);
    await expectQueuedOnce(await send(chat.conversationId, "Offline", { delivery: "steer" }), "bot_offline");
    fake.capable.mockReturnValue(false);
    await expectQueuedOnce(await send(chat.conversationId, "Old worker", { delivery: "steer" }), "worker_update_required");
    fake.capable.mockReturnValue(true); fake.status.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    await expectQueuedOnce(await send(chat.conversationId, "Status lost", { delivery: "steer" }), "status_unavailable");
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("never steers into a turn another sender started, a background review, or a turn waiting on a card", async () => {
    const chat = await resolve();
    const owner = await b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId: "owner-task", text: "Owner task", attachments: [] });
    await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [owner.message.id]);
    runs.set(chat.conversationId, { targetId: "run_owner", sourceMessageId: owner.message.id });
    await expectQueuedOnce(await send(chat.conversationId, "Hijack", { delivery: "steer" }), "turn_not_from_sender");
    fake.status.mockResolvedValueOnce({ supported: true, reason: "background_review" });
    await expectQueuedOnce(await send(chat.conversationId, "Review", { delivery: "steer" }), "background_review");
    await b.store.acknowledgeDelivery("target", owner.message.id);
    const run = await liveTurn(chat.conversationId);
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, blocks: [{ type: "card", elements: [{ type: "button", text: "Allow", actionId: "act_1", value: { cctb_lark: "approval", requestId: "req", decision: "allow_once" } }] }] });
    await expectQueuedOnce(await send(chat.conversationId, "Approve it", { delivery: "steer" }), "pending_card");
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("queues group chats and attachments", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const bytes = Buffer.from("file"), sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    const upload = await call(input("upload", { name: "a.txt", mime: "text/plain", size: bytes.length, sha256 }, chat.conversationId));
    await call(input("chunk", { uploadId: upload.id, index: 0, bytes: bytes.toString("base64") }, chat.conversationId));
    await call(input("complete", { uploadId: upload.id }, chat.conversationId));
    const withFile = await send(chat.conversationId, "See file", { delivery: "steer", attachments: [upload.id] });
    expect(withFile).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "attachments_unsupported" } });
    const group = await b.store.createConversation("owner", ["target", "source"], "Group", "group-1");
    await b.store.db.run("UPDATE conversations SET type='group' WHERE id=?", [group.id]);
    const grouped = await send(group.id, "Group fix", { delivery: "steer" });
    expect(grouped).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "unsupported_conversation" } });
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("turns a definite engine rejection (the turn just ended) into exactly one queued task", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    expect(fake.dispatch).not.toHaveBeenCalled();
    // Status saw the run; by the time the steer arrives the run has ended.
    fake.steer.mockImplementationOnce(async () => { runs.delete(chat.conversationId); return { outcome: "rejected", reason: "stale" }; });
    const receipt = await send(chat.conversationId, "Late fix", { delivery: "steer" });
    await expectQueuedOnce(receipt, "turn_ended");
    expect(fake.steer).toHaveBeenCalledTimes(1);
    // The new delivery asks the Hub to dispatch (socket-level proof in hub-bot-message-steer-dispatch).
    expect(fake.dispatch).toHaveBeenCalledWith("target");
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    const claimed = await new HubPromptQueue(b.store).claim("target", true, false);
    expect(claimed.map(message => message.id)).toEqual([receipt.messageId]);
    expect(await new HubPromptQueue(b.store).claim("target", true, false)).toEqual([]);
    // A retry with the same request ID neither steers nor queues again.
    const again = await send(chat.conversationId, "Late fix", { delivery: "steer" }, receipt.requestId);
    expect(again).toMatchObject({ duplicate: true, delivery: { actual: "fell_back_to_queue", reason: "turn_ended" } });
    expect(await deliveries(receipt.messageId)).toHaveLength(1);
    expect(fake.steer).toHaveBeenCalledTimes(1);
  });

  it("M1: a lost Hub call is unconfirmed, not terminal; only the Gateway's own \"cannot tell\" is uncertain, and neither is a merged reply", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Maybe", { delivery: "steer" });
    // Same words in the send receipt and in wait for the same state.
    expect(receipt).toMatchObject({ status: "pending", delivery: { requested: "steer", actual: "pending", reason: "steer_unconfirmed", turn: { messageId: run.sourceMessageId } } });
    expect(await deliveries(receipt.messageId)).toEqual([]);
    // Reconciliation cannot run (no worker): still not terminal, with the reason.
    fake.capable.mockReturnValue(undefined);
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, blocks: [{ type: "text", text: "Finished without it" }] });
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    const waiting = await wait(chat.conversationId, receipt.messageId);
    expect(waiting).toMatchObject({ status: "pending", text: "", delivery: { actual: "pending", reason: "steer_unconfirmed" } });
    expect(waiting).not.toHaveProperty("reply");
    expect(JSON.stringify(waiting)).not.toContain("Finished without it");
    expect(fake.reconcile).not.toHaveBeenCalled();
    // The Gateway answers that it cannot tell: now terminal, still never merged_turn or completed.
    fake.capable.mockReturnValue(true);
    const ended = await wait(chat.conversationId, receipt.messageId);
    expect(ended).toMatchObject({ status: "uncertain", text: "", files: [], delivery: { actual: "steer_uncertain", turn: { messageId: run.sourceMessageId } } });
    expect(ended).not.toHaveProperty("reply");
    const again = await send(chat.conversationId, "Maybe", { delivery: "steer" }, receipt.requestId);
    expect(again).toMatchObject({ duplicate: true, status: "uncertain", delivery: { actual: "steer_uncertain" } });
    expect(fake.steer).toHaveBeenCalledTimes(1); expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(await deliveries(receipt.messageId)).toEqual([]);
  });

  it("M1: the Gateway's own unknown answer to the steer is terminal at once", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    fake.steer.mockResolvedValueOnce({ outcome: "unknown", reason: "uncertain", sourceMessageId: run.sourceMessageId });
    const receipt = await send(chat.conversationId, "No ack", { delivery: "steer" });
    expect(receipt).toMatchObject({ status: "uncertain", delivery: { actual: "steer_uncertain", turn: { messageId: run.sourceMessageId } } });
    expect(await wait(chat.conversationId, receipt.messageId)).toMatchObject({ status: "uncertain", delivery: { actual: "steer_uncertain" } });
    expect(fake.reconcile).not.toHaveBeenCalled();
  });

  it("reports a pending steer to a concurrent duplicate and recovers an interrupted Hub as uncertain", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    let release!: (value: unknown) => void;
    fake.steer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const requestId = randomUUID();
    const first = send(chat.conversationId, "Slow", { delivery: "steer" }, requestId);
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalledTimes(1));
    const duplicate = await send(chat.conversationId, "Slow", { delivery: "steer" }, requestId);
    expect(duplicate).toMatchObject({ duplicate: true, status: "pending", delivery: { actual: "pending", reason: "steer_in_flight" } });
    expect((await wait(chat.conversationId, duplicate.messageId)).status).toBe("pending");
    // A Hub restart leaves the unresolved call unconfirmed (reconcilable); nothing is queued.
    await b.store.recoverSteering();
    expect(await wait(chat.conversationId, duplicate.messageId)).toMatchObject({ status: "pending", delivery: { actual: "pending", reason: "steer_unconfirmed", turn: { messageId: run.sourceMessageId } } });
    release({ outcome: "accepted", sourceMessageId: run.sourceMessageId });
    await first;
    expect(await deliveries(duplicate.messageId)).toEqual([]);
  });

  it("reports a turn that failed or dropped the merged text as a terminal failure", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Fix", { delivery: "steer" });
    await b.store.applySteeringOutcome("target", { conversationId: chat.conversationId, userId: "owner", requestId: (await b.store.messageForUser("owner", receipt.messageId)).clientMsgId, targetId: run.targetId, application: { status: "dropped", reason: "stopped" } });
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, status: "error", blocks: [{ type: "text", text: "Stopped" }] });
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    expect(await wait(chat.conversationId, receipt.messageId)).toMatchObject({ status: "failed", delivery: { actual: "steered", dropped: "stopped" } });
  });
});

describe("owner steering stays separate", () => {
  it("never lets the owner's steer route re-send a Bot steer record", async () => {
    const chat = await resolve(); const run = await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Bot text", { delivery: "steer" });
    const record = await b.store.messageForUser("owner", receipt.messageId);
    await expect(b.store.beginSteeringRecord("owner", { conversationId: chat.conversationId, botId: "target", requestId: record.clientMsgId!, targetId: run.targetId, text: "Bot text" })).rejects.toThrow("idempotency_conflict");
    await expect(b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId: record.clientMsgId!, text: "Bot text", attachments: [] })).rejects.toThrow("idempotency_conflict");
    expect(await deliveries(receipt.messageId)).toEqual([]);
  });
});

describe("only the sender's own turn (D1)", () => {
  it("queues instead of steering into a turn the owner or a third Bot started, and never reveals that turn's reply", async () => {
    for (const hub of [a, b]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('third','Third',?,'codex')", [hashSecret("test-".repeat(10))]);
    await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "third", targetBot: "target" }, guard);
    const chat = await resolve();
    // A third Bot reaches the same conversation by exact ID and starts the turn.
    const third: any = await source.local({ operation: "send", host: "Windows", bot: "target", conversation: chat.conversationId, requestId: randomUUID(), data: { text: "Third task", attachments: [] } }, "third", guard, true);
    await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [third.messageId]);
    runs.set(chat.conversationId, { targetId: "run_third", sourceMessageId: third.messageId });
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: third.messageId, blocks: [{ type: "text", text: "Secret answer for Third" }] });
    const receipt = await send(chat.conversationId, "Hijack", { delivery: "steer" });
    expect(receipt).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "turn_not_from_sender" } });
    expect(fake.steer).not.toHaveBeenCalled();
    const result = await wait(chat.conversationId, receipt.messageId);
    expect(JSON.stringify(result)).not.toContain("Secret answer");
    await expect(wait(chat.conversationId, third.messageId)).rejects.toThrow("bot_message_reply_forbidden");
    // Even a forged record pointing at another sender's turn reveals nothing.
    const own = await liveTurn(chat.conversationId), steered = await send(chat.conversationId, "Mine", { delivery: "steer" });
    expect(steered.delivery.turn.messageId).toBe(own.sourceMessageId);
    const key = (await b.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:incoming:%'")).find(row => JSON.parse(row.value).steer?.turn === own.sourceMessageId)!.key;
    const memo = JSON.parse((await b.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]))!.value);
    await b.store.db.run("UPDATE meta SET value=? WHERE key=?", [JSON.stringify({ ...memo, steer: { ...memo.steer, turn: third.messageId } }), key]);
    const forged = await wait(chat.conversationId, steered.messageId);
    expect(forged).toMatchObject({ status: "uncertain", text: "", files: [] });
    expect(JSON.stringify(forged)).not.toContain("Secret answer");
  });
});

describe("reconciling an unknown outcome (R1)", () => {
  it("queues exactly once when the Gateway had in fact refused before admission", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Slow refusal", { delivery: "steer" });
    expect(receipt.delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    fake.reconcile.mockResolvedValue({ outcome: "rejected", reason: "stale" });
    const after = await wait(chat.conversationId, receipt.messageId);
    expect(after).toMatchObject({ status: "pending", delivery: { actual: "fell_back_to_queue", reason: "turn_ended" } });
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(fake.reconcile.mock.calls[0]![1]).toEqual({ conversationId: chat.conversationId, requestId: (await b.store.messageForUser("owner", receipt.messageId)).clientMsgId, targetId: runs.get(chat.conversationId)!.targetId, sourceMessageId: runs.get(chat.conversationId)!.sourceMessageId, receiptEpoch: "epoch_1" });
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    // Later waits and a replay neither reconcile nor queue again.
    await wait(chat.conversationId, receipt.messageId);
    expect(await send(chat.conversationId, "Slow refusal", { delivery: "steer" }, receipt.requestId)).toMatchObject({ duplicate: true, status: "queued", delivery: { actual: "fell_back_to_queue" } });
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(await deliveries(receipt.messageId)).toHaveLength(1);
    expect(fake.steer).toHaveBeenCalledTimes(1);
  });

  it("becomes steered, never queued, when the Gateway had in fact accepted", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Slow accept", { delivery: "steer" });
    fake.reconcile.mockResolvedValue({ outcome: "accepted", sourceMessageId: run.sourceMessageId });
    const again = await send(chat.conversationId, "Slow accept", { delivery: "steer" }, receipt.requestId);
    expect(again).toMatchObject({ duplicate: true, status: "steered", delivery: { actual: "steered", turn: { messageId: run.sourceMessageId } } });
    expect((await blocks(receipt.messageId)).find(block => block.type === "steering")).toMatchObject({ outcome: "accepted" });
    expect((await blocks(receipt.messageId)).find(block => block.type === "steering")).not.toHaveProperty("reason");
    expect(await deliveries(receipt.messageId)).toEqual([]);
    expect(fake.steer).toHaveBeenCalledTimes(1);
  });

  it("stays unconfirmed while reconciliation cannot run, and terminal only when the Gateway cannot tell", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Unknowable", { delivery: "steer" });
    fake.capable.mockReturnValue(undefined);
    expect((await wait(chat.conversationId, receipt.messageId)).delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    fake.capable.mockReturnValue(false);
    expect((await wait(chat.conversationId, receipt.messageId)).delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    expect(fake.reconcile).not.toHaveBeenCalled();
    fake.capable.mockReturnValue(true); fake.reconcile.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    expect((await wait(chat.conversationId, receipt.messageId)).delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    expect((await wait(chat.conversationId, receipt.messageId)).delivery.actual).toBe("steer_uncertain");
    expect(fake.reconcile).toHaveBeenCalledTimes(2);
    expect(await deliveries(receipt.messageId)).toEqual([]);
    let release!: (value: unknown) => void;
    fake.steer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = send(chat.conversationId, "In flight", { delivery: "steer" });
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalledTimes(2));
    const record = await b.store.db.get<{ id: string }>("SELECT id FROM messages WHERE blocks_json LIKE '%In flight%'");
    const calls = fake.reconcile.mock.calls.length;
    expect(await wait(chat.conversationId, record!.id)).toMatchObject({ status: "pending", delivery: { actual: "pending", reason: "steer_in_flight" } });
    expect(fake.reconcile.mock.calls.length).toBe(calls);
    release({ outcome: "accepted", sourceMessageId: runs.get(chat.conversationId)!.sourceMessageId });
    expect((await sending).status).toBe("steered");
  });

  it("reconciles every open steer of a Bot when its worker attaches, without the sender asking", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "Lost", { delivery: "steer" });
    fake.reconcile.mockResolvedValueOnce({ outcome: "rejected", reason: "stale" });
    await b.botMessages.reconcileForBot("target");
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    expect(fake.dispatch).toHaveBeenCalledWith("target");
    // Settled records are not reconciled again.
    await b.botMessages.reconcileForBot("target");
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("waits always end (R5)", () => {
  it("ends when the joined turn is cancelled, fails, loses its input or replies, or its chat is archived", async () => {
    for (const ending of ["cancelled", "failed", "input_deleted", "replies_deleted", "archived"] as const) {
      await resetRate();
      const chat = await call(input("resolve", { newConversation: `End ${ending}` })), run = await liveTurn(chat.conversationId);
      const receipt = await send(chat.conversationId, `Fix ${ending}`, { delivery: "steer" });
      expect((await wait(chat.conversationId, receipt.messageId)).status).toBe("pending");
      if (ending === "cancelled" || ending === "failed") await b.store.db.run("UPDATE deliveries SET status=? WHERE message_id=?", [ending, run.sourceMessageId]);
      else {
        const reply = await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, blocks: [{ type: "text", text: "Partial" }] });
        if (ending === "input_deleted") await b.store.db.run("UPDATE messages SET status='deleted' WHERE id=?", [run.sourceMessageId]);
        if (ending === "replies_deleted") await b.store.db.run("UPDATE messages SET status='deleted' WHERE id=?", [reply.id]);
        if (ending === "archived") await b.store.updateConversation("owner", chat.conversationId, { archived: true });
        await b.store.acknowledgeDelivery("target", run.sourceMessageId);
      }
      const done = await wait(chat.conversationId, receipt.messageId);
      expect(done.status).toBe(ending === "cancelled" ? "cancelled" : ending === "failed" ? "failed" : "completed");
      expect(done.reply).toEqual({ kind: "merged_turn", turnMessageId: run.sourceMessageId });
      if (ending === "replies_deleted") expect(done.text).toBe("");
    }
  });

  it("returns an explicit error once the recipient Bot is deleted", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Fix", { delivery: "steer" });
    await b.store.db.run("UPDATE bots SET deleted_at=? WHERE id='target'", [Date.now()]);
    await expect(wait(chat.conversationId, receipt.messageId)).rejects.toThrow(/bot_deleted|not_authorized/);
  });
});

describe("second code review (C1–C5)", () => {
  it("C1: concurrent requests with one request ID share the first record's outcome, never a conflict", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    let release!: (value: unknown) => void;
    fake.steer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const requestId = randomUUID();
    const first = send(chat.conversationId, "Same", { delivery: "steer" }, requestId);
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalledTimes(1));
    const others = await Promise.all([send(chat.conversationId, "Same", { delivery: "steer" }, requestId), send(chat.conversationId, "Same", { delivery: "queue" }, requestId), send(chat.conversationId, "Same", {}, requestId)]);
    release({ outcome: "accepted", sourceMessageId: run.sourceMessageId });
    const original = await first;
    for (const other of others) expect(other).toMatchObject({ messageId: original.messageId, duplicate: true, delivery: { actual: expect.stringMatching(/^(pending|steered)$/) } });
    expect(fake.steer).toHaveBeenCalledTimes(1);
    expect(await deliveries(original.messageId)).toEqual([]);
  });

  it("C1: a concurrent duplicate whose own plan hits a limit still reports the first record", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (let i = 0; i < 2; i++) await send(chat.conversationId, `Earlier ${i}`, { delivery: "steer" });
    const requestId = randomUUID();
    const results = await Promise.all([send(chat.conversationId, "Third", { delivery: "steer" }, requestId), send(chat.conversationId, "Third", { delivery: "steer" }, requestId)]);
    expect(new Set(results.map(result => result.messageId)).size).toBe(1);
    expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
    // The first is steered; the duplicate reports that same record, in flight or settled.
    expect(results.find(result => !result.duplicate)!.delivery.actual).toBe("steered");
    expect(["pending", "steered"]).toContain(results.find(result => result.duplicate)!.delivery.actual);
    expect(await deliveries(results[0]!.messageId)).toEqual([]);
  });

  it("C3: counts a turn's Bot steers from its records and keeps no per-turn counter", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (let i = 0; i < 3; i++) await send(chat.conversationId, `Fix ${i}`, { delivery: "steer" });
    expect((await send(chat.conversationId, "Fix 3", { delivery: "steer" })).delivery.reason).toBe("turn_steer_limit");
    expect(await b.store.db.all("SELECT key FROM meta WHERE key LIKE 'bot-messages:steer-turn:%'")).toEqual([]);
  });

  it("C4: a Gateway control refusal is never queued and never reported as an engine limitation", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    fake.steer.mockResolvedValueOnce({ outcome: "rejected", reason: "control_forbidden" });
    const receipt = await send(chat.conversationId, "Looks plain to the Hub", { delivery: "steer" });
    expect(receipt.delivery.actual).toBe("steer_uncertain");
    expect(receipt.delivery.reason).toBeUndefined();
    expect(await deliveries(receipt.messageId)).toEqual([]);
    const audit = await b.store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot-message.steer'");
    expect(audit.map(row => JSON.parse(row.detail_json))).toContainEqual(expect.objectContaining({ outcome: "steer_uncertain", reason: "control_forbidden_unreachable" }));
  });

  it("C5: the legacy path's extra lookup, empty or failing, leaves the legacy receipt and stored input unchanged", async () => {
    const chat = await resolve();
    const lookup = vi.spyOn(b.botMessages as unknown as { priorSteerRequest: (key: string) => Promise<unknown> }, "priorSteerRequest");
    const stored = async (messageId: string) => b.store.db.get<Record<string, unknown>>("SELECT author_id,author_type,blocks_json,status,version,client_msg_id,reply_to,mentions_json,forwarded_json,bot_source_json FROM messages WHERE id=?", [messageId]);
    const outcomes = [];
    for (const behaviour of ["empty", "failing"] as const) {
      if (behaviour === "failing") lookup.mockRejectedValueOnce(new Error("meta_read_failed"));
      const requestId = `legacy_${behaviour}`, receipt = await send(chat.conversationId, "Plain", {}, requestId);
      expect(JSON.stringify(receipt)).toBe(JSON.stringify({ hostId: chat.hostId, hostName: "Windows", botId: "target", botName: "Target", conversationId: chat.conversationId, conversationName: chat.conversationName, requestId, messageId: receipt.messageId, duplicate: false, status: "queued" }));
      const row = await stored(receipt.messageId);
      outcomes.push({ ...row, client_msg_id: undefined, bot_source_json: JSON.parse(String(row!.bot_source_json)).botId });
      expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    }
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]).toMatchObject({ author_id: "owner", author_type: "user", blocks_json: JSON.stringify([{ type: "text", text: "Plain" }]), mentions_json: JSON.stringify(["target"]), status: "complete", version: 1, reply_to: null, forwarded_json: null });
  });
});

describe("M4: the owner's switch and the plan's Hub conditions hold in the creating transaction", () => {
  it("queues when the owner turns steering off while the Gateway status call is in flight", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const original = fake.status.getMockImplementation()!;
    fake.status.mockImplementationOnce(async (bot: string, conversationId: string) => {
      await b.botMessages.setSteering("owner", { botId: "target", allowed: false }, guard, guard, "owner");
      return original(bot, conversationId);
    });
    const receipt = await send(chat.conversationId, "Fix", { delivery: "steer" });
    expect(receipt).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "steering_disabled" } });
    expect(fake.steer).not.toHaveBeenCalled();
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
  });

  it("queues when the engine changes away from Codex/Claude during the status call", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const original = fake.status.getMockImplementation()!;
    fake.status.mockImplementationOnce(async (bot: string, conversationId: string) => {
      await b.store.db.run("UPDATE bots SET engine='pi' WHERE id='target'");
      return original(bot, conversationId);
    });
    expect(await send(chat.conversationId, "Fix", { delivery: "steer" })).toMatchObject({ delivery: { actual: "fell_back_to_queue", reason: "unsupported_engine" } });
    expect(fake.steer).not.toHaveBeenCalled();
  });
});

describe("R10: a merged Bot record follows its turn through a history rewind", () => {
  it("binds an accepted steer to the run it joined, so a rewind of that turn marks it too", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    const merged = await send(chat.conversationId, "Merged fix", { delivery: "steer" });
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const unconfirmed = await send(chat.conversationId, "Unconfirmed fix", { delivery: "steer" });
    expect((await b.store.runInputs(run.sourceMessageId)).inputs.map(input => input.id)).toEqual([merged.messageId, unconfirmed.messageId]);
    await b.store.db.transaction(() => b.store.excludeHistoryMessagesInTransaction(chat.conversationId, [run.sourceMessageId], "op_rewind", "target"));
    expect((await b.store.messageForUser("owner", merged.messageId)).historyContext?.excludedBy).toBe("op_rewind");
    // Unknown membership is never inferred.
    expect((await b.store.messageForUser("owner", unconfirmed.messageId)).historyContext).toBeUndefined();
  });
});

describe("R11/R12: bounded replay and the source rate limit before the Gateway", () => {
  it("R11: refuses a record under this request's client ID that is not this request's, without re-planning forever", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const requestId = "collision_request";
    const clientMsgId = `bm_${hashSecret(`bot-messages:incoming:${hashSecret(JSON.stringify([a.auth.publicKey, "source", requestId]))}`)}`;
    // A hand-made collision: a record with that client ID but another origin and no request memo.
    await b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId, text: "Someone else", attachments: [] });
    await expect(send(chat.conversationId, "Mine", { delivery: "steer" }, requestId)).rejects.toThrow("bot_message_request_conflict");
    expect(fake.status.mock.calls.length).toBeLessThanOrEqual(1);
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("R12: a rate-limited source gets the queue path's 429 without any Gateway call", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (let i = 0; i < 9; i++) await send(chat.conversationId, `Filler ${i}`);
    const statusCalls = fake.status.mock.calls.length;
    for (let i = 0; i < 3; i++) await expect(send(chat.conversationId, `Steer ${i}`, { delivery: "steer" })).rejects.toThrow("bot_message_rate_limit");
    expect(fake.status.mock.calls.length).toBe(statusCalls);
  });
});

describe("R13: every steer outcome leaves an audit entry", () => {
  const steerAudits = async () => (await b.store.db.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log WHERE kind IN ('bot-message.steer','bot-message.send') ORDER BY id")).map(row => ({ kind: row.kind, ...JSON.parse(row.detail_json) }));
  it("records a Hub restart that left the call unconfirmed", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    let release!: (value: unknown) => void;
    fake.steer.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = send(chat.conversationId, "Interrupted", { delivery: "steer" });
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalledTimes(1));
    const record = (await b.store.db.get<{ id: string }>("SELECT id FROM messages WHERE blocks_json LIKE '%Interrupted%'"))!;
    await b.store.recoverSteering();
    expect(await steerAudits()).toContainEqual(expect.objectContaining({ kind: "bot-message.steer", messageId: record.id, outcome: "steer_unconfirmed", reason: "hub_restart", sourceBot: "source" }));
    release({ outcome: "unknown", reason: "uncertain" }); await sending;
  });
  it("records the engine dropping merged text and every replay of a steer request", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Fix", { delivery: "steer" });
    await b.store.applySteeringOutcome("target", { conversationId: chat.conversationId, userId: "owner", requestId: (await b.store.messageForUser("owner", receipt.messageId)).clientMsgId, targetId: run.targetId, application: { status: "dropped", reason: "stopped" } });
    expect(await steerAudits()).toContainEqual(expect.objectContaining({ kind: "bot-message.steer", messageId: receipt.messageId, outcome: "dropped", reason: "stopped" }));
    await send(chat.conversationId, "Fix", { delivery: "steer" }, receipt.requestId);
    expect((await steerAudits()).filter(entry => entry.kind === "bot-message.send" && entry.requestId === receipt.requestId).map(entry => entry.duplicate)).toEqual([false, true]);
  });
});

describe("R15: scope decided by the lead", () => {
  it("queues for an internal worker recipient while allowing steering on a dispatcher recipient", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    await resetRate();
    await b.store.db.run("UPDATE bots SET role='worker' WHERE id='target'");
    expect(await send(chat.conversationId, "Fix worker", { delivery: "steer" })).toMatchObject({ delivery: { actual: "fell_back_to_queue", reason: "unsupported_conversation" } });
    expect(fake.status).not.toHaveBeenCalled();

    await resetRate();
    await b.store.db.run("UPDATE bots SET role='dispatcher' WHERE id='target'");
    expect(await send(chat.conversationId, "Fix dispatcher", { delivery: "steer" })).toMatchObject({ delivery: { actual: "steered" } });
    expect(fake.status).toHaveBeenCalled();
  });

  it("does not count a Host-written notice that merely carries the sender's Bot source as the sender's turn", async () => {
    const chat = await resolve();
    const notice = await b.store.sendMessage("owner", { conversationId: chat.conversationId, clientMsgId: "dispatch_notice_fixture", text: "Ticket update", attachments: [], mentions: ["target"],
      botSource: { hostId: (await source.ownSource()).hostId, hostName: "Mac", botId: "source", botName: "Source", requestId: "notice_request", hops: 1 } });
    await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [notice.message.id]);
    runs.set(chat.conversationId, { targetId: "run_notice", sourceMessageId: notice.message.id });
    expect(await send(chat.conversationId, "Fix", { delivery: "steer" })).toMatchObject({ delivery: { actual: "fell_back_to_queue", reason: "turn_not_from_sender" } });
    expect(fake.steer).not.toHaveBeenCalled();
  });

  it("never lets a Bot steer itself", async () => {
    await b.botMessages.grant({ sourceHost: "Windows", sourceBot: "target", targetBot: "target" }, guard);
    const self = (request: Omit<BotLocalRequest, "host" | "bot">) => b.botMessages.local({ ...request, host: "Windows", bot: "target" }, "target", guard, true) as Promise<any>;
    const chat = await self({ operation: "resolve", requestId: randomUUID(), data: {} });
    const task = await self({ operation: "send", conversation: chat.conversationId, requestId: randomUUID(), data: { text: "My own task", attachments: [] } });
    await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
    runs.set(chat.conversationId, { targetId: "run_self", sourceMessageId: task.messageId });
    expect(await self({ operation: "send", conversation: chat.conversationId, requestId: randomUUID(), data: { text: "Note to self", attachments: [], delivery: "steer" } }))
      .toMatchObject({ delivery: { actual: "fell_back_to_queue", reason: "self_target" } });
    expect(fake.status).not.toHaveBeenCalled();
  });
});

describe("R17: requirements pinned so that breaking them fails", () => {
  /** Hold every status call until `count` have arrived, so concurrent requests all pass planning first. */
  const barrier = (count: number) => {
    const original = fake.status.getMockImplementation()!;
    let arrived = 0, open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    fake.status.mockImplementation(async (bot: string, conversationId: string) => { if (++arrived >= count) open(); await gate; return original(bot, conversationId); });
  };
  it("holds the per-turn limit inside the creating transaction under concurrency", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (let i = 0; i < 2; i++) await send(chat.conversationId, `Earlier ${i}`, { delivery: "steer" });
    barrier(2);
    const results = await Promise.all([send(chat.conversationId, "Race A", { delivery: "steer" }), send(chat.conversationId, "Race B", { delivery: "steer" })]);
    expect(results.map(result => result.delivery.actual).sort()).toEqual(["fell_back_to_queue", "steered"]);
    expect(results.find(result => result.delivery.actual === "fell_back_to_queue")!.delivery.reason).toBe("turn_steer_limit");
  });
  it("holds the per-edge limit inside the creating transaction under concurrency", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const edge = `bot-messages:steer-rate:${hashSecret(JSON.stringify([a.auth.publicKey, "source", "target"]))}`, now = Date.now();
    await b.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [edge, JSON.stringify([now, now, now, now, now])]);
    barrier(2);
    const results = await Promise.all([send(chat.conversationId, "Edge A", { delivery: "steer" }), send(chat.conversationId, "Edge B", { delivery: "steer" })]);
    expect(results.map(result => result.delivery.actual).sort()).toEqual(["fell_back_to_queue", "steered"]);
    expect(results.find(result => result.delivery.actual === "fell_back_to_queue")!.delivery.reason).toBe("steer_rate_limited");
  });
  it("reports failed when the engine dropped the merged text, even if the turn itself completed", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Fix", { delivery: "steer" });
    await b.store.applySteeringOutcome("target", { conversationId: chat.conversationId, userId: "owner", requestId: (await b.store.messageForUser("owner", receipt.messageId)).clientMsgId, targetId: run.targetId, application: { status: "dropped", reason: "turn_failed" } });
    await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: run.sourceMessageId, blocks: [{ type: "text", text: "All good" }] });
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    expect(await wait(chat.conversationId, receipt.messageId)).toMatchObject({ status: "failed", delivery: { actual: "steered", dropped: "turn_failed" } });
  });
  it("never turns an accepted record into a queued one", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const receipt = await send(chat.conversationId, "Accepted", { delivery: "steer" });
    const { changed } = await b.store.fallBackBotSteer(receipt.messageId, "target", { type: "card", elements: [] });
    expect(changed).toBe(false);
    expect(await deliveries(receipt.messageId)).toEqual([]);
    expect((await blocks(receipt.messageId)).find(block => block.type === "steering")).toMatchObject({ outcome: "accepted" });
  });
  it("plans a steer only into a turn whose input is still pending and already dispatched", async () => {
    const chat = await resolve(), run = await liveTurn(chat.conversationId);
    await b.store.db.run("UPDATE deliveries SET dispatched=0 WHERE message_id=?", [run.sourceMessageId]);
    expect((await send(chat.conversationId, "Not started", { delivery: "steer" })).delivery).toMatchObject({ actual: "fell_back_to_queue", reason: "turn_ended" });
    await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [run.sourceMessageId]);
    await b.store.acknowledgeDelivery("target", run.sourceMessageId);
    expect((await send(chat.conversationId, "Finished", { delivery: "steer" })).delivery).toMatchObject({ actual: "fell_back_to_queue", reason: "turn_ended" });
    expect(fake.steer).not.toHaveBeenCalled();
  });
  it("downgrades only on the receiving Host's explicit refusal of the probe; any other probe failure stops the send", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    for (const failure of [new HubError("bot_message_peer_unavailable_or_upgrade_required", 503), new HubError("bot_message_transport_timeout", 504), new HubError("bot_message_not_authorized_or_revoked", 403)]) {
      const sends: string[] = [];
      vi.spyOn(source, "exchange").mockImplementation(async (_host, signed, body) => {
        if (signed.passport.path === "/api/bot-messages/capabilities") throw failure;
        sends.push(signed.passport.path); return b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body);
      });
      await expect(send(chat.conversationId, "Probe failed", { delivery: "steer" })).rejects.toThrow(failure.code);
      expect(sends).toEqual([]);
      vi.mocked(source.exchange).mockRestore();
    }
  });
});

describe("final verification round (V1–V4)", () => {
  const openKeys = () => b.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:steer-open:%'");
  it("V1: the open index commits with the record — a failed index write leaves nothing behind, and a restart still reconciles", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const bm = b.botMessages as unknown as { put(key: string, value: unknown): Promise<unknown> };
    const put = bm.put.bind(b.botMessages); let failed = 0;
    bm.put = (key: string, value: unknown) => { if (key.startsWith("bot-messages:steer-open:") && !failed) { failed++; return Promise.reject(new Error("simulated lost index write")); } return put(key, value); };
    const requestId = randomUUID();
    await expect(send(chat.conversationId, "IndexedOrNothing", { delivery: "steer" }, requestId)).rejects.toThrow("simulated lost index write");
    bm.put = put;
    expect(failed).toBe(1);
    expect(await b.store.db.get("SELECT 1 FROM messages WHERE blocks_json LIKE '%IndexedOrNothing%'")).toBeUndefined();
    expect(fake.steer).not.toHaveBeenCalled();
    // The Hub dies after the record (and its index) committed, before any answer.
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    const receipt = await send(chat.conversationId, "IndexedOrNothing", { delivery: "steer" }, requestId);
    expect(receipt.delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    expect((await openKeys()).map(row => row.key)).toEqual([`bot-messages:steer-open:target:${receipt.messageId}`]);
    await b.close(); b = await HubServer.start({ stateDir: path.join(root, "b") }); b.botMessages.steering = fake as unknown as BotMessageSteeringHooks;
    fake.reconcile.mockResolvedValueOnce({ outcome: "rejected", reason: "stale" });
    await b.botMessages.reconcileForBot("target");
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(await deliveries(receipt.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    expect(await openKeys()).toEqual([]);
  });

  const unconfirmed = async (title: string) => {
    const chat = await call(input("resolve", { newConversation: title })); await liveTurn(chat.conversationId);
    fake.steer.mockRejectedValueOnce(new HubError("bot_timeout", 504));
    return { chat, receipt: await send(chat.conversationId, `Lost ${title}`, { delivery: "steer" }) };
  };
  const steerAudits = async () => (await b.store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot-message.steer' ORDER BY id")).map(row => JSON.parse(row.detail_json));

  it("V4: one record that fails to settle does not stop the rest of the attach batch, and is audited", async () => {
    const first = await unconfirmed("One"), second = await unconfirmed("Two");
    fake.reconcile.mockResolvedValue({ outcome: "rejected", reason: "stale" });
    const original = b.store.fallBackBotSteer.bind(b.store); let thrown = "";
    vi.spyOn(b.store, "fallBackBotSteer").mockImplementation(async (messageId, ...rest) => {
      if (!thrown) { thrown = messageId; throw new HubError("bot_forbidden", 403); }
      return original(messageId, ...rest);
    });
    await b.botMessages.reconcileForBot("target");
    const other = [first.receipt.messageId, second.receipt.messageId].find(id => id !== thrown)!;
    expect(await deliveries(other)).toHaveLength(1);
    expect(await deliveries(thrown)).toEqual([]);
    expect(await steerAudits()).toContainEqual(expect.objectContaining({ messageId: thrown, outcome: "reconcile_failed", reason: "bot_forbidden" }));
  });

  it("V2: a worker without the steer capability ends this Bot's open steers as uncertain, never queued", async () => {
    const { chat, receipt } = await unconfirmed("Downgraded");
    await b.botMessages.closeOpenSteersForBot("target", "worker_without_steer");
    expect(fake.reconcile).not.toHaveBeenCalled();
    expect(await deliveries(receipt.messageId)).toEqual([]);
    expect(await wait(chat.conversationId, receipt.messageId)).toMatchObject({ status: "uncertain", delivery: { actual: "steer_uncertain" } });
    expect(await steerAudits()).toContainEqual(expect.objectContaining({ messageId: receipt.messageId, outcome: "steer_uncertain", reason: "worker_without_steer" }));
    expect(await openKeys()).toEqual([]);
  });

  it("V3: attach reconciliation rechecks the source's grant before queueing a recorded refusal", async () => {
    const { receipt } = await unconfirmed("Revoked");
    await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target", revoke: true }, guard);
    fake.reconcile.mockResolvedValue({ outcome: "rejected", reason: "stale" });
    await b.botMessages.reconcileForBot("target");
    expect(await deliveries(receipt.messageId)).toEqual([]);
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect((await blocks(receipt.messageId)).find(block => block.type === "steering")).toMatchObject({ outcome: "rejected", reason: "grant_revoked" });
    expect(await steerAudits()).toContainEqual(expect.objectContaining({ messageId: receipt.messageId, outcome: "not_delivered", reason: "grant_revoked" }));
    expect(await openKeys()).toEqual([]);
    // With the grant in place the same refusal is queued once (control).
    await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target" }, guard);
    const kept = await unconfirmed("Kept");
    await b.botMessages.reconcileForBot("target");
    expect(await deliveries(kept.receipt.messageId)).toHaveLength(1);
  });
});

describe("M3: blank steer text", () => {
  it("gets the queue path's own answer before any record or Gateway call", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const before = (await b.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages"))!.n;
    await expect(send(chat.conversationId, "", {})).rejects.toThrow("empty_message");
    await expect(send(chat.conversationId, "", { delivery: "steer" })).rejects.toThrow("empty_message");
    expect((await b.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages"))!.n).toBe(before);
    // Whitespace is accepted by the queue path, so it is queued, never steered.
    const blank = await send(chat.conversationId, "   ", { delivery: "steer" });
    expect(blank).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "blank_text" } });
    expect(await deliveries(blank.messageId)).toEqual([{ status: "pending", dispatched: 0 }]);
    expect(fake.status).not.toHaveBeenCalled(); expect(fake.steer).not.toHaveBeenCalled();
  });
});

describe("loop limits", () => {
  it("caps Bot steers per turn and per sender edge, then queues", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await send(chat.conversationId, `Fix ${i}`, { delivery: "steer" }));
    expect(results.map(r => r.delivery.actual)).toEqual(["steered", "steered", "steered", "fell_back_to_queue"]);
    expect(results[3]!.delivery.reason).toBe("turn_steer_limit");
    await resetRate();
    // Fresh turns: the edge allows 6 steers per 10 minutes in total.
    const edge = [];
    for (let i = 0; i < 4; i++) { const other = await call(input("resolve", { newConversation: `Edge ${i}` })); await liveTurn(other.conversationId); edge.push(await send(other.conversationId, `Edge ${i}`, { delivery: "steer" })); }
    expect(edge.map(r => r.delivery.actual)).toEqual(["steered", "steered", "steered", "fell_back_to_queue"]);
    expect(edge[3]!.delivery.reason).toBe("steer_rate_limited");
  });

  it("bounds two Bots that keep steering each other's live turns", async () => {
    // Both Bots live on Host B; each one's turn was started by the other.
    await b.botMessages.grant({ sourceHost: "Windows", sourceBot: "source", targetBot: "target" }, guard);
    await b.botMessages.grant({ sourceHost: "Windows", sourceBot: "target", targetBot: "source" }, guard);
    const local = (from: string, to: string, request: Omit<BotLocalRequest, "host" | "bot">) => b.botMessages.local({ ...request, host: "Windows", bot: to }, from, guard, true) as Promise<any>;
    const chats: Record<string, string> = {};
    for (const [from, to] of [["source", "target"], ["target", "source"]] as const) {
      chats[to] = (await local(from, to, { operation: "resolve", requestId: randomUUID(), data: {} })).conversationId;
      const task = await local(from, to, { operation: "send", conversation: chats[to], requestId: randomUUID(), data: { text: `Task for ${to}`, attachments: [] } });
      await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
      runs.set(chats[to]!, { targetId: `run_${to}`, sourceMessageId: task.messageId });
    }
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const [from, to] = i % 2 ? ["target", "source"] : ["source", "target"];
      const receipt = await local(from!, to!, { operation: "send", conversation: chats[to!], requestId: randomUUID(), data: { text: `Ping ${i}`, attachments: [], delivery: "steer" } });
      outcomes.push(receipt.delivery.actual);
    }
    expect(outcomes.filter(o => o === "steered")).toHaveLength(6);
    expect(outcomes.slice(6).every(o => o === "fell_back_to_queue")).toBe(true);
    expect(fake.steer).toHaveBeenCalledTimes(6);
  });
});

describe("receiving-host capability", () => {
  it("advertises steer support and lets a new sender downgrade against an older receiver", async () => {
    const chat = await resolve(); await liveTurn(chat.conversationId);
    const probes: string[] = [];
    vi.spyOn(source, "exchange").mockImplementation(async (_host, signed, body) => {
      probes.push(signed.passport.path);
      if (signed.passport.path === "/api/bot-messages/capabilities") throw new HubError("bot_message_operation_forbidden", 403);
      if (signed.passport.path === "/api/bot-messages/send") bodies.push(JSON.parse(body.toString("utf8")));
      return b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body);
    });
    const receipt = await send(chat.conversationId, "Old host", { delivery: "steer" });
    expect(probes).toContain("/api/bot-messages/capabilities");
    expect(bodies.at(-1)).toEqual({ text: "Old host", attachments: [] });
    expect(receipt).toMatchObject({ status: "queued", delivery: { requested: "steer", actual: "fell_back_to_queue", reason: "receiver_update_required" } });
    vi.mocked(source.exchange).mockRestore();
    const fresh = await send(chat.conversationId, "New host", { delivery: "steer" });
    expect(bodies.at(-1)).toEqual({ text: "New host", attachments: [], delivery: "steer" });
    expect(fresh.status).toBe("steered");
  });
});
