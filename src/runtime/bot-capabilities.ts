import { constants } from "node:fs";
import { open, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { botCapabilitiesSchema, type BotCapabilities, type BotCapability } from "../client-protocol/capabilities.js";
import { loadGatewayEnvironment } from "../gateway/environment.js";
import { resolveSearchRouting } from "./search-routing.js";
import { collectClaudeSearchMcpEntries, collectCodexSearchMcpEntries, createNativeSearchMcpPlanner, searchMcpBlocksManaged } from "./native-search-mcp.js";
import { redactSecrets } from "./secret-redaction.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown, max = 500) => typeof value === "string" ? redactSecrets(value).replace(/https?:\/\/\S+/g, "[URL]").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, max) : "";
const engineNames = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
export type CapabilityEngine = typeof engineNames[number];
type Options = { env?: NodeJS.ProcessEnv; offline?: boolean };
/** A registered Bot: its own state, workspace and project-scoped settings. */
type BotScope = { stateDir: string; workspace: string; offline: boolean };

const emptyResult = (engine: CapabilityEngine | null): BotCapabilities => ({ generatedAt: new Date().toISOString(), engine, workspace: null, runtime: "unverified", coverage: "partial", entries: [], sources: [], warnings: ["runtime_unverified", "partial_catalog"] });
const finish = (result: BotCapabilities) => { result.entries.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)); return botCapabilitiesSchema.parse(result); };

/** Bounded, redacting readers shared by every scan. Each call gets its own
 * read/entry budget and deduplication state. */
function scanner(result: BotCapabilities) {
  const warn = (value: BotCapabilities["warnings"][number]) => { if (!result.warnings.includes(value)) result.warnings.push(value); };
  let reads = 0;
  async function raw(file: string, source: string, kind: "skill" | "mcp" | "config", report = true, maxBytes = 2 * 1024 * 1024): Promise<string | null> {
    let handle; let status: BotCapabilities["sources"][number]["status"] = "read";
    try {
      if (++reads > 1600) { warn("scan_limited"); status = "limited"; return null; }
      // Resolve intentional skill/config symlinks, then refuse FIFO/devices and a
      // last-component substitution. The bounded read also handles growing files.
      const resolved = await realpath(file);
      handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("invalid file");
      const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
      let offset = 0;
      while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset > stat.size) throw new Error("file changed");
      return buffer.subarray(0, offset).toString("utf8");
    } catch (error) { status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; return null; }
    finally { await handle?.close(); if (report && result.sources.length < 200) result.sources.push({ source: clean(source), kind, status }); }
  }
  async function document(file: string, source: string, format: "json" | "toml" = "json", maxBytes?: number): Promise<Record<string, unknown>> {
    const text = await raw(file, source, "config", true, maxBytes); if (text === null) return {};
    try {
      const parsed: unknown = format === "toml" ? parseToml(text) : JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config_requires_object");
      return parsed as Record<string, unknown>;
    }
    catch { const item = result.sources.at(-1); if (item?.source === clean(source)) item.status = "unreadable"; return {}; }
  }
  const seenEntries = new Set<string>();
  function add(row: Omit<BotCapability, "id">, identity = row.source + "\0" + row.name) {
    if (result.entries.length >= 1000) { warn("scan_limited"); return; }
    const id = createHash("sha256").update(row.kind + "\0" + identity).digest("hex");
    if (seenEntries.has(id)) return; seenEntries.add(id);
    result.entries.push({ ...row, name: clean(row.name, 200), description: clean(row.description), source: clean(row.source, 1000), id });
  }
  const seenSkills = new Set<string>();
  const disabledSkills = new Set<string>();
  async function skills(root: string, source: string, scope: BotCapability["scope"], disabled = false, depth = 0) {
    if (depth > 3 || result.entries.length >= 1000 || reads > 1600) { warn("scan_limited"); return; }
    let directory; let count = 0;
    try {
      directory = await opendir(root);
      if (result.sources.length < 200) result.sources.push({ source: clean(source), kind: "skill", status: "read" });
      for await (const entry of directory) {
        if (++count > 1000 || reads > 1600 || result.entries.length >= 1000) { warn("scan_limited"); break; }
        if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
        const file = path.join(root, entry.name, "SKILL.md"), label = `${source}/${entry.name}/SKILL.md`;
        const text = await raw(file, label, "skill", false);
        if (text === null) {
          if (entry.name === ".system") await skills(path.join(root, entry.name), `${source}/${entry.name}`, "system", disabled, depth + 1);
          continue;
        }
        const canonical = await realpath(file).catch(() => file);
        if (seenSkills.has(canonical)) continue;
        const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        if (!frontmatter) continue;
        const doc = parseDocument(frontmatter, { schema: "core", uniqueKeys: true });
        if (doc.errors.length || doc.warnings.length) continue;
        let fields: Record<string, unknown>; try { fields = object(doc.toJS({ maxAliasCount: 20 })); } catch { continue; }
        if (typeof fields.name !== "string" || !fields.name.trim()) continue;
        seenSkills.add(canonical);
        add({ kind: "skill", name: fields.name, description: clean(fields.description), source: label, scope,
          status: disabled || disabledSkills.has(canonical) || disabledSkills.has(path.resolve(file)) ? "disabled" : "discovered" }, canonical);
      }
    } catch (error) { if (result.sources.length < 200) result.sources.push({ source: clean(source), kind: "skill", status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }); }
  }
  function mcp(values: unknown, source: string, scope: BotCapability["scope"], disabled: string[] = [], allDisabled = false) {
    for (const [name, value] of Object.entries(object(values))) {
      const row = object(value); if (!Object.keys(row).length) continue;
      const type = row.type ?? row.transport;
      const transport: BotCapability["transport"] = type === "streamable-http" ? "http" : ["stdio", "http", "sse", "ws", "sdk"].includes(String(type)) ? type as BotCapability["transport"] : typeof row.command === "string" ? "stdio" : row.url || row.serverUrl || row.httpUrl ? "http" : "unknown";
      add({ kind: "mcp", name, description: "", source, scope, transport,
        status: allDisabled || row.enabled === false || row.disabled === true || disabled.includes(name) ? "disabled" : "configured" });
    }
  }
  async function jsonMcp(file: string, source: string, scope: BotCapability["scope"], disabled: string[] = []) { const data = await document(file, source); mcp(data.mcpServers, source, scope, disabled); }
  return { warn, document, add, skills, mcp, jsonMcp, disabledSkills };
}
type Scanner = ReturnType<typeof scanner>;

