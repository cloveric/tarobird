import path from "node:path";
import { CODEX_MODEL_CHOICES } from "../codex/model-capabilities.js";
import { antigravityEffortChoices, discoverAntigravityModels } from "../codex/antigravity-models.js";
import { readKimiModelConfig } from "../codex/kimi-models.js";
import { EFFORT_LEVELS } from "../state/config-file-schema.js";
import { CLAUDE_MODEL_CHOICES, getEngineEffortValidationError, type InstanceEngine } from "../state/instance-config.js";
import type { ModelSettings } from "../client-protocol/model.js";
import { discoverCliModels } from "./cli-model-discovery.js";
import { discoverPiModels } from "./pi-model-discovery.js";
import { discoverOmpModels } from "./omp-model-discovery.js";
import { discoverDeepSeekModels } from "./deepseek-model-discovery.js";
import { findDeepSeekModel } from "../codex/deepseek-models.js";

export function modelEffortChoices(engine: InstanceEngine, model: string, discovered: ModelSettings["choices"] = []): ModelSettings["customEfforts"] {
  if (engine === "deepseek") return findDeepSeekModel(discovered, model)?.efforts ?? [""];
  if (engine === "kimi" || engine === "claude" || engine === "codex" || engine === "pi" || engine === "omp") {
    const known = discovered.find(choice => choice.id === model);
    if (known) return known.efforts;
  }
  // Native Pi/omp model metadata is authoritative. Unknown models can follow their
  // native default, but must not advertise invented reasoning capabilities.
  if (engine === "pi" || engine === "omp") return [""];
  return engine === "antigravity" ? antigravityEffortChoices(discovered, model) : ["", ...EFFORT_LEVELS.filter(effort => !getEngineEffortValidationError(engine, effort, model || undefined))];
}
export type ModelCatalogRead = {
  choices: ModelSettings["choices"]; status?: "ready" | "no-models" | "unavailable";
  /** False when the engine did not answer and the choices are this release's fallback. */
  answered: boolean;
};
export type ModelCatalogOptions = {
  /** Skip the other engines' short-lived discovery caches, joining a read in
   * progress; the Hub's catalog cache owns their freshness. */
  reread?: boolean;
  /** DeepSeek's persistent catalog home. A managed Bot shares its Host's. */
  deepseekCatalogHome?: string;
};
/** The Host directory's DeepSeek catalog home, for the Hub and its Bot processes alike. */
export function deepseekCatalogHome(hostDirectory: string): string { return path.join(hostDirectory, "deepseek-catalog"); }
/** Creation and existing-Bot settings use the same host-owned catalog.
 * `fresh` keeps its DeepSeek meaning (a new read with the longer budget). */
export async function readModelCatalog(engine: InstanceEngine, env = process.env, cwd?: string, fresh = false, options: ModelCatalogOptions = {}): Promise<Omit<ModelCatalogRead, "answered">> {
  const { answered: _answered, ...catalog } = await readModelCatalogAnswer(engine, env, cwd, fresh, options);
  return catalog;
}
/** The same read, saying whether the engine answered or its fallback stands. */
export async function readModelCatalogAnswer(engine: InstanceEngine, env = process.env, cwd?: string, fresh = false, options: ModelCatalogOptions = {}): Promise<ModelCatalogRead> {
  const reread = options.reread ?? false;
  if (engine === "deepseek") {
    const catalogHome = options.deepseekCatalogHome ?? (env.TAROBOT_HOST_DIR?.trim() ? deepseekCatalogHome(env.TAROBOT_HOST_DIR.trim()) : undefined);
    const result = await discoverDeepSeekModels(env, cwd, fresh, catalogHome ? { catalogHome } : {}), selected = result.models.find(model => model.id === result.defaultModel);
    return { choices: [{ id: "", ...(selected ? { label: `${selected.provider} / ${selected.label}`, provider: selected.provider, modelId: selected.modelId } : {}), efforts: selected?.efforts ?? [""] }, ...result.models], status: result.status, answered: result.status !== "unavailable" };
  }
  if (engine === "pi") {
    const result = await (reread ? discoverPiModels(env, cwd, true) : discoverPiModels(env, cwd)), selected = result.models.find(model => model.id === result.defaultModel);
    return { choices: [{ id: "", ...(selected ? { label: selected.label } : {}), efforts: selected?.efforts ?? [""] }, ...result.models], status: result.status, answered: result.status !== "unavailable" };
  }
  if (engine === "omp") {
    const result = await (reread ? discoverOmpModels(env, cwd, true) : discoverOmpModels(env, cwd)), selected = result.models.find(model => model.id === result.defaultModel);
    return { choices: [{ id: "", ...(selected ? { label: selected.label } : {}), efforts: selected?.efforts ?? [""] }, ...result.models], status: result.status, answered: result.status !== "unavailable" };
  }
  return legacyModelCatalog(engine, env, reread);
}

