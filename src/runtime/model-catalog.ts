import { CODEX_MODEL_CHOICES } from "../codex/model-capabilities.js";
import { antigravityEffortChoices, discoverAntigravityModels } from "../codex/antigravity-models.js";
import { readKimiModelConfig } from "../codex/kimi-models.js";
import { EFFORT_LEVELS } from "../state/config-file-schema.js";
import { CLAUDE_MODEL_CHOICES, getEngineEffortValidationError, type InstanceEngine } from "../state/instance-config.js";
import type { ModelSettings } from "../client-protocol/model.js";
import { discoverCliModels } from "./cli-model-discovery.js";

export function modelEffortChoices(engine: InstanceEngine, model: string, discovered: ModelSettings["choices"] = []): ModelSettings["customEfforts"] {
  if (engine === "kimi") {
    const known = discovered.find(choice => choice.id === model);
    if (known) return known.efforts;
  }
  return engine === "antigravity" ? antigravityEffortChoices(discovered, model) : ["", ...EFFORT_LEVELS.filter(effort => !getEngineEffortValidationError(engine, effort, model || undefined))];
}
/** Creation and existing-Bot settings use the same host-owned catalog. */
export async function modelCatalog(engine: InstanceEngine, env = process.env): Promise<ModelSettings["choices"]> {
  if (engine === "antigravity") return [{ id: "", efforts: [""] }, ...await discoverAntigravityModels(env)];
  if (engine === "kimi") {
    const config = await readKimiModelConfig(env);
    const current = config.models.find(model => model.id === config.defaultModel);
    return [{ id: "", ...(config.defaultModel ? { label: current?.label ?? config.defaultModel } : {}), efforts: current?.efforts ?? modelEffortChoices(engine, "") },
      ...config.models.map(({ id, label, efforts }) => ({ id, ...(label ? { label } : {}), efforts }))];
  }
  const fixed = ["", ...(engine === "codex" ? CODEX_MODEL_CHOICES : engine === "claude" ? CLAUDE_MODEL_CHOICES : [])].map(id => ({ id, efforts: modelEffortChoices(engine, id) }));
  if (engine !== "codex" && engine !== "claude") return fixed;
  // Ask the installed CLI first, so a model it gained since this release is
  // offered and an alias shows the version it resolves to. Without an answer
  // the built-in list stands unchanged.
  const discovered = await discoverCliModels(engine, env);
  if (!discovered) return fixed;
  const choices: ModelSettings["choices"] = [{ id: "", ...(discovered.defaultLabel ? { label: discovered.defaultLabel } : {}), efforts: fixed[0]!.efforts }];
  for (const model of discovered.models) {
    if (!model.id || choices.some(choice => choice.id === model.id)) continue;
    // Offer only levels TaroBird will also run, so a choice is never dropped later.
    const allowed = modelEffortChoices(engine, model.id);
    choices.push({ id: model.id, ...(model.label ? { label: model.label } : {}), efforts: allowed.filter(level => level === "" || model.efforts.includes(level)) });
  }
  // Built-in entries the CLI did not list (e.g. "claude-opus-5-5[1m]") stay selectable.
  for (const choice of fixed) if (!choices.some(existing => existing.id === choice.id)) choices.push(choice);
  return choices;
}
