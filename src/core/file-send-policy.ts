import { readFile } from "node:fs/promises";
import path from "node:path";
import { currentPermission } from "../state/permission-options.js";
import { readValidatedConfigFile } from "../state/instance-config.js";
import { parseCoreEnvFile } from "./env-parser.js";

const setting = (env: Record<string, string | undefined>) => env.TAROBOT_ALLOW_ANY_FILE_PATH ?? env.CCTB_LARK_ALLOW_ANY_FILE_PATH;

/** App and headless-host delivery share the Bot's effective permission. Read it
 * at delivery time: an earlier Bypass turn must not outlive a later downgrade.
 * An explicit zero can narrow full access; no env flag can widen a lesser mode.
 */
export async function appAnyFilePathAllowed(stateDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!stateDir) return false;
  try {
    const config = await readValidatedConfigFile(path.join(stateDir, "config.json"), { forExecution: true });
    if (currentPermission(config.engine ?? "codex", config) !== "bypass") return false;
    let value = setting(env);
    for (const name of ["bot.env", "lark.env"]) {
      if (value !== undefined) break;
      try { value = setting(parseCoreEnvFile(await readFile(path.join(stateDir, name), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return value === undefined || /^(?:1|true|yes|on)$/i.test(value.trim());
  } catch {
    // Unreadable/corrupt permissions never imply full access.
    return false;
  }
}
