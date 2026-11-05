import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { conversationFiles } from "../src/hub/conversation-files.js";
import { deletedMessage } from "../src/client-protocol/message-deletion.js";
import { clearMessagesPlanSchema, clearMessagesResultSchema, hasPendingCardAction } from "../src/client-protocol/message-clear.js";
import type { SnapshotFrame } from "../src/client-protocol/snapshot.js";
import type { Block, HubEvent, Message } from "../src/client-protocol/index.js";

let root: string, store: HubStore, conversationId: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "personal-clear-")); store = await HubStore.open(root);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member'),('outsider','Outsider','member')");
  conversationId = (await store.createConversation("owner", ["bot"], "Chat", "chat")).id;
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [conversationId]);
});
afterEach(async () => { await store?.db.close().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
const publish = (text: string, status: Message["status"] = "complete", replyTo?: string) => store.publishBotMessage("bot", { conversationId, blocks: [{ type: "text", text }], status, ...(replyTo ? { replyTo } : {}) });
const shared = () => store.db.all("SELECT id,blocks_json,status,version FROM messages ORDER BY rowid");
const deliveries = () => store.db.all("SELECT * FROM deliveries ORDER BY rowid");
const head = async () => (await store.syncHead("owner", conversationId)).seq;

it("plans and clears personal history in insertion order without a full-conversation sort", async () => {
  const first = await publish("first"), second = await publish("second"), last = await publish("last");
  // Creation timestamps need not follow insertion order (imports/clock skew).
  await store.db.run("UPDATE messages SET created_at=CASE id WHEN ? THEN 300 WHEN ? THEN 200 ELSE 100 END", [first.id, second.id]);
  const reads = vi.spyOn(store.db, "get"), pages = vi.spyOn(store.db, "all");
  const plan = await store.planClearMessages("owner", conversationId);
  expect(plan).toEqual({ throughId: last.id, count: 3 });
  expect((await store.clearMessages("owner", conversationId, { throughId: last.id })).clearedIds).toEqual([first.id, second.id, last.id]);
  const queries = [...reads.mock.calls, ...pages.mock.calls].filter(([sql]) => sql.includes("FROM messages WHERE conversation_id=?") && (sql.includes("ORDER BY rowid") || sql.includes("COUNT(*)")));
  expect(queries).toHaveLength(4); // Plan tail/count, clear page/remaining.
  reads.mockRestore(); pages.mockRestore();
  for (const [sql, params] of queries) {
    const details = (await store.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)).map(row => row.detail).join("\n");
    expect(details).toContain("USING INDEX messages_personal_history");
    expect(details).not.toContain("TEMP B-TREE");
  }
});

it("clears oldest first in bounded pages up to a fixed cutoff, as repeated personal deletions only", async () => {
  const input = (await store.sendMessage("owner", { conversationId, clientMsgId: "input", text: "searchable input", attachments: [] })).message;
  await store.acknowledgeDelivery("bot", input.id);
  const history: Message[] = [input];
  for (let index = 0; index < 232; index++) history.push(await publish(`searchable answer ${index}`));
  await store.deleteMessages("owner", conversationId, { messageIds: [history[5]!.id, history[6]!.id] });
  const plan = clearMessagesPlanSchema.parse(await store.planClearMessages("owner", conversationId));
  expect(plan).toEqual({ throughId: history.at(-1)!.id, count: 231 });
  // Arrives after the reviewed boundary: never selected by any page.
  const late = await publish("late answer");
  const before = { shared: await shared(), deliveries: await deliveries() }, events: HubEvent[] = [];
  store.subscribe(event => events.push(event));
  const decode = vi.spyOn(store as unknown as { decodeMessage: (row: unknown) => Message }, "decodeMessage");
  const pages = [];
  for (let page = 0; page < 4; page++) pages.push(clearMessagesResultSchema.parse(await store.clearMessages("owner", conversationId, { throughId: plan.throughId! })));
  expect(decode).not.toHaveBeenCalled();
  expect(pages.map(page => [page.clearedIds.length, page.remaining])).toEqual([[100, 131], [100, 31], [31, 0], [0, 0]]);
  const expected = history.filter((_, index) => index !== 5 && index !== 6).map(message => message.id);
  expect(pages.flatMap(page => page.clearedIds)).toEqual(expected);
  expect(pages.at(-1)!.seq).toBe(pages.at(-2)!.seq);
  expect(pages.at(-1)!.seq).toBe(await head());
  // One personal tombstone per cleared message, identical to deleteMessages.
  const deleted = events.filter(event => event.kind === "message.deleted");
  expect(deleted.map(event => (event.payload as { message: Message }).message)).toEqual(history.filter((_, index) => index !== 5 && index !== 6).map(deletedMessage));
  expect(deleted.every(event => (event.payload as { userId: string }).userId === "owner")).toBe(true);
  expect(events.every(event => event.kind === "message.deleted")).toBe(true);
  expect(Math.max(...deleted.map(event => event.seq))).toBe(pages.at(-2)!.seq);
  expect(await shared()).toEqual(before.shared);
  expect(await deliveries()).toEqual(before.deliveries);
  expect((await store.listMessages("owner", conversationId)).messages).toEqual([late]);
  expect((await store.listMessages("member", conversationId)).messages).toHaveLength(50);
  expect(await store.planClearMessages("owner", conversationId)).toEqual({ throughId: late.id, count: 1 });
  expect(await store.planClearMessages("member", conversationId)).toEqual({ throughId: late.id, count: 234 });
  expect(await store.search("owner", "searchable")).toEqual([]);
  expect(await store.search("member", "searchable")).toHaveLength(100);
  await expect(store.sendMessage("owner", { conversationId, clientMsgId: "reply", text: "reply", replyTo: history[0]!.id, attachments: [] })).rejects.toThrow("reply_not_found");
  expect((await conversationFiles(store, "owner", { conversationId, q: "" })).items).toEqual([]);
}, 30_000);

type Card = Extract<Block, { type: "card" }>;
const questionForm = (options: { disabled?: boolean; parentDisabled?: boolean; buttonValue?: boolean } = {}): Card => ({ type: "card", elements: [{ type: "columns", ...(options.parentDisabled ? { disabled: true } : {}), children: [{
  type: "form", actionId: "form", extra: { tarocub_questions: { version: 1, requestId: "question", questions: [{ question: "Which?", header: "Pick", multiSelect: false, required: true, allowFreeText: true, options: [{ label: "A" }] }] } },
  children: [{ type: "button", name: "askq_submit", actionId: "askq_submit", extra: { form_action_type: "submit" }, ...(options.disabled ? { disabled: true } : {}),
    ...(options.buttonValue === false ? {} : { value: { cctb_lark: "ask_user_question", action: "form_submit", requestId: "question" } }) }] }] }] });
const approval = (button: Record<string, unknown> = {}, parent: Record<string, unknown> = {}): Card => ({ type: "card", elements: [{ type: "columns", ...parent, children: [
  { type: "button", actionId: "allow", value: { cctb_lark: "approval", requestId: "approval", decision: "allow_once" }, ...button }] }] });
const run = (key: "nativeRun" | "scopedRun" | "answerFollowup", phase: string): Card => ({ type: "card", elements: [], extra: { [key]: { phase } } });
const card = (block: Card, status: Message["status"] = "complete") => store.publishBotMessage("bot", { conversationId, blocks: [block], status });
const refuses = async (throughId: string) => {
  const before = { deletions: await store.db.all("SELECT * FROM message_deletions ORDER BY message_id"), head: await head(), deliveries: await deliveries() };
  await expect(store.clearMessages("owner", conversationId, { throughId })).rejects.toMatchObject({ code: "message_clear_active", status: 409 });
  expect({ deletions: await store.db.all("SELECT * FROM message_deletions ORDER BY message_id"), head: await head(), deliveries: await deliveries() }).toEqual(before);
};

it.each([
  ["a running reply", () => publish("partial", "streaming")],
  ["a pending reply", () => publish("", "pending")],
  ["an input still waiting for a Bot", async () => (await store.sendMessage("owner", { conversationId, clientMsgId: "queued", text: "queued", attachments: [] })).message],
  ["an async question in a complete message", () => card(questionForm())],
  ["a form-only question without a callback value", () => card(questionForm({ buttonValue: false }))],
  ["an approval in a complete message", () => card(approval())],
  ["an active background run", () => card(run("scopedRun", "working"))],
  ["an active foreground run card", () => card(run("nativeRun", "waiting_answer"))],
  ["a queued answer follow-up", () => card(run("answerFollowup", "queued"))],
  ["a processing answer follow-up", () => card(run("answerFollowup", "processing"))],
])("refuses the whole page without writing when it reaches %s", async (_, create) => {
  const blocker = await create();
  const later = await publish("ordinary");
  await refuses(later.id);
  expect((await store.listMessages("owner", conversationId)).messages.map(message => message.id)).toEqual([later.id, blocker.id]);
});

it.each([
  ["a disabled question button", () => questionForm({ disabled: true })],
  ["a question under a disabled parent", () => questionForm({ parentDisabled: true })],
  ["a disabled approval button", () => approval({ disabled: true })],
  ["an approval under a disabled parent", () => approval({}, { disabled: true })],
  ["a link button", () => approval({ url: "https://example.invalid/approve" })],
  ["an approval without a decision", () => approval({ value: { cctb_lark: "approval", requestId: "approval" } })],
  ["an approval without a request", () => approval({ value: { cctb_lark: "approval", requestId: "", decision: "deny" } })],
  ["a finished foreground run", () => run("nativeRun", "done")],
  ["a finished background run", () => run("scopedRun", "stopped")],
  ["a settled answer follow-up", () => run("answerFollowup", "submitted")],
])("clears %s", async (_, block) => {
  const message = await card(block());
  expect(await store.clearMessages("owner", conversationId, { throughId: message.id })).toMatchObject({ clearedIds: [message.id], remaining: 0 });
});

it("matches the App's actionable question/approval projection for every card fixture", async () => {
  const { messageAttention } = await import("../client/src/attention.js");
  const blocks: Card[] = [questionForm(), questionForm({ buttonValue: false }), questionForm({ disabled: true }), questionForm({ parentDisabled: true }),
    approval(), approval({ disabled: true }), approval({}, { disabled: true }), approval({ url: "https://example.invalid/approve" }),
    approval({ value: { cctb_lark: "approval", requestId: "approval" } }), approval({ value: { cctb_lark: "approval", requestId: "", decision: "deny" } }),
    approval({ value: { cctb_lark: "approval", requestId: "approval", decision: "allow_session" } }), approval({ actionId: undefined }),
    { type: "card", elements: [{ type: "form", actionId: "form", extra: { tarocub_questions: { version: 2 } }, children: [{ type: "button", name: "askq_submit", actionId: "askq_submit", extra: { form_action_type: "submit" } }] }] },
    run("scopedRun", "working")];
  for (const block of blocks) {
    const message: Message = { id: "msg_fixture", conversationId, authorId: "bot", authorType: "bot", blocks: [block], status: "complete", version: 1, createdAt: 1 };
    expect([JSON.stringify(block), hasPendingCardAction(JSON.parse(JSON.stringify(message.blocks)))]).toEqual([JSON.stringify(block), !!messageAttention(message)]);
  }
});

it("ignores errored cards and forwarded copies, and never inspects messages after the cutoff", async () => {
  const failed = await store.publishBotMessage("bot", { conversationId, blocks: [approval()], status: "error" });
  const source = await card(questionForm()), other = await store.createConversation("owner", ["bot"], "Other", "other");
  const forwarded = (await store.forwardMessage("owner", { v: 1, type: "message.forward", conversationId: other.id, clientMsgId: "forward", sourceMessageId: source.id }, async () => {})).message;
  await store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [forwarded.id]);
  expect(await store.clearMessages("owner", other.id, { throughId: forwarded.id })).toMatchObject({ clearedIds: [forwarded.id], remaining: 0 });
  await refuses(source.id);
  await store.publishBotMessage("bot", { id: source.id, conversationId, blocks: [questionForm({ disabled: true })], status: "complete" });
  const { throughId } = await store.planClearMessages("owner", conversationId);
  // Unfinished work that arrives after the reviewed boundary never blocks it.
  const later = [await publish("live", "streaming"), await card(questionForm()), await card(approval()), await card(run("scopedRun", "working"))];
  expect(await store.clearMessages("owner", conversationId, { throughId: throughId! })).toMatchObject({ clearedIds: [failed.id, source.id], remaining: 0 });
  expect((await store.listMessages("owner", conversationId)).messages.map(message => message.id)).toEqual(later.map(message => message.id).reverse());
});

