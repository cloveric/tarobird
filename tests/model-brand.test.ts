import { describe, expect, it } from "vitest";
import { resolveModelBrand } from "../client/src/model-brand.js";
import { CODEX_MODEL_CHOICES } from "../src/codex/model-capabilities.js";
import { CLAUDE_MODEL_CHOICES } from "../src/state/instance-config.js";

describe("Bot model brand", () => {
  it.each([
    ["gpt-6-astra", "openai"], ["openai/o3-mini", "openai"], ["o1", "openai"], ["gpt-oss-120b", "openai"],
    ["gpt-6.1-sol", "openai"], ["openai/gpt-6-luna", "openai"], ["sol", "openai"], [" LUNA ", "openai"],
    ["openai/astra", "openai"], ["terra", "openai"], ["openai/sol", "openai"], ["openai/luna", "openai"],
    ["claude-opus-5-5[1m]", "claude"], ["anthropic/claude-sonnet-4.5", "claude"], ["sonnet", "claude"], ["us.anthropic.claude-opus-4-1:0", "claude"],
    ["Sonnet 4.6", "claude"], ["haiku", "claude"], ["anthropic/claude-haiku-4-5", "claude"],
    ["fable", "claude"], ["Fable5", "claude"], ["fable-5", "claude"], [" Fable 5 ", "claude"],
    ["anthropic/fable-5[1m]", "claude"], ["claude-fable-5", "claude"], ["us.anthropic.fable-5:0", "claude"],
    ["google/gemini-3.7-pro-high", "gemini"], ["DeepSeek-V4", "deepseek"], ["deepseek/deepseek-reasoner", "deepseek"],
    ["kimi-code/k3", "kimi"], ["moonshot-v1-128k", "kimi"], ["kimi-k2-thinking", "kimi"],
  ])("recognizes %s regardless of the runtime engine", (model, brand) => {
    expect(resolveModelBrand({ engine: "antigravity", model })).toEqual({ brand, source: "model" });
  });
  it.each([
    ...CODEX_MODEL_CHOICES.map(model => [model, "openai"]),
    ...CLAUDE_MODEL_CHOICES.map(model => [model, "claude"]),
  ])("covers the configured model catalog entry %s", (model, brand) => {
    expect(resolveModelBrand({ model })).toEqual({ brand, source: "model" });
  });
  it("only uses explicitly labelled engine fallback for an unspecified model", () => {
    expect(resolveModelBrand({ engine: "agy", model: "" })).toEqual({ brand: "gemini", source: "engine" });
    expect(resolveModelBrand({ engine: "codex", model: "auto" })).toEqual({ brand: "openai", source: "engine" });
    for (const model of ["my-gpt-alias", "sonnet-custom-router/proxy", "gptish", "o10", "qwen-3", "custom", "not-claude", "fabled", "fable5custom", "my-fable-alias", "fable-router/proxy", "solar", "lunar", "astral", "terraform", "sol-alias", "luna-router/proxy"]) expect(resolveModelBrand({ engine: "claude", model })).toBeUndefined();
    expect(resolveModelBrand()).toBeUndefined();
    expect(resolveModelBrand({ engine: "custom" })).toBeUndefined();
    expect(resolveModelBrand({ engine: "constructor" })).toBeUndefined();
  });
});
