import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { acquireInstanceLock, isInstanceLockOwnerAlive, resolveInstanceLockPath } from "../src/state/instance-lock.js";
import type { ProcessEpoch } from "../src/state/process-epoch.js";

describe("instance lock", () => {
  const firstBoot = "darwin:11111111-1111-4111-8111-111111111111", secondBoot = "darwin:22222222-2222-4222-8222-222222222222";
  it("normalizes raw optional epochs before making a read-only live-owner decision", async () => {
    const options = { processAlive: () => true, readEpoch: async () => ({ bootId: firstBoot, processBirth: "win32:130000000000000000" }) };
    expect(await isInstanceLockOwnerAlive({ pid: process.pid, bootId: "invalid", processBirth: "invalid" }, options)).toBe(true);
    expect(await isInstanceLockOwnerAlive({ pid: process.pid, bootId: firstBoot.toUpperCase() }, options)).toBe(true);
    expect(await isInstanceLockOwnerAlive({ pid: process.pid, processBirth: "invalid" }, options)).toBe(true);
  });
  async function existingEpochLock(stored: Record<string, unknown>, observed: ProcessEpoch, recover: boolean) {
    const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-epoch-lock-"));
    try {
      const original = { pid: process.pid, token: "previous-owner", acquiredAt: "1900-01-01T00:00:00.000Z", ...stored };
      await writeFile(resolveInstanceLockPath(root), JSON.stringify(original));
      const acquire = acquireInstanceLock(root, process.pid, { readEpoch: async () => observed });
      if (recover) {
        const handle = await acquire; expect(handle.recoveredStale).toBe(true);
        expect(JSON.parse(await readFile(handle.filePath, "utf8"))).toMatchObject(observed); await handle.release();
      } else {
        await expect(acquire).rejects.toThrow(`Instance lock already held by pid ${process.pid}`);
        expect(JSON.parse(await readFile(resolveInstanceLockPath(root), "utf8"))).toEqual(original);
      }
    } finally { await removeTempRoot(root); }
  }
  it("recovers a previous boot's lock even when its PID has been reused", async () => {
    await existingEpochLock({ bootId: firstBoot }, { bootId: secondBoot }, true);
  });
  it("never infers stale ownership from wall-clock age in the same boot", async () => {
    await existingEpochLock({ bootId: firstBoot }, { bootId: firstBoot }, false);
  });
  it("preserves a live owner when the current boot identity is unavailable", async () => {
    await existingEpochLock({ bootId: firstBoot }, {}, false);
  });
  it("preserves live legacy locks without a comparable boot identity", async () => {
    await existingEpochLock({}, { bootId: secondBoot }, false);
  });
  it("recovers a reused Windows PID using immutable process creation time", async () => {
    await existingEpochLock({ processBirth: "win32:130000000000000000" }, { processBirth: "win32:140000000000000000" }, true);
  });
  it("preserves a Windows owner with the same process creation identity", async () => {
    await existingEpochLock({ processBirth: "win32:130000000000000000" }, { processBirth: "win32:130000000000000000" }, false);
  });
  it("does not interpret malformed optional metadata as a corrupt live lock", async () => {
    await existingEpochLock({ bootId: 123, processBirth: "invalid" }, { bootId: secondBoot }, false);
  });
  it("acquires a fresh lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const lock = await acquireInstanceLock(root);

      const onDisk = JSON.parse(await readFile(resolveInstanceLockPath(root), "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);

      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces a stale lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: 99999999,
            token: "stale-token",
            acquiredAt: "2026-04-08T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const lock = await acquireInstanceLock(root);

      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);

      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("allows only one winner when many starters race to replace the same stale lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(lockPath, JSON.stringify({
        pid: 99_999_999,
        token: "stale-token",
        acquiredAt: "2026-04-08T00:00:00.000Z",
      }), "utf8");

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () => acquireInstanceLock(root)),
      );
      const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireInstanceLock>>> =>
        result.status === "fulfilled");
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);

      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await winners[0]!.value.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects a live lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "2026-04-08T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(acquireInstanceLock(root)).rejects.toThrow(`Instance lock already held by pid ${process.pid}`);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces an invalid lock record shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "not-a-timestamp",
          },
          null,
          2,
        ),
        "utf8",
      );

      const lock = await acquireInstanceLock(root);
      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("treats parseable non-canonical timestamps as valid lock records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(
        lockPath,
        JSON.stringify(
          {
            pid: process.pid,
            token: "live-token",
            acquiredAt: "2026-04-08T00:00:00Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(acquireInstanceLock(root)).rejects.toThrow(`Instance lock already held by pid ${process.pid}`);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("replaces a malformed lock file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);

    try {
      await writeFile(lockPath, "{bad json\n", "utf8");

      const lock = await acquireInstanceLock(root);
      const onDisk = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      expect(onDisk.pid).toBe(process.pid);
      await lock.release();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("logs sync-release failures before swallowing them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const lockPath = resolveInstanceLockPath(root);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const lock = await acquireInstanceLock(root);
      await writeFile(lockPath, "{bad json\n", "utf8");

      expect(() => lock.releaseSync()).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });
});
