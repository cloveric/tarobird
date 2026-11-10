// Copy on read; the next explicit settings update writes only canonical keys.
function normalizeConfigNames(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...value } as Record<string, unknown>;
  for (const [oldKey, key] of [["larkElementStream", "elementStream"], ["larkSteerEnabled", "steerEnabled"], ["larkSteerWindowSeconds", "steerWindowSeconds"]] as const) {
    if (record[key] === undefined && record[oldKey] !== undefined) record[key] = record[oldKey];
    delete record[oldKey];
  }
  return record;
}

import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

import {
  ConfigFileSchema,
  EFFORT_LEVELS,
  formatSchemaError,
  type ConfigFile,
  type EffortLevel,
} from "../state/config-file-schema.js";
import {
  normalizeApprovalMode,
  resolveApprovalModeForEngine,
} from "../state/approval-mode.js";
import { normalizeCronTimezone, resolveDefaultCronTimezone } from "../state/cron-timezone.js";
import { withFileMutex } from "../state/file-mutex.js";
import { STATE_FILE_MODE } from "../state/state-permissions.js";
import { EngineConfigError } from "../state/engine-config-error.js";
import { isExtendedCodexEffort, knownCodexModelSupportsEffort } from "../codex/model-capabilities.js";

export type { EffortLevel };
export type InstanceEngine = "codex" | "claude" | "antigravity" | "kimi" | "deepseek";

export const CLAUDE_MODEL_CHOICES = [
  "claude-opus-5-5[1m]",
  "claude-fable-5-2",
  "opus",
  "sonnet",
  "haiku",
] as const;
export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODEL_CHOICES[0];
export const DEFAULT_CLAUDE_EFFORT: EffortLevel = "xhigh";
export const DEFAULT_CODEX_EFFORT: EffortLevel = "xhigh";
export const KIMI_EFFORT_LEVELS = ["low", "high", "max"] as const satisfies readonly EffortLevel[];
export const ANTIGRAVITY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];
// Clearing the bridge override follows Harness defaults; it does not guarantee
// that reasoning is disabled. Only explicit non-default effort levels persist.
export const DEEPSEEK_EFFORT_LEVELS = ["low", "high", "max"] as const satisfies readonly EffortLevel[];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVELS.includes(value as EffortLevel);
}

export function getEngineEffortValidationError(
  engine: InstanceEngine,
  effort: EffortLevel | undefined,
  model?: string,
): string | undefined {
  if (effort === undefined) return undefined;
  if (engine === "codex" && isExtendedCodexEffort(effort) && knownCodexModelSupportsEffort(model, effort) !== true) {
    return "The selected Codex model does not support this effort";
  }
  if (engine === "claude" && effort === "ultra") {
    return "Claude effort supports only low, medium, high, xhigh, or max";
  }
  // Official Claude model capability matrix: older/Haiku models do not all
  // support the CLI's five accepted level names. Aliases follow the CLI model.
  if (engine === "claude" && model) {
    const name = model.toLowerCase().replace(/\[1m\]$/, "").replaceAll(".", "-");
    if (/haiku|sonnet-4-[05]|opus-4(?:-0)?(?:-20|$)|sonnet-3|opus-3/.test(name)) return "This Claude model does not support effort";
    if (effort === "xhigh" && /(?:opus|sonnet)-4-6/.test(name)) return "This Claude model does not support xhigh";
    if (["xhigh", "max"].includes(effort) && /opus-4-5/.test(name)) return "This Claude model supports only low, medium, or high";
  }
  if (engine === "kimi" && !KIMI_EFFORT_LEVELS.includes(effort as (typeof KIMI_EFFORT_LEVELS)[number])) {
    return "Kimi effort supports only low, high, or max";
  }
  if (
    engine === "antigravity" &&
    !ANTIGRAVITY_EFFORT_LEVELS.includes(effort as (typeof ANTIGRAVITY_EFFORT_LEVELS)[number])
  ) {
    return "Antigravity effort supports only low, medium, high, xhigh, or max";
  }
  if (
    engine === "deepseek" &&
    !DEEPSEEK_EFFORT_LEVELS.includes(effort as (typeof DEEPSEEK_EFFORT_LEVELS)[number])
  ) {
    return "DeepSeek Harness effort supports only low, high, or max";
  }
  return undefined;
}

