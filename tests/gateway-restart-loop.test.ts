import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubError } from "../src/hub/store.js";
import { blocksText } from "../src/client-protocol/index.js";
import { readDeliveryObligations, recordDeliveryObligation } from "../src/state/delivery-obligation-store.js";
import { isRestartLoopTripped, recordUncleanBootAndCheck } from "../src/runtime/restart-loop-guard.js";
import { gatewayRestartFixture } from "./helpers/gateway-restart-fixture.js";

it("treats a requested stop during startup as clean, not another crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-stop-startup-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    await recordUncleanBootAndCheck(stateDir);
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "stop-startup" }, path.join(root, "home"));
    await vi.waitFor(() => expect(fixture!.messages).toContain("fixture.startup-waiting"), { timeout: 15_000 });
    fixture.child.send({ type: "shutdown.now" }); fixture.child.send({ type: "fixture.release-startup" });
    await vi.waitFor(() => expect(fixture!.child.exitCode).toBe(0));
    expect((await isRestartLoopTripped(stateDir)).recentBoots).toHaveLength(1);
    expect(await readFile(path.join(stateDir, "service.lifecycle.log.jsonl"), "utf8").catch(() => "")).not.toContain('"service.fatal"');
    await expect(readFile(path.join(stateDir, "instance.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it("retires input transport before slow worker cleanup can accept more messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cleanup-admission-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Pending", "create");
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "slow-cleanup" }, path.join(root, "home"));
    await vi.waitFor(() => expect(fixture!.messages).toContain("boot-complete"), { timeout: 15_000 });
    fixture.child.send({ type: "shutdown.now" });
    await vi.waitFor(() => expect(fixture!.messages).toContain("fixture.cleanup-waiting"));
    await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(0));
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "wait", text: "Wait for a live worker", attachments: [] });
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(1);
    expect(fixture.messages).not.toContain("fixture.unwanted-turn");
    fixture.child.send({ type: "fixture.release-cleanup" });
    await vi.waitFor(() => expect(fixture!.child.exitCode).toBe(0));
    expect(await hub.store.pendingForBot("alpha")).toHaveLength(1);
  } finally { await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000);

