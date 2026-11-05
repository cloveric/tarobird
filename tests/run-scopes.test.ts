import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeRun, anyRun, RUN_CAPABILITY, RUN_SCOPES_CAPABILITY, runEntrySchema, runScopeSchema, runScopeWriteSchema, runWriteSchema, type RunEntry, type RunScope, type RunSummary } from "../src/client-protocol/run.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
import type { Block } from "../src/client-protocol/index.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { runScopeLabel, runScopeParent } from "../client/src/run-presentation.js";

const scope: RunScope = { id: "child-1", kind: "subagent", label: "核对报告", parentId: "background-1", parentCallId: "agent-call" };
const entry: RunEntry = { seq: 1, revision: 1, kind: "tool", status: "done", at: 1, name: "Read", text: "公开进展", output: "原始工具回执", scope };
const summary = (id = "run", phase: RunSummary["phase"] = "done", startedAt = Date.now()): RunSummary => ({ version: 1, id, revision: 1, phase, startedAt, updatedAt: startedAt + 1, ...(phase === "done" ? { endedAt: startedAt + 1 } : {}), count: 1, completed: phase === "done" ? 1 : 0, failed: 0, truncated: false });
const card = (run: RunSummary, scoped = true): Extract<Block, { type: "card" }> => ({ type: "card", elements: [{ type: "markdown", text: "公开完整正文" }], extra: { [scoped ? "scopedRun" : "nativeRun"]: JSON.parse(JSON.stringify(run)) } });

it("validates bounded scope metadata only on the separate negotiated write contract", () => {
  expect(runEntrySchema.parse(entry).scope).toEqual(scope);
  expect(runScopeSchema.safeParse({ ...scope, id: "x".repeat(129) }).success).toBe(false);
  expect(runScopeSchema.safeParse({ ...scope, parentId: "x".repeat(129) }).success).toBe(false);
  expect(runScopeSchema.safeParse({ ...scope, parentCallId: "x".repeat(513) }).success).toBe(false);
  expect(runScopeSchema.safeParse({ ...scope, label: "x".repeat(513) }).success).toBe(false);
  const legacySchema = runEntrySchema.omit({ scope: true }).strict();
  expect(legacySchema.safeParse(entry).success).toBe(false);
  const input = { conversationId: "chat", messageId: "message", runId: "run", entries: [entry] };
  expect(runWriteSchema.safeParse(input).success).toBe(false);
  expect(runScopeWriteSchema.parse(input).entries[0].scope).toEqual(scope);
});

it("labels every scope and its explicit parent without inventing ancestry", () => {
  expect(runScopeLabel(scope)).toBe("子代理 · 核对报告");
  expect(runScopeParent(scope)).toBe("父作用域：background-1 · 父调用：agent-call");
  expect(runScopeLabel({ kind: "background", id: "job-1" })).toBe("后台任务");
  expect(runScopeParent({ kind: "subagent", id: "child-2" })).toBe("");
});

it("reads scoped summaries and strips live metadata from forwarded snapshots", () => {
  const block = card(summary());
  expect(anyRun(block)?.id).toBe("run");
  expect(nativeRun(block)).toBeUndefined();
  expect(nativeRun(card(summary(), false))?.id).toBe("run");
  block.extra!.scopedJournal = { runId: "run", revision: 1, pending: true };
  const forwarded = forwardedBlocks([block], new Map())[0]!;
  expect(forwarded.type === "card" && anyRun(forwarded)).toBeUndefined();
  expect(JSON.stringify(forwarded)).toContain("公开完整正文");
  expect(JSON.stringify(forwarded)).not.toContain("scopedRun");
  expect(JSON.stringify(forwarded)).not.toContain("scopedJournal");
});

