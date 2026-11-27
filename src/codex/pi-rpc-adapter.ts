import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostT } from "../locales/index.js";
import { EngineSessionRestarts } from "./engine-session-restart.js";
import { APP_STOP_PROCESS_GRACE_MS } from "../runtime/turn-cancellation.js";

import {
  EngineIncompleteResponseError, EngineSteeringRejectedError, withFailedTurnUsage,
  type AppPlatformTools, type CodexAdapter, type CodexAdapterResponse, type CodexSessionHandle, type CodexUserMessageInput,
  type EngineApprovalDecision, type EngineContextUsage, type EngineSessionRestartOptions, type EngineSessionRestartResult, type EngineStreamEvent, type ExternalSessionInfo,
  type NativeHistoryAnchor, type NativeHistoryRejection, type NativeHistoryResult, type NativeHistoryState,
} from "./adapter.js";
import { ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS, ENGINE_DEFAULT_TURN_TIMEOUT_MS } from "./engine-timeouts.js";
import type { NativeSearchMcpPlanner } from "../runtime/native-search-mcp.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile, resolveEngineOverride, type EngineOverride } from "../state/instance-config.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { PI_THINKING_LEVELS, decodePiModel, encodePiModel, parsePiModels, piThinkingLevels, type PiThinkingLevel } from "./pi-models.js";
import { PI_LIVE_COMMANDS } from "../client-protocol/pi-commands.js";
import {
  PI_BRIDGE_COMMAND, openPiBridgeEndpoint, resolvePiBridgeExtensionPath,
  type PiBridgeConnection, type PiBridgeEndpoint, type PiBridgeEvent, type PiBridgeHandler, type PiBridgeToolOrigin,
} from "./pi-bridge-host.js";
import { piBuiltinYieldsToSessionCommand, runPiNativeCommand, type PiCommandAnswer, type PiCommandQuestion, type PiNativeCommandResult } from "./pi-native-commands.js";
import {
  PiNativeBridgeUnavailableError, PiNativeBusyError, PiNativeRejectedError, PiNativeUncertainError,
  type PiNativeBashResult, type PiNativeCommand, type PiNativeCompaction, type PiNativeControls, type PiNativeEvent,
  type PiNativeGlobalSetting, type PiNativeLiveSession, type PiNativeModelScope, type PiNativeProjectTrust, type PiNativeState,
  type PiNativeStats, type PiNativeTool, type PiNativeTree,
} from "./pi-native-types.js";
import { PiRpcClient, PiRpcCommandError, PiStartupError, queryPiCatalog, type PiLaunchSpec, type PiSpawn } from "./pi-rpc-client.js";
import {
  PI_TUI_BUILTIN_COMMANDS, classifyPiError, isPiPlaceholderModel, parsePiSlashCommand, piClip, piDisplayText, piProviderFailure, samePiModel, sanitizePiErrorText, toPiModelRef,
  type PiAssistantMessage, type PiExtensionUiRequest, type PiModel, type PiModelRef, type PiPromptDisposition, type PiSessionEntry, type PiSessionEvent, type PiSessionState,
} from "./pi-rpc-protocol.js";
import { piLabelAnswer, piLabelValue, piQuestionSelection, piQuestionText } from "./pi-question-identity.js";
import { piManagedSearchServer, type PiManagedSearchServer } from "./pi-search-mcp.js";
import { PiSessionStore, piWorkspaceCwd, samePiWorkspace, hasPiTrustGatedFiles, isSafePiSessionId, piBotDefaultFingerprint, type PiSessionRecord } from "./pi-session-store.js";
import {
  PiTurnMapper, buildPiPrompt, isPiDialog, piDialogQuestion, piDialogResponse, piNativeTree, piQuestionWithDetail, piUsageCostBreakdown, piUserEntryText,
} from "./pi-turn-mapper.js";
import { piSkippedImagesNotice } from "./pi-turn-mapper.js";
import { unavailableQuota } from "./account-quota.js";
import type { EngineQuotaReadOptions, EngineQuotaReadResult } from "./adapter-account-quota.js";

export interface PiRpcAdapterOptions {
  launch: PiLaunchSpec;
  workspacePath: string;
  /** Bot state directory. Sessions live in `<stateDir>/pi/sessions`. */
  stateDir: string;
  /** Passed to Pi unchanged. Native `PI_CODING_AGENT_DIR`, sign-ins and settings are shared with the owner's own Pi. */
  childEnv: NodeJS.ProcessEnv;
  /** Bot config read at every turn for approval mode, model and effort. */
  configPath?: string;
  /** Compiled bridge extension. Defaults to the packaged one; null runs without it (tests only). */
  bridgeExtensionPath?: string | null;
  /** Host-managed Search MCP. Registered per process through the bridge; its credentials go to the MCP child only. */
  nativeSearchMcp?: NativeSearchMcpPlanner;
  /**
   * The Host's own test for text it would act on after a turn (file sends, tool and schedule tags).
   * Those are a model's instructions to the Host. A reply this adapter writes itself for a native
   * command is shown, never executed: when this says yes, the reply goes out as one literal block.
   */
  carriesHostDirectives?: (text: string) => boolean;
  spawnFn?: PiSpawn;
  killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
  openBridgeFn?: typeof openPiBridgeEndpoint;
  queryCatalogFn?: typeof queryPiCatalog;
  turnTimeoutMs?: number | null;
  inactivityTimeoutMs?: number | null;
  startupTimeoutMs?: number;
  /** How long a stop may wait for Pi to settle before the process is ended. */
  cancelGraceMs?: number;
  /** Deadline for one native model or thinking write. Default: the RPC client's 30 s. */
  settingsWriteTimeoutMs?: number;
  idleWorkerTtlMs?: number;
  idleSweepIntervalMs?: number;
  /** One-line diagnostics (idle-worker decisions). Default: stderr, which the Hub keeps as the Bot's log tail. */
  log?: (line: string) => void;
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void; settled: boolean };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const result = { settled: false } as Deferred<T>;
  result.promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  result.resolve = value => { if (!result.settled) { result.settled = true; resolve(value); } };
  result.reject = error => { if (!result.settled) { result.settled = true; reject(error); } };
  result.promise.catch(() => {});
  return result;
}
const sleep = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

interface Turn {
  /** The process serving this turn. It changes when the turn restarts Pi (project trust). */
  worker: Worker;
  readonly input: CodexUserMessageInput;
  readonly mapper: PiTurnMapper;
  /** Aborts approvals, dialogs and App tool calls that belong to this turn. */
  readonly scope: AbortController;
  /** Resolves when the native run settled (or there was none to wait for). */
  readonly done: Deferred<void>;
  /** Resolves when a stop or timeout was requested, so every wait in the turn can be raced against it. */
  readonly stopped: Deferred<void>;
  /** The prompt command in flight, if any. Pi answers it only after extension and input preflight. */
  promptOutcome?: Promise<PiPromptDisposition | "failed">;
  /** Pi answered that prompt, taken in stream order: an agent_settled before it ended a run this turn did not start. */
  promptAnswered?: boolean;
  instructions?: string;
  appTools?: AppPlatformTools;
  notices: string[];
  extensionErrors: number;
  emitChain: Promise<void>;
  /** Open human waits; the inactivity timer does not run while the owner is deciding. */
  humanWaits: number;
  /**
   * Input this turn accepted while its run was going (live commands, `!`, steers). The turn ends
   * only after each has been answered, so a reply joins this turn and nothing outlives it unseen.
   */
  readonly liveWork: Set<Promise<unknown>>;
  /** Live commands and `!` run one after another, like input typed into Pi's own editor. */
  liveChain: Promise<void>;
  liveQueued: number;
  /**
   * The run's last reply needed no tools, so Pi is finishing: a steer arriving now is parked and
   * then delivered into the next, unrelated run (observed on Pi 1.5.2, opus-probe o03).
   */
  wrappingUp: boolean;
  /** Additions taken back from Pi's queue in this turn; the final answer says how many, never what. */
  handedBack: number;
  /** Pi could not confirm its queue at the end of this turn and the process was ended. */
  queueUnconfirmed?: boolean;
  stopRequested: boolean;
  stopping?: Promise<void>;
  timedOut?: string;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  turnTimer?: ReturnType<typeof setTimeout>;
}

interface Worker {
  sessionId: string;
  generation: number;
  /** Random identity of this process and session generation, for live handles. */
  token: string;
  editorRevision: number;
  /** Model and thinking changes to this process run one at a time, whoever asks. */
  settingsQueue: Promise<void>;
  /** Set when a model or thinking write got no confirmed answer. Never cleared for this process. */
  settingsUncertain?: string;
  readonly cwd: string;
  readonly client: PiRpcClient;
  readonly endpoint?: PiBridgeEndpoint;
  bridge?: PiBridgeConnection;
  state: PiSessionState;
  queue: { steering: string[]; followUp: string[] };
  /** Undefined until a turn has told the bridge. The extension itself starts gated. */
  gate?: boolean;
  /** Whether Pi loaded this project's own files; undefined when the bridge could not say. */
  trusted?: boolean;
  turn?: Turn;
  /** A native control that needs the session idle is running. */
  exclusive?: string;
  readonly dialogs: Map<string, PiExtensionUiRequest>;
  /** Tool-name prefix of the Host's search server when it is registered in this process. */
  managedSearchPrefix?: string;
  readonly ui: PiNativeState["ui"];
  /** Extension notices that arrived while no turn was running. */
  readonly backlog: string[];
  readonly extensionErrors: Array<Extract<PiNativeEvent, { type: "extension_error" }>>;
  /** When the last turn ended (or the process started); with `touchedBy`, says what keeps an idle worker fresh. */
  lastTurnAt: number;
  /** The last call outside a turn that refreshed `lastUsedAt` (a history read, a native control). */
  touchedBy?: string;
  lastUsedAt: number;
  closed: boolean;
}

const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "tool_search", "codemode"]);
/** Built-ins that may run while a model run is in progress; the rest need an idle session. */
const SESSION_GRANT_LIMIT = 128;
/** The shared question card holds this much editor text; more would be cut, and the extension would get the cut text back as the edit. */
const EDITOR_PREFILL_LIMIT = 16_000;
const IMPORT_MAX_BYTES = 512 * 1024 * 1024;
const NOTICE_BACKLOG_LIMIT = 20;
const NO_APP_TURN = { text: "No matching active App turn; nothing was sent. Follow this turn's channel instructions and never claim delivery without a receipt.", isError: true };

/** What one model or thinking change was started for; made by `settingsTask`, which explains why. */
interface SettingsScope {
  readonly sessionId: string;
  /** Passes only while the process still serves that session and the requester still allows the change. */
  check(): Promise<void>;
  /** Writes the change's bookkeeping for that session, after `check`. */
  record(patch: Partial<PiSessionRecord>): Promise<void>;
}

/** `work`, or an AbortError as soon as `signal` aborts. The work itself goes on. */
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

function abortError(): Error {
  const error = new Error("Pi turn was aborted");
  error.name = "AbortError";
  return error;
}
/** The adapter was retired under a turn that had not finished. Whatever it produced so far is not an answer. */
const destroyedTurnError = () => new EngineIncompleteResponseError("Pi adapter was destroyed before the turn finished", "interrupted");
const minutes = (ms: number) => { const value = Math.max(1, Math.round(ms / 60_000)); return `${value} ${value === 1 ? "minute" : "minutes"}`; };
const isThinkingLevel = (value: unknown): value is PiThinkingLevel => (PI_THINKING_LEVELS as readonly unknown[]).includes(value);
/** The Host's canonical form: no whitespace, so the settings-error reader can take the identity whole, and the same value the Bot setting shows. */
const modelLabel = (ref: PiModelRef) => encodePiModel(ref.provider, ref.modelId);

/**
 * Pi as a first-class engine: one long-lived `pi --mode rpc` process per
 * native session, plus the TaroBird bridge extension for what RPC does not
 * expose (tool approvals, App tools, host instructions, project trust, tree
 * navigation, reload). Sessions are ordinary Pi session files.
 */
/** Head of a Pi session that exists and has no entries on its current branch. */
const PI_EMPTY_HISTORY_HEAD = "empty";

function isPiUserEntry(entry: PiSessionEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/** The entries from the root to `leafId`, oldest first. */
function piActiveBranch(entries: PiSessionEntry[], leafId: string | null): PiSessionEntry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch: PiSessionEntry[] = [];
  for (let cursor = leafId ? byId.get(leafId) : undefined, guard = 0; cursor && guard <= entries.length; guard++) {
    branch.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return branch.reverse();
}

async function isExistingFile(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); } catch { return false; }
}

