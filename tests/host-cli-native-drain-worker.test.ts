import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";

it("the actual worker retains native tasks, review and delivery through graceful drain commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-native-drain-")), stateDir = path.join(root, "alpha"), home = path.join(root, "home");
  for (const directory of [stateDir, home]) await mkdir(directory);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "en" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let child: ReturnType<typeof fork> | undefined, exit: Promise<unknown> | undefined, output = "";
  const messages: Array<Record<string, any>> = [];
  const received = async (type: string) => vi.waitFor(() => expect(messages.some(value => value.type === type), output).toBe(true), { timeout: 15_000, interval: 10 });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    child = fork(fileURLToPath(new URL("./fixtures/gateway-native-drain.ts", import.meta.url)), [], {
      execArgv: ["--require", fileURLToPath(new URL("./helpers/gateway-no-feishu.cjs", import.meta.url)), "--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, TAROBOT_GATEWAY_GUARD_REPORT: process.env.TAROBOT_GATEWAY_GUARD_REPORT,
        TAROBOT_NATIVE_DRAIN_FIXTURE: JSON.stringify({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance" }) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    exit = new Promise(resolve => child!.once("exit", (code, signal) => resolve({ code, signal })));
    child.on("message", value => messages.push(value as Record<string, any>));
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { output = (output + chunk.toString()).slice(-5000); });
    await received("fixture.foreground-finished");
    expect(messages.find(value => value.type === "fixture.foreground-finished")!.tasks.tasks).toContainEqual(expect.objectContaining({ mode: "background", status: "running" }));
    child.send({ type: "drain.whenIdle", requestId: "native_drain" }); await received("restart.queued");
    const checkBusy = async (stage: string) => {
      child!.send({ type: "drain.status", requestId: stage, drainId: "native_drain" });
      await vi.waitFor(() => expect(messages.find(value => value.requestId === stage)).toMatchObject({ idle: false, blockers: expect.arrayContaining([expect.objectContaining({ botId: "alpha", type: "worker", count: 1 })]) }));
      expect(child!.exitCode).toBeNull();
    };
    await checkBusy("running");
    // Even an already-sent commit cannot bypass the worker's current idle read.
    child.send({ type: "drain.commit", drainId: "native_drain" });
    await new Promise(resolve => setTimeout(resolve, 350)); expect(child.exitCode, output).toBeNull();
    child.send({ type: "fixture.task-finished" }); await received("fixture.review-started"); await checkBusy("review");
    child.send({ type: "fixture.review-finished" }); await received("fixture.delivery"); await checkBusy("delivery");
    expect(messages.filter(value => value.type === "fixture.delivery").some(value => value.reason === "engine_exit")).toBe(false);
    child.send({ type: "fixture.delivery-finished" });
    await vi.waitFor(() => expect(child!.exitCode, output).toBe(75), { timeout: 5000 });
  } finally {
    if (child?.connected) child.send({ type: "fixture.delivery-finished" });
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit; await hub.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
