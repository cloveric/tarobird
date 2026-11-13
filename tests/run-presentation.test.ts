import { writeFile } from "node:fs/promises";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { createCoreRunCardController } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { CronStore } from "../src/state/cron-store.js";
import { deliverCoreResponse } from "../src/core/delivery.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { nativeRun, isGoalTurnEnded, RUN_BYTE_LIMIT, RUN_ENTRY_LIMIT, RUN_RETENTION_MS } from "../src/client-protocol/run.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubStore } from "../src/hub/store.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { initialCoreRunState, renderCoreRunCard, applyCoreEngineEvent } from "../src/core/card-renderer.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import type { GatewayTransport } from "../src/gateway/transport.js";

describe("native public run capture", () => {
  it("keeps maintenance feedback in fallback cards and previews without adding answer text", () => {
    let state = applyCoreEngineEvent(initialCoreRunState("compaction-feedback"), { type: "context_compaction", id: "compact", status: "started" });
    expect(JSON.stringify(renderCoreRunCard(state))).toContain("正在压缩上下文");
    expect(JSON.stringify(renderCoreRunCard(state, "en"))).toContain("Compacting context");
    expect(state.blocks).toEqual([]);
    expect(state.resultText).toBe("");
    state = applyCoreEngineEvent(state, { type: "context_compaction", id: "compact", status: "completed" });
    expect(state).toMatchObject({ status: "running", footer: "thinking", resultText: "" });
  });
  it("records background lifecycle receipts without completing or refreshing an unrelated turn", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "background_task_started", taskId: "a", description: "核对报告" });
    recordRunEvent(record, { type: "background_task_started", taskId: "a", description: "核对报告" });
    recordRunEvent(record, { type: "background_task_finished", taskId: "a", status: "stopped" });
    expect(record.entries).toHaveLength(2);
    expect(summarizeRun(record, "running")).toMatchObject({ phase: "thinking", count: 0 });
    const before = JSON.stringify(record);
    recordRunEvent(record, { type: "task_notification", text: "old result", origin: "unattributed" }, Date.now() + 30000);
    expect(JSON.stringify(record)).toBe(before);
    summarizeRun(record, "done");
    recordRunEvent(record, { type: "background_task_finished", taskId: "b", status: "completed" });
    expect(record.entries).toHaveLength(2);
  });
  it("keeps explicit Claude thought blocks and child messages separate without breaking token fragments", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "thinking", text: "先核", delta: false });
    recordRunEvent(record, { type: "thinking", text: "对。", delta: true });
    recordRunEvent(record, { type: "thinking", text: "再检查。", delta: false });
    expect(record.entries.map(entry => entry.text)).toEqual(["先核对。", "再检查。"]);
    recordRunEvent(record, { type: "tool_use", toolName: "Agent", toolUseId: "child" });
    recordRunEvent(record, { type: "tool_progress", toolUseId: "child", text: "第一段。", delta: false });
    recordRunEvent(record, { type: "tool_progress", toolUseId: "child", text: "第二段。", delta: false });
    expect(record.entries.at(-1)?.text).toBe("第一段。\n\n第二段。");
    recordRunEvent(record, { type: "tool_result", toolUseId: "child", output: "最终回报" });
    expect(record.entries.at(-1)).toMatchObject({ text: "第一段。\n\n第二段。", output: "最终回报", status: "done" });
    expect(record.phase).toBe("working");
  });
  it("preserves public text beyond legacy card limits and shows explicit capture bounds", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "thinking", text: "公".repeat(12000) });
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "shell", toolInput: { command: "echo test" } });
    recordRunEvent(record, { type: "tool_result", toolUseId: "shell", output: "a".repeat(50000) });
    expect(record.entries[0]!.text).toHaveLength(12000); expect(record.entries[1]!.output).toHaveLength(50000);
    expect(summarizeRun(record, "running").phase).not.toBe("done");
    recordRunEvent(record, { type: "thinking", text: "a".repeat(40000) });
    expect(record.entries.at(-1)!.text).toHaveLength(32768); expect(record.truncated).toBe(true);
  });
  it("correlates approvals before start, duplicates, parallel results and missing IDs safely", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "permission_request", toolName: "Bash", toolUseId: "a" });
    expect(summarizeRun(record, "running").phase).toBe("waiting_approval");
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "a" });
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "b" });
    recordRunEvent(record, { type: "tool_result", toolName: "Bash", output: "unmatched" });
    expect(record.entries.filter(e => e.status === "running")).toHaveLength(2);
    recordRunEvent(record, { type: "tool_result", toolUseId: "a", isError: true, output: "failure" });
    recordRunEvent(record, { type: "tool_use", toolUseId: "a", toolName: "Bash" });
    expect(record.entries.find(e => e.callId === "a")!.status).toBe("error");
    expect(record.entries.find(e => e.callId === "b")!.status).toBe("running");
    summarizeRun(record, "done"); expect(record.entries.find(e => e.callId === "b")!.status).toBe("unknown");
    const revision = record.revision; recordRunEvent(record, { type: "tool_progress", toolUseId: "b", text: "late" }); expect(record.revision).toBe(revision);
  });
  it("does not treat asynchronous questions or tool success as turn completion", () => {
    const record = createRunRecord(); recordRunEvent(record, { type: "user_input_request", toolName: "request_user_input_async", toolInput: {} });
    expect(record.phase).toBe("thinking"); recordRunEvent(record, { type: "result", text: "answer" });
    expect(summarizeRun(record, "delivering").endedAt).toBeUndefined();
    expect(summarizeRun(record, "done").endedAt).toBeDefined();
  });
  it("keeps structured evidence bounded, omits raw commands from summaries, and ignores late progress", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: "x", toolInput: { command: "PRIVATE_COMMAND", description: "Check report" } });
    expect(JSON.stringify(summarizeRun(record, "running"))).not.toContain("PRIVATE_COMMAND");
    recordRunEvent(record, { type: "tool_result", toolUseId: "x", exitCode: 0, durationMs: 100, changes: [{ path: "/a", diff: "x".repeat(40000) }] });
    recordRunEvent(record, { type: "tool_progress", toolUseId: "x", text: "late" });
    expect(record.entries[0]).toMatchObject({ status: "done", exitCode: 0, durationMs: 100, truncated: true });
    expect(record.entries[0]!.changes![0]!.diff).toHaveLength(32768);
    recordRunEvent(record, { type: "permission_request", toolName: "Bash", toolUseId: "x" });
    expect(record.phase).not.toBe("waiting_approval");
  });
  it("caps event count and marks incomplete data", () => {
    const record = createRunRecord(); for (let i = 0; i < RUN_ENTRY_LIMIT + 5; i++) recordRunEvent(record, { type: "assistant_text", text: String(i) });
    expect(record.entries).toHaveLength(RUN_ENTRY_LIMIT); expect(record.truncated).toBe(true);
  });
  it("preserves real tool receipts and stop states after the evidence byte limit", () => {
    const record = createRunRecord();
    for (const id of ["success", "failure", "stopped"]) {
      recordRunEvent(record, { type: "tool_use", toolName: "Bash", toolUseId: id, toolInput: { description: id } });
      recordRunEvent(record, { type: "tool_progress", toolUseId: id, text: "Previously captured output" });
    }
    for (let i = 0; i < 128; i++) {
      recordRunEvent(record, { type: "tool_use", toolName: "Read", toolUseId: `fill-${i}` });
      recordRunEvent(record, { type: "tool_result", toolUseId: `fill-${i}`, output: "x".repeat(65536) });
    }
    expect(record.truncated).toBe(true);
    recordRunEvent(record, { type: "tool_result", toolUseId: "success", output: "s".repeat(65536), exitCode: 0, durationMs: 123 });
    recordRunEvent(record, { type: "tool_result", toolUseId: "failure", output: "f".repeat(65536), isError: true, exitCode: 1, durationMs: 456 });
    expect(record.entries.find(e => e.callId === "success")).toMatchObject({ status: "done", exitCode: 0, durationMs: 123, output: "Previously captured output", truncated: true });
    expect(record.entries.find(e => e.callId === "failure")).toMatchObject({ status: "error", exitCode: 1, durationMs: 456, output: "Previously captured output", truncated: true });
    expect(summarizeRun(record, "running").current?.name).toBe("Bash");
    summarizeRun(record, "interrupted");
    expect(record.entries.find(e => e.callId === "stopped")).toMatchObject({ status: "stopped" });
    expect(record.entries.some(e => ["running", "waiting"].includes(e.status))).toBe(false);
    expect(record.bytes).toBe(record.entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0));
    expect(record.bytes).toBeLessThanOrEqual(RUN_BYTE_LIMIT);
  });
  it("reserves terminal receipts for every captured entry in a full journal", () => {
    const record = createRunRecord();
    for (let i = 0; i < RUN_ENTRY_LIMIT; i++) recordRunEvent(record, { type: "tool_use", toolName: "Read", toolUseId: String(i), toolInput: { path: "x".repeat(4096) } });
    expect(record.truncated).toBe(true);
    const count = record.entries.length;
    summarizeRun(record, "done");
    expect(record.entries).toHaveLength(count);
    expect(record.entries.every(entry => entry.status === "unknown" && entry.endedAt !== undefined)).toBe(true);
    expect(record.bytes).toBe(record.entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0));
    expect(record.bytes).toBeLessThanOrEqual(RUN_BYTE_LIMIT);
  });
});

