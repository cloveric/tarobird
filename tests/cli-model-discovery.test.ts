import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeModels, parseCodexModels, resetModelDiscoveryCacheForTest } from "../src/runtime/cli-model-discovery.js";
import { modelCatalog } from "../src/runtime/model-catalog.js";

describe("installed CLI model discovery", () => {
  let root: string;
  beforeEach(async () => { resetModelDiscoveryCacheForTest(); root = await mkdtemp(path.join(os.tmpdir(), "tarobot-model-discovery-")); });
  afterEach(async () => { resetModelDiscoveryCacheForTest(); await rm(root, { recursive: true, force: true }); });
  const env = (extra: NodeJS.ProcessEnv) => ({ ...process.env, TAROBOT_MODEL_DISCOVERY: "1", FIXTURE_ARGS_FILE: path.join(root, "args.json"), ...extra });
  const builtIn = (engine: "claude" | "codex") => modelCatalog(engine, { ...process.env, TAROBOT_MODEL_DISCOVERY: "0" });
  const all = ["", "low", "medium", "high", "xhigh", "max"];

  it("lists Claude Code's own models and names what the default and each alias resolve to", async () => {
    const choices = await modelCatalog("claude", env({ CLAUDE_EXECUTABLE: path.resolve("tests/fixtures/claude-models.mjs") }));
    expect(choices.map(choice => [choice.id, choice.label ?? null])).toEqual([
      ["", "Fable 5.2"], ["opus", "Opus 5.5 (opus)"], ["fable", "Fable 5.2 (fable)"], ["haiku", "Haiku 5.5 (haiku)"],
      ["claude-fable-5-1", "Fable 5.1"], ["claude-fable-5-3", "Fable 5.3"],
      // Built-in entries the CLI did not list stay selectable.
      ["claude-opus-5-5[1m]", null], ["sonnet", null],
    ]);
    const efforts = (id: string) => choices.find(choice => choice.id === id)?.efforts;
    expect(efforts("fable")).toEqual(all);
    expect(efforts("claude-fable-5-3")).toEqual(["", "low", "high"]);
    // Only levels TaroBird also runs: its Haiku rule still allows no effort.
    expect(efforts("haiku")).toEqual([""]);
    // Read-only: a skipped-customisation initialize, never a prompt or a --model.
    const args = JSON.parse(await readFile(path.join(root, "args.json"), "utf8")) as string[];
    expect(args).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--safe-mode", "--no-chrome"]));
    expect(args).not.toContain("--model");
  });

  it("adds Codex models the CLI gained, offering only efforts TaroBird will run", async () => {
    const choices = await modelCatalog("codex", env({ CODEX_EXECUTABLE: path.resolve("tests/fixtures/codex-models.mjs") }));
    const fixed = (await builtIn("codex")).map(choice => choice.id).filter(id => id && !["gpt-6.1-sol", "gpt-6-luna"].includes(id));
    expect(choices.map(choice => choice.id)).toEqual(["", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-luna", ...fixed]);
    expect(choices.find(choice => choice.id === "gpt-6.2-sol")).toEqual({ id: "gpt-6.2-sol", label: "GPT-6.2-Sol", efforts: ["", "low", "medium", "high", "xhigh"] });
    expect(choices.find(choice => choice.id === "gpt-6.1-sol")?.efforts).toEqual([...all, "ultra"]);
    expect(choices.find(choice => choice.id === "gpt-6-luna")?.efforts).toEqual(all);
    expect(choices.some(choice => choice.id === "gpt-internal")).toBe(false);
    expect(JSON.parse(await readFile(path.join(root, "args.json"), "utf8"))).toEqual(["app-server"]);
  });

  it("keeps the built-in list when the CLI is missing or discovery is off", async () => {
    expect(await modelCatalog("claude", env({ CLAUDE_EXECUTABLE: path.join(root, "missing-claude") }))).toEqual(await builtIn("claude"));
    expect(await modelCatalog("codex", { ...env({ CODEX_EXECUTABLE: path.resolve("tests/fixtures/codex-models.mjs") }), TAROBOT_MODEL_DISCOVERY: "0" })).toEqual(await builtIn("codex"));
    await expect(readFile(path.join(root, "args.json"), "utf8")).rejects.toThrow();
  });

  it("ignores malformed rows", () => {
    expect(parseClaudeModels(undefined)).toEqual({ models: [] });
    expect(parseClaudeModels({ models: [{ value: "x\ny" }, { value: "default" }, { value: "ok", displayName: "\u0007" }] })).toEqual({ models: [{ id: "ok", efforts: [""] }] });
    expect(parseCodexModels([null, { model: "a b" }, { model: "ok", supportedReasoningEfforts: ["high", "bogus"] }])).toEqual({ models: [{ id: "ok", efforts: ["", "high"] }] });
  });
});