describe("scoped journal transport and recovery", () => {
  let root: string, store: HubStore, journal: RunJournal, chat: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "run-scopes-")); store = await HubStore.open(root); journal = new RunJournal(store);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture'),('other','Other','fixture2')");
    chat = (await store.createConversation("owner", ["bot", "other"], "Scopes", "create")).id;
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });

  it("retains scope ownership across pagination, search and persistence while default reads stay legacy compatible", async () => {
    const entries = Array.from({ length: 45 }, (_, index) => ({ ...entry, seq: index + 1, scope: { ...scope, kind: index % 2 ? "background" as const : "subagent" as const } }));
    for (let i = 0; i < entries.length; i += 4) await journal.writeScoped("bot", { conversationId: chat, messageId: "message", runId: "run", entries: entries.slice(i, i + 4) });
    const { scope: _scope, ...rootEntry } = { ...entry, seq: 46 };
    await journal.write("bot", { conversationId: chat, messageId: "message", runId: "run", entries: [rootEntry] });
    await store.publishBotMessage("bot", { id: "message", conversationId: chat, blocks: [card(summary())] });
    const first = await journal.read("owner", "message", 0, "核对报告", true);
    expect(first.entries.map(e => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(first.entries.every(e => e.scope?.parentCallId === "agent-call")).toBe(true);
    expect(first.next).toBe(40);
    const last = await journal.read("owner", "message", first.next!, "agent-call", true);
    expect(last.entries.map(e => e.seq)).toEqual([41, 42, 43, 44, 45]);
    expect(last.next).toBeNull();
    const legacy = await journal.read("owner", "message", 0);
    expect(legacy.entries).toEqual([rootEntry]);
    const payloads = await store.db.all<{ payload: string }>("SELECT payload FROM run_journal UNION ALL SELECT payload FROM run_journal_scoped");
    expect(payloads).toHaveLength(46);
    for (const row of payloads) expect(runEntrySchema.omit({ scope: true }).strict().safeParse(JSON.parse(row.payload)).success).toBe(true);
    expect(await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "25" });
    await store.db.close(); store = await HubStore.open(root); journal = new RunJournal(store);
    expect((await journal.read("owner", "message", 40, "", true)).entries[0]?.scope).toEqual(scope);
  });

  it("upgrades an existing schema-15 database before legacy writes and reconciles rollback recalls", async () => {
    await store.db.run("DROP TABLE run_journal_scoped");
    await store.db.close(); store = await HubStore.open(root); journal = new RunJournal(store);
    expect(await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "25" });
    const columns = await store.db.all<{ name: string; pk: number }>("PRAGMA table_info(run_journal_scoped)");
    expect(columns.filter(column => column.pk).map(column => column.name)).toEqual(["message_id", "run_id", "seq"]);
    expect(await store.db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='run_journal_scoped_expiry'")).toBeDefined();
    const { scope: _scope, ...rootEntry } = { ...entry, seq: 2 };
    await journal.write("bot", { conversationId: chat, messageId: "upgrade", runId: "run", entries: [rootEntry] });
    await journal.writeScoped("bot", { conversationId: chat, messageId: "upgrade", runId: "run", entries: [entry] });
    await store.publishBotMessage("bot", { id: "upgrade", conversationId: chat, blocks: [card(summary(), false)] });
    expect((await journal.read("owner", "upgrade", 0)).entries).toEqual([rootEntry]);
    // Old binaries recall the message but know nothing about the optional table.
    await store.db.run("UPDATE messages SET status='deleted',blocks_json='[]' WHERE id='upgrade'");
    await expect(journal.read("owner", "upgrade", 0, "", true)).rejects.toThrow("run_not_found");
    await store.db.close(); store = await HubStore.open(root); journal = new RunJournal(store);
    expect(await store.db.get("SELECT count(*) AS count FROM run_journal_scoped")).toEqual({ count: 0 });
  });

  it.each([false, true])("never activates the conversation envelope for working scoped reports, with scopes capability %s", async supportsScopes => {
    const transport = { capabilities: [RUN_CAPABILITY, ...(supportsScopes ? [RUN_SCOPES_CAPABILITY] : [])], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "publish") return store.publishBotMessage("bot", input);
      if (method === "run.scope.write") return null;
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { config: { streaming_mode: true }, elements: [{ tag: "markdown", content: "子代理公开进展" }], appRun: { summary: summary("background", "working"), entries: [], background: true } } });
    const message = await store.messageForUser("owner", sent.messageId);
    expect(message.status).toBe("complete");
    const block = message.blocks[0]!;
    expect(block.type === "card" && nativeRun(block)).toBeUndefined();
    expect(block.type === "card" && anyRun(block)?.phase).toBe(supportsScopes ? "working" : undefined);
    await channel.updateCard(sent.messageId, { elements: [], appRun: { summary: summary("background", "delivering"), entries: [], background: true } });
    expect((await store.messageForUser("owner", sent.messageId)).status).toBe("complete");
  });

  it.each([false, true])("writes foreground evidence safely to a scopes-capable Hub: %s", async supportsScopes => {
    const writes: unknown[] = [];
    const transport = { capabilities: [RUN_CAPABILITY, ...(supportsScopes ? [RUN_SCOPES_CAPABILITY] : [])], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "run.write") { writes.push(input); if (!supportsScopes) for (const e of input.entries) runEntrySchema.omit({ scope: true }).strict().parse(e); await journal.write("bot", input); return null; }
      if (method === "run.scope.write") { await journal.writeScoped("bot", input); return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const { scope: _scope, ...rootEntry } = { ...entry, seq: 2 };
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "正文始终保留" }], appRun: { summary: summary(), entries: [entry, rootEntry] } } });
    expect(writes).toHaveLength(1);
    const message = await store.messageForUser("owner", sent.messageId);
    expect(JSON.stringify(message)).toContain("正文始终保留");
    const stored = message.blocks[0]!;
    expect(stored.type === "card" && anyRun(stored)?.detailsUnavailable).not.toBe(true);
    expect((await journal.read("owner", sent.messageId, 0)).entries).toEqual([rootEntry]);
    if (supportsScopes) await expect.poll(async () => (await journal.read("owner", sent.messageId, 0, "", true)).entries.length).toBe(2);
    const saved = (await journal.read("owner", sent.messageId, 0, "", true)).entries;
    expect(saved).toEqual(supportsScopes ? [entry, rootEntry] : [rootEntry]);
  });

  it.each([false, true])("keeps background reports safe for older clients when scopes support is %s", async supportsScopes => {
    const methods: string[] = [];
    const transport = { capabilities: [RUN_CAPABILITY, ...(supportsScopes ? [RUN_SCOPES_CAPABILITY] : [])], options: { stateDir: root }, request: async (method: string, input: any) => {
      methods.push(method); if (method === "run.scope.write") { await journal.writeScoped("bot", input); return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "后台正文始终保留" }], appRun: { summary: summary(), entries: [entry], background: true } } });
    const message = await store.messageForUser("owner", sent.messageId), block = message.blocks[0]!;
    expect(JSON.stringify(message)).toContain("后台正文始终保留");
    expect(block.type === "card" && block.extra?.nativeRun).toBeUndefined();
    expect(block.type === "card" && !!block.extra?.scopedRun).toBe(supportsScopes);
    if (supportsScopes) await expect.poll(() => methods.length).toBe(3);
    expect(methods).toEqual(supportsScopes ? ["publish", "run.scope.write", "publish"] : ["publish"]);
  });

  it("notifies once at scoped completion and never during complete-envelope progress or sync acknowledgements", async () => {
    const now = Date.now();
    await store.db.run("INSERT INTO devices VALUES('device','owner','Test','android','unused',0,?,?,?)", [now, now, JSON.stringify({ provider: "fcm", token: "test_" + "x".repeat(48) })]);
    await store.db.run("INSERT INTO device_preferences VALUES('device',?)", [JSON.stringify({ enabled: true })]);
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "publish") return store.publishBotMessage("bot", input);
      if (method === "run.scope.write") return journal.writeScoped("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const render = (phase: RunSummary["phase"]) => ({ elements: [{ tag: "markdown", content: "后台公开回复" }], appRun: { summary: summary("background", phase), entries: phase === "done" ? [entry] : [], background: true } });
    const sent = await channel.send(chat, { card: render("working") });
    await channel.updateCard(sent.messageId, render("delivering"));
    expect(await store.db.all("SELECT id FROM push_outbox")).toHaveLength(0);
    await channel.updateCard(sent.messageId, render("done"));
    await expect.poll(() => (channel as any).tasks.size).toBe(0);
    const rows = await store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ messageId: sent.messageId, kind: "answer" });
  });

  it("keeps scoped RPC rejection separate from the root journal and final answer", async () => {
    const roots: RunEntry[] = [];
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "run.scope.write") throw new Error("invalid_request");
      if (method === "run.write") { roots.push(...input.entries); await journal.write("bot", input); return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const { scope: _scope, ...rootEntry } = { ...entry, seq: 2 };
    const render = (revision: number) => ({ elements: [{ tag: "markdown", content: "完整最终回复" }], appRun: { summary: { ...summary(), revision }, entries: [entry, { ...rootEntry, revision }] } });
    const sent = await channel.send(chat, { card: render(1) });
    await expect.poll(() => (channel as any).scopedRunWriter.unavailable({ messageId: sent.messageId, conversationId: chat, runId: "run" })).toBe(true);
    await channel.updateCard(sent.messageId, render(2));
    expect(roots.map(value => value.revision)).toEqual([1, 2]);
    const message = await store.messageForUser("owner", sent.messageId);
    expect(message.status).toBe("complete");
    expect(JSON.stringify(message)).toContain("完整最终回复");
    expect((await journal.read("owner", sent.messageId, 0)).entries).toEqual([{ ...rootEntry, revision: 2 }]);
  });

  it("publishes a terminal answer while scoped persistence is blocked and drains its writer on disconnect", async () => {
    let release!: () => void, requested = false, disconnected = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, disconnect: async () => { disconnected = true; release(); }, request: async (method: string, input: any) => {
      if (method === "run.scope.write") { requested = true; await held; await journal.writeScoped("bot", input); return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "立即可读的最终回复" }], appRun: { summary: summary(), entries: [entry], background: true } } });
    await expect.poll(() => requested).toBe(true);
    expect((await store.messageForUser("owner", sent.messageId)).status).toBe("complete");
    expect(JSON.stringify(await store.messageForUser("owner", sent.messageId))).toContain("立即可读的最终回复");
    await channel.disconnect();
    expect(disconnected).toBe(true);
    expect((await journal.read("owner", sent.messageId, 0, "", true)).entries).toEqual([entry]);
  });

  it("marks a last scoped batch failure on the same terminal card without changing or duplicating its body", async () => {
    const publications: any[] = [];
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "run.scope.write") throw new Error("invalid_request");
      if (method === "publish") { publications.push(input); return store.publishBotMessage("bot", input); }
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "最终正文逐字保留" }], appRun: { summary: summary(), entries: [entry], background: true } } });
    await expect.poll(async () => {
      const block = (await store.messageForUser("owner", sent.messageId)).blocks[0]!;
      return block.type === "card" && anyRun(block)?.detailsUnavailable;
    }).toBe(true);
    expect(publications).toHaveLength(2);
    expect(publications[1]).toMatchObject({ id: sent.messageId, status: "complete", version: 2 });
    expect(publications[1].blocks[0].elements).toEqual(publications[0].blocks[0].elements);
    expect((await store.snapshot("owner", chat)).messages).toHaveLength(1);
  });

  it("does not falsely mark a slow successful final scope batch unavailable", async () => {
    let release!: () => void, requested = false;
    const held = new Promise<void>(resolve => { release = resolve; }), publications: any[] = [];
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "run.scope.write") { requested = true; await held; await journal.writeScoped("bot", input); return null; }
      if (method === "publish") { publications.push(input); return store.publishBotMessage("bot", input); }
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "先展示最终正文" }], appRun: { summary: summary(), entries: [entry], background: true } } });
    await expect.poll(() => requested).toBe(true);
    expect((await store.messageForUser("owner", sent.messageId)).status).toBe("complete");
    release(); await expect.poll(() => (channel as any).tasks.size).toBe(0);
    expect(publications).toHaveLength(2);
    expect(publications[0].blocks[0].extra.scopedJournal.pending).toBe(true);
    expect(publications[1].blocks[0].extra.scopedJournal.pending).toBe(false);
    expect(publications[1].blocks[0].elements).toEqual(publications[0].blocks[0].elements);
    const block = (await store.messageForUser("owner", sent.messageId)).blocks[0]!;
    expect(block.type === "card" && anyRun(block)?.detailsUnavailable).toBeUndefined();
  });

  it("ignores a late scope failure after the message has moved to a different run", async () => {
    let reject!: () => void, requested = false;
    const held = new Promise<void>((_resolve, fail) => { reject = () => fail(new Error("invalid_request")); });
    const transport = { capabilities: [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY], options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "run.scope.write") { requested = true; await held; return null; }
      if (method === "publish") return store.publishBotMessage("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport);
    const sent = await channel.send(chat, { card: { elements: [{ tag: "markdown", content: "之前的正文" }], appRun: { summary: summary("old"), entries: [entry], background: true } } });
    await expect.poll(() => requested).toBe(true);
    await channel.updateCard(sent.messageId, { elements: [{ tag: "markdown", content: "新运行的正文" }], appRun: { summary: summary("new", "working"), entries: [] } });
    const newer = await store.messageForUser("owner", sent.messageId);
    reject(); await expect.poll(() => (channel as any).tasks.size).toBe(0);
    expect(await store.messageForUser("owner", sent.messageId)).toEqual(newer);
  });

  it("recovers only old active runs and preserves the scoped key for old clients", async () => {
    const before = Date.now();
    const old = await store.publishBotMessage("bot", { conversationId: chat, status: "complete", blocks: [card(summary("background", "working", before - 100))] });
    const current = await store.publishBotMessage("bot", { conversationId: chat, status: "streaming", blocks: [card(summary("foreground", "working", before), false)] });
    const currentBackground = await store.publishBotMessage("bot", { conversationId: chat, status: "streaming", blocks: [card(summary("new-background", "working", before))] });
    const done = await store.publishBotMessage("bot", { conversationId: chat, status: "complete", blocks: [card(summary("completed", "done", before - 100))] });
    const other = await store.publishBotMessage("other", { conversationId: chat, status: "streaming", blocks: [card(summary("other", "working", before - 100))] });
    await store.recoverOrphanRuns("bot", before);
    const recovered = await store.messageForUser("owner", old.id), block = recovered.blocks[0]!;
    expect(recovered.status).toBe("error");
    expect(block.type === "card" && block.extra?.nativeRun).toBeUndefined();
    expect(block.type === "card" && anyRun(block)).toMatchObject({ id: "background", phase: "interrupted" });
    for (const preserved of [current, currentBackground, done, other]) expect(await store.messageForUser("owner", preserved.id)).toEqual(preserved);
  });

  it("closes a failed input's scoped run without closing another input's foreground run", async () => {
    const first = (await store.sendMessage("owner", { conversationId: chat, clientMsgId: "first", text: "first", attachments: [], mentions: ["bot"] })).message;
    const second = (await store.sendMessage("owner", { conversationId: chat, clientMsgId: "second", text: "second", attachments: [], mentions: ["bot"] })).message;
    const background = await store.publishBotMessage("bot", { conversationId: chat, replyTo: first.id, status: "complete", blocks: [card(summary("background", "working"))] });
    const foreground = await store.publishBotMessage("bot", { conversationId: chat, replyTo: second.id, status: "streaming", blocks: [card(summary("foreground", "working"), false)] });
    await store.failDelivery("bot", first.id, "interrupted");
    const block = (await store.messageForUser("owner", background.id)).blocks[0]!;
    expect(block.type === "card" && block.extra?.nativeRun).toBeUndefined();
    expect(block.type === "card" && anyRun(block)?.phase).toBe("interrupted");
    expect(await store.messageForUser("owner", foreground.id)).toEqual(foreground);
  });

  it("applies scope ownership, recall and retention to the independent table", async () => {
    const input = { conversationId: chat, messageId: "message", runId: "run", entries: [entry] };
    await journal.writeScoped("bot", input);
    await expect(journal.writeScoped("other", input)).rejects.toThrow("run_forbidden");
    await expect(journal.write("bot", input)).rejects.toThrow();
    await store.publishBotMessage("bot", { id: "message", conversationId: chat, blocks: [card(summary())] });
    await store.publishBotMessage("bot", { id: "message", conversationId: chat, blocks: [], status: "deleted", version: 2 });
    expect(await store.db.get("SELECT count(*) AS count FROM run_journal_scoped")).toEqual({ count: 0 });
    await expect(journal.writeScoped("bot", input)).rejects.toThrow("run_forbidden");
    await journal.writeScoped("bot", { ...input, messageId: "retained" });
    await store.db.run("UPDATE run_journal_scoped SET updated_at=1");
    expect(await new HubMaintenance(store, root).pruneRunDetails()).toBe(1);
  });

  it("negotiates the new RPC and opt-in HTTP read over the real Hub transport", async () => {
    const hub = await HubServer.start({ stateDir: path.join(root, "network-hub") });
    const secret = randomBytes(32).toString("base64url");
    const transport = new GatewayTransport({ stateDir: path.join(root, "network-worker"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret });
    const channel = new GatewayChannel(transport);
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
      const conversation = await hub.store.createConversation("owner", ["alpha"], "HTTP scopes", "network");
      await transport.connect();
      await expect.poll(() => transport.capabilities.includes(RUN_SCOPES_CAPABILITY)).toBe(true);
      const { scope: _scope, ...rootEntry } = { ...entry, seq: 2 };
      const sent = await channel.send(conversation.id, { card: { elements: [{ tag: "markdown", content: "完整回复" }], appRun: { summary: summary(), entries: [entry, rootEntry] } } });
      const journal = new RunJournal(hub.store);
      await expect.poll(async () => (await journal.read("owner", sent.messageId, 0, "", true)).entries.length).toBe(2);
      const pair = generateKeyPairSync("ed25519"), deviceId = "scope-reader", clientNonce = randomBytes(32).toString("base64url");
      const pending = await hub.auth.pair({ deviceId, name: "Reader", platform: "web", publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "127.0.0.1");
      await hub.auth.approve(pending.code, "local-owner");
      const challenge = await hub.auth.challenge("reader", deviceId, clientNonce, "127.0.0.1");
      const session = await hub.auth.authenticate("reader", sign(null, deviceProof(deviceId, challenge.nonce, clientNonce), pair.privateKey).toString("base64"));
      const headers = { Authorization: `Bearer ${session.token}` }, url = `${hub.url}/api/messages/${sent.messageId}/run`;
      expect((await fetch(`${url}?scopes=1`)).status).toBe(401);
      const legacy = await (await fetch(url, { headers })).json() as { entries: RunEntry[] };
      const scoped = await (await fetch(`${url}?scopes=1`, { headers })).json() as { entries: RunEntry[] };
      expect(legacy.entries).toEqual([rootEntry]);
      expect(scoped.entries).toEqual([entry, rootEntry]);
    } finally { await channel.disconnect(); await hub.close(); }
  });
});