/** Model/effort for one conversation's turns (a dispatcher ticket); never written to config.json. */
export interface EngineOverride { model?: string; effort?: EffortLevel }

/** Phrased like a provider mismatch so Core reports it as engine-settings. */
export function unsupportedEngineEffortError(engine: InstanceEngine, effort: string, model: string | undefined): Error {
  const available = EFFORT_LEVELS.filter(level => !getEngineEffortValidationError(engine, level, model));
  const name = (model || `${engine}-default`).replace(/\[1m\]$/i, "");
  return new Error(available.length
    ? `Invalid model selection: ${name} has no "${effort}" effort (available: ${available.join(", ")})`
    : `Invalid model selection: ${name} does not support effort`);
}

/**
 * Overrides the Bot's configured model/effort field by field. An unsupported
 * requested effort fails the turn; an inherited Bot effort that the requested
 * model does not support is dropped, as config sanitizing does.
 */
export function resolveEngineOverride<T extends { model?: string; effort?: string }>(
  engine: InstanceEngine,
  configured: T,
  override: EngineOverride | undefined,
): T {
  if (!override?.model && !override?.effort) return configured;
  const model = override.model || configured.model;
  if (override.effort) {
    if (getEngineEffortValidationError(engine, override.effort, model)) throw unsupportedEngineEffortError(engine, override.effort, model);
    return { ...configured, model, effort: override.effort } as T;
  }
  const effort = configured.effort && !getEngineEffortValidationError(engine, configured.effort as EffortLevel, model) ? configured.effort : undefined;
  return { ...configured, model, effort } as T;
}

export function normalizeModelCommandInput(engine: InstanceEngine | undefined, model: string): string {
  const trimmed = model.trim();
  if (engine !== "claude") {
    return trimmed;
  }
  const spacedContextSuffix = trimmed.match(/^(\S+)\s+\[1m\]$/i);
  return spacedContextSuffix ? `${spacedContextSuffix[1]}[1m]` : trimmed;
}
// Default steer eligibility window: a running turn accepts mid-turn steering for
// its first 30s; later messages queue as their own turn. /steer <seconds> tunes it,
// 0 = unlimited, /steer off disables steering entirely.
export const DEFAULT_STEER_WINDOW_SECONDS = 30;

export interface ResumeState {
  sessionId: string;
  dirName: string;
  workspacePath: string;
  /**
   * @deprecated Kept for backward compatibility. New /resume flows no longer
   * create a symlink because all bots share ~/.claude/ directly.
   */
  symlinkPath?: string;
}

export interface InstanceConfig {
  engine: InstanceEngine;
  /** A dispatcher Bot receives the host-owned dispatcher contract each turn. */
  role?: "dispatcher";
  /** Claude native Chrome integration. Only meaningful for the Claude engine. */
  claudeChrome: boolean;
  locale: "en" | "zh";
  verbosity: 0 | 1 | 2;
  budgetUsd: number | undefined;
  effort: EffortLevel | undefined;
  model: string | undefined;
  codexServiceTier: "fast" | undefined;
  /** Lark element-level streaming (native typewriter). undefined = on (default); false = /stream off. */
  elementStream: boolean | undefined;
  /** Lift the bridge runtime watchdog. undefined/false = cap enforced; true = /timeout off. */
  disableRuntimeTimeout: boolean | undefined;
  /** Mid-turn steering. undefined/true = enabled (default); false = /steer off (mid-turn messages always queue). */
  steerEnabled: boolean | undefined;
  /** Steer eligibility window in seconds. undefined = default (30); 0 = unlimited (steer any time). */
  steerWindowSeconds: number | undefined;
  timezone: string;
  resume: ResumeState | undefined;
  workspacePath: string | undefined;
  workspaceProfiles: WorkspaceProfile[];
  groupMode: GroupModeConfig;
  /** Feishu VC bot-in-meeting. OFF unless `enabled` is true; requires beta scopes. */
  meeting: MeetingConfig;
}

export interface MeetingConfig {
  enabled: boolean;
  autoJoinOnInvite: boolean;
  trigger: string;
  transcriptKeep: number;
  respondIn: "meeting" | "im" | "both";
  pollIntervalMs: number;
  summaryOnEnd: boolean;
}

export const DEFAULT_MEETING_CONFIG: MeetingConfig = {
  enabled: false,
  autoJoinOnInvite: false,
  trigger: "@bot",
  transcriptKeep: 200,
  respondIn: "meeting",
  pollIntervalMs: 3000,
  summaryOnEnd: false,
};

