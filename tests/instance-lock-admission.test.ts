import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const firstWrite = vi.hoisted(() => ({ pause: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    const [file, data, options] = args;
    if (String(file).endsWith("/instance.lock.json") && typeof options === "object" && options?.flag === "wx" && firstWrite.pause) {
      const pause = firstWrite.pause; firstWrite.pause = undefined;
      const handle = await fs.open(file, "wx", options.mode);
      try { await pause(); await handle.writeFile(data, options); } finally { await handle.close(); }
      return;
    }
    return fs.writeFile(...args);
  } };
});
import { acquireInstanceLock } from "../src/state/instance-lock.js";

it("never treats a fresh owner's incomplete write as a stale lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-lock-admission-"));
  let opened!: () => void, resume!: () => void;
  const writing = new Promise<void>(resolve => { opened = resolve; });
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  firstWrite.pause = () => { opened(); return blocked; };
  const first = acquireInstanceLock(root);
  await writing;
  const second = acquireInstanceLock(root);
  // Let the contender inspect the empty file while its creator still owns it.
  const delay = setTimeout(resume, 150);
  const results = await Promise.allSettled([first, second]);
  clearTimeout(delay);
  const winners = results.filter((result): result is PromiseFulfilledResult<Awaited<typeof first>> => result.status === "fulfilled");
  try {
    expect(winners).toHaveLength(1);
    expect(results[1]).toMatchObject({ status: "rejected", reason: { message: `Instance lock already held by pid ${process.pid}` } });
  } finally {
    for (const winner of winners) await winner.value.release();
    await rm(root, { recursive: true, force: true });
  }
});
