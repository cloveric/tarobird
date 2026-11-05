import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { controlPath, inspectHubService, startHubControl, stopDrainedHub } from "../src/hub/service.js";
import { closeHubRuntime } from "../src/hub/shutdown.js";
import { waitForHostIdle } from "../src/host-cli/lifecycle.js";

vi.mock("node:child_process", async original => { const actual = await original<typeof import("node:child_process")>(); return { ...actual, fork: vi.fn(actual.fork) }; });
let root: string, hub: HubServer, manager: BotManager;
let children: childProcess.ChildProcess[], frames: Array<{ type: string; message?: { id: string }; method?: string }>;
let control: (() => Promise<void>) | undefined;
const spec = { requestId: "drain_fixture", name: "Fixture", engine: "codex" as const, model: "", effort: "" as const, workspace: "" };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "h-drain-")); children = []; frames = [];
  const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(childProcess.fork).mockImplementation((...args) => {
    const child = original.fork(...args); children.push(child);
    child.on("message", (value: unknown) => { const data = value as { type: string; frame: typeof frames[number] }; if (data.type === "fixture.frame") frames.push(data.frame); }); return child;
  });
  hub = await HubServer.start({ stateDir: root, managedBots: { entrypoint: path.resolve("tests/fixtures/host-drain-worker.mjs"), env: { PATH: process.env.PATH, CODEX_EXECUTABLE: process.execPath, TAROBOT_FIXTURE_DRAIN_ACK_DELAY: "100" } } });
  manager = (hub as unknown as { botManager: BotManager }).botManager;
});
afterEach(async () => { await control?.(); control = undefined; await hub?.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function create(requestId = spec.requestId) { const bot = await manager.create("owner", { ...spec, requestId }); await vi.waitFor(async () => expect((await hub.store.bots("owner")).find(value => value.id === bot.id)?.online).toBe(1)); return bot.id; }
async function childState(child: childProcess.ChildProcess): Promise<{ draining: boolean; cancelled: boolean; busy: boolean; port: number }> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("fixture_timeout")), 2000); const listener = (raw: unknown) => { const data = raw as { type: string; draining: boolean; cancelled: boolean; busy: boolean; port: number }; if (data.type === "fixture.state") { clearTimeout(timer); child.off("message", listener); resolve(data); } }; child.on("message", listener); child.send({ type: "fixture.state" }); });
}
async function leaseHost(duration: number) {
  await hub.close();
  hub = await HubServer.start({ stateDir: root, drainLeaseMs: duration, managedBots: { entrypoint: path.resolve("tests/fixtures/host-drain-worker.mjs"), env: { PATH: process.env.PATH, CODEX_EXECUTABLE: process.execPath } } });
  manager = (hub as unknown as { botManager: BotManager }).botManager;
}

it("drains existing work without forcing it and restores queued messages exactly after cancellation", async () => {
  const bot = await create(), child = children[0]!, conversation = await hub.store.createConversation("owner", [bot], "drain", "conversation");
  await hub.drainHost(); expect(hub.hostDrainStatus()).toMatchObject({ draining: true, drained: false });
  const { message: first } = await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "queued", text: "keep this", attachments: [] });
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(frames.filter(frame => frame.type === "instance.message")).toHaveLength(0);
  expect(await hub.store.pendingForBot(bot)).toHaveLength(1); expect(child.exitCode).toBeNull();
  await expect(manager.create("owner", { ...spec, requestId: "refused" })).rejects.toThrow("hub_draining");
  await hub.cancelHostDrain(); expect(await childState(child)).toMatchObject({ draining: false, cancelled: true });
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "instance.message" && frame.message?.id === first.id)).toBe(true));
  child.send({ type: "fixture.ack", messageId: first.id });
  await vi.waitFor(async () => expect(await hub.store.pendingForBot(bot)).toHaveLength(0));
  const delivered = frames.filter(frame => frame.type === "instance.message" && frame.message?.id === first.id).length;
  await hub.cancelHostDrain(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(frames.filter(frame => frame.type === "instance.message" && frame.message?.id === first.id)).toHaveLength(delivered);
});