function sanitizeConfigCompatibility(config: ConfigFile, configPath: string): ConfigFile {
  const effort = config.effort as EffortLevel | undefined;
  const engine = config.engine ?? "codex";
  const reason = getEngineEffortValidationError(engine, effort, config.model);
  if (!reason) {
    return config;
  }

  const sanitized = { ...config };
  delete sanitized.effort;
  const logReason = engine === "antigravity"
    ? "Antigravity supports only low, medium, high, xhigh, and max"
    : engine === "deepseek"
      ? "DeepSeek Harness supports only low, high, and max"
      : engine === "kimi"
        ? "Kimi ACP supports only low, high, and max"
        : engine === "claude"
          ? reason
          : "the selected Codex model does not advertise that effort";
  console.error(
    `Ignored incompatible effort ${effort} in ${configPath}; ${logReason}.`,
  );
  return sanitized;
}

export interface WorkspaceProfile {
  name: string;
  path: string;
  updatedAt: string;
}

export interface GroupModeConfig {
  enabled: boolean;
  allowedChatIds: number[];
  listenAllChatIds: number[];
}

const VALID_EFFORT_LEVELS: EffortLevel[] = [...EFFORT_LEVELS];
const VALID_CLAUDE_EFFORT_LEVELS: EffortLevel[] = VALID_EFFORT_LEVELS.filter((level) => level !== "ultra");
const VALID_KIMI_EFFORT_LEVELS: EffortLevel[] = [...KIMI_EFFORT_LEVELS];
const VALID_ANTIGRAVITY_EFFORT_LEVELS: EffortLevel[] = [...ANTIGRAVITY_EFFORT_LEVELS];

function applyClaudeEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  const modelOverride = typeof config.model === "string" && config.model.trim().length > 0
    ? config.model.trim()
    : undefined;
  const effortOverride = VALID_CLAUDE_EFFORT_LEVELS.includes(config.effort as EffortLevel)
    ? config.effort as EffortLevel
    : undefined;

  if (previousEngine !== "claude" || modelOverride === undefined) {
    config.model = DEFAULT_CLAUDE_MODEL;
  } else {
    config.model = modelOverride;
  }
  if (previousEngine !== "claude" || effortOverride === undefined) {
    config.effort = DEFAULT_CLAUDE_EFFORT;
  }
}

function applyCodexEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  const effortOverride = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel)
    ? config.effort as EffortLevel
    : undefined;

  // Pin effort explicitly so a bot's strength cannot silently drift when
  // ~/.codex/config.toml changes (edits or codex upgrades). The model is
  // deliberately NOT pinned: codex model names churn with CLI releases, and
  // following the engine's own current default is the safer behavior there.
  if (previousEngine !== "codex" || effortOverride === undefined) {
    config.effort = DEFAULT_CODEX_EFFORT;
  }
}

function applyKimiEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  const effortOverride = VALID_KIMI_EFFORT_LEVELS.includes(config.effort as EffortLevel)
    ? config.effort as EffortLevel
    : undefined;
  if (previousEngine !== "kimi" || effortOverride === undefined) {
    // Kimi publishes model-specific defaults. Leave this unset so both new
    // and resumed sessions follow native metadata at their next safe boundary.
    delete config.effort;
  }
}

function applyDeepSeekEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  if (previousEngine !== "deepseek") {
    delete config.effort;
  }
}

function applyAntigravityEngineDefaults(config: Record<string, unknown>, previousEngine: InstanceEngine | undefined): void {
  const effortOverride = VALID_ANTIGRAVITY_EFFORT_LEVELS.includes(config.effort as EffortLevel)
    ? config.effort as EffortLevel
    : undefined;
  if (previousEngine !== "antigravity" || effortOverride === undefined) {
    delete config.effort;
  }
}

function parseResumeState(raw: unknown): ResumeState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || typeof r.dirName !== "string" || typeof r.workspacePath !== "string") {
    return undefined;
  }
  return {
    sessionId: r.sessionId,
    dirName: r.dirName,
    workspacePath: r.workspacePath,
    symlinkPath: typeof r.symlinkPath === "string" ? r.symlinkPath : undefined,
  };
}

