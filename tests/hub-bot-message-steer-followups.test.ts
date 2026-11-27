import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotMessages } from "../src/hub/bot-messages.js";
import { hashSecret } from "../src/hub/auth.js";
import { networkId } from "../src/hub/private-network.js";
import { networkManifestSchema } from "../src/client-protocol/private-network.js";
import type { Block } from "../src/client-protocol/index.js";
import type { BotLocalRequest } from "../src/client-protocol/bot-messages.js";
import type { BotMessageSteeringHooks } from "../src/hub/bot-message-steering.js";

let root: string, a: HubServer, b: HubServer, source: BotMessages, bodies: Record<string, unknown>[];
const guard = async () => undefined;
type Fake = { capable: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn>; reconcile: ReturnType<typeof vi.fn>; dispatch: ReturnType<typeof vi.fn> };
let fake: Fake;
/** One live run per conversation, as a Gateway reports it. */
let runs: Map<string, { targetId: string; sourceMessageId: string }>;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-steer-followups-"));
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
const steering = async (messageId: string) => (JSON.parse((await b.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [messageId]))!.blocks_json) as Block[]).find(block => block.type === "steering") as Extract<Block, { type: "steering" }> | undefined;
/** A live turn on the receiving Host that the sending Bot started with a queued message. */
async function liveTurn() {
  const conversation = (await resolve()).conversationId as string;
  const first = await send(conversation, "Start the long task");
  await b.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [first.messageId]);
  runs.set(conversation, { targetId: "run_live", sourceMessageId: first.messageId });
  return { conversation, turn: first.messageId as string };
}

describe("Bot steer follow-ups", () => {
  it("reports a steer the engine adopted after the Gateway could not tell as steered to the sender", async () => {
    const { conversation, turn } = await liveTurn();
    fake.steer.mockResolvedValueOnce({ outcome: "unknown", reason: "uncertain" });
    const sent = await send(conversation, "Also check the flaky test", { delivery: "steer" }, "req-late-adoption");
    expect(sent.delivery).toMatchObject({ actual: "steer_uncertain" });
    // The native adoption receipt arrives afterwards (Claude confirmed after the Gateway gave up waiting).
    const record = (await b.store.db.get<{ client_msg_id: string }>("SELECT client_msg_id FROM messages WHERE id=?", [sent.messageId]))!;
    await b.store.applySteeringOutcome("target", { conversationId: conversation, userId: "owner", requestId: record.client_msg_id, targetId: "run_live", application: { status: "applied", via: "fold" } });
    expect((await steering(sent.messageId))?.application).toEqual({ status: "applied", via: "fold" });
    const replay = await send(conversation, "Also check the flaky test", { delivery: "steer" }, "req-late-adoption");
    expect(replay.delivery).toMatchObject({ actual: "steered", turn: { messageId: turn } });
    expect(await wait(conversation, sent.messageId)).toMatchObject({ delivery: { actual: "steered" }, reply: { kind: "merged_turn", turnMessageId: turn } });
    expect(fake.steer).toHaveBeenCalledTimes(1);
  });

  it("settles a steer whose call was lost while a new worker attached, without the sender asking again", async () => {
    const { conversation, turn } = await liveTurn();
    let lose!: (error: Error) => void;
    fake.steer.mockImplementationOnce(() => new Promise((_resolve, reject) => { lose = reject; }));
    const pending = send(conversation, "Also check the flaky test", { delivery: "steer" }, "req-lost-call");
    await vi.waitFor(() => expect(fake.steer).toHaveBeenCalledTimes(1));
    // The replacement worker attaches while the original call is still awaited: its attach pass skips the record.
    await b.botMessages.reconcileForBot("target");
    expect(fake.reconcile).not.toHaveBeenCalled();
    fake.reconcile.mockResolvedValue({ outcome: "accepted", sourceMessageId: turn });
    lose(new Error("worker_replaced"));
    const receipt = await pending;
    expect(receipt.delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    await vi.waitFor(async () => expect((await steering(receipt.messageId))?.outcome).toBe("accepted"));
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => expect(await b.store.db.get("SELECT 1 FROM meta WHERE key LIKE 'bot-messages:steer-open:%'")).toBeUndefined());
  });

  it("offers the steering switch for a dispatcher on a supported engine, and hides internal workers", async () => {
    expect(await b.botMessages.readSteering("owner", "target", guard)).toMatchObject({ supported: true });
    await b.store.db.run("UPDATE bots SET role='dispatcher' WHERE id='target'");
    expect(await b.botMessages.readSteering("owner", "target", guard)).toMatchObject({ botId: "target", supported: true, allowed: true });
    await b.store.db.run("UPDATE bots SET role='worker' WHERE id='target'");
    await expect(b.botMessages.readSteering("owner", "target", guard)).rejects.toThrow("bot_not_found");
  });
});
