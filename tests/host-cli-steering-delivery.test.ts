import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { startHubControl } from "../src/hub/service.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { EngineSteeringRejectedError } from "../src/codex/adapter.js";
import { spawn } from "node:child_process";

let root: string, hub: HubServer, chat: string, control: () => Promise<void>, gateway: Awaited<ReturnType<typeof attachGateway>>;
let runtime: ReturnType<typeof createCoreServiceRuntime>, exitCode: typeof process.exitCode;
let log: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>;
const steer = vi.fn(async () => true);
beforeEach(async () => {
  exitCode = process.exitCode; process.exitCode = 0; steer.mockReset(); steer.mockResolvedValue(true);
  root = await mkdtemp(path.join(os.tmpdir(), "steer-cli-")); await initializeHost(root, "Steer test");
  const stateDir = path.join(root, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }));
  hub = await HubServer.start({ stateDir: root }); const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot',?)", [hashSecret(secret)]);
  chat = (await hub.store.createConversation("owner", ["bot"], "Steering", "direct")).id;
  runtime = createCoreServiceRuntime(); runtime.activeRuns.set(buildCoreConversationKey(chat), { abortController: new AbortController() });
  gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex", runtime,
    bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }), supportsSteering: () => true, steerActiveTurn: steer } });
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
  log = vi.spyOn(console, "log").mockImplementation(() => {}); error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.exitCode = exitCode; vi.restoreAllMocks(); await control?.(); await gateway?.disconnect(); await hub?.close(); await rm(root, { recursive: true, force: true });
});
async function cli(...args: string[]) {
  await runHostCli(["steer", ...args, "--state-dir", root, "--json"]);
  return JSON.parse(log.mock.calls.at(-1)![0] as string);
}
async function target() { return (await cli("status", chat, "--bot", "bot")).targetId as string; }
function send(id: string) { return cli("send", chat, "--bot", "bot", "--target", id, "--text", "Check the report", "--request-id", "stable-input"); }

it("exits nonzero for an expired target, preserves the JSON receipt and never queues or retargets it", async () => {
  const old = await target(); runtime.activeRuns.set(buildCoreConversationKey(chat), { abortController: new AbortController() });
  const receipt = await send(old);
  expect(receipt.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "rejected", reason: "stale" }));
  expect(process.exitCode).toBe(1);
  expect(error.mock.calls.flat().join("\n")).toContain("未投递");
  expect(await send(old)).toEqual(receipt);
  expect(steer).not.toHaveBeenCalled(); expect(await hub.store.pendingForBot("bot")).toEqual([]);
});

it("reports uncertainty without retrying the native side effect or admitting a new task", async () => {
  const id = await target(); steer.mockRejectedValue(new Error("reply lost"));
  const first = await send(id);
  expect(first.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "unknown" }));
  expect(process.exitCode).toBe(1);
  expect(error.mock.calls.flat().join("\n")).toContain("原编号");
  await send(id);
  expect(steer).toHaveBeenCalledTimes(1); expect(await hub.store.pendingForBot("bot")).toEqual([]);
});

it("distinguishes native refusal from accepted admission and keeps status queries successful", async () => {
  const id = await target(); expect(process.exitCode).toBe(0);
  steer.mockRejectedValue(new EngineSteeringRejectedError("not_ready"));
  expect((await send(id)).blocks).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "not_ready" }));
  expect(process.exitCode).toBe(1);
  process.exitCode = 0; steer.mockResolvedValue(true);
  const accepted = await cli("send", chat, "--bot", "bot", "--target", id, "--text", "New authorized input", "--request-id", "accepted-input");
  expect(accepted.blocks).toContainEqual(expect.objectContaining({ outcome: "accepted" }));
  expect(process.exitCode).toBe(0); expect(steer).toHaveBeenCalledTimes(2);
});

it.each(["applied", "absorbed", "dropped"] as const)("checks persisted %s adoption after initial admission without sending twice", async status => {
  const id = await target(); const first = await send(id); expect(process.exitCode).toBe(0);
  await hub.store.applySteeringOutcome("bot", { conversationId: chat, userId: "owner", requestId: "stable-input", targetId: id,
    application: status === "applied" ? { status, via: "fold" } : status === "dropped" ? { status, reason: "turn_failed" } : { status } });
  const replay = await send(id); expect(replay.id).toBe(first.id);
  expect(process.exitCode).toBe(status === "dropped" ? 1 : 0); expect(steer).toHaveBeenCalledTimes(1);
});

it.each(["unknown", "dropped", "cancelled", "received"] as const)("reports stored native %s evidence instead of the earlier accepted receipt", async state => {
  const id = await target();
  const input = { conversationId: chat, userId: "owner", requestId: "stable-input", botId: "bot", targetId: id, text: "Check the report", mode: "message" as const };
  const record = await hub.store.beginSteering("owner", input);
  await hub.store.finishSteering(record.id, { outcome: "accepted" });
  await hub.store.applyNativeInputProgress("bot", { conversationId: chat, userId: "owner", requestId: input.requestId, targetId: id, progress: { state } });
  const replay = await cli("send", chat, "--bot", "bot", "--target", id, "--text", input.text, "--mode", "message", "--request-id", input.requestId);
  expect(replay.id).toBe(record.id); expect(process.exitCode).toBe(state === "received" ? 0 : 1);
  expect(steer).not.toHaveBeenCalled(); expect(await hub.store.pendingForBot("bot")).toEqual([]);
});

it("the actual CLI process exits with failure while retaining a machine-readable rejected receipt", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "steer", "send", chat, "--state-dir", root, "--bot", "bot", "--target", "expired", "--text", "A scoped follow-up", "--request-id", "process-test", "--json"], { cwd: process.cwd(), timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect(code).toBe(1); expect(JSON.parse(stdout).blocks).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "stale" }));
  expect(stderr).toContain("未投递"); expect(await hub.store.pendingForBot("bot")).toEqual([]);
}, 15_000);
