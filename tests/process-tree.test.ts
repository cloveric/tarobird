import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { killProcessTree, settleProcessTreeKills } from "../src/codex/process-tree.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("killProcessTree", () => {
  it("sends SIGTERM first and SIGKILL after the grace period on unix", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const identities = new Map<number, string>([
      [100, "p100"],
      [200, "p200"],
      [201, "p201"],
    ]);
    const execFileFn = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      const pid = Number(args[1]);
      if (command === "pgrep" && pid === 100) {
        callback(null, "200\n201\n");
        return undefined as never;
      }
      callback(null, "");
      return undefined as never;
    });
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
    });
    const readIdentityFn = vi.fn((pid: number, callback: (identity: string | null) => void) => {
      callback(identities.get(pid) ?? null);
    });

    const done = killProcessTree(100, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "linux",
      graceMs: 2_000,
      readIdentityFn,
    });
    const signals = () => kills.filter((kill) => kill.signal !== 0);

    await vi.advanceTimersByTimeAsync(0);
    expect(signals()).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 201, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    expect(signals()).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 201, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
      { pid: 200, signal: "SIGKILL" },
      { pid: 201, signal: "SIGKILL" },
      { pid: 100, signal: "SIGKILL" },
    ]);
    // Each escalation is preceded by a liveness check of that exact PID.
    expect(kills.slice(-6)).toEqual([
      { pid: 200, signal: 0 }, { pid: 200, signal: "SIGKILL" },
      { pid: 201, signal: 0 }, { pid: 201, signal: "SIGKILL" },
      { pid: 100, signal: 0 }, { pid: 100, signal: "SIGKILL" },
    ]);
  });

  it("uses taskkill on windows", () => {
    const execFileFn = vi.fn();
    const killFn = vi.fn();

    killProcessTree(123, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "win32",
    });

    expect(execFileFn).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "123"], { windowsHide: true, timeout: 3_000 }, expect.any(Function));
    expect(killFn).not.toHaveBeenCalled();
  });

  it("falls back to the owned root only if Windows tree termination fails", () => {
    const killFn = vi.fn();
    const execFileFn = vi.fn((_command, _args, _options, callback) => callback(new Error("taskkill failed")));
    killProcessTree(123, { execFileFn: execFileFn as never, killFn, platform: "win32" });
    expect(killFn).toHaveBeenCalledExactlyOnceWith(123, "SIGKILL");
  });

  it("skips SIGKILL when the pid identity changed during the grace period", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const execFileFn = vi.fn((command: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      callback(null, "");
      return undefined as never;
    });
    let identity = "original";
    const readIdentityFn = vi.fn((_pid: number, callback: (identity: string | null) => void) => {
      callback(identity);
    });
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      kills.push({ pid, signal });
    });

    killProcessTree(123, {
      execFileFn: execFileFn as never,
      killFn,
      platform: "linux",
      graceMs: 2_000,
      readIdentityFn,
    });
    const signals = () => kills.filter((kill) => kill.signal !== 0);

    await vi.advanceTimersByTimeAsync(0);
    expect(signals()).toEqual([{ pid: 123, signal: "SIGTERM" }]);

    identity = "reused";
    await vi.advanceTimersByTimeAsync(2_000);

    expect(signals()).toEqual([{ pid: 123, signal: "SIGTERM" }]);
  });

  it("still signals the root and resolves within its bound when pgrep and ps never answer", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const hung = { kill: vi.fn() };
    const execFileFn = vi.fn(() => hung as never);
    let resolved = false;
    void killProcessTree(100, { execFileFn: execFileFn as never, killFn: (pid, signal) => { kills.push({ pid, signal }); }, platform: "linux", graceMs: 2_000 }).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(3_000);
    // The hung pgrep is abandoned (and its process killed); the root is still signalled.
    expect(hung.kill).toHaveBeenCalled();
    expect(kills.filter(kill => kill.signal !== 0)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(kills.filter(kill => kill.signal !== 0)).toEqual([{ pid: 100, signal: "SIGTERM" }]);
    await vi.advanceTimersByTimeAsync(2_000 + 5_000);
    expect(resolved).toBe(true);
  });

  it("sends no signal after its wait bound expired, even when a process tool answers late", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    let late: ((identity: string | null) => void) | undefined;
    const done = killProcessTree(100, {
      execFileFn: ((_command: string, _args: string[], callback: (error: Error | null, stdout: string) => void) => { callback(null, ""); return undefined as never; }) as never,
      killFn: (pid, signal) => { kills.push({ pid, signal }); },
      readIdentityFn: (_pid, callback) => { late = callback; },
      platform: "linux", graceMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100 + 5_000);
    await done;
    // The PID may belong to another process by now; the expired kill must stay silent.
    late!("start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kills).toEqual([]);
  });

  it("expires kills still pending when a settling process reaches its deadline", async () => {
    vi.useFakeTimers();
    const kills: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    let late: ((identity: string | null) => void) | undefined;
    void killProcessTree(100, {
      execFileFn: ((_command: string, _args: string[], callback: (error: Error | null, stdout: string) => void) => { callback(null, ""); return undefined as never; }) as never,
      killFn: (pid, signal) => { kills.push({ pid, signal }); },
      readIdentityFn: (_pid, callback) => { late = callback; },
      platform: "linux", graceMs: 2_000,
    });
    const settled = settleProcessTreeKills(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
    // The worker may now release its lock; this kill must never signal again.
    late!("start");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kills).toEqual([]);
  });

  it("reads each start time before sending any signal", async () => {
    const order: string[] = [];
    await killProcessTree(100, {
      execFileFn: ((_command: string, _args: string[], callback: (error: Error | null, stdout: string) => void) => { callback(null, ""); return undefined as never; }) as never,
      killFn: (pid, signal) => { if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" }); order.push(`${String(signal)}:${pid}`); },
      readIdentityFn: (pid, callback) => { order.push(`identity:${pid}`); callback("start"); },
      platform: "linux", graceMs: 20,
    });
    expect(order).toEqual(["identity:100", "SIGTERM:100"]);
  });

  it("lists every descendant before signalling the root, even when pgrep answers asynchronously", async () => {
    // 100 forwards SIGTERM to 200 and both exit; 300 is then re-parented and
    // `pgrep -P 200` no longer finds it. It must already have been listed.
    const tree = new Map<number, number[]>([[100, [200]], [200, [300]], [300, []]]);
    const signalled: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const gone = new Set<number>();
    const execFileFn = vi.fn((_command: string, args: string[], callback: (error: Error | null, stdout: string) => void) => {
      const pid = Number(args.at(-1));
      setImmediate(() => callback(null, gone.has(pid) ? "" : (tree.get(pid) ?? []).join("\n")));
      return undefined as never;
    });
    const killFn = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
      if (gone.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === 0) return;
      signalled.push({ pid, signal });
      if (pid === 100 && signal === "SIGTERM") { gone.add(100); gone.add(200); }
      if (signal === "SIGTERM" || signal === "SIGKILL") gone.add(pid);
    });
    await killProcessTree(100, { execFileFn: execFileFn as never, killFn, platform: "linux", graceMs: 50, readIdentityFn: (_pid, callback) => callback(null) });
    expect(signalled).toEqual([
      { pid: 300, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);
  });
});

