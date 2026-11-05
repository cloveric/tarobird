import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { conversationFiles } from "../src/hub/conversation-files.js";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubGroupDiscussions } from "../src/hub/group-discussions.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { parseClientFrame, type Block, type Conversation } from "../src/client-protocol/index.js";
import type { GroupDiscussionRun, GroupDiscussionStep, GroupStance } from "../src/client-protocol/group-discussion.js";

const bots = ["alpha", "beta", "gamma"] as const;
type StopHook = (botId: string, conversationId: string, messageId: string) => Promise<unknown>;
let root: string, hub: HubServer, service: HubGroupDiscussions, stop: ReturnType<typeof vi.fn<StopHook>>, capable: Map<string, boolean | undefined>;
let request = 0;
const rid = (tag = "r") => `${tag}-${++request}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-group-discussion-"));
  hub = await HubServer.start({ stateDir: root });
  for (const id of [...bots, "delta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `Name ${id}`, "fixture"]);
  await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  stop = vi.fn<StopHook>(async () => ({ stopped: true })); capable = new Map();
  service = new HubGroupDiscussions(hub.store, { workerCapable: botId => capable.get(botId), stop });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

const group = (botIds: string[] = [...bots], title = "Group") => hub.store.createConversation("owner", botIds, title, rid("group"), { type: "group" });
const settings = (id: string) => hub.store.groupSettings("owner", id);
async function mode(conversation: Conversation, policy: { mode: "mentions" | "sequential" | "independent"; botOrder?: string[]; maxRounds?: number }) {
  const current = await settings(conversation.id);
  await hub.store.updateGroup("owner", conversation.id, { title: current.group.title, botIds: current.group.botIds, expectedTitle: current.group.title, expectedBotIds: current.group.botIds,
    policy: { mode: policy.mode, botOrder: policy.botOrder ?? current.policy.botOrder, maxRounds: policy.maxRounds ?? current.policy.maxRounds }, expectedRevision: current.revision });
  return settings(conversation.id);
}
async function start(conversationId: string, text = "Pick a database", groupId = conversationId) {
  return service.start("owner", conversationId, { requestId: rid("start"), revision: (await settings(groupId)).revision, text });
}
const view = async (conversationId: string) => (await service.view("owner", conversationId)).run!;
const runCard = (phase: string, text = ""): Block => ({ type: "card", elements: [{ type: "markdown", text }], extra: { nativeRun: { version: 1, id: `run_${request++}`, revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } });
const active = (run: GroupDiscussionRun) => run.steps.filter(step => step.status === "running" || step.status === "queued");
const dispatch = (step: GroupDiscussionStep) => hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [step.inputMessageId!, step.botId]);
/** Simulates one worker turn through the same Hub APIs the Gateway uses. */
async function speak(conversationId: string, step: GroupDiscussionStep, text: string, stance?: GroupStance | Record<string, unknown>, options: { phase?: string; report?: boolean; ack?: boolean } = {}) {
  await dispatch(step);
  if (options.report !== false) await service.report(step.botId, { messageId: step.inputMessageId!, turnId: step.id, text, ...(stance ? { stance } : {}) });
  const reply = await hub.store.publishBotMessage(step.botId, { conversationId, replyTo: step.inputMessageId!, blocks: [runCard(options.phase ?? "done", text)], status: "complete" });
  await service.published(step.botId, reply);
  if (options.ack !== false) { await hub.store.acknowledgeDelivery(step.botId, step.inputMessageId!); await service.settleInput(step.botId, step.inputMessageId!); }
  return reply;
}
const next = async (conversationId: string) => { const run = await view(conversationId); return { run, step: active(run)[0]! }; };

describe("group settings and the mention delivery rule", () => {
  it("saves policy-only edits, keeps old-client saves from resetting them and checks the full revision", async () => {
    const chat = await group();
    const initial = await settings(chat.id);
    expect(initial.policy).toEqual({ mode: "mentions", botOrder: ["alpha", "beta", "gamma"], maxRounds: 3 });
    const changed = await mode(chat, { mode: "sequential", botOrder: ["gamma", "alpha", "beta"], maxRounds: 2 });
    expect(changed.policy).toEqual({ mode: "sequential", botOrder: ["gamma", "alpha", "beta"], maxRounds: 2 });
    expect(changed.revision).not.toBe(initial.revision);
    // A replay of the same edit after a lost response is a read.
    const body = { title: "Group", botIds: [...bots], expectedTitle: "Group", expectedBotIds: [...bots], policy: changed.policy, expectedRevision: initial.revision };
    await expect(hub.store.updateGroup("owner", chat.id, body)).resolves.toHaveLength(1);
    // A stale policy view is rejected; an old client (no policy) keeps the mode.
    await expect(hub.store.updateGroup("owner", chat.id, { ...body, policy: { ...changed.policy, maxRounds: 4 } })).rejects.toThrow("group_settings_conflict");
    await hub.store.updateGroup("owner", chat.id, { title: "Renamed", botIds: [...bots, "delta"], expectedTitle: "Group", expectedBotIds: [...bots] });
    expect((await settings(chat.id)).policy).toEqual({ mode: "sequential", botOrder: ["gamma", "alpha", "beta", "delta"], maxRounds: 2 });
    const current = await settings(chat.id);
    await expect(hub.store.updateGroup("owner", chat.id, { title: "Renamed", botIds: current.group.botIds, expectedTitle: "Renamed", expectedBotIds: current.group.botIds, policy: { ...current.policy, botOrder: ["alpha", "beta"] }, expectedRevision: current.revision })).rejects.toThrow("group_discussion_order_invalid");
    await expect(hub.store.updateGroup("owner", chat.id, { title: "Renamed", botIds: current.group.botIds, expectedTitle: "Renamed", expectedBotIds: current.group.botIds, policy: current.policy } as never)).rejects.toThrow("policy_revision_pair");
    const single = await group(["alpha"], "Solo");
    const solo = await settings(single.id);
    await expect(hub.store.updateGroup("owner", single.id, { title: "Solo", botIds: ["alpha"], expectedTitle: "Solo", expectedBotIds: ["alpha"], policy: { ...solo.policy, mode: "independent" }, expectedRevision: solo.revision })).rejects.toThrow("group_discussion_member_count");
    // Restarting keeps the saved policy (schema 21 state).
    await hub.close(); hub = await HubServer.start({ stateDir: root }); service = new HubGroupDiscussions(hub.store, { workerCapable: () => undefined, stop });
    expect((await settings(chat.id)).policy.mode).toBe("sequential");
    expect(await hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "25" });
  });

  it("delivers group input only to mentioned Bots; direct chats are unchanged", async () => {
    const chat = await group();
    const note = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "note", text: "just a note", attachments: [] });
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [note.message.id])).toEqual([]);
    const two = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "two", text: "hi", attachments: [], mentions: ["alpha", "gamma"] });
    expect((await hub.store.db.all<{ bot_id: string }>("SELECT bot_id FROM deliveries WHERE message_id=? ORDER BY bot_id", [two.message.id])).map(row => row.bot_id)).toEqual(["alpha", "gamma"]);
    const topic = await hub.store.createConversation("owner", [], "Topic", "topic", { parentId: chat.id });
    const topicNote = await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: "topic-note", text: "note", attachments: [] });
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [topicNote.message.id])).toEqual([]);
    const direct = await hub.store.createConversation("owner", ["alpha"], "Direct", "direct");
    const plain = await hub.store.sendMessage("owner", { conversationId: direct.id, clientMsgId: "direct", text: "hello", attachments: [] });
    expect(await hub.store.pendingForBot("alpha")).toEqual(expect.arrayContaining([expect.objectContaining({ id: plain.message.id })]));
  });
});

describe("discussion start", () => {
  it("rejects invisible-only topics and notes without creating tasks or messages", async () => {
    const chat = await group(); const current = await mode(chat, { mode: 'sequential' });
    for (const text of ['\u200b\u200d', '\u2060\ufeff\n ', '\ufe0f']) {
      await expect(service.start('owner', chat.id, { requestId: rid('invisible'), revision: current.revision, text })).rejects.toThrow();
    }
    expect(await hub.store.db.all('SELECT id FROM group_discussions')).toHaveLength(0);
    expect(await hub.store.db.all('SELECT id FROM messages')).toHaveLength(0);
    const run = (await start(chat.id, '比较 👩‍💻 的方案')).run!;
    const before = await hub.store.db.all('SELECT id FROM messages');
    for (const text of ['\u200b', '\u2060\ufe0f']) {
      await expect(service.note('owner', chat.id, run.id, { requestId: rid('empty-note'), text, attachments: [] })).rejects.toThrow();
    }
    expect(await hub.store.db.all('SELECT id FROM messages')).toHaveLength(before.length);
    await service.note('owner', chat.id, run.id, { requestId: rid('visible-note'), text: 'می\u200cخواهم 👩‍💻', attachments: [] });
    expect((await service.view('owner', chat.id)).run?.latestNote?.text).toBe('می\u200cخواهم 👩‍💻');
  });

  it('keeps older confirmed invisible-text receipts replayable without scheduling again', async () => {
    const chat = await group(); const current = await mode(chat, { mode: 'sequential' });
    const requestId = rid('legacy-topic'), noteId = rid('legacy-note');
    const started = await service.start('owner', chat.id, { requestId, revision: current.revision, text: 'Legacy topic' });
    await service.note('owner', chat.id, started.run!.id, { requestId: noteId, text: 'Legacy note', attachments: [] });
    // Fixture a receipt accepted by an older Host (same canonical hashes).
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    await hub.store.db.run('UPDATE group_discussion_requests SET payload_hash=? WHERE request_id=?', [hash(['start', chat.id, current.revision, '\u200b', []]), requestId]);
    await hub.store.db.run('UPDATE group_discussion_requests SET payload_hash=? WHERE request_id=?', [hash(['note', chat.id, started.run!.id, '\u200b', [], null]), noteId]);
    const before = await hub.store.db.all('SELECT id FROM messages');
    expect((await service.start('owner', chat.id, { requestId, revision: current.revision, text: '\u200b' })).run?.id).toBe(started.run!.id);
    expect((await service.note('owner', chat.id, started.run!.id, { requestId: noteId, text: '\u200b', attachments: [] })).run?.noteCount).toBe(1);
    expect(await hub.store.db.all('SELECT id FROM messages')).toHaveLength(before.length);
  });

  it("lists a supplemental file once while retaining it in each Bot input", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    const bytes = Buffer.from("SHARED_NOTE_FILE");
    const upload = await hub.attachments.create("owner", { conversationId: chat.id, name: "note.txt", size: bytes.length, mime: "text/plain", sha256: createHash("sha256").update(bytes).digest("hex") });
    await hub.attachments.putChunk("owner", upload.id, 0, bytes); await hub.attachments.complete("owner", upload.id);
    await service.note("owner", chat.id, run.id, { requestId: "file-source", text: "Check this file", attachments: [upload.id] });
    const note = (await hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'"))!;
    let step = run.steps[0]!;
    for (let i = 0; i < 3; i++) {
      await speak(chat.id, step, `Turn ${i}`); step = (await next(chat.id)).step;
      expect((await hub.store.db.serial(() => hub.store.queuedMessageInTransaction(step.inputMessageId!))).blocks).toContainEqual(expect.objectContaining({ type: "file", attachmentId: upload.id }));
    }
    const files = (userId = "owner", botId?: string) => conversationFiles(hub.store, userId, { conversationId: chat.id, q: "", ...(botId ? { botId } : {}) });
    expect((await files()).items.map(file => file.messageId)).toEqual([note.id]);
    expect((await files("owner", "alpha")).items.map(file => file.messageId)).toEqual([note.id]);
    expect((await hub.store.search("owner", "note.txt")).map(message => message.id)).toEqual([note.id]);
    expect((await hub.store.searchPage("owner", "note.txt")).items.map(item => item.id)).toEqual([note.id]);
    // Personal deletion hides the source for this reader; it does not revoke
    // bytes already given to participants or erase other members' history.
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat.id]);
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [note.id] });
    expect((await files()).items).toEqual([]);
    expect(await hub.store.search("owner", "note.txt")).toEqual([]);
    expect((await hub.store.searchPage("owner", "note.txt")).items).toEqual([]);
    expect((await files("member")).items.map(file => file.messageId)).toEqual([note.id]);
    // An explicit resend remains a separate genuine sharing event.
    const resent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "reshare", text: "Again", attachments: [upload.id] });
    expect((await files()).items.map(file => file.messageId)).toEqual([resent.message.id]);
  });

  it("binds supplemental notes to the live run and retries without sending or starting again", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 1 });
    const quoted = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "quoted-note-context", text: "QuotedNoteContext", attachments: [] });
    const run = (await start(chat.id)).run!;
    const body = { requestId: "note-once", text: "Keep maintenance costs low", replyTo: quoted.message.id };
    await service.note("owner", chat.id, run.id, body);
    const notes = await hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'");
    expect(notes).toHaveLength(1);
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [notes[0]!.id])).toEqual([]);
    await speak(chat.id, run.steps[0]!, "Alpha's view");
    const beta = (await next(chat.id)).step;
    expect((await service.dispatch("beta", beta.inputMessageId!))!.notes.join("\n")).toContain(body.text);
    expect((await service.dispatch("beta", beta.inputMessageId!))!.notes.join("\n")).toContain("QuotedNoteContext");
    await expect(service.note("owner", chat.id, run.id, { ...body, text: "Changed" })).rejects.toThrow("idempotency_conflict");
    const current = await view(chat.id);
    await service.control("owner", chat.id, run.id, { requestId: "end-notes", revision: current.revision, action: "end" });
    await expect(service.note("owner", chat.id, run.id, body)).resolves.toMatchObject({ run: { id: run.id } });
    await expect(service.note("owner", chat.id, run.id, { ...body, requestId: "late-note" })).rejects.toThrow("group_discussion_not_active");
    await expect(service.note("member", chat.id, run.id, body)).rejects.toThrow();
    expect(await hub.store.db.all("SELECT id FROM messages WHERE client_msg_id LIKE 'gdnote_%'")).toHaveLength(1);
  });

  it("preserves an explicit topic quote and binds it to start idempotency", async () => {
    const chat = await group(); const saved = await mode(chat, { mode: "sequential" });
    const quote = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "quoted-context", text: "Original context", attachments: [] });
    const body = { requestId: "quoted-start", revision: saved.revision, text: "Discuss this", replyTo: quote.message.id };
    const started = await service.start("owner", chat.id, body);
    expect(await hub.store.messageForUser("owner", started.run!.topicMessageId)).toMatchObject({ replyTo: quote.message.id });
    await expect(service.start("owner", chat.id, body)).resolves.toEqual(started);
    await expect(service.start("owner", chat.id, { ...body, replyTo: "missing" })).rejects.toThrow("idempotency_conflict");
  });

  it("requires an explicit start with the current revision and a discussion mode, atomically and idempotently", async () => {
    const chat = await group();
    await expect(start(chat.id)).rejects.toThrow("group_discussion_mode_required");
    const saved = await mode(chat, { mode: "sequential" });
    const count = async () => (await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?", [chat.id]))!.n;
    const before = await count();
    await expect(service.start("owner", chat.id, { requestId: "stale", revision: "gs_stale", text: "x" })).rejects.toThrow("group_settings_conflict");
    expect(await count()).toBe(before);
    const first = await service.start("owner", chat.id, { requestId: "same", revision: saved.revision, text: "Topic" });
    expect(await service.start("owner", chat.id, { requestId: "same", revision: saved.revision, text: "Topic" })).toEqual(first);
    await expect(service.start("owner", chat.id, { requestId: "same", revision: saved.revision, text: "Other" })).rejects.toThrow("idempotency_conflict");
    expect(first.run).toMatchObject({ mode: "sequential", status: "running", stage: "discussion", round: 1, maxRounds: 3, topic: "Topic", createdBy: "owner" });
    expect(first.run!.steps).toHaveLength(1);
    expect(first.run!.steps[0]).toMatchObject({ botId: "alpha", round: 1, position: 0, status: "queued", blind: false });
    const input = await hub.store.messageForUser("owner", first.run!.steps[0]!.inputMessageId!);
    expect(input).toMatchObject({ authorType: "user", authorId: "owner", mentions: ["alpha"], replyTo: first.run!.topicMessageId });
    expect((await hub.store.pendingForBot("alpha")).map(message => message.id)).toEqual([input.id]);
    expect(await hub.store.pendingForBot("beta")).toEqual([]);
    // One active discussion per root group, including its topics.
    const topic = await hub.store.createConversation("owner", [], "Topic", rid("topic"), { parentId: chat.id });
    await expect(start(topic.id, "second", chat.id)).rejects.toThrow("group_discussion_active");
    expect((await service.view("owner", topic.id)).run).toMatchObject({ id: first.run!.id, conversationId: chat.id });
    // The topic's own active run is controllable through its root group too.
    const inTopic = await group([...bots], "Topics");
    await mode(inTopic, { mode: "sequential" });
    const sub = await hub.store.createConversation("owner", [], "Sub", rid("sub"), { parentId: inTopic.id });
    const running = (await start(sub.id, "topic run", inTopic.id)).run!;
    expect((await service.view("owner", inTopic.id)).run).toMatchObject({ id: running.id, conversationId: sub.id });
    expect((await service.control("owner", inTopic.id, running.id, { requestId: "via-root", revision: running.revision, action: "pause" })).run).toMatchObject({ id: running.id, status: "paused" });
    await expect(service.control("owner", chat.id, running.id, { requestId: "wrong-group", revision: running.revision, action: "end" })).rejects.toThrow("group_discussion_not_found");
    // A Bot whose attached worker lacks the capability blocks a new start.
    const other = await group([...bots], "Other");
    await mode(other, { mode: "independent" }); capable.set("beta", false);
    await expect(start(other.id)).rejects.toThrow("group_discussion_worker_update_required");
  });

  it("checks member authorization for every participant", async () => {
    await hub.store.db.run("INSERT INTO bot_grants VALUES('member','alpha'),('member','beta')");
    const chat = await hub.store.createConversation("member", ["alpha", "beta"], "Member", rid("m"), { type: "group" });
    const current = await hub.store.groupSettings("member", chat.id);
    await hub.store.updateGroup("member", chat.id, { title: "Member", botIds: ["alpha", "beta"], expectedTitle: "Member", expectedBotIds: ["alpha", "beta"], policy: { ...current.policy, mode: "sequential" }, expectedRevision: current.revision });
    await hub.store.db.run("DELETE FROM bot_grants WHERE user_id='member' AND bot_id='beta'");
    await expect(service.start("member", chat.id, { requestId: "m", revision: (await hub.store.groupSettings("member", chat.id)).revision, text: "x" })).rejects.toThrow("bot_forbidden");
    await expect(service.view("owner", chat.id)).rejects.toThrow("conversation_forbidden");
  });
});

describe("sequential discussion", () => {
  it("runs in order, shows earlier speakers to later ones and ends early only on explicit unanimous agreement", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential", botOrder: ["beta", "alpha", "gamma"], maxRounds: 3 });
    await start(chat.id);
    let { step } = await next(chat.id);
    expect(step.botId).toBe("beta");
    await speak(chat.id, step, "Use SQLite", { stance: "propose", proposal: "SQLite for v1", summary: "SQLite is enough" });
    ({ step } = await next(chat.id));
    expect(step.botId).toBe("alpha");
    const context = (await service.dispatch("alpha", step.inputMessageId!))!;
    expect(context).toMatchObject({ stage: "discussion", round: 1, position: 1, proposal: { id: "P1", botId: "beta", text: "SQLite for v1" } });
    expect(context.references).toEqual([{ botId: "beta", name: "Name beta", round: 1, text: "Use SQLite" }]);
    expect(await service.dispatch("beta", step.inputMessageId!)).toBeUndefined();
    // Prose agreement is not agreement: no block means unconfirmed.
    await speak(chat.id, step, "I agree completely");
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "Fine", { stance: "agree", proposalId: "P1", summary: "ok" });
    let run = await view(chat.id);
    expect(run.status).toBe("running");
    expect(run.steps.map(s => [s.botId, s.round, s.vote])).toEqual([["beta", 1, "unconfirmed"], ["alpha", 1, "unconfirmed"], ["gamma", 1, "agree"], ["beta", 2, undefined]]);
    // beta's next context only repeats what it has not seen yet.
    const second = (await service.dispatch("beta", active(run)[0]!.inputMessageId!))!;
    expect(second.references.map(r => r.botId)).toEqual(["alpha", "gamma"]);
    expect(second.positions.find(p => p.botId === "gamma")).toMatchObject({ stance: "agree", proposalId: "P1" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "Still SQLite", { stance: "agree", proposalId: "P1", summary: "mine" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "Agree now", { stance: "agree", proposalId: "P1", summary: "yes" });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "completed", outcome: "consensus", phase: "finished" });
    expect(run.conclusion).toContain("SQLite for v1");
    expect(run.steps).toHaveLength(5);
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending'")).toEqual({ n: 0 });
  });

  it("never counts agreement with a proposal ID the Bot had not been shown", async () => {
    const chat = await group(["alpha", "beta"]);
    await mode(chat, { mode: "sequential", maxRounds: 2 });
    await start(chat.id);
    let { step } = await next(chat.id);
    // A guessed future ID, before any proposal exists.
    await speak(chat.id, step, "A1", { stance: "agree", proposalId: "P1", summary: "guess" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "B1", { stance: "propose", proposal: "Plan B", summary: "B" });
    let run = await view(chat.id);
    expect(run.status).toBe("running");
    expect(run.steps[0]!.vote).toBe("unconfirmed");
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "A2", { stance: "agree", proposalId: "P1", summary: "now seen" });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "completed", outcome: "consensus" });
    expect(run.steps.map(s => s.vote)).toEqual(["unconfirmed", "unconfirmed", "agree"]);
  });

  it("clears earlier agreement on a new proposal revision and keeps each view at the round limit", async () => {
    const chat = await group(["alpha", "beta"]);
    await mode(chat, { mode: "sequential", maxRounds: 2 });
    await start(chat.id);
    let { step } = await next(chat.id);
    await speak(chat.id, step, "A1", { stance: "propose", proposal: "Plan A", summary: "A" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "B1", { stance: "propose", proposal: "Plan B", summary: "B" });
    ({ step } = await next(chat.id));
    // Agreeing with the superseded revision does not count.
    await speak(chat.id, step, "A2", { stance: "agree", proposalId: "P1", summary: "still A" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "B2", { stance: "disagree", summary: "B is better" });
    const run = await view(chat.id);
    expect(run).toMatchObject({ status: "completed", outcome: "different_views", proposal: { id: "P2", botId: "beta", text: "Plan B" } });
    expect(run.conclusion).toContain("Name alpha：同意 P1 — still A");
    expect(run.conclusion).toContain("Name beta：不同意 — B is better");
  });

  it("classifies receipts by terminal replies and the worker report, never by acknowledgement alone", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    let { step } = await next(chat.id);
    // Receipt before the final run card: still speaking.
    await dispatch(step);
    await service.report(step.botId, { messageId: step.inputMessageId!, turnId: step.id, text: "partial work" });
    const streaming = await hub.store.publishBotMessage(step.botId, { conversationId: chat.id, replyTo: step.inputMessageId!, blocks: [runCard("waiting_approval")], status: "streaming" });
    await hub.store.acknowledgeDelivery(step.botId, step.inputMessageId!); await service.settleInput(step.botId, step.inputMessageId!);
    let run = await view(chat.id);
    expect(run.steps[0]).toMatchObject({ status: "running", attention: "approval" });
    const final = await hub.store.publishBotMessage(step.botId, { id: streaming.id, conversationId: chat.id, blocks: [runCard("done", "partial work")], status: "complete" });
    await service.published(step.botId, final);
    run = await view(chat.id);
    expect(run.steps[0]).toMatchObject({ status: "completed", result: "answered", text: "partial work" });
    // A swallowed engine error is acknowledged too; it pauses, it does not advance.
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "", undefined, { phase: "error", report: false });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_failed", actions: ["resume", "retry", "end"] });
    expect(active(run)).toEqual([]);
    // Retry is explicit and creates a new input; the failed one is never replayed.
    const retried = await service.control("owner", chat.id, run.id, { requestId: "retry", revision: run.revision, action: "retry" });
    const retry = active(retried.run!)[0]!;
    expect(retry).toMatchObject({ botId: "beta", attempt: 2, round: 1, position: 1 });
    expect(retry.inputMessageId).not.toBe(step.inputMessageId);
    // An acknowledged turn without the worker's completed-output report is no reply.
    await speak(chat.id, retry, "ignored", undefined, { report: false });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_no_reply" });
    // Uncertain worker failure: resume continues with the next speaker, no rerun.
    await service.control("owner", chat.id, run.id, { requestId: "resume", revision: run.revision, action: "resume" });
    ({ step } = await next(chat.id));
    expect(step).toMatchObject({ botId: "gamma", round: 1 });
    await dispatch(step);
    await hub.store.failDelivery(step.botId, step.inputMessageId!, "interrupted"); await service.settleInput(step.botId, step.inputMessageId!, "interrupted");
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_interrupted" });
    expect(run.steps.filter(s => s.botId === "gamma")).toHaveLength(1);
    // A user Stop is reported by the run card's stopped phase.
    await service.control("owner", chat.id, run.id, { requestId: "resume-2", revision: run.revision, action: "resume" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "half", undefined, { phase: "stopped" });
    expect(await view(chat.id)).toMatchObject({ status: "paused", pauseReason: "turn_stopped" });
  });

  it("pauses after the current speaker, ends by stopping and waiting for the terminal state, and enforces CAS and permissions", async () => {
    await hub.store.db.run("INSERT INTO conversation_members SELECT id,'user','member',0 FROM conversations");
    const chat = await group();
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat.id]);
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    await dispatch(active(await view(chat.id))[0]!);
    let run = await view(chat.id);
    await expect(service.control("member", chat.id, run.id, { requestId: "x", revision: run.revision, action: "pause" })).rejects.toThrow("group_discussion_control_forbidden");
    expect((await service.view("member", chat.id)).run!.actions).toEqual([]);
    const paused = (await service.control("owner", chat.id, run.id, { requestId: "pause", revision: run.revision, action: "pause" })).run!;
    expect(paused).toMatchObject({ status: "pausing", actions: ["resume", "end"] });
    // Same request replays; an unrelated stale request conflicts; satisfied ones are no-ops.
    expect((await service.control("owner", chat.id, run.id, { requestId: "pause", revision: run.revision, action: "pause" })).run!.status).toBe("pausing");
    await expect(service.control("owner", chat.id, run.id, { requestId: "late-resume", revision: run.revision, action: "retry" })).rejects.toThrow("group_discussion_conflict");
    await expect(service.control("owner", chat.id, run.id, { requestId: "pause", revision: run.revision, action: "end" })).rejects.toThrow("idempotency_conflict");
    const { step } = await next(chat.id);
    await speak(chat.id, step, "done", { stance: "abstain", summary: "-" });
    run = await view(chat.id);
    expect(run.status).toBe("paused"); expect(active(run)).toEqual([]);
    run = (await service.control("owner", chat.id, run.id, { requestId: "resume", revision: run.revision, action: "resume" })).run!;
    expect(run.status).toBe("running"); expect(active(run)[0]!.botId).toBe("beta");
    // End: a live engine turn is stopped through the existing Stop, then awaited.
    const live = active(run)[0]!;
    await dispatch(live);
    const card = await hub.store.publishBotMessage("beta", { conversationId: chat.id, replyTo: live.inputMessageId!, blocks: [runCard("working")], status: "streaming" });
    run = (await service.control("owner", chat.id, run.id, { requestId: "end", revision: run.revision, action: "end" })).run!;
    expect(run.status).toBe("ending");
    // Exactly this input's run, never whatever else runs in the conversation.
    expect(stop).toHaveBeenCalledExactlyOnceWith("beta", chat.id, live.inputMessageId);
    // A Stop lost with the worker's socket is re-sent on reattachment, only
    // while this turn's own run card is still live.
    await service.settleBot("beta", true);
    expect(stop).toHaveBeenCalledTimes(2);
    stop.mockClear(); stop.mockResolvedValue({ stopped: true });
    await service.settleBot("beta");
    expect(stop).not.toHaveBeenCalled();
    // Still waiting: End never pretends the engine has already stopped.
    await service.published("beta", await hub.store.publishBotMessage("beta", { id: card.id, conversationId: chat.id, blocks: [runCard("stopping")], status: "streaming" }));
    expect((await view(chat.id)).status).toBe("ending");
    expect(stop).not.toHaveBeenCalled();
    await service.published("beta", await hub.store.publishBotMessage("beta", { id: card.id, conversationId: chat.id, blocks: [runCard("stopped")], status: "complete" }));
    await hub.store.acknowledgeDelivery("beta", live.inputMessageId!); await service.settleInput("beta", live.inputMessageId!);
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "ended", outcome: "stopped", actions: [] });
    expect(run.conclusion).toContain("讨论已结束");
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending'")).toEqual({ n: 0 });
  });

  it("withdraws an undispatched input on end without contacting the worker", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    const run = await view(chat.id);
    const ended = (await service.control("owner", chat.id, run.id, { requestId: "end-now", revision: run.revision, action: "end" })).run!;
    expect(ended).toMatchObject({ status: "ended", outcome: "stopped" });
    expect(ended.steps[0]).toMatchObject({ status: "cancelled", result: "cancelled" });
    expect(stop).not.toHaveBeenCalled();
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
  });
});

describe("independent review", () => {
  it("dispatches the first round in parallel without peer content, seals peer replies, then reveals and discusses", async () => {
    const chat = await group();
    await mode(chat, { mode: "independent", maxRounds: 2 });
    await start(chat.id, "Which framework?");
    let run = await view(chat.id);
    expect(run).toMatchObject({ stage: "blind", round: 1 });
    expect(active(run).map(step => step.botId)).toEqual(["alpha", "beta", "gamma"]);
    for (const step of active(run)) {
      const context = (await service.dispatch(step.botId, step.inputMessageId!))!;
      expect(context).toMatchObject({ stage: "blind", topic: "Which framework?", references: [], positions: [], notes: [] });
      expect(context.proposal).toBeUndefined();
    }
    // A user note during the sealed round is not delivered and not shown blind.
    await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "note", text: "Budget is small", attachments: [] });
    const [a, b, c] = active(run);
    const alphaReply = await speak(chat.id, a!, "React", { stance: "propose", proposal: "React", summary: "React" });
    await expect(hub.store.messageForBot("beta", alphaReply.id)).rejects.toThrow("group_discussion_sealed");
    await expect(hub.store.messageForBot("alpha", alphaReply.id)).resolves.toMatchObject({ id: alphaReply.id });
    const file = await hub.store.db.run("INSERT INTO attachments VALUES('att_sealed',?,'owner','x',1,'text/plain','a.txt','a.blob',1,1)", [chat.id]);
    void file;
    const withFile = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: a!.inputMessageId!, blocks: [{ type: "file", attachmentId: "att_sealed", name: "a.txt", size: 1, mime: "text/plain" }] });
    await expect(hub.store.requireAttachmentUnsealed("gamma", "att_sealed")).rejects.toThrow("group_discussion_sealed");
    void withFile;
    await speak(chat.id, b!, "Vue", { stance: "propose", proposal: "Vue", summary: "Vue" });
    run = await view(chat.id);
    expect(run.stage).toBe("blind");
    expect(active(run).map(step => step.botId)).toEqual(["gamma"]);
    await speak(chat.id, c!, "Svelte", { stance: "disagree", summary: "neither" });
    run = await view(chat.id);
    expect(run).toMatchObject({ stage: "discussion", round: 2, proposal: { id: "P2", botId: "beta" } });
    await expect(hub.store.messageForBot("beta", alphaReply.id)).resolves.toMatchObject({ id: alphaReply.id });
    const step = active(run)[0]!;
    expect(step).toMatchObject({ botId: "alpha", round: 2, blind: false });
    const context = (await service.dispatch("alpha", step.inputMessageId!))!;
    expect(context.references.map(r => [r.botId, r.text])).toEqual([["beta", "Vue"], ["gamma", "Svelte"]]);
    expect(context.notes).toEqual(["Budget is small"]);
  });

  it("waits for every first-round answer before pausing on one failure, and retries it blind", async () => {
    const chat = await group();
    await mode(chat, { mode: "independent", maxRounds: 1 });
    await start(chat.id);
    let run = await view(chat.id);
    const [a, b, c] = active(run);
    // These two inputs really reached workers; held inputs do not delay pause.
    await dispatch(b!); await dispatch(c!);
    await speak(chat.id, a!, "", undefined, { phase: "error", report: false });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "pausing", pauseReason: "turn_failed", stage: "blind" });
    await speak(chat.id, b!, "B", { stance: "abstain", summary: "b" });
    await speak(chat.id, c!, "C", { stance: "abstain", summary: "c" });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", stage: "blind" });
    run = (await service.control("owner", chat.id, run.id, { requestId: "retry-blind", revision: run.revision, action: "retry" })).run!;
    const retry = active(run)[0]!;
    expect(retry).toMatchObject({ botId: "alpha", blind: true, attempt: 2 });
    expect((await service.dispatch("alpha", retry.inputMessageId!))!.references).toEqual([]);
    await speak(chat.id, retry, "A", { stance: "abstain", summary: "a" });
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "completed", outcome: "different_views", stage: "discussion" });
  });
});

describe("durability and membership", () => {
  it("advances exactly once after reconciliation and never replays an uncertain turn", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    const { step } = await next(chat.id);
    await dispatch(step);
    await service.report(step.botId, { messageId: step.inputMessageId!, turnId: step.id, text: "answer" });
    await hub.store.publishBotMessage(step.botId, { conversationId: chat.id, replyTo: step.inputMessageId!, blocks: [runCard("done", "answer")], status: "complete" });
    // The receipt committed but the Hub stopped before applying it.
    await hub.store.acknowledgeDelivery(step.botId, step.inputMessageId!);
    await hub.close(); hub = await HubServer.start({ stateDir: root });
    service = new HubGroupDiscussions(hub.store, { workerCapable: () => undefined, stop });
    let run = await view(chat.id);
    expect(run.steps.map(s => s.status)).toEqual(["completed", "queued"]);
    await service.reconcile(); await hub.groupDiscussions.reconcile();
    run = await view(chat.id);
    expect(run.steps).toHaveLength(2);
    // Reads never advance anything.
    for (let i = 0; i < 3; i++) await service.view("owner", chat.id);
    expect((await view(chat.id)).revision).toBe(run.revision);
  });

  it("settles a deleted participant, protects active members from removal and skips them on resume", async () => {
    await hub.store.db.run("INSERT INTO managed_bots VALUES('gamma','owner','gamma','{}')");
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    await expect(hub.store.updateGroup("owner", chat.id, { title: "Group", botIds: ["alpha", "beta"], expectedTitle: "Group", expectedBotIds: [...bots] })).rejects.toThrow("group_discussion_active");
    let { step } = await next(chat.id);
    await speak(chat.id, step, "A", { stance: "abstain", summary: "a" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "B", { stance: "abstain", summary: "b" });
    ({ step } = await next(chat.id));
    expect(step.botId).toBe("gamma");
    await hub.store.deleteBot("owner", "gamma", "Name gamma");
    await service.settleBot("gamma");
    let run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_unavailable" });
    expect(run.actions).toEqual(["resume", "end"]);
    expect(run.participants.find(p => p.botId === "gamma")).toMatchObject({ active: false });
    run = (await service.control("owner", chat.id, run.id, { requestId: "skip", revision: run.revision, action: "resume" })).run!;
    expect(active(run).map(s => [s.botId, s.round])).toEqual([["alpha", 2]]);
  });

  it("withholds discussion input from a worker without the capability and pauses instead of running it as chat", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    const queue = new HubPromptQueue(hub.store);
    const claimed = await queue.claim("alpha", false, false, () => true, true, true, ids => service.rejectForWorkerInTransaction("alpha", ids));
    expect(claimed).toEqual([]);
    const run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_worker_update_required" });
    expect(run.steps[0]).toMatchObject({ result: "worker_update_required" });
    // A capable claim dispatches ordinary input but never the withheld turn.
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
  });

  it("refuses cross-Bot messages that use a discussion turn as context", async () => {
    await hub.profile.update({ name: "Mac", revision: 0 });
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    const { step } = await next(chat.id);
    await dispatch(step);
    await expect(hub.botMessages.local({ operation: "send", host: "Mac", bot: "beta", requestId: "x", contextMessage: step.inputMessageId!, data: { text: "peek", attachments: [] } }, "alpha", async () => undefined))
      .rejects.toThrow("group_discussion_bot_messages_blocked");
  });
});

describe("review regressions", () => {
  it("retires a participant deleted while another member speaks instead of scheduling it (R-HUB-1)", async () => {
    await hub.store.db.run("INSERT INTO managed_bots VALUES('gamma','owner','gamma','{}')");
    const chat = await group();
    await mode(chat, { mode: "sequential", maxRounds: 2 });
    await start(chat.id);
    await hub.store.deleteBot("owner", "gamma", "Name gamma");
    await service.settleBot("gamma");
    let { step } = await next(chat.id);
    await speak(chat.id, step, "A", { stance: "abstain", summary: "a" });
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "B", { stance: "abstain", summary: "b" });
    const run = await view(chat.id);
    expect(active(run).map(s => [s.botId, s.round])).toEqual([["alpha", 2]]);
    expect(run.steps.some(s => s.botId === "gamma")).toBe(false);
    expect(run.participants.find(p => p.botId === "gamma")).toMatchObject({ active: false });
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM deliveries WHERE bot_id='gamma'")).toEqual({ n: 0 });
  });

  it("re-arms a failed or unconfirmed Stop and retries it for the same input (R-HUB-2)", async () => {
    stop.mockRejectedValueOnce(new Error("bot_offline")).mockResolvedValueOnce({ stopped: false }).mockResolvedValue({ stopped: true });
    const chat = await group(["alpha", "beta"]);
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    const step = active(await view(chat.id))[0]!;
    await dispatch(step);
    const card = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: step.inputMessageId!, blocks: [runCard("waiting_approval")], status: "streaming" });
    let run = await view(chat.id);
    expect(run.steps[0]).toMatchObject({ attention: "approval" });
    await service.control("owner", chat.id, run.id, { requestId: rid("end"), revision: run.revision, action: "end" });
    await vi.waitFor(async () => expect(await hub.store.db.get("SELECT stop_sent FROM group_discussion_turns WHERE id=?", [step.id])).toEqual({ stop_sent: 0 }));
    await service.published("alpha", await hub.store.publishBotMessage("alpha", { id: card.id, conversationId: chat.id, blocks: [runCard("working")], status: "streaming" }));
    await vi.waitFor(async () => expect(await hub.store.db.get("SELECT stop_sent FROM group_discussion_turns WHERE id=?", [step.id])).toEqual({ stop_sent: 0 }));
    await service.reconcile();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(3));
    expect(stop.mock.calls.every(call => call[2] === step.inputMessageId)).toBe(true);
    expect(await hub.store.db.get("SELECT stop_sent FROM group_discussion_turns WHERE id=?", [step.id])).toEqual({ stop_sent: 1 });
    run = await view(chat.id);
    expect(run.status).toBe("ending");
  });

  it("holds a paused run's undispatched speaker input in the queue claim until resume", async () => {
    const chat = await group();
    await mode(chat, { mode: "sequential" });
    await start(chat.id);
    let run = await view(chat.id);
    run = (await service.control("owner", chat.id, run.id, { requestId: rid("pause"), revision: run.revision, action: "pause" })).run!;
    expect(run.status).toBe("paused");
    const queue = new HubPromptQueue(hub.store);
    expect(await queue.claim("alpha", false, false)).toEqual([]);
    run = (await service.control("owner", chat.id, run.id, { requestId: rid("resume"), revision: run.revision, action: "resume" })).run!;
    expect(run.status).toBe("running");
    expect(run.steps).toHaveLength(1);
    expect((await queue.claim("alpha", false, false)).map(message => message.id)).toEqual([run.steps[0]!.inputMessageId]);
  });

  it("seals a blind answer from Bots added after the run started (R-HUB-3)", async () => {
    const chat = await group(["alpha", "beta"]);
    await mode(chat, { mode: "independent", maxRounds: 2 });
    await start(chat.id);
    const [, b] = active(await view(chat.id));
    await dispatch(b!);
    const sealed = await hub.store.publishBotMessage("beta", { conversationId: chat.id, replyTo: b!.inputMessageId!, blocks: [{ type: "text", text: "BETA_BLIND" }], status: "complete" });
    await hub.store.updateGroup("owner", chat.id, { title: "Group", botIds: ["alpha", "beta", "gamma"], expectedTitle: "Group", expectedBotIds: ["alpha", "beta"] });
    await expect(hub.store.messageForBot("gamma", sealed.id)).rejects.toThrow("group_discussion_sealed");
  });

  it("marks topic and scheduler inputs with a Hub-owned marker that clients cannot forge", async () => {
    const chat = await group();
    await mode(chat, { mode: "independent", maxRounds: 2 });
    const run = (await start(chat.id, "Marked topic")).run!;
    const listed = (await hub.store.listMessages("owner", chat.id)).messages;
    expect(listed.find(m => m.id === run.topicMessageId)!.groupDiscussion).toEqual({ runId: run.id, role: "topic", mode: "independent" });
    const input = listed.find(m => m.id === run.steps[1]!.inputMessageId)!;
    expect(input.groupDiscussion).toEqual({ runId: run.id, role: "input", mode: "independent", turnId: run.steps[1]!.id, botId: "beta", round: 1, maxRounds: 2, position: 1, participants: 3, attempt: 1, blind: true });
    // A client frame cannot carry the marker into an ordinary message. (An @
    // beside the active run is refused; the unaddressed form becomes a note.)
    const forged = { v: 1, type: "message.send", clientMsgId: "forge", conversationId: chat.id, text: "hi", groupDiscussion: { runId: run.id, role: "input", mode: "independent" } };
    const mentioned = parseClientFrame(JSON.stringify({ ...forged, clientMsgId: "forge-at", mentions: ["alpha"] }));
    await expect(hub.store.sendMessage("owner", (mentioned as { frame: never }).frame)).rejects.toThrow("group_discussion_active");
    const parsed = parseClientFrame(JSON.stringify(forged));
    expect("frame" in parsed && "groupDiscussion" in parsed.frame).toBe(false);
    const sent = await hub.store.sendMessage("owner", (parsed as { frame: never }).frame);
    expect((await hub.store.messageForUser("owner", sent.message.id)).groupDiscussion).toBeUndefined();
  });

  it("serves brief, unchanged and per-step reads plus structured positions", async () => {
    const chat = await group(["alpha", "beta"]);
    await mode(chat, { mode: "sequential", maxRounds: 1 });
    await start(chat.id);
    let { step } = await next(chat.id);
    await speak(chat.id, step, "x".repeat(2000), { stance: "propose", proposal: "Plan", summary: "plan" });
    const full = await service.view("owner", chat.id);
    const brief = (await service.view("owner", chat.id, undefined, { brief: true })).run!;
    expect(brief).toMatchObject({ brief: true });
    expect(brief.steps[0]).toMatchObject({ textTruncated: true });
    expect(brief.steps[0]!.text!.length).toBeLessThanOrEqual(600);
    const detail = await service.step("owner", chat.id, full.run!.id, step.id);
    expect(detail.text).toHaveLength(2000);
    const known = `${full.run!.id}.${full.run!.revision}.${full.settings.revision}`;
    expect(await service.read("owner", chat.id, undefined, { known })).toEqual({ unchanged: true });
    expect(await service.read("owner", chat.id, undefined, { known: `r0.${full.settings.revision}` })).toHaveProperty("run");
    ({ step } = await next(chat.id));
    await speak(chat.id, step, "ok", { stance: "agree", proposalId: "P1", summary: "fine" });
    expect((await view(chat.id)).positions).toEqual([
      { botId: "alpha", stance: "propose", summary: "plan", turnId: full.run!.steps[0]!.id, agreesWithProposal: true },
      { botId: "beta", stance: "agree", proposalId: "P1", summary: "fine", turnId: step.id, agreesWithProposal: true },
    ]);
  });
});

it("conditional view must distinguish completed runs with the same per-run revision", async () => {
 const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 1 });
 async function finish() { for(let i=0;i<3;i++) { const {step}=await next(chat.id); await speak(chat.id,step,`${step.botId} answer`); } }
 await start(chat.id,"First topic"); await finish();
 const before=await service.view("owner",chat.id);
 const known=`${before.run!.id}.${before.run!.revision}.${before.settings.revision}`;
 expect(await service.read("owner",chat.id,undefined,{known})).toEqual({unchanged:true});
 await start(chat.id,"Second topic"); await finish();
 const after=await service.view("owner",chat.id);
 expect(after.run!.revision).toBe(before.run!.revision);
 expect(after.run!.id).not.toBe(before.run!.id);
 expect(await service.read("owner",chat.id,undefined,{known})).not.toEqual({unchanged:true});
});

it("End sends exact Stop for a dispatched input even before a running card exists", async () => {
 const chat = await group(); await mode(chat, { mode: "sequential" }); await start(chat.id);
 const run = await view(chat.id), turn = active(run)[0]!; await dispatch(turn);
 await service.control("owner", chat.id, run.id, { requestId: "end-worker-queued", revision: run.revision, action: "end" });
 expect(stop).toHaveBeenCalledWith(turn.botId, chat.id, turn.inputMessageId);
});


it("a dispatched input remains queued until a real run starts and invalidates the cached view then", async () => {
  const chat = await group(); await mode(chat, { mode: "sequential" }); await start(chat.id);
  const step = active(await view(chat.id))[0]!;
  expect(step).toMatchObject({ status: "queued", dispatched: false });
  await dispatch(step); await service.markDispatched(step.botId, step.inputMessageId!);
  const waiting = await service.view("owner", chat.id);
  expect(waiting.run!.steps[0]).toMatchObject({ status: "queued", dispatched: true });
  const known = `${waiting.run!.id}.${waiting.run!.revision}.${waiting.settings.revision}`;
  const reply = await hub.store.publishBotMessage(step.botId, { conversationId: chat.id, replyTo: step.inputMessageId!, blocks: [runCard("thinking")], status: "streaming" });
  await service.published(step.botId, reply);
  expect((await view(chat.id)).steps[0]!.status).toBe("running");
  expect(await service.read("owner", chat.id, undefined, { known })).not.toEqual({ unchanged: true });
});

it("an acknowledged queued input stopped by End is cancelled rather than a missing-answer failure", async () => {
  const chat = await group(); await mode(chat, { mode: "sequential" }); await start(chat.id);
  const run = await view(chat.id), step = active(run)[0]!; await dispatch(step);
  await service.control("owner", chat.id, run.id, { requestId: rid("end-queued"), revision: run.revision, action: "end" });
  await hub.store.acknowledgeDelivery(step.botId, step.inputMessageId!); await service.settleInput(step.botId, step.inputMessageId!);
  expect(await view(chat.id)).toMatchObject({ status: "ended", outcome: "stopped", steps: [{ status: "cancelled", result: "stopped" }] });
});
