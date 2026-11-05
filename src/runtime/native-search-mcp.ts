import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { resolveSearchMcpServerInvocation, type SearchMcpServerInvocation } from "../../deepseek-harness-plugin/src/search-mcp-server.js";
import { resolveSearchRoutingSync, SEARCH_CREDENTIAL_KEYS } from "./search-routing.js";

/** Server name for the host-managed Brave/Tavily MCP added to Claude/Codex
 * sessions. It never replaces a user, project or plugin registration. */
export const MANAGED_SEARCH_MCP_NAME = "tarobot_search";
const FALLBACK_MARKER = "TAROBOT_SEARCH_CREDENTIAL_FALLBACK";

/** Credential-free description of the managed server: paths and env-var
 * NAMES only. Values stay in the engine process environment. */
export interface NativeSearchMcpPlan {
  name: string;
  command: string;
  args: string[];
  /** Variables the MCP child must receive from the engine process. */
  envKeys: string[];
  /** Resolved values the engine process lacks; merge into its spawn env only. */
  processEnv: Record<string, string>;
}

export type NativeSearchMcpPlanner = () => NativeSearchMcpPlan | null;

export interface SearchMcpEntry {
  name: string;
  server: Record<string, unknown>;
  disabled?: boolean;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Resolve per engine launch. A changed bot.env/integrations.env is loaded by
 * the next Bot worker, consistent with other engine environment settings. Without effective credentials the native default is kept. */
export function createNativeSearchMcpPlanner(
  env: NodeJS.ProcessEnv,
  resolveInvocation: () => SearchMcpServerInvocation = resolveSearchMcpServerInvocation,
): NativeSearchMcpPlanner {
  let warned = false;
  return () => {
    const routing = resolveSearchRoutingSync(env);
    if (!routing.enabled) return null;
    let invocation: SearchMcpServerInvocation;
    try {
      invocation = resolveInvocation();
    } catch {
      // A damaged package must cost search only, never the Bot.
      if (!warned) console.error("[search] Managed Search MCP entrypoint unavailable; keeping native search.");
      warned = true;
      return null;
    }
    const processEnv: Record<string, string> = {};
    const envKeys: string[] = [];
    for (const key of [...SEARCH_CREDENTIAL_KEYS, FALLBACK_MARKER]) {
      const value = routing.env[key];
      if (value === undefined) continue;
      envKeys.push(key);
      if (env[key] !== value) processEnv[key] = value;
    }
    return { name: MANAGED_SEARCH_MCP_NAME, command: invocation.command, args: [...invocation.args], envKeys, processEnv };
  };
}

const SEARCH_SERVER_NAME = /^(?:web[-_]?search|cctb[-_]search|tarobot[-_]search|brave[-_]?search|tavily(?:[-_][a-z0-9]+)*)$/i;
const SEARCH_SERVER_ARG = /(?:^search-mcp$|(?:^|[\\/])search-mcp(?:\.mjs|\.js|-server\.js)$|server-brave-search|tavily-mcp|mcp-server-tavily)/i;

/** Same purpose: the TaroBot search entrypoints (any checkout or package) or a
 * Brave/Tavily server. Name matches count even for third-party commands. */
export function isSearchMcpServer(name: string, server: Record<string, unknown>): boolean {
  if (SEARCH_SERVER_NAME.test(name)) return true;
  const command = typeof server.command === "string" ? [server.command] : [];
  return [...command, ...strings(server.args)].some((value) => SEARCH_SERVER_ARG.test(value.trim()));
}

/** A stdio registration whose absolute command or script path is gone cannot
 * start; any other shape (bare command, URL, unknown) is taken as usable. */
export function isBrokenStdioRegistration(server: Record<string, unknown>): boolean {
  const command = typeof server.command === "string" ? server.command : undefined;
  if (command && path.isAbsolute(command) && !existsSync(command)) return true;
  return strings(server.args).some((arg) => path.isAbsolute(arg) && /\.(?:[cm]?js|ts)$/i.test(arg) && !existsSync(arg));
}

/** An enabled working registration keeps its own server; a disabled one is the
 * user's decision and must not be bypassed under another name. Only a broken
 * one (e.g. a moved checkout) is supplemented by the managed server. */
export function searchMcpBlocksManaged(entries: Iterable<SearchMcpEntry>): boolean {
  for (const entry of entries) {
    if (!isSearchMcpServer(entry.name, entry.server)) continue;
    const disabled = entry.disabled === true || entry.server.enabled === false || entry.server.disabled === true;
    if (disabled || !isBrokenStdioRegistration(entry.server)) return true;
  }
  return false;
}

function entries(servers: unknown, disabledNames: ReadonlySet<string> = new Set(), allDisabled = false): SearchMcpEntry[] {
  return Object.entries(object(servers)).map(([name, server]) => ({
    name,
    server: object(server),
    disabled: allDisabled || disabledNames.has(name),
  }));
}

class UnreadableConfig extends Error {}

async function readConfig(file: string, format: "json" | "toml" = "json", maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) throw new UnreadableConfig();
    const text = await readFile(file, "utf8");
    return object(format === "toml" ? parseToml(text) : JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Contents never enter diagnostics; the caller only learns it was unusable.
    throw new UnreadableConfig();
  }
}