it("serializes an immediately cancelled drain before restoring worker admission", async () => {
  await create(); const child = children[0]!;
  const draining = hub.drainHost(), cancelled = hub.cancelHostDrain();
  await Promise.all([draining, cancelled]);
  expect(hub.hostDrainStatus()).toMatchObject({ draining: false, drained: false });
  expect(await childState(child)).toMatchObject({ draining: false, cancelled: true });
  child.send({ type: "fixture.finish" }); await new Promise(resolve => setTimeout(resolve, 350));
  expect(child.exitCode).toBeNull(); expect(children).toHaveLength(1);
});

it("does not let a different CLI drain claim or cancel an existing operation", async () => {
  await create(); await hub.drainHost("owner_drain");
  await expect(hub.drainHost("another_drain")).rejects.toThrow("host_drain_owned");
  await expect(hub.cancelHostDrain("another_drain")).rejects.toThrow("host_drain_owned");
  expect(hub.hostDrainStatus()).toMatchObject({ draining: true, drainId: "owner_drain" });
  expect((await childState(children[0]!)).draining).toBe(true);
  await hub.cancelHostDrain("owner_drain"); expect(hub.hostDrainStatus().draining).toBe(false);
});

it("rejects new drain operations while Hub shutdown finishes its accepted control work", async () => {
  await create(); const drain = hub.drainHost("closing_drain");
  await Promise.resolve(); const closing = hub.close();
  await Promise.allSettled([drain, closing]);
  await expect(hub.cancelHostDrain()).rejects.toThrow("hub_stopping");
});

it("expires an abandoned completed drain, restarts its workers and dispatches preserved messages", async () => {
  await leaseHost(1200); const bot = await create(), first = children[0]!;
  const conversation = await hub.store.createConversation("owner", [bot], "lease", "lease");
  await hub.drainHost("abandoned"); first.send({ type: "fixture.finish" });
  await vi.waitFor(() => expect(hub.hostDrainStatus().drained).toBe(true));
  const { message } = await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "while-offline", text: "retain me", attachments: [] });
  await vi.waitFor(() => expect(hub.hostDrainStatus().draining).toBe(false), { timeout: 3000 });
  await vi.waitFor(() => expect(children).toHaveLength(2));
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "instance.message" && frame.message?.id === message.id)).toBe(true));
  children[1]!.send({ type: "fixture.ack", messageId: message.id });
  await vi.waitFor(async () => expect(await hub.store.pendingForBot(bot)).toHaveLength(0));
});

it("renews only the matching drain lease and never accepts stale ownership", async () => {
  await leaseHost(600); await hub.drainHost("lease_owner");
  const original = hub.hostDrainStatus().drainLeaseExpiresAt!;
  await expect(hub.renewHostDrain("different_owner")).rejects.toThrow("host_drain_owned");
  await hub.drainHost(); await hub.drainHost("lease_owner");
  expect(hub.hostDrainStatus().drainLeaseExpiresAt).toBe(original);
  await new Promise(resolve => setTimeout(resolve, 300)); await hub.renewHostDrain("lease_owner");
  expect(hub.hostDrainStatus().drainLeaseExpiresAt).toBeGreaterThan(original);
  await new Promise(resolve => setTimeout(resolve, 350)); expect(hub.hostDrainStatus().draining).toBe(true);
  await vi.waitFor(() => expect(hub.hostDrainStatus().draining).toBe(false));
  await expect(hub.renewHostDrain("lease_owner")).rejects.toThrow("host_drain_owned");
});

it("preserves worker waiting reasons through the Hub's authenticated local status", async () => {
  const botId = await create();
  children[0]!.send({ type: "fixture.blocker", kind: "async_question", conversationKey: "lark:gw_waiting" });
  control = await startHubControl(root, () => ({ running: true, pid: process.pid, url: hub.url, publicKey: hub.auth.publicKey, ...hub.hostDrainStatus() }), () => {});
  await hub.drainHost("explain_wait");
  await vi.waitFor(async () => {
    expect(await inspectHubService(root)).toMatchObject({ draining: true, drained: false, drainBlockers: [{ botId, conversationKey: "lark:gw_waiting", type: "async_question", count: 1 }] });
  });
  await hub.cancelHostDrain("explain_wait");
  expect(await inspectHubService(root)).not.toHaveProperty("drainBlockers");
});

