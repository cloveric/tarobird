import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { publishExclusive } from "../src/state/publish-exclusive.js";
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open) }; });
it("never publishes partial bytes, preserves an existing file, and cleans its scratch file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "publish-exclusive-")), target = path.join(root, "spec.json");
  try {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      handle.writeFile = async () => { await handle.write("partial"); throw new Error("disk full"); };
      return handle;
    });
    await expect(publishExclusive(target, "complete")).rejects.toThrow("disk full");
    expect(await readdir(root)).toEqual([]);
    await publishExclusive(target, "first"); await expect(publishExclusive(target, "second")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("first"); expect(await readdir(root)).toEqual(["spec.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
