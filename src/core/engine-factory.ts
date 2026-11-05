import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, symlink, lstat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

import { resolveBridgeConfig, resolveConfig, resolveInstanceStateDir, resolveInstanceName, type EnvSource } from "../config.js";
import { Bridge } from "../runtime/bridge.js";
import { prepareBotInstructions } from "../runtime/bot-instructions.js";
import { ProcessCodexAdapter } from "../codex/process-adapter.js";
import { ClaudeStreamAdapter } from "../codex/claude-stream-adapter.js";
import { KimiAcpAdapter } from "../codex/kimi-acp-adapter.js";
import { ProcessAntigravityAdapter } from "../codex/antigravity-adapter.js";
import { CodexAppServerAdapter } from "../codex/app-server-adapter.js";
import { DeepSeekHarnessAdapter, type DeepSeekHarnessModelSelection } from "../codex/deepseek-harness-adapter.js";
import { DeepSeekHarnessHost } from "../codex/deepseek-harness-host.js";
import { createNativeSearchMcpPlanner } from "../runtime/native-search-mcp.js";
import { resolveSearchRouting } from "../runtime/search-routing.js";
import { resolveSearchMcpServerInvocation } from "../../deepseek-harness-plugin/src/search-mcp-server.js";
import type { CodexAdapter } from "../codex/adapter.js";
import { AccessStore } from "../state/access-store.js";
import { appendAuditEvent } from "../state/audit-log.js";
import { SessionStore } from "../state/session-store.js";
import { resolveApprovalModeForEngine, type ApprovalMode } from "../state/approval-mode.js";
import { SessionManager } from "../runtime/session-manager.js";
import { normalizeInstanceName } from "../instance.js";
import { loadTelemetryAdapterFromEnv } from "../runtime/telemetry.js";
import { FileTurnPool } from "../runtime/turn-pool.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { EngineRecoveryBudgetError } from "../runtime/engine-recovery.js";
import { loadInstanceConfig, readValidatedConfigFile } from "../state/instance-config.js";

export interface BridgeDependencyOptions {
  transport?: "telegram" | "lark" | "gateway";
  startupInstructions?: (config: Awaited<ReturnType<typeof loadInstanceConfig>>) => string | null;
  runtimeInstructions?: () => string;
}

function resolveSharedCodexHome(env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_HOME">): string | null {
  if (env.CODEX_HOME?.trim()) {
    return env.CODEX_HOME.trim();
  }

  const homeDir = process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    return null;
  }

  return path.join(homeDir, ".codex");
}

async function symlinkIfMissing(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await lstat(targetPath);
    return; // already exists
  } catch {
    // doesn't exist — proceed
  }
  try {
    await lstat(sourcePath);
  } catch {
    return; // source doesn't exist
  }
  try {
    const source = await lstat(sourcePath);
    await symlink(sourcePath, targetPath, process.platform === "win32" && source.isDirectory() ? "junction" : undefined);
  } catch {
    // symlink failed (e.g. Windows without dev mode)
  }
}

async function linkKimiSharedSkills(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_HOME">,
  workspacePath: string,
): Promise<void> {
  const sharedCodexHome = resolveSharedCodexHome(env);
  if (!sharedCodexHome) {
    return;
  }
  const kimiConfigDir = path.join(workspacePath, ".kimi-code");
  const sourceSkillsDir = path.join(sharedCodexHome, "skills");
  const targetSkillsPath = path.join(kimiConfigDir, "skills");
  await mkdir(kimiConfigDir, { recursive: true });
  let targetInfo: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    targetInfo = await lstat(targetSkillsPath);
  } catch {
    // Missing target gets the simplest zero-copy whole-directory link.
  }
  if (!targetInfo) {
    await symlinkIfMissing(sourceSkillsDir, targetSkillsPath);
    return;
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    return;
  }

  // Preserve project-owned Kimi skills while exposing missing shared Codex
  // skills one entry at a time. Existing names always win.
  let entries: string[];
  try {
    entries = await readdir(sourceSkillsDir);
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    await symlinkIfMissing(path.join(sourceSkillsDir, entry), path.join(targetSkillsPath, entry));
  }));
}

async function syncOrRemove(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code === "ENOENT") {
      // Source doesn't exist — remove any stale destination so the consumer
      // falls through to alternate auth sources (e.g. keychain).
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(destinationPath);
      } catch {
        // Destination didn't exist or couldn't be removed — that's fine.
      }
      return;
    }
    throw error;
  }
}

