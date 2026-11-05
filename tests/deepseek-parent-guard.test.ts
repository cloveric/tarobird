import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deepseekParentGuardEnvironment } from "../src/codex/deepseek-parent-guard.js";

describe("DSH parent lifetime", () => {
  it.each([false, true])("ends an orphaned real process, including one ignoring SIGTERM=%s", async (ignoreTerm) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-parent-"));
    const receipt = path.join(root, "child.json");
    const env = deepseekParentGuardEnvironment({ ...process.env, NODE_OPTIONS: "--no-warnings" });
    // A real intermediate parent supplies its own PID, then is killed without
    // any cleanup callback. The guarded child reports only test-local state.
    const childCode = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, marker: process.env.TAROCUB_DSH_PARENT_PID ?? null })); ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} setInterval(() => {}, 1000);`;
    const parentCode = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', env: { ...process.env, TAROCUB_DSH_PARENT_PID: String(process.pid) } }); setInterval(() => {}, 1000);`;
    // The parent itself must not be guarded; only its child gets NODE_OPTIONS.
    const parent = spawn(process.execPath, ["-e", parentCode], { env: { ...env, TAROCUB_DSH_PARENT_PID: "" }, stdio: "ignore" });
    let pid: number | undefined;
    const alive = () => { try { if (pid) process.kill(pid, 0); return !!pid; } catch { return false; } };
    try {
      await vi.waitFor(async () => { expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ marker: null }); }, { timeout: 5000 });
      pid = JSON.parse(await readFile(receipt, "utf8")).pid;
      expect(alive()).toBe(true);
      const exited = once(parent, "exit"); parent.kill("SIGKILL"); await exited;
      await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5000 });
    } finally {
      parent.kill("SIGKILL");
      if (alive()) process.kill(pid!, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
