import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FileTurnPool, resolveDefaultTurnPoolPath } from "../src/runtime/turn-pool.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it.skipIf(process.platform === "win32")("rejects a FIFO pool without waiting for a writer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "turn-pool-fifo-")), poolPath = path.join(root, "pool.json");
  try {
    execFileSync("mkfifo", [poolPath]);
    const source = new URL("../src/runtime/turn-pool.ts", import.meta.url).href;
    // Bound the child as well: an old blocking open must fail this test without
    // leaving the test runner's own filesystem thread stuck in that syscall.
    const script = `import { FileTurnPool } from ${JSON.stringify(source)};
      let entered = false;
      try { await new FileTurnPool({ maxActive: 1, poolPath: ${JSON.stringify(poolPath)} }).run(async () => { entered = true; }); }
      catch (error) { console.log(JSON.stringify({ code: error.code, entered })); }`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 3_000 });
    expect(JSON.parse(stdout)).toEqual({ code: "turn_pool_location_unsafe", entered: false });
    expect((await lstat(poolPath)).isFIFO()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

describe("turn pool telemetry", () => {
  it("records active and waiting pool metrics without changing queue semantics", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-"));
    const telemetry = {
      recordMetric: vi.fn(async () => undefined),
    };
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 5,
      telemetry,
      telemetryTags: { channel: "lark", instanceName: "ccfcc1" },
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      }, { metadata: { conversationKey: "lark:one" } });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      const second = pool.run(async () => "second", {
        waitNotifyAfterMs: 0,
        metadata: { conversationKey: "lark:two" },
      });
      await vi.waitFor(() => {
        expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 1, expect.objectContaining({
          channel: "lark",
          instanceName: "ccfcc1",
          conversationKey: "lark:two",
        }));
      });

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_active", 1, expect.objectContaining({
        conversationKey: "lark:one",
      }));
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_active", 0, expect.objectContaining({
        conversationKey: "lark:two",
      }));
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("clears the pool_waiting gauge when a queued turn is aborted", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-abort-"));
    const telemetry = { recordMetric: vi.fn(async () => undefined) };
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 5,
      telemetry,
      telemetryTags: { channel: "lark", instanceName: "ccfcc1" },
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted = false;
    const ac = new AbortController();

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      }, { metadata: { conversationKey: "lark:one" } });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      // Second queues behind the held first (pool_waiting=1), then is aborted.
      const second = pool.run(async () => "second", {
        signal: ac.signal,
        waitNotifyAfterMs: 0,
        metadata: { conversationKey: "lark:two" },
      });
      await vi.waitFor(() => {
        expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 1, expect.objectContaining({
          conversationKey: "lark:two",
        }));
      });

      ac.abort();
      await expect(second).rejects.toThrow();
      // The gauge must be cleared back to 0 — not left stuck at 1.
      expect(telemetry.recordMetric).toHaveBeenCalledWith("pool_waiting", 0, expect.objectContaining({
        conversationKey: "lark:two",
      }));

      releaseFirst();
      await expect(first).resolves.toBe("first");
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps a long-running lease alive via heartbeat so the concurrency cap holds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-hb-"));
    // staleLeaseMs is short; without a heartbeat the still-running first lease
    // would be judged stale after 120ms and the cap would be breached.
    const pool = new FileTurnPool({
      maxActive: 1,
      poolPath: path.join(stateDir, "pool.json"),
      pollIntervalMs: 10,
      staleLeaseMs: 120,
      heartbeatIntervalMs: 25,
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let secondStarted = false;

    try {
      const first = pool.run(async () => {
        firstStarted = true;
        await firstCanFinish;
        return "first";
      });
      await vi.waitFor(() => expect(firstStarted).toBe(true));

      // Hold well past staleLeaseMs — the heartbeat must keep the lease fresh.
      await new Promise((resolve) => setTimeout(resolve, 350));

      const second = pool.run(async () => {
        secondStarted = true;
        return "second";
      });
      // Window in which a wrongly-evicted lease would let the second turn start.
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(secondStarted).toBe(false);

      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(secondStarted).toBe(true);
    } finally {
      releaseFirst?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

const isWindows = process.platform === "win32";

function liveLease(id = "held-elsewhere"): Record<string, unknown> {
  const now = new Date().toISOString();
  return { id, pid: process.pid, acquiredAt: now, updatedAt: now, channel: "lark", instanceName: "other" };
}

async function tempFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

describe("turn pool state integrity", () => {
  it.each([
    ["a truncated write", '{\n  "leases": [\n    {\n      "id": "x'],
    ["an empty file", ""],
    ["a non-array leases field", JSON.stringify({ leases: { held: liveLease() } })],
    ["a missing leases field", JSON.stringify({})],
    ["a lease with a string pid", JSON.stringify({ leases: [{ ...liveLease(), pid: String(process.pid) }] })],
    ["a lease with a non-positive pid", JSON.stringify({ leases: [{ ...liveLease(), pid: 0 }] })],
    ["a lease with an unparseable heartbeat", JSON.stringify({ leases: [{ ...liveLease(), updatedAt: "soon" }] })],
  ])("fails closed on %s and preserves the file as evidence", async (_label, contents) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-corrupt-"));
    const poolPath = path.join(stateDir, "pool.json");
    await writeFile(poolPath, contents, "utf8");
    const task = vi.fn(async () => "ran");
    const pool = new FileTurnPool({ maxActive: 4, poolPath, pollIntervalMs: 5 });

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(pool.run(task)).rejects.toMatchObject({
          name: "TurnPoolStateError",
          code: "turn_pool_state_invalid",
          targetPath: poolPath,
          message: expect.stringContaining("stop every service that shares this pool"),
        });
      }
      expect(task).not.toHaveBeenCalled();
      await expect(readFile(poolPath, "utf8")).resolves.toBe(contents);
      await expect(tempFiles(stateDir)).resolves.toEqual([]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("still counts leases written by earlier versions of the pool file", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-legacy-"));
    const poolPath = path.join(stateDir, "pool.json");
    // Exact pre-fix on-disk format: pretty JSON written in place.
    await writeFile(poolPath, JSON.stringify({ leases: [liveLease()] }, null, 2) + "\n", "utf8");
    const pool = new FileTurnPool({ maxActive: 1, poolPath, pollIntervalMs: 5 });
    const controller = new AbortController();
    const onWait = vi.fn();
    const task = vi.fn(async () => "ran");

    try {
      const waiting = pool.run(task, { signal: controller.signal, waitNotifyAfterMs: 0, onWait });
      await vi.waitFor(() => expect(onWait).toHaveBeenCalledWith(expect.objectContaining({ activeCount: 1, maxActive: 1 })));
      controller.abort();
      await expect(waiting).rejects.toThrow("turn pool wait aborted");
      expect(task).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(poolPath, "utf8"))).toEqual({
        leases: [expect.objectContaining({ id: "held-elsewhere", pid: process.pid })],
      });
    } finally {
      controller.abort();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replaces the pool file atomically with private permissions and no temporary leftovers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-atomic-"));
    const poolPath = path.join(stateDir, "pool.json");
    await writeFile(poolPath, JSON.stringify({ leases: [] }), "utf8");
    const before = await stat(poolPath);
    const pool = new FileTurnPool({ maxActive: 1, poolPath, pollIntervalMs: 5 });
    let duringTask: unknown;

    try {
      await expect(pool.run(async () => {
        duringTask = JSON.parse(await readFile(poolPath, "utf8"));
        return "ran";
      })).resolves.toBe("ran");

      expect(duringTask).toEqual({ leases: [expect.objectContaining({ pid: process.pid })] });
      expect(JSON.parse(await readFile(poolPath, "utf8"))).toEqual({ leases: [] });
      await expect(tempFiles(stateDir)).resolves.toEqual([]);
      if (!isWindows) {
        const after = await stat(poolPath);
        // A rename-based replace gives a new inode; an in-place rewrite keeps the old one.
        expect(after.ino).not.toBe(before.ino);
        expect(after.mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("refuses a symlinked pool file without writing through it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-link-"));
    const poolPath = path.join(stateDir, "pool.json");
    const victim = path.join(stateDir, "victim-settings.json");
    await writeFile(victim, JSON.stringify({ important: true }), "utf8");
    await symlink(victim, poolPath);
    const task = vi.fn(async () => "ran");

    try {
      await expect(new FileTurnPool({ maxActive: 1, poolPath, pollIntervalMs: 5 }).run(task)).rejects.toMatchObject({
        name: "TurnPoolStateError",
        code: "turn_pool_location_unsafe",
      });
      expect(task).not.toHaveBeenCalled();
      await expect(readFile(victim, "utf8")).resolves.toBe(JSON.stringify({ important: true }));
      expect((await lstat(poolPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(isWindows)("default turn pool location in a shared temporary directory", () => {
  async function withSharedTmp(run: (sharedTmp: string, poolPath: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-turn-pool-tmp-"));
    const sharedTmp = path.join(root, "shared-tmp");
    await mkdir(sharedTmp);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = sharedTmp;
    try {
      const poolPath = resolveDefaultTurnPoolPath();
      expect(poolPath).toBe(path.join(sharedTmp, "tarocub-turn-pool", "turns.json"));
      await run(sharedTmp, poolPath);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  }

  it("keeps the historical path and creates it as a private directory", async () => {
    await withSharedTmp(async (_sharedTmp, poolPath) => {
      await expect(new FileTurnPool({ maxActive: 1, pollIntervalMs: 5 }).run(async () => "ran")).resolves.toBe("ran");
      expect((await stat(path.dirname(poolPath))).mode & 0o777).toBe(0o700);
      expect((await stat(poolPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("refuses a pre-created directory that other users can write", async () => {
    await withSharedTmp(async (_sharedTmp, poolPath) => {
      await mkdir(path.dirname(poolPath));
      await chmod(path.dirname(poolPath), 0o777);
      const task = vi.fn(async () => "ran");
      await expect(new FileTurnPool({ maxActive: 1, pollIntervalMs: 5 }).run(task)).rejects.toMatchObject({
        name: "TurnPoolStateError",
        code: "turn_pool_location_unsafe",
        message: expect.stringContaining("mode 777"),
      });
      expect(task).not.toHaveBeenCalled();
      expect((await stat(path.dirname(poolPath))).mode & 0o777).toBe(0o777);
      expect(await readdir(path.dirname(poolPath))).toEqual([]);
    });
  });

  it("refuses a pre-created directory owned by another user", async () => {
    await withSharedTmp(async (_sharedTmp, poolPath) => {
      await mkdir(path.dirname(poolPath), { mode: 0o700 });
      const ownUid = process.getuid!();
      vi.spyOn(process, "getuid").mockReturnValue(ownUid + 1);
      const task = vi.fn(async () => "ran");
      await expect(new FileTurnPool({ maxActive: 1, pollIntervalMs: 5 }).run(task)).rejects.toMatchObject({
        code: "turn_pool_location_unsafe",
        message: expect.stringContaining(`owned by uid ${ownUid}`),
      });
      expect(task).not.toHaveBeenCalled();
    });
  });

  it("refuses a symlinked pool directory", async () => {
    await withSharedTmp(async (sharedTmp, poolPath) => {
      const elsewhere = path.join(sharedTmp, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await symlink(elsewhere, path.dirname(poolPath));
      const task = vi.fn(async () => "ran");
      await expect(new FileTurnPool({ maxActive: 1, pollIntervalMs: 5 }).run(task)).rejects.toMatchObject({
        code: "turn_pool_location_unsafe",
        message: expect.stringContaining("not a real directory"),
      });
      expect(task).not.toHaveBeenCalled();
      expect(await readdir(elsewhere)).toEqual([]);
    });
  });
});
