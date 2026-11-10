import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelDiscoveryCacheForTest } from "../src/runtime/cli-model-discovery.js";
import { modelSettings } from "../src/runtime/model-settings.js";
import { effortSettings } from "../src/runtime/effort-settings.js";

describe("discovered model settings", () => {
  let root: string;
  beforeEach(async () => {
    resetModelDiscoveryCacheForTest();
    root = await mkdtemp(path.join(os.tmpdir(), "tarobird-model-settings-"));
    vi.stubEnv("CLAUDE_EXECUTABLE", path.resolve("tests/fixtures/cli-model-settings.mjs"));
    vi.stubEnv("CODEX_EXECUTABLE", path.resolve("tests/fixtures/cli-model-settings.mjs"));
    vi.stubEnv("FIXTURE_MODEL_DISCOVERY_LOG", path.join(root, "discovery.jsonl"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); resetModelDiscoveryCacheForTest(); await rm(root, { recursive: true, force: true }); });
  const state = async (name: string, config: object) => {
    const dir = path.join(root, name); await mkdir(dir);
    await writeFile(path.join(dir, "config.json"), JSON.stringify(config)); return dir;
  };

  it.each(["claude", "codex"] as const)("%s settings reads and writes share one discovery deadline below the Hub RPC budget", async engine => {
    const model = engine === "claude" ? "fable" : "gpt-6.1-sol";
    const dirs = await Promise.all(["model-read", "effort-read", "model-write", "effort-write"].map(name => state(name, { engine, model, effort: "high" })));
    vi.stubEnv("TAROBOT_MODEL_DISCOVERY", "0");
    const before = await modelSettings(dirs[0]!, engine, 0); if (!before.ok) throw new Error(before.error);
    vi.stubEnv("TAROBOT_MODEL_DISCOVERY", "1"); vi.stubEnv("FIXTURE_MODEL_DISCOVERY_SCENARIO", "stalled");
    const started = performance.now();
    const results = await Promise.all([
      modelSettings(dirs[0]!, engine, 0), effortSettings(dirs[1]!, engine, 0),
      modelSettings(dirs[2]!, engine, 0, { revision: before.settings.revision, model, effort: "low" }),
      effortSettings(dirs[3]!, engine, 0, { revision: before.settings.revision, effort: "low" }),
    ]);
    // Include initialize, all pages and writes, with scheduling/IO headroom for
    // a busy runner. Eight seconds still precedes Hub's ten-second RPC timeout
    // and rejects the previous fifteen-second discovery deadline.
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(results.every(result => result.ok)).toBe(true);
    expect(results[0]).toMatchObject({ ok: true, settings: { choices: before.settings.choices } });
    for (const dir of dirs.slice(2)) expect(JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"))).toMatchObject({ engine, model, effort: "low" });
    const events = (await readFile(path.join(root, "discovery.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.started)).toHaveLength(1);
    if (engine === "codex") expect(events.filter(event => event.method === "model/list")).toHaveLength(2);
  }, 20_000);

  it.each([
    ["claude", "claude-fable-5-3", ["", "low", "high"], "max"],
    ["claude", "claude-nova-6", [""], "high"],
    ["codex", "gpt-6.2-sol", ["", "low", "high"], "medium"],
    ["codex", "gpt-next-no-effort", [""], "high"],
  ] as const)("%s / %s uses the same discovered efforts in both settings entry points", async (engine, model, allowed, invalid) => {
    vi.stubEnv("TAROBOT_MODEL_DISCOVERY", "1"); vi.stubEnv("FIXTURE_MODEL_DISCOVERY_SCENARIO", "restricted");
    const dir = await state("bot", { engine, model });
    const before = await readFile(path.join(dir, "config.json"), "utf8");
    const models = await modelSettings(dir, engine, 0), effort = await effortSettings(dir, engine, 0);
    if (!models.ok || !effort.ok) throw new Error("fixture settings unavailable");
    expect(models.settings.choices.find(choice => choice.id === model)?.efforts).toEqual(allowed);
    expect.soft(effort.settings.choices).toEqual(allowed);
    expect(await modelSettings(dir, engine, 0, { revision: models.settings.revision, model, effort: invalid })).toEqual({ ok: false, error: "model_effort_incompatible" });
    expect.soft(await effortSettings(dir, engine, 0, { revision: effort.settings.revision, effort: invalid })).toEqual({ ok: false, error: "effort_incompatible" });
    expect(await readFile(path.join(dir, "config.json"), "utf8")).toBe(before);
    // A fresh settings write still discovers model-specific restrictions; an
    // empty cache must not make a newly listed model fall back to broad levels.
    resetModelDiscoveryCacheForTest();
    expect(await effortSettings(dir, engine, 0, { revision: effort.settings.revision, effort: invalid })).toEqual({ ok: false, error: "effort_incompatible" });
    const accepted = allowed.at(-1)!;
    expect(await effortSettings(dir, engine, 0, { revision: effort.settings.revision, effort: accepted })).toMatchObject({ ok: true, settings: { effort: accepted, choices: allowed } });
  });
});