/** Claude's MCP sources for this workspace: user, local project, .mcp.json and
 * installed plugins, with their disable lists. */
export async function collectClaudeSearchMcpEntries(env: NodeJS.ProcessEnv, workspacePath: string): Promise<SearchMcpEntry[]> {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const settings = await Promise.all([
    readConfig(path.join(claudeHome, "settings.json")),
    readConfig(path.join(workspacePath, ".claude/settings.json")),
    readConfig(path.join(workspacePath, ".claude/settings.local.json")),
  ]);
  const data = await readConfig(env.CLAUDE_CONFIG_DIR ? path.join(claudeHome, ".claude.json") : path.join(home, ".claude.json"), "json", 32 * 1024 * 1024);
  const physical = await realpath(workspacePath).catch(() => workspacePath);
  const keys = new Set([workspacePath, physical].flatMap((value) => [value, value.replaceAll("\\", "/")]));
  const matchesWorkspace = async (value: unknown) => typeof value === "string"
    && (keys.has(value) || (path.isAbsolute(value) && await realpath(value).catch(() => "") === physical));
  const project = object(Object.entries(object(data.projects)).find(([key]) => keys.has(key))?.[1]);
  const disabledJson = new Set([...settings.flatMap((s) => strings(s.disabledMcpjsonServers)), ...strings(project.disabledMcpjsonServers)]);
  const disabledLocal = new Set(strings(project.disabledMcpServers));
  const mcpJson = await readConfig(path.join(workspacePath, ".mcp.json"));
  const result = [
    ...entries(data.mcpServers, disabledLocal),
    ...entries(project.mcpServers, disabledLocal),
    ...entries(mcpJson.mcpServers, new Set([...disabledJson, ...disabledLocal])),
    // A disabled search name is a decision even where its entry is not visible
    // here (e.g. a plugin or managed name); never re-add it under another name.
    ...[...disabledLocal, ...disabledJson].map((name) => ({ name, server: {}, disabled: true })),
  ];
  const enabledPlugins = Object.assign({}, ...settings.map((s) => object(s.enabledPlugins))) as Record<string, unknown>;
  const installed = await readConfig(path.join(claudeHome, "plugins/installed_plugins.json"));
  let count = 0;
  for (const [plugin, records] of Object.entries(object(installed.plugins))) {
    for (const record of Array.isArray(records) ? records : []) {
      const row = object(record);
      const installPath = row.installPath;
      if (typeof installPath !== "string" || !path.isAbsolute(installPath) || ++count > 60) continue;
      // Project/local plugins only apply to their own workspace.
      if (row.projectPath ? !await matchesWorkspace(row.projectPath) : ["project", "local"].includes(String(row.scope))) continue;
      const pluginDisabled = enabledPlugins[plugin] === false;
      const config = await readConfig(path.join(installPath, ".mcp.json")).catch(() => ({}));
      const manifest = await readConfig(path.join(installPath, ".claude-plugin/plugin.json")).catch(() => ({}));
      result.push(...entries(object(config).mcpServers ?? config, new Set(), pluginDisabled));
      result.push(...entries(object(manifest).mcpServers, new Set(), pluginDisabled));
    }
  }
  return result;
}

/** Managed server entry for Claude's --mcp-config. Values arrive through
 * Claude's own ${VAR:-} expansion of its process env, never through the file. */
export async function claudeManagedSearchServers(
  plan: NativeSearchMcpPlan | null,
  env: NodeJS.ProcessEnv,
  workspacePath: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!plan || !workspacePath) return null;
  try {
    if (searchMcpBlocksManaged(await collectClaudeSearchMcpEntries(env, workspacePath))) return null;
  } catch {
    // Without a readable configuration a duplicate cannot be ruled out.
    console.error("[search] Claude MCP configuration unreadable; not adding the managed Search MCP.");
    return null;
  }
  const serverEnv: Record<string, string> = {};
  for (const key of plan.envKeys) serverEnv[key] = key === FALLBACK_MARKER ? "0" : `\${${key}:-}`;
  return { [plan.name]: { type: "stdio", command: plan.command, args: plan.args, env: serverEnv } };
}

/** Flat Codex config keys; flat keys add one server without replacing the
 * user's `mcp_servers` table. `env_vars` passes names, never values. */
export function codexManagedSearchConfig(plan: NativeSearchMcpPlan): Record<string, unknown> {
  const prefix = `mcp_servers.${plan.name}`;
  return {
    [`${prefix}.command`]: plan.command,
    [`${prefix}.args`]: plan.args,
    [`${prefix}.env_vars`]: plan.envKeys,
  };
}

/** `codex exec` has no config/read; inspect the user and workspace layers. */
export async function collectCodexSearchMcpEntries(env: NodeJS.ProcessEnv, workspacePath: string): Promise<SearchMcpEntry[]> {
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const [user, project] = await Promise.all([
    readConfig(path.join(codexHome, "config.toml"), "toml"),
    readConfig(path.join(workspacePath, ".codex/config.toml"), "toml"),
  ]);
  return [...entries(user.mcp_servers), ...entries(project.mcp_servers)];
}

/** TOML values for `codex exec -c`; JSON strings/arrays are valid TOML. */
export function codexManagedSearchCliOverrides(plan: NativeSearchMcpPlan): string[] {
  return Object.entries(codexManagedSearchConfig(plan)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);
}
