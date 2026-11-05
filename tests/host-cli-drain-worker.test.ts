import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { delegateToInstance } from "../src/bus/bus-client.js";
import { gatewayRestartFixture } from "./helpers/gateway-restart-fixture.js";
import type { DrainBlocker } from "../src/gateway/control.js";

it("the actual worker keeps Bus continuations alive during prepare and only exits after fleet commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-drain-")), stateDir = path.join(root, "alpha"), caller = path.join(root, "caller"), home = path.join(root, "home");
  for (const directory of [stateDir, caller, home]) await mkdir(directory);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", bus: { peers: ["caller"], secret: randomBytes(32).toString("hex") } }));
  await writeFile(path.join(caller, "config.json"), JSON.stringify({ bus: { peers: ["alpha"], secret: randomBytes(32).toString("hex") } }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  const tasks: Array<ReturnType<typeof delegateToInstance>> = [];
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "drain" }, home);
    const replies: Array<{ type: string; requestId: string; idle?: boolean }> = [];
    fixture.child.on("message", value => replies.push(value as typeof replies[number]));
    await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15_000 });
    const input = { fromInstance: "caller", targetInstance: "alpha", depth: 0, stateDir: caller };
    tasks.push(delegateToInstance({ ...input, prompt: "existing task" }));
    await vi.waitFor(() => expect(fixture!.messages.filter(value => value === "fixture.turn")).toHaveLength(1));
    fixture.child.send({ type: "drain.whenIdle", requestId: "drain_test" });
    await vi.waitFor(() => expect(replies.some(value => value.type === "restart.queued" && value.requestId === "drain_test")).toBe(true));
    fixture.child.send({ type: "drain.status", requestId: "busy", drainId: "drain_test" });
    await vi.waitFor(() => expect(replies.find(value => value.requestId === "busy")).toMatchObject({ idle: false }));
    tasks.push(delegateToInstance({ ...input, prompt: "continuation from another active Bot" }));
    await vi.waitFor(() => expect(fixture!.messages.filter(value => value === "fixture.turn")).toHaveLength(2));
    fixture.child.send({ type: "fixture.release" });
    expect(await Promise.all(tasks)).toEqual([expect.objectContaining({ success: true, text: "finished" }), expect.objectContaining({ success: true, text: "finished" })]);
    fixture.child.send({ type: "drain.status", requestId: "idle", drainId: "drain_test" });
    await vi.waitFor(() => expect(replies.find(value => value.requestId === "idle")).toMatchObject({ idle: true }));
    await new Promise(resolve => setTimeout(resolve, 600)); expect(fixture.child.exitCode).toBeNull();
    fixture.child.send({ type: "drain.commit", drainId: "old_drain" });
    await new Promise(resolve => setTimeout(resolve, 350)); expect(fixture.child.exitCode).toBeNull();
    fixture.child.send({ type: "drain.commit", drainId: "drain_test" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(75), { timeout: 5000 });
  } finally { fixture?.child.connected && fixture.child.send({ type: "fixture.release" }); await Promise.allSettled(tasks); await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.each(["choice", "native-choice", "async-question", "approval"] as const)("the actual worker distinguishes durable choices from protected %s callbacks during drain", async interaction => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-drain-card-")), stateDir = path.join(root, "alpha"), home = path.join(root, "home");
  for (const directory of [stateDir, home]) await mkdir(directory);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let fixture: ReturnType<typeof gatewayRestartFixture> | undefined;
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    fixture = gatewayRestartFixture({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", mode: "drain-interactions", interaction }, home);
    const replies: Array<{ type: string; requestId: string; idle?: boolean; blockers?: DrainBlocker[] }> = [];
    fixture.child.on("message", value => replies.push(value as typeof replies[number]));
    await vi.waitFor(() => expect(fixture!.messages, fixture!.output()).toContain("boot-complete"), { timeout: 15_000 });
    fixture.child.send({ type: "drain.whenIdle", requestId: "drain_card" });
    await vi.waitFor(() => expect(replies.some(value => value.type === "restart.queued" && value.requestId === "drain_card")).toBe(true));
    fixture.child.send({ type: "drain.status", requestId: "interaction", drainId: "drain_card" });
    await vi.waitFor(() => expect(replies.find(value => value.requestId === "interaction")?.idle).toBe(interaction === "choice"));
    const reasons = replies.find(value => value.requestId === "interaction")!.blockers;
    if (interaction === "choice") expect(reasons).toEqual([]);
    else {
      expect(reasons).toContainEqual(expect.objectContaining({ botId: "alpha", type: interaction.replace("-", "_"), count: 1, ...(interaction === "native-choice" ? {} : { conversationKey: "lark:gw_card_conversation" }) }));
      fixture.child.send({ type: "drain.commit", drainId: "drain_card" });
      await new Promise(resolve => setTimeout(resolve, 350)); expect(fixture.child.exitCode).toBeNull();
      fixture.child.send({ type: "fixture.release-interaction" });
      await vi.waitFor(() => expect(fixture!.messages).toContain("fixture.interaction-released"));
    }
    fixture.child.send({ type: "drain.commit", drainId: "drain_card" });
    await vi.waitFor(() => expect(fixture!.child.exitCode, fixture!.output()).toBe(75), { timeout: 5000 });
  } finally { await fixture?.kill(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
