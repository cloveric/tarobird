import path from "node:path";
import { readHubConfig } from "../hub/config.js";
import { inspectHubService } from "../hub/service.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { HubDatabase } from "../hub/database.js";
import { exists, resolveDesktopHostDirectory } from "./paths.js";
import { readHostProfile } from "./setup.js";
import { managedServiceStatus, managedServiceEnvironmentDifferences, type ManagedServiceStatus } from "./service-manager.js";
import { buildHostEnvironment, HOST_ENGINE_EXECUTABLE_KEYS, HOST_PRESERVED_ENVIRONMENT_KEYS } from "./environment.js";
import { LocalHostClient } from "./client.js";
import { HostDirectoryError } from "./windows-state-admission.js";
import { HostManagement } from "./management.js";

export function inspectEngines(env: NodeJS.ProcessEnv = process.env) {
  return ([
    ["codex", env.CODEX_EXECUTABLE || "codex"], ["claude", env.CLAUDE_EXECUTABLE || "claude"],
    ["antigravity", env.ANTIGRAVITY_EXECUTABLE || "agy"], ["kimi", env.KIMI_EXECUTABLE || "kimi"],
    ["deepseek", env.DSH_EXECUTABLE || "dsh"],
  ] as const).map(([engine, command]) => {
    const executable = resolveEngineExecutable(command, env);
    return { engine, installed: !!executable, ...(executable ? { executable } : {}), authentication: "unverified" as const };
  });
}

/** Read-only inspection. No new identity, DB migrations, engine execution or login. */
export async function inspectHost(directory: string, env: NodeJS.ProcessEnv = process.env, inspectLiveEngines = false) {
  const initialized = await exists(path.join(directory, "hub.sqlite"));
  const service = await inspectHubService(directory);
  const manager: Partial<ManagedServiceStatus> = await managedServiceStatus(directory).catch(error => ({ limitations: [], directory, error: error instanceof Error && ["host_service_owner_mismatch", "host_service_user_mismatch"].includes(error.message) ? error.message : "host_service_status_unavailable" }));
  let serviceEnvironmentDifferences: string[] = [], serviceEnvironmentCheck: string | undefined;
  try { serviceEnvironmentDifferences = await managedServiceEnvironmentDifferences(directory, env); }
  catch { serviceEnvironmentCheck = "host_service_environment_unavailable"; }
  let engines: ReturnType<typeof inspectEngines>, environmentCheck: { error: string; variables: string[] } | undefined;
  try { engines = inspectEngines(buildHostEnvironment({ env })); }
  catch (error) {
    const candidate = error instanceof Error ? error.message.split(": ")[1] : undefined;
    const names = [...HOST_PRESERVED_ENVIRONMENT_KEYS, "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"] as string[];
    environmentCheck = { error: "host_environment_invalid", variables: candidate && names.includes(candidate) ? [candidate] : [] };
    // Engine presence can still be checked without adopting invalid service
    // config/proxy settings. Never expose rejected values in diagnostic JSON.
    const fallback: NodeJS.ProcessEnv = {};
    const lookup = (key: string) => env[key] ?? (process.platform === "win32" ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
    const search = lookup("PATH");
    if (search && !/[\x00-\x1f\x7f]/.test(search)) fallback.PATH = search;
    for (const key of HOST_ENGINE_EXECUTABLE_KEYS) {
      const value = lookup(key);
      if (value && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)) fallback[key] = value;
    }
    engines = inspectEngines(buildHostEnvironment({ env: fallback }));
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
