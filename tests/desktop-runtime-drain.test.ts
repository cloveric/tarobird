import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { waitForHostIdle } from "../src/host-cli/lifecycle.js";
import * as service from "../src/hub/service.js";
import { HubStore } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
let opened: { directory: string; store: HubStore } | undefined;
afterEach(async () => { vi.restoreAllMocks(); if (opened) { await opened.store.db.close(); await rm(opened.directory, { recursive: true, force: true }); } opened = undefined; });
function fixture(mode = "busy", version?: string, onDrain?: () => Promise<void>) {
  const state = { draining: mode === "owned", drainId: mode === "owned" ? "other" : undefined as string | undefined, commands: [] as string[] };
  vi.spyOn(service, "inspectHubService").mockImplementation(async (_directory, action = "status", options = {}) => {
    state.commands.push(action);
    if (action === "drain") { await onDrain?.(); state.draining = true; state.drainId = options.drainId; }
    if (action === "drain-cancel") {
      if (mode === "cancel-fails") return { running: true, pid: 2000000001, publicKey: "fixture", url: "http://127.0.0.1:1", controlError: "control_failed", draining: true };
      state.draining = false; state.drainId = undefined;
    }
    return { running: true, pid: 2000000001, publicKey: "fixture", url: "http://127.0.0.1:1", ...(version ? { version } : {}), drained: mode === "idle", draining: state.draining, drainId: state.drainId, controlCapabilities: ["drain-renew"] };
  });
  return state;
}
async function hostState(options: { online?: number; member?: boolean; engine?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-drain-")), store = await HubStore.open(directory);
  opened = { directory, store };
  await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('bot_c','Claude','00',?,?)", [options.engine ?? "claude", options.online ?? 1]);
  await store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES('conv_1','direct','c','owner',1)");
  await store.db.run("INSERT INTO conversation_members VALUES('conv_1','user','owner',0)");
  if (options.member !== false) await store.db.run("INSERT INTO conversation_members VALUES('conv_1','bot','bot_c',0)");
  return { directory, store };
}
/** Foreground work: a user input handed to the worker (or still queued) and/or its streaming reply. */
async function foreground(store: HubStore, options: { dispatched?: number; delivery?: boolean; reply?: boolean } = {}) {
  await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('in_1','conv_1','owner','user','[]','complete',1,1)");
  if (options.delivery !== false) await store.db.run("INSERT INTO deliveries(message_id,bot_id,status,queue_position,dispatched) VALUES('in_1','bot_c','pending',1,?)", [options.dispatched ?? 1]);
  if (options.reply) await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,reply_to,created_at) VALUES('reply_1','conv_1','bot_c','bot',?,'streaming',1,'in_1',2)", [JSON.stringify([{ type: "text", text: "partial" }])]);
}
/** A completed foreground reply's separate background process card. */
async function backgroundCard(options: { online?: number; member?: boolean; updatedAt?: number; phase?: string; engine?: string; run?: "scopedRun" | "nativeRun" } = {}) {
  const { directory, store } = await hostState(options);
  const updatedAt = options.updatedAt ?? Date.now();
  const card = { type: "card", elements: [{ type: "markdown", text: "subagent running" }], extra: { [options.run ?? "scopedRun"]: { id: "run_bg", phase: options.phase ?? "working", startedAt: updatedAt - 1000, updatedAt, revision: 1 } } };
  await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_bg','conv_1','bot_c','bot',?,'complete',1,2)", [JSON.stringify([card])]);
  return directory;
}
it("busy timeout keeps its code only after restoring task acceptance", async () => {
  const state = fixture(); await expect(waitForHostIdle("fixture", 0)).rejects.toMatchObject({ code: "host_drain_busy" });
  expect(state.draining).toBe(false); expect(state.commands.at(-1)).toBe("drain-cancel");
});
it("another drain owner is reported without cancellation", async () => {
  const state = fixture("owned"); await expect(waitForHostIdle("fixture", 0)).rejects.toMatchObject({ code: "host_drain_owned" });
  expect(state.commands).toEqual(["status"]); expect(state.drainId).toBe("other");
});
it("failed cancellation is not disguised as harmless waiting", async () => {
  fixture("cancel-fails");
  await expect(waitForHostIdle("fixture", 0)).rejects.toThrow("恢复接收任务失败");
});
it("idle hosts return the owned lease for guarded stopping", async () => {
  const state = fixture("idle"); expect(await waitForHostIdle("fixture", 0)).toBe(state.drainId); expect(state.draining).toBe(true);
});
it("never asks an older Host to drain while its background card may still be running", async () => {
  const directory = await backgroundCard(), state = fixture("idle", "0.1.453");
  const error = await waitForHostIdle(directory, 0).catch((value: Error & { code?: string }) => value);
  expect(error).toMatchObject({ code: "host_drain_busy" });
  expect(String(error)).toContain("旧版主机（0.1.453）"); expect(String(error)).toContain("conv_1");
  expect(state.commands).toEqual(["status"]); expect(state.draining).toBe(false);
});
it("conservatively counts an active run card from any engine on an older Host", async () => {
  const directory = await backgroundCard({ engine: "codex", run: "nativeRun" }), state = fixture("idle", "0.1.453");
  await expect(waitForHostIdle(directory, 0)).rejects.toMatchObject({ code: "host_drain_busy" });
  expect(state.commands).toEqual(["status"]);
});
it("keeps waiting on an old silent card: age alone never proves native work ended", async () => {
  const directory = await backgroundCard({ updatedAt: Date.now() - 7 * 24 * 60 * 60_000 }), state = fixture("idle", "0.1.453");
  await expect(waitForHostIdle(directory, 0)).rejects.toMatchObject({ code: "host_drain_busy", message: expect.stringContaining("tarobot restart --force") });
  expect(state.commands).toEqual(["status"]);
});
it.each([
  ["its Bot has no attached worker", { online: 0 }],
  ["its Bot left the conversation", { member: false }],
  ["it already reached a terminal phase", { phase: "done" }],
])("limits the old-host card guard to online members with active phases: %s", async (_name, options) => {
  const directory = await backgroundCard(options), state = fixture("idle", "0.1.453");
  expect(await waitForHostIdle(directory, 0)).toBe(state.drainId); expect(state.commands).toContain("drain");
});
it("leaves current Hosts to their own native drain accounting", async () => {
  const directory = await backgroundCard(), state = fixture("idle", "0.1.454");
  expect(await waitForHostIdle(directory, 0)).toBe(state.drainId); expect(state.commands).toContain("drain");
});
it("drains an older Host once its background card settles within the wait", async () => {
  const directory = await backgroundCard(), state = fixture("idle", "0.1.453");
  const settled = new Promise(resolve => setTimeout(resolve, 200)).then(() => opened!.store.db.run("UPDATE messages SET blocks_json=json_set(blocks_json,'$[0].extra.scopedRun.phase','done') WHERE id='msg_bg'"));
  expect(await waitForHostIdle(directory, 10_000)).toBe(state.drainId); await settled;
  expect(state.commands.filter(command => command === "drain")).toHaveLength(1);
});
it("waits for an input already handed to an older Host's worker, before any reply or card exists", async () => {
  const { directory, store } = await hostState(); await foreground(store); const state = fixture("idle", "0.1.453");
  await expect(waitForHostIdle(directory, 0)).rejects.toMatchObject({ code: "host_drain_busy", message: expect.stringContaining("已开始处理的消息") });
  expect(state.commands).toEqual(["status"]);
});
it("waits for a streaming foreground reply on an older Host instead of letting its drain wait for it", async () => {
  const { directory, store } = await hostState(); await foreground(store, { delivery: false, reply: true }); const state = fixture("idle", "0.1.453");
  await expect(waitForHostIdle(directory, 0)).rejects.toMatchObject({ code: "host_drain_busy", message: expect.stringContaining("前台回复") });
  expect(state.commands).toEqual(["status"]);
});
it("leaves undispatched queued inputs to the older Host's drain, which never dispatches them", async () => {
  const { directory, store } = await hostState(); await foreground(store, { dispatched: 0 }); const state = fixture("idle", "0.1.453");
  expect(await waitForHostIdle(directory, 0)).toBe(state.drainId); expect(state.commands).toContain("drain");
});
it.each([["has no attached worker", { online: 0 }], ["left the conversation", { member: false }]])("does not wait for foreground work of a Bot that %s", async (_name, options) => {
  const { directory, store } = await hostState(options); await foreground(store, { reply: true }); const state = fixture("idle", "0.1.453");
  expect(await waitForHostIdle(directory, 0)).toBe(state.drainId); expect(state.commands).toContain("drain");
});
it("leaves current Hosts' foreground work to their own drain", async () => {
  const { directory, store } = await hostState(); await foreground(store, { reply: true }); const state = fixture("idle", "0.1.454");
  expect(await waitForHostIdle(directory, 0)).toBe(state.drainId); expect(state.commands).toContain("drain");
});
it("drains an older Host once, only after a foreground reply hands off to background work and both settle", async () => {
  const { directory, store } = await hostState(); await foreground(store, { reply: true });
  const timeline: string[] = [], at = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const state = fixture("idle", "0.1.453", async () => { timeline.push("drain"); });
  const script = (async () => {
    await at(200);
    const card = [{ type: "card", elements: [], extra: { scopedRun: { id: "run_bg", phase: "working", startedAt: Date.now(), updatedAt: Date.now(), revision: 1 } } }];
    await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,reply_to,created_at) VALUES('bg_1','conv_1','bot_c','bot',?,'complete',1,'in_1',3)", [JSON.stringify(card)]);
    timeline.push("background-started"); await at(200);
    await store.db.run("UPDATE messages SET status='complete' WHERE id='reply_1'"); await store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id='in_1'");
    timeline.push("foreground-done"); await at(1200);
    await store.db.run("UPDATE messages SET blocks_json=json_set(blocks_json,'$[0].extra.scopedRun.phase','done') WHERE id='bg_1'");
    timeline.push("background-done");
  })();
  expect(await waitForHostIdle(directory, 10_000)).toBe(state.drainId); await script;
  expect(timeline).toEqual(["background-started", "foreground-done", "background-done", "drain"]);
  expect(state.commands.filter(command => command === "drain")).toHaveLength(1);
});
it("cancelling while an older Host's known work runs requests no drain and stops nothing", async () => {
  const { directory, store } = await hostState(); await foreground(store, { reply: true }); const state = fixture("idle", "0.1.453");
  const controller = new AbortController(); setTimeout(() => controller.abort(), 100);
  await expect(waitForHostIdle(directory, 10_000, controller.signal)).rejects.toThrow("等待已取消");
  expect(state.commands).toEqual(["status"]); expect(state.draining).toBe(false);
});
it("a cancellation while an older Host's work snapshot is being read never reaches drain", async () => {
  const { directory } = await hostState(); const state = fixture("idle", "0.1.453");
  const snapshot = HubDatabase.snapshot.bind(HubDatabase);
  let release!: () => void, reading!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reading = resolve; });
  vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
    const reader = await snapshot(file), all = reader.all.bind(reader);
    vi.spyOn(reader, "all").mockImplementation((async (sql: string, params?: never) => { reading(); await gate; return all(sql, params); }) as never);
    return reader;
  });
  const controller = new AbortController(), waiting = waitForHostIdle(directory, 10_000, controller.signal);
  // The held read finds no work; the cancellation arrives before it returns.
  await held; controller.abort(); release();
  await expect(waiting).rejects.toThrow("等待已取消");
  expect(state.commands).toEqual(["status"]); expect(state.draining).toBe(false);
});
