import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCoreEnvFile, parseCoreEnvExtras, CORE_BRIDGE_RUNTIME_ENV_KEYS } from "../core/env-parser.js";
import { parseIntegrationEnvironment } from "../runtime/integration-environment.js";

export const GATEWAY_LEGACY_IDENTITY_KEYS = ["CCTB_LARK_STATE_DIR", "CODEX_TELEGRAM_STATE_DIR", "CCTB_LARK_INSTANCE", "CODEX_TELEGRAM_INSTANCE", "TAROCUB_INSTANCE", "CCTB_LARK_ACTIVE_TURN", "CCTB_LARK_ACTIVE_INSTANCE", "CCTB_LARK_ACTIVE_STATE_DIR"] as const;
const SETTING_ALIASES = { TAROBOT_ALLOW_ANY_FILE_PATH: "CCTB_LARK_ALLOW_ANY_FILE_PATH", TAROBOT_INBOUND_FILE_RETENTION_DAYS: "LARK_INBOUND_FILE_RETENTION_DAYS", TAROBOT_ELEMENT_STREAM: "CCTB_LARK_ELEMENT_STREAM" } as const;
function canonicalSettings<T extends Record<string, string | undefined>>(source: T): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = { ...source };
  for (const [key, old] of Object.entries(SETTING_ALIASES)) { if (values[key] === undefined && values[old] !== undefined) values[key] = values[old]; delete values[old]; }
  return values;
}

/** Explicit Bot state only. Historical lark.env and shared credentials remain read-compatible. */
export async function loadGatewayEnvironment(stateDir: string, botId: string, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
 const identity = { TAROBOT_STATE_DIR: stateDir, TAROBOT_INSTANCE: botId };
 const result: NodeJS.ProcessEnv = { ...canonicalSettings(base), ...identity };
 // Never inherit another Bot or optional adapter's identity into an App worker.
 for (const key of GATEWAY_LEGACY_IDENTITY_KEYS) delete result[key];
 for (const key of ["TAROBOT_SEARCH_CREDENTIAL_FALLBACK", "TAROBOT_MESSAGE_ID", "TAROBOT_ACTIVE_TURN", "TAROBOT_ACTIVE_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR"]) delete result[key];
 const home = base.HOME ?? base.USERPROFILE;
 const files = [path.join(stateDir, "bot.env"), path.join(stateDir, "lark.env"), ...(home ? [path.join(home, ".tarobot", "integrations.env"), path.join(home, ".cctb", "shared.env")] : [])];
 for (const [index, file] of files.entries()) {
  let text: string; try { text = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  const values = parseCoreEnvExtras(text);
  // These are operator-owned runtime settings, never arbitrary process controls.
  if (index < 3) Object.assign(values, parseIntegrationEnvironment(text));
  if (index < 2) { const settings = parseCoreEnvFile(text); for (const key of CORE_BRIDGE_RUNTIME_ENV_KEYS) if (settings[key] !== undefined) values[key] = settings[key]; }
  for (const [key, value] of Object.entries(canonicalSettings(values))) if (result[key] === undefined) result[key] = value;
 }
 return result;
}
