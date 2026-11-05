import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ deleteBusy: false, markerRemoved: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: async (target: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
    if (fault.deleteBusy && String(target).includes(".mutex.lock/ticket-v1.")) {
      await fs.rm(path.join(String(target), "released"), { force: true });
      fault.markerRemoved = true;
      throw Object.assign(new Error("simulated NTFS deletion pending"), { code: "EPERM" });
    }
    return fs.rm(target, options);
  } };
});
import { withFileMutex } from "../src/state/file-mutex.js";
afterEach(() => { fault.deleteBusy = false; fault.markerRemoved = false; });

it("restores the released marker after EPERM partial cleanup, so a live process never strands a choosing ticket", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-release-")), target = path.join(dir, "state.json");
  try {
    fault.deleteBusy = true;
    await withFileMutex(target, async () => {});
    expect(fault.markerRemoved).toBe(true);
    const [name] = await readdir(`${target}.mutex.lock`);
    expect(name).toMatch(/^ticket-v1\./);
    expect(await readFile(path.join(`${target}.mutex.lock`, name!, "released"), "utf8")).toBe("");
    fault.deleteBusy = false;
    await withFileMutex(target, async () => {});
    await expect(readdir(`${target}.mutex.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { fault.deleteBusy = false; await rm(dir, { recursive: true, force: true }); }
});

it("separates the new ticket container from a legacy recoverer's directory removal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "file-mutex-release-")), target = path.join(dir, "state.json");
  try {
    await mkdir(`${target}.lock`);
    await withFileMutex(target, async () => {
      const [name] = await readdir(`${target}.mutex.lock`);
      await rm(`${target}.lock`, { recursive: true });
      await mkdir(`${target}.lock`);
      await writeFile(path.join(`${target}.lock`, "legacy-trash"), "");
      expect(await readFile(path.join(`${target}.mutex.lock`, name!, "number"), "utf8")).toBe("1");
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
