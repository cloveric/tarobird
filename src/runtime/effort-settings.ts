import { modelCatalog, modelEffortChoices } from "./model-catalog.js";
import type { ModelSettings } from "../client-protocol/model.js";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { effortErrorSchema, effortPatchSchema, type EffortSettings } from "../client-protocol/effort.js";
import { ConfigFileSchema, type ConfigFile } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
import type { InstanceEngine } from "../state/instance-config.js";

async function readConfig(file: string): Promise<ConfigFile> {
  // A settings picker must never repair/reset a damaged config or expose its secrets.
  try { return ConfigFileSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("effort_config_unreadable"); }
}
function snapshot(config: ConfigFile, runtimeEngine: InstanceEngine, activeTurns: number, models: ModelSettings["choices"]): EffortSettings {
  const engine = config.engine ?? "codex", model = config.model?.trim() ?? "";
  if (engine !== runtimeEngine) throw new Error("effort_engine_changed");
  const choices = modelEffortChoices(engine, model, models);
  const revision = createHash("sha256").update(JSON.stringify([engine, model, config.effort ?? null, config._clientEffortRevision ?? null])).digest("hex");
  return { scope: "bot", revision, engine, model, effort: config.effort ?? "", choices, activeTurns };
}
/** Same Bot-level config and file mutex as /effort. Never touches session bindings
 * or live workers: each native adapter reads this at its next safe boundary. */
export async function effortSettings(stateDir: string, engine: InstanceEngine, activeTurns: number | (() => number), patch?: unknown) {
  const activeCount = () => typeof activeTurns === "function" ? activeTurns() : activeTurns;
  try {
    const models = await modelCatalog(engine);
    const file = path.join(stateDir, "config.json");
    const settings = await withFileMutex(file, async () => {
      const config = await readConfig(file), before = snapshot(config, engine, activeCount(), models);
      if (patch === undefined) return before;
      const update = effortPatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("effort_conflict");
      if (!before.choices.includes(update.effort)) throw new Error("effort_incompatible");
      if (update.effort === before.effort) return before;
      if (update.effort) config.effort = update.effort; else delete config.effort;
      config._clientEffortRevision = randomUUID();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => undefined); }
      return snapshot(await readConfig(file), engine, activeCount(), models);
    });
    return { ok: true as const, settings };
  } catch (error) {
    const code = effortErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!code.success) throw error;
    return { ok: false as const, error: code.data };
  }
}
