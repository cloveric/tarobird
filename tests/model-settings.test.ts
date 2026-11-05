import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelSettings } from "../src/runtime/model-settings.js";
import { effortSettings } from "../src/runtime/effort-settings.js";
import { modelSettingsSchema } from "../src/client-protocol/model.js";
import { updateInstanceConfig, type InstanceEngine } from "../src/state/instance-config.js";
import { kimiModelConfig } from "./fixtures/kimi-model-config.js";

describe("existing Bot model settings", () => {
  let root: string;
  beforeEach(async () => { vi.stubEnv("ANTIGRAVITY_EXECUTABLE", path.resolve("tests/fixtures/agy-models.mjs")); root = await mkdtemp(path.join(os.tmpdir(), "tarobot-model-")); vi.stubEnv("KIMI_CODE_HOME", root); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  const config = (value: object) => writeFile(path.join(root, "config.json"), JSON.stringify(value));
  const read = async (engine: InstanceEngine = "codex") => { const result = await modelSettings(root, engine, 2); if (!result.ok) throw new Error(result.error); return modelSettingsSchema.parse(result.settings); };
  it("shares Kimi model-specific efforts with the effort picker and preserves explicit choices", async () => {
    await writeFile(path.join(root, "config.toml"), kimiModelConfig);
    await config({ engine: "kimi", effort: "max", resume: { sessionId: "old", dirName: "work", workspacePath: "/preserved" } });
    const before = await read("kimi");
    expect(before).toMatchObject({ model: "", effort: "max", choices: [{ id: "", label: "K3.1 Pro" }, {}, {}, { efforts: [""] }] });
    const switched = await modelSettings(root, "kimi", 2, { revision: before.revision, model: "kimi-code/k3" });
    expect(switched).toMatchObject({ ok: true, settings: { model: "kimi-code/k3", effort: "max" } });
    if (!switched.ok) throw new Error(switched.error);
    const fixed = "kimi-code/kimi-for-coding-highspeed";
    expect(await modelSettings(root, "kimi", 2, { revision: switched.settings.revision, model: fixed })).toEqual({ ok: false, error: "model_effort_incompatible" });
    expect(await modelSettings(root, "kimi", 2, { revision: switched.settings.revision, model: fixed, effort: "" })).toMatchObject({ ok: true, settings: { effort: "" } });
    const effort = await effortSettings(root, "kimi", 2);
    expect(effort).toMatchObject({ ok: true, settings: { choices: [""] } });
    if (!effort.ok) throw new Error(effort.error);
    expect(await effortSettings(root, "kimi", 2, { revision: effort.settings.revision, effort: "high" })).toEqual({ ok: false, error: "effort_incompatible" });
    await writeFile(path.join(root, "config.toml"), kimiModelConfig.replace('default_model = "kimi-code/k3.1-pro"', `default_model = "${fixed}"`));
    const current = await read("kimi");
    expect(await modelSettings(root, "kimi", 2, { revision: current.revision, model: "", effort: "" })).toMatchObject({ ok: true, settings: { model: "", effort: "" } });
    expect(await effortSettings(root, "kimi", 0)).toMatchObject({ ok: true, settings: { choices: [""] } });
    expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ resume: { sessionId: "old" } });
  });
  it.each([
    ["gemini-3.8-flash-high", "low"], ["gemini-4-argon-medium", "high"],
    ["gemini-3.8-flash-high", "xhigh"], ["gemini-3.8-flash-high", "ultra"],
    ["gemini-3.1-pro-high", "medium"], ["gpt-oss-120b-medium", "high"],
    ["unknown-future-model", "high"],
  ] as const)("rejects an unsupported %s / %s even when submitted outside the picker", async (model, effort) => {
    await config({ engine: "antigravity", model: "gemini-4-argon-medium", effort: "medium" });
    const before = await read("antigravity"), bytes = await readFile(path.join(root, "config.json"), "utf8");
    expect(await modelSettings(root, "antigravity", 0, { revision: before.revision, model, effort })).toEqual({ ok: false, error: "model_effort_incompatible" });
    expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(bytes);
  });
  it.each([
    ["codex", "gpt-6-astra", "ultra"], ["claude", "claude-opus-5-5[1m]", "xhigh"],
    ["codex", "gpt-6.1-sol", "ultra"], ["codex", "gpt-6-sol", "ultra"], ["codex", "gpt-6-luna", "max"],
    ["antigravity", "gemini-4-argon-medium", "medium"], ["kimi", "kimi-code/k3", "max"],
    ["deepseek", "deepseek-official/deepseek-v4-pro", "high"],
  ] as const)("saves %s model and effort atomically without touching sessions or other config", async (engine, model, effort) => {
    const preserved = { engine, workspacePath: "/private/unchanged", bus: { secret: "secret-value" }, resume: { sessionId: "old", dirName: "work", workspacePath: "/private/unchanged" }, customField: true };
    await config({ ...preserved, model: "previous-model", effort: "high" }); await writeFile(path.join(root, "session.json"), "unchanged");
    const before = await read(engine);
    expect(JSON.stringify(before)).not.toMatch(/private|secret-value/);
    const result = await modelSettings(root, engine, 2, { revision: before.revision, model, effort });
    expect(result).toMatchObject({ ok: true, settings: { model, effort, activeTurns: 2 } });
    expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ ...preserved, model, effort });
    expect(await readFile(path.join(root, "session.json"), "utf8")).toBe("unchanged");
    const persisted = await read(engine); expect(persisted.revision).not.toBe(before.revision);
    if (engine === "antigravity") { expect(persisted.choices.find(item => item.id === model)?.label).toBe("Gemini 4 Argon (Medium)"); expect(persisted.choices.some(item => item.id === "gemini-4-argon-ultra")).toBe(false); }
  });
  it("rejects incompatible choices without partial writes, and permits explicitly resetting effort", async () => {
    await config({ engine: "codex", model: "gpt-6-astra", effort: "ultra" }); const before = await read();
    const bytes = await readFile(path.join(root, "config.json"), "utf8");
    for (const model of ["gpt-5.6-luna", "gpt-6-luna", "", "custom-model"]) {
      expect(await modelSettings(root, "codex", 0, { revision: before.revision, model })).toEqual({ ok: false, error: "model_effort_incompatible" });
      expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(bytes);
    }
    expect(await modelSettings(root, "codex", 0, { revision: before.revision, model: "", effort: "" })).toMatchObject({ ok: true, settings: { model: "", effort: "" } });
    const saved = JSON.parse(await readFile(path.join(root, "config.json"), "utf8")); expect(saved).not.toHaveProperty("model"); expect(saved).not.toHaveProperty("effort");
  });
  it("checks Claude and host-discovered Antigravity model-specific effort", async () => {
    for (const [engine, model, effort] of [["claude", "haiku", "high"], ["antigravity", "gemini-4-argon-medium", "ultra"], ["antigravity", "unknown", "high"]] as const) {
      await config({ engine }); const before = await read(engine);
      expect(await modelSettings(root, engine, 0, { revision: before.revision, model, effort })).toEqual({ ok: false, error: "model_effort_incompatible" });
    }
  });
  it("rejects stale devices, effort-picker updates and CLI command config edits", async () => {
    await config({ engine: "codex", model: "gpt-5.6-sol", effort: "high" });
    const before = await read(), effort = await effortSettings(root, "codex", 0); if (!effort.ok) throw new Error(effort.error);
    const results = await Promise.all(["gpt-6-astra", "gpt-5.6-luna"].map(model => modelSettings(root, "codex", 0, { revision: before.revision, model })));
    expect(results.filter(result => result.ok)).toHaveLength(1); expect(results).toContainEqual({ ok: false, error: "model_conflict" });
    expect(await effortSettings(root, "codex", 0, { revision: effort.settings.revision, effort: "low" })).toEqual({ ok: false, error: "effort_conflict" });
    const fresh = await read(); await updateInstanceConfig(root, value => { value.model = "command-model"; });
    expect(await modelSettings(root, "codex", 0, { revision: fresh.revision, model: "gpt-6-astra" })).toEqual({ ok: false, error: "model_conflict" });
    const current = await read(), effortNow = await effortSettings(root, "codex", 0); if (!effortNow.ok) throw new Error(effortNow.error);
    await effortSettings(root, "codex", 0, { revision: effortNow.settings.revision, effort: "low" });
    expect(await modelSettings(root, "codex", 0, { revision: current.revision, model: "gpt-6-astra" })).toEqual({ ok: false, error: "model_conflict" });
  });
  it("preserves unknown configured model IDs for review and makes reads and no-ops read-only", async () => {
    await config({ engine: "codex", model: "provider/custom-v1", effort: "high" });
    const original = await readFile(path.join(root, "config.json"), "utf8"), before = await read();
    expect(before.choices.some(choice => choice.id === "provider/custom-v1")).toBe(true);
    expect(await modelSettings(root, "codex", 0, { revision: before.revision, model: before.model })).toMatchObject({ ok: true, settings: { revision: before.revision } });
    expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(original);
  });
  it("fails closed on corrupt config, changed engine, and malformed requests", async () => {
    await writeFile(path.join(root, "config.json"), "{broken"); expect(await modelSettings(root, "codex", 0)).toEqual({ ok: false, error: "model_config_unreadable" });
    expect(await readFile(path.join(root, "config.json"), "utf8")).toBe("{broken");
    await config({ engine: "claude" }); expect(await modelSettings(root, "codex", 0)).toEqual({ ok: false, error: "model_engine_changed" });
    await config({ engine: "codex" }); const before = await read();
    for (const model of ["bad\nmodel", "two words", "a".repeat(129), "bad\u0000id"]) await expect(modelSettings(root, "codex", 0, { revision: before.revision, model })).rejects.toThrow();
    expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toEqual({ engine: "codex" });
  });
});
