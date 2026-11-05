import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { nativeRun } from "../src/client-protocol/run.js";
import type { Block } from "../src/client-protocol/index.js";
import { renderCoreQueueWaitCard } from "../src/core/card-renderer.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { queueNotice } from "../src/client-protocol/queue-notice.js";
import { userReplyStatuses } from "../client/src/user-reply-status.js";

it.each(["queued", "started"] as const)("deleting a Bot retires its %s queue presentation without legacy controls", async state => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-bot-delete-")); const hub = await HubServer.start({ stateDir: root });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("fixture")]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES('alpha','owner','fixture','{}')");
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Queue deletion", "create")).id;
    const input = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "source", text: "Work", attachments: [] });
    const card = translateCard(renderCoreQueueWaitCard({ profile: "gateway", taskId: input.message.id, conversationKey: `lark:${chat}`, waitedMs: 0 }));
    card.extra!.appQueue = { ...(card.extra!.appQueue as Record<string, never>), state };
    if (state === "started") card.elements = card.elements.filter(e => e.type !== "button");
    const sent = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.message.id, status: state === "started" ? "streaming" : "complete", blocks: [card] });
    await hub.store.deleteBot("owner", "alpha", "Alpha");
    const retired = await hub.store.messageForUser("owner", sent.id);
    expect(retired.status).toBe("error");
    expect(retired.blocks[0]?.type === "card" && queueNotice(retired.blocks[0], retired)).toMatchObject({ state: "interrupted" });
    expect(JSON.stringify(retired.blocks)).not.toContain('"actionId"');
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it.each([{ legacy: false, started: false }, { legacy: true, started: false }, { legacy: false, started: true }])("settles orphan Core queue notices without replaying or touching live deliveries (%j)", async ({ legacy, started }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-recovery-"));
  const hub = await HubServer.start({ stateDir: root });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "Alpha", hashSecret(randomBytes(32).toString("base64url"))]);
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Queue recovery", "create")).id;
    const add = async (id: string, pending: boolean, at: number) => {
      const input = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: id, text: id, attachments: [] });
      if (!pending) await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [input.message.id]);
      const card = translateCard(renderCoreQueueWaitCard({ profile: "gateway", taskId: input.message.id, conversationKey: `lark:${chat}`, waitedMs: 1 }));
      if (legacy) delete card.extra!.appQueue;
      else card.extra!.appQueue = { ...(card.extra!.appQueue as Record<string, never>), at, state: started ? "started" : "queued" };
      if (started) card.elements = card.elements.filter(e => e.type !== "button");
      const message = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.message.id, blocks: [card], status: started ? "streaming" : "complete" });
      await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [at, message.id]);
      return { ...message, createdAt: at };
    };
    const before = Date.now();
    const orphan = await add("old", false, before - 10), pending = await add("pending", true, before - 10), current = await add("new", false, before);
    await hub.store.recoverOrphanRuns("alpha", before);
    const recovered = await hub.store.messageForUser("owner", orphan.id);
    expect(recovered.status).toBe("complete");
    expect(recovered.blocks[0]?.type === "card" && queueNotice(recovered.blocks[0], recovered)).toMatchObject({ state: "expired" });
    expect(recovered.blocks[0]).toMatchObject({ summary: "排队提示已失效" });
    expect(JSON.stringify(recovered.blocks)).not.toContain('"actionId"');
    expect(await hub.store.messageForUser("owner", pending.id)).toEqual(pending);
    expect(await hub.store.messageForUser("owner", current.id)).toEqual(current);
    await hub.store.recoverOrphanRuns("alpha", before);
    expect(await hub.store.messageForUser("owner", orphan.id)).toEqual(recovered);
    const done = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: orphan.replyTo, blocks: [block("done", "completed_elsewhere")] });
    const source = await hub.store.messageForUser("owner", orphan.replyTo!);
    expect(userReplyStatuses([source, done, recovered], chat, new Set(["alpha"])).get(source.id)?.[0]?.state).toBe("done");
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