it("keeps earlier committed pages when a later page reaches active work, then continues with the same cutoff", async () => {
  const history: Message[] = [];
  for (let index = 0; index < 150; index++) history.push(index === 120 ? await card(approval()) : await publish(`answer ${index}`));
  const { throughId } = await store.planClearMessages("owner", conversationId);
  expect(await store.clearMessages("owner", conversationId, { throughId: throughId! })).toMatchObject({ remaining: 50 });
  const before = await deliveries();
  await refuses(throughId!);
  expect(await store.planClearMessages("owner", conversationId)).toEqual({ throughId, count: 50 });
  // A resolved approval disables its buttons in place; the next page proceeds.
  await store.publishBotMessage("bot", { id: history[120]!.id, conversationId, blocks: [approval({}, { disabled: true })], status: "complete" });
  expect(await store.clearMessages("owner", conversationId, { throughId: throughId! })).toMatchObject({ remaining: 0 });
  expect(await deliveries()).toEqual(before);
  expect((await store.listMessages("member", conversationId)).messages).toHaveLength(50);
}, 30_000);

it("leaves queued and running work executing while it refuses, and resumes after the Bot finishes", async () => {
  const done = (await store.sendMessage("owner", { conversationId, clientMsgId: "done", text: "done", attachments: [] })).message;
  await store.acknowledgeDelivery("bot", done.id);
  const running = await publish("partial", "streaming", done.id);
  await refuses(running.id);
  expect((await store.pendingForBot("bot"))).toEqual([]);
  const final = await store.publishBotMessage("bot", { id: running.id, conversationId, blocks: [{ type: "text", text: "final" }], status: "complete", replyTo: done.id });
  expect(await store.clearMessages("owner", conversationId, { throughId: final.id })).toMatchObject({ clearedIds: [done.id, running.id], remaining: 0 });
});

