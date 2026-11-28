import { raceAbort } from "../runtime/abort-race.js";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostT } from "../locales/index.js";

import {
  client as acpClient,
  CreateElicitationRequest as CreateElicitationRequestGuard,
  methods as acpMethods,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  type ElicitationPropertySchema,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";

import { isLogicalSessionId } from "../runtime/logical-session.js";
import { AdapterQuotaCache, type EngineQuotaReadOptions, type EngineQuotaReadResult } from "./adapter-account-quota.js";
import { cancelOwnedAntigravityQuotaReads, readOwnedAntigravityQuota, type AntigravityQuotaSpawn } from "./antigravity-account-quota.js";
import { antigravitySupportsSwarm } from "./antigravity-acp-support.js";
import {
  applySwarmAcpUpdate,
  emptyParsedSwarmFiles,
  extractWorkerAttribution,
  hasActiveSwarmExecution,
  isSwarmMemberActive,
  isSwarmToolName,
  mergeSwarmSnapshots,
  readSwarmBoardFiles,
  readSwarmBoardFilesSync,
  resolveAntigravityBrainDir,
  snapshotSwarmMembersFileSync,
  swarmMembersToEngineTasks,
  toSwarmV1Snapshot,
  type AcpSwarmState,
  type ParsedSwarmFiles,
  type SwarmBoardFileCache,
} from "./antigravity-swarm.js";
import { spawnEngine } from "../runtime/engine-process.js";
import { APP_STOP_PROCESS_GRACE_MS, appStopKillOptions } from "../runtime/turn-cancellation.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { ANTIGRAVITY_EFFORT_LEVELS, readValidatedConfigFile, resolveEngineOverride } from "../state/instance-config.js";
import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexUserMessageInput,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineContextUsage,
  EngineStreamEvent,
  EngineTask,
  EngineTaskSnapshot,
  EngineSessionRestartOptions,
  EngineSessionRestartResult,
} from "./adapter.js";
import { EngineIncompleteResponseError, EngineSteeringRejectedError } from "./adapter.js";
import { killProcessTree } from "./process-tree.js";
import { EngineSessionRestarts, observeEngineProcessExit } from "./engine-session-restart.js";
import { extractAntigravityTaskPlan, parseAcpPlanSummary, type AntigravityTodoItem } from "./antigravity-task-plan.js";
import { renderPrivateTurnInstructions } from "./turn-instructions.js";
import { isChineseLocale } from "../runtime/locale.js";
import { discoverAntigravityModels } from "./antigravity-models.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type AgyReadable = {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

type AgyWritable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end?(callback?: () => void): void;
  destroy?(error?: Error): void;
  on?(event: "error", listener: (error: Error) => void): unknown;
};

export type AgyAcpChildProcess = {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdin?: AgyWritable;
  stdout?: AgyReadable;
  stderr?: AgyReadable;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "exit" | "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
};

export type SpawnAgyAcp = (command: string, args: string[], options: SpawnOptions) => AgyAcpChildProcess;

export type AntigravityAcpAdapterOptions = {
  childEnv?: NodeJS.ProcessEnv;
  configPath?: string;
  workspacePath: string;
  /** Override Antigravity brain directory (default: ~/.gemini/antigravity-cli/brain). */
  brainDir?: string;
  /** Optional version capability check override for `/swarm` availability. */
  supportsSwarmFn?: () => Promise<boolean>;
  spawnFn?: SpawnAgyAcp;
  /** Starts the one-shot `agy -p /usage` read; never the ACP server. */
  quotaSpawnFn?: AntigravityQuotaSpawn;
  localQuotaProbe?: boolean | Partial<import("./antigravity-local-server.js").AntigravityLocalProbeDeps>;
  killProcessTreeFn?: (pid: number | undefined, options?: { graceMs: number }) => void;
  initializeTimeoutMs?: number;
  /** Bound for each session/close before the process is ended anyway. */
  closeTimeoutMs?: number;
  /** How long a user stop waits for `cancelled` before the session is closed. */
  cancelGraceMs?: number;
  /** Quiet period after an idle session's last usage_update. */
  wakeQuietMs?: number;
  /** How long a steer waits for agy to take it over before it is reported as uncertain. */
  steerAdmissionTimeoutMs?: number;
  /** How long a first-turn `/swarm` waits for initial `available_commands_update` before continuing. */
  commandsAdvertiseTimeoutMs?: number;
  idleWorkerTtlMs?: number;
  idleSweepIntervalMs?: number;
  turnTimeoutMs?: number | null;
  inactivityTimeoutMs?: number | null;
  /** Hard total wall-clock ceiling for an active swarm (default: 6h, aligned with turnTimeoutMs). */
  swarmMaxDurationMs?: number;
};

type RuntimeConfig = {
  approvalMode: ApprovalMode;
  legacyTurnApproval?: boolean;
  model?: string;
  effort?: (typeof ANTIGRAVITY_EFFORT_LEVELS)[number];
};

type SelectOption = { value: string; name?: string };
type ConfigSelect = { id: string; category?: string | null; currentValue?: string; options: SelectOption[] };

type ToolState = {
  id: string;
  /** Opaque handle shown to the App instead of the native call id. */
  token: string;
  name: string;
  kind?: string;
  title?: string;
  workerName?: string;
  rawInput?: unknown;
  status: string;
  startedAt: number;
  updatedAt: number;
  /** The turn that started this call; undefined when it began while idle. */
  turn?: Turn;
  /** The model moved on (a later model call or the turn ended) while this call still runs. */
  background: boolean;
  emittedUse: boolean;
  emittedResult: boolean;
  emittedPermission: boolean;
  /** Internal Antigravity brain/<sessionId>/task.md artifact surfaced as TodoWrite plan. */
  isTaskArtifact?: boolean;
  lastDiffNewText?: string;
};

type PromptOutcome = { result?: PromptResponse; error?: unknown };
type Admission = { admitted: true } | { admitted: false; error?: unknown };
type PromptEntry = {
  seq: number;
  settled: boolean;
  steer?: boolean;
  /** agy handed the run to this steer: the prompt before it returned. */
  admitted?: boolean;
  outcome?: PromptOutcome;
  /** A steer waits for agy to take it: the prompt it replaces returns first. */
  admission?: (result: Admission | undefined) => void;
};

type Turn = {
  wholeTurnApproval: boolean;
  worker: Worker;
  prompts: PromptEntry[];
  text: string;
  usage: AdapterUsage | undefined;
  toolSeen: boolean;
  /** Last emitted TodoWrite payload JSON to deduplicate identical task.md updates. */
  lastPlanJson?: string;
  /** Tool calls that emitted permission_request in this turn, so their matching tool_result is never orphaned. */
  permissionTools: Map<string, { name?: string; kind?: string; title?: string; rawInput?: unknown; isTaskArtifact?: boolean }>;
  /** Length of the reply text when the owner last declined an approval in this turn. */
  declinedAt?: number;
  /** The prompt is exactly the native /compact, which agy completes without text. */
  compact: boolean;
  /** This turn spawned an async subagent/swarm worker whose ACP tool_call completed immediately on spawn. */
  hasAsyncSubagent: boolean;
  /** The model completed an LLM step (`usage_update`) with no active foreground tool and is waiting for reactive wakeup. */
  awaitingReactiveWake: boolean;
  locale?: CodexUserMessageInput["locale"];
  onProgress?: CodexUserMessageInput["onProgress"];
  onEngineEvent?: CodexUserMessageInput["onEngineEvent"];
  onApprovalRequest?: CodexUserMessageInput["onApprovalRequest"];
  approvals: AbortController;
  eventChain: Promise<void>;
  stopRequested: boolean;
  stopKillOptions?: { graceMs: number };
  stopTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
  timeoutsDisabled: boolean;
  done: boolean;
  resolve: (response: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
};

/**
 * Output agy pushes to an idle session (a background command or subagent
 * finished). It carries no request id and no end marker: it ends after the
 * last usage_update once nothing arrives for a quiet period, unless a tool
 * started after that model call is still running.
 */
type Wake = {
  text: string;
  /** Tools started after the latest usage_update that are still running. */
  openTools: Set<string>;
  /** Handler of the turn that started a background command finishing here. */
  owner?: CodexUserMessageInput["onEngineEvent"];
  timer?: ReturnType<typeof setTimeout>;
};

type Worker = {
  child: AgyAcpChildProcess;
  connection: ClientConnection;
  initialized?: InitializeResponse;
  sessionId: string | null;
  workspacePath: string;
  launchKey: string;
  configKey?: string;
  configOptions: ConfigSelect[];
  currentModeId?: string;
  /** True only after the user explicitly invoked `/plan` in this live worker. */
  planModeRequested: boolean;
  /** Created with session/new: the Host learns the native id from the first turn. */
  announceSession: boolean;
  turn: Turn | null;
  /** A turn is being prepared (session config) and will start next. */
  reserved: boolean;
  /** The latest turn's event handler; idle wake-ups without an owner report through it. */
  lastTurnHandler?: CodexUserMessageInput["onEngineEvent"];
  /** Active/recent swarm state observed over ACP for this session. */
  swarm?: AcpSwarmState & { ownerTurn?: Turn };
  /** Hard ceiling timer enforcing swarmMaxDurationMs on active swarms. */
  swarmTimer?: ReturnType<typeof setTimeout>;
  swarmTimerDeadline?: number;
  /** Cached stat/parse result for synchronous board-file checks. */
  swarmFileCache?: SwarmBoardFileCache;
  /** Waiters unblocked if this worker closes while waiting for available_commands_update. */
  commandCloseWaiters: Set<() => void>;
  wake: Wake | null;
  promptSeq: number;
  tools: Map<string, ToolState>;
  lastTaskMarkdown?: string;
  pendingPermissions: number;
  contextUsage?: { used: number; size: number };
  stderrTail: string;
  lastActivityAt: number;
  quotaCredentialAtSpawn: string;
  removed: boolean;
  /** Set while initialize and the session request are in flight; ends that wait when the worker is removed. */
  rejectStart?: (error: Error) => void;
  closing?: Promise<void>;
  exited: boolean;
  failure?: Error;
};

const MAX_ACP_LINE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_WAKE_QUIET_MS = 3_000;
const DEFAULT_IDLE_WORKER_TTL_MS = 2 * 60 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
export const ANTIGRAVITY_ACP_TURN_TIMEOUT_MS = 6 * 60 * 60_000;
export const ANTIGRAVITY_ACP_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export const ANTIGRAVITY_ACP_SWARM_MAX_DURATION_MS = 6 * 60 * 60_000;
const STOPPED_BY_USER = "Task was stopped by user";
const DEFAULT_STEER_ADMISSION_TIMEOUT_MS = 10_000;
const DEFAULT_COMMANDS_ADVERTISE_TIMEOUT_MS = 750;
const MAX_NATIVE_COMMANDS = 500;
/** Orchestration tools whose child agents/workflows/timers run inside `agy` without emitting parent ACP updates. */
const SILENT_LONG_RUNNING_TOOLS = new Set(["run_workflow", "invoke_subagent", "schedule"]);

function spawnsReactiveSubagent(tool: ToolState): boolean {
  const name = tool.name || tool.title || "";
  // Swarm lifecycle is tracked separately via `worker.swarm` + `onInactivityTimeout`
  // so permanently paused/waiting swarms still time out instead of bypassing inactivity.
  return name === "invoke_subagent";
}
const NATIVE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ANTIGRAVITY_EFFORTS: ReadonlySet<string> = new Set(ANTIGRAVITY_EFFORT_LEVELS);
const PRESET_SUFFIX = /-(low|medium|high|xhigh|max|ultra)$/;
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

function permissionFlags(mode: ApprovalMode): string[] {
  if (mode === "bypass") return ["--dangerously-skip-permissions"];
  if (mode === "full-auto") return ["--dangerously-skip-permissions", "--sandbox"];
  return [];
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"") ? trimmed.slice(1, -1) : trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalized = normalizeExecutableCommand(command);
  if (process.platform === "win32") return { command: normalized, args, shell: false };
  if (/\.(cmd|bat)$/i.test(normalized)) return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", normalized, ...args] };
  if (/\.ps1$/i.test(normalized)) return { command: "pwsh", args: ["-NoProfile", "-File", normalized, ...args] };
  return { command: normalized, args, shell: false };
}

function createAcpStream(stdout: AgyReadable, stdin: AgyWritable, onActivity: () => void, onFailure: (error: Error) => void): Stream {
  const decoder = new TextDecoder();
  let buffer = "";
  let settled = false;
  const readable = new ReadableStream<unknown>({
    start(controller) {
      // A line that is not protocol JSON, an oversized line or a failed pipe: the session cannot continue.
      const fail = (error: Error) => { if (!settled) { settled = true; controller.error(error); onFailure(error); } };
      const enqueueLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try { controller.enqueue(JSON.parse(trimmed) as unknown); }
        catch { fail(new Error("Antigravity ACP emitted invalid JSON")); }
      };
      stdout.on("data", (chunk) => {
        if (settled) return;
        onActivity();
        buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer, "utf8") > MAX_ACP_LINE_BYTES) { fail(new Error("Antigravity ACP output exceeded the maximum line size")); return; }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) { enqueueLine(line); if (settled) return; }
      });
      stdout.on("error", fail);
      stdout.on("end", () => {
        if (settled) return;
        enqueueLine(buffer + decoder.decode());
        buffer = "";
        if (!settled) { settled = true; try { controller.close(); } catch { /* the reader already cancelled */ } }
      });
    },
    // The protocol reader cancels when a write fails (the process never started or is gone).
    // Nothing may be queued or closed afterwards: a throw in these listeners ends the Bot process.
    cancel() { settled = true; },
  });
  const writable = new WritableStream<unknown>({
    write(message) {
      onActivity();
      return new Promise<void>((resolve, reject) => {
        stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    },
    close() { stdin.end?.(); },
    abort(reason) { stdin.destroy?.(reason instanceof Error ? reason : new Error(String(reason))); },
  });
  return { readable, writable } as Stream;
}

/** A request that got no answer in time: agy may still carry it out later. */
class AcpTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AcpTimeoutError(message)), ms);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/** Check the installed transport without opening a session or submitting input. */
type AcpResumeProbe = "supported" | "timed_out" | "unavailable" | "resume_unsupported" | "protocol_unsupported" | "exit_unconfirmed";

