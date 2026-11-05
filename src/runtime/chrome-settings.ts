import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromeErrorSchema, chromePatchSchema, type ChromeSettings } from "../client-protocol/chrome.js";
import { ConfigFileSchema, type ConfigFile } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
import type { InstanceEngine } from "../state/instance-config.js";

async function readConfig(file: string): Promise<ConfigFile> {
  try { return ConfigFileSchema.parse(JSON.parse(await readFile(file, "utf8"))); }
  catch { throw new Error("chrome_config_unreadable"); }
}
function snapshot(config: ConfigFile, runtimeEngine: InstanceEngine, activeTurns: number): ChromeSettings {
  const engine = config.engine ?? "codex";
  if (engine !== runtimeEngine) throw new Error("chrome_engine_changed");
  if (engine !== "claude") throw new Error("chrome_unsupported");
  const enabled = config.claudeChrome === true;
  const revision = createHash("sha256").update(JSON.stringify([engine, enabled, config._clientChromeRevision ?? null])).digest("hex");
  return { scope: "bot", engine, enabled, revision, activeTurns };
}
/** Changes only this Bot's launch policy, never the shared Claude/Chrome profile.
 * Native workers apply it between turns while retaining their session ID. */
export async function chromeSettings(stateDir: string, engine: InstanceEngine, activeTurns: number | (() => number), patch?: unknown) {
  const activeCount = () => typeof activeTurns === "function" ? activeTurns() : activeTurns;
  try {
    const file = path.join(stateDir, "config.json");
    const settings = await withFileMutex(file, async () => {
      const config = await readConfig(file), before = snapshot(config, engine, activeCount());
      if (patch === undefined) return before;
      const update = chromePatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("chrome_conflict");
      if (update.enabled === before.enabled) return before;
      config.claudeChrome = update.enabled;
      config._clientChromeRevision = randomUUID();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally { await unlink(temporary).catch(() => undefined); }
      return snapshot(await readConfig(file), engine, activeCount());
    });
    return { ok: true as const, settings };
  } catch (error) {
    const code = chromeErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!code.success) throw error;
    return { ok: false as const, error: code.data };
  }
}
