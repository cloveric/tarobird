import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readKimiModelConfig } from "../src/codex/kimi-models.js";
import { modelCatalog } from "../src/runtime/model-catalog.js";
import { modelChoiceSchema } from "../src/client-protocol/model.js";
import { kimiModelConfig } from "./fixtures/kimi-model-config.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "kimi-models-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const save = (text: string) => writeFile(path.join(root, "config.toml"), text);
it("discovers exact native IDs, labels, per-model efforts/defaults without exposing credentials", async () => {
  await save(kimiModelConfig);
  const native = await readKimiModelConfig({}, root);
  expect(native.defaultModel).toBe("kimi-code/k3.1-pro");
  expect(native.models.map(model => model.defaultThinking)).toEqual(["high", "max", "on"]);
  const catalog = await modelCatalog("kimi", { KIMI_CODE_HOME: root });
  expect(catalog).toEqual([
    { id: "", label: "K3.1 Pro", efforts: ["", "low", "high", "max"] },
    { id: "kimi-code/k3", label: "K3", efforts: ["", "low", "high", "max"] },
    { id: "kimi-code/k3.1-pro", label: "K3.1 Pro", efforts: ["", "low", "high", "max"] },
    { id: "kimi-code/kimi-for-coding-highspeed", label: "K2.7 Code Highspeed", efforts: [""] },
  ]);
  expect(() => catalog.map(value => modelChoiceSchema.parse(value))).not.toThrow();
  expect(JSON.stringify(native) + JSON.stringify(catalog)).not.toMatch(/fixture-secret|api_key|providers/);
  await save(kimiModelConfig.replace('default_model = "kimi-code/k3.1-pro"', 'default_model = "kimi-code/kimi-for-coding-highspeed"'));
  expect((await modelCatalog("kimi", { KIMI_CODE_HOME: root }))[0]).toEqual({ id: "", label: "K2.7 Code Highspeed", efforts: [""] });
});
it.each(["", "invalid [ toml", 'default_model = "legacy-model"', "x".repeat(1024 * 1024 + 1)])("handles old or unreadable metadata without inventing model defaults (%#)", async text => {
  await save(text);
  const native = await readKimiModelConfig({}, root);
  expect(native.models).toEqual([]);
  expect(native.defaultModel).toBe(text.includes("legacy-model") ? "legacy-model" : undefined);
});
it("allows symlinks and leaves unadvertised effort/default metadata unknown", async () => {
  await writeFile(path.join(root, "linked.toml"), 'default_model="custom"\n[models.custom]\nmodel="native"\nprovider="custom"\nsupport_efforts=["high", "future"]\ndefault_effort="future"\n');
  await symlink(path.join(root, "linked.toml"), path.join(root, "config.toml"));
  expect(await readKimiModelConfig({}, root)).toEqual({ defaultModel: "custom", models: [{ id: "custom", efforts: ["", "high"] }] });
});
it("honors disabled native thinking only for models that allow it", async () => {
  await save(kimiModelConfig.replace("enabled = true", "enabled = false"));
  expect((await readKimiModelConfig({}, root)).models[1]?.defaultThinking).toBe("max");
  await save(kimiModelConfig.replace("enabled = true", "enabled = false").replaceAll('["thinking", "always_thinking"]', '["thinking"]'));
  expect((await readKimiModelConfig({}, root)).models[1]?.defaultThinking).toBe("off");
});