async function copyIfExists(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }

    throw error;
  }
}

async function seedIsolatedCodexHome(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_HOME">,
  engineHomePath: string,
): Promise<void> {
  const sharedCodexHome = resolveSharedCodexHome(env);
  if (!sharedCodexHome) {
    return;
  }

  if (path.resolve(sharedCodexHome) === path.resolve(engineHomePath)) {
    return;
  }

  await mkdir(engineHomePath, { recursive: true });
  await Promise.all([
    copyIfExists(path.join(sharedCodexHome, "auth.json"), path.join(engineHomePath, "auth.json")),
    copyIfExists(path.join(sharedCodexHome, "config.toml"), path.join(engineHomePath, "config.toml")),
    symlinkIfMissing(path.join(sharedCodexHome, "skills"), path.join(engineHomePath, "skills")),
  ]);
}

function resolveSharedClaudeHome(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string | null {
  const homeDir = process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    return null;
  }

  return homeDir;
}

function computeConfigDirHash(configDir: string): string {
  return createHash("sha256").update(configDir).digest("hex").slice(0, 8);
}

function execFileAsync(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function propagateMacOsKeychainCredential(engineHomePath: string): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const resolvedPath = path.resolve(engineHomePath);
  const hash = computeConfigDirHash(resolvedPath);
  const targetService = `Claude Code-credentials-${hash}`;
  const sourceService = "Claude Code-credentials";

  let sourcePassword: string;
  try {
    const result = await execFileAsync("security", [
      "find-generic-password", "-s", sourceService, "-w",
    ]);
    sourcePassword = result.stdout.trimEnd();
    if (!sourcePassword) {
      return;
    }
  } catch {
    return;
  }

  // Always sync — source token may have been refreshed since last start
  const account = process.env.USER ?? "claude";
  try {
    await execFileAsync("security", [
      "add-generic-password",
      "-s", targetService,
      "-a", account,
      "-w", sourcePassword,
      "-U",
    ]);
  } catch {
    // Keychain write failed (e.g. locked keychain) — user will need to run claude login manually
  }
}

async function seedIsolatedClaudeConfig(
  env: Pick<EnvSource, "HOME" | "USERPROFILE">,
  engineHomePath: string,
): Promise<void> {
  const sharedClaudeHome = resolveSharedClaudeHome(env);
  if (!sharedClaudeHome) {
    return;
  }

  await mkdir(engineHomePath, { recursive: true });
  await Promise.all([
    copyIfExists(path.join(sharedClaudeHome, ".claude.json"), path.join(engineHomePath, ".claude.json")),
    // Credentials: sync from source OR remove stale copy so Claude falls back
    // to the keychain entry propagated below. Without removal, an old
    // .credentials.json silently shadows the fresh keychain token and the bot
    // stays stuck on 401.
    syncOrRemove(path.join(sharedClaudeHome, ".claude", ".credentials.json"), path.join(engineHomePath, ".credentials.json")),
    propagateMacOsKeychainCredential(engineHomePath),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "skills"), path.join(engineHomePath, "skills")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "plugins"), path.join(engineHomePath, "plugins")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "settings.json"), path.join(engineHomePath, "settings.json")),
    symlinkIfMissing(path.join(sharedClaudeHome, ".claude", "settings.local.json"), path.join(engineHomePath, "settings.local.json")),
  ]);
}

export type EngineType = "codex" | "claude" | "antigravity" | "kimi" | "deepseek";
type CodexRuntime = "app-server" | "process";

export async function readInstanceRuntimeConfig(configPath: string): Promise<{
  engine: EngineType;
  approvalMode: ApprovalMode;
  codexRuntime: CodexRuntime | undefined;
  claudeChrome: boolean;
}> {
  const parsed = await readValidatedConfigFile(configPath);
  const engine = parsed.engine === "claude" || parsed.engine === "antigravity" || parsed.engine === "kimi" || parsed.engine === "deepseek"
    ? parsed.engine
    : "codex";
  const approvalMode = resolveApprovalModeForEngine(
    engine,
    parsed.approvalMode,
    parsed.kimiAutoNeverAskAcknowledged,
  );
  return {
    engine,
    approvalMode,
    codexRuntime:
      parsed.codexRuntime === "process" || parsed.codexRuntime === "app-server"
        ? parsed.codexRuntime
        : undefined,
    claudeChrome: parsed.claudeChrome === true,
  };
}

