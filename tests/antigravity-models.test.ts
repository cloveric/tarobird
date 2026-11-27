import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ANTIGRAVITY_MODELS_TIMEOUT_MS, antigravityEffortChoices, discoverAntigravityModels, parseAntigravityModels, preferredAntigravityModel } from "../src/codex/antigravity-models.js";

describe("Antigravity provider model capabilities", () => {
  it("keeps concrete model effort fixed while collecting advertised family aliases", () => {
    const models = parseAntigravityModels("Fetching available models...\n\x1b[32mflash-high\tFlash High\x1b[0m\nflash-low\tFlash Low\npro-xhigh\tPro Xhigh\nflash-high\tDuplicate\nunknown\tOpaque model\ncredential: value\n");
    expect(models.map((m) => m.id)).toEqual(["flash-high", "flash-low", "pro-xhigh", "unknown"]);
    expect(models[0]?.label).toBe("Flash High");
    expect(antigravityEffortChoices(models, "flash-high")).toEqual(["", "high"]);
    expect(antigravityEffortChoices(models, "flash")).toEqual(["", "low", "high"]);
    expect(antigravityEffortChoices(models, "pro-xhigh")).toEqual(["", "xhigh"]);
    expect(antigravityEffortChoices(models, "unknown")).toEqual([""]);
    expect(antigravityEffortChoices(models, "")).toEqual([""]);
    expect(antigravityEffortChoices(models, "not-listed")).toEqual([""]);
  });
  it("coalesces CLI discovery and returns only its model table", async () => {
    const env = { ...process.env, ANTIGRAVITY_EXECUTABLE: path.resolve("tests/fixtures/agy-models.mjs") };
    const first = discoverAntigravityModels(env), second = discoverAntigravityModels({ ...env });
    expect(second).toBe(first);
    const models = await first;
    expect(preferredAntigravityModel(models)).toBe("gemini-4-argon-medium");
    for (const level of ["low", "medium", "high"]) {
      expect(models.find(model => model.id === `gemini-4-argon-${level}`)).toMatchObject({
        label: `Gemini 4 Argon (${level[0]!.toUpperCase()}${level.slice(1)})`, efforts: ["", level],
      });
    }
    expect(antigravityEffortChoices(await first, "gemini-3.8-flash-high")).toEqual(["", "high"]);
  });
  it("fails conservatively without stderr leakage or guessed capability", async () => {
    expect(await discoverAntigravityModels({ PATH: "", ANTIGRAVITY_EXECUTABLE: "/missing/agy" })).toEqual([]);
    expect(preferredAntigravityModel([])).toBe("");
    expect(preferredAntigravityModel([{ id: "gemini-3.8-flash-medium" }, { id: "gemini-4-argon-high" }])).toBe("");
  });
  it("gives Antigravity model discovery at least 15s and keeps Hub RPC and client budgets above it", async () => {
    const { BOT_MODEL_SETTINGS_RPC_TIMEOUT_MS } = await import("../src/hub/server.js");
    const { BOT_SETTINGS_REQUEST_TIMEOUT_MS } = await import("../client/src/bot-settings-request.js");
    expect(ANTIGRAVITY_MODELS_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
    expect(BOT_MODEL_SETTINGS_RPC_TIMEOUT_MS - ANTIGRAVITY_MODELS_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
    expect(BOT_SETTINGS_REQUEST_TIMEOUT_MS - BOT_MODEL_SETTINGS_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(2_000);
  });
  it("loads a slow `agy models` response within the timeout budget and falls back cleanly when exceeded", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agy-slow-models-"));
    try {
      const script = path.join(dir, "slow-agy.mjs");
      await writeFile(script, `#!/usr/bin/env node\nsetTimeout(() => { console.log("gemini-4-argon-medium\\tGemini 4 Argon (Medium)"); }, 150);\n`, "utf8");
      await chmod(script, 0o755);
      const env = { ...process.env, ANTIGRAVITY_EXECUTABLE: script };
      expect(await discoverAntigravityModels(env, true, 40)).toEqual([]);
      const loaded = await discoverAntigravityModels(env, true, 2_000);
      expect(loaded.map((m) => m.id)).toEqual(["gemini-4-argon-medium"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