export class PiRpcAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = false;
  readonly inFlightSendBehavior = "steer" as const;
  readonly turnRuntimeLimitMs: number | null;
  readonly piNative: PiNativeControls;

  private readonly store: PiSessionStore;
  private readonly workers = new Map<string, Worker>();
  private readonly starting = new Map<string, { controller: AbortController; work: Promise<Worker>; client?: PiRpcClient }>();
  private readonly sessionRestarts = new EngineSessionRestarts();
  /**
   * Second processes making a fork, from before they are spawned until they
   * have exited. They belong to no session of this adapter, so nothing else
   * would wait for or end them. The key cancels one that is still starting.
   */
  private readonly historyHelpers = new Map<AbortController, Promise<unknown>>();
  private readonly historyHelperClients = new Set<PiRpcClient>();
  private readonly subscribers = new Map<string, Set<(event: PiNativeEvent) => void>>();
  /** Session-scoped tool approvals. Memory only: a Host restart asks again. */
  private readonly grants = new Map<string, Set<string>>();
  private readonly inactivityTimeoutMs: number | null;
  private readonly cancelGraceMs: number;
  private readonly idleWorkerTtlMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** The sweep in progress: one at a time, however long its closes take. */
  private sweeping: Promise<void> | undefined;
  /** Why each expired idle worker was last kept, so a reason is logged once and again only when it changes. */
  private readonly sweepReasons = new WeakMap<Worker, string>();
  private readonly bridgeExtensionPath: string | null;
  private destroyed = false;
  /** Aborted by `destroy`: a start still waiting on Pi stops waiting, so destroy does not wait out its deadlines. */
  private readonly retiring = new AbortController();

  constructor(private readonly options: PiRpcAdapterOptions) {
    this.store = new PiSessionStore({ stateDir: options.stateDir, childEnv: options.childEnv });
    this.turnRuntimeLimitMs = options.turnTimeoutMs === undefined ? ENGINE_DEFAULT_TURN_TIMEOUT_MS : options.turnTimeoutMs;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs === undefined ? ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS : options.inactivityTimeoutMs;
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000;
    this.idleWorkerTtlMs = options.idleWorkerTtlMs ?? 15 * 60_000;
    this.bridgeExtensionPath = options.bridgeExtensionPath === undefined ? resolvePiBridgeExtensionPath() : options.bridgeExtensionPath;
    const interval = options.idleSweepIntervalMs ?? 60_000;
    if (interval > 0) { this.sweepTimer = setInterval(() => { void this.sweepIdleWorkers(); }, interval); this.sweepTimer.unref?.(); }
    this.piNative = this.createNativeControls();
  }

  // ---------------------------------------------------------------- CodexAdapter

  /** Pi accepts a Host-chosen session id (`--session-id`), so the real native id exists before the first message. */
  async createSession(_chatId: number): Promise<CodexSessionHandle> {
    this.assertUsable();
    return { sessionId: randomUUID() };
  }

  supportsSessionSteering(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    return Boolean(worker && !worker.closed && worker.client.isAlive);
  }

  hasPendingNativeWork(): boolean {
    if (this.starting.size || this.historyHelpers.size) return true;
    for (const worker of this.workers.values()) if (!worker.closed && (worker.turn || worker.state.isStreaming || worker.state.isCompacting)) return true;
    return false;
  }

  /**
   * Input sent while a run is in progress, handled as Pi's own editor does
   * while streaming (interactive-mode.ts:3326-3510). A terminal built-in
   * (`/model`, `/thinking` …) and `!`/`!!` are carried out at once and never
   * reach the model as prose. Other text, including prompt templates and
   * `/skill:` commands, becomes a native steer; Pi expands those itself.
   *
   * Every refusal here is decided before anything reaches Pi, or is Pi's own
   * refusal, so the caller may queue the input as a new turn instead.
   */
  async steerActiveTurn(sessionId: string, input: { text: string; throwOnError?: boolean }): Promise<boolean> {
    this.assertUsable();
    const reject = (reason: EngineSteeringRejectedError["reason"]) => {
      if (input.throwOnError) throw new EngineSteeringRejectedError(reason);
      return false;
    };
    const worker = this.workers.get(sessionId), turn = worker?.turn;
    if (!worker || worker.closed || !turn || turn.stopRequested || turn.done.settled) return reject("stale");
    const current = () => !worker.closed && worker.turn === turn && !turn.stopRequested && !turn.done.settled;
    // Idle Pi only parks a steer in its queue and never starts a run, so steering needs a live run.
    if (!turn.mapper.runStarted || turn.mapper.settled) return reject("not_ready");
    // Pi's editor trims what was typed before it looks for a command (interactive-mode.ts:3327).
    const text = input.text.trim();
    if (!text) return reject("not_ready");
    // `!` adds the output to the context and `!!` keeps it out; Pi runs either at once, even while streaming
    // (interactive-mode.ts:3472-3486), and holds a streaming run's result until that run ends (agent-session.ts:4041-4060).
    const bang = text.startsWith("!") && Boolean(text.slice(text.startsWith("!!") ? 2 : 1).trim());
    const builtin = parsePiSlashCommand(text);
    let sessionCommands: PiNativeCommand[] | undefined;
    if (builtin && Object.hasOwn(PI_TUI_BUILTIN_COMMANDS, builtin.name) && piBuiltinYieldsToSessionCommand(builtin.name, builtin.args)) {
      // `/session x` is not the built-in for Pi's editor; with an extension command or template of that name it is that one.
      try { sessionCommands = await this.nativeCommands(worker); } catch { return reject("not_ready"); }
      if (!current()) return reject("stale");
    }
    const yields = Boolean(sessionCommands?.some(command => command.name === builtin!.name));
    if (bang || (builtin && Object.hasOwn(PI_TUI_BUILTIN_COMMANDS, builtin.name) && !yields)) {
      return this.admitLiveCommand(worker, turn, text, bang ? "!" : builtin!.name);
    }
    if (turn.wrappingUp) return reject("not_ready");
    if (builtin) {
      // A registered extension command cannot be steered (agent-session.ts:2435-2445). `prompt` would run it,
      // but also after this run has ended and outside this turn (opus-probe o02-D), so it waits for a turn of its own.
      let extension: boolean;
      try {
        extension = (sessionCommands ?? await this.nativeCommands(worker)).some(command => command.source === "extension" && command.name === builtin.name);
      } catch { return reject("not_ready"); }
      if (!current()) return reject("stale");
      if (extension) return reject("unsupported");
      if (turn.mapper.settled || turn.wrappingUp) return reject("not_ready");
    }
    const request = worker.client.request({ type: "steer", message: text }, { timeoutMs: 30_000 });
    this.trackLive(turn, request);
    try {
      const result = await request;
      return result.disposition === "queued" || result.disposition === "handled";
    } catch (error) {
      // Pi answered and refused: nothing was queued.
      if (error instanceof PiRpcCommandError) return reject("not_ready");
      if (input.throwOnError) throw error;
      return false;
    }
  }

  /**
   * Accept a live command or `!` for this turn. It runs after the turn's
   * earlier ones. The caller gets its answer once the command finished or is
   * waiting for the owner or the shell, so a card or a long command never
   * holds the request open.
   */
  private async admitLiveCommand(worker: Worker, turn: Turn, text: string, name: string): Promise<true> {
    const admitted = deferred<void>();
    // Queued behind another command, it is admitted already: the turn runs it, or a stop cancels it.
    if (turn.liveQueued > 0) admitted.resolve();
    turn.liveQueued++;
    const work = turn.liveChain.then(() => this.runCommandDuringRun(worker, turn, text, name, () => admitted.resolve()))
      .finally(() => { turn.liveQueued--; admitted.resolve(); });
    turn.liveChain = work.catch(() => {});
    this.trackLive(turn, work);
    await Promise.race([work.catch(() => {}), admitted.promise]);
    return true;
  }

  private trackLive(turn: Turn, work: Promise<unknown>): void {
    const tracked = work.then(() => undefined, () => undefined);
    turn.liveWork.add(tracked);
    void tracked.then(() => { turn.liveWork.delete(tracked); });
  }

  /** Wait until everything accepted during the run has been answered; work accepted meanwhile is waited for too. */
  private async drainLiveWork(turn: Turn): Promise<void> {
    while (turn.liveWork.size) await Promise.all([...turn.liveWork]);
  }

  /**
   * Pi still holds queued input although no run is going: it arrived after
   * the run had finished. Pi would deliver it into the next, unrelated run,
   * so it is taken back and returned to the owner instead.
   */
  private async handBackParked(turn: Turn): Promise<void> {
    const worker = turn.worker;
    if (worker.closed || !worker.client.isAlive) return;
    let state: PiSessionState;
    try { state = await this.refreshState(worker); } catch { await this.dropUnconfirmedQueue(turn); return; }
    // A run that is going (an extension's own) owns its queue.
    if (state.isStreaming || !state.pendingMessageCount) return;
    let cleared: { steering: string[]; followUp: string[] };
    try { cleared = await worker.client.request({ type: "clear_queue" }, { timeoutMs: 3_000 }); } catch { await this.dropUnconfirmedQueue(turn); return; }
    worker.queue = { steering: [], followUp: [] };
    this.publishState(worker);
    await this.handBack(turn, cleared, "late");
  }

  private handBackNote(turn: Turn, locale: string): string | undefined {
    const count = turn.handedBack;
    const parts: string[] = [];
    if (count > 0) parts.push(
      count === 1
        ? hostT(locale, "[Pi] 有 1 条补充没有送达模型，已收回，全文见本轮运行过程，未自动重发。")
        : hostT(locale, "[Pi] 有 {0} 条补充没有送达模型，已收回，全文见本轮运行过程，未自动重发。", count),
    );
    if (turn.queueUnconfirmed) parts.push(hostT(locale, "[Pi] Pi 没有确认是否还留有本轮的补充，已结束该 Pi 进程，未自动重发；请核对补充是否已被采纳。"));
    return parts.length ? parts.join("\n") : undefined;
  }

  /**
   * Pi did not confirm what it still holds. Its queue lives only in this
   * process, so the process is ended: nothing can reach the next turn. This
   * says what is known and does not claim the input was never applied.
   */
  private async dropUnconfirmedQueue(turn: Turn): Promise<void> {
    const worker = turn.worker, loc = turn.input.locale ?? "en";
    turn.queueUnconfirmed = true;
    await this.emit(turn, { type: "assistant_text", sessionId: worker.sessionId, text: hostT(loc, "[Pi] Pi 没有确认它是否还留有本轮的补充。为避免带入下一轮，已结束这个 Pi 进程（会话记录保留）。请核对本轮回复，确认补充是否已被采纳。") });
    await this.closeWorker(worker, { terminate: true });
  }

  /**
   * Show undelivered queued input to the owner, in full, exactly as Pi's
   * `clear_queue` reports it (a template or skill appears expanded, as Pi held
   * it). It is never sent again on its own.
   */
  private async handBack(turn: Turn, cleared: { steering: string[]; followUp: string[] }, reason: "late" | "stopped"): Promise<void> {
    const worker = turn.worker;
    const texts = [...cleared.steering, ...cleared.followUp].filter(text => text.trim());
    if (!texts.length) return;
    turn.handedBack += texts.length;
    const loc = turn.input.locale ?? "en";
    const shown = texts.map(text => `- ${text}`).join("\n");
    const head = hostT(
      loc,
      reason === "stopped"
        ? "[Pi] 停止时这些补充还没有送达模型，已收回，不会自动重发："
        : "[Pi] 这些补充在本轮回复结束后才到达，没有送达模型，已收回，不会自动重发：",
    );
    worker.ui.editorText = { text: texts.join("\n\n"), revision: ++worker.editorRevision };
    this.publish(worker.sessionId, { type: "editor_text", text: texts.join("\n\n") });
    // Taken-back input is shown, never acted on, should the Host take this block as the answer.
    await this.emit(turn, { type: "assistant_text", text: this.shownNotExecuted(`${head}\n${shown}`, turn.input.locale), sessionId: worker.sessionId });
  }

  async validateExternalSession(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<ExternalSessionInfo> {
    this.assertUsable();
    const cwd = await this.resolveWorkspace(input.workspaceOverride);
    const live = this.workers.get(sessionId);
    if (live && !live.closed) {
      if (!samePiWorkspace(live.cwd, cwd)) throw new Error(`Pi session ${sessionId} belongs to another workspace`);
      return { sessionId, cwd: live.cwd, ...(live.state.sessionName ? { title: live.state.sessionName } : {}) };
    }
    const file = await this.store.find(sessionId, cwd);
    if (!file) throw new Error(`Pi session ${sessionId} was not found for this workspace`);
    if (!samePiWorkspace(file.cwd, cwd)) throw new Error(`Pi session ${sessionId} belongs to another workspace`);
    if (file.origin === "native") await this.store.updateRecord(sessionId, { externalPath: file.path });
    return { sessionId, cwd: file.cwd, ...(file.name ? { title: file.name } : {}), updatedAt: file.updatedAt };
  }

  // ---- Native history: fork ---------------------------------------------------
  // Pi's `fork` and `clone` move the process that runs them to the new session.
  // A fork that must leave its source alone is therefore made by a second,
  // short-lived Pi on the same session file. Rewinding is not offered: Pi keeps
  // a move in its tree in memory until the next entry is written, so it would
  // be lost whenever this process is replaced.
  //
  // No `history_anchor` is emitted. Pi's answer to `prompt` is a disposition
  // only, and an input hook or an extension's own `sendUserMessage` can add a
  // user entry before the prompt's: nothing Pi reports says which entry a
  // given prompt became. Forking from a message stays with Pi's own `/fork`,
  // where the owner picks from Pi's list.

  /** The process to ask about a session's history. Never starts Pi for an id it has no file for: that would create the session. */
  private async historySource(sessionId: string, workspaceOverride?: string): Promise<{ worker: Worker; cwd: string } | { blocked: "source_missing" | "not_ready"; detail?: string }> {
    try {
      this.assertUsable();
      const cwd = await this.resolveWorkspace(workspaceOverride);
      const live = this.workers.get(sessionId);
      if (!live || live.closed) {
        const file = await this.store.find(sessionId, cwd);
        if (!file || !samePiWorkspace(file.cwd, cwd)) return { blocked: "source_missing" };
      }
      const worker = await this.ensureWorker(sessionId, cwd);
      if (!worker.turn) worker.touchedBy = "a conversation history read";
      return { worker, cwd };
    } catch (error) {
      return { blocked: "not_ready", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async getHistoryState(sessionId: string, input: { workspaceOverride?: string; signal?: AbortSignal } = {}): Promise<NativeHistoryState> {
    const source = await this.historySource(sessionId, input.workspaceOverride);
    if ("blocked" in source) return { head: null, blocked: source.blocked };
    const { worker } = source;
    if (worker.turn || worker.exclusive) return { head: null, blocked: "busy" };
    try {
      const state = await this.refreshState(worker);
      const { entries, leafId } = await worker.client.request({ type: "get_entries" }, { timeoutMs: 30_000 });
      const blocked = state.isStreaming || state.isCompacting || state.pendingMessageCount > 0 || worker.dialogs.size > 0 || worker.turn || worker.exclusive;
      return {
        fork: { whole: leafId !== null && entries.at(-1)?.id === leafId, anchored: false },
        head: leafId ?? PI_EMPTY_HISTORY_HEAD, ...(blocked ? { blocked: "busy" as const } : {}),
      };
    } catch {
      return { head: null, blocked: "not_ready" };
    }
  }

  async forkHistory(sessionId: string, input: {
    anchor?: NativeHistoryAnchor; expectedHead?: string | null; workspaceOverride?: string; signal?: AbortSignal;
  } = {}): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    const anchor = input.anchor;
    if (input.signal?.aborted) return rejected("cancelled");
    if (anchor && !(anchor.fork && anchor.forkBoundary === "before-input")) return rejected("anchor_unavailable", "The anchor does not allow this operation");
    if (anchor && anchor.sessionId !== sessionId) return rejected("anchor_unavailable", "The anchor belongs to another session");
    const source = await this.historySource(sessionId, input.workspaceOverride);
    if ("blocked" in source) return rejected(source.blocked, source.detail);
    const { worker, cwd } = source;
    // A turn that has not prompted yet does not make Pi busy, but it is about to.
    if (worker.turn) return rejected("busy");
    try {
      // While this holds, no turn starts on the source: its file does not change under the second process.
      return await this.exclusive(worker, "fork", async () => {
        if (worker.dialogs.size > 0 || worker.state.pendingMessageCount > 0) return rejected("busy");
        const { entries, leafId } = await worker.client.request({ type: "get_entries" }, { timeoutMs: 30_000 });
        if (input.expectedHead !== undefined && input.expectedHead !== (leafId ?? PI_EMPTY_HISTORY_HEAD)) return rejected("source_changed");
        if (anchor) {
          // On the branch the owner is on now, not merely somewhere in the file.
          const branch = piActiveBranch(entries, leafId), at = branch.findIndex(entry => entry.id === anchor.inputId && isPiUserEntry(entry));
          if (at < 0) return rejected("anchor_unavailable", "The anchor is no longer on this session's current branch");
          // Pi writes a session to disk only once it holds an assistant message: a fork from before the first answer would have no file.
          if (!branch.slice(0, at).some(entry => entry.type === "message" && entry.message?.role === "assistant")) {
            return rejected("anchor_unavailable", "There is nothing before this message to fork");
          }
        } else {
          if (leafId === null) return rejected("not_ready", "There is no history to fork yet");
          // The second process sees the position Pi has written, which is the file's last entry.
          if (entries.at(-1)?.id !== leafId) return rejected("not_ready", "Pi has not saved this session's current position yet. Send a message first.");
        }
        const file = worker.state.sessionFile;
        if (!file || !await isExistingFile(file)) return rejected("not_ready", "Pi has not saved this session yet");
        if (input.signal?.aborted) return rejected("cancelled");
        return await this.forkInSecondProcess(sessionId, file, cwd, anchor ? { type: "fork", entryId: anchor.inputId } : { type: "clone" }, leafId);
      });
    } catch (error) {
      // Everything after the second process starts is returned, not thrown: nothing was asked of Pi here.
      if (error instanceof PiNativeBusyError) return rejected("busy");
      return rejected("not_ready", error instanceof Error ? error.message : String(error));
    }
  }

  private forkInSecondProcess(
    sourceId: string, file: string, cwd: string, command: { type: "fork"; entryId: string } | { type: "clone" }, sourceLeaf: string | null,
  ): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    const text = (error: unknown) => error instanceof Error ? error.message : String(error);
    let helper: PiRpcClient | undefined;
    const starting = new AbortController();
    const run = async (): Promise<NativeHistoryResult> => {
      try {
        if (this.destroyed) return rejected("not_ready", "Pi adapter has been destroyed");
        helper = await PiRpcClient.start({
          launch: this.options.launch, cwd, signal: starting.signal,
          // The handle from the moment the process exists: a startup that fails or is cancelled still leaves a process to wait for.
          onSpawned: client => { helper = client; this.historyHelperClients.add(client); },
          // No extensions: nothing of the owner's runs here, and nothing can open a dialog nobody would answer.
          args: ["--session-dir", this.store.sessionDir, "--session", file, "--no-extensions"],
          env: { ...this.options.childEnv },
          onExtensionUi: (request, peer) => { if (isPiDialog(request)) peer.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true }); },
          ...(this.options.startupTimeoutMs ? { startupTimeoutMs: this.options.startupTimeoutMs } : {}),
          ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
          ...(this.options.killProcessTreeFn ? { killProcessTreeFn: this.options.killProcessTreeFn } : {}),
        });
      } catch (error) {
        return rejected("not_ready", text(error));
      }
      // Before the fork is asked for: any failure leaves Pi's sessions as they were.
      try {
        if (this.destroyed) return rejected("not_ready", "Pi adapter has been destroyed");
        const opened = await helper.request({ type: "get_state" }, { timeoutMs: 15_000 });
        if (opened.sessionId !== sourceId) return rejected("not_ready", "Pi opened a different session than the one to fork");
        const seen = await helper.request({ type: "get_entries" }, { timeoutMs: 30_000 });
        if (command.type === "clone" && seen.leafId !== sourceLeaf) return rejected("not_ready", "Pi has not saved this session's current position yet. Send a message first.");
        if (command.type === "fork" && !seen.entries.some(entry => entry.id === command.entryId)) return rejected("anchor_unavailable", "Pi has not saved that message yet");
        if (this.destroyed) return rejected("not_ready", "Pi adapter has been destroyed");
      } catch (error) {
        return rejected("not_ready", text(error));
      }
      // The fork itself. Only Pi's own answer to this one command is a refusal.
      try {
        const result = await helper.request(command, { timeoutMs: 60_000 });
        if (result.cancelled) return rejected("not_ready", "Pi cancelled the fork");
      } catch (error) {
        if (error instanceof PiRpcCommandError) return rejected(/invalid entry id/i.test(error.message) ? "anchor_unavailable" : "not_ready", error.message);
        return { outcome: "unknown", detail: text(error) };
      }
      // Pi has forked. From here a failure never means "nothing happened".
      let forked: string | undefined;
      try {
        const state = await helper.request({ type: "get_state" }, { timeoutMs: 15_000 });
        forked = state.sessionId;
        if (!forked || forked === sourceId || !isSafePiSessionId(forked)) return { outcome: "unknown", detail: "Pi did not report a distinct, addressable session for the fork" };
        // Pi writes a session file only once it holds an assistant message. An id without a file cannot be opened again.
        if (!state.sessionFile || !await isExistingFile(state.sessionFile)) {
          return { outcome: "unknown", detail: "Pi has not written the forked session to disk", candidateSessionId: forked };
        }
        let head: string | null = null;
        try { head = (await helper.request({ type: "get_entries" }, { timeoutMs: 30_000 })).leafId ?? PI_EMPTY_HISTORY_HEAD; } catch { /* The fork is confirmed; only its head could not be read. */ }
        // A retired adapter records nothing more. The new session exists in Pi; the caller is told so, not that it is theirs.
        if (this.destroyed) return { outcome: "unknown", detail: "Pi adapter was destroyed while the fork was being recorded", candidateSessionId: forked };
        await this.store.inheritRecord(sourceId, forked);
        const forkedFile = path.resolve(state.sessionFile);
        if (path.dirname(forkedFile) !== this.store.sessionDir) await this.store.updateRecord(forked, { externalPath: forkedFile });
        return { outcome: "applied", sessionId: forked, head, boundary: command.type === "fork" ? "before-input" : "whole" };
      } catch (error) {
        return { outcome: "unknown", detail: text(error), ...(forked ? { candidateSessionId: forked } : {}) };
      }
    };
    // run() has spawned the process by the time it first waits, and this line follows without a turn of the
    // event loop: there is no moment at which the process exists and the adapter does not know of it.
    const work: Promise<NativeHistoryResult> = run().finally(async () => {
      if (helper) {
        // Gone before this returns: the new session's file must not have a writer when it is next opened.
        await helper.close({ graceMs: 2_000 }).catch(() => undefined);
        await Promise.race([helper.exited, sleep(8_000)]);
        this.historyHelperClients.delete(helper);
      }
      this.historyHelpers.delete(starting);
    });
    this.historyHelpers.set(starting, work);
    return work;
  }

  async listExternalSessions(input: { cwd?: string; limit?: number } = {}): Promise<ExternalSessionInfo[]> {
    this.assertUsable();
    const sessions = await this.store.list({ cwd: await this.resolveWorkspace(input.cwd), ...(input.limit ? { limit: input.limit } : {}) });
    return sessions.map(session => ({
      sessionId: session.sessionId, cwd: session.cwd, updatedAt: session.updatedAt, ...(session.name ? { title: session.name } : {}),
    }));
  }

  async getContextUsage(sessionId: string, input: { workspaceOverride?: string; passive?: boolean } = {}): Promise<EngineContextUsage | null> {
    this.assertUsable();
    const read = async (worker: Worker): Promise<EngineContextUsage | null> => {
      const context = (await worker.client.request({ type: "get_session_stats" })).contextUsage;
      return context ? { ...(typeof context.tokens === "number" ? { pressureTokens: context.tokens } : {}), contextWindow: context.contextWindow } : null;
    };
    if (input.passive) {
      // A reading for display asks only a process that is already running, does not count as using it,
      // and has no answer when that process cannot give one (it may be ending).
      const live = this.workers.get(sessionId);
      if (!live || live.closed || !live.client.isAlive) return null;
      try { return await read(live); } catch { return null; }
    }
    const worker = await this.ensureWorker(sessionId, await this.resolveWorkspace(input.workspaceOverride));
    if (!worker.turn) worker.touchedBy = "a context usage read";
    return read(worker);
  }

  /** Ends this session's Pi process; the next turn starts a new one on the same session file. */
  async restartSession(sessionId: string, options?: EngineSessionRestartOptions): Promise<EngineSessionRestartResult> {
    const worker = this.workers.get(sessionId);
    const startup = this.starting.get(sessionId);
    const client = worker?.client ?? startup?.client;
    const closing = this.sessionRestarts.close(sessionId, client?.isAlive && !this.sessionRestartPending(sessionId) ? {
      exited: client.exited,
      stop: async () => {
        if (worker && !worker.closed) {
          if (worker.turn && !worker.turn.done.settled) worker.turn.stopRequested = true;
          await this.closeWorker(worker, { graceMs: APP_STOP_PROCESS_GRACE_MS });
        } else if (client.isAlive) {
          client.terminate();
        }
      },
    } : undefined, options?.beforeStop);
    startup?.controller.abort();
    await startup?.work.catch(() => undefined);
    return closing;
  }

  sessionRestartPending(sessionId: string): Promise<void> | undefined {
    return this.sessionRestarts.exiting(sessionId);
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    this.assertUsable();
    if (input.abortSignal?.aborted) throw abortError();
    const cwd = await this.resolveWorkspace(input.workspaceOverride);
    // A stop ends this wait at once. A start already past Pi's handshake goes on and is kept for the next message.
    const first = await untilAborted(this.ensureWorker(sessionId, cwd, input.abortSignal), input.abortSignal);
    // Readying the workspace and the process can outlast the request. A stop that came meanwhile would
    // never reach a listener attached from here on, so no turn begins. Nothing has been sent to Pi, and
    // the process is left as it is: another caller may have started it.
    if (input.abortSignal?.aborted) throw abortError();
    if (first.turn) throw new Error("Pi session already has a turn in progress");
    if (first.exclusive) throw new PiNativeBusyError(first.exclusive);
    const turn = this.beginTurn(first, input);
    try {
      // An extension may have replaced the session while nobody was looking.
      await this.reconcileSession(turn.worker);
      const runtime = await this.loadRuntime(input.engineOverride);
      await this.resolveProjectTrust(turn, cwd);
      await this.applyGate(turn.worker, runtime.gate);
      // A command is only ever what the owner typed for this turn: `input.text` may carry context the Host
      // appended for a model (a quoted message, a transcript), and a message that is not the owner's own has
      // no authored text at all. Pi's editor trims before it looks for `/` or `!` (interactive-mode.ts:3327).
      const text = this.authoredCommand(input);
      const command = text ? parsePiSlashCommand(text) : undefined;
      const canRepairDefaults = !runtime.ticket && command
        && (command.name === "model" || command.name === "thinking" || command.name === "session" && !command.args);
      let defaultsNotice = "";
      let rejectedDefault: PiNativeRejectedError | undefined;
      // Same queue as the conversation's own model controls: a default being applied and a choice being made never interleave.
      try {
        await this.unlessStopped(turn, this.settingsTask(turn.worker, turn.worker.sessionId, false, undefined, scope => this.applyModelSettings(turn.worker, runtime, scope)));
      } catch (error) {
        // A confirmed incompatible/unavailable default must not block its own
        // recovery controls. I/O failures, stale ownership and uncertain native
        // writes still fail the turn; normal prompts and extensions do as well.
        if (!canRepairDefaults || !(error instanceof PiNativeRejectedError)
          || (error.reason !== "thinking-unsupported" && error.reason !== "model-unavailable")) throw error;
        rejectedDefault = error;
        defaultsNotice = hostT(input.locale ?? "en", "Bot 默认设置暂时无法应用。可以用 /model 或 /thinking 调整当前对话。");
      }
      this.throwIfStopped(turn);
      await this.emit(turn, { type: "session", sessionId: turn.worker.sessionId });
      this.flushBacklog(turn);

      if (text.startsWith("/") || text.startsWith("!")) {
        const handled = await this.unlessStopped(turn, this.runNativeCommand(turn, text, runtime.gate));
        if (handled.handled) {
          this.throwIfStopped(turn);
          const current = handled.sessionId ?? turn.worker.sessionId;
          if (current !== sessionId) await this.emit(turn, { type: "session", sessionId: current });
          const text = this.withExtensionErrorNotice(turn, [defaultsNotice, this.shownNotExecuted(handled.text, input.locale)].filter(Boolean).join("\n\n"));
          await this.emit(turn, { type: "result", text, sessionId: current });
          await turn.emitChain;
          return { text, sessionId: current };
        }
      }
      if (rejectedDefault) throw rejectedDefault; // Recovery may never fall through to a model prompt.
      return await this.runPrompt(turn);
    } catch (error) {
      // The turn is over for the Host only once the stop is confirmed: Pi settled, or its process was ended.
      if (turn.stopping) await turn.stopping;
      // Model calls that completed before the failure were billed; the Host's ledger records them too.
      const usage = turn.mapper.usage;
      if (turn.timedOut) throw withFailedTurnUsage(new Error(turn.timedOut), usage);
      if (turn.stopRequested) throw withFailedTurnUsage(abortError(), usage);
      throw withFailedTurnUsage(this.publicError(error), usage);
    } finally {
      this.endTurn(turn);
    }
  }

  private readonly quotaRevision = randomUUID();

  /** Pi 1.6.x exposes only local session token/cost stats (`get_session_stats`) and no provider account
   * quota RPC; report `mode_not_supported` explicitly rather than "not yet implemented". */
  async getAccountQuota(_options: EngineQuotaReadOptions): Promise<EngineQuotaReadResult> {
    return {
      revision: this.quotaRevision,
      snapshot: unavailableQuota("pi", "mode_not_supported", Date.now(), "other"),
    };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.retiring.abort();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    // A start in flight sees `destroyed` and closes what it created; wait so no process outlives the adapter.
    await Promise.allSettled([...this.starting.values()].map(start => start.work));
    // A fork in a second process is cut short: its caller reports an unknown outcome and writes nothing more.
    // One still starting is cancelled; one that started is ended the way a worker is.
    for (const starting of this.historyHelpers.keys()) starting.abort(new Error("Pi adapter has been destroyed"));
    await Promise.allSettled([...this.historyHelperClients].map(helper => helper.close({ graceMs: 3_000 })));
    await Promise.allSettled([...this.historyHelpers.values()]);
    const workers = [...this.workers.values()];
    this.workers.clear();
    // Ending a process under a running turn is not that turn finishing: what it streamed so far is not an answer.
    for (const worker of workers) worker.turn?.done.reject(destroyedTurnError());
    await Promise.all(workers.map(worker => this.closeWorker(worker, { graceMs: 3_000 })));
  }

  // ---------------------------------------------------------------- turns

  private beginTurn(worker: Worker, input: CodexUserMessageInput): Turn {
    const turn: Turn = {
      worker, input, mapper: new PiTurnMapper(worker.sessionId), scope: new AbortController(), done: deferred<void>(), stopped: deferred<void>(),
      notices: [], extensionErrors: 0, emitChain: Promise.resolve(), humanWaits: 0, stopRequested: false,
      liveWork: new Set(), liveChain: Promise.resolve(), liveQueued: 0, wrappingUp: false, handedBack: 0,
    };
    worker.turn = turn;
    worker.lastUsedAt = Date.now();
    worker.touchedBy = undefined;
    // Everything below addresses `turn.worker`, never the process this turn happened to start on.
    const stop = () => { void this.stopTurn(turn); };
    input.abortSignal?.addEventListener("abort", stop, { once: true });
    turn.scope.signal.addEventListener("abort", () => input.abortSignal?.removeEventListener("abort", stop), { once: true });
    if (this.turnRuntimeLimitMs && !input.disableRuntimeTimeout) {
      const limit = this.turnRuntimeLimitMs;
      turn.turnTimer = setTimeout(() => { turn.timedOut = `Pi turn timed out after ${minutes(limit)}`; void this.stopTurn(turn); }, limit);
      turn.turnTimer.unref?.();
    }
    this.noteActivity(turn);
    // An abort that came before the listener was attached is never delivered to it.
    if (input.abortSignal?.aborted) stop();
    return turn;
  }

  private endTurn(turn: Turn): void {
    const worker = turn.worker;
    clearTimeout(turn.turnTimer);
    clearTimeout(turn.inactivityTimer);
    turn.done.resolve();
    turn.scope.abort();
    if (worker.turn === turn) worker.turn = undefined;
    worker.lastUsedAt = worker.lastTurnAt = Date.now();
    worker.touchedBy = undefined;
    // A dialog nobody will answer must not leave an extension waiting forever.
    this.cancelDialogs(worker);
  }

  private cancelDialogs(worker: Worker): void {
    for (const request of worker.dialogs.values()) worker.client.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
    worker.dialogs.clear();
  }

  private noteActivity(turn: Turn): void {
    turn.worker.lastUsedAt = Date.now();
    clearTimeout(turn.inactivityTimer);
    const limit = this.inactivityTimeoutMs;
    if (!limit || turn.input.disableRuntimeTimeout || turn.done.settled || turn.stopRequested) return;
    turn.inactivityTimer = setTimeout(() => {
      if (turn.humanWaits > 0) { this.noteActivity(turn); return; }
      turn.timedOut = `Pi turn became inactive after ${minutes(limit)}`;
      void this.stopTurn(turn);
    }, limit);
    turn.inactivityTimer.unref?.();
  }

  private throwIfStopped(turn: Turn): void {
    if (turn.stopRequested) throw abortError();
    // A step that lost its process to `destroy` may still have returned: the command layer turns that loss into reply text.
    if (this.destroyed) throw destroyedTurnError();
  }

  /** Await `work`, but give up as soon as the turn is stopped. The work itself is not cancelled by this. */
  private async unlessStopped<T>(turn: Turn, work: Promise<T>): Promise<T> {
    work.catch(() => {});
    const outcome = await Promise.race([work.then(value => ({ value })), turn.stopped.promise.then(() => undefined)]);
    if (!outcome) throw abortError();
    return outcome.value;
  }

  private emit(turn: Turn, event: EngineStreamEvent): Promise<void> {
    const handler = turn.input.onEngineEvent;
    if (!handler) return turn.emitChain;
    turn.emitChain = turn.emitChain.then(() => handler(event)).then(() => undefined, () => undefined);
    return turn.emitChain;
  }

  private runNativeCommand(turn: Turn, text: string, gate: boolean): Promise<PiNativeCommandResult> {
    const worker = turn.worker, input = turn.input;
    return runPiNativeCommand(text, {
      sessionId: worker.sessionId, controls: this.piNative, locale: input.locale ?? "en",
      approvalMode: gate ? "normal" : "bypass",
      ...(input.onApprovalRequest ? { ask: question => this.askCommandQuestion(turn, question), approveBash: command => this.approveUserBash(turn, command) } : {}),
      ...(input.requestOutputDir ? { outputDir: input.requestOutputDir } : {}),
      // Pi's effective settings through the bridge (`pi.getSettings()`); credentials live elsewhere and are never read.
      ...(worker.bridge?.isOpen ? { readNativeSettings: () => worker.bridge!.readSettings() } : {}),
      abortSignal: turn.scope.signal,
    });
  }

  /**
   * A built-in or `!` typed while the model is running. Its reply joins the
   * running turn's stream; the turn does not end before it. `onAdmitted` is
   * called when the command starts waiting for the owner or the shell.
   *
   * `!` keeps the idle path's rules: Normal mode asks each time and is
   * refused when nobody can be asked; the command goes to the session it was
   * typed for (a replaced session is not found, never substituted), is sent
   * once, and has no deadline that could lead to sending it again.
   */
  private async runCommandDuringRun(worker: Worker, turn: Turn, text: string, name: string, onAdmitted: () => void = () => {}): Promise<void> {
    const loc = turn.input.locale ?? "en";
    let reply: string;
    if (name !== "!" && PI_TUI_BUILTIN_COMMANDS[name] !== "terminal" && !PI_LIVE_COMMANDS.has(name)) {
      reply = hostT(loc, "/{0} 需要等当前回复结束后再执行。", name);
    } else {
      try {
        const sessionId = worker.sessionId;
        const controls: PiNativeControls = { ...this.piNative, runUserBash: (id, bash) => { onAdmitted(); return this.piNative.runUserBash(id, bash); } };
        const result = await runPiNativeCommand(text, {
          sessionId, controls, locale: turn.input.locale ?? "en",
          approvalMode: worker.gate === false ? "bypass" : "normal",
          ...(turn.input.onApprovalRequest ? {
            ask: question => { onAdmitted(); return this.askCommandQuestion(turn, question); },
            approveBash: command => { onAdmitted(); return this.approveUserBash(turn, command); },
          } : {}),
          abortSignal: turn.scope.signal,
        });
        reply = result.handled ? result.text : "";
      } catch (error) {
        reply = sanitizePiErrorText(error instanceof Error ? error.message : String(error));
      }
    }
    // Whatever this says (a command's answer, or native error text that repeats what was typed), it is the
    // adapter's own line in the stream: shown, never an instruction to the Host.
    reply = this.shownNotExecuted(reply, turn.input.locale);
    // A stopped turn reports its own outcome; anything else is still part of this turn.
    if (reply && !turn.scope.signal.aborted) await this.emit(turn, { type: "assistant_text", text: reply, sessionId: worker.sessionId });
  }

  private async runPrompt(turn: Turn): Promise<CodexAdapterResponse> {
    const worker = turn.worker, input = turn.input, sessionId = worker.sessionId, locale = input.locale ?? "en";
    // A command (an extension's, a template, `/skill:`) is sent trimmed and bare, so Pi dispatches it rather than reading prose.
    const commandText = this.authoredCommand(input);
    const sessionCommand = Boolean(commandText && parsePiSlashCommand(commandText));
    let instructions = input.instructions, turnInstructions = input.turnInstructions;
    if (input.appPlatformTools) {
      let installed = false;
      if (worker.bridge?.isOpen) {
        try {
          const result = await this.unlessStopped(turn, worker.bridge.installTools(input.appPlatformTools.definitions));
          // All or nothing: instructions that promise a tool the model cannot call would mislead it.
          installed = result.skipped.length === 0 && result.installed.length === input.appPlatformTools.definitions.length;
        } catch { installed = false; }
      }
      this.throwIfStopped(turn);
      if (installed) {
        turn.appTools = input.appPlatformTools;
        instructions = input.appPlatformTools.instructions;
        turnInstructions = input.appPlatformTools.turnInstructions;
      } else {
        await this.emit(turn, { type: "assistant_text", sessionId, text: hostT(locale, "当前 Pi 会话的原生 App 工具不可用，本轮使用兼容交付。") });
      }
    }
    // Stable instructions ride in the system prompt (through the bridge) so they stay out of the transcript and cacheable.
    const viaBridge = Boolean(worker.bridge?.isOpen);
    // A command goes out bare so Pi dispatches it; the turn's private guidance then rides with this run's system prompt.
    turn.instructions = viaBridge ? [instructions?.trim(), sessionCommand ? turnInstructions?.trim() : undefined].filter(Boolean).join("\n\n") || undefined : undefined;
    let text = sessionCommand ? await this.sessionCommandLine(turn, commandText) : prependPrivateTurnInstructions(input.text, turnInstructions);
    this.throwIfStopped(turn);
    if (!viaBridge && !sessionCommand && instructions?.trim()) {
      text = `<private_bridge_instructions>\nFollow these instructions silently. Do not quote or describe them.\n${instructions.trim()}\n</private_bridge_instructions>\n\n${text}`;
    }
    // Pi dispatches a message as a command when its first character is "/" (agent-session.ts:2171,
    // prompt-templates.ts:326; the RPC layer passes the message as it is). Everything that is not the
    // owner's own command is prose, whatever it begins with.
    if (!sessionCommand && text.startsWith("/")) text = `\n${text}`;
    const acceptsImages = Boolean(worker.state.model?.input?.includes("image"));
    const prompt = await buildPiPrompt({ text, files: input.files, modelAcceptsImages: acceptsImages });
    this.throwIfStopped(turn);
    const imageNotice = piSkippedImagesNotice(prompt.skippedImages, locale);
    if (imageNotice) this.publishUi(worker, { type: "notify", level: "warning", text: imageNotice }, "host");

    // Pi answers `prompt` only after its extension and input preflight, which can take arbitrarily long.
    // The request is kept unbounded and raced against a stop, so a stop never waits on that preflight.
    const request = worker.client.request({
      type: "prompt", message: prompt.message,
      ...(prompt.images.length ? { images: prompt.images } : {}),
      // A run this turn did not start (an extension's own message) is still going: join it instead of failing.
      ...(worker.state.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
    });
    turn.promptOutcome = request.then(result => result.disposition, () => "failed" as const);
    const response = await this.unlessStopped(turn, request);
    this.noteActivity(turn);
    if (response.disposition === "handled") {
      // An extension command ran. It may have replaced the session or started a run of its own.
      const state = await this.refreshState(worker).catch(() => worker.state);
      if (!state.isStreaming && !(turn.mapper.runStarted && !turn.mapper.settled)) turn.done.resolve();
    }
    await this.unlessStopped(turn, turn.done.promise);
    // Input accepted during the run is answered within this turn; whatever Pi parked after the run is handed back
    // rather than delivered into the next one.
    await this.unlessStopped(turn, this.drainLiveWork(turn));
    await this.unlessStopped(turn, this.handBackParked(turn));
    await turn.emitChain;
    if (turn.stopRequested || turn.mapper.settled?.aborted) throw abortError();

    const last = turn.mapper.lastAssistant;
    if (last?.stopReason === "error") {
      // Typed, so the Host can tell a provider status reported by Pi (a bare "429") from unrelated text. Only sanitized text is carried.
      const raw = last.errorMessage ?? "";
      // The provider's own status and explanation travel with it, so the owner is told what the provider said.
      throw new PiRpcCommandError("prompt", sanitizePiErrorText(raw) || "Pi model request failed", classifyPiError(raw), piProviderFailure(raw));
    }
    const current = await this.reconcileSession(worker).catch(() => worker.sessionId);
    if (current !== sessionId) await this.emit(turn, { type: "session", sessionId: current });
    // Extension notices are external/tool text, not an assistant instruction to send files or run Host commands.
    let finalText = turn.mapper.finalText || (turn.notices.length
      ? hostT(locale, "Pi 扩展发出了提示，详情见本轮运行过程。")
      : "");
    // An extension command that printed nothing still gets a visible answer; an empty reply reads as a failure.
    if (!finalText && response.disposition === "handled" && !turn.mapper.runStarted) {
      finalText = hostT(locale, "命令已执行，没有输出。");
    }
    // The final answer is what the Host shows and acts on (card-renderer finalAnswerText). It carries a count only:
    // the taken-back text stays in this turn's run details, so nothing the owner typed is replayed as the reply.
    const note = this.handBackNote(turn, locale);
    if (note) finalText = finalText.trim() ? `${finalText}\n\n${note}` : note;
    finalText = this.withExtensionErrorNotice(turn, finalText);
    await this.emit(turn, { type: "result", text: finalText, sessionId: current });
    await turn.emitChain;
    return { text: finalText, sessionId: current, ...(turn.mapper.usage ? { usage: turn.mapper.usage } : {}) };
  }

  /**
   * A native command's reply can echo anything: the last reply (`/copy`), a
   * session name, a typed argument, an entry's text. When the Host would act
   * on something in it, the whole reply goes out as one literal block, which
   * every Host parser reads as displayed text; nothing is hidden or rewritten.
   * Should even that still read as an instruction, the text is withheld.
   */
  private shownNotExecuted(text: string, locale: string | undefined): string {
    const carries = this.options.carriesHostDirectives;
    if (!text || !carries || !carries(text)) return text;
    // Longer than any backtick run inside, so nothing in the text can close it. Counted in a loop:
    // a long reply can hold more runs than a call can take as arguments.
    let longest = 2;
    for (const run of text.match(/`+/g) ?? []) if (run.length > longest) longest = run.length;
    const fence = "`".repeat(longest + 1);
    const literal = `${fence}\n${text}\n${fence}`;
    if (!carries(literal)) return literal;
    return hostT(locale ?? "en", "[Pi] 这条命令的回复里有会被当作投递指令的文本，没有在这里显示。");
  }

  /** What the owner typed for this turn, trimmed, when it can be a command at all: their own message, without files. */
  private authoredCommand(input: CodexUserMessageInput): string {
    return input.files.length === 0 ? (input.authoredText ?? "").trim() : "";
  }

  /**
   * The line Pi dispatches for an extension command, a prompt template or a
   * skill. Context the Host appended to the message (a quoted message, a
   * transcript) is for a model to read. A template or skill expands into a
   * model prompt, so it receives that context as further arguments. An
   * extension command is code and receives only what was typed. Text Pi does
   * not know as a command is prose and goes out as composed.
   */
  private async sessionCommandLine(turn: Turn, authored: string): Promise<string> {
    const composed = turn.input.text.trim();
    const context = composed.startsWith(authored) ? composed.slice(authored.length).trim() : "";
    if (!context) return authored;
    const name = parsePiSlashCommand(authored)!.name;
    let commands: PiNativeCommand[];
    // Unanswered, the kind is unknown: the typed line alone is the safe reading.
    try { commands = await this.unlessStopped(turn, this.nativeCommands(turn.worker)); }
    catch (error) { if (turn.stopRequested) throw error; return authored; }
    const source = commands.find(command => command.name === name)?.source;
    if (!source) return composed;
    return source === "extension" ? authored : `${authored} ${context}`;
  }

  /**
   * Native Esc: take the queued messages back, abort, and end the process if
   * Pi does not come to rest within the grace period. That includes a prompt
   * still inside extension or input preflight, which `abort` cannot reach.
   */
  private stopTurn(turn: Turn): Promise<void> {
    turn.stopping ??= (async () => {
      turn.stopRequested = true;
      clearTimeout(turn.inactivityTimer);
      turn.scope.abort();
      turn.stopped.resolve();
      const worker = turn.worker, grace = this.cancelGraceMs;
      this.cancelDialogs(worker);
      if (worker.closed || !worker.client.isAlive) { turn.done.resolve(); return; }
      try {
        const cleared = await worker.client.request({ type: "clear_queue" }, { timeoutMs: Math.min(grace, 3_000) });
        worker.queue = { steering: [], followUp: [] };
        if (cleared.steering.length || cleared.followUp.length) {
          this.publishState(worker);
          // Pi's Esc puts queued messages back into the editor (interactive-mode.ts:2104, 2400); they are not dropped here either.
          await this.handBack(turn, cleared, "stopped");
        }
      } catch { /* the abort below still applies */ }
      // `abort` also cancels a retry wait, a compaction and a branch summary.
      const abort = () => worker.client.request({ type: "abort" }, { timeoutMs: grace }).then(() => true, () => false);
      await abort();
      const deadline = Date.now() + grace;
      const within = async <T>(work: Promise<T>): Promise<T | undefined> => Promise.race([work, sleep(Math.max(0, deadline - Date.now())).then(() => undefined)]);
      // A prompt still in preflight may yet start a run; wait for its real answer before calling the session quiet.
      const outcome = turn.promptOutcome ? await within(turn.promptOutcome) : "none";
      if (outcome === undefined) { await this.closeWorker(worker, { terminate: true }); turn.done.resolve(); return; }
      if (outcome === "started" && !turn.mapper.settled) await abort();
      const running = (turn.mapper.runStarted || outcome === "started") && !turn.mapper.settled;
      if (running && (await within(turn.done.promise.then(() => true, () => true))) === undefined) {
        // The process is gone after this, so the stop is confirmed either way.
        await this.closeWorker(worker, { terminate: true });
        turn.done.resolve();
        return;
      }
      // A steer still in flight can be queued after the first clear (an input hook may take its time).
      // Wait for every answer, then clear once more; whatever cannot be settled ends the process instead.
      if (turn.liveWork.size && !worker.closed) {
        const settled = await Promise.race([this.drainLiveWork(turn).then(() => true), sleep(grace).then(() => false)]);
        if (!settled) { await this.closeWorker(worker, { terminate: true }); turn.done.resolve(); return; }
      }
      if (!worker.closed && worker.client.isAlive) {
        try {
          const late = await worker.client.request({ type: "clear_queue" }, { timeoutMs: Math.min(grace, 3_000) });
          worker.queue = { steering: [], followUp: [] };
          if (late.steering.length || late.followUp.length) { this.publishState(worker); await this.handBack(turn, late, "stopped"); }
        } catch {
          // Refused or unanswered, the queue was not cleared, and it lives only in this process: end it, say so, resend nothing.
          await this.dropUnconfirmedQueue(turn);
        }
      }
      turn.done.resolve();
    })();
    return turn.stopping;
  }

  private handleEvent(worker: Worker, event: PiSessionEvent): void {
    const turn = worker.turn;
    switch (event.type) {
      case "agent_start": worker.state = { ...worker.state, isStreaming: true }; break;
      case "agent_settled": worker.state = { ...worker.state, isStreaming: false }; break;
      case "queue_update": worker.queue = { steering: [...event.steering], followUp: [...event.followUp] }; this.publishState(worker); break;
      case "thinking_level_changed": if (isThinkingLevel(event.level)) worker.state = { ...worker.state, thinkingLevel: event.level }; this.publishState(worker); break;
      case "session_info_changed": worker.state = { ...worker.state, sessionName: event.name }; this.publishState(worker); break;
      case "compaction_start": worker.state = { ...worker.state, isCompacting: true }; this.publishState(worker); break;
      case "compaction_end": worker.state = { ...worker.state, isCompacting: false }; this.publishState(worker); break;
      case "extension_error": {
        const diagnostic: Extract<PiNativeEvent, { type: "extension_error" }> = {
          type: "extension_error", extensionPath: path.basename(event.extensionPath),
          event: sanitizePiErrorText(event.event, 100), error: sanitizePiErrorText(event.error),
        };
        this.publish(worker.sessionId, diagnostic);
        if (turn && !turn.done.settled) this.emitExtensionError(turn, diagnostic);
        else {
          worker.extensionErrors.push(diagnostic);
          while (worker.extensionErrors.length > NOTICE_BACKLOG_LIMIT) worker.extensionErrors.shift();
        }
        break;
      }
      default: break;
    }
    if (!turn) return;
    this.noteActivity(turn);
    // A reply that ends without tool calls is the last one unless Pi continues (a queued message, a retry, an extension).
    if (event.type === "message_end" && event.message.role === "assistant") turn.wrappingUp = (event.message as PiAssistantMessage).stopReason !== "toolUse";
    else if (event.type === "agent_start" || event.type === "turn_start" || (event.type === "message_start" && event.message.role === "assistant")) turn.wrappingUp = false;
    for (const mapped of turn.mapper.apply(event)) void this.emit(turn, mapped);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") turn.input.onProgress?.(turn.mapper.currentText);
    // Pi defers a prompt sent while it settles another run (an extension's own), so that settle can come first.
    if (event.type === "agent_settled" && turn.promptAnswered) turn.done.resolve();
  }

  /**
   * What an extension shows. Notices and editor text are put in front of the
   * owner: in the running turn's stream, or at the start of the next turn.
   * Status lines, widgets and the title are standing state, kept for
   * `getState` and subscribers.
   */
  private publishUi(worker: Worker, event: Extract<PiNativeEvent, { type: "notify" | "status" | "widget" | "title" | "editor_text" }>, source: "extension" | "host" = "extension"): void {
    this.publish(worker.sessionId, event);
    if (event.type === "status") { if (event.text) worker.ui.status[event.key] = event.text; else delete worker.ui.status[event.key]; return; }
    if (event.type === "widget") { if (event.lines?.length) worker.ui.widgets[event.key] = { lines: event.lines, placement: event.placement }; else delete worker.ui.widgets[event.key]; return; }
    if (event.type === "title") { worker.ui.title = event.title; return; }
    if (event.type === "editor_text") worker.ui.editorText = { text: event.text, revision: ++worker.editorRevision };
    const turn = worker.turn, loc = turn?.input.locale ?? "en";
    // Marked as coming from Pi or one of its extensions, so it is never read as something the model wrote.
    // The Host can take an earlier text block as the answer (an empty or placeholder result) and act on its
    // delivery tags; an extension's words are shown as written, never executed.
    const line = this.shownNotExecuted(event.type === "editor_text"
      ? `${hostT(loc, "[Pi 扩展] 建议的输入")}:\n${event.text}`
      : `${source === "host" ? "[Pi]" : hostT(loc, "[Pi 扩展]")} ${event.text}`, turn?.input.locale);
    if (turn && !turn.done.settled) {
      if (event.type === "notify") turn.notices.push(event.text);
      void this.emit(turn, { type: "assistant_text", text: line, sessionId: worker.sessionId });
      return;
    }
    worker.backlog.push(line);
    while (worker.backlog.length > NOTICE_BACKLOG_LIMIT) worker.backlog.shift();
  }

  private flushBacklog(turn: Turn): void {
    for (const line of turn.worker.backlog.splice(0)) void this.emit(turn, { type: "assistant_text", text: line, sessionId: turn.worker.sessionId });
    for (const error of turn.worker.extensionErrors.splice(0)) this.emitExtensionError(turn, error);
  }

  private emitExtensionError(turn: Turn, error: Extract<PiNativeEvent, { type: "extension_error" }>): void {
    turn.extensionErrors++;
    if (turn.extensionErrors > NOTICE_BACKLOG_LIMIT) return;
    const label = hostT(turn.input.locale ?? "en", "[Pi 扩展错误]");
    void this.emit(turn, { type: "assistant_text", text: this.shownNotExecuted(`${label} ${error.extensionPath} (${error.event}): ${error.error}`, turn.input.locale), sessionId: turn.worker.sessionId });
  }

  private withExtensionErrorNotice(turn: Turn, text: string): string {
    if (!turn.extensionErrors) return text;
    // Extension diagnostics can contain text that resembles a delivery directive.
    // Keep their details in the process; only a fixed count belongs in the final answer.
    const loc = turn.input.locale ?? "en";
    const warning = turn.extensionErrors === 1
      ? hostT(loc, "[Pi] 本轮出现 1 个扩展错误；详情见本轮运行过程。")
      : hostT(loc, "[Pi] 本轮出现 {0} 个扩展错误；详情见本轮运行过程。", turn.extensionErrors);
    return text.trim() ? `${text}\n\n${warning}` : warning;
  }

  private handleExtensionUi(worker: Worker, request: PiExtensionUiRequest): void {
    const cancel = () => worker.client.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
    switch (request.method) {
      case "notify": {
        const text = sanitizePiErrorText(request.message, 2_000);
        if (text) this.publishUi(worker, { type: "notify", level: request.notifyType ?? "info", text });
        return;
      }
      case "setStatus": this.publishUi(worker, { type: "status", key: request.statusKey, ...(request.statusText ? { text: piDisplayText(request.statusText) } : {}) }); return;
      case "setWidget": this.publishUi(worker, { type: "widget", key: request.widgetKey, ...(request.widgetLines ? { lines: request.widgetLines.map(piDisplayText) } : {}), placement: request.widgetPlacement ?? "aboveEditor" }); return;
      case "setTitle": this.publishUi(worker, { type: "title", title: piDisplayText(request.title) }); return;
      case "set_editor_text": this.publishUi(worker, { type: "editor_text", text: piDisplayText(request.text) }); return;
      default: break;
    }
    if (!isPiDialog(request)) return;
    const turn = worker.turn, ask = turn?.input.onApprovalRequest;
    const locale = turn?.input.locale ?? "en", question = piDialogQuestion(request, locale);
    if (!turn || !ask || !question || turn.stopRequested) { cancel(); return; }
    if (request.method === "editor" && (request.prefill?.length ?? 0) > EDITOR_PREFILL_LIMIT) {
      // Cancelling keeps the extension's original text; a truncated "edit" would silently destroy the rest.
      cancel();
      const size = request.prefill!.length.toLocaleString("en-US");
      this.publishUi(worker, { type: "notify", level: "warning", text: hostT(locale, "一个扩展要求编辑 {0} 个字符的文本，超过了这里编辑卡片能容纳的 16,000 个字符。这次编辑已取消，原文没有改动；这类编辑请在 Pi 的终端界面里做。", size) }, "host");
      return;
    }
    worker.dialogs.set(request.id, request);
    turn.humanWaits++;
    // Pi resolves a timed dialog on its own and sends no "closed" record, so withdraw the card at the same moment.
    const withdraw = new AbortController();
    const timeout = "timeout" in request && typeof request.timeout === "number" && request.timeout > 0
      ? setTimeout(() => withdraw.abort(), request.timeout) : undefined;
    timeout?.unref?.();
    const abortSignal = AbortSignal.any([turn.scope.signal, withdraw.signal]);
    void (async () => {
      let decision: EngineApprovalDecision = { behavior: "deny" };
      try {
        await this.emit(turn, { type: "permission_request", toolName: "AskUserQuestion", toolInput: { questions: [question] }, sessionId: worker.sessionId });
        decision = await ask({ engine: "pi", toolName: "AskUserQuestion", toolInput: { questions: [question] }, cwd: worker.cwd, sessionId: worker.sessionId, abortSignal });
      } catch { decision = { behavior: "deny" }; }
      clearTimeout(timeout);
      turn.humanWaits = Math.max(0, turn.humanWaits - 1);
      this.noteActivity(turn);
      if (!worker.dialogs.delete(request.id)) return; // already cancelled by a stop
      worker.client.respondExtensionUi(decision.behavior === "allow" && !abortSignal.aborted
        ? piDialogResponse(request, question, decision.updatedInput, locale)
        : { type: "extension_ui_response", id: request.id, cancelled: true });
    })();
  }

  private async askCommandQuestion(turn: Turn, question: PiCommandQuestion): Promise<PiCommandAnswer> {
    const ask = turn.input.onApprovalRequest, worker = turn.worker;
    if (!ask || turn.stopRequested) return { cancelled: true };
    const form = {
      // Non-blank, so the card keeps every option and its answer positions line up with `question.options`.
      // The explanation goes into the text the card shows: what is being confirmed has to be readable there.
      question: piQuestionWithDetail(piQuestionText(question.title, "Pi"), question.message),
      options: question.options.map(option => ({ label: piQuestionText(option.label, option.value), ...(option.description ? { description: option.description } : {}) })),
      multiSelect: Boolean(question.multiple),
      // Stated either way: the shared card offers a free-text box by default, and a typed answer to a pure choice would only cancel it.
      allowFreeText: Boolean(question.text),
      ...(question.text ? { input: { kind: question.text.multiline ? "multiline" : "text", ...(question.text.placeholder ? { placeholder: question.text.placeholder } : {}), ...(question.text.prefill ? { prefill: question.text.prefill } : {}) } } : {}),
    };
    turn.humanWaits++;
    try {
      await this.emit(turn, { type: "permission_request", toolName: "AskUserQuestion", toolInput: { questions: [form] }, sessionId: worker.sessionId });
      const decision = await ask({ engine: "pi", toolName: "AskUserQuestion", toolInput: { questions: [form] }, cwd: worker.cwd, sessionId: worker.sessionId, abortSignal: turn.scope.signal });
      if (decision.behavior !== "allow" || turn.stopRequested) return { cancelled: true };
      // Picked options by position: two fork points or tree entries may share their text.
      const selection = piQuestionSelection(decision.updatedInput);
      if (selection) {
        const picked = selection.options.map(position => question.options[position]);
        if (picked.some(option => !option)) return { cancelled: true };
        if (picked.length) {
          if (question.multiple) return { values: picked.map(option => option!.value) };
          return picked.length === 1 ? { value: picked[0]!.value } : { cancelled: true };
        }
        return question.text ? { text: selection.text ?? "" } : { cancelled: true };
      }
      // A label-only answer (a surface without positions): labels that look alike on the card are never guessed between.
      const raw = piLabelAnswer(decision.updatedInput, form.question);
      const shown = form.options.map((option, index) => ({ label: option.label, value: question.options[index]!.value }));
      if (question.multiple) {
        // The shared form returns several choices as an array, or as one comma-separated string.
        const labels = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string")
          : typeof raw === "string" ? raw.split(/\s*[,，]\s*/).filter(Boolean) : undefined;
        if (!labels) return { cancelled: true };
        const matches = labels.map(label => piLabelValue(shown, label));
        if (matches.includes("ambiguous")) return { cancelled: true };
        if (matches.every(match => typeof match === "object")) return { values: matches.map(match => (match as { value: string }).value) };
        return question.text && typeof raw === "string" ? { text: raw } : { cancelled: true };
      }
      const answer = Array.isArray(raw) ? raw.find((value): value is string => typeof value === "string") : typeof raw === "string" ? raw : undefined;
      if (answer === undefined) return { cancelled: true };
      const match = piLabelValue(shown, answer);
      if (typeof match === "object") return { value: match.value };
      if (match === "ambiguous") return { cancelled: true };
      return question.text ? { text: answer } : { cancelled: true };
    } catch { return { cancelled: true }; } finally {
      turn.humanWaits = Math.max(0, turn.humanWaits - 1);
      this.noteActivity(turn);
    }
  }

  private async approveUserBash(turn: Turn, command: string): Promise<boolean> {
    // The owner typed this command; in normal mode it is still confirmed, each time.
    return (await this.requestApproval(turn.worker, turn, { toolName: "bash", toolCallId: `user-bash-${randomUUID()}`, input: { command }, origin: "builtin" }, turn.scope.signal, false)).allow;
  }

  // ---------------------------------------------------------------- bridge handler

  private bridgeHandler(getWorker: () => Worker | undefined, cwd: string, startup: { events: PiBridgeEvent[] }): PiBridgeHandler {
    return {
      trust: async () => (await this.store.trustDecision(cwd)) ?? "undecided",
      instructions: async () => getWorker()?.turn?.instructions,
      approve: async (request, signal) => {
        const worker = getWorker();
        // The extension starts gated and asks until told otherwise; before the first turn nothing may run unasked.
        if (!worker) return { allow: false, reason: "The session is still starting" };
        if (worker.gate === false) return { allow: true };
        return this.requestApproval(worker, worker.turn, request, signal, true);
      },
      callTool: async (call, signal) => {
        const worker = getWorker(), turn = worker?.turn, tools = turn?.appTools;
        if (!worker || !turn || !tools || turn.stopRequested || !tools.definitions.some(tool => tool.name === call.name)) return NO_APP_TURN;
        const abortSignal = AbortSignal.any([signal, turn.scope.signal]);
        try {
          return await tools.call({ name: call.name, arguments: call.arguments, callId: call.callId, sessionId: worker.sessionId, abortSignal, onActivity: () => this.noteActivity(turn) });
        } catch (error) {
          return { text: abortSignal.aborted ? "The App tool call was cancelled; check receipts before retrying." : `App tool failed: ${sanitizePiErrorText(error instanceof Error ? error.message : String(error))}`, isError: true };
        }
      },
      onEvent: event => {
        const worker = getWorker();
        // Pi reports session_start before it reads its first command, which is before the worker exists here.
        if (worker) this.handleBridgeEvent(worker, event); else startup.events.push(event);
      },
    };
  }

  private handleBridgeEvent(worker: Worker, event: PiBridgeEvent): void {
    if (event.type === "session_start") {
      if (typeof event.trusted === "boolean") worker.trusted = event.trusted;
      // Outside a turn nobody else would notice an extension replacing the session.
      if (!worker.turn && !worker.exclusive) void this.reconcileSession(worker).catch(() => {});
      return;
    }
    if (event.type === "model_select") void this.refreshState(worker).then(() => this.publishState(worker)).catch(() => {});
  }

  /** Per-tool approval for `normal` mode. Anything that cannot be asked is denied. */
  private async requestApproval(
    worker: Worker, turn: Turn | undefined,
    request: { toolName: string; toolCallId: string; input: unknown; origin?: PiBridgeToolOrigin }, signal: AbortSignal,
    useGrants: boolean,
  ): Promise<{ allow: boolean; reason?: string }> {
    const name = request.toolName, origin = request.origin ?? "other";
    if (useGrants) {
      // A name alone proves nothing: an extension may register its own `read`. Only Pi's built-in tool and tools this bridge installed pass unasked.
      if (origin === "builtin" && AUTO_ALLOWED_TOOLS.has(name)) return { allow: true };
      if (origin === "bridge" && turn?.appTools?.definitions.some(tool => tool.name === name)) return { allow: true };
      // The Host's own search server, registered for this process and not shadowed by one of the owner's.
      if (worker.managedSearchPrefix && origin === "other" && name.startsWith(worker.managedSearchPrefix)) return { allow: true };
    }
    const grants = this.grants.get(worker.sessionId);
    // A session grant covers the tool it was given for, not a later look-alike from another source.
    const grantKey = `${origin}:${name}`;
    if (useGrants && grants?.has(grantKey)) return { allow: true };
    const ask = turn?.input.onApprovalRequest;
    if (!turn || !ask || turn.stopRequested) return { allow: false, reason: "No one is available to approve this tool call" };
    const abortSignal = AbortSignal.any([signal, turn.scope.signal]);
    turn.humanWaits++;
    let decision: EngineApprovalDecision = { behavior: "deny" };
    try {
      await this.emit(turn, { type: "permission_request", toolName: name, toolInput: request.input, toolUseId: request.toolCallId, sessionId: worker.sessionId });
      decision = await ask({
        engine: "pi", toolName: name, toolInput: request.input, cwd: worker.cwd, sessionId: worker.sessionId, abortSignal,
        approvalScopes: useGrants ? { once: "once", session: "session" } : { once: "once" },
      });
    } catch { decision = { behavior: "deny" }; } finally {
      turn.humanWaits = Math.max(0, turn.humanWaits - 1);
      this.noteActivity(turn);
    }
    if (abortSignal.aborted || decision.behavior !== "allow") return { allow: false, reason: abortSignal.aborted ? "Cancelled" : "Denied by the owner" };
    if (useGrants && decision.scope === "session") {
      const set = grants ?? new Set<string>();
      this.grants.set(worker.sessionId, set);
      set.add(grantKey);
      // Eviction only causes a fresh approval, never a broader permission.
      while (set.size > SESSION_GRANT_LIMIT) set.delete(set.values().next().value!);
    }
    return { allow: true };
  }

  // ---------------------------------------------------------------- settings

  private async loadRuntime(override: EngineOverride | undefined): Promise<{
    gate: boolean; botModel?: string; botEffort?: string; ticket?: { model?: string; effort?: string };
  }> {
    let botModel: string | undefined, botEffort: string | undefined, approvalMode = DEFAULT_APPROVAL_MODE;
    if (this.options.configPath) {
      const parsed = await readValidatedConfigFile(this.options.configPath, { forExecution: true });
      approvalMode = normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
      botModel = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
      botEffort = typeof parsed.effort === "string" && parsed.effort.trim() ? parsed.effort.trim() : undefined;
    }
    const ticket = override?.model || override?.effort ? resolveEngineOverride("pi", { model: botModel, effort: botEffort }, override) : undefined;
    return {
      gate: approvalMode !== "bypass",
      ...(botModel ? { botModel } : {}), ...(botEffort ? { botEffort } : {}),
      ...(ticket ? { ticket: { ...(ticket.model ? { model: ticket.model } : {}), ...(ticket.effort ? { effort: ticket.effort } : {}) } } : {}),
    };
  }

  private async applyGate(worker: Worker, gate: boolean): Promise<void> {
    if (gate && !worker.bridge?.isOpen) {
      throw new Error("Pi tool approval is unavailable for this session (the TaroBird bridge did not connect), so the turn was not started. Start a new conversation or restart the Bot to connect it again. Full access also starts the turn, but then Pi runs every tool without asking.");
    }
    if (worker.gate === gate) return;
    if (worker.bridge?.isOpen) await worker.bridge.setGate(gate);
    worker.gate = gate;
  }

  /**
   * The Bot-wide model and effort are a default, not a per-turn force: they are
   * applied when a session first runs and again only when that individual Bot
   * field changes. A choice in the other field made in the conversation survives.
   * Clearing the Bot setting undoes exactly what it had imposed and nothing
   * the conversation chose itself. A dispatcher ticket override is applied on
   * every turn of its session.
   */
  private async applyModelSettings(worker: Worker, runtime: Awaited<ReturnType<PiRpcAdapter["loadRuntime"]>>, scope: SettingsScope): Promise<void> {
    const beforeWrite = scope.check;
    if (runtime.ticket) {
      if (runtime.ticket.model) await this.setModelExact(worker, this.decodeModel(runtime.ticket.model), beforeWrite);
      if (runtime.ticket.effort) await this.setThinkingExact(worker, runtime.ticket.effort, beforeWrite);
      await scope.record({ modelSource: "ticket" });
      return;
    }
    const fingerprint = piBotDefaultFingerprint(runtime.botModel, runtime.botEffort);
    const record = await this.store.record(scope.sessionId);
    const modelFingerprint = piBotDefaultFingerprint(runtime.botModel, undefined);
    const thinkingFingerprint = piBotDefaultFingerprint(undefined, runtime.botEffort);
    // Older records know only the pair. If unchanged, migrate without writing to Pi;
    // otherwise retain the old apply-both behavior once, since neither previous value is known.
    const legacyUnchanged = record.appliedBotDefault === fingerprint;
    const modelChanged = record.appliedBotModelDefault !== undefined
      ? record.appliedBotModelDefault !== modelFingerprint : !legacyUnchanged;
    const thinkingChanged = record.appliedBotThinkingDefault !== undefined
      ? record.appliedBotThinkingDefault !== thinkingFingerprint : !legacyUnchanged;
    const patch: Partial<PiSessionRecord> = {
      appliedBotDefault: fingerprint, appliedBotModelDefault: modelFingerprint, appliedBotThinkingDefault: thinkingFingerprint,
    };
    if (!modelChanged && !thinkingChanged) {
      if (record.appliedBotModelDefault === undefined || record.appliedBotThinkingDefault === undefined) await scope.record(patch);
      return;
    }
    const stillImposedModel = Boolean(record.modelSource === "bot-default" && record.botDefaultModel && samePiModel(toPiModelRef(worker.state.model), record.botDefaultModel));
    const stillImposedThinking = Boolean(record.botDefaultThinking && worker.state.thinkingLevel === record.botDefaultThinking);
    // Ownership must survive Pi resetting thinking during an uncertain model
    // write. A conversation's explicit thinking choice clears this record.
    const retainBotThinking = modelChanged && !thinkingChanged && Boolean(runtime.botEffort && record.botDefaultThinking === runtime.botEffort)
      && (Boolean(runtime.botModel) || record.modelSource === "bot-default");
    const thinkingBefore = stillImposedThinking ? record.thinkingBeforeBotDefault : worker.state.thinkingLevel;
    const modelBefore = toPiModelRef(worker.state.model), levelBefore = worker.state.thinkingLevel;
    let modelRestored = false;

    if (modelChanged && runtime.botModel) {
      const ref = this.decodeModel(runtime.botModel);
      if (retainBotThinking) await this.validateThinkingForModel(worker, ref, runtime.botEffort!);
      await this.setModelExact(worker, ref, beforeWrite);
      patch.modelSource = "bot-default"; patch.botDefaultModel = ref;
    } else if (modelChanged && stillImposedModel) {
      // The Bot default was cleared and this session still runs the model it had imposed: return to Pi's own default.
      modelRestored = await this.restoreNativeDefault(worker, beforeWrite, { thinking: thinkingChanged && stillImposedThinking, ...(retainBotThinking ? { requiredThinking: runtime.botEffort } : {}) });
      patch.modelSource = "native"; patch.botDefaultModel = undefined;
      if (!modelRestored) this.publishUi(worker, { type: "notify", level: "warning", text: "Pi's default model is not available right now; the conversation keeps its current model." }, "host");
    } else if (modelChanged && record.modelSource === "bot-default") {
      patch.modelSource = "session"; patch.botDefaultModel = undefined;
    }

    // Pi's set_model applies its per-model/default thinking setting. Reapply an
    // unchanged Bot-owned effort even if an earlier uncertain write already
    // selected the target model. No intermediate checkpoint or retry flag needed.
    if (retainBotThinking) await this.setThinkingExact(worker, runtime.botEffort!, beforeWrite);
    else if (modelChanged && !thinkingChanged && !samePiModel(modelBefore, toPiModelRef(worker.state.model)) && levelBefore !== worker.state.thinkingLevel && levelBefore && isThinkingLevel(levelBefore)) {
      const { levels } = await worker.client.request({ type: "get_available_thinking_levels" });
      if (levels.includes(levelBefore)) await this.setThinkingExact(worker, levelBefore, beforeWrite);
      else this.publishUi(worker, { type: "notify", level: "warning", text: `The new Pi model does not support the conversation's ${levelBefore} thinking level; Pi selected ${worker.state.thinkingLevel ?? "its default"}.` }, "host");
    }

    if (thinkingChanged && runtime.botEffort) {
      await this.setThinkingExact(worker, runtime.botEffort, beforeWrite);
      patch.botDefaultThinking = runtime.botEffort; patch.thinkingBeforeBotDefault = thinkingBefore;
    } else if (thinkingChanged) {
      // The Bot effort was cleared. If the session still runs the level it had imposed, put back what was there before;
      // a model that was just returned to Pi's default already carries Pi's own level.
      if (stillImposedThinking && !modelRestored && thinkingBefore && thinkingBefore !== worker.state.thinkingLevel) {
        const { levels } = await worker.client.request({ type: "get_available_thinking_levels" });
        if (isThinkingLevel(thinkingBefore) && levels.includes(thinkingBefore)) {
          await this.settingsWrite(worker, { type: "set_thinking_level", level: thinkingBefore }, beforeWrite);
          await this.refreshState(worker);
          this.publishState(worker);
        }
      }
      patch.botDefaultThinking = undefined; patch.thinkingBeforeBotDefault = undefined;
    }
    await scope.record(patch);
  }

  private decodeModel(value: string): PiModelRef {
    const ref = decodePiModel(value);
    if (!ref) throw new Error(`Invalid model selection: "${value}" is not a Pi provider/model reference`);
    return ref;
  }

  /** `beforeWrite` runs immediately before each native write; throwing there leaves Pi untouched. */
  private async setModelExact(worker: Worker, ref: PiModelRef, beforeWrite?: () => Promise<void>): Promise<void> {
    if (samePiModel(toPiModelRef(worker.state.model), ref)) return;
    let written = false;
    try {
      const model = await this.settingsWrite(worker, { type: "set_model", provider: ref.provider, modelId: ref.modelId }, beforeWrite);
      written = true;
      worker.state = { ...worker.state, model };
      await this.refreshState(worker);
      this.publishState(worker);
    } catch (error) {
      if (written) {
        worker.settingsUncertain = "set_model";
        throw new PiNativeUncertainError("set_model", { cause: error });
      }
      if (error instanceof PiRpcCommandError && error.kind === "model-unavailable") {
        // Pi words an unknown model and a provider without credentials identically.
        throw new PiNativeRejectedError(`Invalid model selection: ${modelLabel(ref)} is not available in Pi. Either the model does not exist or its provider is not signed in.`, "model-unavailable");
      }
      throw error;
    }
  }

  /** Reject an incompatible retained Bot effort before changing the model. */
  private async validateThinkingForModel(worker: Worker, ref: PiModelRef, level: string): Promise<void> {
    const { models } = await worker.client.request({ type: "get_available_models" });
    const model = models.find(model => model.provider === ref.provider && model.id === ref.modelId);
    if (!model) return; // Keep Pi's own unavailable-model error and credential check.
    const levels = piThinkingLevels(model);
    if (!isThinkingLevel(level) || !levels.includes(level)) throw new PiNativeRejectedError(
      `Invalid model selection: ${modelLabel(ref)} has no "${level}" effort (available: ${levels.join(", ")})`, "thinking-unsupported", levels,
    );
  }

  private async setThinkingExact(worker: Worker, level: string, beforeWrite?: () => Promise<void>): Promise<void> {
    if (!isThinkingLevel(level)) throw new PiNativeRejectedError(`Invalid model selection: "${level}" is not a Pi thinking level`, "thinking-unsupported", [...PI_THINKING_LEVELS]);
    if (worker.state.thinkingLevel === level) return;
    const { levels } = await worker.client.request({ type: "get_available_thinking_levels" });
    if (!levels.includes(level)) {
      const ref = toPiModelRef(worker.state.model);
      // Pi would clamp silently and report success.
      throw new PiNativeRejectedError(`Invalid model selection: ${ref ? modelLabel(ref) : "the current model"} has no "${level}" effort (available: ${levels.join(", ")})`, "thinking-unsupported", levels);
    }
    await this.settingsWrite(worker, { type: "set_thinking_level", level }, beforeWrite);
    await this.refreshState(worker);
    this.publishState(worker);
  }

  /**
   * The only place a model or thinking level is written to Pi. Pi handles
   * commands concurrently and answers `set_model` only after checking the
   * provider's credentials, so a write that ran out of time is not cancelled:
   * it can still land, after and over a later one. Such a process is marked
   * uncertain and receives no further writes.
   */
  private settingsWrite(worker: Worker, command: { type: "set_model"; provider: string; modelId: string }, beforeWrite?: () => Promise<void>): Promise<PiModel>;
  private settingsWrite(worker: Worker, command: { type: "set_thinking_level"; level: PiThinkingLevel }, beforeWrite?: () => Promise<void>): Promise<undefined>;
  private async settingsWrite(
    worker: Worker,
    command: { type: "set_model"; provider: string; modelId: string } | { type: "set_thinking_level"; level: PiThinkingLevel },
    beforeWrite?: () => Promise<void>,
  ): Promise<PiModel | undefined> {
    if (worker.settingsUncertain) throw new PiNativeUncertainError(command.type);
    await beforeWrite?.();
    if (worker.settingsUncertain) throw new PiNativeUncertainError(command.type);
    const options = this.options.settingsWriteTimeoutMs ? { timeoutMs: this.options.settingsWriteTimeoutMs } : {};
    try {
      return command.type === "set_model" ? await worker.client.request(command, options) : await worker.client.request(command, options);
    } catch (error) {
      // Pi said no: nothing was changed. Anything else (deadline, lost pipe) leaves the outcome open.
      if (error instanceof PiRpcCommandError) throw error;
      worker.settingsUncertain = command.type;
      throw new PiNativeUncertainError(command.type, { cause: error });
    }
  }

  /**
   * Run one complete model or thinking change (its lookups, native writes and
   * bookkeeping) with no other such change to the same process in between.
   * After the wait the process must still be the one asked about.
   * `explicit`: a choice someone made; it is refused outright on an uncertain
   * process. Applying defaults at a turn start is refused only if it would
   * have to write.
   *
   * A native write waits on Pi, and the process can be serving another session
   * by the time Pi answers. So the session a change was started for is fixed
   * here and never read from the worker again: `scope.check` must pass before
   * each native write, and `scope.record` is the only way its bookkeeping is
   * written. `authorize` is the requester's own check; it is asked again at
   * each of those points.
   */
  private settingsTask<T>(
    worker: Worker, sessionId: string, explicit: boolean, authorize: (() => Promise<void>) | undefined, run: (scope: SettingsScope) => Promise<T>,
  ): Promise<T> {
    const token = worker.token;
    // `worker.state` is what Pi last reported. Between Pi moving to another session and the Host filing
    // the process under it, that is the only sign of the move.
    const same = () => !this.destroyed && !worker.closed && worker.token === token && worker.sessionId === sessionId
      && worker.state.sessionId === sessionId && this.workers.get(sessionId) === worker;
    const check = async () => {
      const replaced = () => new PiNativeRejectedError("The Pi session was replaced while its model settings were being changed; the change was not completed or recorded", "not-found");
      if (!same()) throw replaced();
      if (!authorize) return;
      await authorize();
      if (!same()) throw replaced();
    };
    // Refused at this point, a native write may already be in place: say only what is known.
    const notRecorded = () => new PiNativeRejectedError("The Pi session or the request stopped being current while its model settings were being changed; the change was not recorded", "not-found");
    const scope: SettingsScope = {
      sessionId, check,
      record: async patch => {
        // Have the state file in memory first, so that only the checks stand between the native write and the record.
        await this.store.record(sessionId);
        try { await check(); } catch (error) {
          throw error instanceof PiNativeRejectedError && error.reason === "not-found" ? notRecorded() : error;
        }
        // Asked once more at the moment the record changes: the store may still have waited.
        if (!(await this.store.updateRecordIf(sessionId, patch, same))) throw notRecorded();
      },
    };
    const task = worker.settingsQueue.then(async () => {
      if (!same()) throw new PiNativeRejectedError("The Pi session changed while this was waiting; nothing was changed", "not-found");
      if (explicit && worker.settingsUncertain) throw new PiNativeUncertainError("the change");
      return run(scope);
    });
    worker.settingsQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async restoreNativeDefault(worker: Worker, beforeWrite?: () => Promise<void>, options: { thinking: boolean; requiredThinking?: string } = { thinking: true }): Promise<boolean> {
    try {
      const catalog = await (this.options.queryCatalogFn ?? queryPiCatalog)({
        launch: this.options.launch, cwd: worker.cwd, env: this.options.childEnv,
        // Reading the default must not start the owner's MCP servers. Extensions stay on: they can register providers.
        extraArgs: ["--no-mcp"],
        ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
        ...(this.options.killProcessTreeFn ? { killProcessTreeFn: this.options.killProcessTreeFn } : {}),
      });
      if (!catalog.current) return false;
      const ref = { provider: catalog.current.provider, modelId: catalog.current.modelId };
      if (options.requiredThinking) await this.validateThinkingForModel(worker, ref, options.requiredThinking);
      await this.setModelExact(worker, ref, beforeWrite);
      const level = catalog.current.thinkingLevel;
      if (options.thinking && isThinkingLevel(level) && worker.state.thinkingLevel !== level) {
        const { levels } = await worker.client.request({ type: "get_available_thinking_levels" });
        if (levels.includes(level)) {
          await this.settingsWrite(worker, { type: "set_thinking_level", level }, beforeWrite);
          await this.refreshState(worker);
        }
      }
      return true;
    } catch (error) {
      // A failed precondition and an unconfirmed write must reach the caller as what they are;
      // anything else means the default could not be restored.
      if (error instanceof PiNativeUncertainError || (error instanceof PiNativeRejectedError && (error.reason === "not-found" || error.reason === "thinking-unsupported"))) throw error;
      return false;
    }
  }

  /**
   * Set, or with null drop, the conversation's own model or thinking choice.
   * Dropping applies at once and only to the field named: the model goes to
   * the Bot default, or to Pi's own default when the Bot has none; the
   * thinking level goes to the Bot effort, or stays when the Bot has none.
   */
  private chooseForSession(
    worker: Worker, choice: { model: PiModelRef | null } | { thinking: PiThinkingLevel | null }, authorize?: () => Promise<void>,
  ): Promise<void> {
    return this.settingsTask(worker, worker.sessionId, true, authorize, async scope => {
      // The caller's check comes first, even when the value asked for is already in place:
      // a request that may not act must not change who is recorded as having chosen it either.
      await scope.check();
      await this.applyChoice(worker, choice, scope);
    });
  }

  private async applyChoice(worker: Worker, choice: { model: PiModelRef | null } | { thinking: PiThinkingLevel | null }, scope: SettingsScope): Promise<void> {
    const beforeWrite = scope.check;
    // This explicit choice supersedes the Bot default already saved when it
    // starts. A later Bot change must still apply, and the other field remains
    // independent. Capture before any native write; only record after success.
    const runtime = await this.loadRuntime(undefined);
    const modelDefault = { appliedBotModelDefault: piBotDefaultFingerprint(runtime.botModel, undefined) };
    const thinkingDefault = { appliedBotThinkingDefault: piBotDefaultFingerprint(undefined, runtime.botEffort) };
    if ("model" in choice && choice.model) {
      await this.setModelExact(worker, choice.model, beforeWrite);
      await scope.record({ ...modelDefault, modelSource: "session", botDefaultModel: undefined });
      return;
    }
    if ("thinking" in choice && choice.thinking) {
      await this.setThinkingExact(worker, choice.thinking, beforeWrite);
      // The conversation chose this level itself; clearing the Bot effort later must not undo it.
      await scope.record({ ...thinkingDefault, botDefaultThinking: undefined, thinkingBeforeBotDefault: undefined });
      return;
    }
    // Dropping a choice. Model and thinking level are independent: resetting one never moves the other.
    // Pi's `set_model` picks a level of its own (its per-model or default setting, then a clamp), so a
    // level that still follows the Bot is put back afterwards: the conversation never chose another one.
    if ("model" in choice) {
      const record = await this.store.record(scope.sessionId);
      const botThinking = runtime.botEffort && record.botDefaultThinking !== undefined ? runtime.botEffort : undefined;
      // The model reset is complete and recorded first; putting the level back is a second step whose
      // failure is reported as such, never as an unknown outcome of the reset.
      const thinkingAfterReset = async () => {
        if (!botThinking) return;
        try {
          if (await this.reapplyThinking(worker, botThinking, beforeWrite)) await scope.record({ ...thinkingDefault, botDefaultThinking: botThinking });
        } catch (error) {
          this.publishUi(worker, { type: "notify", level: "warning", text: `The model was reset, but the Bot's ${botThinking} thinking level could not be applied${error instanceof PiNativeUncertainError ? " (Pi did not confirm the change; check the level before changing it again)" : ""}.` }, "host");
        }
      };
      if (runtime.botModel) {
        const ref = this.decodeModel(runtime.botModel);
        await this.setModelExact(worker, ref, beforeWrite);
        await scope.record({ ...modelDefault, modelSource: "bot-default", botDefaultModel: ref });
        await thinkingAfterReset();
        return;
      }
      await beforeWrite();
      const restored = await this.restoreNativeDefault(worker, beforeWrite, { thinking: false });
      if (!restored) throw new PiNativeRejectedError("Pi's default model is not available right now; the conversation keeps its current model", "model-unavailable");
      await scope.record({ ...modelDefault, modelSource: "native", botDefaultModel: undefined });
      await thinkingAfterReset();
      return;
    }
    if (runtime.botEffort) {
      // Checked against the model the session runs now; an unsupported Bot effort is refused, never worked around by switching models.
      await this.setThinkingExact(worker, runtime.botEffort, beforeWrite);
      await scope.record({ ...thinkingDefault, botDefaultThinking: runtime.botEffort, thinkingBeforeBotDefault: undefined });
      return;
    }
    // No Bot effort to fall back to: the level stays; only the record of who chose it is cleared.
    await scope.record({ ...thinkingDefault, botDefaultThinking: undefined, thinkingBeforeBotDefault: undefined });
  }

  /**
   * After a model change, put back the level that owns the thinking field. Pi chose one of its own on
   * `set_model`. A level the new model does not offer is left to Pi, with a notice. True when the level is in place.
   */
  private async reapplyThinking(worker: Worker, level: string, beforeWrite: () => Promise<void>): Promise<boolean> {
    if (!isThinkingLevel(level)) return false;
    if (worker.state.thinkingLevel === level) return true;
    const { levels } = await worker.client.request({ type: "get_available_thinking_levels" });
    if (!levels.includes(level)) {
      this.publishUi(worker, { type: "notify", level: "warning", text: `The model does not support the ${level} thinking level; Pi selected ${worker.state.thinkingLevel ?? "its default"}.` }, "host");
      return false;
    }
    await this.settingsWrite(worker, { type: "set_thinking_level", level }, beforeWrite);
    await this.refreshState(worker);
    this.publishState(worker);
    return true;
  }

  /** Pi's own `get_commands` for this process. Names are Pi's invocation names (a duplicate gets `name:2`, runner.ts:839-849). */
  private async nativeCommands(worker: Worker): Promise<PiNativeCommand[]> {
    const { commands } = await worker.client.request({ type: "get_commands" });
    return commands.filter(command => command.name !== PI_BRIDGE_COMMAND && (command.source === "extension" || command.source === "prompt" || command.source === "skill"))
      .map((command): PiNativeCommand => ({
        name: command.name, source: command.source as PiNativeCommand["source"],
        ...(command.description ? { description: command.description } : {}), ...(command.sourceInfo?.scope ? { scope: command.sourceInfo.scope } : {}),
      }));
  }

  private liveSession(sessionId: string): PiNativeLiveSession | undefined {
    const worker = this.workers.get(sessionId);
    if (this.destroyed || !worker || worker.closed || !worker.client.isAlive) return;
    const token = worker.token, generation = worker.generation;
    const isCurrent = () => !this.destroyed && !worker.closed && worker.client.isAlive && worker.token === token && worker.generation === generation
      && worker.sessionId === sessionId && this.workers.get(sessionId) === worker;
    const stale = () => new PiNativeRejectedError("The Pi session this control was opened for is no longer current; nothing was changed", "not-found");
    const guard = () => { if (!isCurrent()) throw stale(); };
    const read = async <T>(work: () => Promise<T>): Promise<T> => { guard(); const value = await work(); guard(); return value; };
    const write = (choice: Parameters<PiRpcAdapter["chooseForSession"]>[1], options: { isCurrent: () => Promise<boolean> }) => read(async () => {
      // A change is use of the worker, so the idle sweep does not close it mid-change. Reads do not count:
      // a client that keeps looking must not keep an idle process alive.
      worker.lastUsedAt = Date.now();
      // Checked on both sides of the caller's own asynchronous check, right before each native write.
      await this.chooseForSession(worker, choice, async () => { guard(); if (!(await options.isCurrent())) throw stale(); guard(); });
      guard();
      return this.describeState(worker);
    });
    return {
      token, isCurrent,
      getState: () => read(async () => { await this.refreshState(worker); guard(); return this.describeState(worker); }),
      listModels: () => read(async () => (await worker.client.request({ type: "get_available_models" })).models),
      // The extension, prompt-template and skill commands of this very process and session generation.
      // Asked of this worker only: a handle never starts, restarts or substitutes a process.
      listCommands: () => read(() => this.nativeCommands(worker)),
      setModel: (model, options) => write({ model }, options),
      setThinkingLevel: (level, options) => write({ thinking: level }, options),
    };
  }

  /**
   * Pi in RPC mode never asks about project-local files; it skips them. When
   * the workspace has such files and the owner has not answered here before,
   * ask once, remember the answer for this Bot and restart the process so a
   * "yes" takes effect. Nothing is written to Pi's own trust store.
   */
  private async resolveProjectTrust(turn: Turn, cwd: string): Promise<void> {
    const worker = turn.worker;
    if (worker.trusted !== false || !worker.bridge?.isOpen || !turn.input.onApprovalRequest) return;
    if ((await this.store.trustDecision(cwd)) !== undefined || !(await hasPiTrustGatedFiles(cwd))) return;
    const loc = turn.input.locale ?? "en";
    const yes = hostT(loc, "信任并加载"), no = hostT(loc, "不加载");
    const answer = await this.askCommandQuestion(turn, {
      title: hostT(loc, "要加载这个项目自带的 Pi 文件吗？"),
      message: hostT(loc, "这个工作区带有项目级 Pi 配置（.pi 下的设置、扩展、技能、提示词或 MCP 配置）。扩展和 MCP 服务会在你的电脑上运行代码。"),
      options: [{ label: yes, value: "yes" }, { label: no, value: "no" }],
    });
    this.throwIfStopped(turn);
    if (!("value" in answer)) return; // no answer: ask again next time, load nothing now
    await this.store.setTrustDecision(cwd, answer.value === "yes" ? "yes" : "no");
    if (answer.value !== "yes") return;
    await this.restartWorker(worker);
  }

  /**
   * Close an idle process and start a new one for the same session, so that
   * trust, model scope or other startup-only inputs take effect. A turn that
   * is in progress (it has not prompted yet) moves to the new process.
   */
  private async restartWorker(worker: Worker): Promise<Worker> {
    const turn = worker.turn, sessionId = worker.sessionId, cwd = worker.cwd;
    worker.turn = undefined;
    await this.closeWorker(worker, { graceMs: 3_000 });
    const starting = this.ensureWorker(sessionId, cwd);
    if (!turn) return starting;
    const restarted = await this.unlessStopped(turn, starting);
    // From here on a stop, a timeout and every event of this turn belong to the new process.
    turn.worker = restarted;
    restarted.turn = turn;
    restarted.gate = undefined;
    this.noteActivity(turn);
    return restarted;
  }

  // ---------------------------------------------------------------- workers

  private assertUsable(): void {
    if (this.destroyed) throw new Error("Pi adapter has been destroyed");
  }

  private async resolveWorkspace(override: string | undefined): Promise<string> {
    if (override !== undefined) return piWorkspaceCwd(override);
    // Control calls such as /resume and /context have no turn-supplied override.
    // Read the current Bot configuration, just as ordinary messages do, rather
    // than using the factory's fallback directory after the workspace changes.
    if (this.options.configPath) {
      const config = await readValidatedConfigFile(this.options.configPath, { forExecution: true });
      const resume = config.resume && typeof config.resume === "object" ? config.resume as { workspacePath?: unknown } : undefined;
      const workspace = typeof config.workspacePath === "string" && config.workspacePath.trim()
        ? config.workspacePath.trim()
        : typeof resume?.workspacePath === "string" && resume.workspacePath ? resume.workspacePath : undefined;
      if (workspace) return piWorkspaceCwd(workspace);
    }
    return piWorkspaceCwd(this.options.workspacePath);
  }

  private ensureWorker(sessionId: string, cwd: string, signal?: AbortSignal): Promise<Worker> {
    if (this.destroyed) return Promise.reject(new Error("Pi adapter has been destroyed"));
    if (!isSafePiSessionId(sessionId)) return Promise.reject(new Error("Invalid Pi session id"));
    if (this.sessionRestartPending(sessionId)) return Promise.reject(new Error("Pi's old process is still exiting"));
    const live = this.workers.get(sessionId);
    if (live && !live.closed && live.client.isAlive) {
      if (!samePiWorkspace(live.cwd, cwd)) return Promise.reject(new Error(`Pi session ${sessionId} is open in another workspace`));
      live.lastUsedAt = Date.now();
      return Promise.resolve(live);
    }
    const pending = this.starting.get(sessionId);
    if (pending) return pending.work.then(worker => {
      if (!samePiWorkspace(worker.cwd, cwd)) throw new Error(`Pi session ${sessionId} is open in another workspace`);
      return worker;
    });
    const controller = new AbortController();
    const startup: { controller: AbortController; work: Promise<Worker>; client?: PiRpcClient } = {
      controller,
      work: this.startWorker(sessionId, cwd, signal, controller.signal,
        client => { startup.client = client; }).finally(() => {
        if (this.starting.get(sessionId) === startup) this.starting.delete(sessionId);
      }),
    };
    this.starting.set(sessionId, startup);
    return startup.work;
  }

  private async startWorker(sessionId: string, cwd: string, signal: AbortSignal | undefined, restartSignal: AbortSignal, onSpawned: (client: PiRpcClient) => void): Promise<Worker> {
    // An ordinary turn stop can leave a handshaken worker for future input.
    // Explicit restart or destruction instead retires it at any setup stage.
    const startupSignal = AbortSignal.any([restartSignal, this.retiring.signal]);
    await this.store.ensureDirs();
    await mkdir(cwd, { recursive: true });
    cwd = piWorkspaceCwd(cwd);
    const file = await this.store.find(sessionId, cwd);
    // Resuming by id from another directory makes Pi ask [y/N] on the terminal and read our first command as the answer.
    if (file && !samePiWorkspace(file.cwd, cwd)) throw new Error(`Pi session ${sessionId} belongs to another workspace`);
    const args = ["--session-dir", this.store.sessionDir, ...(file ? ["--session", file.path] : ["--session-id", sessionId])];
    // The Bot's model scope. `--models` takes a comma-separated list, so a reference containing a comma cannot be passed.
    const scope = (await this.store.scopedModels()).map(decodePiModel).filter((model): model is PiModelRef => Boolean(model))
      .map(model => `${model.provider}/${model.modelId}`).filter(reference => !reference.includes(","));
    if (scope.length) args.push("--models", scope.join(","));
    let worker: Worker | undefined;
    let endpoint: PiBridgeEndpoint | undefined;
    const startup = { events: [] as PiBridgeEvent[] };
    if (this.bridgeExtensionPath) {
      try {
        endpoint = await (this.options.openBridgeFn ?? openPiBridgeEndpoint)({ stateDir: this.options.stateDir, handler: this.bridgeHandler(() => worker, cwd, startup) });
        args.push("-e", this.bridgeExtensionPath);
      } catch { endpoint = undefined; }
    }
    let managedSearch: PiManagedSearchServer | null = null;
    if (endpoint && this.options.nativeSearchMcp) {
      try { managedSearch = await piManagedSearchServer(this.options.nativeSearchMcp(), this.options.childEnv, cwd); } catch { managedSearch = null; }
    }
    const uiAtStartup: PiExtensionUiRequest[] = [];
    const errorsAtStartup: Array<Extract<PiSessionEvent, { type: "extension_error" }>> = [];
    let client: PiRpcClient | undefined;
    let bridge: PiBridgeConnection | undefined;
    const discard = async () => { client?.terminate(); bridge?.close(); await endpoint?.dispose(); };
    const retired = () => new Error("Pi adapter has been destroyed");
    try {
      signal?.throwIfAborted();
      if (this.destroyed) throw new Error("Pi adapter has been destroyed");
      client = await PiRpcClient.start({
        launch: this.options.launch, cwd, args, env: { ...this.options.childEnv, ...(endpoint?.env ?? {}) },
        signal: signal ? AbortSignal.any([signal, startupSignal]) : startupSignal, onSpawned,
        // Nobody can answer a dialog an extension opens while Pi is still starting; notices are kept for the first turn.
        onExtensionUi: (request, peer) => {
          if (worker) return;
          if (isPiDialog(request)) peer.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
          else uiAtStartup.push(request);
        },
        onEvent: event => {
          if (worker) this.handleEvent(worker, event);
          else if (event.type === "extension_error") {
            errorsAtStartup.push(event);
            while (errorsAtStartup.length > NOTICE_BACKLOG_LIMIT) errorsAtStartup.shift();
          }
        },
        ...(this.options.startupTimeoutMs ? { startupTimeoutMs: this.options.startupTimeoutMs } : {}),
        ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
        ...(this.options.killProcessTreeFn ? { killProcessTreeFn: this.options.killProcessTreeFn } : {}),
      });
    } catch (error) {
      await discard();
      if (this.destroyed) throw retired();
      if (signal?.aborted) throw abortError();
      throw error instanceof PiStartupError ? new PiStartupError(this.startupMessage(error), error.reason, error.exit) : error;
    }
    if (endpoint) {
      try { bridge = await untilAborted(endpoint.connection, startupSignal); } catch { bridge = undefined; await endpoint.dispose(); }
    }
    try {
      const state = await untilAborted(client.request({ type: "get_state" }), startupSignal);
      if (state.sessionId !== sessionId) throw new Error("Pi opened a different session than requested");
      // The adapter may have been retired, or the caller may have given up, while Pi was starting.
      if (this.destroyed) throw new Error("Pi adapter has been destroyed");
      if (signal?.aborted) throw abortError();
      worker = {
        sessionId, generation: 1, token: randomUUID(), editorRevision: 0, settingsQueue: Promise.resolve(), cwd, client, ...(endpoint ? { endpoint } : {}), ...(bridge ? { bridge } : {}),
        state, queue: { steering: [], followUp: [] }, dialogs: new Map(), ui: { status: {}, widgets: {} }, backlog: [], extensionErrors: [], lastUsedAt: Date.now(), lastTurnAt: Date.now(), closed: false,
      };
    } catch (error) {
      await discard();
      throw this.destroyed ? retired() : error;
    }
    const current = worker;
    for (const event of startup.events.splice(0)) if (event.type === "session_start" && typeof event.trusted === "boolean") current.trusted = event.trusted;
    for (const event of errorsAtStartup.splice(0)) this.handleEvent(current, event);
    client.onExtensionUi(request => this.handleExtensionUi(current, request));
    // Pi's own state, applied where it sits in the stream: a reply read while a run was going must not
    // overwrite the agent_settled that followed it in the same chunk (the awaited reply resumes after it).
    client.onResponse((command, data) => {
      if (command === "get_state" && !current.closed) current.state = data as PiSessionState;
      if (command === "prompt" && current.turn?.promptOutcome) current.turn.promptAnswered = true;
    });
    for (const request of uiAtStartup.splice(0)) this.handleExtensionUi(current, request);
    void client.exited.then(() => this.handleExit(current));
    void bridge?.closed.then(() => { if (!current.closed) { current.bridge = undefined; current.managedSearchPrefix = undefined; this.publishState(current); } });
    if (bridge?.isOpen && managedSearch) {
      try {
        const registered = await untilAborted(bridge.setMcpServers([{ name: managedSearch.name, config: managedSearch.config }]), startupSignal);
        if (registered.includes(managedSearch.name)) current.managedSearchPrefix = managedSearch.toolPrefix;
      } catch { /* search is an extra; the session works without it */ }
    }
    // That registration waited on Pi. The adapter may have been retired meanwhile, or the process may
    // have ended: neither is handed out, or filed, as this session's live process.
    if (this.destroyed) { await discard(); throw new Error("Pi adapter has been destroyed"); }
    if (restartSignal.aborted) { await discard(); throw abortError(); }
    if (current.closed) {
      const failed = new PiStartupError("Pi exited during startup", "exit", await client.exited);
      throw new PiStartupError(this.startupMessage(failed), failed.reason, failed.exit);
    }
    this.workers.set(sessionId, current);
    return current;
  }

  private startupMessage(error: PiStartupError): string {
    if (error.reason === "spawn") return "Pi could not be started. Check that Pi is installed and that the configured executable path is correct.";
    if (error.reason === "timeout") return "Pi did not become ready in time.";
    const detail = sanitizePiErrorText(error.exit?.stderrTail ?? "", 400);
    return `Pi exited during startup${detail ? `: ${detail}` : ""}`;
  }

  private handleExit(worker: Worker): void {
    const expected = worker.closed;
    worker.closed = true;
    if (this.workers.get(worker.sessionId) === worker) this.workers.delete(worker.sessionId);
    worker.bridge?.close();
    void worker.endpoint?.dispose();
    const turn = worker.turn;
    if (turn && turn.worker === worker && !turn.done.settled) {
      if (expected || turn.stopRequested) turn.done.resolve();
      else turn.done.reject(new EngineIncompleteResponseError("Pi exited before the turn finished", "interrupted"));
    }
  }

  private async closeWorker(worker: Worker, options: { graceMs?: number; terminate?: boolean } = {}): Promise<void> {
    if (worker.closed && !worker.client.isAlive) return;
    worker.closed = true;
    if (this.workers.get(worker.sessionId) === worker) this.workers.delete(worker.sessionId);
    if (options.terminate) worker.client.terminate();
    else await worker.client.close({ graceMs: options.graceMs ?? 5_000 }).catch(() => {});
    await Promise.race([worker.client.exited, sleep(8_000)]);
    worker.bridge?.close();
    await worker.endpoint?.dispose();
  }

  private sweepIdleWorkers(): Promise<void> {
    this.sweeping ??= this.sweepOnce().finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  /**
   * Close the workers idle past their TTL. What the Host owns (a turn, an
   * exclusive control, an open dialog) keeps a worker as it is. Pi's own run
   * and compaction flags are asked afresh: a cached flag that went stale would
   * otherwise keep the worker for good. Closes run side by side, so one slow
   * Pi exit does not hold back the rest.
   */
  private async sweepOnce(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const worker of [...this.workers.values()]) {
      const idle = Date.now() - worker.lastUsedAt;
      if (worker.closed) continue;
      if (idle < this.idleWorkerTtlMs) {
        // Fresh only because something outside a turn keeps using it: say what, so a worker that never expires can be explained.
        const sinceTurn = Date.now() - worker.lastTurnAt;
        if (!worker.turn && worker.touchedBy && sinceTurn >= this.idleWorkerTtlMs) this.keepIdle(worker, `kept fresh by ${worker.touchedBy}; last turn ${Math.round(sinceTurn / 1000)} s ago`, idle);
        continue;
      }
      const held = worker.turn ? "a turn is running" : worker.exclusive ? `${worker.exclusive} is in progress` : worker.dialogs.size ? `${worker.dialogs.size} extension dialog(s) open` : undefined;
      if (held) { this.keepIdle(worker, held, idle); continue; }
      // Ask Pi itself before closing: an extension may have started work the Host did not see.
      const usedAt = worker.lastUsedAt;
      let state: PiSessionState;
      try { state = await this.refreshState(worker); } catch (error) { this.keepIdle(worker, `Pi did not report its state (${error instanceof Error ? error.name : "error"})`, idle); continue; }
      // The Host may have started something while Pi answered: looked at again here, not taken from before the question.
      const busy = worker.turn ? "a turn started" : worker.exclusive ? `${worker.exclusive} started` : worker.dialogs.size ? "an extension dialog opened"
        : worker.lastUsedAt !== usedAt ? "used while Pi was asked" : state.isStreaming ? "Pi reports a run in progress" : state.isCompacting ? "Pi reports a compaction"
        : state.pendingMessageCount > 0 ? `pending messages: ${state.pendingMessageCount}` : undefined;
      if (busy) { this.keepIdle(worker, busy, idle); continue; }
      this.log(`[pi] closed idle worker ${worker.sessionId.slice(0, 8)} after ${Math.round(idle / 1000)} s idle`);
      closing.push(this.closeWorker(worker));
    }
    await Promise.all(closing);
  }

  private keepIdle(worker: Worker, reason: string, idle: number): void {
    // The same reason with only its durations changed is not news.
    const key = reason.replace(/\d+ s\b/g, "");
    if (this.sweepReasons.get(worker) === key) return;
    this.sweepReasons.set(worker, key);
    this.log(`[pi] kept idle worker ${worker.sessionId.slice(0, 8)} past its TTL (${Math.round(idle / 1000)} s idle): ${reason}`);
  }

  private log(line: string): void {
    try { (this.options.log ?? (text => console.error(text)))(line); } catch { /* diagnostics never affect a worker */ }
  }

  /** Pi's state as it answered. `worker.state` took it in stream order (`onResponse`), and later events may have moved it on. */
  private async refreshState(worker: Worker): Promise<PiSessionState> {
    return worker.client.request({ type: "get_state" });
  }

  /**
   * Make the Host's view follow Pi's. An extension command can replace the
   * session on its own (`ctx.newSession`, `ctx.fork`, `ctx.switchSession`);
   * the process then serves a different native session than the one it is
   * filed under here. Returns the session id the process serves now.
   */
  private async reconcileSession(worker: Worker): Promise<string> {
    if (worker.closed || !worker.client.isAlive) return worker.sessionId;
    const state = await this.refreshState(worker);
    return state.sessionId === worker.sessionId ? worker.sessionId : this.adoptReplacement(worker, "native", state);
  }

  /** Reword what the owner can act on. The error keeps its Pi type: the Host classifies by it, and its text is already sanitized. */
  private publicError(error: unknown): unknown {
    if (error instanceof PiRpcCommandError) {
      if (error.kind === "no-model") return new PiRpcCommandError(error.command, "Pi has no usable model. Sign in to a provider in a terminal with `pi auth login <provider>`, or choose a model whose provider is signed in.", error.kind, error.provider);
      if (error.kind === "auth") return new PiRpcCommandError(error.command, `Pi could not authenticate with the model provider. Sign in again in a terminal with \`pi auth login <provider>\`. (${error.message})`, error.kind, error.provider);
    }
    return error;
  }

  // ---------------------------------------------------------------- native controls

  private publish(sessionId: string, event: PiNativeEvent): void {
    for (const listener of [...(this.subscribers.get(sessionId) ?? [])]) { try { listener(event); } catch { /* listener errors stay local */ } }
  }

  private publishState(worker: Worker): void {
    if (!this.subscribers.get(worker.sessionId)?.size) return;
    void this.describeState(worker).then(state => this.publish(worker.sessionId, { type: "state", state })).catch(() => {});
  }

  private async describeState(worker: Worker): Promise<PiNativeState> {
    const state = worker.state, model = isPiPlaceholderModel(state.model) ? undefined : state.model!;
    const record = await this.store.record(worker.sessionId);
    let levels: PiThinkingLevel[] = [state.thinkingLevel];
    try { levels = (await worker.client.request({ type: "get_available_thinking_levels" })).levels.filter(isThinkingLevel); } catch { /* keep the current level */ }
    return {
      sessionId: worker.sessionId, ...(state.sessionName ? { sessionName: state.sessionName } : {}),
      ...(model ? { model: { provider: model.provider, modelId: model.id, name: model.name, reasoning: Boolean(model.reasoning), input: [...(model.input ?? [])], contextWindow: model.contextWindow } } : {}),
      modelSource: record.modelSource ?? "native",
      thinkingLevel: state.thinkingLevel, availableThinkingLevels: levels,
      isStreaming: state.isStreaming, isCompacting: state.isCompacting,
      steeringMode: state.steeringMode, followUpMode: state.followUpMode, autoCompactionEnabled: state.autoCompactionEnabled,
      pending: { steering: [...worker.queue.steering], followUp: [...worker.queue.followUp] },
      bridge: worker.bridge?.isOpen ? "connected" : "unavailable",
      ui: {
        status: { ...worker.ui.status },
        widgets: Object.fromEntries(Object.entries(worker.ui.widgets).map(([key, widget]) => [key, { lines: [...widget.lines], placement: widget.placement }])),
        ...(worker.ui.title ? { title: worker.ui.title } : {}),
        ...(worker.ui.editorText ? { editorText: { ...worker.ui.editorText } } : {}),
      },
    };
  }

  private async describeTrust(worker: Worker): Promise<PiNativeProjectTrust> {
    const decision = await this.store.trustDecision(worker.cwd);
    return { hasProjectFiles: await hasPiTrustGatedFiles(worker.cwd), ...(decision ? { decision } : {}), ...(typeof worker.trusted === "boolean" ? { loaded: worker.trusted } : {}) };
  }

  private async describeScope(worker: Worker): Promise<PiNativeModelScope> {
    const scope = (await this.store.scopedModels()).map(decodePiModel).filter((model): model is PiModelRef => Boolean(model));
    let nativePatterns: string[] = [];
    if (worker.bridge?.isOpen) {
      try {
        const enabled = (await worker.bridge.readSettings()).enabledModels;
        if (Array.isArray(enabled)) nativePatterns = enabled.filter((item): item is string => typeof item === "string").slice(0, 200);
      } catch { /* shown as none */ }
    }
    return { scope, nativePatterns };
  }

  /** A local file offered for import: a regular file of bounded size whose first line is a Pi session header. */
  private async importCandidate(worker: Worker, file: string): Promise<{ path: string; header: { id: string; cwd: string }; sameWorkspace: boolean; alreadyPresent: boolean } | undefined> {
    // "~/…" as the owner would type it in a terminal; anything relative is taken from the workspace.
    const expanded = file === "~" || file.startsWith("~/") || file.startsWith("~\\") ? path.join(os.homedir(), file.slice(1)) : file;
    const resolved = path.resolve(worker.cwd, expanded);
    try {
      const info = await lstat(resolved);
      // A symbolic link could point anywhere; the owner names the real file.
      if (!info.isFile() || info.size === 0 || info.size > IMPORT_MAX_BYTES) return;
    } catch { return; }
    const header = await this.store.readHeader(resolved);
    if (!header || !isSafePiSessionId(header.id)) return;
    const existing = await this.store.find(header.id, worker.cwd);
    return {
      path: resolved, header, sameWorkspace: samePiWorkspace(header.cwd, worker.cwd),
      alreadyPresent: Boolean(existing) || this.workers.has(header.id),
    };
  }

  private async live(sessionId: string): Promise<Worker> {
    this.assertUsable();
    const worker = this.workers.get(sessionId);
    if (worker && !worker.closed && worker.client.isAlive) { worker.lastUsedAt = Date.now(); if (!worker.turn) worker.touchedBy = "a native Pi control"; return worker; }
    return this.ensureWorker(sessionId, await this.resolveWorkspace(undefined));
  }

  private requireBridge(worker: Worker, operation: string): PiBridgeConnection {
    if (!worker.bridge?.isOpen) throw new PiNativeBridgeUnavailableError(operation);
    return worker.bridge;
  }

  /** Tree navigation, reload, compaction and session replacement need Pi idle; Pi refuses them mid-run. */
  private async exclusive<T>(worker: Worker, operation: string, run: () => Promise<T>): Promise<T> {
    const state = await this.refreshState(worker);
    // The command layer runs inside a turn that has not prompted yet; only a real native run blocks.
    if (state.isStreaming || state.isCompacting || worker.exclusive || (worker.turn && worker.turn.mapper.runStarted && !worker.turn.mapper.settled)) throw new PiNativeBusyError(operation);
    worker.exclusive = operation;
    try { return await run(); } finally { worker.exclusive = undefined; worker.lastUsedAt = Date.now(); }
  }

  /**
   * The same process now serves another native session. File it under the new
   * id, move the subscribers, and tell them. A session opened from a file
   * outside the Bot's own directory is remembered by path so it can be found
   * again. If another process already serves that session it is closed: one
   * session file must not have two writers.
   */
  private async adoptReplacement(worker: Worker, reason: "fork" | "clone" | "new" | "native", known?: PiSessionState): Promise<string> {
    const previous = worker.sessionId;
    const state = known ?? await this.refreshState(worker);
    const next = state.sessionId;
    if (next === previous) return previous;
    if (!isSafePiSessionId(next)) {
      // An id the Host cannot address later: do not file the process under it.
      await this.closeWorker(worker, { graceMs: 2_000 });
      throw new Error("Pi switched to a session the Host cannot address");
    }
    const other = this.workers.get(next);
    if (other && other !== worker) {
      if (other.turn || other.exclusive) {
        await this.closeWorker(worker, { graceMs: 2_000 });
        throw new Error("Pi switched to a session that is busy in another conversation");
      }
      await this.closeWorker(other, { graceMs: 2_000 });
    }
    if (this.workers.get(previous) === worker) this.workers.delete(previous);
    worker.sessionId = next;
    worker.generation++;
    worker.token = randomUUID();
    worker.queue = { steering: [], followUp: [] };
    this.workers.set(next, worker);
    if (reason === "fork" || reason === "clone") await this.store.inheritRecord(previous, next);
    const file = state.sessionFile;
    if (file && path.dirname(path.resolve(file)) !== this.store.sessionDir) await this.store.updateRecord(next, { externalPath: path.resolve(file) });
    const listeners = this.subscribers.get(previous);
    if (listeners) { this.subscribers.delete(previous); this.subscribers.set(next, new Set([...(this.subscribers.get(next) ?? []), ...listeners])); }
    this.publish(next, { type: "session_replaced", previousSessionId: previous, sessionId: next, reason });
    this.publishState(worker);
    return next;
  }

  private createNativeControls(): PiNativeControls {
    const trigger = (worker: Worker) => (text: string) => worker.client.request({ type: "prompt", message: text }).then(result => result.disposition);
    const controls: PiNativeControls = {
      getLiveSession: sessionId => this.liveSession(sessionId),
      getState: async sessionId => { const worker = await this.live(sessionId); await this.refreshState(worker); return this.describeState(worker); },
      listModels: async sessionId => (await (await this.live(sessionId)).client.request({ type: "get_available_models" })).models,
      listCommands: async sessionId => this.nativeCommands(await this.live(sessionId)),
      getStats: async sessionId => {
        const worker = await this.live(sessionId);
        const stats = await worker.client.request({ type: "get_session_stats" });
        // The per-model split is not an RPC value; Pi's terminal UI derives it from the session entries, and so does this.
        let costByModel: PiNativeStats["costByModel"];
        try { costByModel = piUsageCostBreakdown((await worker.client.request({ type: "get_entries" })).entries); } catch { costByModel = undefined; }
        return {
          userMessages: stats.userMessages, assistantMessages: stats.assistantMessages, toolCalls: stats.toolCalls, totalMessages: stats.totalMessages,
          tokens: { ...stats.tokens }, costUsd: stats.cost, ...(stats.contextUsage ? { context: { ...stats.contextUsage } } : {}),
          ...(costByModel ? { costByModel } : {}),
        } satisfies PiNativeStats;
      },
      getTree: async (sessionId): Promise<PiNativeTree> => { const { tree, leafId } = await (await this.live(sessionId)).client.request({ type: "get_tree" }); return piNativeTree(tree, leafId); },
      listForkPoints: async sessionId => (await (await this.live(sessionId)).client.request({ type: "get_fork_messages" })).messages,
      getLastAssistantText: async sessionId => (await (await this.live(sessionId)).client.request({ type: "get_last_assistant_text" })).text ?? undefined,
      listTools: async (sessionId): Promise<PiNativeTool[]> => { const worker = await this.live(sessionId); return this.requireBridge(worker, "listing tools").listTools(); },
      subscribe: (sessionId, listener) => {
        const set = this.subscribers.get(sessionId) ?? new Set();
        this.subscribers.set(sessionId, set);
        set.add(listener);
        return () => { for (const listeners of this.subscribers.values()) listeners.delete(listener); };
      },

      setModel: async (sessionId, model) => { const worker = await this.live(sessionId); await this.chooseForSession(worker, { model }); return this.describeState(worker); },
      setThinkingLevel: async (sessionId, level) => { const worker = await this.live(sessionId); await this.chooseForSession(worker, { thinking: level }); return this.describeState(worker); },
      setSessionName: async (sessionId, name) => {
        const trimmed = name.trim();
        if (!trimmed) throw new PiNativeRejectedError("A session name cannot be empty", "invalid");
        // The same 200 units as before, cut so that it never leaves half of a surrogate pair.
        await (await this.live(sessionId)).client.request({ type: "set_session_name", name: piClip(trimmed, 200) });
      },
      followUp: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        const prompt = await buildPiPrompt({ text: input.text, files: input.files ?? [], modelAcceptsImages: Boolean(worker.state.model?.input?.includes("image")) });
        const result = await worker.client.request({ type: "follow_up", message: prompt.message, ...(prompt.images.length ? { images: prompt.images } : {}) });
        const imageNotice = piSkippedImagesNotice(prompt.skippedImages, worker.turn?.input.locale ?? "en");
        if (imageNotice) this.publishUi(worker, { type: "notify", level: "warning", text: imageNotice }, "host");
        return result.disposition;
      },
      clearQueue: async sessionId => {
        const worker = await this.live(sessionId);
        const cleared = await worker.client.request({ type: "clear_queue" });
        worker.queue = { steering: [], followUp: [] };
        this.publishState(worker);
        return { steering: [...cleared.steering], followUp: [...cleared.followUp] };
      },
      compact: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "compaction", async (): Promise<PiNativeCompaction> => {
          const result = await worker.client.request({ type: "compact", ...(input?.instructions?.trim() ? { customInstructions: input.instructions.trim() } : {}) });
          return {
            summary: result.summary,
            ...(typeof result.tokensBefore === "number" ? { tokensBefore: result.tokensBefore } : {}),
            ...(typeof result.estimatedTokensAfter === "number" ? { estimatedTokensAfter: result.estimatedTokensAfter } : {}),
          };
        });
      },
      abortRetry: async sessionId => { await (await this.live(sessionId)).client.request({ type: "abort_retry" }); },
      runUserBash: async (sessionId, input): Promise<PiNativeBashResult> => {
        const worker = await this.live(sessionId);
        const off = input.onOutput ? worker.client.onEvent(event => { if (event.type === "bash_execution_update") input.onOutput!(event.delta); }) : undefined;
        const abort = () => { void worker.client.request({ type: "abort_bash" }).catch(() => {}); };
        input.abortSignal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await worker.client.request({ type: "bash", command: input.command, ...(input.excludeFromContext ? { excludeFromContext: true } : {}) });
          return { output: result.output, exitCode: result.exitCode ?? null, cancelled: result.cancelled, truncated: result.truncated, ...(result.fullOutputPath ? { fullOutputPath: result.fullOutputPath } : {}) };
        } finally { off?.(); input.abortSignal?.removeEventListener("abort", abort); }
      },
      exportHtml: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        // Pi writes the file but does not create its directory.
        if (input?.outputPath) await mkdir(path.dirname(path.resolve(worker.cwd, input.outputPath)), { recursive: true });
        return worker.client.request({ type: "export_html", ...(input?.outputPath ? { outputPath: input.outputPath } : {}) });
      },
      setActiveTools: async (sessionId, names) => { const worker = await this.live(sessionId); return this.requireBridge(worker, "changing tools").setActiveTools(names); },
      reload: async sessionId => {
        const worker = await this.live(sessionId), bridge = this.requireBridge(worker, "reload");
        await this.exclusive(worker, "reload", async () => {
          await bridge.control({ op: "reload" }, { trigger: trigger(worker), timeoutMs: 120_000 });
          await this.refreshState(worker);
          this.publishState(worker);
        });
      },
      setLabel: async (sessionId, input) => { const worker = await this.live(sessionId); await this.requireBridge(worker, "labelling an entry").setLabel(input.entryId, input.label); },
      navigateTree: async (sessionId, input) => {
        const worker = await this.live(sessionId), bridge = this.requireBridge(worker, "tree navigation");
        return this.exclusive(worker, "tree navigation", async () => {
          const before = await worker.client.request({ type: "get_tree" });
          const known = piNativeTree(before.tree, before.leafId).nodes.some(node => node.id === input.targetId);
          if (!known) throw new PiNativeRejectedError("That entry is not part of this session", "not-found");
          const result = await bridge.control(
            { op: "navigate", targetId: input.targetId, ...(input.summarize ? { summarize: true } : {}), ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}), ...(input.label ? { label: input.label } : {}) },
            { trigger: trigger(worker), timeoutMs: 10 * 60_000 },
          );
          const after = await worker.client.request({ type: "get_tree" });
          await this.refreshState(worker);
          this.publishState(worker);
          // Pi's terminal UI puts a user message back into the editor; over RPC it does not, so hand the text back.
          const editorText = result.cancelled ? undefined : piUserEntryText(before.tree, input.targetId);
          return { cancelled: Boolean(result.cancelled), leafId: after.leafId, ...(editorText ? { editorText } : {}) };
        });
      },

      fork: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "fork", async () => {
          const result = await worker.client.request({ type: "fork", entryId: input.entryId });
          if (result.cancelled) return { sessionId: worker.sessionId, text: "", cancelled: true };
          return { sessionId: await this.adoptReplacement(worker, "fork"), text: result.text ?? "", cancelled: false };
        });
      },
      clone: async sessionId => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "clone", async () => {
          const result = await worker.client.request({ type: "clone" });
          return result.cancelled ? { sessionId: worker.sessionId, cancelled: true } : { sessionId: await this.adoptReplacement(worker, "clone"), cancelled: false };
        });
      },
      newSession: async sessionId => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "new session", async () => {
          const result = await worker.client.request({ type: "new_session" });
          return result.cancelled ? { sessionId: worker.sessionId, cancelled: true } : { sessionId: await this.adoptReplacement(worker, "new"), cancelled: false };
        });
      },

      getProjectTrust: async sessionId => this.describeTrust(await this.live(sessionId)),
      setProjectTrust: async (sessionId, decision) => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "changing project trust", async () => {
          await this.store.setTrustDecision(worker.cwd, decision);
          // Pi reads project files once, at startup.
          return this.describeTrust(await this.restartWorker(worker));
        });
      },
      exportJsonl: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        const { entries, leafId } = await worker.client.request({ type: "get_entries" });
        const byId = new Map(entries.map(entry => [entry.id, entry]));
        const branch: typeof entries = [];
        for (let cursor = leafId ? byId.get(leafId) : undefined, guard = 0; cursor && guard <= entries.length; guard++) {
          branch.push(cursor);
          cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
        }
        branch.reverse();
        const file = worker.state.sessionFile ? await this.store.readHeader(worker.state.sessionFile) : undefined;
        // Same shape Pi's own `/export file.jsonl` writes: a fresh header, then the active branch re-linked as one chain.
        const header = { type: "session", version: file?.version ?? 3, id: worker.sessionId, timestamp: new Date().toISOString(), cwd: worker.cwd };
        const lines = [header, ...branch.map((entry, index) => ({ ...entry, parentId: index === 0 ? null : branch[index - 1]!.id }))];
        const target = path.resolve(worker.cwd, input.outputPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`, { mode: 0o600 });
        return { path: target, entries: branch.length };
      },
      inspectImport: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        const candidate = await this.importCandidate(worker, input.path);
        if (!candidate) return undefined;
        return { sessionId: candidate.header.id, sameWorkspace: candidate.sameWorkspace, alreadyPresent: candidate.alreadyPresent };
      },
      importSession: async (sessionId, input) => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "import", async () => {
          const candidate = await this.importCandidate(worker, input.path);
          if (!candidate) throw new PiNativeRejectedError("That file is not a Pi session file", "invalid");
          // Pi runs a session's tools in the directory recorded in the session, which must be this Bot's workspace.
          if (!candidate.sameWorkspace) throw new PiNativeRejectedError("That session belongs to another workspace", "invalid");
          if (candidate.alreadyPresent) throw new PiNativeRejectedError("That session is already among this Bot's sessions", "invalid");
          await this.store.ensureDirs();
          const destination = await this.store.importDestination(candidate.path, candidate.header.id);
          await copyFile(candidate.path, destination, fsConstants.COPYFILE_EXCL);
          try {
            const result = await worker.client.request({ type: "switch_session", sessionPath: destination });
            if (result.cancelled) { await rm(destination, { force: true }); return { sessionId: worker.sessionId, cancelled: true }; }
          } catch (error) {
            await rm(destination, { force: true });
            throw error;
          }
          return { sessionId: await this.adoptReplacement(worker, "native"), cancelled: false };
        });
      },
      getModelScope: async sessionId => this.describeScope(await this.live(sessionId)),
      setModelScope: async (sessionId, models) => {
        const worker = await this.live(sessionId);
        return this.exclusive(worker, "changing the model scope", async () => {
          const chosen = models ?? [];
          const native = (model: PiModelRef) => `${model.provider}/${model.modelId}`;
          const unusable = chosen.find(model => native(model).includes(","));
          if (unusable) throw new PiNativeRejectedError(`"${native(unusable)}" cannot be scoped: Pi's --models list is comma-separated`, "invalid");
          if (chosen.length) {
            const available = (await worker.client.request({ type: "get_available_models" })).models;
            const unknown = chosen.filter(model => !available.some(candidate => candidate.provider === model.provider && candidate.id === model.modelId)).map(native);
            if (unknown.length) throw new PiNativeRejectedError(`Not available in Pi: ${unknown.join(", ")}`, "model-unavailable", unknown);
          }
          // Stored in the Host's canonical form; only the shared codec turns it back into a native pair.
          await this.store.setScopedModels(chosen.map(model => encodePiModel(model.provider, model.modelId)));
          // The scope is a startup flag; other live sessions of this Bot pick it up when their process next starts.
          return this.describeScope(await this.restartWorker(worker));
        });
      },

      setNativeGlobalSetting: async (sessionId, setting: PiNativeGlobalSetting) => {
        const worker = await this.live(sessionId);
        if (setting.key === "steeringMode") await worker.client.request({ type: "set_steering_mode", mode: setting.value });
        else if (setting.key === "followUpMode") await worker.client.request({ type: "set_follow_up_mode", mode: setting.value });
        else if (setting.key === "autoCompaction") await worker.client.request({ type: "set_auto_compaction", enabled: setting.value });
        else if (setting.key === "autoRetry") await worker.client.request({ type: "set_auto_retry", enabled: setting.value });
        await this.refreshState(worker);
        this.publishState(worker);
      },
    };
    return controls;
  }
}

/** Pi-native controls of an adapter, when it has them. Prefer this over `instanceof` so tests can substitute a fake. */
export function getPiNativeControls(adapter: CodexAdapter | undefined): PiNativeControls | undefined {
  const controls = (adapter as { piNative?: unknown } | undefined)?.piNative;
  return controls && typeof controls === "object" && typeof (controls as PiNativeControls).getState === "function" ? controls as PiNativeControls : undefined;
}

/** Client-safe model rows for a session, in the Bot setting's `provider/model` form. */
export async function listPiModelChoices(controls: PiNativeControls, sessionId: string) {
  return parsePiModels(await controls.listModels(sessionId));
}

export { encodePiModel };