export async function readInstanceEngine(configPath: string): Promise<EngineType> {
  return (await readInstanceRuntimeConfig(configPath)).engine;
}

export async function readApprovalMode(configPath: string): Promise<ApprovalMode> {
  return (await readInstanceRuntimeConfig(configPath)).approvalMode;
}

export function resolveEngineRuntime(
  engine: EngineType,
  _approvalMode: ApprovalMode,
  codexRuntime?: CodexRuntime,
): "app-server" | "process" | "stream" | "acp" | "web" {
  if (engine === "claude") {
    return "stream";
  }
  if (engine === "antigravity") {
    return "process";
  }
  if (engine === "kimi") {
    return "acp";
  }
  if (engine === "deepseek") {
    return "web";
  }

  return codexRuntime ?? "app-server";
}

function resolveClaudeExecutable(env: EnvSource): string {
  if (env.CLAUDE_EXECUTABLE) {
    return env.CLAUDE_EXECUTABLE;
  }

  if (process.platform === "win32") {
    const appData =
      env.APPDATA ??
      (env.USERPROFILE ? path.join(env.USERPROFILE, "AppData", "Roaming") : undefined);

    if (appData) {
      const windowsClaudeCmd = path.join(appData, "npm", "claude.cmd");
      if (existsSync(windowsClaudeCmd)) {
        return windowsClaudeCmd;
      }

      const windowsClaudeShim = path.join(appData, "npm", "claude.ps1");
      if (existsSync(windowsClaudeShim)) {
        return windowsClaudeShim;
      }
    }
  }

  return "claude";
}

function resolveAntigravityExecutable(env: EnvSource, configuredExecutable: string): string {
  if (env.ANTIGRAVITY_EXECUTABLE) {
    return env.ANTIGRAVITY_EXECUTABLE;
  }
  return configuredExecutable;
}

/**
 * Recursively copy a directory tree, skipping symlinks and never
 * overwriting an existing destination file. Used to migrate a legacy
 * engine-home tree into the user's shared ~/.claude/ location without
 * clobbering anything that's already there.
 *
 * Safe to re-run; returns the number of files actually copied (0 if the
 * migration has already completed).
 */
async function copyTreeSkipExistingSkipSymlinks(src: string, dst: string): Promise<number> {
  let srcInfo;
  try {
    srcInfo = await lstat(src);
  } catch {
    return 0;
  }
  if (srcInfo.isSymbolicLink()) return 0;

  if (srcInfo.isFile()) {
    if (existsSync(dst)) return 0;
    try {
      await copyFile(src, dst);
      return 1;
    } catch {
      return 0;
    }
  }

  if (!srcInfo.isDirectory()) return 0;

  try {
    await mkdir(dst, { recursive: true });
  } catch {
    return 0;
  }

  let entries: string[];
  try {
    entries = await readdir(src);
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    total += await copyTreeSkipExistingSkipSymlinks(path.join(src, entry), path.join(dst, entry));
  }
  return total;
}

async function migrateClaudeEngineHomeIfPresent(
  stateDir: string,
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR">,
): Promise<void> {
  const engineProjectsDir = path.join(stateDir, "engine-home", "projects");
  if (!existsSync(engineProjectsDir)) return;

  // Mirror the resolution the spawned Claude CLI will actually use: an
  // explicit CLAUDE_CONFIG_DIR wins, otherwise fall back to ~/.claude.
  // Writing to the wrong root would leave files unreachable and defeat the
  // whole migration.
  let claudeConfigDir: string;
  if (env.CLAUDE_CONFIG_DIR) {
    claudeConfigDir = env.CLAUDE_CONFIG_DIR;
  } else {
    const homeDir =
      process.platform === "win32"
        ? env.USERPROFILE ?? env.HOME
        : env.HOME ?? env.USERPROFILE;
    if (!homeDir) return;
    claudeConfigDir = path.join(homeDir, ".claude");
  }

  const targetProjectsDir = path.join(claudeConfigDir, "projects");
  await mkdir(targetProjectsDir, { recursive: true });

  const migrated = await copyTreeSkipExistingSkipSymlinks(engineProjectsDir, targetProjectsDir);
  if (migrated > 0) {
    // Park the legacy directory so we don't redo the work next boot. Keep
    // it around as *.migrated-<timestamp> — evidence for the operator and
    // a cheap rollback path.
    const parkedPath = path.join(stateDir, `engine-home.migrated-${Date.now()}`);
    try {
      await rename(path.join(stateDir, "engine-home"), parkedPath);
    } catch {
      // If rename fails (permission, name clash) we just leave it —
      // copyTree is idempotent so next boot re-scans harmlessly.
    }
  }
}