it.each(["kill", "throw"] as const)("standalone %s recovery loops break without losing owed replies or blocking fresh commands", async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-restart-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const options = { stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode };
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  const start = () => fixture = gatewayRestartFixture(options, path.join(root, "home"));
  const boot = async () => { await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15000 }); };
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const c = await hub.store.createConversation("owner", ["alpha"], "Crash loop", "create");
    const owed = await recordDeliveryObligation(stateDir, { channel: "lark", chatId: c.id, content: "Unsent answer survives the restart loop", conversationKey: `lark:${c.id}` });
    expect(owed).not.toBeNull();
    // The test seeded the prior process's obligation, so give it a dead owner.
    await writeFile(path.join(stateDir, "delivery-obligations.json"), JSON.stringify({ obligations: (await readDeliveryObligations(stateDir)).map((row) => ({ ...row, ownerPid: 99_999_999 })) }));
    await writeFile(path.join(stateDir, "gateway-outbox.json"), JSON.stringify({ requests: [{ v: 1, type: "instance.request", id: "old_publication", method: "publish", params: { id: "journal_keep", conversationId: c.id, status: "complete", version: 1, blocks: [{ type: "text", text: "Committed journal survives the guard" }] } }] }));
    for (let attempt = 0; attempt < 3; attempt++) {
      start();
      await vi.waitFor(() => expect(fixture!.child.exitCode !== null || fixture!.child.signalCode !== null, fixture!.output()).toBe(true), { timeout: 15000 });
      expect(await fixture!.exited).toEqual(mode === "kill" ? { code: null, signal: "SIGKILL" } : { code: 1, signal: null });
      expect(fixture!.messages).toContain("maintenance"); expect(fixture!.messages).not.toContain("boot-complete");
      if (mode === "throw") await expect(readFile(path.join(stateDir, "instance.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    start(); await boot();
    expect(fixture!.messages).not.toContain("maintenance");
    expect(await isRestartLoopTripped(stateDir)).toMatchObject({ tripped: true, recentBoots: expect.any(Array) });
    expect((await isRestartLoopTripped(stateDir)).recentBoots).toHaveLength(3);
    expect(fixture!.output()).toContain("已暂缓本次启动恢复");
    expect(await readFile(path.join(stateDir, "audit.log.jsonl"), "utf8")).toContain('"recoverySkipped":true');
    expect(await readFile(path.join(stateDir, "service.lifecycle.log.jsonl"), "utf8")).toContain('"uncleanBoots":3');
    expect((await readDeliveryObligations(stateDir)).find((row) => row.id === owed)).toMatchObject({ state: "pending", attempts: 0 });
    await vi.waitFor(async () => expect((await hub.store.snapshot("owner", c.id)).messages.map((m) => blocksText(m.blocks))).toEqual(["Committed journal survives the guard"]));
    await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "fresh", text: "/help", attachments: [] });
    await vi.waitFor(async () => expect((await hub.store.snapshot("owner", c.id)).messages.some((m) => m.authorType === "bot" && blocksText(m.blocks).includes("/config")), fixture!.output()).toBe(true), { timeout: 10000 });
    await vi.waitFor(async () => expect(await hub.store.pendingForBot("alpha")).toHaveLength(0));
    fixture!.child.send({ type: "restart.whenIdle" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(75), { timeout: 10000 });
    expect((await isRestartLoopTripped(stateDir)).recentBoots).toEqual([]);
    await expect(readFile(path.join(stateDir, "instance.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    fixture = gatewayRestartFixture({ ...options, mode: "normal" }, path.join(root, "home")); await boot();
    expect(fixture.messages).toContain("maintenance");
    expect((await readDeliveryObligations(stateDir)).find((row) => row.id === owed)?.state).toBe("delivered");
    expect((await hub.store.snapshot("owner", c.id)).messages.filter((m) => blocksText(m.blocks).includes("Unsent answer survives"))).toHaveLength(1);
  } finally { await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 60000);

it("cleanup failures count as fatal exits while still closing the channel and releasing the lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-cleanup-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    await recordUncleanBootAndCheck(stateDir); await recordUncleanBootAndCheck(stateDir);
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "cleanup" }, path.join(root, "home"));
    await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15000 });
    expect((await isRestartLoopTripped(stateDir)).recentBoots).toHaveLength(2);
    fixture.child.send({ type: "restart.whenIdle" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(1), { timeout: 10000 });
    expect((await isRestartLoopTripped(stateDir)).recentBoots).toHaveLength(3);
    expect((await isRestartLoopTripped(stateDir)).tripped).toBe(true);
    await expect(readFile(path.join(stateDir, "instance.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(0));
    expect(await readFile(path.join(stateDir, "service.lifecycle.log.jsonl"), "utf8")).toContain("synthetic_cleanup_failure");
  } finally { await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);

it("the production worker reports recovery warnings to stderr without exposing request secrets or error payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-warning-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const sensitiveFailure = "private_sweep_payload_do_not_log";
  // HubError crosses the actual RPC boundary unchanged, so this verifies the
  // worker's logging boundary rather than relying on Hub error sanitization.
  const sweep = vi.spyOn(hub.store, "recoverOrphanRuns").mockRejectedValueOnce(new HubError(sensitiveFailure, 503));
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const c = await hub.store.createConversation("owner", ["alpha"], "Warnings", "create");
    await writeFile(path.join(stateDir, "delivery-obligations.json"), JSON.stringify({ obligations: [{ id: "saved_answer", channel: "lark", chatId: c.id, content: "Saved answer survives an unavailable sweep", state: "attempting", attempts: 0, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000, ownerPid: 99_999_999 }] }));
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "normal" }, path.join(root, "home"));
    await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15000 });
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(fixture.stderr()).toContain("gateway_run_recovery_failed\n");
    expect(fixture.stderr()).not.toContain(secret); expect(fixture.stderr()).not.toContain(sensitiveFailure);
    expect((await readDeliveryObligations(stateDir))[0]).toMatchObject({ state: "delivered", attempts: 1 });
    expect((await hub.store.snapshot("owner", c.id)).messages.map(message => blocksText(message.blocks)).join("\n")).toContain("Saved answer survives an unavailable sweep");
    await hub.close();
    await vi.waitFor(() => expect(fixture!.stderr()).toContain("gateway_connection_failed\n"), { timeout: 5000 });
    expect(fixture.stderr()).not.toContain(secret); expect(fixture.stderr()).not.toContain(sensitiveFailure);
    fixture.child.send({ type: "shutdown.now" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(0), { timeout: 10000 });
  } finally { await fixture?.kill(); sweep.mockRestore(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