export const DEFAULT_INSTANCE_CONFIG: InstanceConfig = {
  engine: "codex",
  claudeChrome: false,
  locale: "en",
  verbosity: 1,
  budgetUsd: undefined,
  effort: undefined,
  model: undefined,
  codexServiceTier: undefined,
  elementStream: undefined,
  disableRuntimeTimeout: undefined,
  steerEnabled: undefined,
  steerWindowSeconds: undefined,
  timezone: resolveDefaultCronTimezone(),
  resume: undefined,
  workspacePath: undefined,
  workspaceProfiles: [],
  groupMode: {
    enabled: true,
    allowedChatIds: [],
    listenAllChatIds: [],
  },
  meeting: DEFAULT_MEETING_CONFIG,
};

function parseMeetingConfig(raw: unknown): MeetingConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_MEETING_CONFIG;
  }
  const r = raw as Record<string, unknown>;
  const bool = (key: keyof MeetingConfig, fallback: boolean): boolean =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : fallback;
  const clampInt = (value: unknown, min: number, max: number, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  const respondIn = r.respondIn === "im" || r.respondIn === "both" ? r.respondIn : "meeting";
  return {
    enabled: bool("enabled", DEFAULT_MEETING_CONFIG.enabled),
    autoJoinOnInvite: bool("autoJoinOnInvite", DEFAULT_MEETING_CONFIG.autoJoinOnInvite),
    trigger: typeof r.trigger === "string" && r.trigger.trim() ? r.trigger.trim() : DEFAULT_MEETING_CONFIG.trigger,
    transcriptKeep: clampInt(r.transcriptKeep, 10, 2000, DEFAULT_MEETING_CONFIG.transcriptKeep),
    respondIn,
    pollIntervalMs: clampInt(r.pollIntervalMs, 1000, 60000, DEFAULT_MEETING_CONFIG.pollIntervalMs),
    summaryOnEnd: bool("summaryOnEnd", DEFAULT_MEETING_CONFIG.summaryOnEnd),
  };
}

function parseGroupMode(raw: unknown): GroupModeConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_INSTANCE_CONFIG.groupMode;
  }
  const r = raw as Record<string, unknown>;
  const allowedChatIds = Array.isArray(r.allowedChatIds)
    ? [...new Set(r.allowedChatIds.filter((value): value is number => Number.isInteger(value)))]
    : [];
  const enabled = r.enabled === false ? false : true;
  const listenAllChatIds = enabled && Array.isArray(r.listenAllChatIds)
    ? [...new Set(r.listenAllChatIds.filter((value): value is number => Number.isInteger(value)))]
    : [];
  return {
    enabled,
    allowedChatIds,
    listenAllChatIds,
  };
}

function parseWorkspaceProfiles(raw: unknown): WorkspaceProfile[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const profiles = new Map<string, WorkspaceProfile>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.path !== "string") {
      continue;
    }
    const name = record.name.trim();
    const profilePath = record.path.trim();
    if (!name || !profilePath) {
      continue;
    }
    profiles.set(name, {
      name,
      path: profilePath,
      updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
        ? record.updatedAt
        : new Date(0).toISOString(),
    });
  }
  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveInstanceWorkspacePath(config: Pick<InstanceConfig, "workspacePath" | "resume">): string | undefined {
  return config.workspacePath ?? config.resume?.workspacePath;
}

export function applyEngineSelection(
  config: Record<string, unknown>,
  engine: InstanceEngine,
): { clearedModel: boolean; enabledFullAuto: boolean } {
  const previousEngine =
    config.engine === "claude" || config.engine === "codex" || config.engine === "antigravity" || config.engine === "kimi" || config.engine === "deepseek"
      ? config.engine
      : undefined;
  const hadModelOverride = typeof config.model === "string" && config.model.trim().length > 0;

  config.engine = engine;

  const clearedModel = previousEngine !== undefined && previousEngine !== engine && hadModelOverride;
  if (clearedModel) {
    delete config.model;
  }
  if (engine !== "codex") {
    delete config.codexServiceTier;
  }
  if (engine === "claude") {
    applyClaudeEngineDefaults(config, previousEngine);
  }
  if (engine === "codex") {
    applyCodexEngineDefaults(config, previousEngine);
  }
  if (engine === "kimi") {
    applyKimiEngineDefaults(config, previousEngine);
  }
  if (engine === "deepseek") {
    applyDeepSeekEngineDefaults(config, previousEngine);
  }
  if (engine === "antigravity") {
    applyAntigravityEngineDefaults(config, previousEngine);
  }
  if (engine !== "kimi") {
    delete config.kimiAutoNeverAskAcknowledged;
  } else if (
    normalizeApprovalMode(config.approvalMode) === "bypass"
    && config.kimiAutoNeverAskAcknowledged !== true
  ) {
    config.approvalMode = "full-auto";
  }
  if (normalizeApprovalMode(config.approvalMode) === undefined) {
    // Missing means a new/default config; present-but-invalid means damaged
    // permissions. An unrelated engine change must not widen the latter.
    config.approvalMode = config.approvalMode === undefined
      ? resolveApprovalModeForEngine(engine, undefined)
      : "normal";
  }
  // Antigravity normal now supports explicit whole-turn approval followed by
  // sandboxed execution. Selecting/reselecting an engine must not skip it.
  return { clearedModel, enabledFullAuto: false };
}

