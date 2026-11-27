import { resolvePiExecutable } from "../runtime/pi-executable.js";
import { resolveOmpExecutable } from "../runtime/omp-executable.js";
import { ENGINE_SETTINGS_REPAIR_HINT, type EngineDiscoveryRule } from "../client-protocol/engine-settings.js";
import path from "node:path";
import {
  ENGINE_COMMANDS,
  ENGINE_ENV_KEYS,
  hostEngineEnvironment,
  readEngineDiscoveryCache,
  readHostEngineSettings,
  resolveDiscoveredEngines,
  type EngineDiscoveryCache,
  type StoredEngineSettings,
} from "../runtime/host-engine-settings.js";
import { isLiveHostEnvironment, markLiveHostEnvironment, refreshWindowsRegistryPath } from "../runtime/windows-registry-path.js";
import { readHubConfig } from "../hub/config.js";
import { inspectHubService } from "../hub/service.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { deepseekExecutableOverride, resolveDeepSeekExecutable } from "../runtime/deepseek-executable.js";
import {
  diagnoseExecutableCandidates,
  lookupEnvCaseInsensitive,
  probeExecutableVersion,
  runEnvironmentDiscovery,
  SHELL_ENV_PROBE_FLAG,
  type CommandRunner,
  type DanglingLinkInfo,
  type TaggedDirectory,
} from "./engine-discovery.js";
import { HubDatabase } from "../hub/database.js";
import { exists, resolveDesktopHostDirectory } from "./paths.js";
import { readHostProfile } from "./setup.js";
import { managedServiceStatus, managedServiceEnvironmentDifferences, type ManagedServiceStatus } from "./service-manager.js";
import { buildHostEnvironment, HOST_ENGINE_EXECUTABLE_KEYS, HOST_PRESERVED_ENVIRONMENT_KEYS } from "./environment.js";
import { LocalHostClient } from "./client.js";
import { HostDirectoryError } from "./windows-state-admission.js";
import { HostManagement } from "./management.js";

const DISCOVERY_METADATA_KEYS_UNIX = [
  "SHELL",
  "ZDOTDIR",
  "NVM_DIR",
  "VOLTA_HOME",
  "BUN_INSTALL",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "FNM_DIR",
  "XDG_DATA_HOME",
  SHELL_ENV_PROBE_FLAG,
] as const;

const DISCOVERY_METADATA_KEYS_WINDOWS = [
  "SystemRoot",
  "WINDIR",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "SCOOP",
  "PNPM_HOME",
  "VOLTA_HOME",
  "NVM_SYMLINK",
  "NVM_HOME",
  "ChocolateyInstall",
  "CARGO_HOME",
  "SystemDrive",
  "HOMEDRIVE",
  "HOMEPATH",
  "ALLUSERSPROFILE",
  "ProgramData",
  SHELL_ENV_PROBE_FLAG,
] as const;

function validCallerHome(env: NodeJS.ProcessEnv, platform = process.platform): string | undefined {
  const windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const raw = windows
    ? lookupEnvCaseInsensitive(env, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(env, "HOME", "win32")
    : env.HOME;
  if (!raw || /[\x00-\x1f\x7f]/.test(raw)) return undefined;
  const isAbs = windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(raw) : p.isAbsolute(raw);
  return isAbs ? raw : undefined;
}

/** Retain safe shell/package-manager/Windows-expansion discovery variables from
 * the caller env without adopting rejected proxy or config-directory values. */
export function mergeDiscoveryMetadata(
  hostEnv: NodeJS.ProcessEnv,
  callerEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...hostEnv };
  const keys = platform === "win32" ? DISCOVERY_METADATA_KEYS_WINDOWS : DISCOVERY_METADATA_KEYS_UNIX;
  for (const key of keys) {
    if (lookupEnvCaseInsensitive(merged, key, platform) !== undefined) continue;
    const raw = lookupEnvCaseInsensitive(callerEnv, key, platform);
    if (raw && !/[\x00-\x1f\x7f]/.test(raw)) merged[key] = raw;
  }
  return isLiveHostEnvironment(callerEnv) ? markLiveHostEnvironment(merged) : merged;
}