export async function modelCatalog(engine: InstanceEngine, env = process.env, cwd?: string): Promise<ModelSettings["choices"]> {
  return (await readModelCatalog(engine, env, cwd)).choices;
}

async function legacyModelCatalog(engine: InstanceEngine, env: NodeJS.ProcessEnv, reread: boolean): Promise<ModelCatalogRead> {
  if (engine === "antigravity") { const models = await (reread ? discoverAntigravityModels(env, true) : discoverAntigravityModels(env)); return { choices: [{ id: "", efforts: [""] }, ...models], answered: models.length > 0 }; }
  if (engine === "kimi") {
    const config = await readKimiModelConfig(env);
    const current = config.models.find(model => model.id === config.defaultModel);
    return { answered: true, choices: [{ id: "", ...(config.defaultModel ? { label: current?.label ?? config.defaultModel } : {}), efforts: current?.efforts ?? modelEffortChoices(engine, "") },
      ...config.models.map(({ id, label, efforts }) => ({ id, ...(label ? { label } : {}), efforts }))] };
  }
  const fixed = ["", ...(engine === "codex" ? CODEX_MODEL_CHOICES : engine === "claude" ? CLAUDE_MODEL_CHOICES : [])].map(id => ({ id, efforts: modelEffortChoices(engine, id) }));
  if (engine !== "codex" && engine !== "claude") return { choices: fixed, answered: true };
  // Ask the installed CLI first, so a model it gained since this release is
  // offered and an alias shows the version it resolves to. Without an answer
  // the built-in list stands unchanged.
  const discovered = await (reread ? discoverCliModels(engine, env, true) : discoverCliModels(engine, env));
  if (!discovered) return { choices: fixed, answered: false };
  const choices: ModelSettings["choices"] = [{ id: "", ...(discovered.defaultLabel ? { label: discovered.defaultLabel } : {}), efforts: fixed[0]!.efforts }];
  for (const model of discovered.models) {
    if (!model.id || choices.some(choice => choice.id === model.id)) continue;
    // Offer only levels TaroBird will also run, so a choice is never dropped later.
    const allowed = modelEffortChoices(engine, model.id);
    choices.push({ id: model.id, ...(model.label ? { label: model.label } : {}), efforts: allowed.filter(level => level === "" || model.efforts.includes(level)) });
  }
  // Built-in entries the CLI did not list (e.g. "claude-opus-5-5[1m]") stay selectable.
  for (const choice of fixed) if (!choices.some(existing => existing.id === choice.id)) choices.push(choice);
  return { choices, answered: true };
}

/** What an engine offers when its catalog cannot be read in time: the same
 * choices an unanswered read yields, never another engine's or an invented list. */
export function fallbackModelCatalog(engine: InstanceEngine): ModelCatalogRead {
  if (engine === "deepseek" || engine === "pi" || engine === "omp") return { choices: [{ id: "", efforts: [""] }], status: "unavailable", answered: false };
  if (engine === "codex" || engine === "claude") return { choices: ["", ...(engine === "codex" ? CODEX_MODEL_CHOICES : CLAUDE_MODEL_CHOICES)].map(id => ({ id, efforts: modelEffortChoices(engine, id) })), answered: false };
  return { choices: [{ id: "", efforts: engine === "kimi" ? modelEffortChoices(engine, "") : [""] }], answered: false };
}
