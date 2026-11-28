import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  EngineSteeringRejectedError, withFailedTurnUsage,
  type AdapterUsage, type AppPlatformTools, type CodexAdapter, type CodexAdapterResponse,
  type CodexSessionHandle, type CodexThreadGoal, type CodexThreadGoalResponse, type CodexUserMessageInput,
  type EngineApprovalDecision, type EngineContextUsage, type EngineQuotaReadResult, type EngineSideSession,
  type EngineStreamEvent, type EngineTask, type EngineTaskControlResult, type EngineTaskSnapshot,
  type ExternalSessionInfo, type NativeHistoryAnchor, type NativeHistoryRejection, type NativeHistoryResult,
  type NativeHistoryState, type SideCapability,
} from "./adapter.js";
import { ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS } from "./engine-timeouts.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import type { Locale } from "../runtime/locale.js";
import { decodePiModel, PI_THINKING_LEVELS } from "./pi-models.js";
import { piLabelAnswer, piQuestionSelection, piQuestionText } from "./pi-question-identity.js";
import { parsePiSlashCommand } from "./pi-rpc-protocol.js";
import { piQuestionWithDetail, piSkippedImagesNotice, type PiSkippedImageReason } from "./pi-turn-mapper.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { DEFAULT_APPROVAL_MODE, resolveApprovalModeForEngine } from "../state/approval-mode.js";
import {
  getEngineEffortValidationError, readValidatedConfigFile, resolveEngineOverride,
  unsupportedEngineEffortError, type EffortLevel, type EngineOverride,
} from "../state/instance-config.js";
import {
  openOmpBridgeEndpoint, resolveOmpBridgeExtensionPath,
  type OmpBridgeApproveRequest, type OmpBridgeConnection, type OmpBridgeEndpoint,
} from "./omp-bridge-host.js";
import { parseOmpFormRequest } from "./omp-form.js";
import { OmpSessionStore } from "./omp-session-store.js";
import { OmpRpcClient, OmpRpcCommandError, type OmpLaunchSpec, type OmpSpawn } from "./omp-rpc-client.js";
import type {
  OmpBtwRecord, OmpExtensionUiRequest, OmpGoalModeState, OmpGoalRecord, OmpGoalUpdatedFrame,
  OmpHostToolCallFrame, OmpHostToolCancelFrame, OmpPromptResultFrame, OmpSessionEntry,
  OmpSessionEvent, OmpSessionState, OmpSlashCommand, OmpSubagentEventFrame,
  OmpSubagentLifecycleFrame, OmpSubagentProgressFrame, OmpSubagentSummary,
} from "./omp-rpc-protocol.js";
import type { PiImageContent } from "./pi-rpc-protocol.js";
import type { RunScope } from "../client-protocol/run.js";

export interface OmpRpcAdapterOptions {
  launch: OmpLaunchSpec;
  workspacePath: string;
  stateDir: string;
  childEnv: NodeJS.ProcessEnv;
  configPath?: string;
  /** Compiled approval-gating extension. Defaults to the packaged one; null disables bridge gating (tests only). */
  bridgeExtensionPath?: string | null;
  openBridgeFn?: typeof openOmpBridgeEndpoint;
  spawnFn?: OmpSpawn;
  killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
  startupTimeoutMs?: number;
  cancelGraceMs?: number;
  inactivityTimeoutMs?: number | null;
  idleWorkerTtlMs?: number;
  idleSweepIntervalMs?: number;
}

interface SubagentRecord {
  subagentId: string;
  index?: number;
  agent?: string;
  scope: RunScope;
  label: string;
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  updatedAt: number;
  progress?: string;
}

interface GoalWatcher {
  abortSignal?: AbortSignal;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: CodexUserMessageInput["onApprovalRequest"];
  resolve: (response: CodexThreadGoalResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface PendingSteer {
  text: string;
  onOutcome?: (outcome: SteeringApplication) => void;
  confirmed: boolean;
  settled: boolean;
}

interface OmpHistoryInput {
  promptText: string;
  previousLeaf: string | null;
  previousIds: ReadonlySet<string>;
  userEvent?: { id?: string; message: NonNullable<OmpSessionEntry["message"]> } | null;
}

interface ActiveOmpTurn {
  promptId?: string;
  input: CodexUserMessageInput;
  textChunks: string[];
  finalText?: string;
  thinkingChunks: string[];
  commandOutputs: string[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; hasData: boolean };
  settled: boolean;
  finalizing: boolean;
  aborting: boolean;
  promptResult?: OmpPromptResultFrame;
  pendingSteers: PendingSteer[];
  compactionId?: string;
  compactionStartedAt?: number;
  humanWaits: number;
  timedOut?: string;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  abortScope: AbortController;
  sessionPublication?: Promise<void>;
  historyInput?: OmpHistoryInput;
  resolve: (response: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
}

interface OmpWorker {
  readonly sessionKey: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly client: OmpRpcClient;
  readonly endpoint?: OmpBridgeEndpoint;
  bridgePromise?: Promise<OmpBridgeConnection>;
  bridge?: OmpBridgeConnection;
  gate?: boolean;
  bridgeHostToolsKey?: string;
  state: OmpSessionState;
  initialModel?: { provider: string; modelId: string };
  initialThinkingLevel?: string;
  appliedModelOverride: boolean;
  appliedEffortOverride: boolean;
  queue: { steering: string[]; followUp: string[] };
  readonly subagents: Map<string, SubagentRecord>;
  readonly activeBtw: Map<string, { resolve: (rec: OmpBtwRecord) => void; reject: (err: Error) => void; onDelta?: (delta: string) => void }>;
  readonly bufferedBtwDeltas: Map<string, string[]>;
  readonly completedBtw: Map<string, OmpBtwRecord>;
  readonly hostToolCalls: Map<string, AbortController>;
  readonly pendingUi: Map<string, AbortController>;
  registeredHostToolsKey?: string;
  activeAppTools?: AppPlatformTools;
  activeTurn?: ActiveOmpTurn;
  goalWatcher?: GoalWatcher;
  lastGoal?: OmpGoalRecord | null;
  compactionId?: string;
  compactionStartedAt?: number;
  lastUsedAt: number;
  closed: boolean;
}

const DEFAULT_CANCEL_GRACE_MS = 5_000;
const DEFAULT_IDLE_WORKER_TTL_MS = 15 * 60_000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60_000;
const OMP_EMPTY_HISTORY_HEAD = "omp:empty";
const EDITOR_PREFILL_LIMIT = 16_000;
const SESSION_GRANT_LIMIT = 128;
const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "glob", "ask"]);
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;

function abortError(message = "omp turn was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function destroyedError(): Error {
  return new Error("omp adapter is destroyed");
}

function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) throw abortError(message);
}

/** Resolve with `work`, or reject with AbortError as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  work.catch(() => {});
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const quit = () => reject(abortError());
    signal.addEventListener("abort", quit, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", quit));
  });
}

function minutesLabel(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  return `${value} ${value === 1 ? "minute" : "minutes"}`;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map(block => block.text)
    .join("");
}

function extractMessageUsage(message: unknown): AdapterUsage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = typeof usage.input === "number" ? usage.input : typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const outputTokens = typeof usage.output === "number" ? usage.output : typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  const cachedTokens = typeof usage.cacheRead === "number" ? usage.cacheRead : typeof usage.cachedTokens === "number" ? usage.cachedTokens : 0;
  const costObj = usage.cost && typeof usage.cost === "object" ? usage.cost as { total?: unknown } : undefined;
  const costUsd = typeof costObj?.total === "number" ? costObj.total : typeof usage.costUsd === "number" ? usage.costUsd : 0;
  if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && costUsd === 0) return undefined;
  return { inputTokens, outputTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}), ...(costUsd > 0 ? { costUsd } : {}) };
}

function isDroppedGoalStatus(raw?: string): boolean {
  return raw === "dropped" || raw === "cancelled" || raw === "canceled";
}

export function mapOmpGoalStatus(raw?: string): CodexThreadGoal["status"] | null {
  if (isDroppedGoalStatus(raw)) return null;
  switch (raw) {
    case "active":
    case "running":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
    case "usage_limited":
    case "usage-limited":
      return "usageLimited";
    case "budgetLimited":
    case "budget_limited":
    case "budget-limited":
      return "budgetLimited";
    case "complete":
    case "completed":
    case "done":
      return "complete";
    default:
      return raw ? "paused" : "active";
  }
}

export function unwrapOmpGoal(
  rawGoal: OmpGoalRecord | OmpGoalModeState | null | undefined,
  rawState?: OmpGoalModeState | null,
): {
  record: OmpGoalRecord | null;
  state: OmpGoalModeState | null;
  enabled?: boolean;
  reason?: string;
} {
  let record: OmpGoalRecord | null = null;
  let state: OmpGoalModeState | null = rawState ?? null;
  let enabled: boolean | undefined = rawState?.enabled;
  let reason: string | undefined = rawState?.reason;

  if (rawGoal && typeof rawGoal === "object") {
    const asMode = rawGoal as OmpGoalModeState;
    if ("goal" in asMode && !("objective" in asMode)) {
      state = state ?? asMode;
      if (typeof asMode.enabled === "boolean") enabled = asMode.enabled;
      if (typeof asMode.reason === "string") reason = asMode.reason;
      record = asMode.goal ?? null;
    } else if (typeof (rawGoal as OmpGoalRecord).objective === "string") {
      record = rawGoal as OmpGoalRecord;
    }
  }
  if (!record && rawState?.goal && typeof rawState.goal.objective === "string") {
    record = rawState.goal;
  }
  return { record, state, ...(enabled !== undefined ? { enabled } : {}), ...(reason ? { reason } : {}) };
}

function toCodexThreadGoal(
  threadId: string,
  rawGoal: OmpGoalRecord | OmpGoalModeState | null | undefined,
  rawState?: OmpGoalModeState | null,
): CodexThreadGoal | null {
  const { record, state } = unwrapOmpGoal(rawGoal, rawState);
  if (!record || typeof record.objective !== "string" || !record.objective.trim()) return null;
  const rawStatus = state?.status ?? record.status;
  const status = mapOmpGoalStatus(rawStatus);
  if (status === null) return null;
  const now = Date.now();
  return {
    threadId,
    objective: record.objective,
    status,
    tokenBudget: record.tokenBudget ?? record.token_budget ?? null,
    tokensUsed: state?.tokensUsed ?? record.tokensUsed ?? record.tokens_used ?? 0,
    timeUsedSeconds: state?.timeUsedSeconds ?? record.timeUsedSeconds ?? record.time_used_seconds ?? 0,
    createdAt: record.createdAt ?? record.created_at ?? now,
    updatedAt: record.updatedAt ?? record.updated_at ?? now,
  };
}

function isOmpStateBusy(state: OmpSessionState): boolean {
  return Boolean(
    state.isStreaming
    || state.isCompacting
    || (state.queuedMessageCount ?? state.pendingMessageCount ?? 0) > 0
    || state.hasPendingAsyncWork === true
    || state.isSettled === false,
  );
}

function activeEntryBranch(entries: OmpSessionEntry[], leafId: string | null): OmpSessionEntry[] {
  if (!leafId || entries.length === 0) return [];
  const byId = new Map<string, OmpSessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  if (byId.size !== entries.length) return [];
  const pathEntries: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leafId;
  while (cur) {
    if (seen.has(cur)) return [];
    seen.add(cur);
    const entry = byId.get(cur);
    if (!entry) return [];
    pathEntries.push(entry);
    cur = entry.parentId ?? null;
  }
  pathEntries.reverse();
  return pathEntries;
}

function isUserMessageEntry(entry: OmpSessionEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

function matchHistoryInput(history: OmpHistoryInput | undefined, branch: OmpSessionEntry[]): string | undefined {
  if (!history?.userEvent) return undefined;
  const { previousLeaf, previousIds, userEvent } = history;
  const start = branch.findIndex(entry => entry.id === previousLeaf);
  if (previousLeaf !== null && start < 0) return undefined;
  const appended = branch.slice(start + 1);
  if (appended.some(entry => previousIds.has(entry.id))) return undefined;
  const [main, ...laterUsers] = appended.filter(isUserMessageEntry);
  // Confirm the first new user input and rule out a second entry that the
  // same native event could describe.
  if (!main || !isDeepStrictEqual(main.message, userEvent.message)) return undefined;
  return laterUsers.some(entry => isDeepStrictEqual(entry.message, userEvent.message)) ? undefined : main.id;
}

function resolveAfterTurnLeafId(branch: OmpSessionEntry[], userAnchorIndex: number): string {
  for (let i = userAnchorIndex + 1; i < branch.length; i++) {
    if (isUserMessageEntry(branch[i]!)) {
      return branch[i - 1]!.id;
    }
  }
  return branch[branch.length - 1]!.id;
}

async function prepareAttachments(
  files: string[],
  modelAcceptsImages: boolean,
): Promise<{
  images: PiImageContent[];
  extraFiles: string[];
  skippedImages: Array<{ file: string; reason: PiSkippedImageReason }>;
}> {
  const images: PiImageContent[] = [];
  const extraFiles: string[] = [];
  const skippedImages: Array<{ file: string; reason: PiSkippedImageReason }> = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (mimeType) {
      if (!modelAcceptsImages) {
        skippedImages.push({ file, reason: "model-has-no-vision" });
        extraFiles.push(file);
        continue;
      }
      try {
        const st = await stat(file);
        if (!st.isFile()) {
          skippedImages.push({ file, reason: "unreadable" });
          extraFiles.push(file);
          continue;
        }
        if (st.size > MAX_INLINE_IMAGE_BYTES) {
          skippedImages.push({ file, reason: "too-large" });
          extraFiles.push(file);
          continue;
        }
        const data = (await readFile(file)).toString("base64");
        images.push({ type: "image", data, mimeType });
        continue;
      } catch {
        skippedImages.push({ file, reason: "unreadable" });
      }
    }
    extraFiles.push(file);
  }
  return { images, extraFiles, skippedImages };
}

function extractAskResponseSelections(updatedInput: unknown): {
  answers: Record<string, string>;
  objectSelections?: Record<string, { selectedOptions: string[]; customInput?: string }>;
} {
  if (!updatedInput || typeof updatedInput !== "object") return { answers: {} };
  const record = updatedInput as {
    answers?: Record<string, unknown>;
    selections?: unknown;
  };
  const answers: Record<string, string> = {};
  if (record.answers && typeof record.answers === "object") {
    for (const [k, v] of Object.entries(record.answers)) {
      if (typeof v === "string") answers[k] = v;
    }
  }
  let objectSelections: Record<string, { selectedOptions: string[]; customInput?: string }> | undefined;
  if (record.selections && typeof record.selections === "object" && !Array.isArray(record.selections)) {
    objectSelections = {};
    for (const [k, v] of Object.entries(record.selections as Record<string, { selectedOptions?: unknown; customInput?: unknown }>)) {
      if (!v || typeof v !== "object") continue;
      objectSelections[k] = {
        selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions.filter((x): x is string => typeof x === "string") : [],
        ...(typeof v.customInput === "string" && v.customInput.trim() ? { customInput: v.customInput.trim() } : {}),
      };
    }
  }
  return { answers, objectSelections };
}

function mapSubagentStatus(raw?: string): SubagentRecord["status"] {
  if (raw === "completed") return "done";
  if (raw === "failed") return "error";
  if (raw === "aborted") return "stopped";
  return "running";
}

function formatSubagentProgress(payload: OmpSubagentProgressFrame["payload"]): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const prog = payload.progress;
  if (typeof prog === "string" && prog.trim()) return prog.trim();
  if (prog && typeof prog === "object") {
    if (typeof prog.text === "string" && prog.text.trim()) return prog.text.trim();
    if (typeof prog.lastIntent === "string" && prog.lastIntent.trim()) return prog.lastIntent.trim();
    if (typeof prog.currentTool === "string" && prog.currentTool.trim()) return `Running ${prog.currentTool.trim()}`;
    if (typeof prog.status === "string" && prog.status.trim()) return prog.status.trim();
  }
  if (typeof payload.task === "string" && payload.task.trim()) return payload.task.trim();
  return undefined;
}

/**
 * oh-my-pi (`omp --mode rpc-ui`) engine adapter aligned with Codex, Claude Code, and Pi.
 */