export type InspectedEngine = {
  engine: "codex" | "claude" | "pi" | "omp" | "antigravity" | "kimi" | "deepseek";
  installed: boolean;
  executable?: string;
  version?: string | null;
  rule?: EngineDiscoveryRule | null;
  danglingLinks?: DanglingLinkInfo[];
  terminalExecutable?: string | null;
  searchedDirectories?: string[];
  authentication: "unverified";
};

export function inspectEngines(
  env: NodeJS.ProcessEnv = process.env,
  context?: { baseEnv?: NodeJS.ProcessEnv; settings?: StoredEngineSettings; discoveryCache?: EngineDiscoveryCache },
): InspectedEngine[] {
  const platform = process.platform, windows = platform === "win32", sep = windows ? ";" : ":", p = windows ? path.win32 : path.posix;
  const pathDirs = (lookupEnvCaseInsensitive(env, "PATH", platform) ?? "").split(sep).filter(Boolean);
  const taggedDirs: TaggedDirectory[] = pathDirs.map((dir) => ({ dir, rule: "path" }));
  const explicitEnv = context?.baseEnv ?? env;
  return ([
    ["codex", env.CODEX_EXECUTABLE || "codex"], ["claude", env.CLAUDE_EXECUTABLE || "claude"],
    ["pi", resolvePiExecutable(env, platform)],
    ["omp", resolveOmpExecutable(env, platform)],
    ["antigravity", env.ANTIGRAVITY_EXECUTABLE || "agy"], ["kimi", env.KIMI_EXECUTABLE || "kimi"],
    ["deepseek", resolveDeepSeekExecutable(env, platform)],
  ] as const).map(([engine, command]) => {
    const hasManual = !!context?.settings?.paths[engine];
    const explicit = engine === "deepseek"
      ? deepseekExecutableOverride(explicitEnv, platform) !== undefined
      : !!lookupEnvCaseInsensitive(explicitEnv, ENGINE_ENV_KEYS[engine], platform);
    const remembered = !hasManual && !explicit ? context?.discoveryCache?.paths[engine] : undefined;
    const diagnosed = diagnoseExecutableCandidates(command, taggedDirs, env, platform);
    const executable = diagnosed.executable ?? resolveEngineExecutable(command, env, platform);
    let rule: EngineDiscoveryRule | null = null;
    if (executable) {
      if (hasManual) rule = "setting";
      else if (explicit) rule = "environment";
      else if (remembered && executable === remembered) rule = "auto-discovered";
      else if (diagnosed.rule) rule = diagnosed.rule;
      else if (p.isAbsolute(command)) rule = "known-directory";
      else rule = "path";
    }
    return {
      engine,
      installed: !!executable,
      ...(executable ? { executable } : {}),
      rule,
      ...(diagnosed.danglingLinks.length ? { danglingLinks: diagnosed.danglingLinks } : {}),
      ...(!executable ? { searchedDirectories: pathDirs } : {}),
      authentication: "unverified" as const,
    };
  });
}

