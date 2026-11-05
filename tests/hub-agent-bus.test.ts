import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentBusConfigSchema, AGENT_BUS_STAGE_EXTRA, type AgentBusConfig, type AgentBusDetail, type AgentBusRun, type AgentBusWorkspace } from "../src/client-protocol/agent-bus.js";
import { runAgentBusCommand } from "../src/host-cli/agent-bus.js";
import { blocksText, type Block } from "../src/client-protocol/index.js";
import { deviceProof } from "../src/hub/auth.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { promptQueueMove } from "../client/src/prompt-queue-order.js";
import { HubServer } from "../src/hub/server.js";
import { HubAgentBuses } from "../src/hub/agent-bus.js";
import { assertHostRuntimeCompatible } from "../src/host-cli/schema-guard.js";

const ids = ["alpha", "beta", "gamma", "delta", "epsilon"];
const config = (patch: Partial<AgentBusConfig> = {}): AgentBusConfig => agentBusConfigSchema.parse({ name: "Review desk", mode: "fan", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }, { botId: "gamma" }], ...patch });

describe("Hub Agent Bus workspaces", () => {
  let root: string, hub: HubServer;
  const buses = () => hub.agentBuses;
  const messages = async (conversationId: string) => (await hub.store.listMessages("owner", conversationId)).messages;
  const delivery = (messageId: string) => hub.store.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id='alpha'", [messageId]);
  const dispatch = (messageId: string) => hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='alpha'", [messageId]);
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-agent-bus-"));
    hub = await HubServer.start({ stateDir: root });
    for (const id of ids) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `Name ${id}`, "fixture"]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
    }
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('external','External','fixture')");
  });
  afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

  it.each(["review this change", "/review this change", "/stop"])("keeps Bus goal %s behind an active turn without dispatching editable prompts", async text => {
    await hub.store.db.run("UPDATE bots SET engine='codex' WHERE id='alpha'");
    const queue = new HubPromptQueue(hub.store);
    await queue.registerWorker("alpha", true);
    const bus = await buses().create("owner", { requestId: "queued-goal", config: config() });
    const conversationId = bus.coordinator.conversationId;
    const send = (clientMsgId: string) => hub.store.sendMessage("owner", { conversationId, clientMsgId, text: clientMsgId, attachments: [] });
    const first = await send("first");
    expect((await queue.claim("alpha", true, false)).map(message => message.id)).toEqual([first.message.id]);
    const waiting = await send("waiting");
    const run = await buses().start("owner", bus.id, { requestId: "queued-run", revision: bus.revision, text });
    // Both legacy push workers and pull workers must respect the active turn.
    for (const pull of [undefined, { ready: new Set<string>() }]) {
      expect(await queue.claim("alpha", true, false, () => true, true, true, true, pull)).toEqual([]);
      const snapshot = await queue.read("owner", "alpha", conversationId);
      expect(snapshot.items.find(item => item.message.id === waiting.message.id)).toMatchObject({ state: "queued", canCancel: true, canEdit: true });
      expect(snapshot.items.find(item => item.message.id === run.messageId)).toMatchObject({ state: "queued", canCancel: false, canEdit: false });
    }
    // Moving an ordinary prompt across a Bus input must not depend on goal text.
    const snapshot = await queue.read("owner", "alpha", conversationId);
    expect(snapshot.items.find(item => item.message.id === run.messageId)).toMatchObject({ canMove: false, canCancel: false, reorderBarrier: false });
    const move = promptQueueMove(snapshot.items.filter(item => item.state === "queued"), waiting.message.id, run.messageId, true);
    expect(move).toEqual({ beforeId: null, after: true });
    const moved = await queue.mutate("owner", conversationId, { botId: "alpha", requestId: "move-after-bus", revision: snapshot.revision, action: { type: "move", messageId: waiting.message.id, beforeId: move!.beforeId } });
    expect(moved.items.map(item => item.message.id)).toEqual([first.message.id, run.messageId, waiting.message.id]);
    expect((await buses().stop("owner", bus.id, run.id, { requestId: "stop-queued" })).status).toBe("cancelled");
  });

  it("validates the shared schema shape before any Hub work", () => {
    expect(() => config({ coordinator: { botId: "alpha", conversationId: "same-chat" }, members: [{ botId: "alpha", conversationId: "same-chat" }] })).toThrow("agent_bus_duplicate_member");
    expect(() => config({ mode: "ask" })).toThrow("agent_bus_member_count");
    expect(() => config({ mode: "verify", members: [{ botId: "beta" }, { botId: "gamma" }] })).toThrow("agent_bus_member_count");
    expect(() => config({ mode: "crew" })).toThrow("agent_bus_member_count");
    expect(() => config({ members: Array.from({ length: 12 }, (_, i) => ({ botId: `bot${i}` })) })).toThrow();
    expect(config({ mode: "crew", members: ["beta", "gamma", "delta", "epsilon"].map(botId => ({ botId })) }).maxResearchQuestions).toBe(5);
  });

  it("keeps repeated Bots separate through save, reorder, stage reports and replay", async () => {
    const bus = await buses().create("owner", { requestId: "repeat", config: config({ mode: "chain", members: [{ botId: "alpha", instruction: "research" }, { botId: "alpha", instruction: "valuation" }] }) });
    expect(new Set([bus.coordinator, ...bus.members].map(m => m.conversationId)).size).toBe(3);
    const reordered = await buses().update("owner", bus.id, { revision: bus.revision, config: config({ coordinator: bus.coordinator, mode: "chain", members: [...bus.members].reverse() }) });
    expect(reordered.members).toEqual([...bus.members].reverse());
    const run = await buses().start("owner", bus.id, { revision: reordered.revision, requestId: "run-repeat", text: "task" });
    expect(run.snapshot.members.map(member => member.instruction)).toEqual(["valuation", "research"]);
    expect(await buses().dispatch("alpha", run.messageId)).toMatchObject({ instructions: ["valuation", "research"] });
    await dispatch(run.messageId);
    const base = { runId: run.id, messageId: run.messageId, stageId: "s1", botId: "alpha" };
    // Old/ambiguous or spoofed stage identity must not write to any conversation.
    await expect(buses().event("alpha", { ...base, type: "stage.started", prompt: "x" })).rejects.toThrow("agent_bus_stage_forbidden");
    await expect(buses().event("alpha", { ...base, conversationId: "wrong", type: "stage.started", prompt: "x" })).rejects.toThrow("agent_bus_stage_forbidden");
    await buses().event("alpha", { ...base, conversationId: reordered.members[0]!.conversationId, type: "stage.started", prompt: "first" });
    await expect(buses().event("alpha", { ...base, conversationId: reordered.members[1]!.conversationId, type: "stage.finished", status: "completed", text: "wrong" })).rejects.toThrow("agent_bus_stage_forbidden");
    const event = { ...base, conversationId: reordered.members[0]!.conversationId, type: "stage.finished", status: "completed", text: "first result" };
    await buses().event("alpha", event); await buses().event("alpha", event);
    expect(await messages(reordered.members[0]!.conversationId)).toHaveLength(1);
    expect(blocksText((await messages(reordered.members[0]!.conversationId))[0]!.blocks)).toContain("first result");
    expect(await messages(reordered.members[1]!.conversationId)).toHaveLength(0);
    expect((await buses().detail("owner", bus.id)).runs[0]!.stages[0]).toMatchObject({ botId: "alpha", conversationId: reordered.members[0]!.conversationId });
  });

  it("upgrades old definitions and queued snapshots without adding tasks or changing dispatch", async () => {
    const bus = await buses().create("owner", { requestId: "old-config", config: config({ mode: "chain" }) });
    const run = await buses().start("owner", bus.id, { requestId: "old-run", revision: bus.revision, text: "original task" });
    const before = await buses().dispatch("alpha", run.messageId);
    await hub.store.db.run("UPDATE meta SET value='18' WHERE key='schema_version'");
    await hub.close(); hub = await HubServer.start({ stateDir: root });
    expect(await buses().dispatch("alpha", run.messageId)).toEqual(before);
    expect((await buses().detail("owner", bus.id)).workspace).toMatchObject({ coordinator: bus.coordinator, members: bus.members });
    expect((await buses().detail("owner", bus.id)).runs[0]!.snapshot).toEqual(run.snapshot);
    expect(before).not.toHaveProperty("instructions");
  });

  it("creates dedicated chats idempotently, enforces CAS and keeps chats on delete", async () => {
    const created = await buses().create("owner", { requestId: "create-1", config: config() });
    expect(created).toMatchObject({ name: "Review desk", mode: "fan", coordinator: { botId: "alpha" }, members: [{ botId: "beta" }, { botId: "gamma" }] });
    const conversations = await hub.store.conversations("owner");
    for (const [index, member] of [created.coordinator, ...created.members].entries()) {
      expect(conversations.find(c => c.id === member.conversationId)).toMatchObject({ type: "direct", botIds: [member.botId], title: `Review desk · ${index === 0 ? "发起者" : `成员 ${index}`} · Name ${member.botId}` });
    }
    expect(await buses().create("owner", { requestId: "create-1", config: config() })).toMatchObject({ id: created.id, revision: created.revision });
    expect((await hub.store.conversations("owner")).length).toBe(3);
    await expect(buses().create("owner", { requestId: "create-1", config: config({ name: "Other" }) })).rejects.toThrow("idempotency_conflict");

    await expect(buses().update("owner", created.id, { revision: "rev_stale", config: config({ name: "Renamed" }) })).rejects.toThrow("agent_bus_conflict");
    const removedGamma = await buses().update("owner", created.id, { revision: created.revision, config: config({ members: [{ botId: "beta" }] }) });
    const readded = await buses().update("owner", created.id, { revision: removedGamma.revision, config: config() });
    // A returning member reuses its dedicated chat instead of duplicating it.
    expect(readded.members[1]!.conversationId).toBe(created.members[1]!.conversationId);
    expect((await hub.store.conversations("owner")).length).toBe(3);
    expect(await buses().list("owner")).toEqual([readded]);

    await expect(buses().remove("owner", created.id, { revision: created.revision })).rejects.toThrow("agent_bus_conflict");
    expect(await buses().remove("owner", created.id, { revision: readded.revision })).toEqual({ ok: true });
    expect(await buses().list("owner")).toEqual([]);
    expect((await hub.store.conversations("owner")).length).toBe(3);
    await expect(buses().create("owner", { requestId: "create-1", config: config() })).rejects.toThrow("agent_bus_deleted");
  });

  it.each([
    ["ask", ["成员 1"]], ["fan", ["成员 1", "成员 2"]], ["chain", ["步骤 1", "步骤 2"]],
    ["verify", ["复核者"]], ["crew", ["研究员", "分析员", "撰写者", "审阅者"]],
  ] as const)("names new %s dedicated records by their roles", async (mode, roles) => {
    const bus = await buses().create("owner", { requestId: "role-titles", config: config({ mode, members: roles.map((_, index) => ({ botId: ids[index + 1]! })) }) });
    const conversations = await hub.store.conversations("owner");
    for (const [index, member] of bus.members.entries()) expect(conversations.find(c => c.id === member.conversationId)?.title).toBe(`Review desk · ${roles[index]} · Name ${member.botId}`);
  });

  it("maintains automatic titles through rename and repeated-Bot reorder without changing history", async () => {
    const notify = vi.fn();
    const service = new HubAgentBuses(hub.store, { workerCapable: () => true, stop: async () => undefined, conversationsCreated: notify });
    const first = await service.create("owner", { requestId: "rename-titles", config: config({ mode: "chain", members: [{ botId: "beta" }, { botId: "beta" }] }) });
    const run = await service.start("owner", first.id, { requestId: "before-rename", revision: first.revision, text: "Keep this historical goal" });
    await service.stop("owner", first.id, run.id, { requestId: "stop-before-rename" });
    const history = await messages(first.coordinator.conversationId);
    notify.mockClear();
    const renamed = await service.update("owner", first.id, { revision: first.revision, config: config({ name: "Renamed", mode: "chain", coordinator: first.coordinator, members: [...first.members].reverse() }) });
    const expected = [renamed.coordinator, ...renamed.members].map((member, index) => expect.objectContaining({ id: member.conversationId, title: `Renamed · ${index ? `步骤 ${index}` : "发起者"} · Name ${member.botId}` }));
    expect(await hub.store.conversations("owner")).toEqual(expect.arrayContaining(expected));
    expect(notify).toHaveBeenCalledExactlyOnceWith("owner", expect.arrayContaining(expected));
    expect(await messages(first.coordinator.conversationId)).toEqual(history);
    expect((await service.detail("owner", first.id)).runs[0]!.snapshot).toEqual(run.snapshot);
    const again = await service.update("owner", first.id, { revision: renamed.revision, config: config({ name: "Renamed again", mode: "fan", coordinator: renamed.coordinator, members: [...renamed.members].reverse() }) });
    const conversations = await hub.store.conversations("owner");
    for (const [index, member] of again.members.entries()) expect(conversations.find(c => c.id === member.conversationId)?.title).toBe(`Renamed again · 成员 ${index + 1} · Name beta`);
  });

  it("preserves user titles, ordinary history and another Bus's dedicated records", async () => {
    const other = await buses().create("owner", { requestId: "other-titles", config: config({ mode: "chain", members: [{ botId: "beta" }, { botId: "gamma" }, { botId: "delta" }] }) });
    const ordinary = await hub.store.createConversation("owner", ["gamma"], "Review desk · 步骤 2 · Name gamma", "agentbus_user_history");
    const first = await buses().create("owner", { requestId: "preserve-titles", config: config({ mode: "chain", members: [{ botId: "beta" }, { botId: "gamma", conversationId: ordinary.id }, other.members[2]!] }) });
    await hub.store.updateConversation("owner", first.members[0]!.conversationId, { title: "My research notes" });
    await buses().update("owner", first.id, { revision: first.revision, config: config({ name: "Renamed", mode: "chain", coordinator: first.coordinator, members: first.members }) });
    const conversations = await hub.store.conversations("owner");
    expect(conversations.find(c => c.id === first.members[0]!.conversationId)?.title).toBe("My research notes");
    expect(conversations.find(c => c.id === ordinary.id)?.title).toBe(ordinary.title);
    expect(conversations.find(c => c.id === other.members[2]!.conversationId)?.title).toBe("Review desk · 步骤 3 · Name delta");
    expect(conversations.find(c => c.id === first.coordinator.conversationId)?.title).toBe("Renamed · 发起者 · Name alpha");
  });

  it("upgrades exact legacy titles and maintains replacement titles while leaving archived records alone", async () => {
    const first = await buses().create("owner", { requestId: "legacy-titles", config: config() });
    const oldAction = `agentbus_${createHash("sha256").update(JSON.stringify([first.id, "beta"])).digest("hex").slice(0, 40)}`;
    await hub.store.db.run("UPDATE conversations SET title=?,client_action_id=? WHERE id=?", ["Review desk · 步骤 1 · Name beta", oldAction, first.members[0]!.conversationId]);
    const next = await buses().update("owner", first.id, { revision: first.revision, config: config({ name: "Renamed", coordinator: first.coordinator, members: first.members }) });
    expect((await hub.store.conversations("owner")).find(c => c.id === first.members[0]!.conversationId)?.title).toBe("Renamed · 成员 1 · Name beta");
    const retired = next.members[1]!.conversationId;
    await hub.store.updateConversation("owner", retired, { archived: true });
    const repaired = await buses().update("owner", first.id, { revision: next.revision, config: config({ name: "Renamed", coordinator: next.coordinator, members: [next.members[0]!, { botId: "gamma" }] }) });
    await buses().update("owner", first.id, { revision: repaired.revision, config: config({ name: "Current", coordinator: repaired.coordinator, members: repaired.members }) });
    const conversations = await hub.store.conversations("owner");
    expect(conversations.find(c => c.id === repaired.members[1]!.conversationId)?.title).toBe("Current · 成员 2 · Name gamma");
    expect(conversations.find(c => c.id === retired)).toMatchObject({ title: "Renamed · 成员 2 · Name gamma", archived: true });
  });

  it("does not publish or persist title changes when saving any participant fails", async () => {
    const notify = vi.fn();
    const service = new HubAgentBuses(hub.store, { workerCapable: () => true, stop: async () => undefined, conversationsCreated: notify });
    const first = await service.create("owner", { requestId: "atomic-titles", config: config() });
    const before = await hub.store.conversations("owner");
    notify.mockClear();
    await expect(service.update("owner", first.id, { revision: first.revision, config: config({ name: "Failed rename", coordinator: first.coordinator, members: [first.members[0]!, { botId: "external" }] }) })).rejects.toThrow("agent_bus_bot_unavailable");
    expect(await hub.store.conversations("owner")).toEqual(before);
    expect((await service.detail("owner", first.id)).workspace.revision).toBe(first.revision);
    expect(notify).not.toHaveBeenCalled();
    const run = hub.store.db.run.bind(hub.store.db);
    const write = vi.spyOn(hub.store.db, "run").mockImplementation((sql, params) => sql.startsWith("UPDATE agent_buses SET revision=") ? Promise.reject(new Error("save_failed")) : run(sql, params));
    try {
      await expect(service.update("owner", first.id, { revision: first.revision, config: config({ name: "Rolled back", coordinator: first.coordinator, members: first.members }) })).rejects.toThrow("save_failed");
    } finally { write.mockRestore(); }
    expect(await hub.store.conversations("owner")).toEqual(before);
    expect((await service.detail("owner", first.id)).workspace.revision).toBe(first.revision);
    expect(notify).not.toHaveBeenCalled();
  });

  it("allocates an unreserved dedicated chat after repeated Bot slots are reordered", async () => {
    const first = await buses().create("owner", { requestId: "slot-defaults", config: config({ members: [{ botId: "beta" }, { botId: "beta" }] }) });
    const nextConfig = config({ coordinator: first.coordinator, members: [first.members[1]!, { botId: "beta" }] });
    const second = await buses().update("owner", first.id, { revision: first.revision, config: nextConfig });
    expect(second.members[0]).toEqual(first.members[1]);
    expect(second.members[1]!.conversationId).not.toBe(second.members[0]!.conversationId);
    const third = await buses().update("owner", first.id, { revision: second.revision, config: nextConfig });
    expect(third.members).toEqual(second.members);
    expect((await hub.store.conversations("owner")).length).toBe(4);
  });

  it("preserves a pre-v2 dedicated conversation when updating an omitted binding", async () => {
    const first = await buses().create("owner", { requestId: "legacy-binding", config: config() });
    const oldAction = `agentbus_${createHash("sha256").update(JSON.stringify([first.id, "beta"])).digest("hex").slice(0, 40)}`;
    await hub.store.db.run("UPDATE conversations SET client_action_id=? WHERE id=?", [oldAction, first.members[0]!.conversationId]);
    const updated = await buses().update("owner", first.id, { revision: first.revision, config: config() });
    expect(updated.members).toEqual(first.members);
    expect((await hub.store.conversations("owner")).length).toBe(3);
  });

  it("allocates a usable default after a former dedicated record was archived or changed", async () => {
    const first = await buses().create("owner", { requestId: "retired-default", config: config({ mode: "ask", members: [{ botId: "beta", instruction: "Keep this task" }] }) });
    await hub.store.updateConversation("owner", first.members[0]!.conversationId, { archived: true });
    await expect(buses().update("owner", first.id, { revision: first.revision, config: config({ mode: "ask", members: first.members, coordinator: first.coordinator }) })).rejects.toThrow("agent_bus_conversation_archived");
    const repaired = await buses().update("owner", first.id, { revision: first.revision, config: config({ mode: "ask", coordinator: first.coordinator, members: [{ botId: "beta", instruction: "Keep this task" }] }) });
    expect(repaired.members[0]!.conversationId).not.toBe(first.members[0]!.conversationId);
    expect(repaired.members[0]!.instruction).toBe("Keep this task");
    expect(await hub.store.db.get("SELECT archived FROM conversations WHERE id=?", [first.members[0]!.conversationId])).toEqual({ archived: 1 });
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','gamma',0)", [repaired.members[0]!.conversationId]);
    const next = await buses().update("owner", first.id, { revision: repaired.revision, config: config({ mode: "ask", coordinator: first.coordinator, members: [{ botId: "beta" }] }) });
    expect(next.members[0]!.conversationId).not.toBe(repaired.members[0]!.conversationId);
    const again = await buses().update("owner", first.id, { revision: next.revision, config: config({ mode: "ask", coordinator: first.coordinator, members: [{ botId: "beta" }] }) });
    expect(again.members[0]).toEqual(next.members[0]);
    let current = again;
    for (let i = 0; i < 14; i++) {
      await hub.store.updateConversation("owner", current.members[0]!.conversationId, { archived: true });
      const replacement = await buses().update("owner", current.id, { revision: current.revision, config: config({ mode: "ask", coordinator: current.coordinator, members: [{ botId: "beta" }] }) });
      expect(replacement.members[0]!.conversationId).not.toBe(current.members[0]!.conversationId);
      current = replacement;
    }
  });

  it("rejects unmanaged, deleted or mismatched participants and foreign, archived or topic chats", async () => {
    await expect(buses().create("owner", { requestId: "ext", config: config({ members: [{ botId: "external" }] }) })).rejects.toThrow("agent_bus_bot_unavailable");
    await hub.store.db.run("UPDATE bots SET deleted_at=1 WHERE id='delta'");
    await expect(buses().create("owner", { requestId: "deleted", config: config({ members: [{ botId: "delta" }] }) })).rejects.toThrow("agent_bus_bot_unavailable");
    const gammaChat = await hub.store.createConversation("owner", ["gamma"], "Gamma", "gamma-chat");
    await expect(buses().create("owner", { requestId: "mismatch", config: config({ members: [{ botId: "beta", conversationId: gammaChat.id }] }) })).rejects.toThrow("agent_bus_conversation_bot_mismatch");
    await expect(buses().create("owner", { requestId: "missing", config: config({ members: [{ botId: "beta", conversationId: "gw_missing" }] }) })).rejects.toThrow("agent_bus_conversation_forbidden");
    const group = await hub.store.createConversation("owner", ["beta", "gamma"], "Group", "group-chat");
    const topic = await hub.store.createConversation("owner", [], "Topic", "topic-chat", { parentId: group.id });
    await expect(buses().create("owner", { requestId: "topic", config: config({ members: [{ botId: "beta", conversationId: topic.id }] }) })).rejects.toThrow("agent_bus_conversation_unsupported");
    await hub.store.updateConversation("owner", gammaChat.id, { archived: true });
    await expect(buses().create("owner", { requestId: "archived", config: config({ members: [{ botId: "gamma", conversationId: gammaChat.id }] }) })).rejects.toThrow("agent_bus_conversation_archived");
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    await expect(buses().list("member")).rejects.toThrow("owner_required");
    // A member's private task never lands in a shared chat, even one it belongs to.
    await expect(buses().create("owner", { requestId: "group", config: config({ members: [{ botId: "beta", conversationId: group.id }, { botId: "gamma" }] }) })).rejects.toThrow("agent_bus_conversation_unsupported");
    await expect(buses().create("owner", { requestId: "group-coordinator", config: config({ coordinator: { botId: "beta", conversationId: group.id }, members: [{ botId: "gamma" }] }) })).rejects.toThrow("agent_bus_conversation_unsupported");
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM agent_buses")).toEqual({ count: 0 });
  });

  it("rechecks direct single-Bot chats at update, every start and every record write", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const beta = bus.members[0]!.conversationId;
    // Membership changes after saving: another Bot joins beta's record chat.
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','delta',0)", [beta]);
    await expect(buses().start("owner", bus.id, { requestId: "run-shared", revision: bus.revision, text: "x" })).rejects.toThrow("agent_bus_conversation_bot_mismatch");
    await expect(buses().update("owner", bus.id, { revision: bus.revision, config: { ...config(), members: bus.members } })).rejects.toThrow("agent_bus_conversation_bot_mismatch");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='delta'", [beta]);
    await hub.store.db.run("UPDATE conversations SET type='group' WHERE id=?", [beta]);
    await expect(buses().start("owner", bus.id, { requestId: "run-group", revision: bus.revision, text: "x" })).rejects.toThrow("agent_bus_conversation_unsupported");
    await hub.store.db.run("UPDATE conversations SET type='direct' WHERE id=?", [beta]);
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    // Shared during the run: the stage still reports, but no record is written.
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','delta',0)", [beta]);
    await buses().event("alpha", { type: "stage.started", runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta", prompt: "private prompt" });
    await buses().event("alpha", { type: "stage.finished", runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta", status: "completed", text: "private output" });
    const stage = (await buses().detail("owner", bus.id)).runs[0]!.stages[0]!;
    expect(stage).toMatchObject({ botId: "beta", status: "completed" });
    expect(stage.messageId).toBeUndefined();
    expect(JSON.stringify(await hub.store.db.all("SELECT blocks_json FROM messages WHERE conversation_id=?", [beta]))).not.toContain("private");
  });

  it("queues one run atomically, replays requests and rejects stale or concurrent starts", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const starts = await Promise.allSettled([
      buses().start("owner", bus.id, { requestId: "run-1", revision: bus.revision, text: "Compare the plans" }),
      buses().start("owner", bus.id, { requestId: "run-2", revision: bus.revision, text: "Another task" }),
    ]);
    expect(starts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "agent_bus_busy" } });
    const run = (starts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<HubServer["agentBuses"]["start"]>>>).value;
    expect(run).toMatchObject({ workspaceId: bus.id, status: "queued", stages: [] });
    const input = (await messages(bus.coordinator.conversationId)).find(m => m.id === run.messageId)!;
    expect(input).toMatchObject({ authorType: "user", mentions: ["alpha"] });
    expect(blocksText(input.blocks)).toBe(run.text);
    expect(await delivery(run.messageId)).toEqual({ status: "pending", dispatched: 0 });
    const replay = await buses().start("owner", bus.id, { requestId: (run.text === "Compare the plans" ? "run-1" : "run-2"), revision: bus.revision, text: run.text });
    expect(replay.id).toBe(run.id);
    await expect(buses().start("owner", bus.id, { requestId: run.text === "Compare the plans" ? "run-1" : "run-2", revision: bus.revision, text: "changed" })).rejects.toThrow("idempotency_conflict");
    await expect(buses().remove("owner", bus.id, { revision: bus.revision })).rejects.toThrow("agent_bus_busy");
    // The definition beside a live run is the one it executes.
    await expect(buses().update("owner", bus.id, { revision: bus.revision, config: config({ name: "Edited while queued" }) })).rejects.toThrow("agent_bus_busy");
    await expect(buses().start("owner", bus.id, { requestId: "stale", revision: "rev_stale", text: "x" })).rejects.toThrow("agent_bus_conflict");
    const current = await buses().detail("owner", bus.id);
    expect(current.workspace.latestRun).toMatchObject({ id: run.id, status: "queued" });
    expect(current.runs[0]!.snapshot).toEqual({ name: "Review desk", mode: "fan", coordinator: bus.coordinator, members: bus.members, maxResearchQuestions: 5, maxRevisionRounds: 1 });
  });

  it("fails run inputs for an older worker once, without holding ordinary messages or dispatching the prompt", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const chat = bus.coordinator.conversationId;
    const before = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "before", text: "ordinary before", attachments: [] });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "Bus task" });
    const after = await hub.store.sendMessage("owner", { conversationId: chat, clientMsgId: "after", text: "ordinary after", attachments: [] });
    const queue = new HubPromptQueue(hub.store), older = (ids: string[]) => buses().rejectForWorkerInTransaction("alpha", ids);
    // Without a settlement policy the input is only withheld; chat still flows.
    expect((await queue.claim("alpha", false, false, () => true, true, false)).map(m => m.id)).toEqual([before.message.id, after.message.id]);
    expect(await delivery(run.messageId)).toEqual({ status: "pending", dispatched: 0 });
    expect((await queue.claim("alpha", false, false, () => true, true, older)).map(m => m.id)).toEqual([]);
    expect(await delivery(run.messageId)).toEqual({ status: "cancelled", dispatched: 0 });
    const failed = (await buses().detail("owner", bus.id)).runs[0]!;
    expect(failed).toMatchObject({ status: "failed", error: "agent_bus_worker_update_required" });
    const notice = (await messages(chat)).find(m => m.id === run.messageId)!;
    expect(JSON.stringify(notice.blocks)).toContain("没有作为普通消息执行");
    // Repeating the claim changes nothing.
    expect(await queue.claim("alpha", false, true, () => true, true, older)).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: run.messageId })]));
    expect((await messages(chat)).find(m => m.id === run.messageId)!.version).toBe(notice.version);

    // A downgraded worker never receives a replay of an input a newer one began.
    const next = await buses().start("owner", bus.id, { requestId: "run-2", revision: bus.revision, text: "second" });
    await dispatch(next.messageId);
    await buses().event("alpha", { type: "stage.started", runId: next.id, messageId: next.messageId, stageId: "s1", botId: "beta", prompt: "p" });
    expect((await queue.claim("alpha", false, true, () => true, true, older)).map(m => m.id)).not.toContain(next.messageId);
    expect(await delivery(next.messageId)).toEqual({ status: "failed", dispatched: 1 });
    expect((await buses().detail("owner", bus.id)).runs[0]).toMatchObject({ id: next.id, status: "interrupted", error: "agent_bus_worker_update_required", stages: [expect.objectContaining({ status: "failed" })] });
  });

  it.each([["task", false], ["/review task", false], ["/review task", true]] as const)("locks and dispatches the Bus queue head %s (pull=%s)", async (text, pulling) => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text });
    const queue = new HubPromptQueue(hub.store);
    await hub.store.db.run("INSERT INTO prompt_queue_workers VALUES('alpha',1)");
    await hub.store.db.run("UPDATE bots SET engine='codex' WHERE id='alpha'");
    const snapshot = await queue.read("owner", "alpha", bus.coordinator.conversationId);
    expect(snapshot.supported).toBe(true);
    expect(snapshot.items[0]).toMatchObject({ canCancel: false, canMove: false, canEdit: false });
    expect((await queue.claim("alpha", true, false, () => true, true, true, true, pulling ? { ready: new Set() } : undefined)).map(m => m.id)).toEqual([run.messageId]);
    expect(await buses().dispatch("alpha", run.messageId)).toEqual({ runId: run.id, workspaceId: bus.id, mode: "fan", members: ["beta", "gamma"], coordinatorConversationId: bus.coordinator.conversationId, conversations: bus.members.map(member => member.conversationId), maxResearchQuestions: 5, maxRevisionRounds: 1 });
    expect(await buses().dispatch("beta", run.messageId)).toBeUndefined();
  });

  it("cancels an undispatched run in the queue transaction without involving a worker", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    const stopped = await buses().stop("owner", bus.id, run.id, { requestId: "stop" });
    expect(stopped).toMatchObject({ status: "cancelled", finishedAt: expect.any(Number) });
    expect(await delivery(run.messageId)).toEqual({ status: "cancelled", dispatched: 0 });
    expect(JSON.stringify((await messages(bus.coordinator.conversationId)).find(m => m.id === run.messageId)!.blocks)).toContain("未发送给 Bot");
    expect(await buses().stop("owner", bus.id, run.id, { requestId: "stop" })).toMatchObject({ status: "cancelled" });
    await expect(buses().stop("owner", bus.id, "abr_missing", { requestId: "stop" })).rejects.toThrow("idempotency_conflict");
    const next = await buses().start("owner", bus.id, { requestId: "run-2", revision: bus.revision, text: "again" });
    await dispatch(next.messageId);
    // A dispatched run keeps a durable stop flag until its worker reports.
    expect(await buses().stop("owner", bus.id, next.id, { requestId: "stop-2" })).toMatchObject({ status: "stopping" });
    expect(await buses().dispatch("alpha", next.messageId)).toMatchObject({ stopRequested: true });
    await buses().event("alpha", { type: "run.finished", runId: next.id, messageId: next.messageId, status: "failed", error: "aborted" });
    expect((await buses().detail("owner", bus.id)).runs[0]).toMatchObject({ id: next.id, status: "cancelled" });
  });

  it("abandons an offline stopping run only with explicit owner intent and fences late observations", async () => {
    let online = true;
    const service = new HubAgentBuses(hub.store, { workerCapable: () => online ? true : undefined, stop: async () => undefined, conversationsCreated: () => {} });
    const bus = await service.create("owner", { requestId: "abandon-create", config: config() });
    const run = await service.start("owner", bus.id, { requestId: "abandon-run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    await expect(service.stop("owner", bus.id, run.id, { requestId: "too-soon", abandon: true })).rejects.toThrow("agent_bus_abandon_unavailable");
    await service.stop("owner", bus.id, run.id, { requestId: "stop" });
    await expect(service.stop("owner", bus.id, run.id, { requestId: "online-abandon", abandon: true })).rejects.toThrow("agent_bus_abandon_unavailable");
    online = false;
    expect((await service.detail("owner", bus.id)).runs[0]).toMatchObject({ status: "stopping", canAbandon: true });
    expect(await service.stop("owner", bus.id, run.id, { requestId: "stop" })).toMatchObject({ status: "stopping" });
    await expect(service.stop("owner", bus.id, run.id, { requestId: "stop", abandon: true })).rejects.toThrow("idempotency_conflict");
    expect(await service.stop("owner", bus.id, run.id, { requestId: "abandon", abandon: true })).toMatchObject({ status: "interrupted", error: "agent_bus_wait_abandoned" });
    expect(await delivery(run.messageId)).toEqual({ status: "failed", dispatched: 1 });
    expect(await service.dispatch("alpha", run.messageId)).toMatchObject({ stopRequested: true });
    expect(await service.abandonedStops("alpha")).toEqual([{ runId: run.id, messageId: run.messageId }]);
    expect(await service.abandonedStops("beta")).toEqual([]);
    expect(await service.abandonedStops("alpha", Date.now() + 24 * 60 * 60_000 + 1)).toEqual([]);
    await hub.store.db.run("UPDATE agent_bus_runs SET stop_requested=0 WHERE id=?", [run.id]);
    expect(await service.abandonedStops("alpha")).toEqual([]);
    await hub.store.db.run("UPDATE agent_bus_runs SET stop_requested=1 WHERE id=?", [run.id]);
    await service.event("alpha", { type: "run.finished", runId: run.id, messageId: run.messageId, status: "completed" });
    expect((await service.detail("owner", bus.id)).runs[0]).toMatchObject({ status: "interrupted", error: "agent_bus_wait_abandoned" });
    await expect(service.remove("owner", bus.id, { revision: bus.revision })).resolves.toEqual({ ok: true });
  });

  it("accepts stage reports only from the run's own active coordinator input and publishes records to snapshot chats", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    const base = { runId: run.id, messageId: run.messageId };
    await expect(buses().event("beta", { type: "run.started", ...base })).rejects.toThrow("agent_bus_run_forbidden");
    // Not yet handed to the worker: ignored rather than trusted.
    await buses().event("alpha", { type: "run.started", ...base });
    expect((await buses().detail("owner", bus.id)).runs[0]!.status).toBe("queued");
    await dispatch(run.messageId);
    await buses().event("alpha", { type: "run.started", ...base });
    await expect(buses().event("alpha", { type: "stage.started", ...base, stageId: "s1", botId: "delta", prompt: "x" })).rejects.toThrow("agent_bus_stage_forbidden");
    await buses().event("alpha", { type: "stage.started", ...base, stageId: "s1", botId: "alpha", prompt: "local" });
    await buses().event("alpha", { type: "stage.started", ...base, stageId: "s2", botId: "beta", prompt: "member task" });
    await expect(buses().event("alpha", { type: "stage.finished", ...base, stageId: "s2", botId: "gamma", status: "completed" })).rejects.toThrow("agent_bus_stage_forbidden");
    const running = (await buses().detail("owner", bus.id)).runs[0]!;
    expect(running).toMatchObject({ status: "running", startedAt: expect.any(Number) });
    expect(running.stages).toEqual([
      expect.objectContaining({ id: "s1", botId: "alpha", conversationId: bus.coordinator.conversationId, status: "running" }),
      expect.objectContaining({ id: "s2", botId: "beta", conversationId: bus.members[0]!.conversationId, status: "running", messageId: expect.any(String) }),
    ]);
    expect(running.stages[0]!.messageId).toBeUndefined();
    const [record] = await messages(bus.members[0]!.conversationId);
    // Streaming until the step ends; clients keep it out of chat presence.
    expect(record).toMatchObject({ authorType: "bot", authorId: "beta", status: "streaming" });
    expect(blocksText(record!.blocks)).toContain("执行中 · 独立执行记录");
    expect(JSON.stringify(record!.blocks)).toContain("关于此记录");
    expect(JSON.stringify(record!.blocks)).toContain("member task");
    expect((record!.blocks[0] as { extra: Record<string, unknown> }).extra[AGENT_BUS_STAGE_EXTRA]).toEqual({ runId: run.id, workspaceId: bus.id, stageId: "s2", status: "running" });

    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s2", botId: "beta", status: "completed", text: "beta findings" });
    const finished = (await messages(bus.members[0]!.conversationId))[0]!;
    expect(finished).toMatchObject({ id: record!.id, status: "complete", version: record!.version + 1 });
    expect(blocksText(finished.blocks)).toContain("beta findings");
    expect(JSON.stringify(finished.blocks)).toContain("member task");
    // Durable transport replays never duplicate or rewrite a settled stage.
    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s2", botId: "beta", status: "failed", error: "late" });
    expect((await messages(bus.members[0]!.conversationId))[0]!.version).toBe(finished.version);
    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s1", botId: "alpha", status: "completed", text: "local" });
    expect(await messages(bus.coordinator.conversationId)).toHaveLength(1);
    expect(await messages(bus.members[1]!.conversationId)).toEqual([]);

    await buses().event("alpha", { type: "run.finished", ...base, status: "completed" });
    await buses().event("alpha", { type: "stage.started", ...base, stageId: "s3", botId: "gamma", prompt: "after" });
    const done = (await buses().detail("owner", bus.id)).runs[0]!;
    expect(done).toMatchObject({ status: "completed", finishedAt: expect.any(Number) });
    expect(done.stages.map(stage => [stage.id, stage.status])).toEqual([["s1", "completed"], ["s2", "completed"]]);
    // After the run, edits apply to later runs; history keeps its own snapshot.
    const edited = await buses().update("owner", bus.id, { revision: bus.revision, config: config({ members: [{ botId: "delta" }] }) });
    expect(edited.members.map(member => member.botId)).toEqual(["delta"]);
    expect((await buses().detail("owner", bus.id)).runs[0]!.snapshot.members).toEqual(bus.members);
  });

  it("notifies once when a member's record finishes or fails, never when its step starts or is stopped", async () => {
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen,push_json) VALUES('phone','owner','Phone','ios','key',0,0,0,'{}')");
    await hub.store.db.run("INSERT INTO device_preferences VALUES('phone','{\"enabled\":true}')");
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const pushes = async () => (await hub.store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox WHERE device_id='phone'"))
      .map(row => JSON.parse(row.payload_json) as { messageId: string; kind: string }).filter(push => push.messageId !== undefined);
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    const base = { runId: run.id, messageId: run.messageId };
    for (const stageId of ["s1", "s2", "s3"]) await buses().event("alpha", { type: "stage.started", ...base, stageId, botId: stageId === "s2" ? "gamma" : "beta", prompt: "p" });
    const started = (await buses().detail("owner", bus.id)).runs[0]!.stages;
    expect((await pushes()).filter(push => started.some(stage => stage.messageId === push.messageId))).toEqual([]);
    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s1", botId: "beta", status: "completed", text: "done" });
    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s2", botId: "gamma", status: "failed", error: "boom" });
    await buses().event("alpha", { type: "stage.finished", ...base, stageId: "s3", botId: "beta", status: "cancelled" });
    const byStage = (id: string) => started.find(stage => stage.id === id)!.messageId;
    const records = (await pushes()).filter(push => started.some(stage => stage.messageId === push.messageId));
    expect(records.map(push => [push.messageId, push.kind]).sort()).toEqual([[byStage("s1"), "answer"], [byStage("s2"), "error"]].sort());
  });

  it("keeps a completed run's full snapshot after the workspace is edited to another mode and members", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config({ name: "Research line", mode: "chain", members: [{ botId: "beta" }, { botId: "gamma" }] }) });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "research then review" });
    await dispatch(run.messageId);
    for (const [stageId, botId] of [["s1", "beta"], ["s2", "gamma"]] as const) {
      await buses().event("alpha", { type: "stage.started", runId: run.id, messageId: run.messageId, stageId, botId, prompt: "p" });
      await buses().event("alpha", { type: "stage.finished", runId: run.id, messageId: run.messageId, stageId, botId, status: "completed", text: "ok" });
    }
    await buses().event("alpha", { type: "run.finished", runId: run.id, messageId: run.messageId, status: "completed" });
    const original = { name: "Research line", mode: "chain", coordinator: bus.coordinator, members: bus.members, maxResearchQuestions: 5, maxRevisionRounds: 1 };
    // Edit to a single delegation with a different member; start nothing.
    const edited = await buses().update("owner", bus.id, { revision: bus.revision, config: config({ name: "Writer desk", mode: "ask", members: [{ botId: "delta" }] }) });
    expect(edited).toMatchObject({ name: "Writer desk", mode: "ask", members: [{ botId: "delta" }], latestRun: { id: run.id, status: "completed" } });
    const detail = await buses().detail("owner", bus.id);
    expect(detail.workspace.mode).toBe("ask");
    expect(detail.runs[0]).toMatchObject({ id: run.id, status: "completed", snapshot: original });
    // Stages keep pointing at the snapshot's conversations, not the edited ones.
    expect(detail.runs[0]!.stages.map(stage => [stage.botId, stage.conversationId])).toEqual(bus.members.map(member => [member.botId, member.conversationId]));
    expect(await buses().dispatch("alpha", run.messageId)).toMatchObject({ mode: "chain", members: ["beta", "gamma"] });
  });

  it("settles an acknowledged input without a terminal report as interrupted, including after restart", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    await buses().event("alpha", { type: "stage.started", runId: run.id, messageId: run.messageId, stageId: "s1", botId: "gamma", prompt: "p" });
    await hub.store.acknowledgeDelivery("alpha", run.messageId);
    await buses().settleDelivery("alpha", run.messageId);
    const settled = (await buses().detail("owner", bus.id)).runs[0]!;
    expect(settled).toMatchObject({ status: "interrupted", error: "agent_bus_result_unconfirmed" });
    expect(settled.stages[0]).toMatchObject({ status: "failed", error: "agent_bus_interrupted" });
    expect((await messages(bus.members[1]!.conversationId))[0]).toMatchObject({ status: "error" });

    const second = await buses().start("owner", bus.id, { requestId: "run-2", revision: bus.revision, text: "task 2" });
    await dispatch(second.messageId);
    await buses().event("alpha", { type: "run.started", runId: second.id, messageId: second.messageId });
    // The worker failed the input while this Hub was down; restart reconciles.
    await hub.store.db.run("UPDATE deliveries SET status='failed' WHERE message_id=?", [second.messageId]);
    await hub.close();
    hub = await HubServer.start({ stateDir: root });
    expect((await hub.store.db.get<{ status: string; error: string }>("SELECT status,error FROM agent_bus_runs WHERE id=?", [second.id]))).toEqual({ status: "interrupted", error: "agent_bus_delivery_failed" });
  });

  it("keeps stage status but publishes nothing into an archived member chat", async () => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const started = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(started.messageId);
    await hub.store.updateConversation("owner", bus.members[0]!.conversationId, { archived: true });
    await buses().event("alpha", { type: "stage.started", runId: started.id, messageId: started.messageId, stageId: "s1", botId: "beta", prompt: "p" });
    await buses().event("alpha", { type: "stage.finished", runId: started.id, messageId: started.messageId, stageId: "s1", botId: "beta", status: "completed", text: "kept out" });
    expect((await buses().detail("owner", bus.id)).runs[0]!.stages[0]).toMatchObject({ status: "completed" });
    expect((await buses().detail("owner", bus.id)).runs[0]!.stages[0]!.messageId).toBeUndefined();
    expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", [bus.members[0]!.conversationId])).toEqual({ count: 0 });
    // A new run validates bindings again and refuses the archived chat.
    await buses().event("alpha", { type: "run.finished", runId: started.id, messageId: started.messageId, status: "completed" });
    await expect(buses().start("owner", bus.id, { requestId: "run-2", revision: bus.revision, text: "task" })).rejects.toThrow("agent_bus_conversation_archived");
  });

  it.each(["completed", "failed", "cancelled"] as const)("closes an existing record after its chat is archived without adding private %s output", async status => {
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen,push_json) VALUES('phone','owner','Phone','ios','key',0,0,0,'{}')");
    await hub.store.db.run("INSERT INTO device_preferences VALUES('phone','{\"enabled\":true}')");
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    const base = { runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta" };
    await buses().event("alpha", { type: "stage.started", ...base, prompt: "already visible task" });
    const chat = bus.members[0]!.conversationId, original = (await messages(chat))[0]!;
    expect(original.status).toBe("streaming");
    await hub.store.updateConversation("owner", chat, { archived: true });
    await buses().event("alpha", { type: "stage.finished", ...base, status, text: "NEW_PRIVATE_RESULT", error: "NEW_PRIVATE_ERROR" });
    await buses().event("alpha", { type: "run.finished", runId: run.id, messageId: run.messageId, status });
    expect((await buses().detail("owner", bus.id)).runs[0]!.stages[0]).toMatchObject({ status, messageId: original.id });
    await hub.store.updateConversation("owner", chat, { archived: false });
    const record = (await messages(chat))[0]!;
    expect(record.id).toBe(original.id);
    expect(blocksText(record.blocks)).toContain("already visible task");
    expect(JSON.stringify(record.blocks)).not.toContain("NEW_PRIVATE_RESULT");
    expect(JSON.stringify(record.blocks)).not.toContain("NEW_PRIVATE_ERROR");
    expect(record.status).toBe(status === "failed" ? "error" : "complete");
    expect(record.version).toBe(original.version + 1);
    expect(await hub.store.db.all("SELECT * FROM push_outbox")).toEqual([]);
    expect((record.blocks[0] as { extra: Record<string, unknown> }).extra[AGENT_BUS_STAGE_EXTRA]).toMatchObject({ runId: run.id, stageId: "s1", status });
  });

  it.each(["shared", "removed"] as const)("silently closes only the old record after its member chat is %s", async boundary => {
    await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,revoked,created_at,last_seen,push_json) VALUES('phone','owner','Phone','ios','key',0,0,0,'{}')");
    await hub.store.db.run("INSERT INTO device_preferences VALUES('phone','{\"enabled\":true}')");
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    const base = { runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta" };
    await buses().event("alpha", { type: "stage.started", ...base, prompt: "already visible task" });
    const chat = bus.members[0]!.conversationId, original = (await messages(chat))[0]!;
    const deliveries = await hub.store.db.all("SELECT * FROM deliveries ORDER BY message_id,bot_id");
    if (boundary === "shared") {
      await hub.store.db.run("UPDATE conversations SET type='group' WHERE id=?", [chat]);
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','delta',0)", [chat]);
    } else await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id='beta'", [chat]);
    await buses().event("alpha", { type: "stage.finished", ...base, status: "failed", text: "NEW_PRIVATE_RESULT", error: "NEW_PRIVATE_ERROR" });
    const record = (await messages(chat))[0]!;
    expect(JSON.stringify(record)).not.toContain("NEW_PRIVATE");
    expect(record).toMatchObject({ id: original.id, status: "error", version: original.version + 1 });
    expect(blocksText(record.blocks)).toContain("already visible task");
    expect((record.blocks[0] as { extra: Record<string, unknown> }).extra[AGENT_BUS_STAGE_EXTRA]).toEqual({ runId: run.id, workspaceId: bus.id, stageId: "s1", status: "failed" });
    expect(await hub.store.db.all("SELECT * FROM push_outbox")).toEqual([]);
    expect(await hub.store.db.all("SELECT * FROM deliveries ORDER BY message_id,bot_id")).toEqual(deliveries);
    // Late durable replays cannot publish the withheld result after access returns.
    if (boundary === "shared") {
      await hub.store.db.run("UPDATE conversations SET type='direct' WHERE id=?", [chat]);
      await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='delta'", [chat]);
    } else await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot','beta',0)", [chat]);
    await buses().event("alpha", { type: "stage.finished", ...base, status: "completed", text: "NEW_PRIVATE_REPLAY" });
    await buses().event("alpha", { type: "run.finished", runId: run.id, messageId: run.messageId, status: "failed", error: "NEW_PRIVATE_RUN_ERROR" });
    expect(await messages(chat)).toEqual([record]);
    expect(await hub.store.db.all("SELECT * FROM deliveries ORDER BY message_id,bot_id")).toEqual(deliveries);
  });

  it.each([
    ["deleted", true], ["missing", true], ["foreign", true], ["foreign", false],
    ["wrong-run", true], ["wrong-stage", true], ["wrong-workspace", true],
    ["native", true], ["native", false],
  ] as const)("does not replace a %s record when archived=%s", async (replacement, archived) => {
    const bus = await buses().create("owner", { requestId: "create", config: config() });
    const run = await buses().start("owner", bus.id, { requestId: "run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    const base = { runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta" };
    await buses().event("alpha", { type: "stage.started", ...base, prompt: "p" });
    const chat = bus.members[0]!.conversationId, original = (await messages(chat))[0]!;
    if (replacement === "missing") await hub.store.db.run("DELETE FROM messages WHERE id=?", [original.id]);
    else {
      const card = original.blocks[0] as Extract<Block, { type: "card" }>;
      const marker = { runId: run.id, workspaceId: bus.id, stageId: "s1", status: "running" };
      if (replacement === "wrong-run") marker.runId = "another_run";
      if (replacement === "wrong-stage") marker.stageId = "s2";
      if (replacement === "wrong-workspace") marker.workspaceId = "another_workspace";
      const extra = replacement === "foreign" ? {} : { [AGENT_BUS_STAGE_EXTRA]: marker,
        ...(replacement === "native" ? { nativeRun: { version: 1, id: "foreground", revision: 1, phase: "working", startedAt: 1, updatedAt: 1, count: 0, completed: 0, failed: 0, truncated: false } } : {}) };
      await hub.store.publishBotMessage("beta", { id: original.id, conversationId: chat,
        blocks: [{ ...card, extra }], status: replacement === "deleted" ? "deleted" : "streaming" });
    }
    if (archived) await hub.store.updateConversation("owner", chat, { archived: true });
    const before = await hub.store.db.get("SELECT * FROM messages WHERE id=?", [original.id]);
    await buses().event("alpha", { type: "stage.finished", ...base, status: "failed", text: "NEW_PRIVATE_RESULT", error: "NEW_PRIVATE_ERROR" });
    await buses().event("alpha", { type: "run.finished", runId: run.id, messageId: run.messageId, status: "failed" });
    expect(await hub.store.db.get("SELECT * FROM messages WHERE id=?", [original.id])).toEqual(before);
    expect((await buses().detail("owner", bus.id)).runs[0]!.stages[0]!.status).toBe("failed");
  });

  async function token(user: string) {
    const keys = generateKeyPairSync("ed25519"), device = `device_${user}`;
    const pair = await hub.auth.pair({ deviceId: device, name: user, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
    await hub.auth.approve(pair.code, "local-owner", user);
    const nonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge(device, device, nonce, "fixture");
    return (await hub.auth.authenticate(device, sign(null, deviceProof(device, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  }

  it("returns real responses the CLI's strict parsers accept, including run snapshots", async () => {
    const owner = await token("owner");
    const request = async <T>(route: string, method = "GET", body?: unknown): Promise<T> => {
      const response = await fetch(hub.url + route, { method, headers: { Authorization: `Bearer ${owner}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(value.error);
      return value;
    };
    const file = path.join(root, "bus.json"), task = path.join(root, "task.txt");
    await writeFile(file, JSON.stringify(config({ coordinator: { botId: "alpha", instruction: "coordinator role" }, members: [{ botId: "beta", instruction: "research role" }, { botId: "gamma", instruction: "valuation role" }] }))); await writeFile(task, "CLI task");
    const created = await runAgentBusCommand({ request }, "create", undefined, { from: file, "request-id": "cli-create" }) as AgentBusWorkspace;
    expect(created.coordinator.instruction).toBe("coordinator role");
    expect(created.members.map(member => member.instruction)).toEqual(["research role", "valuation role"]);
    expect((await runAgentBusCommand({ request }, "list", undefined, {}) as { items: AgentBusWorkspace[] }).items.map(item => item.id)).toEqual([created.id]);
    const run = await runAgentBusCommand({ request }, "run", created.id, { "text-file": task, revision: created.revision, "request-id": "cli-run" }) as AgentBusRun;
    expect(run.snapshot).toEqual({ name: created.name, mode: created.mode, coordinator: created.coordinator, members: created.members, maxResearchQuestions: 5, maxRevisionRounds: 1 });
    await expect(runAgentBusCommand({ request }, "update", created.id, { from: file, revision: created.revision })).rejects.toThrow("agent_bus_busy");
    expect((await runAgentBusCommand({ request }, "show", created.id, {}) as AgentBusDetail).runs.map(item => item.id)).toEqual([run.id]);
    expect(await runAgentBusCommand({ request }, "stop", created.id, { run: run.id, "request-id": "cli-stop" })).toMatchObject({ id: run.id, status: "cancelled" });
    const updated = await runAgentBusCommand({ request }, "update", created.id, { from: file, revision: created.revision }) as AgentBusWorkspace;
    expect(updated.members).toEqual(created.members);
    expect(await runAgentBusCommand({ request }, "delete", created.id, { revision: updated.revision, yes: true })).toEqual({ ok: true });
  });

  it("marks the database as schema 25 so an older Hub refuses it instead of misreading run inputs", async () => {
    expect(await hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "25" });
    // A runtime package declaring the previous range cannot open this state.
    const old = path.join(root, "old-runtime");
    await rm(old, { recursive: true, force: true });
    await mkdir(path.join(old, "dist", "src"), { recursive: true });
    await writeFile(path.join(old, "package.json"), JSON.stringify({ tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema: 18 }, tarobotHubSchema: 18 }));
    await expect(assertHostRuntimeCompatible(root, path.join(old, "dist", "src", "index.js"))).rejects.toThrow("host_schema_incompatible:25:runtime_1-18");
    expect(JSON.parse(await readFile(path.resolve("package.json"), "utf8")).tarobotHostUpdate.maxHubSchema).toBe(25);
  });

  it("settles a deleted coordinator's run and member records through the delete route without a Bus read", async () => {
    const bus = await buses().create("owner", { requestId: "deleted-coordinator", config: config({ mode: "ask", members: [{ botId: "beta" }] }) });
    const run = await buses().start("owner", bus.id, { requestId: "deleted-run", revision: bus.revision, text: "task" });
    await dispatch(run.messageId);
    await buses().event("alpha", { type: "stage.started", runId: run.id, messageId: run.messageId, stageId: "s1", botId: "beta", conversationId: bus.members[0]!.conversationId, prompt: "part" });
    const record = () => hub.store.db.get<{ status: string }>("SELECT m.status FROM agent_bus_stages s JOIN messages m ON m.id=s.message_id WHERE s.run_id=?", [run.id]);
    expect(await record()).toEqual({ status: "streaming" });
    const updated: string[] = []; hub.store.subscribe(event => { if (event.kind === "message.updated") updated.push(event.conversationId); });
    // The route's own settlement, independent of worker shutdown in BotManager.
    const server = hub as unknown as { botManager: unknown }, previous = server.botManager;
    server.botManager = { delete: (userId: string, botId: string, name: string, validate: () => Promise<unknown>) => hub.store.deleteBot(userId, botId, name, validate) };
    let response: Response;
    try { response = await fetch(`${hub.url}/api/bots/alpha`, { method: "DELETE", headers: { Authorization: `Bearer ${await token("owner")}`, "Content-Type": "application/json" }, body: JSON.stringify({ expectedName: "Name alpha", confirm: true }) }); }
    finally { server.botManager = previous; }
    expect(response.status).toBe(200);
    expect(await hub.store.db.get("SELECT status,error FROM agent_bus_runs WHERE id=?", [run.id])).toEqual({ status: "interrupted", error: "agent_bus_delivery_failed" });
    expect(await record()).toEqual({ status: "error" });
    expect(updated).toContain(bus.members[0]!.conversationId);
  });

  it("serves the owner-only HTTP API with device trust", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    const owner = { Authorization: `Bearer ${await token("owner")}`, "Content-Type": "application/json" }, member = { Authorization: `Bearer ${await token("member")}` };
    const api = (route: string, init: RequestInit = {}) => fetch(`${hub.url}/api/agent-buses${route}`, { ...init, headers: { ...owner, ...init.headers } });
    expect((await fetch(`${hub.url}/api/agent-buses`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/agent-buses`, { headers: member })).status).toBe(403);
    const created = await (await api("", { method: "POST", body: JSON.stringify({ requestId: "http", config: config() }) })).json() as { id: string; revision: string };
    expect((await (await api("")).json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await api(`/${created.id}`, { method: "PUT", body: JSON.stringify({ revision: created.revision, config: { ...config(), extra: true } }) })).status).toBe(400);
    const run = await (await api(`/${created.id}/runs`, { method: "POST", body: JSON.stringify({ requestId: "http-run", revision: created.revision, text: "hello" }) })).json() as { id: string; status: string };
    expect(run.status).toBe("queued");
    expect(await (await api(`/${created.id}/runs/${run.id}/stop`, { method: "POST", body: JSON.stringify({ requestId: "http-stop" }) })).json()).toMatchObject({ status: "cancelled" });
    expect((await (await api(`/${created.id}`)).json() as { runs: unknown[] }).runs).toHaveLength(1);
    expect((await api(`/${created.id}`, { method: "DELETE", body: JSON.stringify({ revision: created.revision }) })).status).toBe(200);
    expect((await api(`/${created.id}`)).status).toBe(404);
    await hub.store.flushAudit();
    const audit = await hub.store.db.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log WHERE kind LIKE 'agent_bus.%'");
    expect(audit.map(row => row.kind)).toEqual(expect.arrayContaining(["agent_bus.saved", "agent_bus.run_started", "agent_bus.run_stop", "agent_bus.deleted"]));
    expect(JSON.stringify(audit)).not.toContain("hello");
  });
});