export class OmpRpcAdapter implements CodexAdapter {
  readonly inFlightSendBehavior = "steer" as const;
  readonly acceptsHostSessionKeyForSide = true;
  readonly turnRuntimeLimitMs: number | null = null;
  private readonly store: OmpSessionStore;
  private readonly workers = new Map<string, OmpWorker>();
  private readonly starting = new Map<string, Promise<OmpWorker>>();
  private readonly grants = new Map<string, Set<string>>();
  private readonly inactivityTimeoutMs: number | null;
  private readonly idleWorkerTtlMs: number;
  private readonly bridgeExtensionPath: string | null;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  private cachedCommands: Array<{ name: string; description: string; aliases?: string[] }> = [];
  private destroyed = false;
  /** Aborted by `destroy()`: any in-flight worker startup stops waiting and tears down immediately. */
  private readonly retiring = new AbortController();
  private destroying?: Promise<void>;

  constructor(private readonly options: OmpRpcAdapterOptions) {
    this.store = new OmpSessionStore({ stateDir: options.stateDir, childEnv: options.childEnv });
    this.inactivityTimeoutMs = options.inactivityTimeoutMs === undefined ? ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS : options.inactivityTimeoutMs;
    this.idleWorkerTtlMs = options.idleWorkerTtlMs ?? DEFAULT_IDLE_WORKER_TTL_MS;
    this.bridgeExtensionPath = options.bridgeExtensionPath === undefined
      ? (options.spawnFn && !options.openBridgeFn ? null : resolveOmpBridgeExtensionPath())
      : options.bridgeExtensionPath;
    const sweepMs = options.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => { void this.sweepIdleWorkers(); }, sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  async createSession(_chatId?: number): Promise<CodexSessionHandle> {
    if (this.destroyed) throw new Error("omp adapter is destroyed");
    return { sessionId: `omp_${randomUUID()}` };
  }

  supportsSessionSteering(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    const turn = worker?.activeTurn;
    return !!worker && !worker.closed && worker.client.alive && !!turn?.sessionPublication
      && !turn.settled && !turn.finalizing && !turn.aborting;
  }

  hasPendingNativeWork(): boolean {
    if (this.starting.size > 0) return true;
    for (const worker of this.workers.values()) {
      if (worker.closed) continue;
      if (worker.activeTurn && !worker.activeTurn.settled) return true;
      if (worker.goalWatcher && !worker.goalWatcher.settled) return true;
      for (const sub of worker.subagents.values()) {
        if (sub.status === "running") return true;
      }
    }
    return false;
  }

  advertisedCommands(): Array<{ name: string; description: string }> {
    return this.cachedCommands.map(({ name, description }) => ({ name, description }));
  }

  private updateAdvertisedCommands(commands: OmpSlashCommand[] | undefined): void {
    if (!Array.isArray(commands)) return;
    this.cachedCommands = commands
      .filter((c): c is OmpSlashCommand => !!c && typeof c.name === "string" && c.name.trim().length > 0)
      .map(c => ({
        name: c.name.trim(),
        description: c.description?.trim() || c.source || "",
        ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.map(a => a.trim()).filter(Boolean) } : {}),
      }));
  }

  private isAdvertisedCommand(name: string): boolean {
    const lower = name.toLowerCase();
    return this.cachedCommands.some(c =>
      c.name.toLowerCase() === lower || Boolean(c.aliases?.some(alias => alias.toLowerCase() === lower)),
    );
  }

  private async closeWorker(worker: OmpWorker, closeError?: Error): Promise<void> {
    if (worker.closed && !worker.client.alive) {
      worker.endpoint?.dispose();
      return;
    }
    worker.closed = true;
    if (this.workers.get(worker.sessionKey) === worker) this.workers.delete(worker.sessionKey);
    for (const [, ac] of worker.hostToolCalls) ac.abort();
    worker.hostToolCalls.clear();
    for (const [, ac] of worker.pendingUi) ac.abort();
    worker.pendingUi.clear();
    if (worker.activeTurn && !worker.activeTurn.settled) {
      const turn = worker.activeTurn;
      this.settlePendingSteers(turn, "dropped", "engine_exit");
      this.clearTurnTimers(turn);
      turn.abortScope.abort();
      turn.settled = true;
      worker.activeTurn = undefined;
      turn.reject(withFailedTurnUsage(closeError ?? new Error("omp worker closed before turn settled"), this.turnUsage(turn)));
    }
    if (worker.goalWatcher && !worker.goalWatcher.settled) {
      const watcher = worker.goalWatcher;
      watcher.settled = true;
      worker.goalWatcher = undefined;
      watcher.reject(closeError ?? new Error("omp worker closed while watching goal"));
    }
    for (const [id, waiter] of worker.activeBtw) {
      worker.activeBtw.delete(id);
      waiter.reject(closeError ?? new Error("omp worker closed during side question"));
    }
    worker.bufferedBtwDeltas.clear();
    worker.endpoint?.dispose();
    await worker.client.close().catch(() => { worker.client.terminate(); });
  }

  private async sweepIdleWorkers(): Promise<void> {
    if (this.destroyed || this.idleWorkerTtlMs <= 0) return;
    const now = Date.now();
    for (const [, worker] of [...this.workers]) {
      if (worker.closed) continue;
      if (worker.activeTurn || worker.goalWatcher || worker.activeBtw.size > 0 || worker.pendingUi.size > 0) continue;
      let runningSub = false;
      for (const sub of worker.subagents.values()) {
        if (sub.status === "running") { runningSub = true; break; }
      }
      if (runningSub) continue;
      if (now - worker.lastUsedAt < this.idleWorkerTtlMs) continue;
      await this.closeWorker(worker);
    }
  }

  private async ensureWorkerForExistingSession(
    sessionId: string,
    workspaceOverride?: string,
    signal?: AbortSignal,
  ): Promise<OmpWorker | undefined> {
    if (this.destroyed) return undefined;
    const existing = this.workers.get(sessionId);
    if (existing && !existing.closed && existing.client.alive) return existing;
    const persisted = await this.store.resolvePersistedSessionFile(sessionId);
    if (this.destroyed || !persisted) return undefined;
    return this.getOrStartWorker(sessionId, workspaceOverride, signal);
  }

  private async getOrStartWorker(sessionKey: string, workspaceOverride?: string, signal?: AbortSignal): Promise<OmpWorker> {
    if (this.destroyed) throw destroyedError();
    throwIfAborted(signal);
    const existing = this.workers.get(sessionKey);
    if (existing && !existing.closed && existing.client.alive) return existing;
    const waitSignal = signal ? AbortSignal.any([signal, this.retiring.signal]) : this.retiring.signal;
    const inflight = this.starting.get(sessionKey);
    if (inflight) {
      let worker: OmpWorker;
      try {
        worker = await untilAborted(inflight, waitSignal);
      } catch (error) {
        if (this.destroyed) throw destroyedError();
        if (signal?.aborted) throw abortError();
        throw error;
      }
      if (this.destroyed || worker.closed) throw destroyedError();
      throwIfAborted(signal);
      return worker;
    }

    const work = (async (): Promise<OmpWorker> => {
      const startSignal = waitSignal;
      let workerRef: OmpWorker | undefined;
      let endpoint: OmpBridgeEndpoint | undefined;
      let client: OmpRpcClient | undefined;
      let registered = false;

      const assertRunning = () => {
        if (this.destroyed) throw destroyedError();
        throwIfAborted(signal);
      };

      const discard = async () => {
        if (workerRef) workerRef.closed = true;
        endpoint?.dispose();
        endpoint = undefined;
        if (client) {
          const toClose = client;
          client = undefined;
          await toClose.close().catch(() => { toClose.terminate(); });
        }
      };

      try {
        assertRunning();
        const cwd = workspaceOverride || this.options.workspacePath;
        const sessionDir = this.store.sessionDirFor(sessionKey);
        await untilAborted(mkdir(sessionDir, { recursive: true }), startSignal);
        assertRunning();

        const extraArgs: string[] = [];
        let env: NodeJS.ProcessEnv = { ...this.options.childEnv };

        if (this.bridgeExtensionPath !== null || this.options.openBridgeFn) {
          const openBridge = this.options.openBridgeFn ?? openOmpBridgeEndpoint;
          let bridgeAbandoned = false;
          try {
            const bridgePromise = openBridge({
              stateDir: this.options.stateDir,
              initial: { gate: true },
              handler: {
                approve: async (req, reqSignal) => {
                  if (!workerRef) return { allow: false, reason: "The omp session is still starting." };
                  return this.requestToolApproval(workerRef, req, reqSignal);
                },
              },
            });
            // If openBridge resolves after startSignal aborted or failed, dispose immediately so no socket leaks.
            void bridgePromise.then(ep => { if (bridgeAbandoned) ep.dispose(); }, () => {});
            const openedEndpoint = await untilAborted(bridgePromise, startSignal);
            endpoint = openedEndpoint;
            env = { ...env, ...endpoint.env };
            if (this.bridgeExtensionPath) extraArgs.push("--extension", this.bridgeExtensionPath);
          } catch (bridgeError) {
            bridgeAbandoned = true;
            endpoint?.dispose();
            endpoint = undefined;
            if (this.destroyed || signal?.aborted) throw bridgeError;
            // If bridge socket cannot open, worker starts without bridge; normal mode will fail closed in applyGate.
          }
        }
        assertRunning();

        client = await OmpRpcClient.start({
          launch: this.options.launch,
          cwd,
          env,
          mode: "rpc-ui",
          ...(extraArgs.length ? { args: extraArgs } : {}),
          startupTimeoutMs: this.options.startupTimeoutMs,
          signal: startSignal,
          ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
          ...(this.options.killProcessTreeFn ? { killProcessTreeFn: this.options.killProcessTreeFn } : {}),
        });
        assertRunning();

        const initialState = await untilAborted(client.getState(), startSignal);
        assertRunning();

        const worker: OmpWorker = {
          sessionKey,
          sessionDir,
          cwd,
          client,
          ...(endpoint ? { endpoint } : {}),
          state: initialState,
          appliedModelOverride: false,
          appliedEffortOverride: false,
          queue: { steering: [], followUp: [] },
          subagents: new Map(),
          activeBtw: new Map(),
          bufferedBtwDeltas: new Map(),
          completedBtw: new Map(),
          hostToolCalls: new Map(),
          pendingUi: new Map(),
          lastUsedAt: Date.now(),
          closed: false,
        };
        workerRef = worker;
        if (endpoint) {
          worker.bridgePromise = endpoint.connection.then(conn => {
            worker.bridge = conn;
            return conn;
          });
          worker.bridgePromise.catch(() => {});
        }

        // Subscribe to native OMP subagents and enable structured ask dialogs.
        await untilAborted(client.setSubagentSubscription("events").catch(() => undefined), startSignal);
        assertRunning();
        await untilAborted(client.setAskDialog(true).catch(() => undefined), startSignal);
        assertRunning();

        // Keep the worker on the requested file or the conversation's own directory.
        const boundPath = await untilAborted(this.store.resolvePersistedSessionFile(sessionKey), startSignal);
        assertRunning();
        const binding = await untilAborted(boundPath ? client.switchSession(boundPath) : client.openSession(sessionDir), startSignal);
        assertRunning();
        if (binding.cancelled) throw new Error("omp cancelled opening the conversation session");

        worker.state = await untilAborted(client.getState(), startSignal);
        assertRunning();
        if (boundPath && (!worker.state.sessionFile || path.resolve(worker.state.sessionFile) !== path.resolve(boundPath))) {
          throw new Error("omp did not open the requested conversation session");
        }
        if (worker.state.sessionFile) {
          await untilAborted(this.store.setRecord(sessionKey, { sessionFile: worker.state.sessionFile, cwd }).catch(() => undefined), startSignal);
          assertRunning();
        }
        if (!client.alive) {
          throw new Error("omp process exited during startup");
        }
        if (worker.state.model?.provider && worker.state.model?.id) {
          worker.initialModel = { provider: worker.state.model.provider, modelId: worker.state.model.id };
        }
        if (typeof worker.state.thinkingLevel === "string" && worker.state.thinkingLevel) {
          worker.initialThinkingLevel = worker.state.thinkingLevel;
        }
        if (worker.state.goal !== undefined) {
          worker.lastGoal = unwrapOmpGoal(worker.state.goal).record;
        }

        client.onEvent((event) => this.handleEvent(worker, event));
        client.onPromptResult((frame) => this.handlePromptResult(worker, frame));
        client.onSessionSettled(() => this.handleSessionSettled(worker));
        client.onQueueUpdate((frame) => {
          worker.queue = { steering: [...(frame.steering ?? [])], followUp: [...(frame.followUp ?? [])] };
          if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn);
        });
        client.onSubagentLifecycle((frame) => this.handleSubagentLifecycle(worker, frame));
        client.onSubagentProgress((frame) => this.handleSubagentProgress(worker, frame));
        client.onSubagentEvent((frame) => this.handleSubagentEvent(worker, frame));
        client.onBtwRecord((frame) => this.handleBtwRecord(worker, frame.record));
        client.onBtwDelta((frame) => this.handleBtwDelta(worker, frame.recordId, frame.delta));
        client.onExtensionUi((request) => { void this.handleExtensionUi(worker, request); });
        client.onCommandsUpdate((frame) => this.updateAdvertisedCommands(frame.commands));
        client.onHostToolCall((frame) => { void this.handleHostToolCall(worker, frame); });
        client.onHostToolCancel((frame) => this.handleHostToolCancel(worker, frame));
        client.onGoalUpdated((frame) => this.handleGoalUpdated(worker, frame));

        void client.exited.then((exit) => {
          worker.closed = true;
          worker.endpoint?.dispose();
          if (this.workers.get(sessionKey) === worker) this.workers.delete(sessionKey);
          for (const [, ac] of worker.hostToolCalls) ac.abort();
          worker.hostToolCalls.clear();
          for (const [, ac] of worker.pendingUi) ac.abort();
          worker.pendingUi.clear();
          if (worker.activeTurn && !worker.activeTurn.settled) {
            const turn = worker.activeTurn;
            this.settlePendingSteers(turn, "dropped", "engine_exit");
            this.clearTurnTimers(turn);
            turn.abortScope.abort();
            turn.settled = true;
            worker.activeTurn = undefined;
            const err = exit.fatalError ?? new Error("omp process exited unexpectedly before turn settled");
            turn.reject(withFailedTurnUsage(err, this.turnUsage(turn)));
          }
          if (worker.goalWatcher && !worker.goalWatcher.settled) {
            const watcher = worker.goalWatcher;
            watcher.settled = true;
            worker.goalWatcher = undefined;
            watcher.reject(exit.fatalError ?? new Error("omp process exited while watching goal"));
          }
          for (const [id, waiter] of worker.activeBtw) {
            worker.activeBtw.delete(id);
            waiter.reject(exit.fatalError ?? new Error("omp process exited during side question"));
          }
          worker.bufferedBtwDeltas.clear();
        });

        // Final synchronous check right before registering so destroy() can never race past registration.
        assertRunning();
        this.workers.set(sessionKey, worker);
        registered = true;
        void client.getAvailableCommands().then(res => {
          if (!this.destroyed && !worker.closed) this.updateAdvertisedCommands(res.commands);
        }).catch(() => undefined);
        return worker;
      } catch (error) {
        if (!registered) {
          await discard();
        }
        if (this.destroyed) throw destroyedError();
        if (signal?.aborted) throw abortError();
        throw error;
      }
    })();

    this.starting.set(sessionKey, work);
    try {
      return await work;
    } finally {
      if (this.starting.get(sessionKey) === work) this.starting.delete(sessionKey);
    }
  }

  private async loadRuntimeConfig(engineOverride?: EngineOverride): Promise<{
    gate: boolean;
    model?: string;
    effort?: EffortLevel;
  }> {
    let botModel: string | undefined;
    let botEffort: string | undefined;
    let approvalMode = DEFAULT_APPROVAL_MODE;
    if (this.options.configPath) {
      const cfg = await readValidatedConfigFile(this.options.configPath, { forExecution: true });
      approvalMode = resolveApprovalModeForEngine("omp", cfg.approvalMode);
      botModel = typeof cfg.model === "string" && cfg.model.trim() ? cfg.model.trim() : undefined;
      botEffort = typeof cfg.effort === "string" && cfg.effort.trim() ? cfg.effort.trim() : undefined;
    }
    const effective = resolveEngineOverride("omp", { model: botModel, effort: botEffort }, engineOverride);
    return {
      gate: approvalMode !== "bypass",
      ...(effective.model ? { model: effective.model } : {}),
      ...(effective.effort ? { effort: effective.effort as EffortLevel } : {}),
    };
  }

  private async applyGate(worker: OmpWorker, gate: boolean, hostToolNames: string[]): Promise<void> {
    if (gate && !worker.bridge?.isOpen && worker.bridgePromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await untilAborted(
          Promise.race([
            worker.bridgePromise.catch(() => undefined),
            new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref?.(); }),
          ]),
          this.retiring.signal,
        );
      } catch (error) {
        if (this.destroyed || worker.closed) throw destroyedError();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (this.destroyed || worker.closed) throw destroyedError();
    if (gate && !worker.bridge?.isOpen) {
      throw new Error(
        "omp tool approval is unavailable for this session (the TaroBird approval bridge did not connect), so the turn was not started. Start a new conversation or restart the Bot to connect it again. Native access (bypass) also starts the turn, but then omp runs tools without asking.",
      );
    }
    const hostKey = JSON.stringify(hostToolNames);
    if (worker.gate === gate && worker.bridgeHostToolsKey === hostKey) return;
    if (worker.bridge?.isOpen) {
      await worker.bridge.setPolicy(gate, hostToolNames);
    }
    if (this.destroyed || worker.closed) throw destroyedError();
    worker.gate = gate;
    worker.bridgeHostToolsKey = hostKey;
  }

  private async requestToolApproval(
    worker: OmpWorker,
    req: OmpBridgeApproveRequest,
    signal: AbortSignal,
  ): Promise<{ allow: boolean; reason?: string }> {
    const name = req.toolName;
    const origin = req.origin ?? "other";
    // A name alone proves nothing: an extension may register its own `read` or `grep`.
    // Only verified built-in tools pass auto-approval unasked (matching Pi adapter).
    if (origin === "builtin" && AUTO_ALLOWED_TOOLS.has(name)) return { allow: true };
    if (worker.activeAppTools?.definitions.some(def => def.name === name)) return { allow: true };
    const grants = this.grants.get(worker.sessionKey);
    // A session grant covers the tool origin it was granted for, not a look-alike from another source.
    const grantKey = `${origin}:${name}`;
    if (grants?.has(grantKey)) return { allow: true };

    const turn = worker.activeTurn && !worker.activeTurn.settled ? worker.activeTurn : undefined;
    const ask = turn?.input.onApprovalRequest ?? (worker.goalWatcher && !worker.goalWatcher.settled ? worker.goalWatcher.onApprovalRequest : undefined);
    if (!ask || turn?.aborting) {
      return { allow: false, reason: "No one is available to approve this tool call." };
    }
    const signals = [signal, ...(turn ? [turn.abortScope.signal] : []), ...(worker.goalWatcher?.abortSignal ? [worker.goalWatcher.abortSignal] : [])];
    const abortSignal = AbortSignal.any(signals);
    if (turn) turn.humanWaits++;
    let decision: EngineApprovalDecision = { behavior: "deny" };
    try {
      const emit = this.currentEventEmitter(worker);
      if (emit) {
        await emit({ type: "permission_request", toolName: name, toolInput: req.input, toolUseId: req.toolCallId, sessionId: worker.sessionKey });
      }
      decision = await ask({
        engine: "omp",
        toolName: name,
        toolInput: req.input,
        cwd: worker.cwd,
        sessionId: worker.sessionKey,
        abortSignal,
        approvalScopes: { once: "once", session: "session" },
      });
    } catch {
      decision = { behavior: "deny" };
    } finally {
      if (turn) {
        turn.humanWaits = Math.max(0, turn.humanWaits - 1);
        this.noteActivity(worker, turn);
      }
    }
    if (abortSignal.aborted || decision.behavior !== "allow") {
      return { allow: false, reason: abortSignal.aborted ? "Cancelled" : "Denied by the owner" };
    }
    if (decision.scope === "session") {
      const set = grants ?? new Set<string>();
      this.grants.set(worker.sessionKey, set);
      set.add(grantKey);
      while (set.size > SESSION_GRANT_LIMIT) set.delete(set.values().next().value!);
    }
    return { allow: true };
  }

  private async syncConfigToWorker(worker: OmpWorker, runtime: { model?: string; effort?: EffortLevel }): Promise<void> {
    const { model, effort } = runtime;
    if (effort) {
      const errMsg = getEngineEffortValidationError("omp", effort, model);
      if (errMsg) throw unsupportedEngineEffortError("omp", effort, model);
    }

    if (model) {
      const decoded = decodePiModel(model);
      if (!decoded) {
        throw new Error(`Invalid model selection: ${model} is not available in omp.`);
      }
      if (worker.state.model?.provider !== decoded.provider || worker.state.model?.id !== decoded.modelId) {
        worker.state.model = await worker.client.setModel(decoded.provider, decoded.modelId, effort);
      }
      worker.appliedModelOverride = true;
    } else if (worker.appliedModelOverride) {
      if (worker.initialModel && (worker.state.model?.provider !== worker.initialModel.provider || worker.state.model?.id !== worker.initialModel.modelId)) {
        worker.state.model = await worker.client.setModel(worker.initialModel.provider, worker.initialModel.modelId);
      }
      worker.appliedModelOverride = false;
    }

    if (effort) {
      if (!(PI_THINKING_LEVELS as readonly string[]).includes(effort)) {
        throw unsupportedEngineEffortError("omp", effort, model);
      }
      if (worker.state.thinkingLevel !== effort) {
        await worker.client.setThinkingLevel(effort);
        worker.state.thinkingLevel = effort as OmpSessionState["thinkingLevel"];
      }
      worker.appliedEffortOverride = true;
    } else if (worker.appliedEffortOverride) {
      if (worker.initialThinkingLevel && worker.state.thinkingLevel !== worker.initialThinkingLevel) {
        await worker.client.setThinkingLevel(worker.initialThinkingLevel);
        worker.state.thinkingLevel = worker.initialThinkingLevel as OmpSessionState["thinkingLevel"];
      }
      worker.appliedEffortOverride = false;
    }
  }

  private async syncHostTools(worker: OmpWorker, sessionId: string, tools: AppPlatformTools | undefined): Promise<{ registered: boolean; toolNames: string[] }> {
    if (!tools || tools.definitions.length === 0) {
      worker.activeAppTools = undefined;
      if (worker.registeredHostToolsKey !== undefined) {
        await worker.client.setHostTools([]).catch(() => undefined);
        worker.registeredHostToolsKey = undefined;
      }
      return { registered: false, toolNames: [] };
    }
    const resolvedTools = (await tools.forSession?.(sessionId)) ?? tools;
    const key = JSON.stringify(resolvedTools.definitions.map(d => [d.name, d.description, d.inputSchema]));
    const toolNames = resolvedTools.definitions.map(d => d.name);
    worker.activeAppTools = resolvedTools;
    if (worker.registeredHostToolsKey !== key) {
      try {
        await worker.client.setHostTools(resolvedTools.definitions.map(def => ({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: def.inputSchema,
          loadMode: "essential",
        })));
        worker.registeredHostToolsKey = key;
      } catch {
        worker.activeAppTools = undefined;
        return { registered: false, toolNames: [] };
      }
    }
    if (!await resolvedTools.isRegistered(sessionId).catch(() => false)) {
      await resolvedTools.register(sessionId).catch(() => undefined);
    }
    return { registered: true, toolNames };
  }

  private async handleHostToolCall(worker: OmpWorker, frame: OmpHostToolCallFrame): Promise<void> {
    if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn);
    const tools = worker.activeAppTools ?? worker.activeTurn?.input.appPlatformTools;
    if (!tools) {
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        isError: true,
        result: { content: [{ type: "text", text: `Host tool "${frame.toolName}" is not available in this turn.` }] },
      });
      return;
    }
    const controller = new AbortController();
    worker.hostToolCalls.set(frame.id, controller);
    try {
      const outcome = await tools.call({
        name: frame.toolName,
        arguments: frame.arguments ?? {},
        callId: frame.toolCallId || frame.id,
        sessionId: worker.sessionKey,
        abortSignal: controller.signal,
        onActivity: () => { if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn); },
      });
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        ...(outcome.isError ? { isError: true } : {}),
        result: { content: [{ type: "text", text: outcome.text }] },
      });
    } catch (error) {
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        isError: true,
        result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
      });
    } finally {
      worker.hostToolCalls.delete(frame.id);
    }
  }

  private handleHostToolCancel(worker: OmpWorker, frame: OmpHostToolCancelFrame): void {
    const ac = worker.hostToolCalls.get(frame.targetId);
    if (ac) {
      ac.abort();
      worker.hostToolCalls.delete(frame.targetId);
    }
  }

  private turnUsage(turn: ActiveOmpTurn): AdapterUsage | undefined {
    if (!turn.usage.hasData) return undefined;
    return {
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      ...(turn.usage.cachedTokens > 0 ? { cachedTokens: turn.usage.cachedTokens } : {}),
      ...(turn.usage.costUsd > 0 ? { costUsd: turn.usage.costUsd } : {}),
    };
  }

  private clearTurnTimers(turn: ActiveOmpTurn): void {
    if (turn.inactivityTimer) { clearTimeout(turn.inactivityTimer); turn.inactivityTimer = undefined; }
    if (turn.cancelTimer) { clearTimeout(turn.cancelTimer); turn.cancelTimer = undefined; }
  }

  private noteActivity(worker: OmpWorker, turn: ActiveOmpTurn): void {
    worker.lastUsedAt = Date.now();
    if (turn.inactivityTimer) { clearTimeout(turn.inactivityTimer); turn.inactivityTimer = undefined; }
    const limit = this.inactivityTimeoutMs;
    if (!limit || turn.input.disableRuntimeTimeout || turn.settled || turn.finalizing || turn.aborting) return;
    turn.inactivityTimer = setTimeout(() => {
      if (turn.settled || turn.finalizing || turn.aborting) return;
      if (turn.humanWaits > 0) { this.noteActivity(worker, turn); return; }
      turn.timedOut = `omp turn became inactive after ${minutesLabel(limit)}`;
      this.abortActiveTurn(worker, turn);
    }, limit);
    turn.inactivityTimer.unref?.();
  }

  private settlePendingSteers(
    turn: ActiveOmpTurn,
    status: "applied" | "dropped",
    reason?: "stopped" | "turn_failed" | "not_started" | "engine_exit",
  ): void {
    for (const steer of turn.pendingSteers) {
      if (steer.settled || (status === "dropped" && !steer.confirmed)) continue;
      steer.settled = true;
      if (status === "applied") {
        steer.onOutcome?.({ status: "applied", via: "fold" });
      } else {
        steer.onOutcome?.({ status: "dropped", reason: reason ?? "stopped" });
      }
    }
  }

  private abortActiveTurn(worker: OmpWorker, turn: ActiveOmpTurn): void {
    if (turn.settled || turn.aborting) return;
    turn.aborting = true;
    this.clearTurnTimers(turn);
    turn.abortScope.abort();
    for (const [id, ac] of worker.pendingUi) {
      ac.abort();
      worker.pendingUi.delete(id);
      worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id, cancelled: true });
    }
    this.settlePendingSteers(turn, "dropped", "stopped");
    void worker.client.abortAndRestoreQueue().catch((error) => {
      if (error instanceof OmpRpcCommandError) {
        return worker.client.abort().catch(() => undefined);
      }
      return undefined;
    });
    const grace = this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    turn.cancelTimer = setTimeout(() => {
      if (!turn.settled) {
        turn.settled = true;
        if (worker.activeTurn === turn) worker.activeTurn = undefined;
        worker.client.terminate();
        const err = turn.timedOut ? new Error(turn.timedOut) : abortError("Turn aborted");
        turn.reject(withFailedTurnUsage(err, this.turnUsage(turn)));
      }
    }, grace);
    turn.cancelTimer.unref?.();
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    if (this.destroyed) throw destroyedError();
    throwIfAborted(input.abortSignal);
    const runtime = await this.loadRuntimeConfig(input.engineOverride);
    if (this.destroyed) throw destroyedError();
    throwIfAborted(input.abortSignal);

    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride, input.abortSignal);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);
    if (worker.activeTurn) {
      throw new Error("omp session already has an in-flight turn");
    }

    await this.syncConfigToWorker(worker, runtime);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);
    const { registered: hostToolsRegistered, toolNames } = await this.syncHostTools(worker, sessionId, input.appPlatformTools);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);
    await this.applyGate(worker, runtime.gate, toolNames);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);

    // Check authorized owner-typed slash commands (never from Bot messages, cron, or turns with files).
    const authored = input.files.length === 0 ? (input.authoredText ?? "").trim() : "";
    const slashCmd = authored ? parsePiSlashCommand(authored) : undefined;
    if (slashCmd && slashCmd.name.toLowerCase() === "compact") {
      return this.runCompactTurn(worker, sessionId, input, slashCmd.args || undefined);
    }
    const isAuthorizedOmpSlash = Boolean(slashCmd && this.isAdvertisedCommand(slashCmd.name));

    const modelAcceptsImages = Boolean(worker.state.model?.input?.includes("image"));
    const { images, extraFiles, skippedImages } = await prepareAttachments(input.files ?? [], modelAcceptsImages);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);

    if (skippedImages.length > 0 && input.onEngineEvent) {
      const notice = piSkippedImagesNotice(skippedImages, input.locale);
      if (notice) {
        await input.onEngineEvent({ type: "assistant_text", text: `[omp] ${notice}`, sessionId });
      }
    }
    if (this.destroyed || worker.closed) throw destroyedError();

    let promptText: string;
    if (isAuthorizedOmpSlash) {
      // Send authorized omp slash command bare so omp dispatches it instead of reading private instructions prefix.
      promptText = authored;
    } else {
      const baseText = extraFiles.length > 0
        ? `${input.text}\n\nAttached files:\n${extraFiles.map(f => `- ${f}`).join("\n")}`
        : input.text;
      const combinedInstructions = [
        hostToolsRegistered ? input.appPlatformTools?.instructions : input.instructions,
        hostToolsRegistered ? input.appPlatformTools?.turnInstructions : undefined,
        input.turnInstructions,
      ].filter((part): part is string => !!part && part.trim().length > 0).join("\n\n");
      promptText = prependPrivateTurnInstructions(baseText, combinedInstructions || undefined);
      // Escape ordinary prose starting with "/" so omp never mistakes paths like "/etc/hosts" for slash commands.
      if (promptText.startsWith("/")) {
        promptText = `\n${promptText}`;
      }
    }

    // Take the history boundary before sending the prompt. OMP can append
    // assistant entries before a read issued from message_start is answered.
    let historyInput: OmpHistoryInput | undefined;
    if (input.onEngineEvent && !isAuthorizedOmpSlash) {
      const before = await worker.client.command<{ entries: OmpSessionEntry[]; leafId: string | null }>({ type: "get_entries" }, 1500)
        .then(r => r.data).catch(() => undefined);
      if (Array.isArray(before?.entries) && (before.leafId === null || activeEntryBranch(before.entries, before.leafId).length > 0)) {
        historyInput = { promptText, previousLeaf: before.leafId, previousIds: new Set(before.entries.map(entry => entry.id)) };
      }
    }
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal);
    if (worker.activeTurn) {
      throw new Error("omp session already has an in-flight turn");
    }

    return new Promise<CodexAdapterResponse>((resolve, reject) => {
      const promptId = worker.client.nextId("prompt");
      const abortScope = new AbortController();
      const turn: ActiveOmpTurn = {
        promptId,
        input,
        historyInput,
        textChunks: [],
        thinkingChunks: [],
        commandOutputs: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, hasData: false },
        settled: false,
        finalizing: false,
        aborting: false,
        pendingSteers: [],
        humanWaits: 0,
        abortScope,
        resolve,
        reject,
      };
      worker.activeTurn = turn;
      this.noteActivity(worker, turn);

      const onAbort = () => this.abortActiveTurn(worker, turn);
      const cleanupAbort = () => {
        this.clearTurnTimers(turn);
        input.abortSignal?.removeEventListener("abort", onAbort);
      };
      const origResolve = turn.resolve;
      const origReject = turn.reject;
      turn.resolve = (res) => { cleanupAbort(); origResolve(res); };
      turn.reject = (err) => { cleanupAbort(); origReject(err); };

      if (input.abortSignal?.aborted) {
        this.abortActiveTurn(worker, turn);
        return;
      }
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });

      void worker.client.prompt(promptText, images.length > 0 ? images : undefined, undefined, promptId).then(
        ({ data }) => {
          // Synchronous local slash command completed without invoking agent.
          if (data?.agentInvoked === false && !turn.settled && !turn.finalizing) {
            turn.settled = true;
            this.settlePendingSteers(turn, "dropped", "not_started");
            if (worker.activeTurn === turn) worker.activeTurn = undefined;
            worker.lastUsedAt = Date.now();
            const text = turn.commandOutputs.join("\n").trim() || "";
            turn.resolve({ sessionId, text });
            return;
          }
          if (turn.promptResult) this.maybeCompleteTurn(worker, turn);
        },
        (error) => {
          if (!turn.settled && !turn.finalizing) {
            turn.settled = true;
            this.settlePendingSteers(turn, "dropped", "turn_failed");
            if (worker.activeTurn === turn) worker.activeTurn = undefined;
            const err = error instanceof Error ? error : new Error(String(error));
            turn.reject(withFailedTurnUsage(err, this.turnUsage(turn)));
          }
        },
      );
    });
  }

  private async runCompactTurn(
    worker: OmpWorker,
    sessionId: string,
    input: CodexUserMessageInput,
    customInstructions?: string,
  ): Promise<CodexAdapterResponse> {
    throwIfAborted(input.abortSignal);
    if (worker.activeTurn) throw new Error("omp session already has an in-flight turn");
    const abortScope = new AbortController();
    const turn: ActiveOmpTurn = {
      input,
      textChunks: [],
      thinkingChunks: [],
      commandOutputs: [],
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, hasData: false },
      settled: false,
      finalizing: false,
      aborting: false,
      pendingSteers: [],
      humanWaits: 0,
      abortScope,
      resolve: () => {},
      reject: () => {},
    };
    worker.activeTurn = turn;
    const onAbort = () => {
      turn.aborting = true;
      abortScope.abort();
      void worker.client.abortAndRestoreQueue().catch(() => worker.client.abort().catch(() => undefined));
    };
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await worker.client.compact(customInstructions);
      throwIfAborted(input.abortSignal);
      const summary = typeof result === "object" && result && typeof (result as { summary?: unknown }).summary === "string"
        ? (result as { summary: string }).summary.trim()
        : "";
      const fallback = input.locale === "zh" ? "上下文已压缩。" : "Context compacted.";
      const text = (turn.commandOutputs.join("\n").trim() || summary || fallback);
      return { sessionId, text };
    } finally {
      input.abortSignal?.removeEventListener("abort", onAbort);
      this.clearTurnTimers(turn);
      turn.settled = true;
      if (worker.activeTurn === turn) worker.activeTurn = undefined;
      worker.lastUsedAt = Date.now();
    }
  }

  /** Native CodexAdapter mid-turn steering (aligned with Codex, Claude, and Pi). */
  async steerActiveTurn(
    sessionId: string,
    input: { text: string; throwOnError?: boolean; onOutcome?: (outcome: SteeringApplication) => void },
  ): Promise<boolean> {
    const reject = (reason: EngineSteeringRejectedError["reason"]): boolean => {
      if (input.throwOnError) throw new EngineSteeringRejectedError(reason);
      return false;
    };
    if (this.destroyed) return reject("stale");
    const worker = this.workers.get(sessionId);
    const turn = worker?.activeTurn;
    if (!worker || worker.closed || !worker.client.alive || !turn || turn.settled || turn.finalizing || turn.aborting) {
      return reject("stale");
    }
    if (!turn.sessionPublication) return reject("not_ready");
    const text = input.text.trim();
    if (!text) return reject("not_ready");

    const history = turn.historyInput;
    if (history && history.userEvent === undefined && history.promptText.trim() === text) {
      history.userEvent = null;
    }
    const entry: PendingSteer = { text: input.text, onOutcome: input.onOutcome, confirmed: false, settled: false };
    // Register before awaiting steer() so a synchronous message_start arriving in the same stdout chunk is never missed.
    turn.pendingSteers.push(entry);
    try {
      await worker.client.steer(input.text);
      entry.confirmed = true;
      if (entry.settled) return true;
      if (turn.settled || turn.aborting) {
        entry.settled = true;
        entry.onOutcome?.({ status: "dropped", reason: turn.aborting ? "stopped" : "not_started" });
        return false;
      }
      return true;
    } catch (error) {
      const idx = turn.pendingSteers.indexOf(entry);
      if (idx >= 0) turn.pendingSteers.splice(idx, 1);
      if (error instanceof OmpRpcCommandError) {
        const reason = error.code === "session_idle" || error.code === "no_active_turn" ? "stale" : "not_ready";
        return reject(reason);
      }
      if (input.throwOnError) throw error;
      if (!entry.settled) {
        entry.settled = true;
        input.onOutcome?.({ status: "dropped", reason: "turn_failed" });
      }
      return false;
    }
  }

  /** Queue 1: Steer an active OMP turn natively. */
  async steerSession(sessionId: string, message: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.closed || !worker.client.alive) throw new Error("omp session is not active");
    await worker.client.steer(message);
  }

  /** Queue 2: Enqueue a follow-up message natively into OMP's follow-up queue. */
  async followUpSession(sessionId: string, message: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.closed || !worker.client.alive) throw new Error("omp session is not active");
    await worker.client.followUp(message);
  }

  /** Queue 3: Ask an ephemeral side question (`aside` via OMP's native `/btw` command). */
  async askAside(sessionId: string, question: string, options: { recordId?: string; onDelta?: (delta: string) => void; signal?: AbortSignal; workspaceOverride?: string } = {}): Promise<OmpBtwRecord> {
    throwIfAborted(options.signal, "Side question aborted");
    const worker = await this.ensureWorkerForExistingSession(sessionId, options.workspaceOverride, options.signal);
    throwIfAborted(options.signal, "Side question aborted");
    if (!worker) throw new Error("no_main_session");

    const { record } = await worker.client.btw(question, options.recordId);
    worker.lastUsedAt = Date.now();

    // Flush any early btw_delta chunks that arrived while `btw` response was in flight.
    const earlyDeltas = worker.bufferedBtwDeltas.get(record.id);
    let streamed = "";
    if (earlyDeltas) {
      worker.bufferedBtwDeltas.delete(record.id);
      streamed = earlyDeltas.join("");
      if (options.onDelta) {
        for (const chunk of earlyDeltas) options.onDelta(chunk);
      }
    }
    const withStreamedAnswer = (rec: OmpBtwRecord): OmpBtwRecord => {
      if (!streamed) return rec;
      if (rec.followUps && rec.followUps.length > 0) {
        const last = rec.followUps[rec.followUps.length - 1]!;
        if (last.answer) return rec;
        return { ...rec, followUps: [...rec.followUps.slice(0, -1), { ...last, answer: streamed }] };
      }
      return rec.answer ? rec : { ...rec, answer: streamed };
    };

    if (options.signal?.aborted) {
      void worker.client.btwCancel(record.id).catch(() => undefined);
      throw abortError("Side question aborted");
    }

    const settled = worker.completedBtw.get(record.id) ?? record;
    const latest = settled.followUps?.at(-1) ?? settled;
    if (latest.status === "complete") { worker.completedBtw.delete(record.id); return withStreamedAnswer(settled); }
    if (latest.status === "cancelled") { worker.completedBtw.delete(record.id); throw new Error("Side question cancelled"); }
    if (latest.status === "error") { worker.completedBtw.delete(record.id); throw new Error(latest.error || "Side question failed"); }

    return new Promise<OmpBtwRecord>((resolve, reject) => {
      const onAbort = () => {
        void worker.client.btwCancel(record.id).catch(() => undefined);
      };
      if (options.signal?.aborted) {
        onAbort();
        reject(abortError("Side question aborted"));
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      worker.activeBtw.set(record.id, {
        onDelta: (delta) => {
          streamed += delta;
          options.onDelta?.(delta);
        },
        resolve: (done) => { options.signal?.removeEventListener("abort", onAbort); resolve(withStreamedAnswer(done)); },
        reject: (err) => { options.signal?.removeEventListener("abort", onAbort); reject(err); },
      });
    });
  }

  sideCapability(): SideCapability {
    return { context: "native", concurrent: true, seesInProgressTurn: true, readOnly: "no-tools", residue: "none" };
  }

  async openSideSession(input: {
    sourceSessionId: string;
    tools?: "inherited";
    workspaceOverride?: string;
    locale?: Locale;
    abortSignal?: AbortSignal;
  }): Promise<EngineSideSession> {
    const sessionKey = input.sourceSessionId;
    if (!await this.ensureWorkerForExistingSession(sessionKey, input.workspaceOverride, input.abortSignal)) {
      throw new Error("no_main_session");
    }
    let recordId: string | undefined;
    const nativeId = `omp_btw_${randomUUID()}`;
    return {
      nativeId,
      send: async (req) => {
        const record = await this.askAside(sessionKey, req.text, {
          recordId,
          workspaceOverride: input.workspaceOverride,
          signal: req.abortSignal,
          onDelta: (delta) => { void req.onEngineEvent({ type: "assistant_text", text: delta, delta: true }); },
        });
        recordId = record.id;
        const latestTurn = record.followUps?.at(-1) ?? record;
        return { text: latestTurn.answer };
      },
      dispose: async () => {
        const worker = this.workers.get(sessionKey);
        if (recordId && worker?.client.alive) await worker.client.btwCancel(recordId).catch(() => undefined);
      },
    };
  }

  /** Native history state (works across restarts by attaching persisted sessions on demand). */
  async getHistoryState(sessionId: string, input: { workspaceOverride?: string; signal?: AbortSignal } = {}): Promise<NativeHistoryState> {
    if (this.destroyed) return { head: null, blocked: "not_ready" };
    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride, input.signal).catch(() => undefined);
    if (!worker || !worker.client.alive) {
      return { head: null, blocked: "source_missing" };
    }
    if (worker.activeTurn && !worker.activeTurn.settled) {
      return { head: null, blocked: "busy" };
    }
    if (worker.goalWatcher && !worker.goalWatcher.settled) {
      return { head: null, blocked: "goal_active" };
    }
    try {
      const [state, entriesRes] = await Promise.all([worker.client.getState(), worker.client.getEntries()]);
      worker.state = state;
      worker.lastUsedAt = Date.now();
      const busy = isOmpStateBusy(state) || worker.pendingUi.size > 0;
      const goal = toCodexThreadGoal(sessionId, state.goal);
      const goalActive = goal?.status === "active";
      const hasHistory = entriesRes.leafId !== null;
      return {
        fork: { whole: hasHistory, anchored: hasHistory },
        rewind: hasHistory,
        head: entriesRes.leafId ?? OMP_EMPTY_HISTORY_HEAD,
        ...(busy ? { blocked: "busy" as const } : goalActive ? { blocked: "goal_active" as const } : {}),
      };
    } catch {
      return { head: null, blocked: "not_ready" };
    }
  }

  /**
   * Non-destructive native fork using OMP's `fork` command.
   * For `forkBoundary: "after-turn"`, resolves the turn's terminal leaf entry ID (including
   * the assistant reply and tool results) before forking. Relocates the forked `.jsonl` file
   * into the fork's own directory and persists both mappings so restarts never lose the fork
   * or hijack the source conversation.
   */
  async forkHistory(sessionId: string, input: {
    anchor?: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  } = {}): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    if (input.signal?.aborted) return rejected("cancelled");
    const anchor = input.anchor;
    if (anchor && !anchor.fork) return rejected("anchor_unavailable", "Anchor does not support fork");
    if (anchor && anchor.sessionId !== sessionId) return rejected("anchor_unavailable", "Anchor belongs to another session");

    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride, input.signal).catch(() => undefined);
    if (!worker || !worker.client.alive) return rejected("source_missing", "No omp session found to fork");
    if (worker.activeTurn && !worker.activeTurn.settled) return rejected("busy");

    try {
      const [stateBefore, entriesRes] = await Promise.all([worker.client.getState(), worker.client.getEntries()]);
      if (isOmpStateBusy(stateBefore) || worker.pendingUi.size > 0) return rejected("busy");
      const currentHead = entriesRes.leafId ?? OMP_EMPTY_HISTORY_HEAD;
      if (input.expectedHead !== undefined && input.expectedHead !== currentHead) return rejected("source_changed");
      if (entriesRes.leafId === null) return rejected("not_ready", "Session has no history yet");

      let forkEntryId: string | undefined;
      let boundary: Extract<NativeHistoryResult, { outcome: "applied" }>["boundary"] = "whole";
      if (anchor) {
        const branch = activeEntryBranch(entriesRes.entries, entriesRes.leafId);
        const anchorIndex = branch.findIndex(entry => entry.id === anchor.inputId && isUserMessageEntry(entry));
        if (anchorIndex < 0) {
          return rejected("anchor_unavailable", "Anchor is not on the active branch");
        }
        boundary = anchor.forkBoundary ?? "after-turn";
        if (boundary === "after-turn") {
          const end = anchor.data?.forkLeafId;
          if (typeof end === "string" && branch.findIndex(entry => entry.id === end) <= anchorIndex) {
            return rejected("anchor_unavailable", "Anchor's turn end is not on the active branch");
          }
          forkEntryId = typeof end === "string" ? end : resolveAfterTurnLeafId(branch, anchorIndex);
        } else {
          forkEntryId = anchor.inputId;
        }
      }
      if (input.signal?.aborted) return rejected("cancelled");

      const originalSessionFile = stateBefore.sessionFile;
      if (!originalSessionFile) return rejected("source_missing", "omp did not identify the source session file");
      let forkAcknowledged = false;
      let forkedSessionFile: string | undefined;
      let candidateSessionId: string | undefined;
      try {
        const forkResult = await worker.client.fork(forkEntryId);
        if (forkResult.cancelled) return rejected("cancelled", "omp cancelled the fork");
        forkAcknowledged = true;

        const forkedState = await worker.client.getState();
        if (!forkedState.sessionFile || path.resolve(forkedState.sessionFile) === path.resolve(originalSessionFile)) {
          throw new Error("omp did not confirm a distinct fork session file");
        }
        forkedSessionFile = forkedState.sessionFile;
        const newSessionId = `omp_${randomUUID()}`;
        candidateSessionId = newSessionId;
        const forkedEntries = await worker.client.getEntries();

        // Restore the source worker before relocating the fork file.
        const switched = await worker.client.switchSession(originalSessionFile);
        if (switched.cancelled) throw new Error("omp cancelled switching back to the source session after fork");
        const restoredState = await worker.client.getState();
        if (!restoredState.sessionFile || path.resolve(restoredState.sessionFile) !== path.resolve(originalSessionFile)) {
          throw new Error("omp remained on the forked session instead of restoring the source session");
        }
        worker.state = restoredState;
        await this.store.setRecord(sessionId, { sessionFile: originalSessionFile, cwd: worker.cwd });

        const relocated = await this.store.relocateForkedFile(forkedSessionFile, worker.sessionDir, newSessionId);
        await this.store.setRecord(newSessionId, { sessionFile: relocated, cwd: worker.cwd });
        worker.lastUsedAt = Date.now();

        return {
          outcome: "applied",
          sessionId: newSessionId,
          head: forkedEntries.leafId,
          boundary,
        };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (!forkAcknowledged && (code === "session_busy" || code === "entry_not_found")) throw error;
        // The fork may have switched files even if its response was lost.
        await this.store.setRecord(sessionId, { sessionFile: originalSessionFile, cwd: worker.cwd }).catch(() => undefined);
        await this.closeWorker(worker);
        if (forkedSessionFile && candidateSessionId) {
          const relocated = await this.store.relocateForkedFile(forkedSessionFile, worker.sessionDir, candidateSessionId).catch(() => forkedSessionFile!);
          await this.store.setRecord(candidateSessionId, { sessionFile: relocated, cwd: worker.cwd }).catch(() => undefined);
        }
        return {
          outcome: "unknown",
          detail: error instanceof Error ? error.message : String(error),
          ...(candidateSessionId ? { candidateSessionId } : {}),
        };
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "session_busy") return rejected("busy");
      if (code === "entry_not_found") return rejected("anchor_unavailable");
      return rejected("not_ready", error instanceof Error ? error.message : String(error));
    }
  }

  /** Native in-place rewind via OMP's `navigate_tree` (aligned with Codex rewind). */
  async rewindHistory(sessionId: string, input: {
    anchor: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  }): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    if (input.signal?.aborted) return rejected("cancelled");
    if (!input.anchor.rewind || input.anchor.sessionId !== sessionId) return rejected("anchor_unavailable");

    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride, input.signal).catch(() => undefined);
    if (!worker || !worker.client.alive) return rejected("source_missing", "No omp session found to rewind");
    if (worker.activeTurn && !worker.activeTurn.settled) return rejected("busy");

    let rewindRequested = false;
    try {
      const [stateBefore, entriesBefore] = await Promise.all([worker.client.getState(), worker.client.getEntries()]);
      if (isOmpStateBusy(stateBefore) || worker.pendingUi.size > 0) return rejected("busy");
      const currentHead = entriesBefore.leafId ?? OMP_EMPTY_HISTORY_HEAD;
      if (input.expectedHead !== undefined && input.expectedHead !== currentHead) return rejected("source_changed");
      const branch = activeEntryBranch(entriesBefore.entries, entriesBefore.leafId);
      const anchorIndex = branch.findIndex(entry => entry.id === input.anchor.inputId && isUserMessageEntry(entry));
      if (anchorIndex < 0) return rejected("anchor_unavailable", "Anchor is not on the active branch");
      if (input.signal?.aborted) return rejected("cancelled");

      rewindRequested = true;
      const nav = await worker.client.navigateTree(input.anchor.inputId);
      if (nav.cancelled || nav.aborted) return rejected("cancelled", "omp cancelled navigate_tree");

      const entriesAfter = await worker.client.getEntries().catch(() => undefined);
      if (!entriesAfter || entriesAfter.leafId !== (branch[anchorIndex]!.parentId ?? null)) {
        return { outcome: "unknown", detail: "omp did not confirm the history position after rewind" };
      }
      worker.lastUsedAt = Date.now();
      const excludedInputIds = branch.slice(anchorIndex).filter(isUserMessageEntry).map(entry => entry.id);
      return {
        outcome: "applied",
        sessionId,
        head: entriesAfter.leafId,
        boundary: "before-input",
        excludedInputIds,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "session_busy") return rejected("busy");
      if (code === "entry_not_found") return rejected("anchor_unavailable");
      if (rewindRequested) return { outcome: "unknown", detail: error instanceof Error ? error.message : String(error) };
      return rejected("not_ready", error instanceof Error ? error.message : String(error));
    }
  }

  /** Native OMP Goal Mode (aligned with Codex thread goals, works across restarts). */
  async getThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<CodexThreadGoalResponse> {
    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride).catch(() => undefined);
    if (!worker || !worker.client.alive) return { goal: null };
    const res = await worker.client.goal("get");
    const unwrapped = unwrapOmpGoal(res.goal, res.state);
    worker.lastGoal = unwrapped.record;
    worker.lastUsedAt = Date.now();
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride);
    const res = await worker.client.goal("create", {
      objective: input.objective,
      ...(typeof input.tokenBudget === "number" && input.tokenBudget > 0 ? { token_budget: Math.round(input.tokenBudget) } : {}),
    });
    const unwrapped = unwrapOmpGoal(res.goal, res.state);
    worker.lastGoal = unwrapped.record;
    worker.lastUsedAt = Date.now();
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async updateThreadGoal(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    status?: CodexThreadGoal["status"];
    objective?: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride);
    if (input.isCurrentSession && !await input.isCurrentSession()) {
      throw new Error("Session changed before goal update");
    }
    // If editing objective or tokenBudget, recreate with updated fields while preserving paused status.
    if (input.objective !== undefined || input.tokenBudget !== undefined) {
      const before = await worker.client.goal("get");
      const current = toCodexThreadGoal(sessionId, before.goal, before.state);
      if (!current) return { goal: null, sessionId };
      const nextObjective = input.objective ?? current.objective;
      const nextBudget = input.tokenBudget !== undefined ? input.tokenBudget : current.tokenBudget;
      await worker.client.goal("drop").catch(() => undefined);
      let res = await worker.client.goal("create", {
        objective: nextObjective,
        ...(typeof nextBudget === "number" && nextBudget > 0 ? { token_budget: Math.round(nextBudget) } : {}),
      });
      if ((input.status ?? current.status) === "paused") {
        res = await worker.client.goal("pause");
      }
      worker.lastGoal = unwrapOmpGoal(res.goal, res.state).record;
      worker.lastUsedAt = Date.now();
      return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
    }
    const op = input.status === "paused" ? "pause" : input.status === "active" ? "resume" : "get";
    const res = await worker.client.goal(op);
    worker.lastGoal = unwrapOmpGoal(res.goal, res.state).record;
    worker.lastUsedAt = Date.now();
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async watchThreadGoal(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    mode?: "replace" | "resume" | "observe";
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: CodexUserMessageInput["onApprovalRequest"];
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    if (this.destroyed) throw destroyedError();
    throwIfAborted(input.abortSignal, "Goal watch aborted");
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride, input.abortSignal);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal, "Goal watch aborted");
    const runtime = await this.loadRuntimeConfig();
    if (this.destroyed || worker.closed) throw destroyedError();
    await this.syncConfigToWorker(worker, runtime);
    if (this.destroyed || worker.closed) throw destroyedError();
    await this.applyGate(worker, runtime.gate, []);
    if (this.destroyed || worker.closed) throw destroyedError();
    throwIfAborted(input.abortSignal, "Goal watch aborted");

    if (input.mode === "replace" || input.mode === undefined) {
      await worker.client.goal("drop").catch(() => undefined);
      await worker.client.goal("create", {
        objective: input.objective,
        ...(typeof input.tokenBudget === "number" && input.tokenBudget > 0 ? { token_budget: Math.round(input.tokenBudget) } : {}),
      });
    } else if (input.mode === "resume") {
      await worker.client.goal("resume");
    }
    throwIfAborted(input.abortSignal, "Goal watch aborted");

    const current = await worker.client.goal("get");
    const unwrapped = unwrapOmpGoal(current.goal, current.state);
    const mapped = toCodexThreadGoal(sessionId, current.goal, current.state);
    worker.lastGoal = unwrapped.record;
    await input.onEngineEvent?.({ type: "session", sessionId });

    if (!mapped || mapped.status !== "active") {
      return { goal: mapped, sessionId };
    }
    // Upstream omp only auto-continues RPC goals when goal.continuationModes includes "rpc".
    // Surface disabled RPC continuation explicitly instead of hanging forever.
    if (unwrapped.enabled === false && input.mode !== "observe") {
      const detail = unwrapped.reason ? ` (${unwrapped.reason})` : "";
      throw new OmpRpcCommandError(
        "goal",
        `omp RPC goal auto-continuation is disabled${detail}. Add "rpc" to goal.continuationModes in your omp config to run autonomous goals.`,
        "goal_continuation_disabled",
      );
    }

    if (input.abortSignal?.aborted) {
      const paused = await worker.client.goal("pause").catch(() => undefined);
      return { goal: paused ? toCodexThreadGoal(sessionId, paused.goal, paused.state) : { ...mapped, status: "paused" }, sessionId };
    }

    return new Promise<CodexThreadGoalResponse>((resolve, reject) => {
      const watcher: GoalWatcher = {
        abortSignal: input.abortSignal,
        onEngineEvent: input.onEngineEvent,
        onApprovalRequest: input.onApprovalRequest,
        resolve,
        reject,
        settled: false,
      };
      worker.goalWatcher = watcher;
      const onAbort = () => {
        if (watcher.settled) return;
        watcher.settled = true;
        if (worker.goalWatcher === watcher) worker.goalWatcher = undefined;
        void worker.client.abortAndRestoreQueue().catch(() => worker.client.abort().catch(() => undefined));
        void worker.client.goal("pause").then(
          res => resolve({ goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId }),
          () => resolve({ goal: { ...mapped, status: "paused" }, sessionId }),
        );
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const origResolve = watcher.resolve;
      const origReject = watcher.reject;
      watcher.resolve = (res) => { input.abortSignal?.removeEventListener("abort", onAbort); origResolve(res); };
      watcher.reject = (err) => { input.abortSignal?.removeEventListener("abort", onAbort); origReject(err); };
    });
  }

  async clearThreadGoal(sessionId: string, input: { workspaceOverride?: string; isCurrentSession?: () => boolean | Promise<boolean> } = {}): Promise<{ cleared: boolean; sessionId?: string }> {
    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride).catch(() => undefined);
    if (!worker || !worker.client.alive) return { cleared: false, sessionId };
    if (input.isCurrentSession && !await input.isCurrentSession()) return { cleared: false, sessionId };
    await worker.client.goal("drop");
    worker.lastGoal = null;
    worker.lastUsedAt = Date.now();
    if (worker.goalWatcher && !worker.goalWatcher.settled) {
      const watcher = worker.goalWatcher;
      watcher.settled = true;
      worker.goalWatcher = undefined;
      watcher.resolve({ goal: null, sessionId });
    }
    return { cleared: true, sessionId };
  }

  private handleGoalUpdated(worker: OmpWorker, frame: OmpGoalUpdatedFrame): void {
    const unwrapped = unwrapOmpGoal(frame.goal, frame.state);
    worker.lastGoal = unwrapped.record;
    const watcher = worker.goalWatcher;
    if (!watcher || watcher.settled) return;
    const mapped = toCodexThreadGoal(worker.sessionKey, frame.goal, frame.state);
    if (!mapped || mapped.status !== "active") {
      watcher.settled = true;
      worker.goalWatcher = undefined;
      watcher.resolve({ goal: mapped, sessionId: worker.sessionKey });
    }
  }

  /** External session scanning & validation (bot sessions + native `~/.omp/agent/sessions`). */
  async listExternalSessions(input: { cwd?: string; limit?: number } = {}): Promise<ExternalSessionInfo[]> {
    const sessions = await this.store.listSessions({
      defaultWorkspace: this.options.workspacePath,
      cwd: input.cwd,
      limit: input.limit,
    });
    return sessions.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title ? { title: s.title } : {}),
      updatedAt: s.updatedAt,
    }));
  }

  async validateExternalSession(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<ExternalSessionInfo | void> {
    const existingPath = await this.store.resolvePersistedSessionFile(sessionId);
    if (existingPath) {
      const st = await stat(existingPath).catch(() => null);
      if (st?.isFile()) {
        const rec = await this.store.getRecord(sessionId);
        return {
          sessionId,
          cwd: rec?.cwd || input.workspaceOverride || this.options.workspacePath,
          ...(rec?.title ? { title: rec.title } : {}),
          updatedAt: st.mtime.toISOString(),
        };
      }
    }
    const listed = await this.store.listSessions({
      defaultWorkspace: this.options.workspacePath,
      cwd: input.workspaceOverride,
      limit: 200,
    });
    const match = listed.find(s => s.sessionId === sessionId);
    if (!match) throw new Error(`omp session not found: ${sessionId}`);
    await this.store.setRecord(sessionId, {
      sessionFile: match.path,
      cwd: match.cwd,
      ...(match.title ? { title: match.title } : {}),
      external: match.origin === "native",
    });
    return {
      sessionId: match.sessionId,
      cwd: match.cwd,
      ...(match.title ? { title: match.title } : {}),
      updatedAt: match.updatedAt,
    };
  }

  async listTasks(sessionId: string): Promise<EngineTaskSnapshot> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.closed) return { supported: true, tasks: [] };
    if (worker.client.alive && worker.subagents.size === 0) {
      const snap = await worker.client.command<{ subagents?: OmpSubagentSummary[] }>({ type: "get_subagents" }, 1500)
        .then(r => r.data ?? {})
        .catch(() => ({ subagents: undefined }));
      for (const item of snap.subagents ?? []) {
        if (!item || typeof item.id !== "string" || !item.id) continue;
        const rec = this.ensureSubagent(worker, item.id, item.description || item.task || item.agent, item.index, item.agent);
        rec.status = mapSubagentStatus(item.status);
      }
    }
    const tasks: EngineTask[] = [...worker.subagents.values()].map((sub) => ({
      id: sub.subagentId,
      label: sub.label,
      kind: "subagent",
      mode: "background",
      status: sub.status,
      canStop: sub.status === "running",
      startedAt: sub.startedAt,
      updatedAt: sub.updatedAt,
      ...(sub.progress ? { progress: sub.progress } : {}),
    }));
    return { supported: true, tasks };
  }

  async stopTask(sessionId: string, input: { taskId: string }): Promise<EngineTaskControlResult> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.closed || !worker.client.alive) return { outcome: "rejected", reason: "not_ready" };
    const res = await worker.client.cancelSubagent(input.taskId);
    return res?.cancelled ? { outcome: "accepted" } : { outcome: "rejected", reason: "stale" };
  }

  async getContextUsage(sessionId: string, input: { workspaceOverride?: string; passive?: boolean } = {}): Promise<EngineContextUsage | null> {
    if (input.passive) {
      // Strictly non-spawning for passive UI reads.
      const live = this.workers.get(sessionId);
      if (!live || live.closed || !live.client.alive) return null;
      const cached = live.state.contextUsage;
      if (!cached || cached.tokens === null || !cached.contextWindow) return null;
      return { pressureTokens: cached.tokens, contextWindow: cached.contextWindow };
    }
    const worker = await this.ensureWorkerForExistingSession(sessionId, input.workspaceOverride).catch(() => undefined);
    if (!worker || worker.closed || !worker.client.alive) return null;
    try {
      const stats = await worker.client.command<{ contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }>({ type: "get_session_stats" });
      const ctx = stats.data?.contextUsage;
      if (ctx) worker.state.contextUsage = ctx;
      worker.lastUsedAt = Date.now();
      if (!ctx || ctx.tokens === null || !ctx.contextWindow) return null;
      return { pressureTokens: ctx.tokens, contextWindow: ctx.contextWindow };
    } catch {
      return null;
    }
  }

  /** OMP supports multiple BYOK/OAuth providers and does not expose a native quota RPC command. */
  async getAccountQuota(): Promise<EngineQuotaReadResult> {
    return {
      revision: "omp-unsupported",
      snapshot: {
        authMode: "unknown",
        capability: { mode: "unsupported", reason: "not_adapted" },
        state: "unsupported",
        reason: "not_adapted",
        availability: "unknown",
        pools: [],
        constraints: [],
      },
    };
  }

  private currentEventEmitter(worker: OmpWorker): ((event: EngineStreamEvent) => void | Promise<void>) | undefined {
    if (worker.activeTurn && !worker.activeTurn.settled) return worker.activeTurn.input.onEngineEvent;
    if (worker.goalWatcher && !worker.goalWatcher.settled) return worker.goalWatcher.onEngineEvent;
    return undefined;
  }

  private handleEvent(worker: OmpWorker, event: OmpSessionEvent): void {
    const turn = worker.activeTurn && !worker.activeTurn.settled ? worker.activeTurn : undefined;
    if (turn) this.noteActivity(worker, turn);
    const emit = this.currentEventEmitter(worker);

    if (event.type === "agent_start" && turn?.promptId && !turn.aborting && !turn.finalizing && !turn.sessionPublication) {
      // The worker is bound to this conversation and has started the prompt.
      // Publish its stable Host key before the first reply finishes.
      turn.sessionPublication = Promise.resolve().then(() => emit?.({ type: "session", sessionId: worker.sessionKey })).catch(() => undefined);
    }

    if (event.type === "message_start" && turn && event.message && (event.message as { role?: unknown }).role === "user") {
      const delivered = extractMessageText(event.message);
      const history = turn.historyInput;
      if (history) {
        const message = event.message as NonNullable<OmpSessionEntry["message"]>;
        const eventId = typeof event.messageId === "string" && event.messageId ? event.messageId : undefined;
        if (history.userEvent === undefined) {
          // The optional stream ID can detect a duplicate event. The durable
          // history ID still comes from the exact payload on the active branch.
          history.userEvent = turn.sessionPublication && delivered === history.promptText
            && typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? { id: eventId, message } : null;
        } else if (history.userEvent && ((eventId !== undefined && eventId === history.userEvent.id)
          || isDeepStrictEqual(message, history.userEvent.message))) {
          history.userEvent = null;
        }
      }
      // Detect real adoption of queued steers when omp delivers them into the turn.
      if (delivered.trim()) {
        const match = turn.pendingSteers.find(s => !s.settled && s.text.trim() === delivered.trim());
        if (match) {
          match.settled = true;
          match.onOutcome?.({ status: "applied", via: "fold" });
        }
      }
      return;
    }

    if (!emit && !turn) return;

    if (event.type === "message_update" && event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
      const sub = event.assistantMessageEvent as { type?: unknown; delta?: unknown };
      if (sub.type === "text_delta" && typeof sub.delta === "string") {
        turn?.textChunks.push(sub.delta);
        void emit?.({ type: "assistant_text", text: sub.delta, delta: true });
      } else if (sub.type === "thinking_delta" && typeof sub.delta === "string") {
        turn?.thinkingChunks.push(sub.delta);
        void emit?.({ type: "thinking", text: sub.delta, delta: true });
      }
      return;
    }
    if (event.type === "message_end" && event.message && (event.message as { role?: unknown }).role === "assistant") {
      const text = extractMessageText(event.message);
      if (turn && text) turn.finalText = text;
      const usage = extractMessageUsage(event.message);
      if (turn && usage) {
        turn.usage.hasData = true;
        turn.usage.inputTokens += usage.inputTokens;
        turn.usage.outputTokens += usage.outputTokens;
        turn.usage.cachedTokens += usage.cachedTokens ?? 0;
        turn.usage.costUsd += usage.costUsd ?? 0;
      }
      return;
    }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      void emit?.({
        type: "tool_use",
        toolName: event.toolName,
        toolInput: event.args,
        ...(typeof event.toolCallId === "string" ? { toolUseId: event.toolCallId } : {}),
      });
      return;
    }
    if (event.type === "tool_stream_update" && typeof event.toolCallId === "string" && typeof event.delta === "string") {
      void emit?.({ type: "tool_progress", toolUseId: event.toolCallId, text: event.delta, delta: true });
      return;
    }
    if (event.type === "tool_execution_end") {
      const output = typeof event.result === "string" ? event.result : event.result ? JSON.stringify(event.result).slice(0, 4000) : undefined;
      void emit?.({
        type: "tool_result",
        ...(typeof event.toolCallId === "string" ? { toolUseId: event.toolCallId } : {}),
        ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        ...(output !== undefined ? { output } : {}),
        isError: event.isError === true,
      });
      return;
    }
    if (event.type === "command_output") {
      const out = (typeof event.text === "string" ? event.text : typeof event.output === "string" ? event.output : "").trim();
      if (out) {
        turn?.commandOutputs.push(out);
        void emit?.({ type: "assistant_text", text: out, delta: false });
      }
      return;
    }
    if (event.type === "manual_compaction_start" || event.type === "auto_compaction_start") {
      const id = `omp-compaction-${randomUUID()}`;
      const startedAt = Date.now();
      if (turn) { turn.compactionId = id; turn.compactionStartedAt = startedAt; }
      else { worker.compactionId = id; worker.compactionStartedAt = startedAt; }
      void emit?.({ type: "context_compaction", id, status: "started", sessionId: worker.sessionKey });
      return;
    }
    if (event.type === "manual_compaction_end" || event.type === "auto_compaction_end") {
      const id = (turn?.compactionId ?? worker.compactionId) || `omp-compaction-${randomUUID()}`;
      const startedAt = turn?.compactionStartedAt ?? worker.compactionStartedAt;
      if (turn) { turn.compactionId = undefined; turn.compactionStartedAt = undefined; }
      worker.compactionId = undefined;
      worker.compactionStartedAt = undefined;
      const failed = Boolean(event.aborted || (typeof event.errorMessage === "string" && event.errorMessage.trim()));
      void emit?.({
        type: "context_compaction",
        id,
        status: failed ? "failed" : "completed",
        ...(startedAt ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
        sessionId: worker.sessionKey,
      });
      return;
    }
    if (event.type === "auto_retry_start") {
      const msg = String(event.errorMessage ?? "").toLowerCase();
      const reason = msg.includes("429") || msg.includes("rate") ? "rate-limit" : msg.includes("503") || msg.includes("overload") ? "capacity" : "connection";
      void emit?.({
        type: "engine_retry",
        status: "waiting",
        attempt: typeof event.attempt === "number" ? event.attempt : 1,
        reason,
        delayMs: typeof event.delayMs === "number" ? event.delayMs : 1000,
      });
      return;
    }
    if (event.type === "auto_retry_end") {
      void emit?.({
        type: "engine_retry",
        status: event.success ? "resumed" : "failed",
        attempt: typeof event.attempt === "number" ? event.attempt : 1,
        reason: "connection",
        delayMs: 0,
      });
    }
  }

  private handlePromptResult(worker: OmpWorker, frame: OmpPromptResultFrame): void {
    const turn = worker.activeTurn;
    if (!turn || turn.settled || turn.finalizing) return;
    if (turn.promptId && frame.id && frame.id !== turn.promptId) return;
    turn.promptResult = frame;
    this.maybeCompleteTurn(worker, turn);
  }

  private handleSessionSettled(worker: OmpWorker): void {
    const turn = worker.activeTurn;
    if (!turn || turn.settled || turn.finalizing) return;
    if (turn.promptResult) {
      this.finalizeTurn(worker, turn, turn.promptResult);
    }
  }

  private maybeCompleteTurn(worker: OmpWorker, turn: ActiveOmpTurn): void {
    const res = turn.promptResult;
    if (!res || turn.settled || turn.finalizing) return;
    if (res.sessionSettled || res.status === "aborted" || res.status === "error") {
      this.finalizeTurn(worker, turn, res);
    }
  }

  private finalizeTurn(worker: OmpWorker, turn: ActiveOmpTurn, res: OmpPromptResultFrame): void {
    if (turn.settled || turn.finalizing) return;
    turn.finalizing = true;
    this.clearTurnTimers(turn);
    turn.abortScope.abort();
    const usage = this.turnUsage(turn);

    if (res.status === "aborted") {
      this.settlePendingSteers(turn, "dropped", "stopped");
      turn.settled = true;
      if (worker.activeTurn === turn) worker.activeTurn = undefined;
      worker.lastUsedAt = Date.now();
      const err = turn.timedOut ? new Error(turn.timedOut) : abortError("Turn aborted");
      turn.reject(withFailedTurnUsage(err, usage));
      return;
    }
    if (res.status === "error") {
      this.settlePendingSteers(turn, "dropped", "turn_failed");
      turn.settled = true;
      if (worker.activeTurn === turn) worker.activeTurn = undefined;
      worker.lastUsedAt = Date.now();
      const err = new OmpRpcCommandError(
        "prompt",
        res.error?.message || "omp turn failed",
        res.error?.code,
        res.error,
      );
      turn.reject(withFailedTurnUsage(err, usage));
      return;
    }

    const text = (turn.finalText || turn.textChunks.join("") || turn.commandOutputs.join("\n")).trim();

    // Keep worker.activeTurn occupied until metadata refresh and resolution finish so no concurrent turn interleaves!
    const finalizeAsync = async () => {
      try {
        await turn.sessionPublication;
        if (worker.client.alive) {
          const [state, entriesRes] = await Promise.all([
            worker.client.command<OmpSessionState>({ type: "get_state" }, 1500).then(r => r.data).catch(() => worker.state),
            worker.client.command<{ entries: OmpSessionEntry[]; leafId: string | null }>({ type: "get_entries" }, 1500).then(r => r.data).catch(() => null),
          ]);
          worker.state = state;
          if (state.sessionFile) {
            await this.store.setRecord(worker.sessionKey, { sessionFile: state.sessionFile, cwd: worker.cwd }).catch(() => undefined);
          }
          if (entriesRes?.leafId) {
            const branch = activeEntryBranch(entriesRes.entries, entriesRes.leafId);
            // Reconcile any steers whose adoption wasn't seen via message_start against the real transcript.
            for (const steer of turn.pendingSteers) {
              if (steer.settled) continue;
              const adopted = branch.some(entry => isUserMessageEntry(entry) && extractMessageText(entry.message).trim() === steer.text.trim());
              if (!adopted && !steer.confirmed) continue;
              steer.settled = true;
              steer.onOutcome?.(adopted ? { status: "applied", via: "fold" } : { status: "dropped", reason: "not_started" });
            }
            const inputId = matchHistoryInput(turn.historyInput, branch);
            const inputIndex = branch.findIndex(entry => entry.id === inputId && isUserMessageEntry(entry));
            if (inputId && inputIndex >= 0) {
              const fork = inputIndex < branch.length - 1;
              await turn.input.onEngineEvent?.({
                type: "history_anchor",
                anchor: {
                  sessionId: worker.sessionKey,
                  inputId,
                  rewind: true,
                  fork,
                  ...(fork ? {
                    forkBoundary: "after-turn",
                    data: { forkLeafId: entriesRes.leafId },
                  } : {}),
                },
              });
            }
          }
        }
      } catch {
        // Non-fatal metadata refresh.
      } finally {
        this.settlePendingSteers(turn, "dropped", "not_started");
        turn.settled = true;
        if (worker.activeTurn === turn) worker.activeTurn = undefined;
        worker.lastUsedAt = Date.now();
      }
      turn.resolve({ sessionId: worker.sessionKey, text, ...(usage ? { usage } : {}) });
    };
    void finalizeAsync();
  }

  private ensureSubagent(
    worker: OmpWorker,
    subagentId: string,
    label?: string,
    index?: number,
    agent?: string,
  ): SubagentRecord {
    let rec = worker.subagents.get(subagentId);
    if (!rec) {
      const now = Date.now();
      const display = label || agent || subagentId;
      rec = {
        subagentId,
        ...(index !== undefined ? { index } : {}),
        ...(agent ? { agent } : {}),
        scope: { id: `omp_sub_${subagentId}`, kind: "subagent", label: display },
        label: display,
        status: "running",
        startedAt: now,
        updatedAt: now,
      };
      worker.subagents.set(subagentId, rec);
    } else {
      if (index !== undefined && rec.index === undefined) rec.index = index;
      if (agent && !rec.agent) rec.agent = agent;
      if (label && rec.label === subagentId) {
        rec.label = label;
        rec.scope = { ...rec.scope, label };
      }
    }
    return rec;
  }

  private findSubagentForProgress(worker: OmpWorker, payload: NonNullable<OmpSubagentProgressFrame["payload"]>): SubagentRecord | undefined {
    if (typeof payload.id === "string" && payload.id) {
      return this.ensureSubagent(worker, payload.id, payload.description || payload.task || payload.agent, payload.index, payload.agent);
    }
    if (typeof payload.index === "number") {
      for (const rec of worker.subagents.values()) {
        if (rec.index === payload.index && (!payload.agent || !rec.agent || rec.agent === payload.agent)) return rec;
      }
    }
    if (typeof payload.agent === "string" && payload.agent) {
      const fallbackId = `agent_${payload.agent}_${payload.index ?? 0}`;
      return this.ensureSubagent(worker, fallbackId, payload.description || payload.task || payload.agent, payload.index, payload.agent);
    }
    return undefined;
  }

  private handleSubagentLifecycle(worker: OmpWorker, frame: OmpSubagentLifecycleFrame): void {
    const payload = frame?.payload;
    if (!payload || typeof payload !== "object" || typeof payload.id !== "string" || !payload.id) return;
    if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn);
    const rec = this.ensureSubagent(worker, payload.id, payload.description || payload.task || payload.agent, payload.index, payload.agent);
    rec.updatedAt = Date.now();
    rec.status = mapSubagentStatus(payload.status);
    const emit = this.currentEventEmitter(worker);
    if (emit) {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "scope_status", status: rec.status },
      });
    }
  }

  private handleSubagentProgress(worker: OmpWorker, frame: OmpSubagentProgressFrame): void {
    const payload = frame?.payload;
    if (!payload || typeof payload !== "object") return;
    if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn);
    const rec = this.findSubagentForProgress(worker, payload);
    if (!rec) return;
    rec.updatedAt = Date.now();
    const detail = formatSubagentProgress(payload);
    if (detail) rec.progress = detail;
    const emit = this.currentEventEmitter(worker);
    if (emit && detail) {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "assistant_text", text: detail, delta: false },
      });
    }
  }

  private handleSubagentEvent(worker: OmpWorker, frame: OmpSubagentEventFrame): void {
    const payload = frame?.payload;
    const ev = payload?.event;
    if (!payload || typeof payload.id !== "string" || !payload.id || !ev || typeof ev !== "object") return;
    if (worker.activeTurn) this.noteActivity(worker, worker.activeTurn);
    const rec = this.ensureSubagent(worker, payload.id);
    rec.updatedAt = Date.now();
    const emit = this.currentEventEmitter(worker);
    if (!emit) return;
    if (ev.type === "tool_execution_start" && typeof ev.toolName === "string") {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "tool_use", toolName: ev.toolName, toolInput: ev.args, ...(typeof ev.toolCallId === "string" ? { toolUseId: ev.toolCallId } : {}) },
      });
    } else if (ev.type === "tool_execution_end") {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "tool_result", ...(typeof ev.toolCallId === "string" ? { toolUseId: ev.toolCallId } : {}), isError: ev.isError === true },
      });
    }
  }

  private handleBtwDelta(worker: OmpWorker, recordId: string, delta: string): void {
    const waiter = worker.activeBtw.get(recordId);
    if (waiter) {
      waiter.onDelta?.(delta);
      return;
    }
    let buf = worker.bufferedBtwDeltas.get(recordId);
    if (!buf) {
      if (worker.bufferedBtwDeltas.size > 32) {
        worker.bufferedBtwDeltas.delete(worker.bufferedBtwDeltas.keys().next().value!);
      }
      buf = [];
      worker.bufferedBtwDeltas.set(recordId, buf);
    }
    buf.push(delta);
  }

  private handleBtwRecord(worker: OmpWorker, record: OmpBtwRecord): void {
    const latest = record.followUps?.at(-1) ?? record;
    if (latest.status !== "running") {
      worker.completedBtw.set(record.id, record);
      if (worker.completedBtw.size > 32) worker.completedBtw.delete(worker.completedBtw.keys().next().value!);
    }
    const waiter = worker.activeBtw.get(record.id);
    if (!waiter) return;
    if (latest.status === "complete") {
      worker.activeBtw.delete(record.id);
      worker.completedBtw.delete(record.id);
      worker.bufferedBtwDeltas.delete(record.id);
      waiter.resolve(record);
    } else if (latest.status === "cancelled" || latest.status === "error" || latest.status === "interrupted") {
      worker.activeBtw.delete(record.id);
      worker.completedBtw.delete(record.id);
      worker.bufferedBtwDeltas.delete(record.id);
      waiter.reject(new Error(latest.error || `Side question ${latest.status}`));
    }
  }

  private async handleExtensionUi(worker: OmpWorker, req: OmpExtensionUiRequest): Promise<void> {
    if (req.method === "cancel") {
      const target = typeof req.targetId === "string" ? req.targetId : undefined;
      if (target) {
        const pending = worker.pendingUi.get(target);
        if (pending) {
          worker.pendingUi.delete(target);
          pending.abort();
        }
      }
      return;
    }
    // Fire-and-forget presentation frames need no response.
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"].includes(req.method)) {
      return;
    }

    const turn = worker.activeTurn && !worker.activeTurn.settled ? worker.activeTurn : undefined;
    const onApproval = turn
      ? turn.input.onApprovalRequest
      : worker.goalWatcher && !worker.goalWatcher.settled
        ? worker.goalWatcher.onApprovalRequest
        : undefined;
    const locale: Locale = turn?.input.locale ?? "en";

    if (!onApproval || turn?.aborting) {
      worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
      return;
    }

    const cancelController = new AbortController();
    worker.pendingUi.set(req.id, cancelController);
    let timedOut = false;
    const timeout = typeof req.timeout === "number" && req.timeout > 0
      ? setTimeout(() => { timedOut = true; cancelController.abort(); }, req.timeout)
      : undefined;
    timeout?.unref?.();
    const signals = [
      cancelController.signal,
      ...(turn ? [turn.abortScope.signal] : []),
      ...(worker.goalWatcher?.abortSignal ? [worker.goalWatcher.abortSignal] : []),
    ];
    const abortSignal = AbortSignal.any(signals);
    if (turn) turn.humanWaits++;

    const sendCancelled = () => {
      worker.client.sendExtensionUiResponse({
        type: "extension_ui_response",
        id: req.id,
        cancelled: true,
        ...(timedOut ? { timedOut: true } : {}),
      });
    };

    try {
      if (req.method === "confirm") {
        const decision = await onApproval({
          engine: "omp",
          toolName: req.title || "omp_confirm",
          toolInput: { message: req.message || "" },
          cwd: worker.cwd,
          sessionId: worker.sessionKey,
          abortSignal,
        });
        if (!worker.pendingUi.delete(req.id) || abortSignal.aborted) {
          if (timedOut) sendCancelled();
          return;
        }
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, confirmed: decision.behavior === "allow" });
        return;
      }

      if (req.method === "input" || req.method === "editor") {
        if (req.method === "editor" && typeof req.prefill === "string" && req.prefill.length > EDITOR_PREFILL_LIMIT) {
          worker.pendingUi.delete(req.id);
          sendCancelled();
          return;
        }
        const questionText = piQuestionWithDetail(piQuestionText(req.title || "", "omp"), req.message);
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: {
            questions: [{
              header: req.title || (req.method === "editor" ? "Editor" : "Input"),
              question: questionText,
              options: [],
              multiSelect: false,
              allowFreeText: true,
              required: false,
              input: {
                kind: req.method === "editor" ? "multiline" : "text",
                ...(req.placeholder ? { placeholder: req.placeholder } : {}),
                ...(req.prefill ? { prefill: req.prefill } : {}),
              },
            }],
          },
          cwd: worker.cwd,
          sessionId: worker.sessionKey,
          abortSignal,
        });
        if (!worker.pendingUi.delete(req.id) || abortSignal.aborted || decision.behavior !== "allow") {
          sendCancelled();
          return;
        }
        const selection = piQuestionSelection(decision.updatedInput, 0);
        const raw = selection?.text !== undefined ? selection.text : piLabelAnswer(decision.updatedInput, questionText);
        const value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.find((x): x is string => typeof x === "string") : undefined;
        if (value !== undefined) {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, value });
        } else {
          sendCancelled();
        }
        return;
      }

      if (req.method === "ask" && Array.isArray(req.questions) && req.questions.length > 0) {
        const mappedQuestions = req.questions.map((q) => ({
          header: q.header || q.id,
          question: piQuestionText(q.question, q.id),
          multiSelect: Boolean(q.multi),
          allowFreeText: true,
          options: q.options.map(opt => ({
            label: piQuestionText(opt.label, "(empty)"),
            ...(opt.description ? { description: opt.description } : {}),
          })),
        }));
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: { questions: mappedQuestions },
          cwd: worker.cwd,
          sessionId: worker.sessionKey,
          abortSignal,
        });
        if (!worker.pendingUi.delete(req.id) || abortSignal.aborted || decision.behavior !== "allow") {
          sendCancelled();
          return;
        }
        const { answers, objectSelections } = extractAskResponseSelections(decision.updatedInput);
        const wireAnswers = req.questions.map((q, idx) => {
          // 1. Positional selections from card-actions (`askFormPiSelections`) — lossless even when labels contain commas.
          const pos = piQuestionSelection(decision.updatedInput, idx);
          if (pos) {
            const selectedOptions = pos.options
              .map(i => q.options[i]?.label)
              .filter((label): label is string => typeof label === "string");
            const customInput = pos.text?.trim();
            return { id: q.id, selectedOptions, ...(customInput ? { customInput } : {}) };
          }
          // 2. Object-keyed selections (programmatic / test callers).
          const sel = objectSelections?.[q.question];
          if (sel) {
            return { id: q.id, selectedOptions: sel.selectedOptions, ...(sel.customInput ? { customInput: sel.customInput } : {}) };
          }
          // 3. Label-only fallback.
          const raw = (answers[q.question] ?? answers[mappedQuestions[idx]!.question] ?? "").trim();
          const optionLabels = new Set(q.options.map(o => o.label));
          if (q.multi && raw) {
            const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
            const selectedOptions = parts.filter(p => optionLabels.has(p));
            const custom = parts.filter(p => !optionLabels.has(p)).join(", ");
            return { id: q.id, selectedOptions, ...(custom ? { customInput: custom } : {}) };
          }
          if (raw && optionLabels.has(raw)) {
            return { id: q.id, selectedOptions: [raw] };
          }
          return { id: q.id, selectedOptions: [], ...(raw ? { customInput: raw } : {}) };
        });
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, answers: wireAnswers });
        return;
      }

      if (req.method === "select" && Array.isArray(req.options) && req.options.length > 0) {
        const question = piQuestionText(req.title || req.message || "", locale === "zh" ? "请选择一项" : "Choose an option");
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: {
            questions: [{
              header: req.title || "Select",
              question,
              multiSelect: false,
              allowFreeText: false,
              options: req.options.map((label, idx) => ({
                label: piQuestionText(label, "(empty)"),
                ...(req.optionDetails?.[idx]?.description ? { description: req.optionDetails[idx].description } : {}),
              })),
            }],
          },
          cwd: worker.cwd,
          sessionId: worker.sessionKey,
          abortSignal,
        });
        if (!worker.pendingUi.delete(req.id) || abortSignal.aborted || decision.behavior !== "allow") {
          sendCancelled();
          return;
        }
        const pos = piQuestionSelection(decision.updatedInput, 0);
        if (pos && pos.options.length === 1 && req.options[pos.options[0]!] !== undefined) {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, value: req.options[pos.options[0]!]! });
          return;
        }
        const { answers } = extractAskResponseSelections(decision.updatedInput);
        const chosen = answers[question]?.trim();
        if (chosen) {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, value: chosen });
        } else {
          sendCancelled();
        }
        return;
      }

      if (req.method === "form") {
        const fields = parseOmpFormRequest(req);
        if (fields.length === 0) {
          worker.pendingUi.delete(req.id);
          sendCancelled();
          return;
        }
        const mappedQuestions = fields.map(field => {
          const isFreeTextOnly = field.kind === "text" || field.kind === "textarea" || field.kind === "number";
          return {
            header: field.header || field.name,
            question: piQuestionText(field.label, field.name),
            multiSelect: field.kind === "checkbox",
            allowFreeText: true,
            ...(!field.required ? { required: false as const } : {}),
            options: isFreeTextOnly
              ? []
              : field.options.map(opt => ({
                  label: piQuestionText(opt.label, opt.value),
                  ...(opt.description ? { description: opt.description } : {}),
                })),
            ...(isFreeTextOnly ? {
              input: {
                kind: field.kind === "textarea" ? "multiline" as const : "text" as const,
                ...(field.placeholder ? { placeholder: field.placeholder } : {}),
                ...(field.prefill ? { prefill: field.prefill } : {}),
              },
            } : {}),
          };
        });
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: { questions: mappedQuestions },
          cwd: worker.cwd,
          sessionId: worker.sessionKey,
          abortSignal,
        });
        if (!worker.pendingUi.delete(req.id) || abortSignal.aborted || decision.behavior !== "allow") {
          sendCancelled();
          return;
        }
        const { answers } = extractAskResponseSelections(decision.updatedInput);
        const data: Record<string, string | number | string[]> = {};
        fields.forEach((field, idx) => {
          const pos = piQuestionSelection(decision.updatedInput, idx);
          const qText = mappedQuestions[idx]!.question;
          if (field.kind === "checkbox") {
            if (pos) {
              const vals = pos.options.map(i => field.options[i]?.value).filter((v): v is string => typeof v === "string");
              if (pos.text?.trim()) vals.push(pos.text.trim());
              data[field.name] = vals;
            } else {
              const raw = (answers[qText] ?? "").trim();
              const parts = raw ? raw.split(",").map(p => p.trim()).filter(Boolean) : [];
              data[field.name] = parts.map(part => field.options.find(o => o.label === part || o.value === part)?.value ?? part);
            }
          } else if (field.kind === "radio" || field.kind === "select") {
            if (pos && pos.options.length > 0 && field.options[pos.options[0]!]) {
              data[field.name] = field.options[pos.options[0]!]!.value;
            } else if (pos?.text !== undefined && pos.text.trim()) {
              data[field.name] = pos.text.trim();
            } else {
              const raw = (answers[qText] ?? "").trim();
              const match = field.options.find(o => o.label === raw || o.value === raw);
              if (match) data[field.name] = match.value;
              else if (raw) data[field.name] = raw;
            }
          } else if (field.kind === "number") {
            const raw = (pos?.text ?? answers[qText] ?? "").trim();
            const num = Number(raw);
            if (raw && Number.isFinite(num)) data[field.name] = num;
            else if (raw) data[field.name] = raw;
          } else {
            const raw = pos?.text !== undefined ? pos.text : (answers[qText] ?? "");
            data[field.name] = raw;
          }
        });
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, data });
        return;
      }

      // Unsupported interactive dialog method: cancel explicitly so omp never hangs.
      worker.pendingUi.delete(req.id);
      sendCancelled();
    } catch {
      worker.pendingUi.delete(req.id);
      sendCancelled();
    } finally {
      clearTimeout(timeout);
      if (turn) {
        turn.humanWaits = Math.max(0, turn.humanWaits - 1);
        this.noteActivity(worker, turn);
      }
    }
  }

  destroy(): Promise<void> {
    if (this.destroying) return this.destroying;
    this.destroyed = true;
    this.retiring.abort(destroyedError());
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.destroying = (async () => {
      const closeRegistered = async () => {
        const workers = [...this.workers.values()];
        this.workers.clear();
        await Promise.all(workers.map(w => this.closeWorker(w, destroyedError())));
      };
      // Close live workers and wait for all in-flight startups to abort and clean up
      // so no spawned omp process or bridge socket outlives destroy().
      await Promise.all([
        closeRegistered(),
        Promise.allSettled([...this.starting.values()]),
      ]);
      await closeRegistered();
    })();
    return this.destroying;
  }
}