export async function readValidatedConfigFile(configPath: string, options: { forExecution?: boolean; requireValidBudget?: boolean } = {}): Promise<ConfigFile> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (options.forExecution) throw new EngineConfigError();
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(
        `Failed to read ${configPath}, falling back to defaults:`,
        error instanceof Error ? error.message : error,
      );
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (options.forExecution) throw new EngineConfigError();
    console.error(
      `Malformed ${configPath} (${error instanceof Error ? error.message : error}); running on defaults until this is repaired.`,
    );
    return {};
  }

  if (options.forExecution) {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new EngineConfigError();
    // Legacy defaults apply only to a readable, valid config. Never salvage an
    // invalid approval value by dropping it and thereby selecting Bypass/YOLO.
    const record = parsed as Record<string, unknown>;
    for (const key of ["engine", "approvalMode", "claudePermissionMode", "kimiAutoNeverAskAcknowledged", "codexRuntime"] as const) {
      if (!ConfigFileSchema.shape[key].safeParse(record[key]).success) throw new EngineConfigError();
    }
  }
  if (options.requireValidBudget && !ConfigFileSchema.shape.budgetUsd.safeParse((parsed as Record<string, unknown>)?.budgetUsd).success) throw new EngineConfigError("budget");
  parsed = normalizeConfigNames(parsed);
  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    // One invalid field must not discard the WHOLE config (engine would silently
    // flip to codex, the group allowlist would empty, ...). Salvage field by field:
    // keep every known field that validates on its own, drop only the bad ones.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(
        `Malformed ${configPath} (${formatSchemaError(result.error)}); running on defaults until this is repaired.`,
      );
      return {};
    }
    const shape = ConfigFileSchema.shape as Record<string, z.ZodTypeAny | undefined>;
    const salvaged: Record<string, unknown> = {};
    const droppedFields: string[] = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const fieldSchema = shape[key];
      if (!fieldSchema) {
        // Unknown keys pass through, matching the schema's passthrough behavior.
        salvaged[key] = value;
        continue;
      }
      const fieldResult = fieldSchema.safeParse(value);
      if (fieldResult.success) {
        salvaged[key] = fieldResult.data;
      } else {
        droppedFields.push(key);
      }
    }
    console.error(
      `Malformed ${configPath} (${formatSchemaError(result.error)}); dropped invalid field(s) [${droppedFields.join(", ")}] and kept the rest until this is repaired.`,
    );
    return sanitizeConfigCompatibility(salvaged as ConfigFile, configPath);
  }

  return sanitizeConfigCompatibility(result.data, configPath);
}

