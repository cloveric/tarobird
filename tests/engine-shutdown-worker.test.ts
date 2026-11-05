// Not a gateway-* transport test: it intentionally runs local stand-in engine
// processes (node, sleep, pgrep, ps) to verify process-tree cleanup at exit.
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it.skipIf(process.platform === "win32")("a stopping worker finishes engine tree termination before it exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-engine-shutdown-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await mkdir(path.join(root, "home"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
  const secret = randomBytes(32).toString("base64url"); await writeFile(path.join(stateDir, "gateway.key"), secret, { mode: 0o600 });
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const pids: number[] = [];
  const child = fork(fileURLToPath(new URL("./fixtures/engine-shutdown-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(root, "home"), TAROBOT_ENGINE_SHUTDOWN_FIXTURE: JSON.stringify({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance" }) },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const boot = await new Promise<{ engine: number; tool: number }>((resolve, reject) => {
      child.on("message", (value: unknown) => { const message = value as { type?: string; engine?: number; tool?: number }; if (message?.type === "boot-complete") resolve({ engine: message.engine!, tool: message.tool! }); });
      child.once("exit", () => reject(new Error("worker exited before boot")));
    });
    pids.push(boot.engine, boot.tool);
    expect(alive(boot.engine) && alive(boot.tool)).toBe(true);
    child.send({ type: "shutdown.now" });
    expect(await exited).toBe(0);
    // Escalation was delivered before exit; allow only for reaping by init.
    await vi.waitFor(() => { expect(alive(boot.tool)).toBe(false); expect(alive(boot.engine)).toBe(false); }, { timeout: 1_000, interval: 50 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await hub.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