describe("Hub run detail isolation and persistence", () => {
  let root: string, store: HubStore, journal: RunJournal, chat: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "run-journal-")); store = await HubStore.open(root); journal = new RunJournal(store);
    await store.db.run("INSERT INTO users VALUES('other','Other','member')");
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture'),('otherbot','Other bot','fixture2')");
    chat = (await store.createConversation("owner", ["bot"], "Run", "create")).id;
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
  async function seed(count = 1) {
    const record = createRunRecord(); for (let i = 0; i < count; i++) recordRunEvent(record, { type: "tool_use", toolName: "Read", toolUseId: `r${i}`, toolInput: { path: `/file${i}.txt` } });
    for (let i = 0; i < record.entries.length; i += 4) await journal.write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: record.entries.slice(i, i + 4) });
    const summary = summarizeRun(record, "running");
    const message = await store.publishBotMessage("bot", { id: "msg", conversationId: chat, blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summary)) } }], status: "streaming" });
    return { record, message };
  }
  it("paginates and searches, rejects foreign reads/writes and retains records across restart", async () => {
    const { record } = await seed(45);
    const first = await journal.read("owner", "msg", 0); expect(first.entries).toHaveLength(40); expect(first.next).toBe(40);
    expect((await journal.read("owner", "msg", 40)).entries).toHaveLength(5);
    expect((await journal.read("owner", "msg", 0, "/file44.txt")).entries).toHaveLength(1);
    await expect(journal.read("other", "msg", 0)).rejects.toThrow();
    await expect(journal.write("otherbot", { conversationId: chat, messageId: "msg", runId: record.id, entries: [record.entries[0]] })).rejects.toThrow();
    await store.db.close(); store = await HubStore.open(root); journal = new RunJournal(store);
    expect((await journal.read("owner", "msg", 40)).entries).toHaveLength(5);
  });
  it("ignores old revisions, bounds payloads, hides recalled records and expires details", async () => {
    const { record } = await seed(); const entry = record.entries[0]!;
    await journal.write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: [{ ...entry, revision: 3, status: "done", output: "confirmed" }] });
    await journal.write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: [entry] });
    expect((await journal.read("owner", "msg", 0)).entries[0]!.output).toBe("confirmed");
    await expect(journal.write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: [{ ...entry, output: "x".repeat(65537) }] })).rejects.toThrow();
    await store.db.run("UPDATE run_journal SET updated_at=?", [Date.now() - RUN_RETENTION_MS - 1]); expect((await journal.read("owner", "msg", 0)).entries).toHaveLength(0);
    await store.publishBotMessage("bot", { id: "msg", conversationId: chat, blocks: [], status: "deleted", version: 2 });
    await expect(journal.read("owner", "msg", 0)).rejects.toThrow("run_not_found");
    expect((await store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM run_journal"))!.n).toBe(0);
  });
  it("keeps personal deletion private and never infers files across overlapping run scopes", async () => {
    const input = await store.sendMessage("owner", { conversationId: chat, clientMsgId: "files-request", text: "做成片并后台检查", attachments: [] });
    const { record } = await seed();
    await store.db.run("UPDATE messages SET reply_to=? WHERE id='msg'", [input.message.id]);
    await store.db.run("INSERT INTO attachments(id,conversation_id,owner_id,sha256,size,mime,name,stored_name,complete,created_at) VALUES('artifact',?,'bot','test',3,'text/plain','result.txt','test',1,?)", [chat, Date.now()]);
    const file = { type: "file" as const, attachmentId: "artifact", name: "result.txt", size: 3, mime: "text/plain" };
    await store.publishBotMessage("bot", { id: "file-msg", conversationId: chat, replyTo: input.message.id, blocks: [file] });
    expect((await journal.read("owner", "msg", 0)).files).toEqual([file]);
    await store.db.run("INSERT INTO conversation_members(conversation_id,member_id,member_type) VALUES(?,'other','user')", [chat]);
    await store.deleteMessages("owner", chat, { messageIds: ["file-msg"] });
    expect((await journal.read("owner", "msg", 0)).files).toEqual([]);
    expect((await journal.read("other", "msg", 0)).files).toEqual([file]);
    const background = { ...summarizeRun(record, "running"), id: "background" };
    await store.publishBotMessage("bot", { id: "background", conversationId: chat, replyTo: input.message.id, blocks: [{ type: "card", elements: [], extra: { scopedRun: JSON.parse(JSON.stringify(background)) } }] });
    expect((await journal.read("other", "background", 0, "", true)).files).toEqual([]);
    expect((await journal.read("other", "msg", 0, "", true)).files).toEqual([]);
    // Explicit files in a report remain attributable even alongside other runs.
    const own = await store.messageForUser("other", "background");
    await store.publishBotMessage("bot", { id: own.id, conversationId: chat, replyTo: input.message.id, blocks: [...own.blocks, file] });
    expect((await journal.read("other", "background", 0, "", true)).files).toEqual([file]);
    await store.deleteMessages("owner", chat, { messageIds: ["msg"] });
    await expect(journal.read("owner", "msg", 0)).rejects.toThrow("message_not_found");
  });
  it("prunes expired details without deleting replies and preserves restart evidence", async () => {
    const input = await store.sendMessage("owner", { conversationId: chat, clientMsgId: "request", text: "test", attachments: [] });
    const { record } = await seed();
    await store.db.run("UPDATE messages SET reply_to=? WHERE id='msg'", [input.message.id]);
    await store.failDelivery("bot", input.message.id, "interrupted");
    const recovered = await store.messageForUser("owner", "msg"); const block = recovered.blocks[0]!;
    expect(block.type === "card" && nativeRun(block)).toMatchObject({ id: record.id, phase: "interrupted" });
    expect((await journal.read("owner", "msg", 0)).entries[0]!.status).toBe("unknown");
    expect(await new HubMaintenance(store, root).pruneRunDetails(Date.now() + RUN_RETENTION_MS + 1)).toBe(1);
    expect((await store.messageForUser("owner", "msg")).status).toBe("error");
  });
  it("publishes a readable answer even when the optional detail write fails", async () => {
    const transport = { capabilities: ["runs.v1", "runs.changes.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { if (method === "run.write") throw new Error("unavailable"); if (method === "publish") return store.publishBotMessage("bot", input); throw new Error(method); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord(); recordRunEvent(state.nativeRun, { type: "tool_use", toolName: "Read" });
    state.status = "done"; state.resultText = "Readable final answer";
    const sent = await channel.send(chat, { card: renderCoreRunCard(state) });
    const block = (await store.messageForUser("owner", sent.messageId)).blocks[0]!;
    expect(block.type === "card" && nativeRun(block)?.detailsUnavailable).toBe(true);
    expect(block.type === "card" && block.extra?.runChanges).toBeUndefined();
  });
  it("publishes live text before blocked evidence and fences terminal publication behind the final revisions", async () => {
    const calls: string[] = []; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; }); let firstWrite = true;
    const transport = { capabilities: ["runs.v1", "runs.changes.v1"], options: { stateDir: root }, request: async (method: string, input: any) => {
      calls.push(method);
      if (method === "run.write") { if (firstWrite) { firstWrite = false; await blocked; } await journal.write("bot", input); return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord();
    recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: "slow", toolName: "Edit" });
    const sent = await channel.send(chat, { card: renderCoreRunCard(state) });
    expect(calls).toEqual(["publish"]);
    expect((await store.messageForUser("owner", sent.messageId)).blocks[0]).not.toHaveProperty("extra.runChanges");
    await expect.poll(() => calls.length).toBe(2);
    state.blocks = [{ kind: "text", content: "正文无需等待记录", streaming: true }];
    await channel.updateCard(sent.messageId, renderCoreRunCard(state));
    expect(JSON.stringify(await store.messageForUser("owner", sent.messageId))).toContain("正文无需等待记录");
    recordRunEvent(state.nativeRun, { type: "tool_result", toolUseId: "slow", output: "最终过程记录", changes: [{ path: "/project/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] });
    state.status = "done"; state.resultText = "最终答案";
    let completed = false;
    const terminal = channel.updateCard(sent.messageId, renderCoreRunCard(state)).then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect((await store.messageForUser("owner", sent.messageId)).status).toBe("streaming");
    release(); await terminal;
    expect(calls).toEqual(["publish", "run.write", "publish", "run.write", "publish"]);
    expect((await journal.read("owner", sent.messageId, 0)).entries).toContainEqual(expect.objectContaining({ status: "done", output: "最终过程记录" }));
    const completedMessage = await store.messageForUser("owner", sent.messageId);
    expect(completedMessage.status).toBe("complete");
    expect(completedMessage.blocks[0]).toMatchObject({ extra: { runChanges: { files: 1, additions: 1, deletions: 1, partial: false } } });
  });
  it("does not lose readable body when optional evidence cannot be copied", async () => {
    const transport = { capabilities: ["runs.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { if (method === "publish") return store.publishBotMessage("bot", input); throw new Error("must not send malformed evidence"); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord();
    state.blocks = [{ kind: "text", content: "证据异常也保留正文", streaming: true }];
    const card = renderCoreRunCard(state) as any;
    card.appRun.entries = [{ seq: 1, revision: 1, kind: "tool", status: "done", at: 1, text: () => "invalid" }];
    const sent = await channel.send(chat, { card });
    const message = await store.messageForUser("owner", sent.messageId);
    expect(JSON.stringify(message)).toContain("证据异常也保留正文");
    expect(message.blocks[0]!.type === "card" && nativeRun(message.blocks[0]!)?.detailsUnavailable).toBe(true);
  });
  it("retains the original card when optional run summary metadata is invalid", async () => {
    const transport = { capabilities: ["runs.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { if (method === "publish") return store.publishBotMessage("bot", input); throw new Error("must not send invalid run metadata"); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord();
    state.blocks = [{ kind: "text", content: "摘要异常也保留原卡片正文", streaming: true }];
    const card = renderCoreRunCard(state) as any;
    card.appRun.summary.phase = "unsupported_phase";
    const sent = await channel.send(chat, { card });
    const message = await store.messageForUser("owner", sent.messageId);
    expect(JSON.stringify(message)).toContain("摘要异常也保留原卡片正文");
    expect(message.blocks[0]!.type === "card" && nativeRun(message.blocks[0]!)).toBeUndefined();
  });
  it("publishes compact summaries, sends only changed journal entries and leaves a readable older-host fallback", async () => {
    const calls: string[] = [];
    const transport = { capabilities: ["runs.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { calls.push(method); if (method === "run.write") { await journal.write("bot", input); return null; } if (method === "publish") return store.publishBotMessage("bot", input); throw new Error(method); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord(); recordRunEvent(state.nativeRun, { type: "tool_use", toolUseId: "a", toolName: "Bash" }); recordRunEvent(state.nativeRun, { type: "tool_result", toolUseId: "a", output: "x".repeat(10000) });
    const first = await channel.send(chat, { card: renderCoreRunCard(state) });
    expect(calls).toEqual(["publish"]);
    await expect.poll(async () => (await journal.read("owner", first.messageId, 0)).entries.length).toBe(1);
    expect(calls).toEqual(["publish", "run.write"]);
    const stored = await store.messageForUser("owner", first.messageId); const block = stored.blocks[0]; expect(block?.type === "card" && nativeRun(block)).toBeTruthy(); expect(JSON.stringify(stored)).not.toContain("x".repeat(1000));
    calls.length = 0; await channel.updateCard(first.messageId, renderCoreRunCard(state)); expect(calls).toEqual(["publish"]);
    transport.capabilities = []; const old = await channel.send(chat, { card: renderCoreRunCard(state) });
    expect(JSON.stringify(await store.messageForUser("owner", old.messageId))).not.toContain("nativeRun");
    expect(JSON.stringify(forwardedBlocks(stored.blocks, new Map()))).not.toContain("nativeRun");
  });
  it("keeps a goal turn-end hint outside strict summaries and scopes it to the exact run", async () => {
    const transport = { capabilities: ["runs.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { if (method === "run.write") { await journal.write("bot", input); return null; } if (method === "publish") return store.publishBotMessage("bot", input); throw new Error(method); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("goal"); state.nativeRun = createRunRecord();
    state.status = "done"; state.goalTurnEnded = true; state.resultText = "This turn ended; the goal remains set.";
    const sent = await channel.send(chat, { card: renderCoreRunCard(state) });
    const message = await store.messageForUser("owner", sent.messageId);
    const block = message.blocks[0]; expect(block.type).toBe("card"); if (block.type !== "card") throw new Error("Expected a card");
    const run = nativeRun(block)!;
    expect(run).toMatchObject({ phase: "done" });
    expect(run).not.toHaveProperty("goalTurnEnded");
    expect(isGoalTurnEnded(block, run)).toBe(true);
    expect(isGoalTurnEnded(block, { ...run, id: "other" })).toBe(false);
    expect(isGoalTurnEnded(block, { ...run, revision: run.revision + 1 })).toBe(false);
    expect(isGoalTurnEnded(block, { ...run, phase: "working" })).toBe(false);
    expect(isGoalTurnEnded({ extra: { ...block.extra, scopedRun: run } }, run)).toBe(false);
    expect(isGoalTurnEnded({ extra: { goalTurnEnded: true } }, run)).toBe(false);
    expect(JSON.stringify(forwardedBlocks([block], new Map()))).not.toContain("goalTurnEnded");
    state.goalTurnEnded = false;
    await channel.updateCard(sent.messageId, renderCoreRunCard(state));
    expect(JSON.stringify((await store.messageForUser("owner", sent.messageId)).blocks)).not.toContain("goalTurnEnded");
  });
  it("publishes live thought tails separately from strict summaries and clears them on completion", async () => {
    const transport = { capabilities: ["runs.v1"], options: { stateDir: root }, request: async (method: string, input: any) => { if (method === "run.write") { await journal.write("bot", input); return null; } if (method === "publish") return store.publishBotMessage("bot", input); throw new Error(method); } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const state = initialCoreRunState("test"); state.nativeRun = createRunRecord();
    recordRunEvent(state.nativeRun, { type: "thinking", text: "已找到归档记录。" });
    const sent = await channel.send(chat, { card: renderCoreRunCard(state) });
    const stored = await store.messageForUser("owner", sent.messageId);
    expect(stored.blocks[0]).toMatchObject({ extra: { nativeRunThinking: { text: "已找到归档记录。", runId: state.nativeRun.id } } });
    expect(JSON.stringify(stored.blocks[0].type === "card" && nativeRun(stored.blocks[0]))).not.toContain("已找到归档记录");
    state.status = "done";
    await channel.updateCard(sent.messageId, renderCoreRunCard(state));
    const completed = await store.messageForUser("owner", sent.messageId);
    expect(JSON.stringify(completed)).not.toContain("nativeRunThinking");
    expect((await journal.read("owner", sent.messageId, 0)).entries).toContainEqual(expect.objectContaining({ text: "已找到归档记录。" }));
  });
});

it("captures scheduled App turns through the same controller and stops tracking only after delivery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-cron-"));
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    const cards: any[] = [];
    const channel = { profile: "gateway" as const, stream: async () => { throw new Error("Unexpected legacy streaming path"); }, downloadResource: async () => Buffer.alloc(0), send: async (_to: string, content: any) => { if (content.card) cards.push(content.card); return { messageId: "cron" }; }, updateCard: async (_id: string, card: unknown) => { cards.push(card); } };
    const executor = buildCoreCronExecutor({ stateDir: root, channel, runtime: createCoreServiceRuntime(), createRunCard: createCoreRunCardController, deliverResponse: deliverCoreResponse, bridge: { handleAuthorizedMessage: async input => {
      expect(input.abortSignal).toBeDefined();
      await input.onEngineEvent?.({ type: "tool_use", toolName: "Read", toolUseId: "scheduled", toolInput: { path: "/report.txt" } });
      await input.onEngineEvent?.({ type: "tool_result", toolUseId: "scheduled", output: "scheduled evidence" });
      return { text: "Scheduled result" };
    } } });
    const job = await new CronStore(root).add({ channel: "lark", chatId: 1, userId: 1, larkChatId: "gw_test", conversationKey: "lark:gw_test", cronExpr: "0 9 * * *", prompt: "Review report", deliveryMode: "agent" });
    await withChannelProfile("gateway", () => executor(job));
    expect(cards.at(-1).appRun.summary.phase).toBe("done");
    expect(cards.at(-1).appRun.entries).toEqual([expect.objectContaining({ callId: "scheduled", output: "scheduled evidence", status: "done" })]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("publishes a stop request while delivery is pending without prematurely ending the run", async () => {
  const cards: any[] = [], abort = new AbortController();
  const channel = { profile: "gateway" as const, stream: async () => { throw new Error("Unexpected legacy streaming path"); }, downloadResource: async () => Buffer.alloc(0), send: async (_to: string, content: any) => { if (content.card) cards.push(content.card); return { messageId: "delivery" }; }, updateCard: async (_id: string, card: unknown) => { cards.push(card); } };
  await withChannelProfile("gateway", async () => {
    const controller = (await createCoreRunCardController({ channel, chatId: "gw_delivery", conversationKey: "lark:gw_delivery", locale: "zh", abortSignal: abort.signal }))!;
    await controller.beginDelivery("Files are being delivered");
    expect(cards.at(-1).appRun.summary.phase).toBe("delivering");
    abort.abort();
    await expect.poll(() => cards.at(-1).appRun.summary.phase).toBe("stopping");
    expect(cards.at(-1).appRun.summary.endedAt).toBeUndefined();
    await controller.interrupt(); expect(cards.at(-1).appRun.summary.phase).toBe("stopped");
  });
});


it("separates complete public narration messages but never inserts whitespace into token deltas", async () => {
  await withChannelProfile("gateway", async () => {
    let state=initialCoreRunState("lark:fixture");
    state=applyCoreEngineEvent(state,{type:"assistant_text",text:"第一段。"});
    state=applyCoreEngineEvent(state,{type:"assistant_text",text:"第二"});
    state=applyCoreEngineEvent(state,{type:"assistant_text",text:"段。",delta:true});
    expect(state.blocks).toContainEqual(expect.objectContaining({kind:"text",content:"第一段。\n\n第二段。"}));
  });
});


it("marks the bounded App fallback process as a recent excerpt and preserves its latest actions", async () => {
  await withChannelProfile("gateway", async () => {
    let state = initialCoreRunState("gateway-excerpt");
    state.nativeRun = createRunRecord();
    for (let i = 0; i < 80; i++) {
      const event = { type: "tool_use" as const, toolName: "Bash", toolUseId: `tool-${i}`, toolInput: { command: `step-${i} ` + "x".repeat(90) } };
      recordRunEvent(state.nativeRun!, event); state = applyCoreEngineEvent(state, event);
      state = applyCoreEngineEvent(state, { type: "tool_result", toolUseId: `tool-${i}`, output: "ok" });
    }
    state = applyCoreEngineEvent(state, { type: "result", text: "Finished" });
    for (const locale of ["zh", "en"] as const) for (const truncated of [false, true]) {
      state.nativeRun!.truncated = truncated;
      const card = renderCoreRunCard(state, locale) as any;
      const panel = card.body.elements.find((e: any) => e.tag === "collapsible_panel");
      const excerpt = panel.elements[0].content;
      expect(excerpt.length).toBeLessThanOrEqual(3000);
      expect(excerpt).toContain("step-79");
      expect(excerpt).toContain(locale === "zh" ? "最近的过程摘要" : "Recent process excerpt");
      expect(excerpt).toContain(locale === "zh" ? "运行过程" : "run details");
      expect(excerpt).not.toContain(locale === "zh" ? "完整记录" : "complete record");
      expect(excerpt).toContain("/80");
      if (truncated) expect(excerpt).toContain(locale === "zh" ? "采集上限" : "capture limit");
    }
  });
});

it("keeps the native collaboration action meaningful in fallback cards", async () => {
  await withChannelProfile("gateway", async () => {
    let state = initialCoreRunState("collab-excerpt");
    state.nativeRun = createRunRecord();
    state = applyCoreEngineEvent(state, { type: "tool_use", toolName: "CodexAgent", toolUseId: "wait-1", toolInput: { action: "wait", receiverThreadIds: ["first", "second"] } });
    state = applyCoreEngineEvent(state, { type: "tool_result", toolUseId: "wait-1", output: "{}" });
    state = applyCoreEngineEvent(state, { type: "result", text: "Finished" });
    expect(JSON.stringify(renderCoreRunCard(state, "en"))).toContain("wait ×2");
  });
});