/**
 * Build the childEnv passed to spawned engine processes.
 *
 * Starts from `process.env` so the child inherits the normal shell
 * environment (PATH, etc.), then overlays the explicit EnvSource that
 * callers of createServiceDependencies* may have provided. This keeps
 * programmatic callers honest: if they inject `CLAUDE_CONFIG_DIR` or
 * `CODEX_HOME` into the EnvSource, the spawned engine actually sees it —
 * not the ambient value on `process.env`.
 */
export function buildEngineEnvironment(env: EnvSource, transport: BridgeDependencyOptions["transport"]): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  // Strip the bridge's own secrets so the model-controlled engine child (and any
  // tool/MCP it runs) can't read them. We keep engine cloud creds (ANTHROPIC_API_KEY
  // etc.) and the CCTB_LARK_ACTIVE_* turn markers (the engine's own `lark service
  // restart` relies on them); lark-cli authenticates via its own store, not LARK_APP_ID.
  delete childEnv.TELEGRAM_BOT_TOKEN;
  // Feishu transport credentials are private to that adapter. App engine tools
  // may use explicitly configured Feishu credentials just like any other tool.
  if (transport !== "gateway") { delete childEnv.LARK_APP_SECRET; delete childEnv.LARK_APP_ID; }
  delete childEnv.CCTB_SEND_TOKEN;
  // A worker merges loaded values with process.env; absence in the loaded map
  // cannot erase an inherited MCP-only marker. Recompute at the engine boundary.
  delete childEnv.TAROBOT_SEARCH_CREDENTIAL_FALLBACK;

  const overlay: Array<[keyof EnvSource, string]> = [
    ["BRAVE_API_KEY", "BRAVE_API_KEY"],
    ["BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"],
    ["TAVILY_API_KEY", "TAVILY_API_KEY"],
    ["HOME", "HOME"],
    ["APPDATA", "APPDATA"],
    ["USERPROFILE", "USERPROFILE"],
    ["CODEX_HOME", "CODEX_HOME"],
    ["CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"],
    ["KIMI_CODE_HOME", "KIMI_CODE_HOME"],
    ["DSH_HOME", "DSH_HOME"],
    ["TAROBOT_STATE_DIR", "TAROBOT_STATE_DIR"],
    ["TAROBOT_INSTANCE", "TAROBOT_INSTANCE"],
    ["TAROCUB_INSTANCE", "TAROCUB_INSTANCE"],
    ["CODEX_TELEGRAM_INSTANCE", "CODEX_TELEGRAM_INSTANCE"],
    ["ANTIGRAVITY_EXECUTABLE", "ANTIGRAVITY_EXECUTABLE"],
  ];
  for (const [srcKey, dstKey] of overlay) {
    const injected = env[srcKey];
    if (injected !== undefined) {
      childEnv[dstKey] = injected;
    }
  }

  if (transport === "gateway") {
    childEnv.TAROBOT_INSTANCE = resolveInstanceName(env);
    childEnv.TAROBOT_STATE_DIR = resolveInstanceStateDir({ ...env, HOME: env.HOME ?? childEnv.HOME, USERPROFILE: env.USERPROFILE ?? childEnv.USERPROFILE });
    for (const key of ["CCTB_LARK_STATE_DIR", "CODEX_TELEGRAM_STATE_DIR", "CCTB_LARK_INSTANCE", "CODEX_TELEGRAM_INSTANCE", "TAROCUB_INSTANCE", "CCTB_LARK_ACTIVE_TURN", "CCTB_LARK_ACTIVE_INSTANCE", "CCTB_LARK_ACTIVE_STATE_DIR"]) delete childEnv[key];
  }
  return childEnv;
}