it("commits only the drained matching process and never resumes queued work during slow terminal cleanup", async () => {
  await leaseHost(1200); const bot = await create(), worker = children[0]!;
  const conversation = await hub.store.createConversation("owner", [bot], "terminal", "terminal");
  await hub.drainHost("terminal_owner"); worker.send({ type: "fixture.finish" });
  await vi.waitFor(() => expect(hub.hostDrainStatus().drained).toBe(true));
  await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "terminal-queue", text: "wait for next start", attachments: [] });
  let finish!: () => void, closing: Promise<void> | undefined;
  const maintenance = new Promise<void>(resolve => { finish = resolve; });
  const status = { running: true as const, pid: process.pid, url: hub.url, publicKey: hub.auth.publicKey };
  control = await startHubControl(root, () => ({ ...status, ...hub.hostDrainStatus() }), () => {
    closing = closeHubRuntime({ hub, finishMaintenance: () => maintenance, releaseLock: async () => {} });
  }, { stopDrained: id => hub.stopDrainedHost(id) });
  const guard = { drainId: "terminal_owner", pid: process.pid, publicKey: hub.auth.publicKey };
  await expect(stopDrainedHub(root, { ...guard, pid: process.pid + 1 })).rejects.toThrow("host_drain_target_changed");
  await expect(stopDrainedHub(root, { ...guard, publicKey: "different-host" })).rejects.toThrow("host_drain_target_changed");
  await expect(stopDrainedHub(root, { ...guard, drainId: "different-owner" })).rejects.toThrow("host_drain_owned");
  expect(closing).toBeUndefined();
  await stopDrainedHub(root, guard);
  try {
    await expect(hub.cancelHostDrain("terminal_owner")).rejects.toThrow("hub_stopping");
    await expect(hub.renewHostDrain("terminal_owner")).rejects.toThrow("hub_stopping");
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(children).toHaveLength(1); expect(await hub.store.pendingForBot(bot)).toHaveLength(1);
    expect(frames.filter(frame => frame.type === "instance.message")).toHaveLength(0);
  } finally { finish(); await closing; }
  expect(hub.shutdownComplete).toBe(true);
});

it("rejects terminal drain commitment while a real worker is still busy", async () => {
  await create(); const worker = children[0]!;
  await hub.drainHost("busy_stop");
  await expect(hub.stopDrainedHost("busy_stop")).rejects.toThrow("host_drain_not_finished");
  expect((await childState(worker)).busy).toBe(true); expect(worker.exitCode).toBeNull();
  await hub.cancelHostDrain("busy_stop"); expect(hub.hostDrainStatus().draining).toBe(false);
});

it("still closes actual workers and listeners when audit flush fails", async () => {
  await create(); const child = children[0]!, url = hub.url;
  vi.spyOn(hub.store, "flushAudit").mockRejectedValue(new Error("fixture_flush_failure"));
  await expect(hub.close()).rejects.toThrow("fixture_flush_failure");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(manager.shutdownComplete).toBe(true); expect(hub.shutdownComplete).toBe(true);
  await expect(fetch(url + "/health")).rejects.toThrow();
  await expect(hub.store.db.get("SELECT 1")).rejects.toThrow();
  // close() truthfully retains its original error; teardown need not report it twice.
  vi.spyOn(hub, "close").mockResolvedValue();
});

