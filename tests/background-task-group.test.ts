import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_TASK_GROUP_CAPABILITY, backgroundTaskGroup, backgroundTaskGroupSchema } from "../src/client-protocol/background-task-group.js";
import { CAPABILITIES, type Block } from "../src/client-protocol/index.js";
import { RUN_CAPABILITY, RUN_SCOPES_CAPABILITY, anyRun, type RunScope, type RunSummary } from "../src/client-protocol/run.js";
import type { EngineStreamEvent, ScopedEngineEvent } from "../src/codex/adapter.js";
import { createScopedRunPresentation, finishScopedRunPresentation } from "../src/core/scoped-run-presentation.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";

type Card = Extract<Block, { type: "card" }>;
const ALL = [RUN_CAPABILITY, RUN_SCOPES_CAPABILITY, BACKGROUND_TASK_GROUP_CAPABILITY];
const subagent = (id: string): RunScope => ({ id, kind: "subagent", label: `Audit ${id}` });
const running: ScopedEngineEvent = { type: "scope_status", status: "running" };
function scoped(scope: RunScope, event: ScopedEngineEvent, extra: Partial<Extract<EngineStreamEvent, { type: "scoped" }>> = {}): Extract<EngineStreamEvent, { type: "scoped" }> {
  return { type: "scoped", scope, origin: "bound", event, ...extra };
}
const summary = (id: string, phase: RunSummary["phase"] = "working"): RunSummary => ({ version: 1, id, revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false });

describe("background task group contract", () => {
  it("accepts a v1 record with additive fields only when bound to its own scoped run", () => {
    const meta = { version: 1, groupId: "group_a", scopeId: "scope-a", runId: "run-a" };
    expect(backgroundTaskGroupSchema.parse(meta)).toEqual(meta);
    expect(backgroundTaskGroupSchema.parse({ ...meta, ordinal: 2 })).toEqual(meta);
    for (const bad of [{ ...meta, version: 2 }, { ...meta, groupId: "../a" }, { ...meta, runId: "" }, { ...meta, scopeId: undefined }]) expect(backgroundTaskGroupSchema.safeParse(bad).success).toBe(false);
    expect(backgroundTaskGroup({ extra: { backgroundTaskGroup: meta } }, { id: "run-a" })).toEqual(meta);
    expect(backgroundTaskGroup({ extra: { backgroundTaskGroup: meta } }, { id: "run-b" })).toBeUndefined();
    expect(CAPABILITIES).toContain(BACKGROUND_TASK_GROUP_CAPABILITY);
  });
});