/** Native skill/MCP declarations of one engine. Without `bot`, only the Host
 * user's own scope is read: no workspace, Bot state or project-scoped entry. */
async function scanEngine(scan: Scanner, engine: CapabilityEngine, env: NodeJS.ProcessEnv, home: string, bot?: BotScope) {
  const { document, mcp, jsonMcp, skills } = scan;
  const user = !bot?.offline, workspace = bot?.workspace;
  if (engine === "codex") {
    const codexHome = env.CODEX_HOME || path.join(home, ".codex");
    const configs: [string, string, BotCapability["scope"]][] = [...(user ? [[path.join(codexHome, "config.toml"), "$CODEX_HOME/config.toml", "user"] as [string, string, BotCapability["scope"]]] : []), ...(workspace ? [[path.join(workspace, ".codex/config.toml"), "workspace/.codex/config.toml", "workspace"] as [string, string, BotCapability["scope"]]] : [])];
    for (const [file, label, scope] of configs) {
      const data = await document(file, label, "toml"); mcp(data.mcp_servers, label, scope);
      const overrides = object(data.skills).config;
      for (const value of Array.isArray(overrides) ? overrides : []) { const row = object(value); if (row.enabled === false && typeof row.path === "string") { const skillFile = path.resolve(path.dirname(file), row.path); scan.disabledSkills.add(skillFile); scan.disabledSkills.add(await realpath(skillFile).catch(() => skillFile)); } }
    }
    if (user) { await skills(path.join(codexHome, "skills"), "$CODEX_HOME/skills", "user"); await skills(path.join(home, ".agents/skills"), "~/.agents/skills", "user"); }
    if (workspace) await skills(path.join(workspace, ".agents/skills"), "workspace/.agents/skills", "workspace");
  } else if (engine === "claude") {
    const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    const settings = [user ? await document(path.join(claudeHome, "settings.json"), "$CLAUDE_CONFIG_DIR/settings.json") : {}, ...(workspace ? [await document(path.join(workspace, ".claude/settings.json"), "workspace/.claude/settings.json"), await document(path.join(workspace, ".claude/settings.local.json"), "workspace/.claude/settings.local.json")] : [])];
    const disabled = settings.flatMap((s) => Array.isArray(s.disabledMcpjsonServers) ? s.disabledMcpjsonServers.filter((x): x is string => typeof x === "string") : []);
    if (user) {
      const file = env.CLAUDE_CONFIG_DIR ? path.join(claudeHome, ".claude.json") : path.join(home, ".claude.json");
      const data = await document(file, "~/.claude.json", "json", 32 * 1024 * 1024);
      let project: Record<string, unknown> = {};
      let matchesWorkspace = async (_value: unknown) => false;
      if (workspace) {
        const physicalWorkspace = await realpath(workspace).catch(() => workspace);
        const workspaceKeys = new Set([workspace, physicalWorkspace].flatMap((value) => [value, value.replaceAll("\\", "/")]));
        matchesWorkspace = async (value: unknown) => typeof value === "string" && (workspaceKeys.has(value) || (path.isAbsolute(value) && await realpath(value).catch(() => "") === physicalWorkspace));
        const projects = Object.entries(object(data.projects));
        project = object(projects.find(([key]) => workspaceKeys.has(key))?.[1]);
        if (!Object.keys(project).length) {
          for (const [key, value] of projects.slice(0, 512)) { if (await matchesWorkspace(key)) { project = object(value); break; } }
          if (projects.length > 512 && !Object.keys(project).length) scan.warn("scan_limited");
        }
      }
      const localDisabled = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers.filter((x): x is string => typeof x === "string") : [];
      disabled.push(...localDisabled);
      mcp(data.mcpServers, "~/.claude.json", "user", localDisabled);
      if (workspace) mcp(project.mcpServers, "~/.claude.json · workspace", "workspace", localDisabled);
      await skills(path.join(claudeHome, "skills"), "$CLAUDE_CONFIG_DIR/skills", "user");
      const installed = await document(path.join(claudeHome, "plugins/installed_plugins.json"), "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json");
      const enabled = Object.assign({}, ...settings.map((s) => object(s.enabledPlugins))) as Record<string, unknown>;
      let count = 0; const seenPlugins = new Set<string>();
      for (const [name, records] of Object.entries(object(installed.plugins))) {
        for (const record of Array.isArray(records) ? records : []) {
          // A project/local plugin belongs to its own project, never to the user scope.
          const row = object(record); if (typeof row.installPath !== "string" || !path.isAbsolute(row.installPath) || (row.projectPath && !await matchesWorkspace(row.projectPath)) || (["project", "local"].includes(String(row.scope)) && !row.projectPath)) continue;
          const pluginKey = name + "\0" + await realpath(row.installPath).catch(() => row.installPath as string);
          if (seenPlugins.has(pluginKey)) continue; seenPlugins.add(pluginKey);
          if (++count > 60) { scan.warn("scan_limited"); break; }
          const label = `plugin:${clean(name, 120)}`, isDisabled = enabled[name] === false;
          await skills(path.join(row.installPath, "skills"), `${label}/skills`, "plugin", isDisabled);
          const manifest = await document(path.join(row.installPath, ".claude-plugin/plugin.json"), `${label}/plugin.json`);
          const config = await document(path.join(row.installPath, ".mcp.json"), `${label}/.mcp.json`);
          mcp(config.mcpServers ?? config, `${label}/.mcp.json`, "plugin", [], isDisabled);
          if (manifest.mcpServers && typeof manifest.mcpServers === "object") mcp(manifest.mcpServers, `${label}/plugin.json`, "plugin", [], isDisabled);
        }
        if (count > 60) break;
      }
    }
    if (workspace) {
      await jsonMcp(path.join(workspace, ".mcp.json"), "workspace/.mcp.json", "workspace", disabled);
      await skills(path.join(workspace, ".claude/skills"), "workspace/.claude/skills", "workspace");
    }
  } else if (engine === "kimi") {
    if (user) {
      const kimiHome = env.KIMI_CODE_HOME || path.join(home, ".kimi-code");
      await jsonMcp(path.join(kimiHome, "mcp.json"), "$KIMI_CODE_HOME/mcp.json", "user");
      await skills(path.join(kimiHome, "skills"), "$KIMI_CODE_HOME/skills", "user"); await skills(path.join(home, ".agents/skills"), "~/.agents/skills", "user");
    }
    if (workspace) {
      await jsonMcp(path.join(workspace, ".kimi-code/mcp.json"), "workspace/.kimi-code/mcp.json", "workspace");
      await skills(path.join(workspace, ".kimi-code/skills"), "workspace/.kimi-code/skills", "workspace");
      await skills(path.join(workspace, ".agents/skills"), "workspace/.agents/skills", "workspace");
    }
  } else if (engine === "antigravity") {
    if (user) { await jsonMcp(path.join(home, ".gemini/config/mcp_config.json"), "~/.gemini/config/mcp_config.json", "user"); await skills(path.join(home, ".gemini/antigravity-cli/skills"), "~/.gemini/antigravity-cli/skills", "user"); }
    if (workspace) {
      await jsonMcp(path.join(workspace, ".agents/mcp_config.json"), "workspace/.agents/mcp_config.json", "workspace");
      await skills(path.join(workspace, ".agents/skills"), "workspace/.agents/skills", "workspace");
    }
  } else {
    // Harness patches can contain executable !!js and profile/plugin indirection.
    // Do not evaluate them or pretend a filesystem scan knows the effective graph.
    scan.warn("deepseek_dynamic_config");
    if (bot) await skills(path.join(bot.stateDir, "dsh-home/skills"), "Bot/dsh-home/skills", "bot");
    if (workspace) await skills(path.join(workspace, ".dsh/skills"), "workspace/.dsh/skills", "workspace");
  }
}

