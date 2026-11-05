import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effortSettings } from "../src/runtime/effort-settings.js";
import { updateInstanceConfig } from "../src/state/instance-config.js";
import { withFileMutex } from "../src/state/file-mutex.js";

describe("Bot effort settings", () => {
  let root: string;
  beforeEach(async () => { vi.stubEnv("ANTIGRAVITY_EXECUTABLE", path.resolve("tests/fixtures/agy-models.mjs")); root = await mkdtemp(path.join(os.tmpdir(), "effort-settings-")); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const config = (value: object) => writeFile(path.join(root, "config.json"), JSON.stringify(value));
  it.each([
    ["codex", "gpt-5.5", ["", "low", "medium", "high", "xhigh"]],
    ["codex", "gpt-5.6-luna", ["", "low", "medium", "high", "xhigh", "max"]],
    ["codex", "gpt-6-astra", ["", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["codex", "gpt-6.1-sol", ["", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["codex", "gpt-6-sol", ["", "low", "medium", "high", "xhigh", "max", "ultra"]],
    ["codex", "gpt-6-luna", ["", "low", "medium", "high", "xhigh", "max"]],
    ["codex", "custom-model", ["", "low", "medium", "high", "xhigh"]],
    ["claude", "claude-opus-5-5", ["", "low", "medium", "high", "xhigh", "max"]],
    ["claude", "claude-sonnet-4-6", ["", "low", "medium", "high", "max"]],
    ["claude", "claude-opus-4-5", ["", "low", "medium", "high"]],
    ["claude", "haiku", [""]],
    ["kimi", "kimi-code/k3", ["", "low", "high", "max"]],
    ["deepseek", "deepseek-official/deepseek-v4-pro", ["", "low", "high", "max"]],
    ["antigravity", "gemini-3.7-flash-high", ["", "high"]],
    ["antigravity", "gemini-3.1-pro-high", ["", "high"]],
    ["antigravity", "gpt-oss-120b-medium", ["", "medium"]],
    ["antigravity", "", [""]],
    ["antigravity", "unknown-future-model", [""]],
  ] as const)("offers %s / %s compatible levels", async (engine, model, choices) => {
    await config({ engine, model });
    const result = await effortSettings(root, engine, 0);
    expect(result).toMatchObject({ ok: true, settings: { scope: "bot", engine, model, effort: "", choices } });
  });
  it.each(["xhigh", "low"])("preserves incompatible saved effort %s for review and allows repair", async (savedEffort) => {
    await config({ engine: "antigravity", model: "gemini-3.8-flash-high", effort: savedEffort });
    const current = await effortSettings(root, "antigravity", 0); if (!current.ok) throw new Error(current.error);
    expect(current.settings.effort).toBe(savedEffort); expect(current.settings.choices).not.toContain(savedEffort);
    expect(await effortSettings(root, "antigravity", 0, { revision: current.settings.revision, effort: savedEffort })).toEqual({ ok: false, error: "effort_incompatible" });
    expect(await effortSettings(root, "antigravity", 0, { revision: current.settings.revision, effort: "high" })).toMatchObject({ ok: true, settings: { effort: "high" } });
  });
  it("preserves all other config, sessions and secrets while updating only Bot effort", async () => {
    const unrelated = { engine: "codex", model: "gpt-5.5", workspacePath: "/private/workspace", bus: { secret: "private-value" }, resume: { sessionId: "original", dirName: "work", workspacePath: "/private/workspace" } };
    await config({ ...unrelated, effort: "high" }); await writeFile(path.join(root, "session.json"), "session-unchanged");
    const before = await effortSettings(root, "codex", 2); if (!before.ok) throw new Error(before.error);
    expect(JSON.stringify(before)).not.toContain("private");
    const next = await effortSettings(root, "codex", 2, { revision: before.settings.revision, effort: "low" });
    expect(next).toMatchObject({ ok: true, settings: { scope: "bot", effort: "low", activeTurns: 2 } });
    expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ ...unrelated, effort: "low" });
    expect(await readFile(path.join(root, "session.json"), "utf8")).toBe("session-unchanged");
  });
  it("rejects stale device writes and rechecks compatibility after native config changes", async () => {
    await config({ engine: "codex", model: "gpt-5.5", effort: "high" });
    const before = await effortSettings(root, "codex", 0); if (!before.ok) throw new Error(before.error);
    const results = await Promise.all(["low", "xhigh"].map((effort) => effortSettings(root, "codex", 0, { revision: before.settings.revision, effort })));
    expect(results.filter((r) => r.ok)).toHaveLength(1); expect(results).toContainEqual({ ok: false, error: "effort_conflict" });
    const current = await effortSettings(root, "codex", 0); if (!current.ok) throw new Error(current.error);
    expect(await effortSettings(root, "codex", 0, { revision: current.settings.revision, effort: "ultra" })).toEqual({ ok: false, error: "effort_incompatible" });
    await updateInstanceConfig(root, (value) => { value.model = "gpt-6-astra"; });
    expect(await effortSettings(root, "codex", 0, { revision: current.settings.revision, effort: "low" })).toEqual({ ok: false, error: "effort_conflict" });
  });
  it("clears the override for default without persisting an invented off level", async () => {
    await config({ engine: "deepseek", effort: "max" }); const before = await effortSettings(root, "deepseek", 0); if (!before.ok) throw new Error(before.error);
    expect(await effortSettings(root, "deepseek", 0, { revision: before.settings.revision, effort: "" })).toMatchObject({ ok: true, settings: { effort: "" } });
    expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).not.toHaveProperty("effort");
  });
  it("reports tasks that start while an effort save waits for the config mutex", async () => {
    await config({ engine: "codex", effort: "high" });
    const before = await effortSettings(root, "codex", 0); if (!before.ok) throw new Error(before.error);
    let active = 0, release!: () => void, acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const lock = withFileMutex(path.join(root, "config.json"), async () => { acquired(); await held; });
    await entered;
    const pending = effortSettings(root, "codex", () => active, { revision: before.settings.revision, effort: "low" });
    active = 2; release(); await lock;
    expect(await pending).toMatchObject({ ok: true, settings: { effort: "low", activeTurns: 2 } });
  });
  it("never repairs corrupt config or writes settings for a different running engine", async () => {
    await writeFile(path.join(root, "config.json"), "{broken");
    expect(await effortSettings(root, "codex", 0)).toEqual({ ok: false, error: "effort_config_unreadable" });
    expect(await readFile(path.join(root, "config.json"), "utf8")).toBe("{broken");
    await config({ engine: "claude", effort: "high" });
    expect(await effortSettings(root, "codex", 0)).toEqual({ ok: false, error: "effort_engine_changed" });
  });
});