describe("background task group publication", () => {
  let root: string, store: HubStore, journal: RunJournal, chat: string, prompt: string;
  const channels: GatewayChannel[] = [];
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "background-groups-")); store = await HubStore.open(root); journal = new RunJournal(store);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    chat = (await store.createConversation("owner", ["bot"], "Groups", "create")).id;
    prompt = (await store.sendMessage("owner", { conversationId: chat, clientMsgId: "prompt", text: "start", attachments: [], mentions: ["bot"] })).message.id;
  });
  afterEach(async () => {
    // Optional journal batches drain after publication; never close under them.
    for (const channel of channels.splice(0)) await expect.poll(() => (channel as any).tasks.size === 0 && !(channel as any).scopedRunWriter.isBusy() && !(channel as any).runWriter.isBusy()).toBe(true);
    await store.db.close(); await rm(root, { recursive: true, force: true });
  });
  function gateway(capabilities = ALL): GatewayChannel {
    const transport = { capabilities, options: { stateDir: root }, request: async (method: string, input: any) => {
      if (method === "publish") return store.publishBotMessage("bot", input);
      if (method === "run.scope.write") return journal.writeScoped("bot", input);
      if (method === "run.write") return journal.write("bot", input);
      throw new Error(method);
    } };
    const channel = new GatewayChannel(transport as unknown as GatewayTransport); channels.push(channel); return channel;
  }
  const presenter = (channel: GatewayChannel, replyTo = prompt) => createScopedRunPresentation({ channel, chatId: chat, conversationKey: `gateway:${chat}`, replyTo, locale: "en" });
  async function cards(): Promise<Map<string, { message: string; replyTo?: string; status: string; block: Card }>> {
    const result = new Map<string, { message: string; replyTo?: string; status: string; block: Card }>();
    for (const message of (await store.snapshot("owner", chat)).messages) {
      const block = message.blocks[0];
      const label = block?.type === "card" ? (block.extra?.scopedTask as { label?: string } | undefined)?.label : undefined;
      if (message.authorType === "bot" && block?.type === "card" && label) result.set(label, { message: message.id, replyTo: message.replyTo, status: message.status, block });
    }
    return result;
  }
  const meta = (block: Card) => block.extra?.backgroundTaskGroup as { groupId: string; scopeId: string; runId: string } | undefined;

  it("groups bound background subagents per originating callback and binds each member to its own run", async () => {
    const channel = gateway(), first = presenter(channel), second = presenter(channel);
    await first.apply(scoped(subagent("a"), running, { detached: true }));
    await first.apply(scoped(subagent("b"), running, { detached: true }));
    // The same request can start another callback; its tasks form a new group.
    await second.apply(scoped(subagent("c"), running, { detached: true }));
    let stored = await cards();
    const [a, b, c] = ["Audit a", "Audit b", "Audit c"].map(label => stored.get(label)!);
    expect([a, b, c].map(item => item.replyTo)).toEqual([prompt, prompt, prompt]);
    expect(meta(a.block)).toMatchObject({ version: 1, scopeId: "a", runId: anyRun(a.block)!.id });
    expect(meta(b.block)).toMatchObject({ groupId: meta(a.block)!.groupId, scopeId: "b", runId: anyRun(b.block)!.id });
    expect(meta(c.block)!.groupId).not.toBe(meta(a.block)!.groupId);
    expect(new Set([a, b, c].map(item => meta(item.block)!.runId)).size).toBe(3);
    expect(JSON.stringify([...stored.values()].map(item => item.block))).not.toContain("appScopedGroup");
    // Terminal updates keep their membership and their independent status.
    await first.apply(scoped(subagent("a"), { type: "scope_status", status: "error" }, { detached: true }));
    stored = await cards();
    expect(meta(stored.get("Audit a")!.block)).toEqual(meta(a.block));
    expect(anyRun(stored.get("Audit a")!.block)!.phase).toBe("error");
    expect(anyRun(stored.get("Audit b")!.block)!.phase).not.toBe("error");
  });

  it("keeps report carriers, unattributed work and foreground process cards standalone", async () => {
    const channel = gateway(), p = presenter(channel);
    await p.apply(scoped({ id: "review", kind: "background", label: "Review report" }, running));
    await p.apply(scoped(subagent("unknown"), running, { origin: "unattributed", detached: true }));
    await p.apply(scoped(subagent("process"), running));
    // A foreground child that outlives its finished turn joins the turn's group.
    await p.apply(scoped(subagent("late"), running), { foreground: { apply: async () => undefined, isFinished: () => true } });
    await p.apply(scoped(subagent("report"), running, { detached: true }));
    await p.apply(scoped(subagent("collected"), running, { detached: true }));
    let stored = await cards();
    for (const label of ["Review report", "Audit unknown", "Audit process"]) {
      expect(stored.get(label)!.block.extra?.backgroundTaskGroup).toBeUndefined();
      expect(anyRun(stored.get(label)!.block)).toBeDefined();
    }
    const group = meta(stored.get("Audit late")!.block)!.groupId;
    expect(meta(stored.get("Audit report")!.block)!.groupId).toBe(group);
    const context = { channel, conversationKey: `gateway:${chat}`, replyTo: prompt };
    expect(await finishScopedRunPresentation(context, { type: "task_notification", scopeId: "report", origin: "bound", status: "completed", text: "User-facing report" })).toBe(true);
    expect(await finishScopedRunPresentation(context, { type: "task_notification", scopeId: "collected", origin: "bound", status: "completed", text: "Collected", suppressUserDelivery: true })).toBe(true);
    stored = await cards();
    expect(stored.get("Audit report")!.block.extra?.backgroundTaskGroup).toBeUndefined();
    expect(JSON.stringify(stored.get("Audit report")!.block.elements)).toContain("User-facing report");
    expect(meta(stored.get("Audit collected")!.block)!.groupId).toBe(group);
  });

  it("stores no producer grouping without the negotiated capability or a valid bound background summary", async () => {
    await presenter(gateway([RUN_CAPABILITY, RUN_SCOPES_CAPABILITY])).apply(scoped(subagent("legacy"), running, { detached: true }));
    const channel = gateway();
    const send = (extra: Record<string, unknown>, run = summary("direct"), background = true) => channel.send(chat, { card: { elements: [{ tag: "markdown", content: "Readable report" }], ...extra, appRun: { summary: run, entries: [], background } } });
    const bound = { appBackgroundTask: { version: 1, origin: "bound", status: "running" } };
    await send({ ...bound, appScopedTask: { version: 1, label: "Malformed", kind: "subagent" }, appScopedGroup: { version: 1, groupId: "bad/id", scopeId: "s" } }, summary("malformed"));
    await send({ appBackgroundTask: { version: 1, origin: "unattributed", status: "running" }, appScopedTask: { version: 1, label: "Unattributed", kind: "subagent" }, appScopedGroup: { version: 1, groupId: "g", scopeId: "s" } }, summary("unattributed"));
    await send({ ...bound, appScopedTask: { version: 1, label: "Foreground", kind: "subagent" }, appScopedGroup: { version: 1, groupId: "g", scopeId: "s" } }, summary("foreground"), false);
    await send({ ...bound, appScopedTask: { version: 1, label: "Valid", kind: "subagent" }, appScopedGroup: { version: 1, groupId: "g", scopeId: "s" } }, summary("valid"));
    const stored = await cards();
    for (const label of ["Audit legacy", "Malformed", "Unattributed", "Foreground"]) {
      expect(stored.get(label)!.block.extra?.backgroundTaskGroup).toBeUndefined();
      expect(stored.get(label)!.block.extra?.appScopedGroup).toBeUndefined();
      if (label !== "Audit legacy") expect(JSON.stringify(stored.get(label)!.block.elements)).toContain("Readable report");
    }
    expect(anyRun(stored.get("Audit legacy")!.block)).toBeDefined();
    expect(stored.get("Foreground")!.block.extra?.nativeRun).toBeDefined();
    expect(meta(stored.get("Valid")!.block)).toEqual({ version: 1, groupId: "g", scopeId: "s", runId: "valid" });
  });

  it("keeps membership through journal settlement and Hub interruption, never through forwarding", async () => {
    const channel = gateway(), p = presenter(channel);
    for (const id of ["synced", "orphan"]) await p.apply(scoped(subagent(id), running, { detached: true }));
    await p.apply(scoped(subagent("synced"), { type: "tool_use", toolUseId: "read-1", toolName: "Read", toolInput: {} }, { detached: true }));
    await p.apply(scoped(subagent("synced"), { type: "scope_status", status: "done" }, { detached: true }));
    await expect.poll(async () => (await cards()).get("Audit synced")!.block.extra?.scopedJournal).toMatchObject({ pending: false });
    const before = await cards();
    expect(meta(before.get("Audit synced")!.block)!.runId).toBe(anyRun(before.get("Audit synced")!.block)!.id);
    // Failed input delivery and a later worker attachment both interrupt in place.
    await store.failDelivery("bot", prompt, "interrupted");
    let after = await cards();
    expect(after.get("Audit orphan")!.status).toBe("error");
    expect(anyRun(after.get("Audit orphan")!.block)).toMatchObject({ id: meta(before.get("Audit orphan")!.block)!.runId, phase: "interrupted" });
    expect(meta(after.get("Audit orphan")!.block)).toEqual(meta(before.get("Audit orphan")!.block));
    expect(after.get("Audit synced")!.block).toEqual(before.get("Audit synced")!.block);
    // Orphan recovery skips replies whose input delivery is still pending.
    const next = (await store.sendMessage("owner", { conversationId: chat, clientMsgId: "next", text: "again", attachments: [], mentions: ["bot"] })).message.id;
    await store.db.run("UPDATE deliveries SET status='complete' WHERE message_id=?", [next]);
    await presenter(channel, next).apply(scoped(subagent("restarted"), running, { detached: true }));
    const original = meta((await cards()).get("Audit restarted")!.block)!;
    await store.recoverOrphanRuns("bot", Date.now() + 1);
    after = await cards();
    expect(anyRun(after.get("Audit restarted")!.block)).toMatchObject({ id: original.runId, phase: "interrupted" });
    expect(meta(after.get("Audit restarted")!.block)).toEqual(original);
    // Recovery restores only a valid record for the same run, byte-for-byte.
    const direct = (label: string, runId: string, group: Record<string, string | number>) => store.publishBotMessage("bot", { conversationId: chat, status: "complete", blocks: [{ type: "card", elements: [{ type: "markdown", text: label }],
      extra: { scopedTask: { version: 1, label, kind: "subagent" }, scopedRun: JSON.parse(JSON.stringify(summary(runId))), backgroundTaskGroup: group } }] });
    await direct("Additive", "additive-run", { version: 1, groupId: "g", scopeId: "s1", runId: "additive-run", ordinal: 1 });
    await direct("Foreign", "foreign-run", { version: 1, groupId: "g", scopeId: "s2", runId: "another-run" });
    await direct("Unknown version", "v2-run", { version: 2, groupId: "g", scopeId: "s3", runId: "v2-run" });
    await store.recoverOrphanRuns("bot", Date.now() + 1);
    after = await cards();
    expect(after.get("Additive")!.block.extra?.backgroundTaskGroup).toEqual({ version: 1, groupId: "g", scopeId: "s1", runId: "additive-run", ordinal: 1 });
    for (const label of ["Foreign", "Unknown version"]) {
      expect(anyRun(after.get(label)!.block)!.phase).toBe("interrupted");
      expect(after.get(label)!.block.extra?.backgroundTaskGroup).toBeUndefined();
    }
    const target = (await store.createConversation("owner", ["bot"], "Forward target", "forward_target")).id;
    const forwarded = await store.forwardMessage("owner", { v: 1, type: "message.forward", conversationId: target, sourceMessageId: after.get("Audit synced")!.message, clientMsgId: "forward_group" }, async () => undefined);
    const copy = forwarded.message.blocks[0] as Card;
    expect(copy.extra?.backgroundTaskGroup).toBeUndefined();
    expect(anyRun(copy)).toBeUndefined();
    expect(JSON.stringify(copy.elements)).toContain("Subagent execution has finished.");
  });

  it("negotiates the capability over the real Hub transport", async () => {
    const hub = await HubServer.start({ stateDir: path.join(root, "network-hub") });
    const secret = randomBytes(32).toString("base64url");
    const transport = new GatewayTransport({ stateDir: path.join(root, "network-worker"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret });
    const channel = new GatewayChannel(transport);
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
      const conversation = await hub.store.createConversation("owner", ["alpha"], "Network groups", "network");
      await transport.connect();
      await expect.poll(() => transport.capabilities.includes(BACKGROUND_TASK_GROUP_CAPABILITY)).toBe(true);
      await createScopedRunPresentation({ channel, chatId: conversation.id, conversationKey: `gateway:${conversation.id}`, locale: "en" }).apply(scoped(subagent("network"), running, { detached: true }));
      const message = (await hub.store.snapshot("owner", conversation.id)).messages.find(item => item.authorType === "bot")!;
      const block = message.blocks[0] as Card;
      expect(backgroundTaskGroup(block, anyRun(block)!)).toMatchObject({ scopeId: "network" });
    } finally { await channel.disconnect(); await hub.close(); }
  });
});