export async function probeAntigravityAcpResume(executable: string, env: NodeJS.ProcessEnv, mode: ApprovalMode): Promise<AcpResumeProbe> {
  const invocation = buildCommandInvocation(executable, ["acp", ...permissionFlags(mode)]);
  const child = spawnEngine(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env, windowsHide: true,
  });
  const exited = observeEngineProcessExit(child);
  let rejectTransport!: (error: Error) => void;
  const transportError = new Promise<never>((_resolve, reject) => { rejectTransport = reject; });
  child.on("error", rejectTransport);
  child.stdin?.on("error", rejectTransport);
  child.stderr?.resume();
  const ended = exited.then(() => { throw new Error("Antigravity ACP probe exited"); });
  let status: AcpResumeProbe = "unavailable";
  try {
    if (!child.stdout || !child.stdin) {
      void ended.catch(() => undefined);
      void transportError.catch(() => undefined);
    } else {
      const connection = acpClient().connect(createAcpStream(child.stdout, child.stdin, () => {}, rejectTransport));
      const initialize = connection.agent.request(acpMethods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "tarobird", version: "1" },
        clientCapabilities: { elicitation: { form: {} } },
      });
      const reply = await withTimeout(Promise.race([initialize, transportError, ended]), 3500, "Antigravity ACP probe timed out");
      status = reply.protocolVersion !== PROTOCOL_VERSION ? "protocol_unsupported"
        : reply.agentCapabilities?.sessionCapabilities?.resume ? "supported" : "resume_unsupported";
    }
  } catch (error) {
    if (error instanceof AcpTimeoutError) status = "timed_out";
  } finally {
    // Wait for this capability-only process to finish before switching the Bot.
    child.stdin?.end();
    try {
      await withTimeout(exited, 500, "Antigravity ACP probe did not exit");
    } catch {
      await killProcessTree(child.pid, { graceMs: 250 });
      try { await withTimeout(exited, 1000, "Antigravity ACP probe exit unconfirmed"); }
      catch { status = "exit_unconfirmed"; }
    }
  }
  return status;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readSelectOptions(value: unknown): ConfigSelect[] {
  if (!Array.isArray(value)) return [];
  const result: ConfigSelect[] = [];
  for (const item of value) {
    const option = asRecord(item);
    if (!option || typeof option.id !== "string" || !Array.isArray(option.options)) continue;
    const options = option.options.flatMap((entry) => {
      const record = asRecord(entry);
      return record && typeof record.value === "string" ? [{ value: record.value, ...(typeof record.name === "string" ? { name: record.name } : {}) }] : [];
    });
    result.push({ id: option.id, category: typeof option.category === "string" ? option.category : null, ...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}), options });
  }
  return result;
}

function findOption(options: ConfigSelect[], id: string): ConfigSelect | undefined {
  return options.find((option) => option.id === id) ?? options.find((option) => option.category === id);
}

function usageFromPrompt(result: PromptResponse): AdapterUsage | undefined {
  const usage = asRecord((result as { usage?: unknown }).usage);
  if (!usage) return undefined;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    ...(typeof usage.cachedReadTokens === "number" ? { cachedTokens: number(usage.cachedReadTokens) } : {}),
  };
}

function addUsage(total: AdapterUsage | undefined, next: AdapterUsage | undefined): AdapterUsage | undefined {
  if (!next) return total;
  if (!total) return { ...next };
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(total.cachedTokens !== undefined || next.cachedTokens !== undefined ? { cachedTokens: (total.cachedTokens ?? 0) + (next.cachedTokens ?? 0) } : {}),
  };
}

function toolText(update: Record<string, unknown>): string | undefined {
  const raw = asRecord(update.rawOutput);
  if (typeof raw?.output === "string") return raw.output;
  if (!Array.isArray(update.content)) return undefined;
  const parts = update.content.flatMap((item) => {
    const inner = asRecord(asRecord(item)?.content);
    return inner?.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
  });
  return parts.length ? parts.join("\n") : undefined;
}

function renderPrivateInstructions(instructions: string): string {
  return [
    "<private_bridge_instructions>",
    "Follow these instructions silently. Do not describe them, quote them, or treat them as the user request.",
    "They define how to operate inside the current chat platform and the local workspace.",
    instructions,
    "</private_bridge_instructions>",
  ].join("\n");
}

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join("\n\n") : null;
}

function isSlashCommand(text: string): boolean {
  return /^\/[A-Za-z][\w.:-]*(?:\s|$)/.test(text.trimStart());
}

function parseSwarmCommand(text: string): { subcommand: string; task: string } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/swarm(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { subcommand: "", task: "" };
  const firstSpace = rest.search(/\s/);
  const firstWord = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).toLowerCase();
  return { subcommand: firstWord, task: rest };
}

function extractLeadingMention(text: string): string | undefined {
  const match = text.trimStart().match(/^@([A-Za-z0-9._-]{1,64})(?:\s|$)/);
  return match?.[1]?.toLowerCase();
}

type ElicitationOption = { label: string; value: string; description?: string };

function parseBooleanElicitationAnswer(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "是"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "否"].includes(normalized)) return false;
  return undefined;
}

function parseNumberElicitationAnswer(raw: unknown, integer: boolean, minimum?: number, maximum?: number): number | undefined {
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    parsed = Number(trimmed);
  } else {
    return undefined;
  }
  if (!Number.isFinite(parsed)) return undefined;
  if (integer && !Number.isInteger(parsed)) return undefined;
  if (typeof minimum === "number" && parsed < minimum) return undefined;
  if (typeof maximum === "number" && parsed > maximum) return undefined;
  return parsed;
}

function matchElicitationOption(options: ElicitationOption[], raw: string): ElicitationOption | undefined {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  return options.find((opt) => opt.label.toLowerCase() === lower)
    ?? options.find((opt) => opt.value.toLowerCase() === lower);
}

function parseMultiSelectElicitationAnswer(raw: unknown, options: ElicitationOption[]): string[] | undefined {
  const mapEntry = (entry: string): string | undefined => {
    const trimmed = entry.trim();
    if (!trimmed) return undefined;
    if (!options.length) return trimmed;
    return matchElicitationOption(options, trimmed)?.value;
  };
  if (Array.isArray(raw)) {
    const mapped: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") return undefined;
      const value = mapEntry(item);
      if (value === undefined) return undefined;
      mapped.push(value);
    }
    return mapped;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (options.length) {
    // Match labels greedily from left to right so option labels containing commas still parse cleanly.
    const memo = new Map<number, string[] | undefined>();
    const visit = (offset: number): string[] | undefined => {
      if (offset === trimmed.length) return [];
      if (memo.has(offset)) return memo.get(offset);
      for (const opt of options) {
        for (const candidateText of [opt.label, opt.value]) {
          if (trimmed.slice(offset, offset + candidateText.length).toLowerCase() !== candidateText.toLowerCase()) continue;
          const end = offset + candidateText.length;
          if (end === trimmed.length) {
            const res = [opt.value];
            memo.set(offset, res);
            return res;
          }
          const sep = trimmed.slice(end).match(/^,\s*/);
          if (sep) {
            const tail = visit(end + sep[0].length);
            if (tail) {
              const res = [opt.value, ...tail];
              memo.set(offset, res);
              return res;
            }
          }
        }
      }
      memo.set(offset, undefined);
      return undefined;
    };
    const exact = visit(0);
    if (exact) return exact;
  }
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const mapped: string[] = [];
  for (const part of parts) {
    const value = mapEntry(part);
    if (value === undefined) return undefined;
    mapped.push(value);
  }
  return mapped;
}

function renderSwarmUnavailableMessage(reason: "version" | "not_advertised", locale?: CodexUserMessageInput["locale"]): string {
  if (reason === "version") {
    return !isChineseLocale(locale)
      ? "`/swarm` is not available because the installed `agy` CLI version is older than 1.5.5. Update `agy` to 1.5.10+ to use `/swarm` on the ACP runtime. Nothing was sent to the model."
      : "当前安装的 `agy` 版本低于 1.5.5，不支持 `/swarm`。请升级 `agy` 到 1.5.10 及以上后再在 ACP 运行时使用 `/swarm`；本次未向模型发送任何内容。";
  }
  return !isChineseLocale(locale)
    ? "`/swarm` is not available in this Antigravity CLI session (`agy acp` did not advertise `/swarm`, for example due to an older CLI version or account/plan policy). Nothing was sent to the model."
    : "当前 Antigravity CLI 会话未开放 `/swarm` 命令（`agy acp` 未返回 `/swarm`，可能是 CLI 版本或账号/套餐限制）。本次未向模型发送任何内容。";
}

function isPlanSlashCommand(text: string): boolean {
  return /^\/plan(?:\s|$)/i.test(text.trimStart());
}
async function attachmentBlocks(files: string[]): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const file of files) {
    const uri = pathToFileURL(file).href;
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()];
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (mime && info.size <= MAX_IMAGE_BYTES) {
        blocks.push({ type: "image", mimeType: mime, data: (await readFile(file)).toString("base64"), uri });
        continue;
      }
      if (!mime && info.size <= MAX_TEXT_ATTACHMENT_BYTES) {
        const bytes = await readFile(file);
        if (!bytes.includes(0)) {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            blocks.push({ type: "resource", resource: { uri, mimeType: "text/plain", text } });
          } catch {
            // Not UTF-8 text: the model reads it by path with its own tools.
          }
        }
      }
    } catch {
      // An unreadable attachment is still named by path below.
    }
  }
  return blocks;
}

function formatExit(stderr: string, code: number | null, signal?: NodeJS.Signals | null): string {
  const exit = signal ? `signal ${signal}` : `code ${code}`;
  const diagnostic = stderr.trim();
  return diagnostic ? `${diagnostic}\nAntigravity ACP exited with ${exit}` : `Antigravity ACP exited with ${exit}`;
}

function rpcErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  return typeof record?.message === "string" ? record.message : String(error);
}

/**
 * Antigravity through its official ACP server (`agy acp`). One process serves
 * one session. Before any process is ended, every session it holds is closed
 * with session/close: only that stops the background commands and subagents
 * the session started; ending stdin or the process leaves them running.
 */