it("recovers server-side after the CLI process is killed without cancelling its busy worker", async () => {
  await leaseHost(900); await create(); const worker = children[0]!;
  control = await startHubControl(root, () => ({ running: true, pid: process.pid, url: hub.url, publicKey: hub.auth.publicKey, ...hub.hostDrainStatus() }), () => {},
    { drain: id => hub.drainHost(id), cancelDrain: id => hub.cancelHostDrain(id), renewDrain: id => hub.renewHostDrain(id) });
  const cli = childProcess.spawn(process.execPath, ["--input-type=module", "-e", `
    import net from 'node:net'; import {readFile} from 'node:fs/promises';
    const token=(await readFile(process.env.TEST_KEY,'utf8')).trim();
    const socket=net.createConnection(process.env.TEST_PIPE);
    socket.on('connect',()=>socket.write(JSON.stringify({command:'drain',drainId:'dead_cli',token})+'\\n'));
    socket.on('data',()=>process.send?.({type:'leased'})); socket.on('error',()=>process.exit(2)); setInterval(()=>{},1000);
  `], { env: { TEST_KEY: path.join(root, "hub-control.key"), TEST_PIPE: controlPath(root) }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = new Promise<void>(resolve => cli.once("exit", () => resolve())); let leased = false;
  cli.on("message", () => { leased = true; });
  try {
    await vi.waitFor(() => expect(leased).toBe(true)); expect(hub.hostDrainStatus().draining).toBe(true);
    cli.kill("SIGKILL"); await exited;
    await vi.waitFor(() => expect(hub.hostDrainStatus().draining).toBe(false), { timeout: 3000 });
    expect(worker.exitCode).toBeNull(); expect(await childState(worker)).toMatchObject({ busy: true, draining: false, cancelled: true });
  } finally { if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL"); await exited; }
});

it("keeps an idle peer alive for a running Bot's later delegation before stopping the entire fleet", async () => {
  await create("alpha"); await create("beta"); const [alpha, beta] = children as [childProcess.ChildProcess, childProcess.ChildProcess];
  beta.send({ type: "fixture.finish" }); await vi.waitFor(async () => expect((await childState(beta)).busy).toBe(false));
  await hub.drainHost(); await new Promise(resolve => setTimeout(resolve, 700));
  expect(beta.exitCode).toBeNull(); expect(hub.hostDrainStatus().drained).toBe(false);
  alpha.send({ type: "fixture.delegate", port: (await childState(beta)).port });
  await vi.waitFor(async () => expect((await childState(beta)).busy).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 350)); expect(alpha.exitCode).toBeNull(); expect(beta.exitCode).toBeNull();
  beta.send({ type: "fixture.finish" });
  await vi.waitFor(() => expect(hub.hostDrainStatus()).toMatchObject({ draining: true, drained: true }), { timeout: 3000 });
  expect(alpha.exitCode).toBe(75); expect(beta.exitCode).toBe(75); expect(children).toHaveLength(2);
});

it("stops idle workers without auto-respawning and brings them back when drain is cancelled", async () => {
  await create(); const child = children[0]!; await hub.drainHost(); child.send({ type: "fixture.finish" });
  await vi.waitFor(() => expect(hub.hostDrainStatus()).toMatchObject({ draining: true, drained: true }));
  expect(child.exitCode).toBe(75); await new Promise(resolve => setTimeout(resolve, 650)); expect(children).toHaveLength(1);
  await hub.cancelHostDrain(); await vi.waitFor(() => expect(children).toHaveLength(2));
  await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(1));
});

it("a CLI wait timeout retains the running worker and permits approvals during drain", async () => {
  await create(); const child = children[0]!; const shutdown = vi.fn();
  control = await startHubControl(root, () => ({ running: true, pid: process.pid, url: hub.url, publicKey: hub.auth.publicKey, ...hub.hostDrainStatus() }), shutdown,
    { drain: id => hub.drainHost(id), cancelDrain: id => hub.cancelHostDrain(id), renewDrain: id => hub.renewHostDrain(id) });
  await expect(waitForHostIdle(root, 10)).rejects.toThrow("未强制停止或更新");
  expect(shutdown).not.toHaveBeenCalled(); expect(child.exitCode).toBeNull(); expect((await inspectHubService(root)).running).toBe(true);
  expect(hub.hostDrainStatus().draining).toBe(false); expect(await childState(child)).toMatchObject({ draining: false, cancelled: true });
  await hub.drainHost();
  await expect(waitForHostIdle(root, 10)).rejects.toThrow("tarobot drain-cancel");
  expect(hub.hostDrainStatus().draining).toBe(true);
  const botId = (await hub.store.bots("owner"))[0]!.id;
  const result = await (hub as unknown as { callBot: (id: string, method: string, params: object) => Promise<unknown> }).callBot(botId, "interaction", { actionId: "approve-existing-run" });
  expect(result).toMatchObject({ ok: true }); expect(frames.some(frame => frame.type === "instance.call" && frame.method === "interaction")).toBe(true);
});
