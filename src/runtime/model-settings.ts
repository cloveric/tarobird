import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelErrorSchema, modelPatchSchema, type ModelSettings } from "../client-protocol/model.js";
import { ConfigFileSchema, type ConfigFile } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
import { normalizeModelCommandInput, type InstanceEngine } from "../state/instance-config.js";
import { modelCatalog, modelEffortChoices } from "./model-catalog.js";

async function readConfig(file: string): Promise<ConfigFile> {
  try { return ConfigFileSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("model_config_unreadable"); }
}
function snapshot(config: ConfigFile, engine: InstanceEngine, activeTurns: number, choices: ModelSettings["choices"]): ModelSettings {
  if ((config.engine ?? "codex") !== engine) throw new Error("model_engine_changed");
  const model = config.model?.trim() ?? "";
  const revision = createHash("sha256").update(JSON.stringify([engine, model, config.effort ?? null, config._clientEffortRevision ?? null])).digest("hex");
  const visible = choices.some(choice => choice.id === model) ? choices : [...choices, { id: model, efforts: modelEffortChoices(engine, model, choices) }];
  return { scope: "bot", revision, engine, model, effort: config.effort ?? "", choices: visible, customEfforts: modelEffortChoices(engine, ""), activeTurns };
}
/** Same config/mutex as /model. Persist model and its compatible effort together;
 * leave sessions and active workers intact for the next native task boundary. */
export async function modelSettings(stateDir: string, engine: InstanceEngine, activeTurns: number | (() => number), patch?: unknown) {
  const activeCount = () => typeof activeTurns === "function" ? activeTurns() : activeTurns;
  try {
    const choices = await modelCatalog(engine), file = path.join(stateDir, "config.json");
    const settings = await withFileMutex(file, async () => {
      const config = await readConfig(file), before = snapshot(config, engine, activeCount(), choices);
      if (patch === undefined) return before;
      const update = modelPatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("model_conflict");
      const model = normalizeModelCommandInput(engine, update.model), effort = update.effort ?? before.effort;
      const efforts = choices.find(choice => choice.id === model)?.efforts ?? modelEffortChoices(engine, model, choices);
      if (!efforts.includes(effort)) throw new Error("model_effort_incompatible");
      if (model === before.model && effort === before.effort) return before;
      if (model) config.model = model; else delete config.model;
      if (effort) config.effort = effort; else delete config.effort;
      // Shared revision nonce also invalidates an already-open effort picker.
      config._clientEffortRevision = randomUUID();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => undefined); }
      return snapshot(await readConfig(file), engine, activeCount(), choices);
    });
    return { ok: true as const, settings };
  } catch (error) {
    const code = modelErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!code.success) throw error;
    return { ok: false as const, error: code.data };
  }
}
