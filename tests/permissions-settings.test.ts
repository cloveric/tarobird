import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionSettings } from "../src/runtime/permissions-settings.js";
import { applyPermission, currentPermission, defaultPermission, permissionOptions, type PermissionEngine } from "../src/state/permission-options.js";
import { withFileMutex } from "../src/state/file-mutex.js";

describe("Bot permissions", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "bot-permissions-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const config = (value: object) => writeFile(path.join(root, "config.json"), JSON.stringify(value));
  async function settings(engine: PermissionEngine) { const result = await permissionSettings(root, engine, 0); if (!result.ok) throw new Error(result.error); return result.settings; }
  it.each(["codex", "claude", "kimi", "deepseek", "antigravity"] as const)("persists every %s native choice without changing unrelated config or sessions", async engine => {
    const preserved = { engine, model: "my-model", effort: "high", workspacePath: "/private/workspace", bus: { secret: "test-secret-value" }, userExtension: { retained: true } };
    await config(preserved); await writeFile(path.join(root, "session.json"), "unchanged");
    let before = await settings(engine); expect(before.choice).toBe(defaultPermission(engine));
    for (const option of permissionOptions(engine)) {
      const result = await permissionSettings(root, engine, 0, { revision: before.revision, choice: option.id });
      expect(result).toMatchObject({ ok: true, settings: { choice: option.id } });
      const saved = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
      expect(saved).toMatchObject(preserved); expect(currentPermission(engine, saved)).toBe(option.id);
      if (engine === "kimi") expect(saved.kimiAutoNeverAskAcknowledged).toBe(option.id === "bypass" ? true : undefined);
      if (option.id === "claude-auto") expect(saved).toMatchObject({ approvalMode: "normal", claudePermissionMode: "auto" });
      before = await settings(engine); expect(JSON.stringify(before)).not.toContain("test-secret-value");
    }
    expect(await readFile(path.join(root, "session.json"), "utf8")).toBe("unchanged");
    if (process.platform !== "win32") expect((await stat(path.join(root, "config.json"))).mode & 0o777).toBe(0o600);
  });
  it("does not mislabel legacy Claude full-auto or unacknowledged Kimi bypass", () => {
    expect(currentPermission("claude", { approvalMode: "full-auto" })).toBe("bypass");
    expect(currentPermission("kimi", { approvalMode: "bypass" })).toBe("full-auto");
    expect(permissionOptions("codex", "process").find(option => option.id === "normal")?.label).toContain("每轮批准");
    expect(() => applyPermission({}, "kimi", "claude-auto")).toThrow("permissions_incompatible");
  });
  it("rejects stale device writes, unsupported modes and saves during active turns", async () => {
    await config({ engine: "codex" }); const before = await settings("codex");
    const results = await Promise.all(["normal", "full-auto"].map(choice => permissionSettings(root, "codex", 0, { revision: before.revision, choice })));
    expect(results.filter(r => r.ok)).toHaveLength(1); expect(results).toContainEqual({ ok: false, error: "permissions_conflict" });
    const current = await settings("codex");
    expect(await permissionSettings(root, "codex", 0, { revision: current.revision, choice: "claude-auto" })).toEqual({ ok: false, error: "permissions_incompatible" });
    expect(await permissionSettings(root, "codex", 1, { revision: current.revision, choice: "bypass" })).toEqual({ ok: false, error: "permissions_busy" });
    expect((await settings("codex")).revision).toBe(current.revision);
  });
  it("does not overwrite corrupt config or a changed runtime, and hashes native mode changes", async () => {
    await config({ engine: "claude", approvalMode: "normal", claudePermissionMode: "manual" }); const before = await settings("claude");
    await config({ engine: "claude", approvalMode: "normal", claudePermissionMode: "auto" });
    expect(await permissionSettings(root, "claude", 0, { revision: before.revision, choice: "bypass" })).toEqual({ ok: false, error: "permissions_conflict" });
    expect(await permissionSettings(root, "codex", 0)).toEqual({ ok: false, error: "permissions_engine_changed" });
    await writeFile(path.join(root, "config.json"), "{broken");
    expect(await permissionSettings(root, "claude", 0)).toEqual({ ok: false, error: "permissions_config_unreadable" });
    expect(await readFile(path.join(root, "config.json"), "utf8")).toBe("{broken");
  });
  it("rechecks active tasks after waiting for the config mutex", async () => {
    await config({ engine: "codex", approvalMode: "bypass" });
    const before = await settings("codex");
    let active = 0, release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const lock = withFileMutex(path.join(root, "config.json"), async () => { acquired(); await held; });
    await entered;
    const pending = permissionSettings(root, "codex", () => active, { revision: before.revision, choice: "normal" });
    active = 1; release(); await lock;
    expect(await pending).toEqual({ ok: false, error: "permissions_busy" });
    const current = await permissionSettings(root, "codex", () => active);
    expect(current).toMatchObject({ ok: true, settings: { choice: "bypass", revision: before.revision, activeTurns: 1 } });
  });
  it("keeps the original permissions when work starts while syncing a pending save", async () => {
    await config({ engine: "codex", approvalMode: "bypass" });
    const before = await settings("codex");
    let active = 0;
    const handle = await open(path.join(root, "config.json"), "r");
    const prototype = Object.getPrototypeOf(handle) as typeof handle;
    await handle.close();
    const realSync = prototype.sync;
    const syncSpy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof handle) {
      await realSync.call(this); active = 1;
    });
    try {
      expect(await permissionSettings(root, "codex", () => active, { revision: before.revision, choice: "normal" }))
        .toEqual({ ok: false, error: "permissions_busy" });
      expect(syncSpy).toHaveBeenCalled();
    } finally { syncSpy.mockRestore(); }
    expect(await settings("codex")).toMatchObject({ choice: "bypass", revision: before.revision });
    expect(await readdir(root)).toEqual(["config.json"]);
  });
});
