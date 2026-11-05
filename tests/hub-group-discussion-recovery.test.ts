import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HubGroupDiscussions } from "../src/hub/group-discussions.js";
import { groupDiscussionInstructions, groupDiscussionReference } from "../src/gateway/group-discussion.js";
import { CAPABILITIES, type Block, type Conversation } from "../src/client-protocol/index.js";
import { GROUP_DISCUSSION_MAX_STEPS, GROUP_DISCUSSION_RECOVERY_CAPABILITY, groupDiscussionActive, type GroupDiscussionRun, type GroupDiscussionStep, type GroupStance } from "../src/client-protocol/group-discussion.js";

// Owner-reported path (2026-10-23): a mistyped roundtable topic, main-composer
// Stop, a corrected resend and later notes, then Continue. Each case below was
// first reproduced against b3cb23c and now asserts the intended behavior.
const bots = ["alpha", "beta", "gamma"] as const;
type StopHook = (botId: string, conversationId: string, messageId: string) => Promise<unknown>;
let root: string, hub: HubServer, service: HubGroupDiscussions, stop: ReturnType<typeof vi.fn<StopHook>>;
let request = 0;
const rid = (tag = "r") => `${tag}-${++request}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-group-recovery-"));
  hub = await HubServer.start({ stateDir: root });
  for (const id of [...bots, "delta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `Name ${id}`, "fixture"]);
  await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  stop = vi.fn<StopHook>(async () => ({ stopped: true }));
  service = new HubGroupDiscussions(hub.store, { workerCapable: () => undefined, stop });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

const group = (botIds: string[] = [...bots]) => hub.store.createConversation("owner", botIds, "Group", rid("group"), { type: "group" });
const settings = (id: string) => hub.store.groupSettings("owner", id);
async function mode(conversation: Conversation, policy: { mode: "mentions" | "sequential" | "independent"; maxRounds?: number }) {
  const current = await settings(conversation.id);
  await hub.store.updateGroup("owner", conversation.id, { title: current.group.title, botIds: current.group.botIds, expectedTitle: current.group.title, expectedBotIds: current.group.botIds,
    policy: { mode: policy.mode, botOrder: current.policy.botOrder, maxRounds: policy.maxRounds ?? current.policy.maxRounds }, expectedRevision: current.revision });
}
async function start(conversationId: string, text = "Pick a database", extra: object = {}, groupId = conversationId) {
  return service.start("owner", conversationId, { requestId: rid("start"), revision: (await settings(groupId)).revision, text, ...extra });
}
const view = async (conversationId: string) => (await service.view("owner", conversationId)).run!;
const runCard = (phase: string): Block => ({ type: "card", elements: [{ type: "markdown", text: "" }], extra: { nativeRun: { version: 1, id: `run_${request++}`, revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false } } });
const live = (run: GroupDiscussionRun) => run.steps.filter(step => step.status === "running" || step.status === "queued");
const dispatch = (step: GroupDiscussionStep) => hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [step.inputMessageId!, step.botId]);
/** One worker turn through the Hub APIs the Gateway uses; `stopped` is a user Stop. */
async function speak(conversationId: string, step: GroupDiscussionStep, text: string, phase = "done", stance?: GroupStance) {
  await dispatch(step);
  if (phase === "done") await service.report(step.botId, { messageId: step.inputMessageId!, turnId: step.id, text, ...(stance ? { stance } : {}) });
  const reply = await hub.store.publishBotMessage(step.botId, { conversationId, replyTo: step.inputMessageId!, blocks: [runCard(phase)], status: "complete" });
  await service.published(step.botId, reply);
  await hub.store.acknowledgeDelivery(step.botId, step.inputMessageId!); await service.settleInput(step.botId, step.inputMessageId!);
}
const note = (conversationId: string, runId: string, text: string, extra: object = {}) => service.note("owner", conversationId, runId, { requestId: rid("note"), text, ...extra });
const count = async (sql: string, params: unknown[] = []) => (await hub.store.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, params))!.n;
const notesOf = async (step: GroupDiscussionStep) => (await service.dispatch(step.botId, step.inputMessageId!))!.notes;

describe("audit: held discussion inputs and forwarding", () => {
  async function upload(conversationId: string) {
    const data = Buffer.from("correction attachment"), name = "correction.txt";
    const { id } = await hub.attachments.create("owner", { conversationId, name, mime: "text/plain", size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    await hub.attachments.putChunk("owner", id, 0, data); await hub.attachments.complete("owner", id); return id;
  }
  const inputOf = (step: GroupDiscussionStep) => hub.store.db.serial(() => hub.store.queuedMessageInTransaction(step.inputMessageId!));
  it.each(["sequential", "independent"] as const)("refreshes held %s inputs when adding a note and continuing", async discussionMode => {
    const chat = await group(); await mode(chat, { mode: discussionMode, maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    if (discussionMode === "sequential") await speak(chat.id, live(run)[0]!, "alpha view");
    const before = await view(chat.id), held = live(before);
    const paused = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: before.revision, action: "pause" })).run!;
    const body = { requestId: rid(), text: "CORRECTION: use Postgres", then: "resume", revision: paused.revision };
    const resumed = (await service.note("owner", chat.id, run.id, body)).run!;
    expect(live(resumed).map(step => [step.id, step.inputMessageId])).toEqual(held.map(step => [step.id, step.inputMessageId]));
    for (const step of held) expect(await notesOf(step)).toContain("CORRECTION: use Postgres");
    expect(resumed.unseenNoteCount).toBe(0);
    const snapshot = { messages: await count("messages"), deliveries: await count("deliveries"), turns: await count("group_discussion_turns") };
    await service.note("owner", chat.id, run.id, body);
    expect({ messages: await count("messages"), deliveries: await count("deliveries"), turns: await count("group_discussion_turns") }).toEqual(snapshot);
  });

  it("names the held speaker as next while paused, matching the turn that Continue releases", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    await speak(chat.id, live(run)[0]!, "alpha view");
    const before = await view(chat.id);
    const paused = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: before.revision, action: "pause" })).run!;
    expect(paused.next).toEqual({ botId: "beta", round: 1, position: 1 });
    const resumed = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: paused.revision, action: "resume" })).run!;
    expect(live(resumed)[0]!.botId).toBe(paused.next!.botId);
  });

  it("refreshes held blind inputs during retry without revealing member answers or rerunning held speakers", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    const [alpha, ...held] = live(run);
    await speak(chat.id, alpha!, "", "stopped");
    const paused = await view(chat.id);
    expect(paused.status).toBe("paused");
    const secret = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "WITHHELD_MEMBER_ANSWER" }] });
    const attachment = await upload(chat.id);
    const resumed = (await note(chat.id, run.id, "CORRECTION", { then: "retry", revision: paused.revision, attachments: [attachment], replyTo: secret.id })).run!;
    expect(live(resumed).filter(step => step.botId !== "alpha").map(step => step.id)).toEqual(held.map(step => step.id));
    expect(live(resumed).find(step => step.botId === "alpha")).toMatchObject({ attempt: 2 });
    for (const step of live(resumed)) {
      const context = await service.dispatch(step.botId, step.inputMessageId!);
      expect(context).toMatchObject({ stage: "blind", references: [], positions: [] });
      expect(context!.notes.join(" ")).toContain("CORRECTION");
      expect(JSON.stringify(context)).not.toContain("WITHHELD_MEMBER_ANSWER");
      expect((await inputOf(step)).blocks).toContainEqual(expect.objectContaining({ attachmentId: attachment }));
    }
  });

  it("never refreshes an already claimed input when resuming a pausing independent run", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    const run = (await start(chat.id)).run!, [claimed, ...held] = live(run);
    await dispatch(claimed!);
    const before = { context: await service.dispatch(claimed!.botId, claimed!.inputMessageId!), message: await inputOf(claimed!) };
    const paused = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "pause" })).run!;
    expect(paused.status).toBe("pausing");
    const attachment = await upload(chat.id);
    await note(chat.id, run.id, "NEW NOTE", { then: "resume", revision: paused.revision, attachments: [attachment] });
    expect({ context: await service.dispatch(claimed!.botId, claimed!.inputMessageId!), message: await inputOf(claimed!) }).toEqual(before);
    for (const step of held) {
      expect((await notesOf(step)).join(" ")).toContain("NEW NOTE");
      expect((await inputOf(step)).blocks).toContainEqual(expect.objectContaining({ attachmentId: attachment }));
    }
  });

  it("rolls back note receipt, refreshed contexts, resources and events together, then safely retries", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    const run = (await start(chat.id)).run!, held = live(run);
    const paused = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "pause" })).run!;
    const attachment = await upload(chat.id);
    const snapshot = async () => ({ turns: await hub.store.db.all("SELECT * FROM group_discussion_turns"), messages: await hub.store.db.all("SELECT * FROM messages"),
      deliveries: await hub.store.db.all("SELECT * FROM deliveries"), requests: await hub.store.db.all("SELECT * FROM group_discussion_requests"), events: await hub.store.db.all("SELECT * FROM events") });
    const before = await snapshot(), body = { requestId: rid(), text: "ATOMIC NOTE", attachments: [attachment], then: "resume", revision: paused.revision };
    const original = hub.store.updateQueuedMessageInTransaction.bind(hub.store), spy = vi.spyOn(hub.store, "updateQueuedMessageInTransaction");
    spy.mockImplementationOnce(original).mockRejectedValueOnce(Error("synthetic write failure"));
    try { await expect(service.note("owner", chat.id, run.id, body)).rejects.toThrow("synthetic write failure"); }
    finally { spy.mockRestore(); }
    expect(await snapshot()).toEqual(before);
    expect((await view(chat.id)).revision).toBe(paused.revision);
    await service.note("owner", chat.id, run.id, body);
    for (const step of held) expect((await inputOf(step)).blocks).toContainEqual(expect.objectContaining({ attachmentId: attachment }));
    const committed = await snapshot(); await service.note("owner", chat.id, run.id, body);
    expect(await snapshot()).toEqual(committed);
  });

  it("applies send addressing rules to forwarded replies before creating deliveries or copying resources", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const direct = await hub.store.createConversation("owner", ["alpha"], "Direct", rid());
    const attachment = await upload(direct.id);
    const source = (await hub.store.sendMessage("owner", { conversationId: direct.id, clientMsgId: rid(), text: "forward me", attachments: [attachment] })).message;
    const frame = { v: 1 as const, type: "message.forward" as const, conversationId: chat.id, sourceMessageId: source.id };
    const copy = vi.fn(async () => {});
    const snapshot = { messages: await count("messages"), deliveries: await count("deliveries"), events: await count("events") };
    await expect(hub.store.forwardMessage("owner", { ...frame, clientMsgId: rid(), mentions: ["alpha", "beta"] }, copy)).rejects.toThrow("group_discussion_start_required");
    expect(copy).not.toHaveBeenCalled();
    expect({ messages: await count("messages"), deliveries: await count("deliveries"), events: await count("events") }).toEqual(snapshot);
    const directed = { ...frame, clientMsgId: rid(), mentions: ["beta"] };
    const sent = await hub.store.forwardMessage("owner", directed, copy);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(await count("deliveries WHERE message_id=?", [sent.message.id])).toBe(1);
    await start(chat.id);
    expect((await hub.store.forwardMessage("owner", directed, copy)).duplicate).toBe(true);
    await expect(hub.store.forwardMessage("owner", { ...frame, clientMsgId: rid(), mentions: ["gamma"] }, copy)).rejects.toThrow("group_discussion_active");
    expect(copy).toHaveBeenCalledTimes(1);
    const shared = await hub.store.forwardMessage("owner", { ...frame, clientMsgId: rid() }, copy);
    expect(await count("deliveries WHERE message_id=?", [shared.message.id])).toBe(0);
    expect(copy).toHaveBeenCalledTimes(2);
  });
});

describe("owner-reported Stop / resend path", () => {
  it("ends with a stale revision, keeps results, and lets the corrected question start a new discussion", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const typo = (await start(chat.id, "TYPO question")).run!;
    const first = live(typo)[0]!;
    const stale = typo.revision;
    await dispatch(first);
    await service.markDispatched(first.botId, first.inputMessageId!);   // revision moves on
    expect((await view(chat.id)).revision).not.toBe(stale);
    // Main-composer Stop: End with the exact run, from a view already stale.
    const ending = await service.control("owner", chat.id, typo.id, { requestId: rid(), revision: stale, action: "end" });
    expect(ending.run).toMatchObject({ status: "ending" });
    expect(stop).toHaveBeenCalledExactlyOnceWith("alpha", chat.id, first.inputMessageId);
    // Ending still waits for terminal evidence; a new topic cannot start yet.
    await expect(start(chat.id, "CORRECT question")).rejects.toThrow("group_discussion_active");
    await speak(chat.id, first, "", "stopped");
    expect(await view(chat.id)).toMatchObject({ status: "ended", outcome: "stopped" });
    const corrected = (await start(chat.id, "CORRECT question")).run!;
    expect(corrected).toMatchObject({ status: "running", topic: "CORRECT question" });
    expect(live(corrected).map(step => step.botId)).toEqual(["alpha"]);
  });

  it("supersedes a paused run atomically with a new topic and never leaves the old one running", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const old = (await start(chat.id, "TYPO question")).run!;
    await speak(chat.id, live(old)[0]!, "", "stopped");
    const paused = await view(chat.id);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "turn_stopped", next: { botId: "beta", round: 1, position: 1 }, retryTargets: [{ botId: "alpha", round: 1, position: 0 }] });
    const body = { requestId: "replace-1", revision: (await settings(chat.id)).revision, text: "CORRECT question", supersedes: { runId: old.id } };
    const replaced = (await service.start("owner", chat.id, body)).run!;
    expect(replaced).toMatchObject({ status: "running", topic: "CORRECT question" });
    expect((await hub.store.db.get<{ status: string; outcome: string }>("SELECT status,outcome FROM group_discussions WHERE id=?", [old.id]))).toEqual({ status: "ended", outcome: "stopped" });
    expect(await count("group_discussions WHERE status IN ('running','pausing','paused','ending')")).toBe(1);
    // A lost response replays the same result; a changed payload is refused.
    expect((await service.start("owner", chat.id, body)).run!.id).toBe(replaced.id);
    await expect(service.start("owner", chat.id, { ...body, text: "Other" })).rejects.toThrow("idempotency_conflict");
    // The new topic is not mistaken for a note of the ended run.
    expect((await service.step("owner", chat.id, old.id, old.steps[0]!.id)).botId).toBe("alpha");
    const ended = (await hub.store.db.get<{ id: string }>("SELECT id FROM group_discussions WHERE id=?", [old.id]))!;
    expect(ended.id).toBe(old.id);
  });

  it("refuses to supersede a run that already ended, while replays of a confirmed replacement still succeed", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const revision = (await settings(chat.id)).revision;
    // Another device ends the paused run; this device's "new topic" draft must not become a plain start.
    const first = (await start(chat.id, "TYPO question")).run!;
    await speak(chat.id, live(first)[0]!, "", "stopped");
    await service.control("owner", chat.id, first.id, { requestId: rid(), revision: (await view(chat.id)).revision, action: "end" });
    expect((await view(chat.id)).status).toBe("ended");
    const before = { runs: await count("group_discussions"), messages: await count("messages"), requests: await count("group_discussion_requests"), audits: await count("audit_log") };
    await expect(service.start("owner", chat.id, { requestId: "late-replace", revision, text: "CORRECT question", supersedes: { runId: first.id } })).rejects.toThrow("group_discussion_not_active");
    expect({ runs: await count("group_discussions"), messages: await count("messages"), requests: await count("group_discussion_requests"), audits: await count("audit_log") }).toEqual(before);
    // A confirmed replacement replays even after its superseded run is terminal.
    const second = (await start(chat.id, "Second")).run!;
    await speak(chat.id, live(second)[0]!, "", "stopped");
    const body = { requestId: "confirmed-replace", revision, text: "Third", supersedes: { runId: second.id } };
    const third = (await service.start("owner", chat.id, body)).run!;
    expect((await service.start("owner", chat.id, body)).run!.id).toBe(third.id);
    // An older terminal run named while the newer run is active: no side effects at all.
    const active = await view(chat.id);
    const snapshot = { messages: await count("messages"), deliveries: await count("deliveries"), runs: await count("group_discussions") };
    for (const old of [first.id, second.id]) {
      await expect(service.start("owner", chat.id, { requestId: rid(), revision, text: "Stale replace", supersedes: { runId: old } })).rejects.toThrow("group_discussion_not_active");
    }
    expect({ messages: await count("messages"), deliveries: await count("deliveries"), runs: await count("group_discussions") }).toEqual(snapshot);
    expect(await view(chat.id)).toMatchObject({ id: third.id, status: "running", revision: active.revision });
    expect(stop).not.toHaveBeenCalled();
    // A granted member who does not control the run is refused before any state changes.
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat.id]);
    for (const bot of bots) await hub.store.db.run("INSERT INTO bot_grants VALUES('member',?)", [bot]);
    await expect(service.start("member", chat.id, { requestId: rid(), revision, text: "x", supersedes: { runId: first.id } })).rejects.toThrow("group_discussion_control_forbidden");
  });

  it("rejects superseding a run that is still speaking, held elsewhere or not controllable", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const running = (await start(chat.id)).run!;
    const topics = await count("messages");
    const revision = (await settings(chat.id)).revision;
    await expect(service.start("owner", chat.id, { requestId: rid(), revision, text: "New", supersedes: { runId: running.id } })).rejects.toThrow("group_discussion_active");
    expect(await count("messages")).toBe(topics);
    expect((await view(chat.id)).status).toBe("running");
    // User pause before dispatch holds the input; superseding withdraws it without a Stop.
    await service.control("owner", chat.id, running.id, { requestId: rid(), revision: running.revision, action: "pause" });
    expect(await view(chat.id)).toMatchObject({ status: "paused", pauseReason: "user" });
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat.id]);
    await expect(service.start("member", chat.id, { requestId: rid(), revision, text: "Hijack", supersedes: { runId: running.id } })).rejects.toThrow();
    const other = await group(); await mode(other, { mode: "sequential" });
    await expect(service.start("owner", other.id, { requestId: rid(), revision: (await settings(other.id)).revision, text: "Elsewhere", supersedes: { runId: running.id } })).rejects.toThrow("group_discussion_not_found");
    const replaced = (await service.start("owner", chat.id, { requestId: rid(), revision, text: "New", supersedes: { runId: running.id } })).run!;
    expect(replaced.status).toBe("running");
    expect(stop).not.toHaveBeenCalled();
    expect(await hub.store.db.get("SELECT status FROM deliveries WHERE message_id=?", [running.steps[0]!.inputMessageId])).toEqual({ status: "cancelled" });
  });

  it("adds a note and continues in one decision, or stores nothing", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id, "TYPO question")).run!;
    await speak(chat.id, live(run)[0]!, "", "stopped");
    let paused = await view(chat.id);
    const notes = await count("messages WHERE client_msg_id LIKE 'gdnote_%'");
    // Stale revision: neither the note nor the control commits.
    await expect(note(chat.id, run.id, "CORRECT question", { then: "resume", revision: "r1" })).rejects.toThrow("group_discussion_conflict");
    expect(await count("messages WHERE client_msg_id LIKE 'gdnote_%'")).toBe(notes);
    // A note written against a running view is refused rather than parked.
    await expect(note(chat.id, run.id, "parked?", { ifRunning: true })).rejects.toThrow("group_discussion_paused");
    expect(await count("messages WHERE client_msg_id LIKE 'gdnote_%'")).toBe(notes);
    const body = { requestId: "add-continue", text: "CORRECT question", then: "resume", revision: paused.revision };
    const resumed = (await service.note("owner", chat.id, run.id, body)).run!;
    expect(resumed.status).toBe("running");
    const beta = live(resumed)[0]!;
    expect(beta.botId).toBe("beta");
    expect(await notesOf(beta)).toEqual(["CORRECT question"]);
    expect(resumed).toMatchObject({ noteCount: 1, latestNote: { text: "CORRECT question" }, unseenNoteCount: 0 });
    expect((await service.note("owner", chat.id, run.id, body)).run!.id).toBe(run.id);   // replay
    expect(await count("messages WHERE client_msg_id LIKE 'gdnote_%'")).toBe(notes + 1);
    // Note + retry reruns the stopped speaker with the note.
    await speak(chat.id, beta, "", "stopped");
    paused = await view(chat.id);
    const retried = (await note(chat.id, run.id, "Second correction", { then: "retry", revision: paused.revision })).run!;
    const again = live(retried)[0]!;
    expect(again).toMatchObject({ botId: "beta", attempt: 2 });
    expect(await notesOf(again)).toEqual(["CORRECT question", "Second correction"]);
  });

  it("control: pause binds to the exact run but only pauses a running run; resume keeps its CAS", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    const stale = run.revision;
    await dispatch(live(run)[0]!); await service.markDispatched("alpha", live(run)[0]!.inputMessageId!);
    expect((await service.control("owner", chat.id, run.id, { requestId: rid(), revision: stale, action: "pause" })).run!.status).toBe("pausing");
    await speak(chat.id, live(await view(chat.id))[0]!, "", "stopped");
    const paused = await view(chat.id);
    expect(paused.status).toBe("paused");
    // A stale resume is still a conflict; a stale pause of a paused run is a no-op.
    await expect(service.control("owner", chat.id, run.id, { requestId: rid(), revision: stale, action: "resume" })).rejects.toThrow("group_discussion_conflict");
    expect((await service.control("owner", chat.id, run.id, { requestId: rid(), revision: stale, action: "pause" })).run!.revision).toBe(paused.revision);
    await service.control("owner", chat.id, run.id, { requestId: rid(), revision: paused.revision, action: "end" });
    // An old pause can never reopen or alter a terminal run.
    await expect(service.control("owner", chat.id, run.id, { requestId: rid(), revision: stale, action: "pause" })).rejects.toThrow("group_discussion_conflict");
    expect((await view(chat.id)).status).toBe("ended");
  });
});

describe("notes are never silently dropped", () => {
  it("gives every Bot its unseen notes oldest first and carries overflow to its next turn", async () => {
    const chat = await group(["alpha", "beta"]); await mode(chat, { mode: "sequential", maxRounds: 3 });
    const run = (await start(chat.id, "TYPO question")).run!;
    for (let i = 1; i <= 12; i++) await note(chat.id, run.id, i === 1 ? "CORRECT question" : `note ${i}`);
    await speak(chat.id, live(run)[0]!, "alpha 1");
    let step = live(await view(chat.id))[0]!;
    let given = await notesOf(step);
    expect(given[0]).toBe("CORRECT question");
    expect(given).toHaveLength(10);
    expect(given.at(-1)).toContain("3 more user note(s)");
    const dispatched = await service.dispatch(step.botId, step.inputMessageId!);
    expect(Object.keys(dispatched!)).not.toContain("noteIds");
    expect(await view(chat.id)).toMatchObject({ noteCount: 12, latestNote: { text: "note 12" }, unseenNoteCount: 3 });
    await speak(chat.id, step, "beta 1");
    step = live(await view(chat.id))[0]!;   // alpha round 2: its first notes
    given = await notesOf(step);
    expect(given[0]).toBe("CORRECT question");
    await speak(chat.id, step, "alpha 2");
    step = live(await view(chat.id))[0]!;   // beta round 2: only the carried three
    expect(await notesOf(step)).toEqual(["note 10", "note 11", "note 12"]);
    expect((await view(chat.id)).unseenNoteCount).toBe(0);
  });

  it("reports notes that no Bot received once the run ends", async () => {
    const chat = await group(["alpha", "beta"]); await mode(chat, { mode: "sequential", maxRounds: 1 });
    let run = (await start(chat.id)).run!;
    await speak(chat.id, live(run)[0]!, "a");
    run = await view(chat.id);
    const late = await note(chat.id, run.id, "LATE note");
    await speak(chat.id, live(run)[0]!, "b");
    run = await view(chat.id);
    expect(run.status).toBe("completed");
    expect(run).toMatchObject({ noteCount: 1, unseenNoteCount: 1 });
    expect(run.unseenNotes).toEqual([late.run!.latestNote!.messageId]);
  });

  it("counts only this run's own conversation, and honours deletions", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const topic = await hub.store.createConversation("owner", [], "Topic", rid("topic"), { parentId: chat.id });
    const run = (await start(chat.id)).run!;
    await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: rid(), text: "topic chatter", attachments: [] });
    const kept = await note(chat.id, run.id, "kept note");
    const removed = await note(chat.id, run.id, "removed note");
    await hub.store.db.run("UPDATE messages SET status='deleted' WHERE id=?", [removed.run!.latestNote!.messageId]);
    expect(await view(chat.id)).toMatchObject({ noteCount: 1, latestNote: { text: "kept note" } });
    // A reader's own history deletion hides the preview for that reader only.
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [chat.id]);
    const beforeDelete = await service.view("owner", chat.id);
    const known = `${beforeDelete.run!.id}.${beforeDelete.run!.revision}.${beforeDelete.settings.revision}`;
    expect(await service.read("owner", chat.id, undefined, { known })).toEqual({ unchanged: true });
    await hub.store.deleteMessages("owner", chat.id, { messageIds: [kept.run!.latestNote!.messageId] });
    const refreshed = await service.read("owner", chat.id, undefined, { known });
    expect(refreshed).not.toEqual({ unchanged: true });
    if ("unchanged" in refreshed) throw new Error("Deleted note view was cached");
    expect(refreshed.run?.revision).toBe(beforeDelete.run!.revision);
    expect(await service.read("owner", chat.id, undefined, { known: refreshed.viewRevision })).toEqual({ unchanged: true });
    // The shared run/CAS and other readers' cached views remain unchanged.
    expect(await service.read("member", chat.id, undefined, { known })).toEqual({ unchanged: true });
    const mine = await view(chat.id);
    expect(mine.noteCount).toBe(0);
    expect(mine.latestNote).toBeUndefined();
    expect((await service.view("member", chat.id)).run).toMatchObject({ noteCount: 1, latestNote: { text: "kept note" } });
  });

  it("keeps older run contexts readable without note tracking", async () => {
    const chat = await group(["alpha", "beta"]); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id)).run!;
    await note(chat.id, run.id, "before beta");
    await speak(chat.id, live(run)[0]!, "a");
    const beta = live(await view(chat.id))[0]!;
    // Simulate a context frozen by the previous scheduler version.
    const row = (await hub.store.db.get<{ context_json: string }>("SELECT context_json FROM group_discussion_turns WHERE id=?", [beta.id]))!;
    const { noteIds: _ignored, ...legacy } = JSON.parse(row.context_json) as Record<string, unknown>;
    await hub.store.db.run("UPDATE group_discussion_turns SET context_json=? WHERE id=?", [JSON.stringify(legacy), beta.id]);
    expect(await notesOf(beta)).toEqual(["before beta"]);
    await speak(chat.id, beta, "b");
    expect((await view(chat.id)).unseenNoteCount).toBe(0);
  });
});

describe("speakers and addressing", () => {
  it("runs only the selected speakers, in the saved order", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const run = (await start(chat.id, "Topic", { participants: ["gamma", "alpha"] })).run!;
    expect(run.participants.map(participant => participant.botId)).toEqual(["alpha", "gamma"]);
    expect(run.next).toMatchObject({ botId: "gamma", round: 1 });
    await speak(chat.id, live(run)[0]!, "a");
    expect(live(await view(chat.id)).map(step => step.botId)).toEqual(["gamma"]);
    // A non-participant may be removed during the run; participants may not.
    const current = await settings(chat.id);
    await hub.store.updateGroup("owner", chat.id, { title: current.group.title, botIds: ["alpha", "gamma"], expectedTitle: current.group.title, expectedBotIds: current.group.botIds });
    const after = await settings(chat.id);
    await expect(hub.store.updateGroup("owner", chat.id, { title: after.group.title, botIds: ["alpha"], expectedTitle: after.group.title, expectedBotIds: after.group.botIds })).rejects.toThrow("group_discussion_active");
  });

  it("validates the selection against the current members and settings revision", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential" });
    await expect(start(chat.id, "Topic", { participants: ["alpha", "delta"] })).rejects.toThrow("group_discussion_participants_invalid");
    await expect(start(chat.id, "Topic", { participants: ["alpha"] })).rejects.toThrow();
    await expect(start(chat.id, "Topic", { participants: ["alpha", "alpha"] })).rejects.toThrow();
    await expect(service.start("owner", chat.id, { requestId: rid(), revision: "gs_stale", text: "Topic", participants: ["alpha", "beta"] })).rejects.toThrow("group_settings_conflict");
    expect(await count("group_discussions")).toBe(0);
  });

  it("never fans an @ out beside a run, and takes turns instead of fanning out in discussion modes", async () => {
    const chat = await group(); await mode(chat, { mode: "sequential", maxRounds: 2 });
    const send = (extra: object) => hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: rid("send"), text: "@ hello", attachments: [], ...extra });
    const recipients = async (id: string) => (await hub.store.db.all<{ bot_id: string }>("SELECT bot_id FROM deliveries WHERE message_id=? ORDER BY bot_id", [id])).map(row => row.bot_id);
    await expect(send({ mentions: ["alpha", "beta"] })).rejects.toThrow("group_discussion_start_required");
    const revision = (await settings(chat.id)).revision;
    await expect(send({ mentions: ["alpha", "beta"], groupReplyGuard: { mode: "sequential", revision } })).rejects.toThrow("group_discussion_start_required");
    await expect(send({ groupReplyGuard: { mode: "sequential", revision } })).rejects.toThrow("group_discussion_start_required");
    // One named Bot outside a run is a temporary directed reply.
    const single = await send({ mentions: ["beta"], groupReplyGuard: { mode: "sequential", revision } });
    expect(await recipients(single.message.id)).toEqual(["beta"]);
    const run = (await start(chat.id)).run!;
    expect(groupDiscussionActive(run)).toBe(true);
    await expect(send({ mentions: ["beta"] })).rejects.toThrow("group_discussion_active");
    await expect(send({ mentions: ["beta"], groupReplyGuard: { mode: "sequential", revision } })).rejects.toThrow("group_reply_mode_changed");
    // A separate topic is a separate conversation; its directed reply is unaffected.
    const topic = await hub.store.createConversation("owner", [], "Topic", rid("topic"), { parentId: chat.id });
    const elsewhere = await hub.store.sendMessage("owner", { conversationId: topic.id, clientMsgId: rid(), text: "hi", attachments: [], mentions: ["gamma"] });
    expect(await recipients(elsewhere.message.id)).toEqual(["gamma"]);
    expect(await count("deliveries WHERE bot_id='beta' AND status='pending'")).toBe(1);   // only the directed reply
  });

  it("leaves ordinary group-chat addressing unchanged", async () => {
    const chat = await group();
    const sent = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: rid(), text: "both", attachments: [], mentions: ["alpha", "beta"] });
    expect(await count("deliveries WHERE message_id=?", [sent.message.id])).toBe(2);
    expect((await settings(chat.id)).policy.mode).toBe("mentions");
  });

  it("advertises the recovery capability and asks speakers for brief passes", () => {
    expect(CAPABILITIES).toContain(GROUP_DISCUSSION_RECOVERY_CAPABILITY);
    const text = groupDiscussionInstructions({ v: 1, runId: "gd_x", turnId: "gdt_x", conversationId: "c", mode: "sequential", stage: "discussion", round: 1, maxRounds: 2, position: 0, attempt: 1,
      self: { botId: "alpha", name: "A" }, participants: [{ botId: "alpha", name: "A" }, { botId: "beta", name: "B" }], topic: "t", topicAttachments: [], references: [], positions: [], notes: [], remainingRounds: 1 });
    expect(text).toContain("nothing new to add");
  });
});

describe("independent first round recovery", () => {
  it("does not continue without any first-round answer; Retry reruns every unfinished answer", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    let run = (await start(chat.id)).run!;
    for (const step of live(run)) await speak(chat.id, step, "", "stopped");
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", pauseReason: "turn_stopped", actions: ["retry", "end"] });
    expect(run.retryTargets!.map(target => target.botId)).toEqual(["alpha", "beta", "gamma"]);
    await expect(service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "resume" })).rejects.toThrow("group_discussion_resume_unavailable");
    run = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "retry" })).run!;
    expect(live(run).map(step => [step.botId, step.attempt, step.blind])).toEqual([["alpha", 2, true], ["beta", 2, true], ["gamma", 2, true]]);
    // Mixed: one answer completes, two stop. Retry reruns only the two.
    const [alpha, beta, gamma] = live(run);
    await speak(chat.id, alpha!, "alpha answer");
    await speak(chat.id, beta!, "", "stopped");
    await speak(chat.id, gamma!, "", "stopped");
    run = await view(chat.id);
    expect(run.actions).toEqual(["resume", "retry", "end"]);
    expect(run.retryTargets!.map(target => target.botId)).toEqual(["beta", "gamma"]);
    run = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "retry" })).run!;
    expect(live(run).map(step => step.botId)).toEqual(["beta", "gamma"]);
    expect(run.steps.filter(step => step.botId === "alpha" && step.status === "completed")).toHaveLength(1);
    // With at least one answer, Continue skips the rest and reveals.
    for (const step of live(run)) await speak(chat.id, step, "", "stopped");
    run = await view(chat.id);
    run = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "resume" })).run!;
    expect(run.stage).toBe("discussion");
    expect(live(run)[0]).toMatchObject({ botId: "alpha", round: 2, blind: false });
  });

  it("delivers the user's corrections to first-round retries, never a member's withheld answer", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    let run = (await start(chat.id, "TYPO question")).run!;
    const [alpha, beta, gamma] = live(run);
    // A note while every first-round answer is already running cannot change them.
    const early = (await note(chat.id, run.id, "EARLY note")).run!;
    expect(early).toMatchObject({ noteCount: 1, unseenNoteCount: 1 });
    await speak(chat.id, alpha!, "Alpha says React", "done", { stance: "propose", proposal: "React", summary: "React" });
    const alphaReply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, replyTo: alpha!.inputMessageId!, blocks: [{ type: "text", text: "Alpha says React" }], status: "complete" });
    // Quoting a member's sealed answer in a note must not leak it to the others.
    await note(chat.id, run.id, "see this", { replyTo: alphaReply.id });
    await speak(chat.id, beta!, "", "stopped");
    await speak(chat.id, gamma!, "", "stopped");
    run = await view(chat.id);
    expect(run).toMatchObject({ status: "paused", actions: ["resume", "retry", "end"] });
    run = (await note(chat.id, run.id, "CORRECTION", { then: "retry", revision: run.revision })).run!;
    let retries = live(run);
    expect(retries.map(step => [step.botId, step.attempt, step.blind])).toEqual([["beta", 2, true], ["gamma", 2, true]]);
    for (const step of retries) {
      const context = (await service.dispatch(step.botId, step.inputMessageId!))!;
      expect(context).toMatchObject({ stage: "blind", references: [], positions: [] });
      expect(context.notes).toEqual(["EARLY note", "see this\n[Quoted member reply withheld in the independent first round]", "CORRECTION"]);
      expect(JSON.stringify(context)).not.toContain("React");
      const input = await hub.store.db.serial(() => hub.store.queuedMessageInTransaction(step.inputMessageId!));
      expect(JSON.stringify(input.blocks)).not.toContain("React");
    }
    expect(run.unseenNoteCount).toBe(0);
    // The rendered first-round prompt carries the notes outside peer material.
    const rendered = groupDiscussionReference((await service.dispatch("beta", retries[0]!.inputMessageId!))!);
    expect(rendered).toContain("- CORRECTION");
    expect(rendered).toContain("independent first round");
    // A later retry still receives everything that Bot has not received.
    await speak(chat.id, retries[0]!, "Beta answer", "done", { stance: "abstain", summary: "b" });
    await speak(chat.id, retries[1]!, "", "stopped");
    run = await view(chat.id);
    run = (await note(chat.id, run.id, "LATE", { then: "retry", revision: run.revision })).run!;
    retries = live(run);
    expect(retries.map(step => [step.botId, step.attempt])).toEqual([["gamma", 3]]);
    expect(await notesOf(retries[0]!)).toEqual(["EARLY note", "see this\n[Quoted member reply withheld in the independent first round]", "CORRECTION", "LATE"]);
    await speak(chat.id, retries[0]!, "Gamma answer", "done", { stance: "abstain", summary: "g" });
    // Revealed: Alpha (answered before any note) now gets every note, quote included;
    // Beta only the one its successful retry did not receive.
    run = await view(chat.id);
    expect(run.stage).toBe("discussion");
    const alphaRound2 = live(run)[0]!;
    expect(alphaRound2).toMatchObject({ botId: "alpha", round: 2 });
    const alphaNotes = await notesOf(alphaRound2);
    expect(alphaNotes).toHaveLength(4);
    expect(alphaNotes[1]).toContain("[Quoted reference]\nAlpha says React");
    await speak(chat.id, alphaRound2, "a2", "done", { stance: "agree", proposalId: "P1", summary: "ok" });
    expect(await notesOf(live(await view(chat.id))[0]!)).toEqual(["LATE"]);
  });

  it("bounds repeated first-round retries by the run's turn limit", async () => {
    const chat = await group(); await mode(chat, { mode: "independent", maxRounds: 2 });
    let run = (await start(chat.id)).run!;
    for (;;) {
      for (const step of live(run)) await speak(chat.id, step, "", "stopped");
      run = await view(chat.id);
      if (!run.actions!.includes("retry")) break;
      run = (await service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "retry" })).run!;
    }
    expect(run.steps.length).toBeLessThanOrEqual(GROUP_DISCUSSION_MAX_STEPS);
    expect(run.steps.length + 3).toBeGreaterThan(GROUP_DISCUSSION_MAX_STEPS);
    await expect(service.control("owner", chat.id, run.id, { requestId: rid(), revision: run.revision, action: "retry" })).rejects.toThrow("group_discussion_turn_limit");
    expect(run.actions).toEqual(["end"]);
  });
});
