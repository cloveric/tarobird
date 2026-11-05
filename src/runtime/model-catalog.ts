import { CODEX_MODEL_CHOICES } from "../codex/model-capabilities.js";
import { antigravityEffortChoices, discoverAntigravityModels } from "../codex/antigravity-models.js";
import { readKimiModelConfig } from "../codex/kimi-models.js";
import { EFFORT_LEVELS } from "../state/config-file-schema.js";
import { CLAUDE_MODEL_CHOICES, getEngineEffortValidationError, type InstanceEngine } from "../state/instance-config.js";
import type { ModelSettings } from "../client-protocol/model.js";

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
  return ["", ...(engine === "codex" ? CODEX_MODEL_CHOICES : engine === "claude" ? CLAUDE_MODEL_CHOICES : [])].map(id => ({ id, efforts: modelEffortChoices(engine, id) }));
}
