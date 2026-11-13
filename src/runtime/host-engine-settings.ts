import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { enginePathSchema, hostEngineSchema } from "../client-protocol/engine-settings.js";
import { discoverEngineDirectories } from "../host-cli/engine-discovery.js";

export const ENGINE_COMMANDS = { codex: "codex", claude: "claude", antigravity: "agy", kimi: "kimi", deepseek: "dsh" } as const;
export const ENGINE_ENV_KEYS = { codex: "CODEX_EXECUTABLE", claude: "CLAUDE_EXECUTABLE", antigravity: "ANTIGRAVITY_EXECUTABLE", kimi: "KIMI_EXECUTABLE", deepseek: "DSH_EXECUTABLE" } as const;
export const engineSettingsFile = (directory: string) => path.join(directory, "engine-settings.json");
export const storedEngineSettingsSchema = z.object({
  format: z.literal(1), revision: z.string().min(1).max(100), paths: z.partialRecord(hostEngineSchema, enginePathSchema),
  receipts: z.array(z.object({ requestId: z.string(), digest: z.string(), revision: z.string() })).max(32),
}).strict();
export type StoredEngineSettings = z.infer<typeof storedEngineSettingsSchema>;
/** Private local state. An invalid/unreadable file must not silently select a
 * different executable. No shell evaluation, credentials, or profile loading. */
export function readHostEngineSettings(directory: string): StoredEngineSettings {
  let fd: number, expected;
  try {
    const file = engineSettingsFile(directory); expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, revision: "default", paths: {}, receipts: [] }; throw new Error("engine_settings_unavailable"); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.size > 65536 || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw new Error();
    const bytes = Buffer.alloc(65537), size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 65536) throw new Error();
    const value = storedEngineSettingsSchema.parse(JSON.parse(bytes.subarray(0, size).toString("utf8")));
    if (Object.values(value.paths).some(file => !path.isAbsolute(file!))) throw new Error();
    return value;
  } catch { throw new Error("engine_settings_unavailable"); }
  finally { closeSync(fd); }
}
export function hostEngineEnvironment(directory: string, base: NodeJS.ProcessEnv, settings = readHostEngineSettings(directory)): NodeJS.ProcessEnv {
  // The entrypoint already built the baseline PATH. Do not prepend the desktop
  // defaults again: callers can deliberately supply an isolated environment.
  const env = { ...base }, home = process.platform === "win32" ? base.USERPROFILE ?? base.HOME : base.HOME ?? base.USERPROFILE;
  if (home && process.platform !== "win32") env.PATH = [...new Set([...(base.PATH ?? "").split(path.delimiter).filter(Boolean), ...discoverEngineDirectories(home, base, process.platform)])].join(path.delimiter);
  for (const engine of hostEngineSchema.options) if (settings.paths[engine]) env[ENGINE_ENV_KEYS[engine]] = settings.paths[engine];
  return env;
}