function resolveMaxConcurrentTurns(env: EnvSource): number {
  const raw = env.TAROBOT_MAX_CONCURRENT_TURNS ?? env.TAROCUB_MAX_CONCURRENT_TURNS ?? env.CODEX_TELEGRAM_MAX_CONCURRENT_TURNS;
  if (raw === undefined || raw.trim() === "") {
    return 0;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "off" || normalized === "none" || normalized === "disabled") {
    return 0;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function createAdapter(
  env: EnvSource,
  config: ReturnType<typeof resolveConfig>,
  configPath: string,
  options: BridgeDependencyOptions = {},
): Promise<CodexAdapter> {
  const runtimeConfig = await readInstanceRuntimeConfig(configPath);
  const engine = runtimeConfig.engine;
  const workspacePath = path.join(config.stateDir, "workspace");
  const approvalMode = runtimeConfig.approvalMode;
  const engineRuntime = resolveEngineRuntime(engine, approvalMode, runtimeConfig.codexRuntime);
  const childEnv = buildEngineEnvironment(env, options.transport);
  const searchRouting = await resolveSearchRouting(childEnv);
  const nativeSearchMcp = createNativeSearchMcpPlanner(childEnv);

  if (engine === "claude") {
    // Bots no longer get a per-instance CLAUDE_CONFIG_DIR. Instead they
    // inherit whatever the parent env has — which is either unset (Claude
    // uses ~/.claude/) or whatever the user's own Claude CLI uses (custom
    // path via exported CLAUDE_CONFIG_DIR). Either way, all bots plus the
    // user's CLI end up pointing at the same directory, so OAuth refresh
    // tokens rotate cleanly across all of them.
    //
    // Trade-off: the blast radius is now the user's real config dir.
    // Sessions and auto-memory are still keyed by workspace path (each bot
    // has its own workspace/), so those stay per-bot in practice. But
    // anything the engine writes at the config-dir root (settings,
    // telemetry, MCP state, plugins cache) is shared with the user.
    // full-auto / bypass modes inherit that blast radius too — a bot cannot
    // corrupt only its own engine state anymore.
    //
    // One-shot migration for upgraders: if the legacy engine-home/projects/
    // exists, copy its .jsonl and memory files into ~/.claude/projects/
    // (never overwriting existing files) so bot conversation history and
    // auto-memory survive the upgrade.
    await migrateClaudeEngineHomeIfPresent(config.stateDir, env);
    await mkdir(workspacePath, { recursive: true });
    return new ClaudeStreamAdapter(resolveClaudeExecutable(env), {
      childEnv,
      configPath,
      recoveryStatePath: path.join(config.stateDir, "claude-turn-recovery.json"),
      usageStatePath: path.join(config.stateDir, "claude-session-usage.json"),
      workspacePath,
      enableChromeIntegration: runtimeConfig.claudeChrome,
      nativeSearchMcp,
      disallowedTools: options.transport !== "telegram" ? [] : ["AskUserQuestion"],
    });
  }

  if (engine === "antigravity") {
    await mkdir(workspacePath, { recursive: true });
    return new ProcessAntigravityAdapter(
      resolveAntigravityExecutable(env, config.antigravityExecutable),
      childEnv,
      undefined,
      undefined,
      configPath,
      workspacePath,
    );
  }

  if (engine === "kimi") {
    await mkdir(workspacePath, { recursive: true });
    await linkKimiSharedSkills(env, workspacePath);
    const adapter = new KimiAcpAdapter(config.kimiExecutable, {
      childEnv,
      configPath,
      workspacePath,
    });
    const startupInstructions = options.startupInstructions
      ? options.startupInstructions(await loadInstanceConfig(config.stateDir))
      : null;
    await adapter.syncDefaultWorkspaceInstructions(startupInstructions);
    return adapter;
  }

  if (engine === "deepseek") {
    await mkdir(workspacePath, { recursive: true });
    const instanceConfig = await loadInstanceConfig(config.stateDir);
    let searchMcpInvocation;
    if (searchRouting.enabled) {
      try { searchMcpInvocation = resolveSearchMcpServerInvocation(); }
      catch { console.error("[search] Managed Search MCP entrypoint unavailable; keeping native search."); }
    }
    const host = new DeepSeekHarnessHost({
      executable: config.deepseekExecutable,
      sharedHome: config.deepseekHome,
      stateDir: config.stateDir,
      workspacePath,
      searchMcp: searchMcpInvocation ? { ...searchMcpInvocation, cwd: workspacePath } : undefined,
      childEnv: searchRouting.env,
      onDiagnostic: (message) => console.error(message),
    });
    return new DeepSeekHarnessAdapter({
      gateway: host,
      searchMcpEnabled: searchRouting.enabled && Boolean(searchMcpInvocation),
      workspacePath,
      configPath,
      goalStatePath: path.join(config.stateDir, "deepseek-goals.json"),
      permissionPreset: deepSeekPermissionPreset(approvalMode),
      model: deepSeekModelSelection(instanceConfig.model, instanceConfig.effort),
    });
  }

  // Same rationale and trade-offs as the Claude branch above: bots inherit
  // CODEX_HOME (or its absence) from the parent env, so they end up on the
  // same config dir as the user's main Codex CLI — avoiding the OAuth
  // refresh-token race at the cost of a wider blast radius.
  if (engineRuntime === "app-server") {
    await mkdir(workspacePath, { recursive: true });
    return new CodexAppServerAdapter(
      config.codexExecutable,
      workspacePath,
      childEnv,
      undefined,
      undefined,
      undefined,
      configPath,
      undefined, undefined, undefined,
      { nativeSearchMcp },
    );
  }

  await mkdir(workspacePath, { recursive: true });
  return new ProcessCodexAdapter(config.codexExecutable, childEnv, undefined, undefined, configPath, undefined, workspacePath, undefined, undefined, { nativeSearchMcp });
}

function deepSeekPermissionPreset(approvalMode: ApprovalMode): "workspace-write" | "full-auto" | "danger-full-access" {
  if (approvalMode === "bypass") {
    return "danger-full-access";
  }
  if (approvalMode === "full-auto") {
    return "full-auto";
  }
  return "workspace-write";
}

function deepSeekModelSelection(
  configuredModel: string | undefined,
  reasoningEffort: string | undefined,
): DeepSeekHarnessModelSelection | undefined {
  const model = configuredModel?.trim();
  if (!model && !reasoningEffort) {
    return undefined;
  }
  if (!model) {
    return { reasoningEffort };
  }
  const separator = model.indexOf("/");
  if (separator > 0 && separator < model.length - 1) {
    return {
      provider: model.slice(0, separator),
      model: model.slice(separator + 1),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  }
  return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function createBridgeDependenciesForConfig(
  env: EnvSource,
  config: ReturnType<typeof resolveConfig>,
  options: BridgeDependencyOptions = {},
): Promise<{ config: ReturnType<typeof resolveConfig>; bridge: Bridge }> {
  const accessStore = new AccessStore(config.accessStatePath);
  const sessionStore = new SessionStore(config.sessionStatePath);
  const instructionsPath = await prepareBotInstructions(config.stateDir);
  const configPath = path.join(config.stateDir, "config.json");
  const adapter = await createAdapter(env, config, configPath, options);
  const sessionManager = new SessionManager(sessionStore, adapter);
  const maxConcurrentTurns = resolveMaxConcurrentTurns(env);
  const telemetry = await loadTelemetryAdapterFromEnv(env);
  const bridge = new Bridge(accessStore, sessionManager, adapter, {
    botInstructionsPath: instructionsPath,
    loadGroupMode: async () => (await loadInstanceConfig(config.stateDir)).groupMode,
    recordFailedAttempt: async (receipt) => {
      await recordBridgeTurnUsage(config.stateDir, receipt.usage, undefined);
    },
    beforeRetry: async (locale) => {
      // Reload fail-closed: configuration and budget may change during a wait.
      const latest = await readValidatedConfigFile(configPath, { forExecution: true, requireValidBudget: true });
      const exhausted = await checkBudgetAvailability(config.stateDir, latest.budgetUsd, locale);
      if (exhausted) throw new EngineRecoveryBudgetError(exhausted.message);
    },
    ...(options.runtimeInstructions ? { runtimeInstructions: options.runtimeInstructions } : {}),
    turnPool: maxConcurrentTurns > 0
      ? new FileTurnPool({
        maxActive: maxConcurrentTurns,
        ...(env.TAROCUB_TURN_POOL_PATH ? { poolPath: env.TAROCUB_TURN_POOL_PATH } : {}),
        telemetry,
        telemetryTags: {
          channel: options.transport ?? "gateway",
          instanceName: config.instanceName,
        },
      })
      : undefined,
    turnPoolMetadata: {
      channel: options.transport ?? "gateway",
      instanceName: config.instanceName,
    },
    telemetry,
    telemetryTags: {
      channel: options.transport ?? "gateway",
      instanceName: config.instanceName,
    },
  });

  return { config, bridge };
}

export async function createBridgeDependencies(
  env: EnvSource,
  options: BridgeDependencyOptions = {},
): Promise<{ config: ReturnType<typeof resolveConfig>; bridge: Bridge }> {
  return createBridgeDependenciesForConfig(env, resolveBridgeConfig(env), options);
}