export class AntigravityAcpAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "output-directory" as const;
  readonly supportsTurnScopedEnv = false;
  /** A message sent during a reply can join it as another session/prompt. */
  readonly inFlightSendBehavior = "steer" as const;

  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly brainDir: string;
  private readonly spawnFn: SpawnAgyAcp;
  private readonly killProcessTreeFn: (pid: number | undefined, options?: { graceMs: number }) => void;
  private readonly workers = new Map<string, Worker>();
  private readonly sessionRestarts = new EngineSessionRestarts();
  private readonly pendingWorkers = new Map<string, Promise<Worker>>();
  private readonly initializeTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly cancelGraceMs: number;
  protected readonly wakeQuietMs: number;
  private readonly steerAdmissionTimeoutMs: number;
  private readonly commandsAdvertiseTimeoutMs: number;
  private readonly idleWorkerTtlMs: number;
  private readonly turnTimeoutMs: number | null;
  private readonly inactivityTimeoutMs: number | null;
  private readonly swarmMaxDurationMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private reaping = false;
  private destroyPromise: Promise<void> | undefined;
  private destroyed = false;
  /** The newest available_commands_update; every session of this Bot shares the CLI and workspace. */
  private commands: Array<{ name: string; description: string }> = [];
  private commandsReceived = false;
  private readonly commandWaiters = new Set<() => void>();
  private swarmVersionSupported: Promise<boolean> | undefined;
  /** Sessions whose active swarm was stopped or timed out, surviving worker close so listTasks reflects ended state over stale files. */
  private readonly endedSwarmSessions = new Map<string, "stopped" | "timeout">();
  private readonly quotaCache: AdapterQuotaCache;

  constructor(private readonly executable: string, private readonly options: AntigravityAcpAdapterOptions) {
    const env = { ...(options.childEnv ?? process.env) };
    delete env.TELEGRAM_BOT_TOKEN;
    env.AGY_CLI_HIDE_ACCOUNT_INFO ??= "1";
    this.childEnv = env;
    this.brainDir = resolveAntigravityBrainDir(env, options.brainDir);
    this.spawnFn = options.spawnFn ?? (spawnEngine as unknown as SpawnAgyAcp);
    this.quotaCache = new AdapterQuotaCache("antigravity", executable, env, options.workspacePath, options.configPath);
    this.killProcessTreeFn = options.killProcessTreeFn ?? ((pid, kill) => killProcessTree(pid, kill));
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.wakeQuietMs = options.wakeQuietMs ?? DEFAULT_WAKE_QUIET_MS;
    this.steerAdmissionTimeoutMs = options.steerAdmissionTimeoutMs ?? DEFAULT_STEER_ADMISSION_TIMEOUT_MS;
    this.commandsAdvertiseTimeoutMs = options.commandsAdvertiseTimeoutMs ?? DEFAULT_COMMANDS_ADVERTISE_TIMEOUT_MS;
    this.idleWorkerTtlMs = options.idleWorkerTtlMs ?? DEFAULT_IDLE_WORKER_TTL_MS;
    this.turnTimeoutMs = options.turnTimeoutMs === undefined ? ANTIGRAVITY_ACP_TURN_TIMEOUT_MS : options.turnTimeoutMs;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs === undefined ? ANTIGRAVITY_ACP_INACTIVITY_TIMEOUT_MS : options.inactivityTimeoutMs;
    const explicitSwarmMax = options.swarmMaxDurationMs !== undefined && Number.isFinite(options.swarmMaxDurationMs) && options.swarmMaxDurationMs > 0
      ? options.swarmMaxDurationMs
      : undefined;
    this.swarmMaxDurationMs = explicitSwarmMax
      ?? (this.turnTimeoutMs && this.turnTimeoutMs > 0 ? Math.min(ANTIGRAVITY_ACP_SWARM_MAX_DURATION_MS, this.turnTimeoutMs) : ANTIGRAVITY_ACP_SWARM_MAX_DURATION_MS);
    const interval = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    if (this.idleWorkerTtlMs > 0 && interval > 0) {
      this.sweepTimer = setInterval(() => { void this.reapIdleWorkers(); }, interval);
      this.sweepTimer.unref?.();
    }
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `tarobot-${chatId}` };
  }

  /** Quota belongs to the login, not to the runtime: prefers the running `agy acp` / local Antigravity
   * language server (zero new processes), falling back to `agy -p /usage` when no local server answers. */
  async getAccountQuota(options: EngineQuotaReadOptions): Promise<EngineQuotaReadResult> {
    const captureScope = () => this.quotaCache.capture("process");
    const scope = captureScope();
    if (this.destroyed || this.destroyPromise) return this.quotaCache.failure(scope, "cancelled");
    const cached = this.quotaCache.response(scope, options);
    if (cached) return cached;
    const preferredPids = [...new Set([...this.workers.values()]
      .filter(worker => !worker.removed && !worker.closing && !worker.exited
        && worker.quotaCredentialAtSpawn === scope.credentialRevision
        && typeof worker.child.pid === "number" && worker.child.pid > 0)
      .map(worker => worker.child.pid as number))];
    // Keep unit tests with injected fake spawners hermetic unless `localQuotaProbe` is explicitly supplied.
    const localProbe = this.options.localQuotaProbe ?? (!this.options.quotaSpawnFn && !this.options.spawnFn);
    const cwd = this.options.workspacePath;
    return readOwnedAntigravityQuota({
      executable: this.executable, cwd, env: this.childEnv,
      spawn: this.options.quotaSpawnFn ?? (spawnEngine as unknown as AntigravityQuotaSpawn),
      cache: this.quotaCache, scope, options, captureScope,
      preferredPids,
      localProbe,
      // Real spawners only, like the local probe: injected fakes stay hermetic.
      modelCatalog: !this.options.quotaSpawnFn && !this.options.spawnFn ? () => discoverAntigravityModels(this.childEnv, false, undefined, {
        executable: this.executable, credentialRevision: scope.credentialRevision, cwd,
      }) : undefined,
    });
  }

  async getContextUsage(sessionId: string): Promise<EngineContextUsage | null> {
    const usage = this.liveWorker(sessionId)?.contextUsage;
    return usage ? { pressureTokens: usage.used, contextWindow: usage.size } : null;
  }

  supportsSessionSteering(sessionId: string): boolean {
    const worker = this.liveWorker(sessionId);
    return Boolean(worker && !worker.closing && !worker.exited && !worker.turn?.wholeTurnApproval);
  }

  /**
   * agy accepts a session/prompt while one is running: the running prompt
   * returns end_turn at once and the new one carries the rest of the run. It
   * is read at the next model boundary; a running tool is not interrupted.
   * A prompt sent while an approval is unanswered is refused (-32603), so
   * that case is refused here, never queued as a later turn.
   */
  async steerActiveTurn(sessionId: string, input: { text: string; throwOnError?: boolean }): Promise<boolean> {
    const refuse = (reason: EngineSteeringRejectedError["reason"]) => {
      if (input.throwOnError) throw new EngineSteeringRejectedError(reason);
      return false;
    };
    const worker = this.liveWorker(sessionId);
    const turn = worker?.turn;
    if (!worker || worker.closing || !turn || turn.done || turn.stopRequested) return refuse("stale");
    if (turn.wholeTurnApproval) return refuse("not_ready");
    const text = input.text.trim();
    if (!text || !turn.prompts.some((entry) => !entry.settled)) return refuse("not_ready");
    if (worker.pendingPermissions > 0) return refuse("not_ready");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const admission = await new Promise<Admission | undefined>((resolve) => {
      const entry = this.sendPrompt(turn, [{ type: "text", text }], (result) => { if (timer) clearTimeout(timer); entry.admission = undefined; resolve(result); });
      timer = setTimeout(() => { entry.admission = undefined; resolve(undefined); }, this.steerAdmissionTimeoutMs);
      timer.unref?.();
    });
    if (admission?.admitted) return true;
    if (admission && !admission.admitted && admission.error !== undefined && (admission.error as { code?: unknown }).code === -32603) return refuse("not_ready");
    // No answer, or an unexpected one: whether agy took the input is unknown.
    if (input.throwOnError) throw new Error("Antigravity did not confirm the steering input");
    return false;
  }

  /** Native slash commands and skills agy advertised, for the App command menu. */
  advertisedCommands(): Array<{ name: string; description: string }> {
    return this.commands.map((command) => ({ ...command }));
  }

  hasReceivedAdvertisedCommands(): boolean {
    return this.commandsReceived;
  }

  hasPendingNativeWork(): boolean {
    const now = Date.now();
    for (const worker of new Set(this.workers.values())) {
      if (worker.removed || worker.closing) continue;
      if (worker.turn || worker.reserved || worker.pendingPermissions > 0 || worker.wake) return true;
      const fileSwarm = this.syncSwarmFromFilesSync(worker);
      if (worker.swarm && this.isSwarmWithinHardCap(worker.swarm, now)) {
        const merged = mergeSwarmSnapshots(worker.swarm, fileSwarm, { sessionId: worker.sessionId ?? undefined });
        if (hasActiveSwarmExecution(merged)) return true;
      }
      for (const tool of worker.tools.values()) {
        if (tool.background && (tool.status === "pending" || tool.status === "in_progress")) return true;
      }
    }
    return false;
  }

  private async checkSwarmVersionSupported(): Promise<boolean> {
    if (this.options.supportsSwarmFn) return this.options.supportsSwarmFn();
    if (this.options.spawnFn) return true;
    this.swarmVersionSupported ??= antigravitySupportsSwarm(this.executable, this.childEnv);
    const ok = await this.swarmVersionSupported;
    if (!ok) this.swarmVersionSupported = undefined;
    return ok;
  }

  private async loadSwarmBoard(sessionId: string, worker: Worker | undefined) {
    const effectiveSessionId = worker?.sessionId ?? (!isLogicalSessionId(sessionId) ? sessionId : undefined);
    if (!effectiveSessionId) return { effectiveSessionId, swarm: undefined };

    const rawFileSwarm = await readSwarmBoardFiles(this.brainDir, effectiveSessionId);
    const fileSwarm = worker ? this.syncSwarmFromFileResult(worker, rawFileSwarm) : rawFileSwarm;
    const endedReason = this.endedSwarmSessions.get(effectiveSessionId) ?? this.endedSwarmSessions.get(sessionId);
    const endedFallback: AcpSwarmState | undefined = !worker?.swarm && endedReason
      ? {
          active: false,
          stoppedByUser: endedReason === "stopped",
          ...(endedReason === "timeout" ? { timedOut: true } : {}),
          startedAt: fileSwarm.updatedAt,
          updatedAt: Date.now(),
          members: new Map(),
          posts: [],
        }
      : undefined;
    const swarm = mergeSwarmSnapshots(worker?.swarm ?? endedFallback, fileSwarm, { sessionId: effectiveSessionId });
    if (worker?.swarm && !worker.swarm.stoppedByUser && !worker.swarm.timedOut && swarm) {
      worker.swarm.active = swarm.active;
      this.syncSwarmCeilingTimer(worker);
    }
    return { effectiveSessionId, swarm };
  }

  /**
   * Background commands and swarm workers still running in this session. ACP has
   * no per-task stop (only session/cancel and session/close), so each entry is
   * read-only (`canStop: false`); stopping the conversation or swarm closes the session.
   */
  async listTasks(sessionId: string): Promise<EngineTaskSnapshot> {
    const worker = this.liveWorker(sessionId);
    const { effectiveSessionId, swarm } = await this.loadSwarmBoard(sessionId, worker);
    if (!effectiveSessionId) return { supported: true, tasks: [] };
    const tasks: EngineTask[] = swarmMembersToEngineTasks(effectiveSessionId, swarm, worker?.swarm?.startedAt);

    if (worker) {
      for (const tool of worker.tools.values()) {
        if (!tool.background || (tool.status !== "pending" && tool.status !== "in_progress")) continue;
        if (tool.name === "run_command" || (tool.kind === "execute" && !tool.name)) {
          const commandLine = asRecord(tool.rawInput)?.CommandLine;
          const label = (tool.title || (typeof commandLine === "string" ? commandLine : "") || "run_command").slice(0, 500);
          tasks.push({
            id: tool.token, label, kind: "shell", mode: "background", status: "running", canStop: false,
            startedAt: tool.startedAt, updatedAt: tool.updatedAt, owner: tool.turn ? "bound" : "unattributed",
          });
        } else if (SILENT_LONG_RUNNING_TOOLS.has(tool.name || tool.title || "")) {
          const input = asRecord(tool.rawInput);
          const desc = typeof input?.Description === "string" ? input.Description : typeof input?.Role === "string" ? input.Role : "";
          const label = (tool.title || desc || tool.name || "workflow").slice(0, 500);
          tasks.push({
            id: tool.token, label, kind: "subagent", mode: "background", status: "running", canStop: false,
            startedAt: tool.startedAt, updatedAt: tool.updatedAt, owner: tool.turn ? "bound" : "unattributed",
          });
        }
      }
    }

    return {
      supported: true,
      tasks: tasks.slice(-128),
      ...(swarm?.active ? { foregroundStopScope: "all" as const } : {}),
      ...(swarm ? { swarm: toSwarmV1Snapshot(swarm) } : {}),
    };
  }

  async stopBackgroundWork(sessionId: string, input?: { locale?: "en" | "zh"; scope?: "swarm" | "all" }): Promise<{ stopped: boolean; summary?: string }> {
    const worker = this.liveWorker(sessionId);
    if (!worker || worker.closing) return { stopped: false };
    const swarmOnly = input?.scope !== "all";
    const swarmActive = await this.isSwarmActive(worker);
    if (swarmOnly) {
      if (!swarmActive) return { stopped: false };
    } else {
      // Do not bypass session/cancel grace for an active non-swarm foreground turn.
      if (worker.turn && !worker.turn.done && !swarmActive) return { stopped: false };
      const hasTools = this.hasOpenBackgroundTools(worker);
      if (!swarmActive && !hasTools && worker.pendingPermissions === 0) return { stopped: false };
    }

    if (swarmActive) {
      if (worker.swarm) {
        this.markSwarmEnded(worker.swarm, "stopped", worker.sessionId);
      } else {
        worker.swarm = {
          active: false, stoppedByUser: true, startedAt: Date.now(), updatedAt: Date.now(), members: new Map(), posts: [],
        };
        if (worker.sessionId) this.endedSwarmSessions.set(worker.sessionId, "stopped");
      }
      this.endedSwarmSessions.set(sessionId, "stopped");
      this.clearSwarmCeilingTimer(worker);
    }
    if (worker.wake?.timer) clearTimeout(worker.wake.timer);
    worker.wake = null;
    if (worker.sessionId && !worker.exited) {
      void worker.connection.agent.notify(acpMethods.agent.session.cancel, { sessionId: worker.sessionId }).catch(() => undefined);
    }
    await this.closeWorker(worker, new Error(STOPPED_BY_USER));
    const locale = input?.locale === "en" ? "en" : "zh";
    return {
      stopped: true,
      summary: swarmActive
        ? (locale === "en" ? "Stopped the active swarm and ended all running workers." : "已停止当前 Swarm，并结束所有运行中的 worker。")
        : (locale === "en" ? "Stopped background work in this Antigravity session." : "已停止此 Antigravity 会话中的后台任务。"),
    };
  }

  private liveWorker(sessionId: string): Worker | undefined {
    const worker = this.workers.get(sessionId);
    return worker && !worker.removed ? worker : undefined;
  }

  private async loadRuntimeConfig(): Promise<RuntimeConfig> {
    if (!this.options.configPath) return { approvalMode: "normal" };
    const parsed = await readValidatedConfigFile(this.options.configPath, { forExecution: true });
    const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
    const effort = typeof parsed.effort === "string" && ANTIGRAVITY_EFFORTS.has(parsed.effort) ? parsed.effort as RuntimeConfig["effort"] : undefined;
    return {
      approvalMode: normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE,
      legacyTurnApproval: parsed.antigravityRuntime === "acp" && parsed.antigravityAcpLegacyTurnApproval === true,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    };
  }

  private async buildPrompt(input: CodexUserMessageInput, unwrapWorkerMention = false): Promise<ContentBlock[]> {
    // The Host passes the stable channel contract in input.instructions.
    const instructions = combineInstructions(null, input.instructions ?? null);
    const bounded = instructions && instructions.length > MAX_INSTRUCTIONS_CHARS
      ? `${instructions.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`
      : instructions;
    const blocks: ContentBlock[] = [];
    // agy expands a native command (`/name args`) or `@worker message` only from
    // prompt text that starts with it, so it is sent unwrapped ahead of private context.
    const unwrapped = isSlashCommand(input.text) || unwrapWorkerMention;
    if (unwrapped) blocks.push({ type: "text", text: input.text.trimStart() });
    if (bounded) blocks.push({ type: "text", text: renderPrivateInstructions(bounded) });
    const turnInstructions = renderPrivateTurnInstructions(input.turnInstructions);
    if (turnInstructions) blocks.push({ type: "text", text: turnInstructions });
    if (!unwrapped) blocks.push({ type: "text", text: ["<user_message>", input.text, "</user_message>"].join("\n") });
    if (input.files.length) {
      blocks.push({ type: "text", text: input.files.map((file) => `Attachment: ${file}`).join("\n") });
      blocks.push(...await attachmentBlocks(input.files));
    }
    return blocks;
  }

  /** session/close, then the `agy acp` process tree of this session only; the next turn loads the session again. */
  restartSession(sessionId: string, options?: EngineSessionRestartOptions): Promise<EngineSessionRestartResult> {
    const worker = this.workers.get(sessionId);
    return this.sessionRestarts.close(sessionId, worker && !worker.removed && !this.sessionRestartPending(sessionId) ? {
      exited: worker.exited ? Promise.resolve() : observeEngineProcessExit(worker.child),
      stop: () => worker.exited ? undefined : worker.removed
        ? this.killProcessTreeFn(worker.child.pid, { graceMs: APP_STOP_PROCESS_GRACE_MS })
        : this.closeWorker(worker, new Error(STOPPED_BY_USER), { graceMs: APP_STOP_PROCESS_GRACE_MS }),
    } : undefined, options?.beforeStop);
  }

  sessionRestartPending(sessionId: string): Promise<void> | undefined {
    return this.sessionRestarts.exiting(sessionId);
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    if (this.destroyed) throw new Error("Adapter destroyed");
    const config = resolveEngineOverride("antigravity", await this.loadRuntimeConfig(), input.engineOverride);
    const wholeTurnApproval = config.approvalMode === "normal" && config.legacyTurnApproval;
    const workspace = path.resolve(input.workspaceOverride ?? this.options.workspacePath);
    if (wholeTurnApproval) {
      const requestApproval = input.onApprovalRequest;
      if (!requestApproval) throw new Error("Antigravity normal mode requires a whole-turn approval handler");
      const request = {
        engine: "antigravity" as const,
        toolName: "Antigravity full-auto turn (grants the WHOLE turn, not one command)",
        approvalScopes: { once: "turn" as const },
        toolInput: { prompt: input.text },
        cwd: workspace,
        abortSignal: input.abortSignal,
      };
      const decision = input.abortSignal
        ? await raceAbort(() => requestApproval(request), input.abortSignal, () => ({ behavior: "deny" }))
        : await requestApproval(request);
      if (input.abortSignal?.aborted) throw new Error(STOPPED_BY_USER);
      if (decision.behavior !== "allow") throw new Error("Antigravity turn was denied by the user");
    }
    // The Host's compact command carries no approval handler. A native /compact needs none:
    // a permission request that arrives without a handler is declined.
    if (config.approvalMode === "normal" && this.options.configPath && !input.onApprovalRequest && input.text.trim() !== "/compact") {
      throw new Error("Antigravity normal mode requires an approval handler");
    }
    const swarmCmd = parseSwarmCommand(input.text);
    if (swarmCmd) {
      if (!await this.checkSwarmVersionSupported()) {
        return { text: renderSwarmUnavailableMessage("version", input.locale), sessionId };
      }
      if (swarmCmd.subcommand === "board" && swarmCmd.task.toLowerCase() === "board") {
        const { swarm } = await this.loadSwarmBoard(sessionId, this.liveWorker(sessionId));
        const { renderSwarmBoardSummary } = await import("./antigravity-swarm.js");
        return { text: renderSwarmBoardSummary(swarm, input.locale === "zh" ? "zh" : "en"), sessionId };
      }
      if (!swarmCmd.task) {
        return {
          text: input.locale === "zh"
            ? "用法：`/swarm <任务>`。例如：`/swarm 并行排查并修复登录测试`。"
            : "Usage: `/swarm <task>`. For example: `/swarm investigate and fix the failing auth tests`.",
          sessionId,
        };
      }
    }
    const launchMode = wholeTurnApproval ? "full-auto" : config.approvalMode;
    const launchKey = JSON.stringify({ workspace, flags: permissionFlags(launchMode) });
    const worker = await this.startedWorker(sessionId, workspace, launchKey, launchMode, input.abortSignal);
    if (worker.turn || worker.reserved) throw new Error("Antigravity session already has an in-flight turn");
    worker.reserved = true;
    let prompt: ContentBlock[];
    const entersPlanMode = isPlanSlashCommand(input.text);
    try {
      if (swarmCmd) {
        if (!this.commandsReceived) {
          await this.waitForAdvertisedCommands(worker, input.abortSignal);
        }
        if (worker.removed) throw worker.failure ?? new Error("Antigravity ACP worker is no longer available");
        if (this.commandsReceived && !this.commands.some((command) => command.name.toLowerCase() === "swarm")) {
          return { text: renderSwarmUnavailableMessage("not_advertised", input.locale), sessionId: worker.sessionId! };
        }
      }
      const unwrapMention = await this.shouldUnwrapSwarmMention(worker, input.text);
      prompt = await this.buildPrompt(input, unwrapMention);
      try {
        await this.applySessionConfig(worker, config, entersPlanMode);
      } catch (error) {
        // A new conversation's process is reachable by nobody once this message fails (the Host never
        // learned its session id), and after an unanswered write the session's model or mode is unknown
        // and may still change: either way the process is ended; a later message resumes the session.
        if (worker.announceSession || error instanceof AcpTimeoutError) await this.closeWorker(worker, error instanceof Error ? error : undefined);
        throw error;
      }
    } finally {
      worker.reserved = false;
    }
    if (worker.removed) throw worker.failure ?? new Error("Antigravity ACP worker is no longer available");
    // Legacy Normal has already granted its one approval. Unexpected native
    // permission requests are declined instead of prompting a second time.
    return await this.runTurn(worker, prompt, input, wholeTurnApproval);
  }

  /** The worker for a message. A stop while agy acp is still starting ends that process and the message. */
  private async startedWorker(requestedId: string, workspace: string, launchKey: string, approvalMode: ApprovalMode, signal?: AbortSignal): Promise<Worker> {
    if (signal?.aborted) throw new Error(STOPPED_BY_USER);
    const creation = this.getOrCreateWorker(requestedId, workspace, launchKey, approvalMode);
    if (!signal) return await creation;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const starting = this.workers.get(requestedId);
        if (starting?.rejectStart) void this.closeWorker(starting, new Error(STOPPED_BY_USER), appStopKillOptions(signal));
        reject(new Error(STOPPED_BY_USER));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    creation.catch(() => undefined);
    try {
      return await Promise.race([creation, stopped]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async getOrCreateWorker(requestedId: string, workspace: string, launchKey: string, approvalMode: ApprovalMode): Promise<Worker> {
    if (this.sessionRestartPending(requestedId)) throw new Error("Antigravity's old process is still exiting");
    let sessionId = requestedId;
    const existing = this.liveWorker(sessionId);
    if (existing) {
      if (existing.launchKey === launchKey && !existing.closing) return existing;
      if (existing.turn || existing.reserved) throw new Error("Cannot reconfigure Antigravity session while a turn is in flight");
      sessionId = existing.sessionId ?? sessionId;
      await this.closeWorker(existing);
    }
    const pending = this.pendingWorkers.get(sessionId);
    if (pending) {
      // Another message started this process, maybe with other approval flags or another workspace.
      const started = await pending;
      if (started.launchKey === launchKey) return started;
      throw new Error("Antigravity approval or workspace settings changed while agy acp was starting; send the message again");
    }
    const creation = this.createWorker(sessionId, workspace, launchKey, approvalMode);
    this.pendingWorkers.set(sessionId, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingWorkers.get(sessionId) === creation) this.pendingWorkers.delete(sessionId);
    }
  }

  private async createWorker(requestedId: string, workspace: string, launchKey: string, approvalMode: ApprovalMode): Promise<Worker> {
    if (this.destroyed) throw new Error("Adapter destroyed");
    const args = ["acp", ...permissionFlags(approvalMode), "--add-dir", workspace];
    const invocation = buildCommandInvocation(this.executable, args);
    const quotaCredentialAtSpawn = this.quotaCache.capture("spawn").credentialRevision;
    const child = this.spawnFn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env: this.childEnv, cwd: workspace, windowsHide: true,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      this.killProcessTreeFn(child.pid);
      throw new Error("Antigravity ACP subprocess did not expose stdio pipes");
    }
    let worker!: Worker;
    const stream = createAcpStream(child.stdout, child.stdin, () => { if (worker) this.markActivity(worker); }, (error) => this.failWorker(worker, error));
    const connection = acpClient()
      .onNotification(acpMethods.client.session.update, ({ params }) => { this.handleUpdate(worker, params); })
      .onRequest(acpMethods.client.session.requestPermission, ({ params }) => this.handlePermission(worker, params))
      .onRequest(acpMethods.client.elicitation.create, ({ params }) => this.handleElicitation(worker, params))
      .connect(stream);
    worker = {
      child, connection, sessionId: null, workspacePath: workspace, launchKey, configOptions: [], planModeRequested: false, announceSession: false, turn: null, reserved: false,
      commandCloseWaiters: new Set(), wake: null, promptSeq: 0,
      tools: new Map(), pendingPermissions: 0, stderrTail: "", lastActivityAt: Date.now(), quotaCredentialAtSpawn, removed: false, exited: false,
    };
    this.workers.set(requestedId, worker);
    const decoder = new TextDecoder();
    child.stderr.on("data", (chunk) => {
      worker.stderrTail = `${worker.stderrTail}${typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })}`.slice(-MAX_STDERR_TAIL_CHARS);
    });
    child.stdin.on?.("error", (error) => this.failWorker(worker, error));
    child.once("error", (error) => this.failWorker(worker, error));
    child.once("close", (code, signal) => {
      worker.exited = true;
      this.failWorker(worker, new Error(formatExit(worker.stderrTail, code, signal)));
    });

    // A stop, destroy or a dead process must not wait out the start-up timeouts.
    const removedWhileStarting = new Promise<never>((_resolve, reject) => { worker.rejectStart = reject; });
    removedWhileStarting.catch(() => undefined);
    const starting = <T>(request: Promise<T>): Promise<T> => { request.catch(() => undefined); return Promise.race([request, removedWhileStarting]); };
    try {
      const initialized = await starting(withTimeout(connection.agent.request(acpMethods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "tarobird", version: "1" },
        clientCapabilities: { elicitation: { form: {} } },
      }), this.initializeTimeoutMs, `Antigravity ACP initialize timed out after ${this.initializeTimeoutMs}ms`));
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Antigravity ACP negotiated unsupported protocol version ${String(initialized.protocolVersion)}`);
      worker.initialized = initialized;
      const params = { cwd: workspace, mcpServers: [] };
      let result: Record<string, unknown>;
      if (isLogicalSessionId(requestedId)) {
        result = await starting(withTimeout(connection.agent.request(acpMethods.agent.session.new, params), this.initializeTimeoutMs,
          `Antigravity ACP session/new timed out after ${this.initializeTimeoutMs}ms`)) as unknown as Record<string, unknown>;
        const created = typeof result.sessionId === "string" ? result.sessionId : "";
        if (!created) throw new Error("Antigravity ACP session/new returned no session id");
        worker.sessionId = created;
        worker.announceSession = true;
      } else {
        // session/load would replay the whole history as fresh updates.
        if (!initialized.agentCapabilities?.sessionCapabilities?.resume) throw new Error("This Antigravity CLI does not support ACP session/resume");
        worker.sessionId = requestedId;
        result = await starting(withTimeout(connection.agent.request(acpMethods.agent.session.resume, { sessionId: requestedId, ...params }), this.initializeTimeoutMs,
          `Antigravity ACP session/resume timed out after ${this.initializeTimeoutMs}ms`)) as unknown as Record<string, unknown>;
      }
      worker.configOptions = readSelectOptions(result.configOptions);
      const modes = asRecord(result.modes);
      if (typeof modes?.currentModeId === "string") worker.currentModeId = modes.currentModeId;
      if (worker.removed) throw worker.failure ?? new Error("Antigravity ACP worker is no longer available");
      worker.rejectStart = undefined;
      this.rekey(worker, worker.sessionId);
      if (!worker.announceSession) this.syncSwarmFromFilesSync(worker);
      return worker;
    } catch (error) {
      worker.rejectStart = undefined;
      const failure = error instanceof Error ? error : new Error(rpcErrorMessage(error));
      await this.closeWorker(worker, failure);
      throw failure.message.includes(worker.stderrTail.trim()) || !worker.stderrTail.trim()
        ? failure : new Error(`${failure.message}\n\nAntigravity stderr:\n${worker.stderrTail.trim()}`);
    }
  }

  private rekey(worker: Worker, sessionId: string): void {
    for (const [key, candidate] of this.workers) if (candidate === worker && key !== sessionId) this.workers.delete(key);
    const owner = this.workers.get(sessionId);
    if (owner && owner !== worker && !owner.removed) throw new Error(`Antigravity conversation ${sessionId} is already owned by another live worker`);
    this.workers.set(sessionId, worker);
  }

  /** Bot model/effort/mode for this session through ACP session config. */
  private async applySessionConfig(worker: Worker, config: RuntimeConfig, entersPlanMode = false): Promise<void> {
    const key = JSON.stringify([config.model ?? null, config.effort ?? null]);
    const sessionId = worker.sessionId!;
    if (worker.configKey !== key) {
      const modelOption = findOption(worker.configOptions, "model");
      let model: string | undefined;
      let level: string | undefined = config.effort;
      if (config.model) {
        const values = modelOption?.options.map((option) => option.value) ?? [];
        if (values.includes(config.model)) model = config.model;
        else {
          const preset = config.model.match(PRESET_SUFFIX)?.[1];
          const base = preset ? config.model.slice(0, -preset.length - 1) : undefined;
          if (!base || !values.includes(base)) throw new Error(`Antigravity model ${config.model} is not available in this CLI`);
          if (level && level !== preset) throw new Error(`Invalid model selection: --model ${config.model} conflicts with --effort=${level}`);
          model = base;
          level = preset;
        }
        if (modelOption?.currentValue !== model) await this.setConfigOption(worker, "model", model);
      }
      if (level) {
        // Changing the model returns that model's own thinking levels.
        const levels = findOption(worker.configOptions, "thought_level");
        // A model without thinking levels (agy drops the option, e.g. for
        // gpt-oss-120b-medium) runs with the model alone; the effort is skipped.
        const allowed = levels?.options.map((option) => option.value) ?? [];
        if (levels && !allowed.includes(level)) {
          throw new Error(`Invalid model selection: ${model ?? modelOption?.currentValue ?? "the current model"} has no "${level}" effort (available: ${allowed.join(", ")})`);
        }
        if (levels && levels.currentValue !== level) await this.setConfigOption(worker, levels.id, level);
      }
      worker.configKey = key;
    }
    // TaroBird approval settings define permissions; a stale/auto mode left on
    // the native conversation must not silently change them. Preserve "plan"
    // only while the user is actively inside a `/plan` flow started in this worker.
    const keepPlanMode = worker.currentModeId === "plan" && (worker.planModeRequested || entersPlanMode);
    if (worker.currentModeId && worker.currentModeId !== "default" && !keepPlanMode) {
      await withTimeout(worker.connection.agent.request(acpMethods.agent.session.setMode, { sessionId, modeId: "default" }), this.initializeTimeoutMs, "Antigravity ACP session/set_mode timed out");
      worker.currentModeId = "default";
      worker.planModeRequested = false;
    }
    if (entersPlanMode) worker.planModeRequested = true;
  }

  private async setConfigOption(worker: Worker, configId: string, value: string): Promise<void> {
    const response = await withTimeout(worker.connection.agent.request(acpMethods.agent.session.setConfigOption, {
      sessionId: worker.sessionId!, configId, value,
    } as never), this.initializeTimeoutMs, "Antigravity ACP session/set_config_option timed out") as unknown as Record<string, unknown>;
    const next = readSelectOptions(response?.configOptions);
    if (next.length) worker.configOptions = next;
    else worker.configOptions = worker.configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
  }

  private runTurn(worker: Worker, prompt: ContentBlock[], input: CodexUserMessageInput, wholeTurnApproval = false): Promise<CodexAdapterResponse> {
    return new Promise<CodexAdapterResponse>((resolve, reject) => {
      const turn: Turn = {
        worker, wholeTurnApproval, prompts: [], text: "", usage: undefined, toolSeen: false, permissionTools: new Map(), compact: input.text.trim() === "/compact",
        hasAsyncSubagent: false, awaitingReactiveWake: false, locale: input.locale,
        onProgress: input.onProgress, onEngineEvent: input.onEngineEvent, onApprovalRequest: wholeTurnApproval ? undefined : input.onApprovalRequest,
        approvals: new AbortController(), eventChain: Promise.resolve(), stopRequested: false,
        timeoutsDisabled: input.disableRuntimeTimeout === true, done: false, resolve, reject,
      };
      // Whatever an idle wake-up already pushed is delivered before this
      // message takes the session over; agy streams the rest under it.
      this.flushWake(worker);
      worker.turn = turn;
      worker.lastTurnHandler = input.onEngineEvent;
      const swarmCmd = parseSwarmCommand(input.text);
      if (swarmCmd?.task) {
        if (worker.sessionId) this.endedSwarmSessions.delete(worker.sessionId);
        worker.swarmFileCache = undefined;
        const baselineMembersSig = worker.sessionId ? snapshotSwarmMembersFileSync(this.brainDir, worker.sessionId) : undefined;
        const now = Date.now();
        worker.swarm = {
          active: true,
          stoppedByUser: false,
          title: swarmCmd.task.slice(0, 300),
          startedAt: now,
          updatedAt: now,
          ...(baselineMembersSig ? { baselineMembersSig } : {}),
          ownerTurn: turn,
          members: new Map(),
          posts: [],
        };
        this.syncSwarmCeilingTimer(worker);
      } else if (worker.swarm?.active && !worker.swarm.stoppedByUser && !worker.swarm.timedOut && input.onEngineEvent) {
        worker.swarm.ownerTurn = turn;
        this.syncSwarmCeilingTimer(worker);
      }
      if (worker.announceSession) {
        worker.announceSession = false;
        this.emit(turn, { type: "session", sessionId: worker.sessionId! });
      }
      this.armTimers(turn);
      if (input.abortSignal) {
        const signal = input.abortSignal;
        const onAbort = () => this.requestStop(turn, appStopKillOptions(signal));
        turn.abortCleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
      }
      this.sendPrompt(turn, prompt);
    });
  }

  /** One session/prompt of a turn. The newest outstanding prompt owns the turn's result. */
  protected sendPrompt(turn: Turn, prompt: ContentBlock[], admission?: PromptEntry["admission"]): PromptEntry {
    const worker = turn.worker;
    const entry: PromptEntry = { seq: ++worker.promptSeq, settled: false, ...(admission ? { admission, steer: true } : {}) };
    turn.prompts.push(entry);
    turn.awaitingReactiveWake = false;
    this.markActivity(worker);
    worker.connection.agent.request(acpMethods.agent.session.prompt, { sessionId: worker.sessionId!, prompt }).then(
      (result) => this.promptSettled(turn, entry, { result }),
      (error: unknown) => this.promptSettled(turn, entry, { error }),
    );
    return entry;
  }

  protected promptSettled(turn: Turn, entry: PromptEntry, outcome: PromptOutcome): void {
    entry.settled = true;
    entry.outcome = outcome;
    if (outcome.result) turn.usage = addUsage(turn.usage, usageFromPrompt(outcome.result));
    // A refused steer never joined the run, even when its admission wait has
    // already ended; the prompt before it still owns the turn. A steer agy took
    // over owns the run: when it fails, that failure is the turn's outcome.
    if (entry.steer && outcome.error !== undefined && !entry.admitted) turn.prompts = turn.prompts.filter((candidate) => candidate !== entry);
    if (entry.admission) entry.admission(outcome.error !== undefined ? { admitted: false, error: outcome.error } : { admitted: true });
    if (outcome.result) {
      // agy returned this prompt because the next one took over the run.
      const next = turn.prompts.find((candidate) => candidate.seq > entry.seq && !candidate.settled);
      if (next) { next.admitted = true; next.admission?.({ admitted: true }); }
    }
    this.finishIfSettled(turn);
  }

  /** A prompt that returns while a later one is outstanding was handed over
   * (agy returns it at once with end_turn); the newest prompt decides the turn. */
  protected finishIfSettled(turn: Turn): void {
    if (turn.done || turn.prompts.some((candidate) => !candidate.settled)) return;
    const newest = turn.prompts.at(-1);
    if (newest?.outcome) this.finishTurn(turn, newest.outcome);
  }

  private finishTurn(turn: Turn, outcome: PromptOutcome): void {
    if (turn.done) return;
    const worker = turn.worker;
    const stopReason = outcome.result?.stopReason;
    let error: Error | undefined;
    if (outcome.error !== undefined) {
      error = turn.stopRequested ? new Error(STOPPED_BY_USER) : this.withStderr(worker, new Error(rpcErrorMessage(outcome.error)));
      if (!turn.stopRequested && (turn.toolSeen || turn.text.trim())) error = new EngineIncompleteResponseError(error.message, "interrupted");
    } else if (stopReason === "cancelled") {
      error = turn.stopRequested ? new Error(STOPPED_BY_USER) : new EngineIncompleteResponseError("Antigravity turn was cancelled: the answer is incomplete", "interrupted");
    } else if (stopReason === "refusal") {
      error = new Error("Antigravity refused to continue this request");
    } else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      error = new EngineIncompleteResponseError(`Antigravity stopped (${stopReason}): the answer is incomplete`, "interrupted");
    } else if (turn.declinedAt !== undefined && !turn.text.slice(turn.declinedAt).trim()) {
      // agy often ends the turn without more text once an action is declined.
      // That is the owner's choice, not a failure: say so plainly, after any
      // text the model wrote before the declined action.
      const note = hostT(turn.locale ?? "en", "已拒绝执行该操作，Antigravity 已停止本轮。");
      const before = turn.text.trim();
      this.settleTurn(turn, undefined, before ? `${before}\n\n${note}` : note);
      return;
    } else if (!turn.text.trim() && turn.compact) {
      // agy 1.5.14 compacts and ends with end_turn and no text; the Host reports the compaction itself.
      this.settleTurn(turn, undefined, "");
      return;
    } else if (!turn.text.trim()) {
      error = turn.toolSeen
        ? new EngineIncompleteResponseError("Antigravity completed without returning a response", "interrupted")
        : new Error("Antigravity completed without returning a response");
    }
    this.settleTurn(turn, error);
  }

  private settleTurn(turn: Turn, error?: Error, reply?: string): void {
    if (turn.done) return;
    turn.done = true;
    const worker = turn.worker;
    if (worker.turn === turn) worker.turn = null;
    for (const tool of worker.tools.values()) if (tool.turn === turn && (tool.status === "pending" || tool.status === "in_progress")) tool.background = true;
    this.clearTimers(turn);
    turn.abortCleanup?.();
    turn.approvals.abort();
    for (const entry of turn.prompts) entry.admission?.(undefined);
    worker.lastActivityAt = Date.now();
    this.syncSwarmCeilingTimer(worker);
    const text = reply ?? turn.text.trim();
    if (!error) this.emit(turn, { type: "result", text, sessionId: worker.sessionId! });
    void turn.eventChain.then(() => {
      if (error) turn.reject(error);
      else turn.resolve({ text, sessionId: worker.sessionId!, ...(turn.usage ? { usage: turn.usage } : {}) });
    });
  }

  private markSwarmEnded(swarm: AcpSwarmState, reason: "stopped" | "timeout", sessionId?: string | null): void {
    const now = Date.now();
    swarm.active = false;
    if (reason === "stopped") swarm.stoppedByUser = true;
    else swarm.timedOut = true;
    swarm.updatedAt = now;
    if (sessionId) this.endedSwarmSessions.set(sessionId, reason);
    for (const member of swarm.members.values()) {
      if (member.state === "working" || member.state === "waiting" || member.state === "paused") {
        member.state = "killed";
        member.updatedAt = now;
      }
    }
  }

  private isSwarmWithinHardCap(swarm: AcpSwarmState | undefined, now = Date.now()): boolean {
    if (!swarm || !swarm.active || swarm.stoppedByUser || swarm.timedOut) return false;
    return now - swarm.startedAt < this.swarmMaxDurationMs;
  }

  private clearSwarmCeilingTimer(worker: Worker): void {
    if (worker.swarmTimer) clearTimeout(worker.swarmTimer);
    worker.swarmTimer = undefined;
    worker.swarmTimerDeadline = undefined;
  }

  private syncSwarmCeilingTimer(worker: Worker): void {
    const swarm = worker.swarm;
    if (!swarm || !swarm.active || swarm.stoppedByUser || swarm.timedOut || worker.removed || worker.closing) {
      this.clearSwarmCeilingTimer(worker);
      return;
    }
    const deadline = swarm.startedAt + this.swarmMaxDurationMs;
    if (worker.swarmTimer && worker.swarmTimerDeadline === deadline) return;
    this.clearSwarmCeilingTimer(worker);
    const startedAt = swarm.startedAt;
    const remaining = Math.max(0, deadline - Date.now());
    worker.swarmTimerDeadline = deadline;
    worker.swarmTimer = setTimeout(() => {
      void this.onSwarmHardTimeout(worker, startedAt);
    }, remaining);
    worker.swarmTimer.unref?.();
  }

  private async onSwarmHardTimeout(worker: Worker, expectedStartedAt: number): Promise<void> {
    this.clearSwarmCeilingTimer(worker);
    if (worker.removed || worker.closing || !worker.swarm) return;
    if (worker.swarm.startedAt !== expectedStartedAt || worker.swarm.stoppedByUser || worker.swarm.timedOut) return;
    const stillActive = await this.isSwarmActive(worker);
    if (!stillActive || worker.removed || worker.closing || !worker.swarm || worker.swarm.startedAt !== expectedStartedAt) return;
    // Respect explicit /timeout off only while that turn is in flight; once it settles, syncSwarmCeilingTimer re-evaluates.
    if (worker.turn && !worker.turn.done && worker.turn.timeoutsDisabled) return;
    this.markSwarmEnded(worker.swarm, "timeout", worker.sessionId);
    if (worker.wake?.timer) clearTimeout(worker.wake.timer);
    worker.wake = null;
    if (worker.sessionId && !worker.exited) {
      void worker.connection.agent.notify(acpMethods.agent.session.cancel, { sessionId: worker.sessionId }).catch(() => undefined);
    }
    await this.closeWorker(worker, new Error(`Antigravity ACP swarm timed out after ${Math.max(1, Math.round(this.swarmMaxDurationMs / 60_000))} minutes`));
  }

  private hasOpenBackgroundTools(worker: Worker): boolean {
    for (const tool of worker.tools.values()) {
      if (tool.background && (tool.status === "pending" || tool.status === "in_progress")) return true;
    }
    return false;
  }

  private isStaleInactiveFileSwarm(swarm: AcpSwarmState, fileSwarm: ParsedSwarmFiles): boolean {
    if (!swarm.active || swarm.stoppedByUser || swarm.timedOut || !fileSwarm.found || fileSwarm.active) return false;
    if (fileSwarm.membersMtimeMs !== undefined && fileSwarm.membersMtimeMs < swarm.startedAt) return true;
    if (fileSwarm.updatedAt > 0 && fileSwarm.updatedAt < swarm.startedAt) return true;
    if (
      swarm.baselineMembersSig
      && fileSwarm.membersMtimeMs === swarm.baselineMembersSig.mtimeMs
      && fileSwarm.membersSize === swarm.baselineMembersSig.size
      && fileSwarm.membersHash === swarm.baselineMembersSig.hash
    ) {
      return true;
    }
    return false;
  }

  private syncSwarmFromFileResult(worker: Worker, fileSwarm: ParsedSwarmFiles): ParsedSwarmFiles {
    if (worker.swarm && this.isStaleInactiveFileSwarm(worker.swarm, fileSwarm)) {
      return emptyParsedSwarmFiles();
    }
    if (!fileSwarm.found) return fileSwarm;
    if (worker.swarm) {
      if (!worker.swarm.stoppedByUser && !worker.swarm.timedOut) {
        if (fileSwarm.active) {
          worker.swarm.active = true;
          if (fileSwarm.title && !worker.swarm.title) worker.swarm.title = fileSwarm.title;
          this.syncSwarmCeilingTimer(worker);
        } else if (fileSwarm.members.length > 0 || fileSwarm.explicitlyStopped) {
          const merged = mergeSwarmSnapshots(worker.swarm, fileSwarm, { sessionId: worker.sessionId ?? undefined });
          if (merged && !merged.active) {
            worker.swarm.active = false;
            this.clearSwarmCeilingTimer(worker);
            for (const member of merged.members) {
              const key = member.name.toLowerCase();
              const existing = worker.swarm.members.get(key);
              if (existing && member.state !== "unknown") {
                worker.swarm.members.set(key, { ...existing, state: member.state, inferredState: false, updatedAt: member.updatedAt });
              }
            }
          }
        }
      }
    } else if (fileSwarm.active && worker.sessionId && !this.endedSwarmSessions.has(worker.sessionId)) {
      const now = Date.now();
      const ts = fileSwarm.updatedAt || now;
      // Ignore already-expired on-disk swarm files from earlier processes instead of killing a freshly resumed session.
      if (now - ts < this.swarmMaxDurationMs) {
        worker.swarm = {
          active: true,
          stoppedByUser: false,
          ...(fileSwarm.title ? { title: fileSwarm.title } : {}),
          startedAt: ts,
          updatedAt: ts,
          members: new Map(fileSwarm.members.map((m) => [m.name.toLowerCase(), { ...m }])),
          posts: [...fileSwarm.posts],
        };
        this.syncSwarmCeilingTimer(worker);
      }
    }
    return fileSwarm;
  }

  private syncSwarmFromFilesSync(worker: Worker): ParsedSwarmFiles {
    if (!worker.sessionId) return emptyParsedSwarmFiles();
    const { cache, parsed } = readSwarmBoardFilesSync(this.brainDir, worker.sessionId, worker.swarmFileCache);
    worker.swarmFileCache = cache;
    return this.syncSwarmFromFileResult(worker, parsed);
  }

  private async waitForAdvertisedCommands(worker: Worker, signal?: AbortSignal): Promise<void> {
    if (this.commandsReceived || worker.removed || worker.closing || worker.exited || this.commandsAdvertiseTimeoutMs <= 0) return;
    if (signal?.aborted) throw new Error(STOPPED_BY_USER);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.commandWaiters.delete(onCommands);
        worker.commandCloseWaiters.delete(onWorkerClose);
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const onCommands = () => finish();
      const onWorkerClose = () => finish();
      const onAbort = signal ? () => finish(new Error(STOPPED_BY_USER)) : undefined;
      const timer = setTimeout(() => finish(), this.commandsAdvertiseTimeoutMs);
      timer.unref?.();
      this.commandWaiters.add(onCommands);
      worker.commandCloseWaiters.add(onWorkerClose);
      if (onAbort && signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async readMergedSwarm(worker: Worker) {
    if (worker.swarm?.stoppedByUser || worker.swarm?.timedOut) return undefined;
    const rawFileSwarm = worker.sessionId ? await readSwarmBoardFiles(this.brainDir, worker.sessionId) : emptyParsedSwarmFiles();
    const fileSwarm = this.syncSwarmFromFileResult(worker, rawFileSwarm);
    const merged = mergeSwarmSnapshots(worker.swarm, fileSwarm, { sessionId: worker.sessionId ?? undefined });
    if (worker.swarm && !worker.swarm.stoppedByUser && !worker.swarm.timedOut && merged) {
      worker.swarm.active = merged.active;
      this.syncSwarmCeilingTimer(worker);
    }
    return merged;
  }

  private async shouldUnwrapSwarmMention(worker: Worker, text: string): Promise<boolean> {
    const target = extractLeadingMention(text);
    if (!target) return false;
    const merged = await this.readMergedSwarm(worker);
    if (!merged?.active) return false;
    if (merged.members.length === 0) return true;
    return merged.members.some((m) => m.name.toLowerCase() === target && (isSwarmMemberActive(m.state) || m.state === "unknown"));
  }

  private async isSwarmActive(worker: Worker): Promise<boolean> {
    return Boolean((await this.readMergedSwarm(worker))?.active);
  }

  private async hasGenuinelyActiveSwarmWithinCap(worker: Worker): Promise<boolean> {
    const merged = await this.readMergedSwarm(worker);
    if (!merged || !hasActiveSwarmExecution(merged)) return false;
    return this.isSwarmWithinHardCap(worker.swarm);
  }

  private requestStop(turn: Turn, killOptions?: { graceMs: number }): void {
    if (turn.done || turn.stopRequested) return;
    turn.stopRequested = true;
    turn.stopKillOptions = killOptions;
    turn.approvals.abort();
    const worker = turn.worker;
    this.syncSwarmFromFilesSync(worker);
    const swarmKnownActive = Boolean(worker.swarm?.active && !worker.swarm.stoppedByUser && !worker.swarm.timedOut);
    if (swarmKnownActive && worker.swarm) {
      this.markSwarmEnded(worker.swarm, "stopped", worker.sessionId);
      this.clearSwarmCeilingTimer(worker);
      if (worker.wake?.timer) clearTimeout(worker.wake.timer);
      worker.wake = null;
    }
    if (!turn.prompts.length) {
      this.settleTurn(turn, new Error(STOPPED_BY_USER));
      if (swarmKnownActive) void this.closeWorker(worker, new Error(STOPPED_BY_USER), killOptions);
      return;
    }
    void worker.connection.agent.notify(acpMethods.agent.session.cancel, { sessionId: worker.sessionId! }).catch(() => undefined);
    if (swarmKnownActive) {
      // Closing the ACP session guarantees every background swarm worker ends instead of continuing to burn quota.
      void this.closeWorker(worker, new Error(STOPPED_BY_USER), killOptions);
      return;
    }
    void this.checkAndCloseSwarmOnStop(worker, turn, killOptions);
    turn.stopTimer = setTimeout(() => {
      if (turn.done) return;
      // agy did not confirm the stop: closing the session ends its work.
      void this.closeWorker(worker, new Error(STOPPED_BY_USER), killOptions);
    }, this.cancelGraceMs);
    turn.stopTimer.unref?.();
  }

  private async checkAndCloseSwarmOnStop(worker: Worker, turn: Turn, killOptions?: { graceMs: number }): Promise<void> {
    if (worker.removed || worker.closing || !worker.sessionId || worker.swarm?.stoppedByUser || worker.swarm?.timedOut) return;
    const rawFileSwarm = await readSwarmBoardFiles(this.brainDir, worker.sessionId);
    const fileSwarm = this.syncSwarmFromFileResult(worker, rawFileSwarm);
    if (!fileSwarm.active || worker.removed || worker.closing || !turn.stopRequested) return;
    if (worker.sessionId) this.endedSwarmSessions.set(worker.sessionId, "stopped");
    worker.swarm = {
      active: false,
      stoppedByUser: true,
      ...(fileSwarm.title ? { title: fileSwarm.title } : {}),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      members: new Map(),
      posts: [],
    };
    this.clearSwarmCeilingTimer(worker);
    if (worker.wake?.timer) clearTimeout(worker.wake.timer);
    worker.wake = null;
    await this.closeWorker(worker, new Error(STOPPED_BY_USER), killOptions);
  }

  private armTimers(turn: Turn): void {
    if (turn.timeoutsDisabled) return;
    this.armTotalTimeout(turn);
    this.armInactivity(turn);
  }

  private armTotalTimeout(turn: Turn): void {
    if (turn.totalTimer) clearTimeout(turn.totalTimer);
    turn.totalTimer = undefined;
    if (turn.timeoutsDisabled || !this.turnTimeoutMs || this.turnTimeoutMs <= 0) return;
    turn.totalTimer = setTimeout(() => {
      void this.onTotalTimeout(turn);
    }, this.turnTimeoutMs);
    turn.totalTimer.unref?.();
  }

  /** Hard total turn ceiling: never re-armed indefinitely, even while a swarm is active. */
  private async onTotalTimeout(turn: Turn): Promise<void> {
    if (turn.done || turn.stopRequested || turn.worker.removed) return;
    if (turn.worker.swarm?.active && !turn.worker.swarm.stoppedByUser && !turn.worker.swarm.timedOut) {
      this.markSwarmEnded(turn.worker.swarm, "timeout", turn.worker.sessionId);
      this.clearSwarmCeilingTimer(turn.worker);
    }
    await this.closeWorker(turn.worker, new Error(`Antigravity ACP turn timed out after ${Math.max(1, Math.round(this.turnTimeoutMs! / 60_000))} minutes`));
  }

  /**
   * True when this turn is legitimately waiting without parent ACP stream updates:
   * awaiting a user permission decision, waiting on its own background tools /
   * multi-agent orchestration tools (`run_workflow`, `invoke_subagent`, `schedule`),
   * or sitting in `agy`'s reactive wakeup wait after spawning an async subagent.
   * Unrelated background tools from earlier turns do not suppress this turn's watchdog.
   */
  private hasSilentLongRunningWait(turn: Turn): boolean {
    const worker = turn.worker;
    if (worker.pendingPermissions > 0) return true;
    let hasForegroundTool = false;
    for (const tool of worker.tools.values()) {
      if (tool.status !== "pending" && tool.status !== "in_progress") continue;
      if (tool.turn !== turn) continue;
      if (tool.background || SILENT_LONG_RUNNING_TOOLS.has(tool.name || tool.title || "")) return true;
      hasForegroundTool = true;
    }
    return !hasForegroundTool && turn.hasAsyncSubagent && turn.awaitingReactiveWake;
  }
  private armInactivity(turn: Turn): void {
    if (turn.inactivityTimer) clearTimeout(turn.inactivityTimer);
    turn.inactivityTimer = undefined;
    if (turn.done || turn.timeoutsDisabled || !this.inactivityTimeoutMs || this.inactivityTimeoutMs <= 0) return;
    if (this.hasSilentLongRunningWait(turn)) return;
    turn.inactivityTimer = setTimeout(() => {
      void this.onInactivityTimeout(turn);
    }, this.inactivityTimeoutMs);
    turn.inactivityTimer.unref?.();
  }

  /** Pause inactivity only while swarm work is genuinely executing and within the hard total ceiling.
   * Permanently `paused` (quota-exhausted) or all-`waiting` idle swarms do not bypass inactivity timeout. */
  private async onInactivityTimeout(turn: Turn): Promise<void> {
    if (turn.done || turn.stopRequested || turn.worker.removed) return;
    if (await this.hasGenuinelyActiveSwarmWithinCap(turn.worker)) {
      this.armInactivity(turn);
      return;
    }
    if (turn.worker.swarm?.active && !turn.worker.swarm.stoppedByUser && !turn.worker.swarm.timedOut) {
      this.markSwarmEnded(turn.worker.swarm, "timeout", turn.worker.sessionId);
      this.clearSwarmCeilingTimer(turn.worker);
    }
    await this.closeWorker(turn.worker, new Error(`Antigravity ACP turn became inactive after ${Math.max(1, Math.round(this.inactivityTimeoutMs! / 60_000))} minutes`));
  }

  private clearTimers(turn: Turn): void {
    for (const timer of [turn.totalTimer, turn.inactivityTimer, turn.stopTimer]) if (timer) clearTimeout(timer);
    turn.totalTimer = turn.inactivityTimer = turn.stopTimer = undefined;
  }

  private markActivity(worker: Worker): void {
    worker.lastActivityAt = Date.now();
    if (worker.turn) this.armInactivity(worker.turn);
  }

  protected emit(turn: Turn, event: EngineStreamEvent): void {
    const handler = turn.onEngineEvent;
    if (!handler) return;
    turn.eventChain = turn.eventChain.then(() => handler(event)).then(() => undefined, () => undefined);
  }

  private handleUpdate(worker: Worker, notification: SessionNotification): void {
    if (!worker || worker.removed || notification.sessionId !== worker.sessionId) return;
    this.markActivity(worker);
    const update = notification.update as unknown as Record<string, unknown>;
    const kind = update.sessionUpdate;
    if (kind === "usage_update") {
      if (typeof update.used === "number" && typeof update.size === "number") worker.contextUsage = { used: update.used, size: update.size };
    } else if (kind === "current_mode_update" && typeof update.currentModeId === "string") {
      worker.currentModeId = update.currentModeId;
      if (update.currentModeId === "default") worker.planModeRequested = false;
    } else if (kind === "config_option_update") {
      const next = readSelectOptions(update.configOptions);
      if (next.length) worker.configOptions = next;
    } else if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
      this.commandsReceived = true;
      this.commands = update.availableCommands.flatMap((item) => {
        const command = asRecord(item);
        if (!command || typeof command.name !== "string" || !NATIVE_COMMAND_NAME.test(command.name)) return [];
        return [{ name: command.name, description: typeof command.description === "string" ? command.description.slice(0, 300) : "" }];
      }).slice(0, MAX_NATIVE_COMMANDS);
      for (const notify of this.commandWaiters) notify();
      this.commandWaiters.clear();
    }
    const turn = worker.turn;
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (turn) turn.awaitingReactiveWake = false;
      this.trackTool(worker, update, turn);
    }
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      if (turn) turn.awaitingReactiveWake = false;
    }
    const swarmToolAction = isSwarmToolName(update.name)
      ? (typeof asRecord(update.rawInput)?.action === "string" ? String(asRecord(update.rawInput)!.action).trim().toLowerCase() : undefined)
      : undefined;
    const isReadOnlySwarmQuery = swarmToolAction === "status" || swarmToolAction === "models";
    const isExplicitSwarmUpdate = (typeof kind === "string" && kind.startsWith("swarm"))
      || (isSwarmToolName(update.name) && !isReadOnlySwarmQuery);
    if (isExplicitSwarmUpdate && !worker.swarm?.stoppedByUser && !worker.swarm?.timedOut) {
      const now = Date.now();
      const rawStatus = typeof update.status === "string" ? update.status.trim().toLowerCase() : "";
      const initialActive = !(typeof kind === "string" && kind.startsWith("swarm") && ["done", "completed", "stopped", "killed", "finished"].includes(rawStatus));
      worker.swarm ??= {
        active: initialActive,
        stoppedByUser: false,
        startedAt: now,
        updatedAt: now,
        ...(turn ? { ownerTurn: turn } : {}),
        members: new Map(),
        posts: [],
      };
      applySwarmAcpUpdate(worker.swarm, update, now);
      this.syncSwarmCeilingTimer(worker);
    } else if (worker.swarm?.active && !worker.swarm.stoppedByUser && !worker.swarm.timedOut) {
      const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const trackedWorker = toolCallId ? worker.tools.get(toolCallId)?.workerName : undefined;
      const attributed = extractWorkerAttribution({ _meta: update._meta, toolCall: update }, trackedWorker);
      if (attributed) {
        const key = attributed.toLowerCase();
        const hasOtherOpenWorkerTools = [...worker.tools.values()].some((tool) =>
          tool.id !== toolCallId
          && tool.workerName?.toLowerCase() === key
          && (tool.status === "pending" || tool.status === "in_progress"),
        );
        const updateWithWorker = trackedWorker && !extractWorkerAttribution({ _meta: update._meta, toolCall: update })
          ? { ...update, _meta: { ...asRecord(update._meta), workerName: trackedWorker } }
          : update;
        applySwarmAcpUpdate(worker.swarm, updateWithWorker, Date.now(), { hasOtherOpenWorkerTools });
      }
    }
    if (kind === "usage_update") {
      // A model call after a still-running tool means the model left it running in the background.
      for (const tool of worker.tools.values()) if (tool.status === "pending" || tool.status === "in_progress") tool.background = true;
      if (turn && turn.hasAsyncSubagent) turn.awaitingReactiveWake = true;
    }
    if (!turn) this.trackWake(worker, kind, update);
    // A finished call is no longer needed: its result and any wake-up owner were taken above.
    if ((kind === "tool_call" || kind === "tool_call_update") && (update.status === "completed" || update.status === "failed") && typeof update.toolCallId === "string") {
      worker.tools.delete(update.toolCallId);
    }
    // Re-sync the inactivity timer after worker.tools reflects newly started, backgrounded, or finished tools.
    if (turn) this.armInactivity(turn);
    if (!turn) return;
    const sessionId = worker.sessionId!;
    if (kind === "agent_message_chunk") {
      const content = asRecord(update.content);
      if (content?.type !== "text" || typeof content.text !== "string" || !content.text) return;
      turn.text += content.text;
      try { turn.onProgress?.(turn.text); } catch { /* Progress rendering cannot fail the turn. */ }
      this.emit(turn, { type: "assistant_text", text: content.text, delta: true, sessionId });
    } else if (kind === "agent_thought_chunk") {
      const content = asRecord(update.content);
      if (content?.type === "text" && typeof content.text === "string" && content.text) this.emit(turn, { type: "thinking", text: content.text, sessionId });
    } else if (kind === "plan") {
      const plan = parseAcpPlanSummary(update.entries);
      if (plan.todos.length) this.emitPlan(turn, sessionId, plan);
    }
  }

  private emitPlan(
    turn: Turn,
    sessionId: string,
    plan: { todos: AntigravityTodoItem[]; total?: number; completed?: number; truncated?: boolean },
  ): void {
    const toolInput = plan.truncated
      ? {
        todos: plan.todos,
        total: plan.total ?? plan.todos.length,
        completed: plan.completed ?? plan.todos.filter((item) => item.status === "completed").length,
        truncated: true,
      }
      : { todos: plan.todos };
    const serialized = JSON.stringify(toolInput);
    if (turn.lastPlanJson === serialized) return;
    turn.lastPlanJson = serialized;
    this.emit(turn, { type: "tool_use", toolName: "TodoWrite", toolInput, toolUseId: `agy-task-plan:${sessionId}`, sessionId });
  }

  private trackWake(worker: Worker, kind: unknown, update: Record<string, unknown>): void {
    if (worker.swarm?.stoppedByUser || worker.swarm?.timedOut) return;
    if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "tool_call" && kind !== "tool_call_update" && kind !== "usage_update") return;
    if (kind === "usage_update" && !worker.wake) return;
    const wake = worker.wake ??= { text: "", openTools: new Set() };
    if (worker.swarm?.ownerTurn?.onEngineEvent) wake.owner ??= worker.swarm.ownerTurn.onEngineEvent;
    if (wake.timer) clearTimeout(wake.timer);
    wake.timer = undefined;
    const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    const finished = update.status === "completed" || update.status === "failed";
    if (kind === "agent_message_chunk") {
      const content = asRecord(update.content);
      if (content?.type === "text" && typeof content.text === "string") wake.text += content.text;
      if (!wake.openTools.size && wake.text.trim()) {
        wake.timer = setTimeout(() => this.flushWake(worker), Math.max(this.wakeQuietMs * 2, 200));
        wake.timer.unref?.();
      }
      return;
    } else if (kind === "tool_call" && id && !finished) {
      wake.openTools.add(id);
    } else if (kind === "tool_call_update" && id && finished) {
      wake.openTools.delete(id);
      const owner = worker.tools.get(id)?.turn;
      if (owner?.onEngineEvent) wake.owner ??= owner.onEngineEvent;
    } else if (kind === "usage_update") {
      wake.openTools.clear();
    }
    if (kind !== "usage_update" || wake.openTools.size) return;
    wake.timer = setTimeout(() => this.flushWake(worker), this.wakeQuietMs);
    wake.timer.unref?.();
  }

  /** Hand an idle wake-up to the App as a follow-up message; it is never dropped silently. */
  private flushWake(worker: Worker): void {
    const wake = worker.wake;
    if (!wake) return;
    worker.wake = null;
    if (wake.timer) clearTimeout(wake.timer);
    if (worker.swarm?.stoppedByUser || worker.swarm?.timedOut) return;
    const text = wake.text.trim();
    const handler = wake.owner ?? worker.lastTurnHandler;
    if (!text || !handler || !worker.sessionId) return;
    const event: EngineStreamEvent = { type: "task_notification", text, sessionId: worker.sessionId, status: "completed", origin: wake.owner ? "bound" : "unattributed" };
    try { void Promise.resolve(handler(event)).catch(() => undefined); } catch { /* Delivery is best-effort here; the Host ledgers it. */ }
  }

  private trackTool(worker: Worker, update: Record<string, unknown>, turn: Turn | null): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
    if (!id) return;
    const now = Date.now();
    let tool = worker.tools.get(id);
    if (!tool) {
      tool = { id, token: randomUUID(), name: "", status: "pending", startedAt: now, updatedAt: now, ...(turn ? { turn } : {}), background: !turn, emittedUse: false, emittedResult: false, emittedPermission: false };
      worker.tools.set(id, tool);
    }
    const owner = tool.turn && !tool.turn.done ? tool.turn : undefined;
    const permissionMeta = owner?.permissionTools.get(id);
    if (permissionMeta) {
      tool.emittedPermission = true;
      if (!tool.name && permissionMeta.name) tool.name = permissionMeta.name;
      if (!tool.title && permissionMeta.title) tool.title = permissionMeta.title;
      if (!tool.kind && permissionMeta.kind) tool.kind = permissionMeta.kind;
      if (tool.rawInput === undefined && permissionMeta.rawInput !== undefined) tool.rawInput = permissionMeta.rawInput;
      if (permissionMeta.isTaskArtifact) tool.isTaskArtifact = true;
    }
    if (typeof update.name === "string" && update.name) tool.name = update.name;
    if (typeof update.title === "string" && update.title) tool.title = update.title;
    if (typeof update.kind === "string") tool.kind = update.kind;
    if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
    if (typeof update.status === "string") tool.status = update.status;
    const attributed = extractWorkerAttribution({ _meta: update._meta, toolCall: update }, tool.workerName);
    if (attributed) tool.workerName = attributed;
    if (Array.isArray(update.content)) {
      for (const item of update.content) {
        const rec = asRecord(item);
        if (rec?.type === "diff" && typeof rec.newText === "string") tool.lastDiffNewText = rec.newText;
      }
    }
    tool.updatedAt = now;
    const taskPlan = extractAntigravityTaskPlan(update, worker.sessionId ?? "", worker.lastTaskMarkdown, {
      toolKind: tool.kind,
      toolName: tool.name,
      toolTitle: tool.title,
      toolStatus: tool.status,
      toolRawInput: tool.rawInput,
      toolDiffNewText: tool.lastDiffNewText,
      alreadyTaskArtifact: Boolean(tool.isTaskArtifact),
    });
    if (taskPlan?.isTaskArtifact) {
      tool.isTaskArtifact = true;
      if (taskPlan.markdown !== undefined) worker.lastTaskMarkdown = taskPlan.markdown;
    }
    if (tool.status === "completed" || tool.status === "failed") {
      owner?.permissionTools.delete(id);
    }
    if (!owner) return;
    const sessionId = worker.sessionId!;
    if (tool.isTaskArtifact) {
      if (taskPlan?.todos.length) this.emitPlan(owner, sessionId, taskPlan);
      if (!tool.emittedUse && !tool.emittedPermission) return;
      owner.toolSeen = true;
      const toolName = tool.name || tool.title || "Antigravity tool";
      if (tool.emittedPermission && !tool.emittedUse && tool.status === "in_progress") {
        tool.emittedUse = true;
        this.emit(owner, { type: "tool_use", toolName, ...(tool.rawInput !== undefined ? { toolInput: tool.rawInput } : {}), toolUseId: id, sessionId });
      }
      if ((tool.status === "completed" || tool.status === "failed") && !tool.emittedResult) {
        tool.emittedResult = true;
        const output = toolText(update);
        const exitCode = asRecord(update.rawOutput)?.exit_code;
        this.emit(owner, {
          type: "tool_result", toolName, toolUseId: id,
          ...(output !== undefined ? { output } : {}),
          ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
          isError: tool.status === "failed", sessionId,
        });
      }
      return;
    }
    owner.toolSeen = true;
    const toolName = tool.name || tool.title || "Antigravity tool";
    if (!tool.emittedUse) {
      tool.emittedUse = true;
      this.emit(owner, { type: "tool_use", toolName, ...(tool.rawInput !== undefined ? { toolInput: tool.rawInput } : {}), toolUseId: id, sessionId });
    }
    if ((tool.status === "completed" || tool.status === "failed") && !tool.emittedResult) {
      tool.emittedResult = true;
      if (tool.status === "completed" && spawnsReactiveSubagent(tool)) {
        owner.hasAsyncSubagent = true;
      }
      const output = toolText(update);
      const exitCode = asRecord(update.rawOutput)?.exit_code;
      this.emit(owner, {
        type: "tool_result", toolName, toolUseId: id,
        ...(output !== undefined ? { output } : {}),
        ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
        isError: tool.status === "failed", sessionId,
      });
    }
  }

  private async handlePermission(worker: Worker, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!worker || worker.removed || request.sessionId !== worker.sessionId) return { outcome: { outcome: "cancelled" } };
    this.markActivity(worker);
    const option = (kind: string) => request.options.find((candidate) => candidate.kind === kind)?.optionId;
    const reject = option("reject_once");
    const turn = worker.turn;
    // A request made while no turn owns this session (an idle wake-up or post-turn
    // worker) has no owner who could answer it: it is declined, never borrowed by another turn.
    if (!turn || turn.done || turn.stopRequested || !turn.onApprovalRequest) {
      return reject ? { outcome: { outcome: "selected", optionId: reject } } : { outcome: { outcome: "cancelled" } };
    }
    const toolCall = request.toolCall as unknown as Record<string, unknown>;
    const trackedTool = typeof toolCall.toolCallId === "string" ? worker.tools.get(toolCall.toolCallId) : undefined;
    const workerName = extractWorkerAttribution(request, trackedTool?.workerName);
    const rawName = typeof toolCall.name === "string" && toolCall.name ? toolCall.name : typeof toolCall.title === "string" && toolCall.title ? toolCall.title : "Antigravity tool";
    const rawInputRecord = asRecord(toolCall.rawInput);
    const isQuestion = rawName === "AskUserQuestion" || rawName === "ask_user_question" || Array.isArray(rawInputRecord?.questions);
    const toolName = isQuestion ? "AskUserQuestion" : rawName;
    const allow = option("allow_once");
    const questionInput = isQuestion && !Array.isArray(rawInputRecord?.questions)
      ? {
          questions: [{
            question: (typeof toolCall.title === "string" && toolCall.title.trim()) || "Choose an option.",
            header: workerName ? `${workerName}` : "Question",
            multi_select: false,
            options: request.options.filter((opt) => opt.kind === "allow_once" || opt.kind === "allow_always").map((opt) => ({ label: opt.name })),
          }],
        }
      : (toolCall.rawInput ?? {});
    const approval: EngineApprovalRequest = {
      engine: "antigravity",
      toolName,
      toolInput: isQuestion ? questionInput : (toolCall.rawInput ?? {}),
      ...(workerName ? { workerName } : {}),
      cwd: worker.workspacePath,
      sessionId: worker.sessionId!,
      abortSignal: turn.approvals.signal,
      approvalScopes: allow ? { once: "once" } : {},
    };
    if (typeof toolCall.toolCallId === "string") {
      const isTaskArtifact = Boolean(extractAntigravityTaskPlan({ ...toolCall, status: "pending" }, worker.sessionId ?? "")?.isTaskArtifact);
      const meta = {
        ...(typeof toolCall.name === "string" && toolCall.name ? { name: toolCall.name } : {}),
        ...(typeof toolCall.kind === "string" ? { kind: toolCall.kind } : {}),
        ...(typeof toolCall.title === "string" && toolCall.title ? { title: toolCall.title } : {}),
        ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
        ...(isTaskArtifact ? { isTaskArtifact: true } : {}),
      };
      turn.permissionTools.set(toolCall.toolCallId, meta);
      const existing = worker.tools.get(toolCall.toolCallId);
      if (existing) {
        existing.emittedPermission = true;
        if (!existing.name && meta.name) existing.name = meta.name;
        if (!existing.kind && meta.kind) existing.kind = meta.kind;
        if (!existing.title && meta.title) existing.title = meta.title;
        if (existing.rawInput === undefined && meta.rawInput !== undefined) existing.rawInput = meta.rawInput;
        if (meta.isTaskArtifact) existing.isTaskArtifact = true;
      }
      this.emit(turn, { type: "permission_request", toolName, toolInput: approval.toolInput, toolUseId: toolCall.toolCallId, sessionId: worker.sessionId! });
    }
    worker.pendingPermissions += 1;
    this.armInactivity(turn);
    let decision: EngineApprovalDecision;
    try {
      decision = await turn.onApprovalRequest(approval);
    } catch {
      decision = { behavior: "deny" };
    } finally {
      worker.pendingPermissions = Math.max(0, worker.pendingPermissions - 1);
      if (worker.turn === turn && !turn.done) this.armInactivity(turn);
    }
    if (turn.done || turn.stopRequested || worker.removed || worker.closing) return { outcome: { outcome: "cancelled" } };
    if (decision.behavior === "allow") {
      if (isQuestion) {
        const answers = asRecord(asRecord(decision.updatedInput)?.answers);
        const firstAnswer = answers ? Object.values(answers).find((v): v is string => typeof v === "string" && Boolean(v.trim()))?.trim() : undefined;
        const matched = firstAnswer ? request.options.find((opt) => opt.name.trim().toLowerCase() === firstAnswer.toLowerCase()) : undefined;
        if (matched) return { outcome: { outcome: "selected", optionId: matched.optionId }, ...(decision.updatedInput !== undefined ? { _meta: { updatedInput: decision.updatedInput } } : {}) } as RequestPermissionResponse;
        if (allow) return { outcome: { outcome: "selected", optionId: allow }, ...(decision.updatedInput !== undefined ? { _meta: { updatedInput: decision.updatedInput } } : {}) } as RequestPermissionResponse;
      } else if (allow) {
        return { outcome: { outcome: "selected", optionId: allow } };
      }
    }
    if (decision.behavior === "deny") turn.declinedAt = turn.text.length;
    return reject ? { outcome: { outcome: "selected", optionId: reject } } : { outcome: { outcome: "cancelled" } };
  }

  private async handleElicitation(worker: Worker, request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (!worker || worker.removed || !CreateElicitationRequestGuard.isForm(request) || !("sessionId" in request) || request.sessionId !== worker.sessionId) {
      return { action: "cancel" };
    }
    this.markActivity(worker);
    const turn = worker.turn;
    // An elicitation request arriving while no turn owns this session has no
    // owner who could answer it: decline cleanly rather than borrowing a previous turn's handler.
    if (!turn || turn.done || turn.stopRequested || !turn.onApprovalRequest) return { action: "decline" };
    const workerName = extractWorkerAttribution(request);

    const properties = request.requestedSchema.properties ?? {};
    const entries = Object.entries(properties);
    if (!entries.length) return { action: "decline" };
    const required = new Set(request.requestedSchema.required ?? []);
    const isZh = turn.locale === "zh";
    const answerKeys = new Set<string>();
    const fieldMap: Array<{
      key: string;
      answerKey: string;
      type: "string" | "number" | "integer" | "boolean" | "array";
      required: boolean;
      constrained: boolean;
      minimum?: number;
      maximum?: number;
      minItems?: number;
      maxItems?: number;
      options: ElicitationOption[];
    }> = [];
    const questions: Array<{
      question: string;
      header: string;
      multi_select: boolean;
      required: boolean;
      allowFreeText: boolean;
      min_selections?: number;
      max_selections?: number;
      options: Array<{ label: string; description?: string }>;
    }> = [];
    for (let index = 0; index < entries.length; index++) {
      const [key, schema] = entries[index]! as [string, ElicitationPropertySchema];
      if (!schema || typeof schema !== "object") return { action: "decline" };
      const schemaType = (schema as { type?: unknown }).type;
      if (schemaType !== "string" && schemaType !== "number" && schemaType !== "integer" && schemaType !== "boolean" && schemaType !== "array") {
        return { action: "decline" };
      }
      const header = (typeof schema.title === "string" && schema.title.trim()) || request.requestedSchema.title?.trim() || `Question ${index + 1}`;
      const baseQuestion = (typeof schema.description === "string" && schema.description.trim()) || (entries.length === 1 ? request.message.trim() : "") || header;
      let answerKey = baseQuestion;
      if (answerKeys.has(answerKey)) {
        answerKey = `${baseQuestion} (${index + 1})`;
      }
      while (answerKeys.has(answerKey)) {
        answerKey = `${answerKey} (${key})`;
      }
      answerKeys.add(answerKey);

      const options: ElicitationOption[] = [];
      let constrained = false;
      let minimum: number | undefined;
      let maximum: number | undefined;
      let minItems: number | undefined;
      let maxItems: number | undefined;
      if (schema.type === "string") {
        if (Array.isArray(schema.oneOf)) {
          constrained = true;
          for (const opt of schema.oneOf) options.push({ label: opt.title.trim() || opt.const, value: opt.const, ...(opt.description?.trim() ? { description: opt.description.trim() } : {}) });
        } else if (Array.isArray(schema.enum)) {
          constrained = true;
          for (const v of schema.enum) options.push({ label: v, value: v });
        }
      } else if (schema.type === "boolean") {
        constrained = true;
        options.push(
          { label: isZh ? "是" : "Yes", value: "true" },
          { label: isZh ? "否" : "No", value: "false" },
        );
      } else if (schema.type === "number" || schema.type === "integer") {
        if (typeof schema.minimum === "number" && Number.isFinite(schema.minimum)) minimum = schema.minimum;
        if (typeof schema.maximum === "number" && Number.isFinite(schema.maximum)) maximum = schema.maximum;
      } else if (schema.type === "array") {
        if (!schema.items || typeof schema.items !== "object") return { action: "decline" };
        if ("anyOf" in schema.items && Array.isArray(schema.items.anyOf)) {
          constrained = true;
          for (const opt of schema.items.anyOf) options.push({ label: opt.title.trim() || opt.const, value: opt.const, ...(opt.description?.trim() ? { description: opt.description.trim() } : {}) });
        } else if ("enum" in schema.items && Array.isArray(schema.items.enum)) {
          constrained = true;
          for (const v of schema.items.enum) options.push({ label: v, value: v });
        } else {
          return { action: "decline" };
        }
        if (typeof schema.minItems === "number" && Number.isFinite(schema.minItems)) minItems = schema.minItems;
        if (typeof schema.maxItems === "number" && Number.isFinite(schema.maxItems)) maxItems = schema.maxItems;
      }
      const multiSelect = schemaType === "array";
      fieldMap.push({
        key,
        answerKey,
        type: schemaType,
        required: required.has(key),
        constrained,
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
        ...(minItems !== undefined ? { minItems } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        options,
      });
      questions.push({
        question: answerKey,
        header,
        multi_select: multiSelect,
        required: required.has(key),
        allowFreeText: !constrained,
        ...(multiSelect && minItems !== undefined ? { min_selections: minItems } : {}),
        ...(multiSelect && maxItems !== undefined ? { max_selections: maxItems } : {}),
        options: options.map(({ label, description }) => ({ label, ...(description ? { description } : {}) })),
      });
    }

    const approval: EngineApprovalRequest = {
      engine: "antigravity",
      toolName: "AskUserQuestion",
      toolInput: { questions },
      ...(workerName ? { workerName } : {}),
      cwd: worker.workspacePath,
      sessionId: worker.sessionId!,
      abortSignal: turn.approvals.signal,
    };
    worker.pendingPermissions += 1;
    this.armInactivity(turn);
    let decision: EngineApprovalDecision;
    try {
      decision = await turn.onApprovalRequest(approval);
    } catch {
      decision = { behavior: "deny" };
    } finally {
      worker.pendingPermissions = Math.max(0, worker.pendingPermissions - 1);
      if (worker.turn === turn && !turn.done) this.armInactivity(turn);
    }
    if (turn.done || turn.stopRequested || worker.removed || worker.closing) return { action: "cancel" };
    if (decision.behavior !== "allow") return { action: "decline" };
    const answers = asRecord(asRecord(decision.updatedInput)?.answers) ?? {};
    const content: Record<string, ElicitationContentValue> = {};
    for (const field of fieldMap) {
      const raw = answers[field.answerKey] ?? answers[field.key];
      const missing = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());
      if (missing) {
        if (field.required) return { action: "decline" };
        continue;
      }
      if (field.type === "boolean") {
        const parsed = parseBooleanElicitationAnswer(raw);
        if (parsed === undefined) return { action: "decline" };
        content[field.key] = parsed;
      } else if (field.type === "number" || field.type === "integer") {
        const parsed = parseNumberElicitationAnswer(raw, field.type === "integer", field.minimum, field.maximum);
        if (parsed === undefined) return { action: "decline" };
        content[field.key] = parsed;
      } else if (field.type === "array") {
        const parsed = parseMultiSelectElicitationAnswer(raw, field.options);
        if (!parsed) return { action: "decline" };
        if (field.required && parsed.length === 0) return { action: "decline" };
        if (field.minItems !== undefined && parsed.length < field.minItems) return { action: "decline" };
        if (field.maxItems !== undefined && parsed.length > field.maxItems) return { action: "decline" };
        content[field.key] = parsed;
      } else {
        if (typeof raw !== "string") return { action: "decline" };
        const trimmed = raw.trim();
        if (field.constrained) {
          const matched = matchElicitationOption(field.options, trimmed);
          if (!matched) return { action: "decline" };
          content[field.key] = matched.value;
        } else {
          content[field.key] = trimmed;
        }
      }
    }
    return { action: "accept", content };
  }

  private withStderr(worker: Worker, error: Error): Error {
    const stderr = worker.stderrTail.trim();
    return stderr && !error.message.includes(stderr) ? new Error(`${error.message}\n\nAntigravity stderr:\n${stderr}`) : error;
  }

  /** The process failed or exited by itself. Nothing can be closed any more. */
  private failWorker(worker: Worker, error: Error): void {
    if (!worker) return;
    worker.failure ??= error;
    if (!worker.removed) this.flushWake(worker);
    const turn = worker.turn;
    if (turn && !turn.done) {
      const failure = turn.stopRequested ? new Error(STOPPED_BY_USER)
        : turn.toolSeen || turn.text.trim() ? new EngineIncompleteResponseError(error.message, "interrupted") : error;
      this.settleTurn(turn, failure);
    }
    if (worker.removed) return;
    this.removeWorker(worker);
    this.killProcessTreeFn(worker.child.pid);
  }

  private removeWorker(worker: Worker): void {
    worker.removed = true;
    this.clearSwarmCeilingTimer(worker);
    for (const notify of worker.commandCloseWaiters) notify();
    worker.commandCloseWaiters.clear();
    worker.rejectStart?.(worker.failure ?? new Error("Antigravity ACP worker is no longer available"));
    for (const [key, candidate] of this.workers) if (candidate === worker) this.workers.delete(key);
  }

  /**
   * Ends a worker: session/close for its session (bounded), then stdin, then
   * the process tree. Every path that ends an `agy acp` process goes here.
   */
  private closeWorker(worker: Worker, error?: Error, killOptions?: { graceMs: number }): Promise<void> {
    if (worker.closing) return worker.closing;
    worker.closing = (async () => {
      const turn = worker.turn;
      if (error) worker.failure ??= error;
      this.removeWorker(worker);
      this.flushWake(worker);
      if (turn && !turn.done) this.settleTurn(turn, error ?? new Error("Antigravity ACP worker was closed"));
      const close = worker.initialized?.agentCapabilities?.sessionCapabilities?.close;
      if (worker.sessionId && close && !worker.exited) {
        await withTimeout(worker.connection.agent.request(acpMethods.agent.session.close, { sessionId: worker.sessionId }),
          this.closeTimeoutMs, "Antigravity ACP session/close timed out").catch(() => undefined);
      }
      try { worker.child.stdin?.end?.(); } catch { /* The process tree is ended below. */ }
      if (!worker.exited) this.killProcessTreeFn(worker.child.pid, killOptions);
    })();
    return worker.closing;
  }

  private async reapIdleWorkers(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      const now = Date.now();
      for (const worker of new Set(this.workers.values())) {
        if (worker.removed || worker.turn || worker.reserved) continue;
        if (worker.swarm?.active && !worker.swarm.stoppedByUser && !worker.swarm.timedOut && !this.isSwarmWithinHardCap(worker.swarm, now)) {
          await this.onSwarmHardTimeout(worker, worker.swarm.startedAt);
          continue;
        }
        if (now - worker.lastActivityAt < this.idleWorkerTtlMs) continue;
        if (!await this.isReapable(worker)) continue;
        if (worker.swarm?.active && !worker.swarm.stoppedByUser && !worker.swarm.timedOut) {
          this.markSwarmEnded(worker.swarm, "timeout", worker.sessionId);
          this.clearSwarmCeilingTimer(worker);
        }
        void this.closeWorker(worker);
      }
    } finally {
      this.reaping = false;
    }
  }

  /** Closing a session stops its background commands and swarm workers, so a session still running one is kept
   * while genuinely executing and within the hard swarm ceiling. Permanently paused/idle swarms are reapable. */
  private async isReapable(worker: Worker): Promise<boolean> {
    if (worker.pendingPermissions > 0) return false;
    if (this.hasOpenBackgroundTools(worker)) return false;
    if (await this.hasGenuinelyActiveSwarmWithinCap(worker)) return false;
    return true;
  }

  destroy(): Promise<void> {
    if (!this.destroyPromise) {
      this.destroyed = true;
      this.destroyPromise = this.destroyInternal();
    }
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const quotaReads = cancelOwnedAntigravityQuotaReads(this.quotaCache).catch(() => undefined);
    this.quotaCache.invalidate();
    // A process that is still starting is ended now; its start then fails at once instead of timing out.
    for (const worker of new Set(this.workers.values())) if (worker.rejectStart) void this.closeWorker(worker, new Error("Adapter destroyed"));
    const created = await Promise.allSettled([...this.pendingWorkers.values()]);
    const workers = new Set(this.workers.values());
    for (const result of created) if (result.status === "fulfilled") workers.add(result.value);
    await Promise.all([...workers].map((worker) => this.closeWorker(worker, new Error("Adapter destroyed"))));
    this.workers.clear();
    this.pendingWorkers.clear();
    await quotaReads;
  }
}
