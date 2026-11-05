import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { withFileMutex } from "../src/state/file-mutex.js";
import { childProcessTestEnv, removeTempRoot } from "./helpers/temp-files.js";

it("bounds in-process waits without entering timed-out work or bypassing the owner", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-timeout-")), target = path.join(dir, "state.json");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const owner = withFileMutex(target, async () => { entered(); await held; calls.push("owner"); });
  try {
    await ready;
    await expect(withFileMutex(target, async () => { calls.push("expired"); }, { waitTimeoutMs: 20 })).rejects.toMatchObject({ name: "FileMutexTimeoutError" });
    const next = withFileMutex(target, async () => { calls.push("next"); });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toEqual([]);
    release(); await Promise.all([owner, next]); expect(calls).toEqual(["owner", "next"]);
  } finally { release(); await owner; await rm(dir, { recursive: true, force: true }); }
});

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcImportUrl = (rel: string): string => pathToFileURL(path.join(repoRoot, rel)).href;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawns a short-lived child and waits for it to exit, yielding a known-dead pid. */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("failed to spawn child for dead pid");
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

async function seedLock(lockPath: string, owner: Record<string, unknown>): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf8");
}

function runMutexSubprocess(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, scriptPath, ...args], {
      cwd: repoRoot,
      env: childProcessTestEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mutex subprocess exited with ${code}: ${stderr}`));
      }
    });
  });
}

describe("withFileMutex stale-lock recovery", () => {
  it("keeps mutual exclusion when two processes race to recover the same stale lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const logPath = path.join(dir, "sections.log");
    const scriptPath = path.join(dir, "hold-mutex.ts");
    try {
      const deadPid = await spawnDeadPid();
      await seedLock(`${targetPath}.lock`, {
        pid: deadPid,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        token: "stale-owner-token",
        host: os.hostname(),
      });

      await writeFile(scriptPath, [
        `import { withFileMutex } from '${srcImportUrl("src/state/file-mutex.ts")}';`,
        "import { appendFile } from 'node:fs/promises';",
        "(async () => {",
        "  const [target, log, label] = process.argv.slice(2);",
        "  await withFileMutex(target, async () => {",
        "    await appendFile(log, `start ${label}\\n`);",
        "    await new Promise((resolve) => setTimeout(resolve, 300));",
        "    await appendFile(log, `end ${label}\\n`);",
        "  }, { staleLockMs: 100 });",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      await Promise.all([
        runMutexSubprocess(scriptPath, [targetPath, logPath, "a"]),
        runMutexSubprocess(scriptPath, [targetPath, logPath, "b"]),
      ]);

      const events = (await readFile(logPath, "utf8")).trim().split("\n");
      expect(events).toHaveLength(4);
      // Critical sections must never overlap: strict start/end alternation.
      expect(events[0]).toMatch(/^start /);
      expect(events[1]).toMatch(/^end /);
      expect(events[2]).toMatch(/^start /);
      expect(events[3]).toMatch(/^end /);
      expect(events[0]?.slice(6)).toBe(events[1]?.slice(4));
      expect(events[2]?.slice(6)).toBe(events[3]?.slice(4));
    } finally {
      await removeTempRoot(dir);
    }
  }, 60_000);

  it("never age-steals a live legacy owner even with staleLockMs zero", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const lockPath = `${targetPath}.lock`;
    try {
      // A clock change, sleep or long task cannot authorize a second writer.
      await seedLock(lockPath, {
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 365 * 86400_000).toISOString(),
        token: "live-owner-token",
        host: os.hostname(),
      });

      let entered = false;
      const run = withFileMutex(targetPath, async () => {
        entered = true;
      }, { staleLockMs: 0 });

      await sleep(150);
      expect(entered).toBe(false);

      // Owner releases; the waiter must then proceed.
      await rm(path.join(lockPath, "owner.json"));
      await run;
      expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);

  it("recovers a dead owner's lock promptly regardless of age", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    try {
      const deadPid = await spawnDeadPid();
      await seedLock(`${targetPath}.lock`, {
        pid: deadPid,
        acquiredAt: new Date().toISOString(),
        token: "dead-owner-token",
        host: os.hostname(),
      });

      let entered = false;
      await withFileMutex(targetPath, async () => {
        entered = true;
      }, { staleLockMs: 5_000 });
      expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);

  it("keeps six concurrent writers exclusive while publishing and releasing 360 tickets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    const scriptPath = path.join(dir, "hammer-mutex.ts");
    try {
      await writeFile(scriptPath, [
        `import { withFileMutex } from '${srcImportUrl("src/state/file-mutex.ts")}';`,
        "import { open, rm } from 'node:fs/promises';",
        "(async () => {",
        "  const [target, iters] = process.argv.slice(2);",
        "  for (let i = 0; i < Number(iters); i += 1) {",
        "    await withFileMutex(target, async () => {",
        "      const sentinel = await open(target + '.critical', 'wx');",
        "      await new Promise(resolve => setTimeout(resolve, 1));",
        "      await sentinel.close(); await rm(target + '.critical');",
        "    }, { staleLockMs: 0 });",
        "  }",
        "})().catch((error) => { console.error(error); process.exit(1); });",
      ].join("\n"), "utf8");

      // Exclusive-create fails immediately if any critical sections overlap.
      await Promise.all(
        Array.from({ length: 6 }, () => runMutexSubprocess(scriptPath, [targetPath, "60"])),
      );
    } finally {
      await removeTempRoot(dir);
    }
  }, 60_000);

  it("never steals an unverifiable foreign-host owner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
    const targetPath = path.join(dir, "state.json");
    try {
      await seedLock(`${targetPath}.lock`, {
        pid: process.pid, // alive locally, but the record claims another host
        acquiredAt: new Date(Date.now() - 1_000).toISOString(),
        token: "other-host-token",
        host: "some-other-host.invalid",
      });

      let entered = false;
      const run = withFileMutex(targetPath, async () => { entered = true; }, { staleLockMs: 0 });
      await sleep(150); expect(entered).toBe(false);
      await rm(path.join(`${targetPath}.lock`, "owner.json"));
      await run; expect(entered).toBe(true);
    } finally {
      await removeTempRoot(dir);
    }
  }, 20_000);
});

const oldBoot = "darwin:11111111-1111-1111-1111-111111111111";
const currentBoot = "darwin:22222222-2222-2222-2222-222222222222";
async function seedTicket(lockPath: string, pid: number, epoch: string, number?: string, hostname = os.hostname()): Promise<string> {
  const host = createHash("sha256").update(hostname).digest("hex").slice(0, 16);
  const name = `ticket-v1.${pid}.${host}.${epoch ? Buffer.from(epoch).toString("base64url") : "-"}.${randomUUID()}`;
  const directory = path.join(lockPath, name);
  await mkdir(directory, { recursive: true });
  if (number) await writeFile(path.join(directory, "number"), number);
  return directory;
}

describe("file mutex ticket ownership", () => {
  it("refreshes a waiting ticket's process birth when its live PID is reused", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const guid = "33333333-3333-3333-3333-333333333333";
    let observations = 0, deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await seedTicket(`${target}.mutex.lock`, process.pid, `win32-machine:${guid}:123`, "1");
      await withFileMutex(target, async () => {}, {
        waitTimeoutMs: 2_000,
        readEpoch: async () => ({ machineId: `win32:${guid}`, processBirth: ++observations <= 2 ? "win32:123" : "win32:456" }),
        onWait: () => {
          clock.mockReturnValue(1_001);
          deadline = setTimeout(() => clock.mockReturnValue(2_001), 100);
        },
      });
      expect(observations).toBe(3);
      await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { clearTimeout(deadline); clock.mockRestore(); await removeTempRoot(dir); }
  });

  it("does not use a shared Linux boot UUID to reap another hostname's PID namespace", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    const bootId = "linux:22222222-2222-2222-2222-222222222222";
    try {
      const ticket = await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), bootId, "1", "container-host");
      await expect(withFileMutex(target, async () => { throw Error("entered"); }, { waitTimeoutMs: 20, readEpoch: async () => ({ bootId }) })).rejects.toMatchObject({ name: "FileMutexTimeoutError" });
      expect(await readFile(path.join(ticket, "number"), "utf8")).toBe("1");
    } finally { await removeTempRoot(dir); }
  });

  it("recovers a renamed Windows machine's dead ticket using its stable machine identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    const guid = "33333333-3333-3333-3333-333333333333";
    try {
      await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), `win32-machine:${guid}:123`, "1", "old-windows-name");
      await withFileMutex(target, async () => {}, { waitTimeoutMs: 50, readEpoch: async () => ({ machineId: `win32:${guid}`, processBirth: "win32:456" }) });
      await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await removeTempRoot(dir); }
  });

  it("preserves another Windows machine's ticket even when hostnames and local dead PIDs coincide", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      const ticket = await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), "win32-machine:33333333-3333-3333-3333-333333333333:123", "1");
      await expect(withFileMutex(target, async () => {}, { waitTimeoutMs: 20, readEpoch: async () => ({ machineId: "win32:44444444-4444-4444-4444-444444444444", processBirth: "win32:456" }) })).rejects.toMatchObject({ name: "FileMutexTimeoutError" });
      expect(await readFile(path.join(ticket, "number"), "utf8")).toBe("1");
    } finally { await removeTempRoot(dir); }
  });

  it("does not guess ownership of old Windows tickets after a hostname change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      const ticket = await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), "win32:123", "1", "unverified-old-name");
      await expect(withFileMutex(target, async () => {}, { waitTimeoutMs: 20, readEpoch: async () => ({ machineId: "win32:44444444-4444-4444-4444-444444444444", processBirth: "win32:456" }) })).rejects.toMatchObject({ name: "FileMutexTimeoutError" });
      expect(await readFile(path.join(ticket, "number"), "utf8")).toBe("1");
    } finally { await removeTempRoot(dir); }
  });

  it("recovers a dead local ticket after hostname changes when the boot identity still matches", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), currentBoot, "1", "previous-hostname");
      await withFileMutex(target, async () => {}, { waitTimeoutMs: 50, readEpoch: async () => ({ bootId: currentBoot }) });
      await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await removeTempRoot(dir); }
  });

  it("bounds the default wait for a same-boot live PID without process-birth proof, preserving its ticket", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const live = await seedTicket(`${target}.mutex.lock`, process.pid, currentBoot, "1");
      await expect(withFileMutex(target, async () => { throw Error("entered"); }, {
        readEpoch: async () => ({ bootId: currentBoot }), onWait: () => { clock.mockReturnValue(300_001); },
      })).rejects.toMatchObject({ name: "FileMutexTimeoutError", owner: { pid: process.pid } });
      expect(await readFile(path.join(live, "number"), "utf8")).toBe("1");
    } finally { clock.mockRestore(); await removeTempRoot(dir); }
  });

  it("retains a foreign-host dead PID when its boot cannot be verified as this machine", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      const live = await seedTicket(`${target}.mutex.lock`, await spawnDeadPid(), oldBoot, "1", "foreign-machine");
      await expect(withFileMutex(target, async () => {}, { waitTimeoutMs: 20, readEpoch: async () => ({ bootId: currentBoot }) })).rejects.toMatchObject({ name: "FileMutexTimeoutError" });
      expect(await readFile(path.join(live, "number"), "utf8")).toBe("1");
    } finally { await removeTempRoot(dir); }
  });

  it("recovers a reused live PID from a previous boot, including a crash before number publication", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      await seedTicket(`${target}.mutex.lock`, process.pid, oldBoot);
      await seedTicket(`${target}.mutex.lock`, process.pid, oldBoot, "5");
      await withFileMutex(target, async () => {}, { readEpoch: async () => ({ bootId: currentBoot }) });
      await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await removeTempRoot(dir); }
  });

  it("never removes a live choosing ticket, even after staleLockMs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      const live = await seedTicket(`${target}.mutex.lock`, process.pid, currentBoot);
      let entered = false;
      const run = withFileMutex(target, async () => { entered = true; }, { staleLockMs: 0, readEpoch: async () => ({ bootId: currentBoot }) });
      await sleep(150); expect(entered).toBe(false);
      expect(await readdir(live)).toEqual([]);
      await rm(live, { recursive: true });
      await run; expect(entered).toBe(true);
    } finally { await removeTempRoot(dir); }
  });

  it("dead legacy recovery preserves a separate active ticket and waits for it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      await seedLock(`${target}.lock`, { pid: await spawnDeadPid(), acquiredAt: new Date().toISOString(), host: os.hostname() });
      const live = await seedTicket(`${target}.mutex.lock`, process.pid, currentBoot, "1");
      let entered = false;
      const run = withFileMutex(target, async () => { entered = true; }, { readEpoch: async () => ({ bootId: currentBoot }) });
      await sleep(150); expect(entered).toBe(false);
      expect(await readFile(path.join(live, "number"), "utf8")).toBe("1");
      await expect(readFile(path.join(`${target}.lock`, "owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(live, { recursive: true }); await run;
    } finally { await removeTempRoot(dir); }
  });

  it("preserves a live ticket when boot identity is unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      const live = await seedTicket(`${target}.mutex.lock`, process.pid, oldBoot, "1");
      let entered = false;
      const run = withFileMutex(target, async () => { entered = true; }, { readEpoch: async () => ({}) });
      await sleep(100); expect(entered).toBe(false);
      await rm(live, { recursive: true }); await run;
    } finally { await removeTempRoot(dir); }
  });

  it("recovers a Windows reused PID using its immutable process creation identity", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      await seedTicket(`${target}.mutex.lock`, process.pid, "win32:123456", "1");
      await withFileMutex(target, async () => {}, { readEpoch: async () => ({ processBirth: "win32:123457" }) });
      await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await removeTempRoot(dir); }
  });

  it("does not recover malformed legacy owner data by age", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
    try {
      await seedLock(`${target}.lock`, { pid: "unknown", acquiredAt: "1900-01-01" });
      await expect(withFileMutex(target, async () => {}, { staleLockMs: 0 })).rejects.toThrow("manual_recovery_required");
      expect(await readdir(`${target}.lock`)).toEqual(["owner.json"]);
    } finally { await removeTempRoot(dir); }
  });
});

it("reports an unknown owner's bounded wait without stealing it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
  try {
    const live = await seedTicket(`${target}.mutex.lock`, process.pid, "", "1");
    await expect(withFileMutex(target, async () => { throw Error("entered"); }, { waitTimeoutMs: 20, readEpoch: async () => ({}) })).rejects.toMatchObject({ name: "FileMutexTimeoutError", owner: { pid: process.pid } });
    expect(await readFile(path.join(live, "number"), "utf8")).toBe("1");
    expect(await readdir(`${target}.mutex.lock`)).toEqual([path.basename(live)]);
  } finally { await removeTempRoot(dir); }
});

it("released tombstones let a live Hub PID's partially deleted ticket be recovered", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-")), target = path.join(dir, "state.json");
  try {
    const released = await seedTicket(`${target}.mutex.lock`, process.pid, currentBoot);
    await writeFile(path.join(released, "released"), "");
    await withFileMutex(target, async () => {}, { readEpoch: async () => ({ bootId: currentBoot }) });
    await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await removeTempRoot(dir); }
});

it("cancels an in-process waiter promptly without releasing or bypassing the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mutex-cancel-")), target = path.join(root, "state");
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { ready = r; });
  const owner = withFileMutex(target, async () => { ready(); await held; });
  try {
    await entered;
    const abortedWork = vi.fn(), nextWork = vi.fn();
    const controller = new AbortController();
    const waiting = withFileMutex(target, abortedWork, { signal: controller.signal });
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    const next = withFileMutex(target, nextWork);
    await sleep(30); expect(nextWork).not.toHaveBeenCalled();
    release(); await Promise.all([owner, next]);
    expect(abortedWork).not.toHaveBeenCalled(); expect(nextWork).toHaveBeenCalledOnce();
  } finally { release(); await owner; await removeTempRoot(root); }
});

it("cancels a filesystem waiter and retires only its own ticket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mutex-file-cancel-")), target = path.join(root, "state");
  const controller = new AbortController();
  try {
    await seedLock(`${target}.lock`, { pid: process.pid, host: os.hostname() });
    const work = vi.fn();
    const waiting = withFileMutex(target, work, { signal: controller.signal, onWait: () => controller.abort() });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(work).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(`${target}.lock/owner.json`, "utf8"))).toMatchObject({ pid: process.pid });
    expect(await readdir(`${target}.mutex.lock`).catch(() => [])).toEqual([]);
  } finally { await removeTempRoot(root); }
});

it.each(["inline", "sidecar", "sidecar-no-boot"])("keeps a verified POSIX owner (%s) beyond the unknown-owner timeout until cancellation", async (format) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mutex-posix-live-")), target = path.join(root, "state");
  const bootId = "darwin:22222222-2222-2222-2222-222222222222", processBirth = "darwin:123456789";
  const controller = new AbortController();
  let waited = 0;
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const ticket = await seedTicket(`${target}.mutex.lock`, process.pid, format === "inline" ? `posix:${bootId}:${processBirth}` : format === "sidecar" ? bootId : undefined, "1", os.hostname());
    if (format !== "inline") await writeFile(path.join(ticket, "birth"), processBirth);
    const work = vi.fn();
    const waiting = withFileMutex(target, work, {
      readEpoch: async () => ({ bootId, processBirth }), signal: controller.signal,
      onWait: () => { waited++; clock.mockReturnValue(300_001); setTimeout(() => controller.abort(), 30); },
    });
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(waited).toBe(1); expect(work).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); await removeTempRoot(root); }
});

it.each([true, false])("keeps POSIX ticket names readable by released v1 parsers with birth in a sidecar (boot=%s)", async (withBoot) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mutex-rollback-")), target = path.join(root, "state");
  const bootId = "darwin:22222222-2222-2222-2222-222222222222", processBirth = "darwin:123456789";
  try {
    await withFileMutex(target, async () => {
      const names = await readdir(`${target}.mutex.lock`); expect(names).toHaveLength(1);
      // Released 0.1.442 only accepts a bare boot UUID, not posix:<boot>:<birth>.
      const name = names[0]!, epoch = Buffer.from(name.split(".")[3]!, "base64url").toString();
      if (withBoot) { expect(epoch).toMatch(/^(linux|darwin):[a-f0-9-]{36}$/); expect(epoch).toBe(bootId); }
      else expect(name.split(".")[3]).toBe("-");
      expect(await readFile(path.join(`${target}.mutex.lock`, name, "birth"), "utf8")).toBe(processBirth);
    }, { readEpoch: async () => ({ ...(withBoot ? { bootId } : {}), processBirth }) });
    await seedTicket(`${target}.mutex.lock`, process.pid, bootId, "1", os.hostname());
    const [ticket] = await readdir(`${target}.mutex.lock`);
    await writeFile(path.join(`${target}.mutex.lock`, ticket!, "birth"), processBirth);
    await withFileMutex(target, async () => {}, { waitTimeoutMs: 100, readEpoch: async () => ({ bootId, processBirth: "darwin:999999999" }) });
    expect(await readdir(`${target}.mutex.lock`).catch(() => [])).toEqual([]);
  } finally { await removeTempRoot(root); }
});