it("checks membership, transaction-time auth and the cutoff's conversation on every page before any change", async () => {
  const message = await publish("keep"), other = await store.createConversation("owner", ["bot"], "Other", "other");
  const foreign = await store.publishBotMessage("bot", { conversationId: other.id, blocks: [] });
  await expect(store.planClearMessages("outsider", conversationId)).rejects.toThrow("conversation_forbidden");
  await expect(store.clearMessages("outsider", conversationId, { throughId: message.id })).rejects.toThrow("conversation_forbidden");
  for (const throughId of [foreign.id, "missing"]) await expect(store.clearMessages("owner", conversationId, { throughId })).rejects.toThrow("message_not_found");
  await expect(store.clearMessages("owner", conversationId, { throughId: message.id }, async () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  await expect(store.clearMessages("owner", conversationId, { throughId: message.id, extra: true } as never)).rejects.toThrow();
  expect(await store.db.all("SELECT * FROM message_deletions")).toEqual([]);
  expect(await store.planClearMessages("owner", other.id)).toEqual({ throughId: foreign.id, count: 1 });
  expect(await store.planClearMessages("owner", (await store.createConversation("owner", ["bot"], "Empty", "empty")).id)).toEqual({ count: 0 });
});

it("never resurrects cleared messages for a device reconnecting by replay, merge snapshot or after restart", async () => {
  const messages: Message[] = [];
  for (let index = 0; index < 120; index++) messages.push(await publish(`answer ${index}`));
  const after = await head();
  const { throughId } = await store.planClearMessages("owner", conversationId);
  while ((await store.clearMessages("owner", conversationId, { throughId: throughId! })).remaining);
  const replayed = new Map<string, Message>();
  for (let cursor = after, more = true; more;) {
    const page = await store.sync("owner", conversationId, cursor);
    for (const event of page.events) { cursor = event.seq; if (event.kind === "message.updated") replayed.set((event.payload as Message).id, event.payload as Message); }
    more = page.more && page.events.length > 0;
  }
  expect([...replayed.keys()].sort()).toEqual(messages.map(message => message.id).sort());
  expect([...replayed.values()].every(message => message.status === "deleted" && !message.blocks.length)).toBe(true);
  const frames: SnapshotFrame[] = []; for await (const frame of store.snapshotFrames("owner", conversationId, after, { incremental: true })) frames.push(frame);
  expect(frames[0]).toMatchObject({ type: "snapshot.begin", mode: "merge" });
  const merged = frames.flatMap(frame => frame.type === "snapshot.message" ? [frame.message] : []);
  expect(merged.map(message => message.id).sort()).toEqual(messages.map(message => message.id).sort());
  expect(merged.every(message => message.status === "deleted" && !message.blocks.length)).toBe(true);
  await store.db.close(); store = await HubStore.open(root);
  expect(await store.planClearMessages("owner", conversationId)).toEqual({ count: 0 });
  expect((await store.clearMessages("owner", conversationId, { throughId: throughId! })).clearedIds).toEqual([]);
  expect((await store.listMessages("member", conversationId)).messages).toHaveLength(50);
});

it("serves the plan and pages over authenticated HTTP without calling a Bot", async () => {
  await store.db.close();
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "personal-clear-http-")), hub = await HubServer.start({ stateDir: hubRoot });
  try {
    const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pairing = await hub.auth.pair({ deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
    await hub.auth.approve(pairing.code, "local-owner");
    const challenge = await hub.auth.challenge("device", "device", nonce, "fixture"), session = await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Fixture','fixture')");
    const chat = (await hub.store.createConversation("owner", ["bot"], "Chat", "http")).id, other = (await hub.store.createConversation("owner", ["bot"], "Other", "http-other")).id;
    for (let index = 0; index < 3; index++) await hub.store.publishBotMessage("bot", { conversationId: chat, blocks: [{ type: "text", text: `answer ${index}` }] });
    const foreign = await hub.store.publishBotMessage("bot", { conversationId: other, blocks: [] });
    const callBot = vi.spyOn(hub as unknown as { callBot: () => Promise<unknown> }, "callBot");
    const url = `${hub.url}/api/conversations/${chat}/messages/clear`, headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
    expect((await fetch(url)).status).toBe(401);
    const plan = clearMessagesPlanSchema.parse(await (await fetch(url, { headers })).json());
    expect(plan.count).toBe(3);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ throughId: plan.throughId, extra: 1 }) })).status).toBe(400);
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ throughId: foreign.id }) })).status).toBe(404);
    const result = clearMessagesResultSchema.parse(await (await fetch(url, { method: "POST", headers, body: JSON.stringify({ throughId: plan.throughId }) })).json());
    expect(result).toMatchObject({ throughId: plan.throughId, remaining: 0 });
    expect(result.clearedIds).toHaveLength(3);
    expect(result.seq).toBe((await hub.store.syncHead("owner", chat)).seq);
    expect(clearMessagesPlanSchema.parse(await (await fetch(url, { headers })).json())).toEqual({ count: 0 });
    expect(callBot).not.toHaveBeenCalled();
  } finally { await hub.close(); await rm(hubRoot, { recursive: true, force: true }); }
});
