import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { permissionErrorSchema, permissionPatchSchema, type PermissionSettings } from "../client-protocol/permissions.js";
import { applyPermission, currentPermission, defaultPermission, permissionOptions } from "../state/permission-options.js";
import { ConfigFileSchema, type ConfigFile } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
import { type InstanceEngine } from "../state/instance-config.js";

async function readConfig(file: string): Promise<ConfigFile> {
  // A settings picker must never repair/reset a damaged config or expose its secrets.
  try { return ConfigFileSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("permissions_config_unreadable"); }
}
function snapshot(config: ConfigFile, runtimeEngine: InstanceEngine, activeTurns: number): PermissionSettings {
  const engine = config.engine ?? "codex";
  if (engine !== runtimeEngine) throw new Error("permissions_engine_changed");
  const revision = createHash("sha256").update(JSON.stringify([engine, config.approvalMode ?? null, config.claudePermissionMode ?? null, config.kimiAutoNeverAskAcknowledged ?? null, config.codexRuntime ?? null, config._clientPermissionsRevision ?? null])).digest("hex");
  return { scope: "bot", revision, engine, choice: currentPermission(engine, config), defaultChoice: defaultPermission(engine), choices: permissionOptions(engine, config.codexRuntime), activeTurns };
}
/** Same Bot-level config and file mutex as other settings. Never touches session bindings
 * or live workers: each native adapter reads this at its next safe boundary. */
export async function permissionSettings(stateDir: string, engine: InstanceEngine, activeTurns: number | (() => number), patch?: unknown) {
  try {
    const countActive = typeof activeTurns === "function" ? activeTurns : () => activeTurns;
    const file = path.join(stateDir, "config.json");
    const settings = await withFileMutex(file, async () => {
      const config = await readConfig(file), before = snapshot(config, engine, countActive());
      if (patch === undefined) return before;
      const update = permissionPatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("permissions_conflict");
      if (!before.choices.some(option => option.id === update.choice)) throw new Error("permissions_incompatible");
      if (countActive() > 0) throw new Error("permissions_busy");
      applyPermission(config, engine, update.choice);
      config._clientPermissionsRevision = randomUUID();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        // A new run can start while this request waits for the file mutex or
        // writes the temporary file. Never rely on the RPC's old idle snapshot.
        if (countActive() > 0) throw new Error("permissions_busy");
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => undefined); }
      return snapshot(await readConfig(file), engine, countActive());
    });
    return { ok: true as const, settings };
  } catch (error) {
    const code = permissionErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!code.success) throw error;
    return { ok: false as const, error: code.data };
  }
}
