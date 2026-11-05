import { describe, expect, it } from "vitest";
import path from "node:path";
import { antigravityEffortChoices, discoverAntigravityModels, parseAntigravityModels, preferredAntigravityModel } from "../src/codex/antigravity-models.js";

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
});