export async function loadInstanceConfig(stateDir: string): Promise<InstanceConfig> {
  const configPath = path.join(stateDir, "config.json");
  const config = await readValidatedConfigFile(configPath);

  const effort = VALID_EFFORT_LEVELS.includes(config.effort as EffortLevel) ? config.effort as EffortLevel : undefined;
  return {
    engine: config.engine === "claude" || config.engine === "antigravity" || config.engine === "kimi" || config.engine === "deepseek" ? config.engine : "codex",
    ...(config.role === "dispatcher" ? { role: "dispatcher" as const } : {}),
    claudeChrome: config.claudeChrome === true,
    locale: config.locale === "zh" ? "zh" : "en",
    verbosity: config.verbosity === 0 ? 0 : config.verbosity === 2 ? 2 : 1,
    budgetUsd: typeof config.budgetUsd === "number" && config.budgetUsd > 0 ? config.budgetUsd : undefined,
    effort,
    model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : undefined,
    codexServiceTier: config.codexServiceTier === "fast" ? "fast" : undefined,
    elementStream: typeof config.elementStream === "boolean" ? config.elementStream : undefined,
    disableRuntimeTimeout: typeof config.disableRuntimeTimeout === "boolean" ? config.disableRuntimeTimeout : undefined,
    steerEnabled: typeof config.steerEnabled === "boolean" ? config.steerEnabled : undefined,
    steerWindowSeconds: typeof config.steerWindowSeconds === "number" && Number.isInteger(config.steerWindowSeconds) && config.steerWindowSeconds >= 0
      ? config.steerWindowSeconds
      : undefined,
    timezone: normalizeCronTimezone(config.timezone) ?? DEFAULT_INSTANCE_CONFIG.timezone,
    resume: parseResumeState(config.resume),
    workspacePath: typeof config.workspacePath === "string" && config.workspacePath.trim()
      ? config.workspacePath.trim()
      : undefined,
    workspaceProfiles: parseWorkspaceProfiles(config.workspaceProfiles),
    groupMode: parseGroupMode(config.groupMode),
    meeting: parseMeetingConfig(config.meeting),
  };
}

export async function updateInstanceConfig<T = void>(
  stateDir: string,
  updater: (config: Record<string, unknown>) => T,
): Promise<T> {
  const configPath = path.join(stateDir, "config.json");
  return await withFileMutex(configPath, async () => {
    let config: Record<string, unknown> = {};
    let needsRecovery = false;
    try {
      const existing = await readFile(configPath, "utf8");
      const parsed = JSON.parse(existing) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        needsRecovery = true;
      } else {
        config = normalizeConfigNames(parsed) as Record<string, unknown>;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Missing file — start fresh.
      } else if (error instanceof SyntaxError) {
        needsRecovery = true;
      } else {
        throw error; // transient I/O — don't clobber the intact file
      }
    }
    if (needsRecovery) {
      // Copy, never move: a failed updater/write or a crash must leave the bad
      // config in place, so the next command cannot mistake it for first setup.
      // Backup errors propagate; never overwrite an existing backup or proceed
      // with default Bypass after a transient copy failure.
      const backupPath = `${configPath}.corrupt.${Date.now()}.bak`;
      await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
      // copyFile preserves read-only modes; the private backup needs a writable
      // handle for Windows FlushFileBuffers without changing the original.
      await chmod(backupPath, STATE_FILE_MODE);
      // The backup becomes the only copy of the old settings after replacement.
      // Sync its bytes and directory entry first; keep the original on failure.
      const backupHandle = await open(backupPath, "r+");
      try { await backupHandle.sync(); } finally { await backupHandle.close(); }
      try {
        const directoryHandle = await open(path.dirname(configPath), "r");
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } catch (error) {
        // Match JsonStore's portability boundary for unsupported directory sync.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
      }
      config = { approvalMode: "normal" };
      console.error(`Corrupt ${configPath}; backed up and recovering with normal approvals.`);
    }
    const result = updater(config);
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(config, null, 2) + "\n", {
        encoding: "utf8",
        mode: STATE_FILE_MODE,
      });
      // fsync before rename (matching JsonStore.write) so a crash right after the
      // rename can't leave an empty/truncated config.json behind.
      const tempHandle = await open(tempPath, "r+");
      try {
        await tempHandle.sync();
      } finally {
        await tempHandle.close();
      }
      await rename(tempPath, configPath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
    return result;
  });
}

export async function updateInstanceApprovalMode(
  stateDir: string,
  approvalMode: "normal" | "full-auto" | "bypass",
): Promise<InstanceEngine> {
  return await updateInstanceConfig(stateDir, (config) => {
    const engine: InstanceEngine = config.engine === "claude"
      || config.engine === "antigravity"
      || config.engine === "kimi"
      || config.engine === "deepseek"
      ? config.engine
      : "codex";
    config.approvalMode = approvalMode;
    delete config.claudePermissionMode;
    if (approvalMode === "bypass" && engine === "kimi") {
      config.kimiAutoNeverAskAcknowledged = true;
    } else {
      delete config.kimiAutoNeverAskAcknowledged;
    }
    return engine;
  });
}