/** Metadata only. Never starts a CLI/server, executes YAML tags, repairs config,
 * expands environment values, or returns commands, URLs, headers or file bodies.
 * Paths come from the registered Bot and its host, never from an HTTP query. */
export async function readBotCapabilities(stateDir: string, options: Options = {}): Promise<BotCapabilities> {
  const env = options.env ?? process.env, home = env.HOME || env.USERPROFILE || os.homedir();
  const result = emptyResult(null), scan = scanner(result);
  const config = await scan.document(path.join(stateDir, "config.json"), "Bot/config.json");
  if (result.sources[0]?.status !== "read" || (config.engine !== undefined && !engineNames.includes(config.engine as CapabilityEngine))) { scan.warn("config_unreadable"); return result; }
  const engine = result.engine = (config.engine ?? "codex") as CapabilityEngine;
  const override = config.workspacePath ?? object(config.resume).workspacePath;
  if (override !== undefined && (typeof override !== "string" || !path.isAbsolute(override))) { scan.warn("workspace_unknown"); return result; }
  const workspace = typeof override === "string" ? override : path.join(stateDir, "workspace");
  result.workspace = clean(workspace, 1000);
  let managedSearch;
  if (!options.offline && (engine === "kimi" || engine === "deepseek" || engine === "claude" || engine === "codex")) {
    try { managedSearch = await resolveSearchRouting(await loadGatewayEnvironment(stateDir, "capabilities", env)); }
    catch { scan.warn("config_unreadable"); }
  }
  if (options.offline) scan.warn("offline_workspace_only");
  await scanEngine(scan, engine, env, home, { stateDir, workspace, offline: !!options.offline });
  if (managedSearch?.enabled && (engine === "kimi" || engine === "deepseek")) scan.add({ kind: "mcp", name: "cctb_search", description: "", scope: "bridge", source: engine === "kimi" ? "TaroBird / Kimi ACP" : "TaroBird / DeepSeek Harness", status: "configured", transport: "stdio" });
  if (managedSearch?.enabled && (engine === "claude" || engine === "codex")) {
    try {
      const entries = await (engine === "claude" ? collectClaudeSearchMcpEntries : collectCodexSearchMcpEntries)(managedSearch.env, workspace);
      const plan = createNativeSearchMcpPlanner(managedSearch.env)();
      // Match launch-time suppression for existing/disabled registrations.
      // This remains a partial config catalog, never a live health claim.
      if (plan && !searchMcpBlocksManaged(entries)) scan.add({ kind: "mcp", name: plan.name, description: "", scope: "bridge", source: engine === "claude" ? "TaroBird / Claude Code" : "TaroBird / Codex", status: "configured", transport: "stdio" });
    } catch { scan.warn("config_unreadable"); }
  }
  return finish(result);
}

/** The Host user's own declarations for an engine, available before any worker
 * exists. Reads no workspace, Bot state, project-scoped settings/plugins or
 * ticket material, and makes no managed-search claim: a worker's effective
 * inventory also depends on its ticket directory and per-Bot environment.
 * Presence is metadata, not proof that the runtime loads it or of its quality. */
export async function readEngineCapabilities(engine: CapabilityEngine, options: { env?: NodeJS.ProcessEnv } = {}): Promise<BotCapabilities> {
  if (!engineNames.includes(engine)) throw new TypeError("unknown_engine");
  const env = options.env ?? process.env, home = env.HOME || env.USERPROFILE || os.homedir();
  const result = emptyResult(engine);
  await scanEngine(scanner(result), engine, env, home);
  return finish(result);
}
