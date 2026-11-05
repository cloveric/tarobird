import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ container: "", code: "", remaining: 0, calls: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    if (String(args[0]) === faults.container && faults.remaining > 0) {
      faults.remaining--; faults.calls++;
      throw Object.assign(new Error("injected concurrent empty-container removal"), { code: faults.code });
    }
    return actual.mkdir(...args);
  } };
});
import { withFileMutex } from "../src/state/file-mutex.js";
const roots: string[] = [];
afterEach(async () => { faults.container = ""; faults.remaining = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function target(code: string, remaining = 1) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mutex-create-race-")); roots.push(root);
  const file = path.join(root, "state.json");
  Object.assign(faults, { container: `${file}.mutex.lock`, code, remaining, calls: 0 });
  return file;
}
it("acquires exactly once when another process removes the empty container during recursive mkdir", async () => {
  const file = await target("ENOENT"); let calls = 0;
  await withFileMutex(file, async () => { calls++; });
  expect(faults.calls).toBe(1); expect(calls).toBe(1);
  await withFileMutex(file, async () => { calls++; }); expect(calls).toBe(2);
});
it("does not hide a non-race filesystem denial or enter protected work", async () => {
  const file = await target("EACCES"); const work = vi.fn();
  await expect(withFileMutex(file, work)).rejects.toMatchObject({ code: "EACCES" });
  expect(work).not.toHaveBeenCalled(); expect(faults.calls).toBe(1);
});
it("bounds repeated container disappearance without entering protected work", async () => {
  const file = await target("ENOENT", 10000); const work = vi.fn();
  await expect(withFileMutex(file, work, { waitTimeoutMs: 20 })).rejects.toThrow("file_mutex_wait_timeout");
  expect(work).not.toHaveBeenCalled(); expect(faults.calls).toBeLessThan(10000);
});
it("honors cancellation while retrying container creation", async () => {
  const file = await target("ENOENT", 10000); const work = vi.fn(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancel-create")), 20);
  try { await expect(withFileMutex(file, work, { signal: controller.signal })).rejects.toThrow("cancel-create"); }
  finally { clearTimeout(timer); }
  expect(work).not.toHaveBeenCalled();
});