const posix = process.platform !== "win32";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
  return check();
}
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout!.on("data", (chunk: Buffer) => { text += chunk.toString(); const end = text.indexOf("\n"); if (end >= 0) resolve(text.slice(0, end)); });
    child.once("exit", () => reject(new Error("fixture exited early")));
  });
}

describe.skipIf(!posix)("killProcessTree with real processes", () => {
  const leftovers: number[] = [];
  afterEach(() => { for (const pid of leftovers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });

  it("does not orphan a tool when the engine forwards SIGTERM to its shell and exits", async () => {
    // engine (node) -> shell (bash) -> tool (sleep). Reproduces a CLI that
    // forwards SIGTERM to its tool shell; the tool must not be re-parented alive.
    const engine = spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const shell = spawn("/bin/bash", ["-c", "sleep 300 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] });
      shell.stdout.once("data", (tool) => process.stdout.write(shell.pid + " " + String(tool).trim() + "\\n"));
      process.on("SIGTERM", () => { try { shell.kill("SIGTERM"); } catch {} process.exit(0); });
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    const [shell, tool] = (await firstLine(engine)).split(" ").map(Number) as [number, number];
    leftovers.push(engine.pid!, shell, tool);
    expect(alive(tool)).toBe(true);
    await killProcessTree(engine.pid, { graceMs: 300 });
    expect(await until(() => !alive(tool), 2_000)).toBe(true);
    expect(await until(() => !alive(engine.pid!), 1_000)).toBe(true);
  }, 15_000);

  it("delivers SIGKILL escalation to an engine ignoring SIGTERM before a settling process exits", async () => {
    const engine = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    await firstLine(engine); leftovers.push(engine.pid!);
    // Adapters fire and forget; the worker's exit path settles them.
    void killProcessTree(engine.pid, { graceMs: 1_000 });
    await settleProcessTreeKills(5_000);
    // Settling means escalation was already sent; only reaping may remain.
    expect(await until(() => !alive(engine.pid!), 300)).toBe(true);
  }, 15_000);

  it("resolves as soon as the tree is gone instead of waiting for the full grace period", async () => {
    const engine = spawn(process.execPath, ["-e", `process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    await firstLine(engine); leftovers.push(engine.pid!);
    const started = Date.now();
    await killProcessTree(engine.pid, { graceMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(alive(engine.pid!)).toBe(false);
  }, 15_000);
});
