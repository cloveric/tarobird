import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { withServiceDirectoryGate } from "../src/state/service-directory-gate.js";

it("keeps startup outside a directory swap, including the gap where the directory is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "restore-gate-")), state = path.join(root, "state");
  let release!: () => void, entered!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  try {
    await mkdir(state);
    const restore = withServiceDirectoryGate(state, async () => { await rename(state, path.join(root, "old")); entered(); await gate; await mkdir(state); });
    await ready;
    const startup = withServiceDirectoryGate(state, async () => { started = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(started).toBe(false);
    release(); await restore; await startup; expect(started).toBe(true);
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