export async function inspectEnginesWithDiscovery(
  directory: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { forceRefresh?: boolean; runner?: CommandRunner; timeoutMs?: number } = {},
): Promise<InspectedEngine[]> {
  const settings = readHostEngineSettings(directory);
  const platform = process.platform, windows = platform === "win32";
  const cache = readEngineDiscoveryCache(directory, platform);
  const home = windows
    ? lookupEnvCaseInsensitive(baseEnv, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(baseEnv, "HOME", "win32") ?? ""
    : baseEnv.HOME ?? baseEnv.USERPROFILE ?? "";

  const probe = await runEnvironmentDiscovery({
    baseEnv,
    commands: Object.values(ENGINE_COMMANDS),
    home: home || undefined,
    platform,
    forceRefresh: options.forceRefresh,
    runner: options.runner,
    timeoutMs: options.timeoutMs,
  });
  const resolved = resolveDiscoveredEngines({
    directory,
    base: baseEnv,
    settings,
    cache,
    probe,
    platform,
  });

  return Promise.all(resolved.engines.map(async (row) => {
    const version = row.executable
      ? await probeExecutableVersion(row.executable, resolved.enhancedEnv, options.runner, { forceRefresh: options.forceRefresh })
      : null;
    return {
      engine: row.id,
      installed: row.available,
      ...(row.executable ? { executable: row.executable } : {}),
      version,
      rule: row.rule,
      ...(row.danglingLinks.length ? { danglingLinks: row.danglingLinks } : {}),
      ...(row.showTerminalDiff && row.terminalExecutable ? { terminalExecutable: row.terminalExecutable } : {}),
      ...(!row.executable ? { searchedDirectories: resolved.mergedDirs.map(item => item.dir) } : {}),
      authentication: "unverified" as const,
    };
  }));
}

/** Read-only inspection. No new identity, DB migrations, engine execution or login. */
export async function inspectHost(directory: string, env: NodeJS.ProcessEnv = process.env, inspectLiveEngines = false) {
  const initialized = await exists(path.join(directory, "hub.sqlite"));
  const service = await inspectHubService(directory);
  const manager: Partial<ManagedServiceStatus> = await managedServiceStatus(directory).catch(error => ({ limitations: [], directory, error: error instanceof Error && ["host_service_owner_mismatch", "host_service_user_mismatch"].includes(error.message) ? error.message : "host_service_status_unavailable" }));
  let serviceEnvironmentDifferences: string[] = [], serviceEnvironmentCheck: string | undefined;
  try { serviceEnvironmentDifferences = await managedServiceEnvironmentDifferences(directory, env); }
  catch { serviceEnvironmentCheck = "host_service_environment_unavailable"; }
  await refreshWindowsRegistryPath(env, { force: true });
  let engines: InspectedEngine[], environmentCheck: { error: string; variables: string[]; hint?: string } | undefined;
  const callerHome = validCallerHome(env);
  try {
    const hostEnv = buildHostEnvironment({ env, ...(callerHome ? { home: callerHome } : {}) });
    if (inspectLiveEngines) {
      engines = await inspectEnginesWithDiscovery(directory, mergeDiscoveryMetadata(hostEnv, env));
    } else {
      const settings = readHostEngineSettings(directory);
      const discoveryCache = readEngineDiscoveryCache(directory);
      engines = inspectEngines(hostEngineEnvironment(directory, hostEnv, settings, { discoveryCache }), { baseEnv: hostEnv, settings, discoveryCache });
    }
  }
  catch (error) {
    if (error instanceof Error && error.message === "engine_settings_unavailable") {
      engines = []; environmentCheck = { error: "engine_settings_unavailable", variables: [], hint: ENGINE_SETTINGS_REPAIR_HINT };
    } else {
    const candidate = error instanceof Error ? error.message.split(": ")[1] : undefined;
    const names = [...HOST_PRESERVED_ENVIRONMENT_KEYS, "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"] as string[];
    environmentCheck = { error: "host_environment_invalid", variables: candidate && names.includes(candidate) ? [candidate] : [] };
    // Engine presence can still be checked without adopting invalid service
    // config/proxy settings. Never expose rejected values in diagnostic JSON.
    const fallback: NodeJS.ProcessEnv = {};
    if (isLiveHostEnvironment(env)) markLiveHostEnvironment(fallback);
    const lookup = (key: string) => env[key] ?? (process.platform === "win32" ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
    const search = lookup("PATH");
    if (search && !/[\x00-\x1f\x7f]/.test(search)) fallback.PATH = search;
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      const val = lookup(key);
      if (val && !/[\x00-\x1f\x7f]/.test(val)) fallback[key] = val;
    }
    if (process.platform === "win32") {
      const pathext = lookup("PATHEXT");
      if (pathext && !/[\x00-\x1f\x7f]/.test(pathext) && pathext.split(";").filter(Boolean).every(ext => /^\.[a-z0-9]+$/i.test(ext))) {
        fallback.PATHEXT = pathext;
      }
    }
    for (const key of HOST_ENGINE_EXECUTABLE_KEYS) {
      const raw = lookup(key);
      const value = process.platform === "win32" && key === "DSH_EXECUTABLE" ? deepseekExecutableOverride({ DSH_EXECUTABLE: raw }) : raw;
      if (raw && value && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(raw)) fallback[key] = value;
    }
    // The fallback still applies the Host's saved paths: reporting a different
    // program than the Host would start, or hiding a damaged file, is a silent fallback.
    try {
      const hostFallback = buildHostEnvironment({ env: fallback, ...(callerHome ? { home: callerHome } : {}) });
      if (inspectLiveEngines) {
        engines = await inspectEnginesWithDiscovery(directory, mergeDiscoveryMetadata(hostFallback, env));
      } else {
        const settings = readHostEngineSettings(directory);
        const discoveryCache = readEngineDiscoveryCache(directory);
        engines = inspectEngines(hostEngineEnvironment(directory, hostFallback, settings, { discoveryCache }), { baseEnv: hostFallback, settings, discoveryCache });
      }
    }
    catch (settingsError) {
      if (!(settingsError instanceof Error && settingsError.message === "engine_settings_unavailable")) throw settingsError;
      engines = []; environmentCheck = { ...environmentCheck, hint: ENGINE_SETTINGS_REPAIR_HINT };
    }
    }
  }
  let database: { schema?: number; bots?: number; pendingMessages?: number; network?: { id: string; name: string; hosts: number } } | undefined;
  if (initialized) {
    const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try {
      const schema = Number((await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value);
      const network = await db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
      const membership = network ? JSON.parse(network.value)?.membership?.manifest : undefined;
      database = { schema, bots: (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM bots${schema >= 14 ? " WHERE deleted_at IS NULL" : ""}`))?.count,
        pendingMessages: (await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries WHERE status='pending'"))?.count,
        ...(membership ? { network: { id: String(membership.id), name: String(membership.name), hosts: membership.hosts.filter((host: { revoked: boolean; state: string }) => !host.revoked && host.state === "active").length } } : {}) };
    } finally { await db.close(); }
  }
  const config = initialized ? await readHubConfig(directory) : undefined;
  let liveEngines: { id: string; available: boolean }[] | undefined, liveCheck: string | undefined;
  if (inspectLiveEngines && service.running && await exists(path.join(directory, "cli", "identity.json"))) {
    try { const client = await LocalHostClient.connect(directory); try { liveEngines = (await new HostManagement(client).catalog()).engines.map(({ id, available }) => ({ id, available })); } finally { client.close(); } }
    catch (error) { liveCheck = error instanceof Error ? error.message : "host_catalog_unavailable"; }
  }
  let desktopDirectory: string | undefined, desktopDirectoryIssue: string | undefined;
  try { desktopDirectory = await resolveDesktopHostDirectory({ env }); }
  catch (error) { desktopDirectoryIssue = error instanceof HostDirectoryError ? error.issue : "probe_failed"; }
  return { directory, desktopDirectory, desktopDirectoryIssue, initialized, profile: initialized ? await readHostProfile(directory) : undefined,
    service, manager, database, serviceEnvironmentDifferences, serviceEnvironmentCheck, environmentCheck, engines, liveEngines, liveCheck, listeners: config ? [{ host: config.host, port: config.port, tls: !!config.tls }, ...config.tlsListeners.map(listener => ({ host: listener.host, port: listener.port, tls: true }))] : [],
    notes: [...(initialized && "configured" in manager && !manager.configured ? ["尚未安装系统后台守护。桌面 App 打开时会尝试恢复本机主机；无人值守运行请先停止主机，再执行 tarobot service install。系统睡眠或登录前仍不能提供服务。"] : []), "CLI 存在不代表已经登录；请在运行主机、同一系统用户下完成所用引擎的登录。", "监听和中转在线状态不代表手机已经完成端到端连接。", "主机待执行消息保留在原主机；更新不会把 Bot 或手机转移到另一台主机。"] };
}