function block(phase: "delivering" | "working" | "done", id: string): Block {
  return { type: "card", elements: [{ type: "markdown", text: "preserved answer" }], extra: { nativeRun: { version: 1, id, revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } };
}
it("a new worker closes orphan scheduled runs but a socket reconnect preserves the current run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orphan-runs-")), stateDir = path.join(root, "hub"), botDir = path.join(root, "bot");
  await mkdir(botDir); await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex" }));
  let hub = await HubServer.start({ stateDir }); const port = Number(new URL(hub.url).port), secret = randomBytes(32).toString("base64url");
  for (const id of ["alpha", "beta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
  const chat = (await hub.store.createConversation("owner", ["alpha", "beta"], "Recovery", "create")).id;
  const active = await hub.store.publishBotMessage("alpha", { conversationId: chat, status: "streaming", blocks: [block("working", "scheduled")] });
  const legacy = await hub.store.publishBotMessage("alpha", { conversationId: chat, status: "complete", blocks: [block("delivering", "goal")] });
  const done = await hub.store.publishBotMessage("alpha", { conversationId: chat, status: "complete", blocks: [block("done", "finished")] });
  const other = await hub.store.publishBotMessage("beta", { conversationId: chat, status: "streaming", blocks: [block("working", "other")] });
  await new Promise(resolve => setTimeout(resolve, 5));
  const engine = vi.fn(async () => ({ text: "Must not rerun" }));
  const channel = await attachGateway({ url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: botDir, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime(), recoverDeliveries: false });
  try {
    await vi.waitFor(async () => expect((await hub.store.messageForUser("owner", active.id)).status).toBe("error"), { timeout: 5000 });
    for (const message of [active, legacy]) {
      const recovered = await hub.store.messageForUser("owner", message.id), card = recovered.blocks[0]!;
      expect(card.type === "card" && nativeRun(card)).toMatchObject({ phase: "interrupted" });
      expect(JSON.stringify(recovered)).toContain("preserved answer");
    }
    expect(await hub.store.messageForUser("owner", done.id)).toEqual(done);
    expect(await hub.store.messageForUser("owner", other.id)).toEqual(other);
    const before = Date.now(), currentBlock = block("working", "current");
    if (currentBlock.type === "card") currentBlock.extra!.nativeRun = { ...nativeRun(currentBlock)!, startedAt: before, updatedAt: before };
    const current = await hub.store.publishBotMessage("alpha", { conversationId: chat, status: "streaming", blocks: [currentBlock] });
    await hub.store.recoverOrphanRuns("alpha", before);
    expect(await hub.store.messageForUser("owner", current.id)).toEqual(current);
    await hub.close(); hub = await HubServer.start({ stateDir, port });
    await channel.transport.request("conversation", { conversationId: chat });
    expect(await hub.store.messageForUser("owner", current.id)).toEqual(current);
    expect(engine).not.toHaveBeenCalled();
  } finally { await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 15000);

it("settles legacy complete envelopes with active native runs when their durable input fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legacy-run-recovery-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "Alpha", hashSecret(randomBytes(32).toString("base64url"))]);
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Legacy recovery", "create")).id;
    const { message: input } = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "input", text: "Finish the task", attachments: [] });
    const legacy = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.id, status: "complete", blocks: [block("delivering", "legacy")] });
    const done = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.id, status: "complete", blocks: [block("done", "completed")] });
    await hub.store.failDelivery("alpha", input.id, "interrupted");
    const recovered = await hub.store.messageForUser("owner", legacy.id), card = recovered.blocks[0]!;
    expect(recovered).toMatchObject({ status: "error", version: legacy.version + 1 });
    expect(card.type === "card" && nativeRun(card)).toMatchObject({ phase: "interrupted", revision: 2 });
    expect(JSON.stringify(recovered.blocks)).toContain("preserved answer");
    expect(await hub.store.messageForUser("owner", done.id)).toEqual(done);
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
    const snapshot = await hub.store.snapshot("owner", chat);
    await hub.store.failDelivery("alpha", input.id, "interrupted");
    expect(await hub.store.snapshot("owner", chat)).toEqual(snapshot);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it("keeps pending durable runs untouched until their receipt closes them after outbox replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pending-run-recovery-")), botDir = path.join(root, "bot");
  await mkdir(path.join(botDir, "gateway-receipts"), { recursive: true });
  await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  let channel: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "Alpha", hashSecret(secret)]);
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Pending recovery", "create")).id;
    const { message: input } = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "input", text: "Do this once", attachments: [] });
    const active = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.id, status: "streaming", blocks: [block("working", "pending")] });
    const snapshot = await hub.store.snapshot("owner", chat);
    await hub.store.recoverOrphanRuns("alpha", Date.now() + 1);
    expect(await hub.store.snapshot("owner", chat)).toEqual(snapshot);
    expect(await hub.store.pendingForBot("alpha")).toEqual([input]);
    await writeFile(path.join(botDir, "gateway-receipts", createHash("sha256").update(`message:${input.id}`).digest("hex") + ".json"), JSON.stringify({ state: "running" }));
    const saved = block("delivering", "pending");
    if (saved.type === "card") saved.elements = [{ type: "markdown", text: "Latest output survived in the outbox" }];
    await writeFile(path.join(botDir, "gateway-outbox.json"), JSON.stringify({ requests: [{ v: 1, type: "instance.request", id: "saved_output", method: "publish", params: { id: active.id, conversationId: chat, replyTo: input.id, version: 2, status: "complete", blocks: [saved] } }] }));
    const engine = vi.fn(async () => ({ text: "Must not repeat the side effect" }));
    channel = await attachGateway({ url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: botDir, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime(), recoverDeliveries: false });
    await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toEqual([]), { timeout: 5000 });
    const recovered = await hub.store.messageForUser("owner", active.id), card = recovered.blocks[0]!;
    expect(recovered).toMatchObject({ status: "error", version: 3 });
    expect(card.type === "card" && nativeRun(card)).toMatchObject({ phase: "interrupted" });
    expect(JSON.stringify(recovered.blocks)).toContain("Latest output survived in the outbox");
    expect(engine).not.toHaveBeenCalled();
  } finally { await channel?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it("settles an old scheduled run whose first publication only reached the durable outbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unpublished-run-recovery-")), botDir = path.join(root, "bot");
  await mkdir(botDir); await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  let channel: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["alpha", "Alpha", hashSecret(secret)]);
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Unpublished recovery", "create")).id;
    await writeFile(path.join(botDir, "gateway-outbox.json"), JSON.stringify({ requests: [{ v: 1, type: "instance.request", id: "old_scheduled_publication", method: "publish", params: { id: "unpublished_scheduled", conversationId: chat, version: 1, status: "streaming", blocks: [block("working", "old_scheduled")] } }] }));
    const engine = vi.fn(async () => ({ text: "Must not rerun" }));
    channel = await attachGateway({ url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: botDir, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime(), recoverDeliveries: false });
    await vi.waitFor(async () => expect((await hub.store.messageForUser("owner", "unpublished_scheduled")).status).toBe("error"), { timeout: 1500 });
    const recovered = await hub.store.messageForUser("owner", "unpublished_scheduled"), card = recovered.blocks[0]!;
    expect(card.type === "card" && nativeRun(card)).toMatchObject({ phase: "interrupted" });
    expect(JSON.stringify(recovered.blocks)).toContain("preserved answer");
    expect(engine).not.toHaveBeenCalled();
  } finally { await channel?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(["normal", "final-replay", "sweep-error"])("settles a cached complete receipt after restart (%s), without rerunning its input", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "completed-receipt-recovery-")), botDir = path.join(root, "bot");
  await mkdir(path.join(botDir, "gateway-receipts"), { recursive: true });
  await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  let channel: Awaited<ReturnType<typeof attachGateway>> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const chat = (await hub.store.createConversation("owner", ["alpha"], "Completed receipt", "create")).id;
    const { message: input } = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "input", text: "Do this once", attachments: [] });
    const active = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.id, status: "streaming", blocks: [block("working", "stale")] });
    const done = await hub.store.publishBotMessage("alpha", { conversationId: chat, replyTo: input.id, status: "complete", blocks: [block("done", "finished")] });
    await writeFile(path.join(botDir, "gateway-receipts", createHash("sha256").update(`message:${input.id}`).digest("hex") + ".json"), JSON.stringify({ state: "complete", result: { ok: true, result: null } }));
    if (mode === "final-replay") await writeFile(path.join(botDir, "gateway-outbox.json"), JSON.stringify({ requests: [{ v: 1, type: "instance.request", id: "saved_final", method: "publish", params: { id: active.id, conversationId: chat, replyTo: input.id, version: 2, status: "complete", blocks: [block("done", "stale")] } }] }));
    let current: Awaited<ReturnType<typeof hub.store.publishBotMessage>> | undefined;
    const ack = hub.store.acknowledgeDelivery.bind(hub.store);
    vi.spyOn(hub.store, "acknowledgeDelivery").mockImplementation(async (bot, id) => {
      await ack(bot, id);
      const live = block("working", "new-worker");
      if (live.type === "card") live.extra!.nativeRun = { ...nativeRun(live)!, startedAt: Date.now(), updatedAt: Date.now() };
      current = await hub.store.publishBotMessage("alpha", { conversationId: chat, status: "streaming", blocks: [live] });
    });
    const recover = hub.store.recoverOrphanRuns.bind(hub.store); let sweeps = 0;
    vi.spyOn(hub.store, "recoverOrphanRuns").mockImplementation(async (...args) => {
      sweeps++;
      if (mode === "sweep-error" && sweeps === 2) throw new Error("transient sweep failure");
      return recover(...args);
    });
    const warnings: string[] = [];
    const engine = vi.fn(async () => ({ text: "Must not repeat" }));
    channel = await attachGateway({ url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: botDir, bridge: { handleAuthorizedMessage: engine }, runtime: createCoreServiceRuntime(), recoverDeliveries: false, onWarning: code => warnings.push(code) });
    await vi.waitFor(() => expect(sweeps).toBe(2), { timeout: 1500 });
    const status = mode === "normal" ? "error" : mode === "final-replay" ? "complete" : "streaming";
    await vi.waitFor(async () => expect((await hub.store.messageForUser("owner", active.id)).status).toBe(status));
    if (mode === "sweep-error") {
      await vi.waitFor(() => expect(warnings).toEqual(["gateway_run_recovery_failed"]));
      await channel.transport.request("conversation", { conversationId: chat });
      expect(sweeps).toBe(2); // No forced reconnect or replay of a settled input.
    }
    const recovered = await hub.store.messageForUser("owner", active.id);
    expect(recovered.blocks[0]!.type === "card" && nativeRun(recovered.blocks[0]!)).toMatchObject({ phase: mode === "normal" ? "interrupted" : mode === "final-replay" ? "done" : "working" });
    expect(await hub.store.messageForUser("owner", current!.id)).toEqual(current);
    expect(JSON.stringify(recovered)).toContain("preserved answer");
    expect(await hub.store.messageForUser("owner", done.id)).toEqual(done);
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
    expect(engine).not.toHaveBeenCalled();
  } finally { await channel?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});

it("only decodes active recovery candidates instead of complete native-run history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bounded-run-recovery-"));
  const hub = await HubServer.start({ stateDir: root });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
    const chat = await hub.store.createConversation("owner", ["alpha"], "Long history", "history");
    const done = JSON.stringify([block("done", "finished")]);
    await hub.store.db.transaction(async () => {
      for (let i = 0; i < 2000; i++) await hub.store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,?,'alpha','bot',?,'complete',1,1)", [`history_${i}`, chat.id, done]);
    });
    const active = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, status: "streaming", blocks: [block("working", "active")] });
    const decode = vi.spyOn(hub.store as any, "decodeMessage");
    await hub.store.recoverOrphanRuns("alpha", Date.now());
    expect(decode).toHaveBeenCalledTimes(1);
    decode.mockRestore();
    expect((await hub.store.messageForUser("owner", active.id)).status).toBe("error");
    expect(await hub.store.db.get("SELECT count(*) AS count FROM messages WHERE id LIKE 'history_%' AND status='complete' AND version=1")).toEqual({ count: 2000 });
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
