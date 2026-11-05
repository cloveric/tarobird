import { describe, expect, it } from "vitest";
import { modelOptionLabel, modelOptions, selectedModelOption, selectedModelEffort, selectModel, selectModelEffort, modelEffortPreset } from "../client/src/model-selection.js";
import { parseAntigravityModels } from "../src/codex/antigravity-models.js";

const catalog = parseAntigravityModels([
  "argon-medium\tArgon (Medium)", "argon-high\tArgon (High)", "argon-low\tArgon (Low)",
  "flash-high\tFlash (High)", "flash-low\tFlash (Low)", "fixed-medium\tFixed (Medium)",
  "advanced-xhigh\tAdvanced (Xhigh)", "advanced-max\tAdvanced (Max)", "custom-high\tCustom model",
].join("\n"));
const options = modelOptions("antigravity", [{ id: "", efforts: [""] }, ...catalog]);
describe("model and effort selection", () => {
  it("distinguishes following Kimi's resolved default from pinning the same model", () => {
    expect(modelOptionLabel({ id: "", label: "K3.1 Pro" }, "引擎默认模型")).toBe("引擎默认模型 · K3.1 Pro");
    expect(modelOptionLabel({ id: "kimi-code/k3.1-pro", label: "K3.1 Pro" }, "引擎默认模型")).toBe("K3.1 Pro");
    expect(modelOptionLabel({ id: "" }, "引擎默认模型")).toBe("引擎默认模型");
  });
  it("groups variants while retaining exact, family-specific capabilities and real IDs", () => {
    expect(options.map(option => [option.id, option.label, option.efforts])).toEqual([
      ["", undefined, [""]], ["argon-medium", "Argon", ["low", "medium", "high"]],
      ["flash-high", "Flash", ["low", "high"]], ["fixed-medium", "Fixed", ["medium"]],
      ["advanced-xhigh", "Advanced", ["xhigh", "max"]], ["custom-high", "Custom model", ["", "high"]],
    ]);
    expect(selectedModelOption(options, "argon-high")?.id).toBe("argon-medium");
  });
  it("reads preset or explicit effort without changing existing stored settings", () => {
    const original = { model: "argon-high", effort: "" as const };
    const option = selectedModelOption(options, original.model);
    expect(selectedModelEffort(option, original)).toBe("high");
    expect(selectedModelEffort(option, { ...original, effort: "low" })).toBe("low");
    expect(selectedModelEffort(option, { ...original, effort: "xhigh" })).toBe("xhigh");
    expect(original).toEqual({ model: "argon-high", effort: "" });
  });
  it("keeps supported effort when switching families, otherwise chooses an advertised preset", () => {
    expect(selectModel(options, "flash-high", { model: "argon-low", effort: "" })).toEqual({ model: "flash-low", effort: "low" });
    expect(selectModel(options, "flash-high", { model: "argon-medium", effort: "medium" })).toEqual({ model: "flash-high", effort: "high" });
    expect(selectModel(options, "fixed-medium", { model: "advanced-max", effort: "max" })).toEqual({ model: "fixed-medium", effort: "medium" });
    expect(selectModel(options, "", { model: "flash-high", effort: "high" })).toEqual({ model: "", effort: "" });
  });
  it("maps every supported level to an advertised variant and refuses missing ones", () => {
    for (const option of options.filter(value => value.variants)) for (const effort of option.efforts) {
      const result = selectModelEffort(option, option.id, effort)!;
      expect(catalog.find(choice => choice.id === result.model)?.efforts).toContain(effort);
      expect(result.model).toBe(`${option.id.replace(/-[^-]+$/, "")}-${effort}`);
    }
    const flash = selectedModelOption(options, "flash-high");
    for (const effort of ["", "medium", "xhigh", "max", "ultra"] as const) expect(selectModelEffort(flash, "flash-high", effort)).toBeUndefined();
  });
  it("does not group other engines, custom labels, incomplete or conflicting families", () => {
    expect(modelOptions("claude", catalog)).toEqual(catalog);
    for (const rows of [
      [{ id: "flash-high", label: "Flash (High)", efforts: ["", "high"] as const }, { id: "flash-low", label: "Other (Low)", efforts: ["", "low"] as const }],
      [{ id: "flash-high", label: "Flash (High)", efforts: ["", "high"] as const }, { id: "flash", efforts: [""] as const }],
      [{ id: "flash-high", label: "Flash (High)", efforts: [""] as const }],
    ]) {
      const choices = rows.map(row => ({ ...row, efforts: [...row.efforts] }));
      expect(modelOptions("antigravity", choices)).toEqual(choices);
    }
  });
  it("uses only confirmed presets in the separate effort control", () => {
    expect(modelEffortPreset("antigravity", "gemini-flash-high", ["", "low", "high"])).toEqual({ model: "gemini-flash", effort: "high" });
    expect(modelEffortPreset("antigravity", "unknown-high", [""])).toBeUndefined();
    expect(modelEffortPreset("antigravity", "custom-high", ["", "high"])).toBeUndefined();
    expect(modelEffortPreset("claude", "claude-opus-high", ["", "high"])).toBeUndefined();
    expect(modelOptions("antigravity", [{ id: "future", efforts: ["", "turbo"] }])[0]?.efforts).toEqual([""]);
  });
});
