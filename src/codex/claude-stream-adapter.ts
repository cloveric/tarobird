import { isLogicalSessionId } from "../runtime/logical-session.js";
import { claudeAssistantError, claudeError, claudeResultRepeatsError } from "./claude-errors.js";
import { wholeFilePatch } from "../core/recorded-diff.js";
import { ClaudeScopedEvents, type ClaudeScope } from "./claude-scoped-events.js";
import { spawnEngine } from "../runtime/engine-process.js";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import { createClaudeInstructionsFile, type ClaudeInstructionsFile } from "./claude-instructions-file.js";
import { ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS } from "./engine-timeouts.js";
// Use the shared kill helper (SIGTERM then grace + SIGKILL escalation) rather
// than a local SIGTERM-only copy, so a Claude CLI (and its MCP/sandbox children)
// that ignores SIGTERM is still force-killed — matching the other adapters.
import { killProcessTree } from "./process-tree.js";
import { APP_STOP_PROCESS_GRACE_MS, APP_USER_STOP_REASON, appStopKillOptions } from "../runtime/turn-cancellation.js";
import { sideAttachmentPrompt } from "./side-attachments.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { ClaudeTurnRecovery, claudeNoResponseError, isClaudeNoResponsePlaceholder } from "./claude-turn-recovery.js";
import { ClaudeSessionUsage } from "./claude-session-usage.js";
import { EngineRetryableError, type EngineRetryReason } from "./turn-retry.js";
import { classifyFailure } from "../runtime/error-classification.js";
import { ClaudeAppMcp, ClaudeAppMcpInitializationError, CLAUDE_APP_MCP_SERVER, claudeAppInstructions } from "./claude-app-mcp.js";
import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver, NativeInputProgress } from "../client-protocol/native-input.js";
import {
  CLAUDE_INTERRUPT_RECEIPT,
  CLAUDE_INTERRUPT_SEND_NOW,
  CLAUDE_MESSAGE_LIFECYCLE,
  CLAUDE_REQUEST_MARKER_LISTS,
  ClaudeControlError,
  ClaudeNativeControl,
  isTerminalCommandState,
  type ClaudeCommandState,
  type ClaudeEndedTask,
  type ClaudeNativeTask,
} from "./claude-native-control.js";

import { EngineCancellationUnconfirmedError, EngineStopTooLateError, EngineSteeringRejectedError, EngineNativeInputUnsentError } from "./adapter.js";
import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineAnswerProgress,
  EngineStreamEvent,
  EngineSideSession,
  CodexUserMessageInput,
  AppPlatformTools,
  SideCapability,
} from "./adapter.js";
import {
  ClaudeSideChannelClosedError,
  ClaudeSideProcess,
  ClaudeSideQuestionChannel,
  boundedSideHistory,
  claudeSideProcessArgs,
  resolveClaudeConfigDir,
  type ClaudeSideExchange,
} from "./claude-side-question.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile, resolveEngineOverride } from "../state/instance-config.js";
import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";
import { redactSecrets } from "../runtime/secret-redaction.js";
import { claudeManagedSearchServers, type NativeSearchMcpPlanner } from "../runtime/native-search-mcp.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void;
};

type Writable = {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  on?(event: "error", listener: (error: Error) => void): void;
};

type ClaudeChildProcess = {
  pid?: number;
  stdin?: Writable;
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: () => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnClaude = (command: string, args: string[], options: SpawnOptions) => ClaudeChildProcess;

const claudePartialEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content_block_start"), index: z.number().int().nonnegative(), content_block: z.object({ type: z.enum(["text", "thinking"]), text: z.string().optional(), thinking: z.string().optional() }) }),
  z.object({ type: z.literal("content_block_delta"), index: z.number().int().nonnegative(), delta: z.discriminatedUnion("type", [z.object({ type: z.literal("text_delta"), text: z.string() }), z.object({ type: z.literal("thinking_delta"), thinking: z.string() })]) }),
]);
type ClaudePartialBlock = { index: number; raw: string; visible: string };
type ClaudeStreamEvent = {
  uuid?: string;
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  api_error_status?: string | number | null;
  terminal_reason?: string;
  /** On `result`: client uuid of the user message that opened this native turn. */
  user_message_uuid?: string;
  /** `request_marker_lists_v1`: uuids a model request (or the reply to it) carries. */
  user_message_uuids?: unknown;
  /** `task_updated`: the changed task fields. */
  patch?: Record<string, unknown>;
  /** Present on an assistant message that reports an API error instead of a reply. */
  error?: unknown;
  isApiErrorMessage?: boolean;
  request_id?: string;
  task_id?: string;
  tool_use_id?: string;
  task_type?: string;
  status?: string;
  summary?: string;
  output_file?: string;
  parent_tool_use_id?: string;
  tool_use_result?: unknown;
  event?: unknown;
  mcp_server_errors?: unknown;
  origin?: {
    kind?: string;
  } | null;
  request?: {
    subtype?: string;
    tool_name?: string;
    tool_use_id?: string;
    toolName?: string;
    input?: unknown;
    tool_input?: unknown;
    toolInput?: unknown;
    cwd?: string;
    permission_suggestions?: unknown[];
    permissionSuggestions?: unknown[];
  };
  message?: {
    id?: string;
    model?: string;
    content?: Array<{
      type?: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      id?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
};

type PendingTurn = {
  inputOwnerKey?: string;
  nativeAdmission?: boolean;
  nativeStarted?: boolean;
  absorbedReview?: boolean;
  compactionId?: string;
  compactionBoundaries?: Set<string>;
  locale?: "zh" | "en";
  appPlatformTools?: AppPlatformTools;
  promptWritten: boolean;
  turnId: number;
  assistantText: string;
  assistantError?: string;
  partialText?: ClaudePartialBlock;
  partialThinking?: ClaudePartialBlock;
  intermediateDeliveryText: string;
  engineWarnings: string[];
  resolve: (value: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  approvalAbortController: AbortController;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  /** Inactivity watchdog (see armTurnInactivityWatchdog); re-armed on every byte
   * the worker emits, so it only fires when the CLI has gone completely silent. */
  timeout?: ReturnType<typeof setTimeout>;
  /** `/timeout off` (input.disableRuntimeTimeout) — no watchdog for this turn. */
  inactivityTimeoutDisabled?: boolean;
  /** Tool calls started by this turn that have not reported a result yet. A turn
   * with outstanding tool work is still running, so the background-task settle
   * timer must not treat its silence as "finished". */
  outstandingToolUseIds: Set<string>;
  startedAt: number;
  observedToolCalls: number;
  observedToolResults: number;
  pendingToolNames: Map<string, string>;
  lastAssistantWasNoResponsePlaceholder?: boolean;
  backgroundCompletionTimer?: ReturnType<typeof setTimeout>;
  /** uuid of the written prompt; `command_lifecycle` frames name it. */
  commandUuid: string;
  /** The command whose native turn currently carries this host turn: the
   * prompt, or a missed steer that continued it. */
  nativeCommand: string;
  /** Real user text written into this running turn (native steering). */
  steers?: Set<string>;
  /** Own inputs for which `interrupt{send_now}` was requested on this turn: if
   * Claude then cuts the turn, the queued input continues it instead of being
   * withdrawn as after a failure. */
  sendNowRequested?: Set<string>;
  /** A steer missed the fold: Claude runs it as the next native turn, which
   * continues this same host turn. Holds the first native result meanwhile. */
  continuation?: {
    text: string;
    usage: Promise<AdapterUsage | undefined>;
    awaiting: Set<string>;
    timer?: ReturnType<typeof setTimeout>;
    dropped: number;
    /** The held text ends where Claude cut the turn for a send-now input. */
    cut?: boolean;
  };
};

type NativeInputState = NativeInputProgress["state"];
/** One ordinary App input written into a running Claude turn. Its host id maps
 * to a native uuid of this worker only; control never reaches another process. */
type ClaudeNativeInput = {
  id: string;
  uuid: string;
  observer: NativeInputObserver;
  /** The host turn it was written into; released once its fate is settled. */
  turn?: PendingTurn;
  /** Last progress reported to the observer, and its reason. */
  reported?: NativeInputState;
  reason?: string;
  /** Highest admission evidence: 1 queued, 2 dequeued, 3 received. */
  rank: number;
  /** Why this host withdrew it (cancel_async_message), if it did. */
  withdrawn?: "stopped" | "turn_failed" | "not_started" | "retracted";
  /** Own cancel_async_message requests still unanswered, and whether one answered `cancelled:true`. */
  cancelPending: number;
  cancelConfirmed?: boolean;
  /** A user withdrawal is awaiting Claude's answer. */
  retracting?: boolean;
  /** One user control (send-now or withdrawal) at a time per input. */
  controlPending?: boolean;
  /** Claude answered a send-now for it with delivering/stopped, or its answer
   * is unknown: a later cut of the turn is for this input. */
  sendNowEffective?: boolean;
  /** Its lifecycle reached a terminal state: Claude holds nothing more for it. */
  terminal?: boolean;
  /** The turn that consumed it ended cleanly (`completed`). */
  ended?: boolean;
  /** A turn result arrived while it was dequeued (an input that opened its own
   * turn ends after that result; a folded one ends before it). */
  resultSeen?: boolean;
  /** A main-model reply arrived after it was dequeued (needed before a turn's
   * result markers may count as the model's receipt of it). */
  repliedAfterDequeue?: boolean;
};

const NO_PROGRESS = () => undefined;

const NATIVE_INPUT_RANK: Partial<Record<NativeInputState, number>> = { queued: 1, dequeued: 2, received: 3 };

/** `request_marker_lists_v1` uuid lists; anything else carries none. */
function markerList(value: unknown, single?: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").slice(0, 64);
  return typeof single === "string" && single ? [single] : [];
}

/** The task id of a blocking call Claude moved to the background mid-run
 * (2.1.309: for a waiting message, or by the Ctrl+B-equivalent request). */
function backgroundedTaskId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const record = result as Record<string, unknown>;
  if (record.backgroundedToDeliverMessage !== true && record.backgroundedByUser !== true) return undefined;
  return typeof record.backgroundTaskId === "string" && record.backgroundTaskId ? record.backgroundTaskId.slice(0, 200) : undefined;
}

/** Between a soft App stop and the interrupted native turn's terminal frames.
 * Nothing written to stdin may start, and nothing read is attributed, before it opens. */
type ClaudeStopFence = {
  /** Own prompt/steer uuids that have not reached a terminal lifecycle state. */
  commands: Set<string>;
  /** Terminal lifecycle frames may arrive before the corresponding result. */
  ownedCommands: Set<string>;
  /** Kept after the stop promise times out, for a late command start. */
  nativeAdmission?: boolean;
  /** A native turn started by one of those commands has not emitted its result. */
  openTurn: boolean;
  /** The stopped host turn: it settles only once Claude confirms the stop. */
  turn?: PendingTurn;
  /** That turn's native command; its own result tells whether the stop came too late. */
  command?: string;
  tooLate?: boolean;
  receiptStopped?: boolean;
  /** The confirmation window passed: the stop is unconfirmed until Claude settles. */
  unconfirmed: boolean;
  /** Private to this fence; issued only once the stop is unconfirmed, it
   * authorizes exactly one explicit forced recovery of this worker. */
  recoveryToken?: string;
  done: Promise<void>;
  release: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Structurally the shared `EngineTask` / `EngineTaskSnapshot` /
 * `EngineTaskControlResult`; `parentId` and `owner` are additive. Ids are
 * opaque per-worker tokens, never native task ids. */
export type ClaudeEngineTask = {
  id: string;
  label: string;
  kind: "subagent" | "shell" | "unknown";
  mode: "foreground" | "background";
  status: "running" | "done" | "error" | "stopped" | "unknown";
  canStop: boolean;
  startedAt?: number;
  updatedAt: number;
  progress?: string;
  parentId?: string;
  owner?: "bound" | "unattributed";
};
export type ClaudeEngineTaskSnapshot = {
  supported: boolean;
  tasks: ClaudeEngineTask[];
  foregroundStopScope?: "foreground" | "subagents" | "all";
  /** Present only while a stop is unconfirmed: recoverSession(token) force-stops this worker. */
  recovery?: { token: string; reason: "stop_unconfirmed" };
};
export type ClaudeEngineTaskControlResult = { outcome: "accepted" | "rejected" | "unknown"; reason?: "unsupported" | "stale" | "not_ready" | "uncertain" };
/** What became of one steering input after Claude admitted it. */
export type ClaudeSteerOutcome =
  | { status: "applied"; via: "fold" | "continuation" }
  | { status: "absorbed" }
  | { status: "dropped"; reason: "stopped" | "turn_failed" | "not_started" | "engine_exit" };
export const CLAUDE_STEERING_CAPABILITY = Object.freeze({
  /** Taken in at the running turn's next model request (after the current tool result). */
  delivery: "next_model_request",
  /** `true` from steerActiveTurn means Claude admitted it (lifecycle queued/started). */
  receipt: "admitted",
  /** onOutcome reports applied / absorbed / dropped. */
  outcome: true,
  /** A missed fold runs as Claude's next native turn and continues the same host turn. */
  missedFold: "continues_turn",
  text: true,
  attachments: false,
} as const);

type ClaudeTaskNotificationMetadata = {
  taskId?: string;
  toolUseId?: string;
  status?: string;
  summary?: string;
  outputFile?: string;
  /** Monitor <event> envelopes are progress, not task completion receipts. */
  isMonitorEvent?: boolean;
};

type ClaudeBackgroundTask = ClaudeTaskNotificationMetadata & {
  inputOwnerKey?: string;
  reviewInputToken?: string;
  reviewScope?: ClaudeScope;
  parentToolUseId?: string;
  turnId?: number;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onAnswerProgress?: (progress: EngineAnswerProgress) => void;
  lastSeenAt: number;
  /** Only the first launch acknowledgement refreshes an unstarted call's grace. */
  launchResultSeen?: boolean;
  /** Identity of one review slot, shared with calls launched from that slot. */
  reviewIdentity?: object;
};

function reportAnswerProgress(task: ClaudeBackgroundTask | null | undefined, progress: EngineAnswerProgress): void {
  const notify = task?.onAnswerProgress;
  if (!notify) return;
  if (["finished", "interrupted", "unknown", "waiting_input"].includes(progress.phase)) delete task!.onAnswerProgress;
  // Presentation observers cannot change the engine's permission decision.
  try { notify(progress); } catch { /* best effort */ }
}

type ClaudeTaskNotificationWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
  graceTimer?: ReturnType<typeof setTimeout>;
};

type ClaudeWorker = {
  /** Observed native segment, not a preinstalled notification's UI state. */
  nativeTurnOpen: boolean;
  scoped: ClaudeScopedEvents;
  appMcp?: ClaudeAppMcp;
  child: ClaudeChildProcess;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  lineBuffer: string;
  stderrTail: string;
  currentSessionId: string | null;
  /** Spawned without `-r`: the CLI's cumulative cost ledger starts at zero. */
  freshCostLedger: boolean;
  workspacePath: string | undefined;
  pendingTurn: PendingTurn | null;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  backgroundTasks: Map<string, ClaudeBackgroundTask>;
  finishedBackgroundTaskIds: Set<string>;
  /** Tasks whose terminal result was consumed through TaskOutput in a user turn.
   *  A late out-of-band task-notification must not deliver them a second time. */
  collectedBackgroundTaskIds: Set<string>;
  taskOutputToolUseIds: Map<string, string>;
  explicitBackgroundToolUseIds: Set<string>;
  backgroundToolOwners: Map<string, ClaudeBackgroundTask>;
  ambiguousBackgroundCalls: Set<string>;
  pendingTaskNotification: ClaudeBackgroundTask | null;
  suppressNextTaskNotificationAssistant: boolean;
  taskNotificationTurnActive: boolean;
  taskNotificationWaiters: Set<ClaudeTaskNotificationWaiter>;
  /** Task notifications that completed while ANOTHER task's review was active.
   *  Installing them over pendingTaskNotification mid-review handed the active
   *  review's terminal text to the interloper (wrong task id, wrong turn's
   *  event handler) and left the real owner an undelivered zombie. They wait
   *  here and install once the active review settles. */
  queuedTaskNotifications: Array<{ entry: ClaudeBackgroundTask; reviewTurn: boolean }>;
  taskNotificationAssistantText: string;
  taskNotificationDeliveryText: string;
  lastActivityAt: number;
  instructions: string | null;
  instructionsFile: ClaudeInstructionsFile | null;
  appMcpConfigFile: ClaudeInstructionsFile | null;
  approvalMode: ApprovalMode;
  engineOptionsKey: string;
  chromeIntegration: boolean;
  permissionMode: string;
  deferredSettingsKey?: string;
  retired?: boolean;
  /** Native side questions asked on this parent worker. */
  side?: ClaudeSideQuestionChannel;
  sessionApprovedKeys: Set<string>;
  pendingApprovalByKey: Map<string, Promise<EngineApprovalDecision>>;
  control: ClaudeNativeControl;
  stopFence?: ClaudeStopFence;
  /** A turn held open while its not-yet-folded steer becomes the next native turn. */
  continuationTurn?: PendingTurn;
  steerObservers: Map<string, (outcome: ClaudeSteerOutcome) => void>;
  /** Ordinary App input written natively, by host id and by native uuid. */
  nativeInputs: Map<string, ClaudeNativeInput>;
  nativeInputByUuid: Map<string, ClaudeNativeInput>;
  /** Native inputs the latest model request carried (`status "requesting"`),
   * awaiting the start of the main model's reply to that request. */
  nativeAwaitingReply: Set<string>;
  /** Opaque task ids handed to the host, valid for this worker only. */
  taskTokens: Map<string, string>;
  tokenByTask: Map<string, string>;
};

const backgroundCallKey = (id: string, parent?: string) => parent ? `${parent}\0${id}` : id;

const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_LINE_BUFFER_BYTES = 1024 * 1024;
// A single stream-json event (e.g. a large tool_result from reading a big file)
// can legitimately exceed the 1 MiB line cap. Allow recognized stream-json lines
// to grow to this higher cap before aborting, matching the Codex adapters — only
// non-JSON runaway output hard-fails at MAX_LINE_BUFFER_BYTES.
const MAX_STRUCTURED_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_TAIL_CHARS = 20_000;
const MAX_MCP_SERVER_WARNINGS = 20;
const MAX_MCP_SERVER_WARNING_CHARS = 2_000;
// A cold Claude worker spawn costs ~5-7s before the first token (measured),
// which is the single biggest "bot feels slower than the CLI" factor — the
// operator's usage pattern is bursts separated by hours, so a 30min TTL made
// most comebacks pay the cold start. 2h keeps those warm while still bounding
// how long an idle worker's memory is held on a 16GB host.
const DEFAULT_IDLE_WORKER_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_BACKGROUND_TASK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TASK_NOTIFICATION_START_GRACE_MS = 1000;
const BACKGROUND_TASK_SILENT_SUPPRESS_MS = 60 * 60_000;
const BACKGROUND_TASK_TURN_SETTLE_GRACE_MS = 1500;
// There is deliberately NO total-turn cap for Claude: long autonomous tasks
// (large refactors, image generation, /goal-style runs) are expected to run for
// hours and must not be cut off. The safety net is an INACTIVITY watchdog: a
// wedged CLI that emits nothing at all for this long is not working, and without
// it the turn never settles — holding the cross-process bridge session lock
// (stale only after 12h) and blocking every channel and cron turn on that
// session. `/timeout off` (disableRuntimeTimeout) disables it per turn.
export const CLAUDE_STREAM_INACTIVITY_TIMEOUT_MS = ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS;
// Native soft stop (CLI 2.1.307 probes: receipt and interrupted result arrive
// within ~10 ms). Past these bounds the stop is unconfirmed and falls back to
// the bounded process cleanup instead of leaving the session wedged.
const CLAUDE_INTERRUPT_ACK_TIMEOUT_MS = 3_000;
/** A stop that Claude has not confirmed by then is reported as unconfirmed. */
const CLAUDE_STOP_CONFIRM_TIMEOUT_MS = 10_000;
const CLAUDE_STEER_ACK_TIMEOUT_MS = 5_000;
// A review turn Claude runs first can delay a missed steer's own turn.
const CLAUDE_STEER_CONTINUATION_START_MS = 30_000;
const CLAUDE_TASK_STOP_ACK_TIMEOUT_MS = 10_000;
const CLAUDE_TASK_STOP_END_TIMEOUT_MS = 5_000;
const CLAUDE_SEND_NOW_ACK_TIMEOUT_MS = 5_000;
const CLAUDE_CANCEL_ACK_TIMEOUT_MS = 5_000;
const STEER_ADMITTED = new Set<ClaudeCommandState>(["queued", "started"]);
/** Native inputs kept per worker for duplicate-free retries and control. */
const MAX_NATIVE_INPUTS = 256;

function decodeProcessChunk(
  decoder: StringDecoder,
  chunk: Buffer | { toString(): string } | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();
}

let nextPendingTurnId = 0;

/** A plausible Claude stream-json event line (so a large-but-valid event isn't
 * hard-failed at the 1 MiB cap meant for non-JSON runaway output). */
function looksLikeClaudeStreamJsonLine(value: string): boolean {
  return /^\s*\{\s*"type"\s*:/.test(value);
}

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return isLogicalSessionId(sessionId);
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalizedCommand = normalizeExecutableCommand(command);
  if (process.platform === "win32") return { command: normalizedCommand, args, shell: false };

  if (/\.(cmd|bat)$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...args],
    };
  }

  if (/\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", normalizedCommand, ...args],
    };
  }

  return { command: normalizedCommand, args, shell: false };
}

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** The worker was replaced while a prompt waited, before anything was written. */
class ClaudeWorkerReplacedBeforeWriteError extends Error {
  constructor() { super("Claude engine process was replaced before this message was sent"); this.name = "ClaudeWorkerReplacedBeforeWriteError"; }
}

function sumUsage(a: AdapterUsage | undefined, b: AdapterUsage | undefined): AdapterUsage | undefined {
  if (!a || !b) return a ?? b;
  const add = (x?: number, y?: number) => x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cachedTokens: add(a.cachedTokens, b.cachedTokens), costUsd: add(a.costUsd, b.costUsd) };
}

/** The answer streamed before Claude cut its turn for a send-now input stays
 * as shown; this says why it ends mid-way. */
function withSendNowCutNotice(text: string, locale: "zh" | "en" | undefined): string {
  if (!text.trim()) return text;
  return `${text}\n\n${locale === "en" ? "(Claude stopped this answer to take in a message sent with Send now.)" : "（Claude 为立即发送的消息中断了以上回答。）"}`;
}

/** A cut answer whose send-now input then did not run (stopped or never started). */
function withInterruptedAnswerNotice(text: string, locale: "zh" | "en" | undefined): string {
  if (!text.trim()) return text;
  return `${text}\n\n${locale === "en" ? "(This answer was interrupted.)" : "（以上回答在中途被中断。）"}`;
}

/** A Claude error answer to a native input control: nothing was done. */
function nativeControlRejection(error: ClaudeControlError): NativeInputControlResult {
  return /unsupported|not supported|unrecognized/i.test(error.message) ? { outcome: "rejected", reason: "unsupported" } : { outcome: "rejected", reason: "stale" };
}

function withDroppedSteerNotice(text: string, dropped: number, locale: "zh" | "en" | undefined): string {
  if (dropped <= 0) return text;
  const notice = locale === "en"
    ? `(${dropped} message(s) added while Claude was working did not reach this turn. Send again if still needed.)`
    : `（运行中补充的 ${dropped} 条消息未进入本轮，如仍需要请重新发送。）`;
  return text ? `${text}\n\n${notice}` : notice;
}

function appendAssistantText(existing: string, next: string): string {
  if (!next) {
    return existing;
  }

  return existing ? `${existing}\n${next}` : next;
}

type ClaudeMarkdownFence = { marker: "`" | "~"; length: number };

function claudeFenceLine(line: string): { marker: "`" | "~"; length: number; trailing: string } | undefined {
  const match = /^(?:[\t ]{0,3}>[\t ]?)*[\t ]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line.replace(/\r?\n$/u, ""));
  if (!match) return undefined;
  return {
    marker: match[1]![0] as "`" | "~",
    length: match[1]!.length,
    trailing: match[2] ?? "",
  };
}

function stripClaudeControlFrames(text: string, partial = false): string {
  const cleaned = text
    .replace(
      /(^|\r?\n)[\t ]*(?:user|assistant)?[\t ]*<system-reminder>[\s\S]*?<\/system-reminder>[\t ]*(?=\r?\n|$)/giu,
      "$1",
    )
    .replace(
      /(^|\r?\n)[\t ]*<task-notification>[\s\S]*?<\/task-notification>[\t ]*(?=\r?\n|$)/giu,
      "$1",
    )
    // Older Claude builds emitted this distinctive internal frame without a
    // closing system-reminder tag. Keep blocking that known leak, but do not
    // delete arbitrary user prose merely because it contains an unmatched tag.
    .replace(
      /(^|\r?\n)[\t ]*(?:user|assistant)?[\t ]*<system-reminder>[\t ]*\r?\n[\t ]*\[SYSTEM NOTIFICATION - NOT USER INPUT\][\s\S]*$/giu,
      "$1",
    );
  if (!partial) return cleaned;
  // Withhold a possibly incomplete control frame until its closing delimiter
  // arrives. Final messages retain the existing literal/unclosed-tag behavior.
  const open = /(^|\r?\n)[\t ]*(?:(?:user|assistant)[\t ]*)?<(?:system-reminder|task-notification)>/iu.exec(cleaned);
  if (open) return cleaned.slice(0, open.index);
  const lastLine = cleaned.lastIndexOf("\n") + 1;
  const tail = cleaned.slice(lastLine).trimStart().toLowerCase();
  const afterRole = tail.replace(/^(?:user|assistant)[\t ]*/u, "");
  if (["<system-reminder>", "<task-notification>", "user", "assistant"].some((prefix) => prefix.startsWith(tail))
    || afterRole !== tail && ["<system-reminder>", "<task-notification>"].some((prefix) => prefix.startsWith(afterRole))) return cleaned.slice(0, lastLine);
  return cleaned;
}

/**
 * Claude task-review turns can occasionally echo their synthetic user frame
 * into assistant text. Strip only complete control frames outside Markdown
 * fences; ordinary whitespace and literal examples must remain byte-for-byte.
 */
function sanitizeClaudeUserVisibleText(text: string, partial = false): string {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  if (lines.at(-1) === "") lines.pop();
  let output = "";
  let prose = "";
  let fenced = "";
  let fence: ClaudeMarkdownFence | undefined;

  const flushProse = () => {
    output += stripClaudeControlFrames(prose, partial);
    prose = "";
  };

  for (const line of lines) {
    const parsedFence = claudeFenceLine(line);
    if (fence) {
      fenced += line;
      if (
        parsedFence
        && parsedFence.marker === fence.marker
        && parsedFence.length >= fence.length
        && !parsedFence.trailing.trim()
      ) {
        output += fenced;
        fenced = "";
        fence = undefined;
      }
      continue;
    }
    if (parsedFence) {
      flushProse();
      fence = { marker: parsedFence.marker, length: parsedFence.length };
      fenced = line;
      continue;
    }
    prose += line;
  }

  flushProse();
  // An unclosed code fence is still literal user-visible content. Never run the
  // control-frame scrubber through it just because the Markdown is incomplete.
  output += fenced;
  return output.trim();
}

function readClaudeMcpServerWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const warnings: string[] = [];
  for (const item of value.slice(0, MAX_MCP_SERVER_WARNINGS)) {
    let warning = "";
    if (typeof item === "string") {
      warning = item;
    } else if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const message = typeof record.message === "string" ? record.message.trim() : "";
      const type = typeof record.type === "string" ? record.type.trim() : "";
      const detail = message || type;
      warning = name && detail ? `${name}: ${detail}` : detail || name;
    }
    warning = redactSecrets(warning.replace(/\s+/g, " ").trim())
      // Diagnostics are protocol data, not model instructions. Neutralize every
      // bracket so a malformed MCP error cannot smuggle [tool:...] or legacy
      // [send-file:...] directives into either channel's delivery parser.
      .replace(/\[/g, "&#91;")
      .replace(/\]/g, "&#93;");
    if (!warning) {
      continue;
    }
    if (warning.length > MAX_MCP_SERVER_WARNING_CHARS) {
      warning = `${warning.slice(0, MAX_MCP_SERVER_WARNING_CHARS - 1)}…`;
    }
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  return warnings;
}

function renderClaudeMcpWarnings(warnings: string[]): string {
  const label = warnings.length === 1 ? "MCP startup warning" : "MCP startup warnings";
  return `⚠️ ${label}:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function appendClaudeMcpWarnings(text: string, warnings: string[]): string {
  if (warnings.length === 0) {
    return text;
  }
  return [text.trim(), renderClaudeMcpWarnings(warnings)].filter(Boolean).join("\n\n");
}

function renderBackgroundTaskTurnResult(metadata: ClaudeTaskNotificationMetadata, text?: string): string {
  const notificationText = text?.trim();
  // A routine Monitor expiry often has no answer, or only Claude's no-response
  // marker. Neither the monitor label nor an invented completion is a reply.
  // Keep this check scoped to Monitor reviews: ordinary quoted text is valid.
  if (metadata.isMonitorEvent && (!notificationText || /^No response requested\.?$/iu.test(notificationText))) return "";
  if (notificationText) {
    return notificationText;
  }
  const summary = metadata.summary?.trim();
  if (summary) {
    return summary;
  }
  // A resumed CLI may emit an empty task-origin result with no terminal
  // envelope. Absence of evidence must not turn into a fabricated completion.
  if (!metadata.taskId && !metadata.status) return "";
  return `${renderBackgroundTaskHeader("en", metadata.status)}.`;
}

/**
 * Claude stream-json tool_result `content` is either a plain string or an array
 * of `{ type: "text", text }` (and occasionally other typed) blocks. Flatten it
 * into a single string so the Lark card can render the tool output.
 */
function flattenClaudeToolResultContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

/** SDK tool_use_result is separate from the model-facing text. Never parse
 * stdout as metadata, and only associate this envelope with a single result. */
function claudeToolEvidence(value: unknown): Pick<Extract<EngineStreamEvent, { type: "tool_result" }>, "changes" | "sources" | "durationMs"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const positioned = Array.isArray(record.structuredPatch) && record.structuredPatch.every(hunk => hunk && Array.isArray(hunk.lines) && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => Number.isSafeInteger(value) && value >= 0));
  const patch = Array.isArray(record.structuredPatch) ? record.structuredPatch.flatMap(hunk => {
    if (!hunk || !Array.isArray(hunk.lines)) return [];
    return [...(positioned ? [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`] : []), ...hunk.lines.filter((line: unknown) => typeof line === "string")];
  }).join("\n") : "";
  const diff = patch || (record.type === "create" && typeof record.content === "string" ? wholeFilePatch(record.content, "add") : "");
  const changes = typeof record.filePath === "string" && record.staged !== true && diff ? [{ path: record.filePath, diff }] : undefined;
  const sources = Array.isArray(record.results) ? record.results.flatMap(result => result && typeof result === "object" && Array.isArray(result.content) ? result.content.flatMap((hit: { url?: unknown; title?: unknown }) => hit && typeof hit.url === "string" ? [{ url: hit.url, ...(typeof hit.title === "string" ? { title: hit.title } : {}) }] : []) : []) : undefined;
  const durationMs = typeof record.durationMs === "number" ? record.durationMs : typeof record.durationSeconds === "number" ? record.durationSeconds * 1000 : undefined;
  return { ...(changes?.[0]?.diff ? { changes } : {}), ...(sources?.length ? { sources } : {}), ...(durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}) };
}

const CLAUDE_TERMINAL_TASK_OUTPUT_STATUSES = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "canceled",
]);

function parseClaudeTaskOutputTerminal(content: unknown): { taskId: string; status: string } | null {
  const text = flattenClaudeToolResultContent(content);
  if (!text) {
    return null;
  }
  const taskId = /<task_id>\s*([^<]+?)\s*<\/task_id>/i.exec(text)?.[1]?.trim();
  const status = /<status>\s*([^<]+?)\s*<\/status>/i.exec(text)?.[1]?.trim().toLowerCase();
  if (!taskId || !status || !CLAUDE_TERMINAL_TASK_OUTPUT_STATUSES.has(status)) {
    return null;
  }
  return { taskId, status };
}

function isExplicitBackgroundToolInput(input: unknown): boolean {
  return input !== null
    && typeof input === "object"
    && !Array.isArray(input)
    && (input as { run_in_background?: unknown }).run_in_background === true;
}

function taskOutputTaskId(name: unknown, input: unknown): string | null {
  if (name !== "TaskOutput" || input === null || typeof input !== "object") {
    return null;
  }
  const taskId = (input as Record<string, unknown>).task_id;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : null;
}

function extractDeliveryTags(text: string): string[] {
  return Array.from(text.matchAll(/\[send-(?:file|image):[^\]]+\]/g), (match) => match[0]);
}

function hasDeliveryTag(text: string): boolean {
  return /\[send-(?:file|image):[^\]]+\]/.test(text);
}

function isTaskNotificationResult(event: ClaudeStreamEvent): boolean {
  return event.type === "result" && event.origin?.kind === "task-notification";
}

function toTaskNotificationMetadata(event: ClaudeStreamEvent): ClaudeTaskNotificationMetadata {
  return {
    ...(typeof event.task_id === "string" ? { taskId: event.task_id } : {}),
    ...(typeof event.tool_use_id === "string" ? { toolUseId: event.tool_use_id } : {}),
    ...(typeof event.status === "string" ? { status: event.status, isMonitorEvent: false } : {}),
    ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
    ...(typeof event.output_file === "string" ? { outputFile: event.output_file } : {}),
  };
}

function decodeClaudeTaskNotificationXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readClaudeTaskNotificationTag(text: string, tag: string): string | undefined {
  const value = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i").exec(text)?.[1]?.trim();
  return value ? decodeClaudeTaskNotificationXml(value) : undefined;
}

/** Claude 2.1.228 emits the terminal envelope as a user-origin stream frame
 * before running its task-review turn, instead of the older system event. */
function toUserTaskNotificationMetadata(event: ClaudeStreamEvent): ClaudeTaskNotificationMetadata | null {
  if (event.type !== "user" || event.origin?.kind !== "task-notification") {
    return null;
  }
  const content = (event.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const record = item as { text?: unknown; content?: unknown };
          if (typeof record.text === "string") {
            return record.text;
          }
          return typeof record.content === "string" ? record.content : "";
        })
        .join("\n")
      : "";
  if (!/<task-notification>/i.test(text)) {
    return null;
  }
  const direct = toTaskNotificationMetadata(event);
  const metadata = {
    taskId: direct.taskId ?? readClaudeTaskNotificationTag(text, "task-id"),
    toolUseId: direct.toolUseId ?? readClaudeTaskNotificationTag(text, "tool-use-id"),
    status: direct.status ?? readClaudeTaskNotificationTag(text, "status"),
    summary: direct.summary ?? readClaudeTaskNotificationTag(text, "summary"),
    outputFile: direct.outputFile ?? readClaudeTaskNotificationTag(text, "output-file"),
  };
  return metadata.taskId ? {
    // Missing fields must not erase the tool/owner identity captured earlier.
    ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)),
    taskId: metadata.taskId,
    isMonitorEvent: !metadata.status && /<event>/i.test(text),
  } : null;
}

function mergeIntermediateDeliveryText(finalResult: string, intermediateDeliveryText: string): string {
  if (!intermediateDeliveryText) {
    return finalResult;
  }

  if (!finalResult) {
    return intermediateDeliveryText;
  }

  if (finalResult.includes(intermediateDeliveryText)) {
    return finalResult;
  }

  if (intermediateDeliveryText.includes(finalResult)) {
    return intermediateDeliveryText;
  }

  const finalDeliveryTags = new Set(extractDeliveryTags(finalResult));
  const intermediateDeliveryTags = extractDeliveryTags(intermediateDeliveryText);
  if (
    intermediateDeliveryTags.length > 0 &&
    intermediateDeliveryTags.every((tag) => finalDeliveryTags.has(tag))
  ) {
    return finalResult;
  }

  return appendAssistantText(intermediateDeliveryText, finalResult);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function toApprovalInput(parsed: ClaudeStreamEvent, sessionId: string | null): EngineApprovalRequest {
  const request = parsed.request ?? {};
  const toolName = request.tool_name ?? request.toolName;
  const toolInput = request.input ?? request.tool_input ?? request.toolInput ?? {};
  return {
    engine: "claude",
    toolName: typeof toolName === "string" && toolName.trim() ? toolName : "Unknown tool",
    toolInput,
    cwd: typeof request.cwd === "string" ? request.cwd : undefined,
    sessionId: sessionId ?? undefined,
    permissionSuggestions: request.permission_suggestions ?? request.permissionSuggestions,
    approvalScopes: { once: "once", session: "session" },
  };
}

function sessionApprovalKey(request: EngineApprovalRequest): string {
  return `${request.toolName}:${canonicalJson(request.toolInput)}`;
}

function renderPermissionResponse(decision: EngineApprovalDecision, originalInput: unknown): Record<string, unknown> {
  if (decision.behavior === "deny") {
    return {
      behavior: "deny",
      message: "Denied by the user.",
    };
  }

  return {
    behavior: "allow",
    updatedInput: decision.updatedInput ?? originalInput ?? {},
  };
}

function isAskUserQuestionRequest(request: EngineApprovalRequest): boolean {
  return request.toolName === "AskUserQuestion";
}

function renderClaudeStreamError(parsed: ClaudeStreamEvent, stderrTail: string): string {
  const result = parsed.result?.trim();
  if (result) {
    return result;
  }

  const stderr = stderrTail.trim();
  if (stderr) {
    return stderr;
  }

  const details = [
    parsed.api_error_status ? `api_error_status=${parsed.api_error_status}` : undefined,
    parsed.subtype ? `subtype=${parsed.subtype}` : undefined,
    parsed.terminal_reason ? `terminal_reason=${parsed.terminal_reason}` : undefined,
  ].filter(Boolean);

  return details.length > 0
    ? `Claude reported an error (${details.join(", ")})`
    : "Claude reported an error";
}

/**
 * Transient API failure of a Claude `result` frame, judged from the CLI's own
 * `api_error_status` (or its leading `API Error: NNN` line), never from streamed
 * prose or stderr. Claude reports subscription and session limits as HTTP 429
 * too, so 429 counts only as an explicit `rate_limit_error` without limit text.
 */
export function claudeTransientRetryReason(frame: Pick<ClaudeStreamEvent, "result" | "api_error_status">): EngineRetryReason | undefined {
  const text = (frame.result ?? "").trim();
  const status = typeof frame.api_error_status === "number" || typeof frame.api_error_status === "string"
    ? Number(frame.api_error_status)
    : Number(/^API Error:\s*(\d{3})\b/i.exec(text)?.[1]);
  if (!Number.isInteger(status)) return undefined;
  if (/\b(?:hit|reached) your\b[^\n]{0,48}\blimit\b|\b(?:usage|session|weekly|monthly|spend|5-hour)[\s_-]+limit\b/i.test(text)) return undefined;
  if (["engine-quota", "auth", "engine-content-policy", "engine-settings"].includes(classifyFailure(text))) return undefined;
  if (status === 529) return "capacity";
  if (status === 429) return /\brate_limit_error\b/.test(text) ? "rate-limit" : undefined;
  return [500, 502, 503, 504].includes(status) ? "connection" : undefined;
}

function renderClaudeStreamExitError(code: number | null, stderrTail: string): string {
  const stderr = stderrTail.trim();
  if (stderr) {
    return stderr;
  }

  return `claude stream session exited with code ${code}`;
}

export class ClaudeStreamAdapter implements CodexAdapter {
  /** Observer work may still be persisting a public result after its native
   * task closes (or its worker exits). Drain must include that delivery. */
  private pendingEventDeliveries = 0;
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = false;
  /** Ordinary sends may be taken in by the running turn (see steerActiveTurn);
   * per worker readiness is supportsSessionSteering. */
  readonly inFlightSendBehavior = "steer" as const;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnClaude: SpawnClaude;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly workspacePath: string | undefined;
  private readonly idleWorkerTtlMs: number;
  private readonly turnInactivityTimeoutMs: number | null;
  private readonly backgroundTaskMaxAgeMs: number;
  private readonly backgroundTaskSilentSuppressMs: number;
  private readonly taskNotificationStartGraceMs: number;
  private readonly disallowedTools: string[];
  private readonly enableChromeIntegration: boolean;
  private readonly nativeSearchMcp?: NativeSearchMcpPlanner;
  private readonly idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly workers = new Map<string, ClaudeWorker>();
  private readonly sessionUsage: ClaudeSessionUsage;
  private destroyPromise: Promise<void> | undefined;
  private readonly appMcpUnavailable = new WeakSet<ClaudeWorker>();
  private readonly turnRecovery: ClaudeTurnRecovery;
  // Dedicated unpersisted forks for side questions when no parent worker is
  // live. Never in `workers`: no turn, binding or reaping path can adopt them.
  private readonly sideProcesses = new Set<ClaudeSideProcess>();

  constructor(
    private readonly claudeExecutable: string,
    options?: {
      childEnv?: NodeJS.ProcessEnv;
      spawnFn?: SpawnClaude;
      instructionsPath?: string;
      configPath?: string;
      recoveryStatePath?: string;
      /** Per-session cost baselines (see ClaudeSessionUsage); in memory when absent. */
      usageStatePath?: string;
      workspacePath?: string;
      engineHomePath?: string;
      idleWorkerTtlMs?: number;
      idleSweepIntervalMs?: number;
      turnInactivityTimeoutMs?: number | null;
      backgroundTaskMaxAgeMs?: number;
      backgroundTaskSilentSuppressMs?: number;
      taskNotificationStartGraceMs?: number;
      disallowedTools?: string[];
      enableChromeIntegration?: boolean;
      /** Adds the host-managed Brave/Tavily MCP when credentials are effective. */
      nativeSearchMcp?: NativeSearchMcpPlanner;
    },
  ) {
    this.childEnv = options?.childEnv ?? (() => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (options?.engineHomePath) {
        env.CLAUDE_CONFIG_DIR = options.engineHomePath;
      }
      return env;
    })();

    this.spawnClaude = options?.spawnFn ?? (spawnEngine as unknown as SpawnClaude);
    this.instructionsPath = options?.instructionsPath;
    this.configPath = options?.configPath;
    this.turnRecovery = new ClaudeTurnRecovery(options?.recoveryStatePath);
    this.sessionUsage = new ClaudeSessionUsage(options?.usageStatePath);
    this.workspacePath = options?.workspacePath;
    this.idleWorkerTtlMs = options?.idleWorkerTtlMs ?? DEFAULT_IDLE_WORKER_TTL_MS;
    this.turnInactivityTimeoutMs = options?.turnInactivityTimeoutMs === undefined
      ? CLAUDE_STREAM_INACTIVITY_TIMEOUT_MS
      : options.turnInactivityTimeoutMs;
    this.backgroundTaskMaxAgeMs = options?.backgroundTaskMaxAgeMs ?? DEFAULT_BACKGROUND_TASK_MAX_AGE_MS;
    this.backgroundTaskSilentSuppressMs = options?.backgroundTaskSilentSuppressMs ?? BACKGROUND_TASK_SILENT_SUPPRESS_MS;
    this.taskNotificationStartGraceMs = Math.max(
      0,
      options?.taskNotificationStartGraceMs ?? DEFAULT_TASK_NOTIFICATION_START_GRACE_MS,
    );
    this.disallowedTools = options?.disallowedTools ?? [];
    this.enableChromeIntegration = options?.enableChromeIntegration === true;
    this.nativeSearchMcp = options?.nativeSearchMcp;

    const sweepIntervalMs = options?.idleSweepIntervalMs ?? DEFAULT_IDLE_SWEEP_INTERVAL_MS;
    if (this.idleWorkerTtlMs > 0 && sweepIntervalMs > 0) {
      this.idleSweepTimer = setInterval(() => {
        this.reapIdleWorkers();
      }, sweepIntervalMs);
      this.idleSweepTimer.unref?.();
    }
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `tarobot-${chatId}` };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.length <= MAX_INSTRUCTIONS_CHARS) {
        return trimmed;
      }

      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch {
      return null;
    }
  }

  private async loadEngineOptions(): Promise<{ effort?: string; model?: string; permissionMode?: string; approvalMode: ApprovalMode; chrome: boolean }> {
    if (!this.configPath) {
      return { approvalMode: "normal", chrome: this.enableChromeIntegration };
    }

    // Go through the shared validated reader (readValidatedConfigFile →
    // sanitizeConfigCompatibility) like the other adapters, so a stale
    // incompatible effort (e.g. `effort:"ultra"` beside `engine:"claude"`)
    // never reaches the CLI as a raw --effort flag.
    const parsed = await readValidatedConfigFile(this.configPath, { forExecution: true });
    return {
      approvalMode: normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE,
      permissionMode: parsed.claudePermissionMode ?? "manual",
      chrome: parsed.claudeChrome ?? this.enableChromeIntegration,
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const agentInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const existingWorker = this.workers.get(sessionId);
    if (input.reviewAdmission === "native" && (!input.nativeInput?.id || !existingWorker || !this.canAdmitReviewInput(existingWorker, input))) this.rejectReviewInput(input);
    const requestedTools = existingWorker && this.appMcpUnavailable.has(existingWorker) ? undefined : input.appPlatformTools;
    const bridgeInstructions = requestedTools ? claudeAppInstructions(requestedTools.instructions) : input.instructions ?? null;
    // An override changes the worker's options key, so that session gets its own --model/--effort.
    const engineOptions = resolveEngineOverride("claude", await this.loadEngineOptions(), input.engineOverride);
    const approvalMode = engineOptions.approvalMode;
    const effectiveWorkspace = input.workspaceOverride ?? this.workspacePath;
    // The interrupted-turn note tells the model not to resume on its own. The
    // host's automatic continuation is that explicit request, so it omits the
    // note; the receipt is kept for the user's next message until a success clears it.
    const recoveryInstructions = input.engineRecoveryContinuation ? undefined : await this.turnRecovery.instructions(sessionId, effectiveWorkspace);
    if (existingWorker) {
      // A soft stop leaves the interrupted native turn settling; this prompt
      // must not be written (or attributed) before that turn's terminal frames.
      await this.waitForStopFence(existingWorker, input.abortSignal);
      // A recovery may have replaced the worker meanwhile; the new one is
      // acquired below and nothing was written to the old one.
      if (!existingWorker.retired) {
        this.advanceTaskNotificationQueue(existingWorker);
        await this.waitForReviewAdmission(existingWorker, input);
        this.advanceTaskNotificationQueue(existingWorker);
      }
    }
    let worker = await this.getOrCreateWorker(sessionId, agentInstructions, bridgeInstructions, approvalMode, effectiveWorkspace, engineOptions, requestedTools);
    // Tool configuration can be deferred while background work owns a worker.
    // Use only the contract actually installed on this worker. Claude may keep
    // a system-prompt snapshot on resume, so refresh the short App contract in
    // private turn guidance without resetting native history.
    const nativeTools = requestedTools && worker.appMcp?.matches(requestedTools) ? requestedTools : undefined;
    const turnInput = { ...input, appPlatformTools: nativeTools, turnInstructions: nativeTools
      ? claudeAppInstructions([nativeTools.instructions, nativeTools.turnInstructions].filter(Boolean).join("\n\n"))
      : worker.appMcp || input.appPlatformTools ? [input.instructions, "Native App tools are unavailable for this turn. Use this turn's channel delivery procedures instead.", input.turnInstructions].filter(Boolean).join("\n\n") : input.turnInstructions };
    turnInput.turnInstructions = [turnInput.turnInstructions, recoveryInstructions].filter(Boolean).join("\n\n") || undefined;
    const prompt = this.buildPrompt(turnInput);

    let response: CodexAdapterResponse;
    try {
      // A fence that opened after acquisition can end with the worker replaced
      // (explicit recovery) before this prompt was written: use the new one.
      for (let replaced = 0; ; replaced += 1) {
        try { response = await this.sendTurn(worker, prompt, turnInput); break; }
        catch (error) {
          if (!(error instanceof ClaudeWorkerReplacedBeforeWriteError) || replaced >= 2 || input.abortSignal?.aborted || this.destroyPromise) throw error;
          worker = await this.getOrCreateWorker(sessionId, agentInstructions, bridgeInstructions, approvalMode, effectiveWorkspace, engineOptions, requestedTools);
        }
      }
    } catch (error) {
      // Only this typed pre-prompt handshake failure is safe to retry. Never
      // replay a model turn after an engine/tool/publish failure or user stop.
      if (!(error instanceof ClaudeAppMcpInitializationError) || input.abortSignal?.aborted || this.destroyPromise) throw error;
      const notice = input.locale === "en"
        ? "Claude native App tools could not initialize. This turn uses compatible file delivery; other conversations are unaffected."
        : "Claude 原生 App 工具初始化失败，本轮已改用兼容文件交付；其他会话不受影响。";
      await this.emitEngineEvent(worker, { type: "assistant_text", text: notice, sessionId: worker.currentSessionId ?? undefined }, input.onEngineEvent);
      worker = await this.getOrCreateWorker(sessionId, agentInstructions, input.instructions ?? null, approvalMode, effectiveWorkspace, engineOptions);
      // A deterministic rejection disables only this fallback worker. A slow
      // initialization can retry next turn, and healthy sessions stay native.
      if (error.reason === "rejected") this.appMcpUnavailable.add(worker);
      const fallback = { ...input, appPlatformTools: undefined, turnInstructions: [input.instructions, input.turnInstructions, recoveryInstructions].filter(Boolean).join("\n\n") };
      response = await this.sendTurn(worker, this.buildPrompt(fallback), fallback);
    }
    const nextSessionId = response.sessionId;
    if (nextSessionId && nextSessionId !== sessionId) {
      this.workers.delete(sessionId);
      this.workers.set(nextSessionId, worker);
      // Drop any other alias keys still pointing at this worker (earlier
      // re-keys of the same process), so the map stays bounded to one live key
      // per worker. removeWorker/reapIdleWorkers tolerate aliases either way.
      for (const [key, candidate] of this.workers.entries()) {
        if (candidate === worker && key !== nextSessionId) {
          this.workers.delete(key);
        }
      }
    }

    return {
      text: response.text,
      sessionId: nextSessionId && nextSessionId !== sessionId ? nextSessionId : undefined,
      // Usage must ride the return: dropping it made every Claude turn invisible
      // to /usage, budget enforcement, and telemetry (they all read result.usage).
      usage: response.usage,
    };
  }

  sideCapability(): SideCapability {
    // A parent turn always has a live worker, and the native side question
    // reads that worker's live messages; without one there is no live turn.
    // side_question takes one string and has no tools: UTF-8 text can be
    // inlined, images and binary documents cannot reach the model.
    return { context: "native", concurrent: true, readOnly: "no-tools", residue: "none", seesInProgressTurn: true, attachments: { images: false, files: "text", paths: false } };
  }

  /**
   * Native Claude Code side questions. They are answered from the parent
   * session's context with no tools and are never written to its transcript.
   * A live parent worker answers them alongside its turn; otherwise an isolated
   * `--fork-session --no-session-persistence` process does. Side cancellation
   * sends `control_cancel_request` and never stops or restarts a parent worker.
   */
  async openSideSession(input: { sourceSessionId: string; workspaceOverride?: string; abortSignal?: AbortSignal }): Promise<EngineSideSession> {
    const sourceSessionId = input.sourceSessionId;
    if (!sourceSessionId || isLogicalTelegramSessionId(sourceSessionId)) throw new Error("no_main_session");
    if (this.destroyPromise) throw new Error("expired");
    input.abortSignal?.throwIfAborted();
    const workspacePath = input.workspaceOverride ?? this.workspacePath;
    const forkSessionId = randomUUID();
    const life = new AbortController();
    let history: ClaudeSideExchange[] = [];
    let own: ClaudeSideProcess | undefined;
    const liveParent = (): ClaudeWorker | undefined => {
      const worker = this.workers.get(sourceSessionId);
      return worker && !worker.retired && worker.currentSessionId === sourceSessionId ? worker : undefined;
    };
    const isolated = async (): Promise<ClaudeSideProcess> => {
      if (own && !own.exited) return own;
      // Clean the exited fork before its generated session ID is reused.
      await own?.dispose();
      own = await this.startSideProcess(sourceSessionId, forkSessionId, workspacePath);
      if (life.signal.aborted) { await own.dispose(); throw new Error("expired"); }
      return own;
    };
    return {
      nativeId: forkSessionId,
      send: async (turn) => {
        if (life.signal.aborted || this.destroyPromise) throw new Error("expired");
        const signal = AbortSignal.any([turn.abortSignal, life.signal]);
        if (turn.attachments?.some((file) => file.kind !== "text")) throw new Error("attachment_unsupported");
        // History keeps the inlined text so follow-ups can still refer to it.
        const question = sideAttachmentPrompt(turn.text, turn.attachments, { paths: false, native: [] });
        const ask = (channel: ClaudeSideQuestionChannel) => channel.ask({ question, history, signal });
        const parent = liveParent();
        let text: string;
        if (parent) {
          parent.side ??= new ClaudeSideQuestionChannel((payload) => this.writeJson(parent, payload));
          try {
            text = await ask(parent.side);
          } catch (error) {
            // The parent worker stopped or restarted underneath a tool-less
            // question; ask it again in an isolated fork instead of failing.
            if (!(error instanceof ClaudeSideChannelClosedError) || signal.aborted) throw error;
            text = await ask((await isolated()).channel);
          }
        } else {
          text = await ask((await isolated()).channel);
        }
        if (life.signal.aborted) throw new Error("expired");
        history = boundedSideHistory([...history, { question, response: text }]);
        return { text };
      },
      dispose: async () => {
        if (life.signal.aborted) return;
        life.abort();
        history = [];
        await own?.dispose();
      },
    };
  }

  private async startSideProcess(sourceSessionId: string, forkSessionId: string, workspacePath: string | undefined): Promise<ClaudeSideProcess> {
    const engineOptions = await this.loadEngineOptions();
    const agentInstructions = this.instructionsPath ? await this.loadInstructions() : null;
    const instructionsFile = agentInstructions ? await createClaudeInstructionsFile(agentInstructions) : null;
    const args = claudeSideProcessArgs({ sourceSessionId, forkSessionId, effort: engineOptions.effort, model: engineOptions.model, workspacePath, appendSystemPromptFile: instructionsFile?.path });
    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    let child: ClaudeChildProcess;
    try {
      child = this.spawnClaude(invocation.command, invocation.args, { stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env: this.childEnv, cwd: workspacePath, windowsHide: true });
    } catch (error) {
      await instructionsFile?.cleanup().catch(() => {});
      throw error;
    }
    const side: ClaudeSideProcess = new ClaudeSideProcess(child, { configDir: resolveClaudeConfigDir(this.childEnv), sessionId: forkSessionId }, () => {
      this.sideProcesses.delete(side);
      void instructionsFile?.cleanup().catch(() => {});
    });
    this.sideProcesses.add(side);
    return side;
  }

  private buildPrompt(input: CodexUserMessageInput): string {
    const parts: string[] = [];
    parts.push(prependPrivateTurnInstructions(input.text, input.turnInstructions));
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    return parts.join("\n");
  }

  private async getOrCreateWorker(sessionId: string, agentInstructions: string | null, bridgeInstructions: string | null, approvalMode: ApprovalMode, workspacePath: string | undefined, engineOptions?: { effort?: string; model?: string; permissionMode?: string; chrome?: boolean }, appTools?: AppPlatformTools): Promise<ClaudeWorker> {
    if (this.destroyPromise) {
      throw new Error("Adapter destroyed");
    }
    const combinedKey = combineInstructions(agentInstructions, bridgeInstructions);
    const permissionMode = approvalMode === "normal" ? engineOptions?.permissionMode ?? "manual" : "bypassPermissions";
    const chromeIntegration = engineOptions?.chrome ?? this.enableChromeIntegration;
    const optionsKey = `${engineOptions?.effort ?? ""}:${engineOptions?.model ?? ""}:${permissionMode}:${chromeIntegration}`;
    const existing = this.workers.get(sessionId);
    if (existing) {
      if (
        existing.instructions === combinedKey &&
        existing.approvalMode === approvalMode &&
        existing.engineOptionsKey === optionsKey &&
        (appTools ? existing.appMcp?.matches(appTools) : !existing.appMcp) &&
        existing.workspacePath === workspacePath
      ) {
        existing.deferredSettingsKey = undefined;
        return existing;
      }

      if (existing.pendingTurn || existing.continuationTurn || existing.stopFence) {
        throw new Error("Cannot reconfigure Claude session while a turn is in flight");
      }
      // Sweep first: a background task whose completion notification never arrived
      // lingers for backgroundTaskMaxAgeMs (6h by default) and would otherwise
      // hard-block every /model, /effort, /approval or workspace change for that
      // whole window — the idle sweeper only prunes workers it visits.
      const now = Date.now();
      this.pruneExpiredBackgroundTasks(existing, now);
      // A finished task can still own a live native review. Reconfiguration
      // must not replace that process while a human input is joining it.
      const hasTaskReview = this.taskNotificationTurnBusy(existing);
      const runningTaskCount = [...existing.backgroundTasks.keys()]
        .filter((taskId) => !existing.finishedBackgroundTaskIds.has(taskId))
        .length;
      const count = runningTaskCount + (hasTaskReview ? 1 : 0);
      if (count > 0) {
        if (existing.chromeIntegration !== chromeIntegration) {
          throw new Error("Claude browser integration changed while background tasks are still running. Wait for them to finish before sending the next task; the current work was not interrupted.");
        }
        if (existing.workspacePath !== workspacePath) {
          throw new Error(
            `Claude session has ${count} background task${count === 1 ? "" : "s"} still running, so its workspace cannot be changed yet. ` +
            `Retry once ${count === 1 ? "it finishes" : "they finish"}, or send /reset to start a fresh session.`,
          );
        }
        if (existing.approvalMode !== approvalMode || existing.permissionMode !== permissionMode) {
          throw new Error(
            `Claude session has ${count} background task${count === 1 ? "" : "s"} still running, so its approval mode cannot be changed yet. ` +
            `Retry once ${count === 1 ? "it finishes" : "they finish"}, or send /reset to start a fresh session.`,
          );
        }
        const deferredSettingsKey = `${combinedKey ?? ""}:${optionsKey}`;
        if (existing.deferredSettingsKey !== deferredSettingsKey) {
          existing.deferredSettingsKey = deferredSettingsKey;
          console.warn(
            `Deferring Claude engine settings for session ${existing.currentSessionId ?? sessionId} until ${count} background task${count === 1 ? "" : "s"} finish.`,
          );
        }
        return existing;
      }

      const resumedSessionId = existing.currentSessionId ?? sessionId;
      killProcessTree(existing.child.pid);
      this.removeWorker(existing);
      sessionId = resumedSessionId;
    }

    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--forward-subagent-text",
      "--permission-prompt-tool",
      "stdio",
    ];
    // Explicit off prevents the user's global Claude default from overriding
    // this Bot's browser-access choice. Never modify the shared profile.
    args.push(chromeIntegration ? "--chrome" : "--no-chrome");
    for (const toolName of this.disallowedTools) {
      args.push("--disallowedTools", toolName);
    }
    if (!isLogicalTelegramSessionId(sessionId)) {
      args.push("-r", sessionId);
    }
    if (approvalMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (approvalMode === "full-auto") {
      args.push("--permission-mode", "bypassPermissions");
    } else {
      args.push("--permission-mode", permissionMode);
    }
    if (engineOptions?.effort) {
      args.push("--effort", engineOptions.effort);
    }
    if (engineOptions?.model) {
      args.push("--model", engineOptions.model);
    }
    if (workspacePath) {
      args.push("--add-dir", workspacePath);
    }

    // One additive --mcp-config (no --strict-mcp-config): user, project and
    // plugin servers still load. The search entry carries no credential values.
    const searchPlan = this.nativeSearchMcp?.() ?? null;
    const searchServers = await claudeManagedSearchServers(searchPlan, this.childEnv, workspacePath);
    const instructionsFile = combinedKey ? await createClaudeInstructionsFile(combinedKey) : null;
    let appMcpConfigFile: ClaudeInstructionsFile | null = null;
    try {
      if (appTools || searchServers) {
        appMcpConfigFile = await createClaudeInstructionsFile(JSON.stringify({ mcpServers: {
          ...(appTools ? { [CLAUDE_APP_MCP_SERVER]: { type: "sdk", name: CLAUDE_APP_MCP_SERVER } } : {}),
          ...searchServers,
        } }), "app-mcp.json");
        args.push("--mcp-config", appMcpConfigFile!.path);
      }
    } catch (error) { await instructionsFile?.cleanup().catch(() => {}); throw error; }
    if (instructionsFile) {
      args.push("--append-system-prompt-file", instructionsFile.path);
    }

    const invocation = buildCommandInvocation(this.claudeExecutable, args);
    let child: ClaudeChildProcess;
    try {
      child = this.spawnClaude(invocation.command, invocation.args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: invocation.shell,
        env: searchServers && searchPlan && Object.keys(searchPlan.processEnv).length > 0
          ? { ...this.childEnv, ...searchPlan.processEnv }
          : this.childEnv,
        cwd: workspacePath,
        windowsHide: true,
      });
    } catch (error) {
      await instructionsFile?.cleanup().catch(() => {});
      await appMcpConfigFile?.cleanup().catch(() => {});
      throw error;
    }

    const worker: ClaudeWorker = {
      nativeTurnOpen: false,
      scoped: new ClaudeScopedEvents({ sanitize: sanitizeClaudeUserVisibleText, flatten: flattenClaudeToolResultContent, evidence: claudeToolEvidence }),
      child,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      lineBuffer: "",
      stderrTail: "",
      currentSessionId: isLogicalTelegramSessionId(sessionId) ? null : sessionId,
      freshCostLedger: isLogicalTelegramSessionId(sessionId),
      workspacePath,
      pendingTurn: null,
      onEngineEvent: undefined,
      backgroundTasks: new Map(),
      finishedBackgroundTaskIds: new Set(),
      collectedBackgroundTaskIds: new Set(),
      taskOutputToolUseIds: new Map(),
      explicitBackgroundToolUseIds: new Set(),
      backgroundToolOwners: new Map(),
      ambiguousBackgroundCalls: new Set(),
      pendingTaskNotification: null,
      suppressNextTaskNotificationAssistant: false,
      taskNotificationTurnActive: false,
      taskNotificationWaiters: new Set(),
      queuedTaskNotifications: [],
      taskNotificationAssistantText: "",
      taskNotificationDeliveryText: "",
      lastActivityAt: Date.now(),
      instructions: combinedKey,
      instructionsFile,
      appMcpConfigFile,
      approvalMode,
      engineOptionsKey: optionsKey,
      chromeIntegration,
      permissionMode,
      sessionApprovedKeys: new Set(),
      pendingApprovalByKey: new Map(),
      control: new ClaudeNativeControl((payload) => this.writeJson(worker, payload), (uuid, state) => this.handleCommandLifecycle(worker, uuid, state)),
      steerObservers: new Map(),
      nativeInputs: new Map(),
      nativeInputByUuid: new Map(),
      nativeAwaitingReply: new Set(),
      taskTokens: new Map(),
      tokenByTask: new Map(),
    };

    child.stdout?.on("data", (chunk) => {
      this.markWorkerActivity(worker);
      this.handleStdout(worker, decodeProcessChunk(worker.stdoutDecoder, chunk));
    });

    child.stderr?.on("data", (chunk) => {
      this.markWorkerActivity(worker);
      // Claude stream-json emits structured events on stdout; stderr is only used on hard failure.
      worker.stderrTail = `${worker.stderrTail}${decodeProcessChunk(worker.stderrDecoder, chunk)}`.slice(-MAX_STDERR_TAIL_CHARS);
    });

    child.stdin?.on?.("error", (error) => {
      this.failWorker(worker, error);
      killProcessTree(worker.child.pid);
      this.removeWorker(worker);
    });

    child.once("error", (error) => {
      this.failWorker(worker, error);
    });

    child.once("close", (code) => {
      const trailingStdout = worker.stdoutDecoder.end();
      // Force the residual JSONL record through even when the CLI exits
      // without writing a final newline.
      this.handleStdout(worker, `${trailingStdout}\n`);
      const trailingStderr = worker.stderrDecoder.end();
      if (trailingStderr) {
        worker.stderrTail = `${worker.stderrTail}${trailingStderr}`.slice(-MAX_STDERR_TAIL_CHARS);
      }
      this.failWorker(worker, claudeError(worker.pendingTurn?.assistantError || renderClaudeStreamExitError(code, worker.stderrTail)));
      // A crash notification is best-effort while the service remains alive;
      // destroyInternal() separately awaits the same delivery during shutdown.
      void this.failBackgroundTasks(worker);
      this.removeWorker(worker);
    });

    this.workers.set(sessionId, worker);
    if (appTools) {
      worker.appMcp = new ClaudeAppMcp(appTools.definitions, (value) => this.writeJson(worker, value), () => this.markWorkerActivity(worker));
      worker.appMcp.start();
    }
    return worker;
  }

  private handleStdout(worker: ClaudeWorker, chunk: string): void {
    worker.lineBuffer += chunk;

    const lines = worker.lineBuffer.split(/\r?\n/);
    worker.lineBuffer = lines.pop() ?? "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line.length > MAX_LINE_BUFFER_BYTES && this.abortOnOversizedLine(worker, line)) {
        return;
      }
      this.handleMessage(worker, line);
    }

    // The residual (still-incomplete) line: a large but valid stream-json event
    // may not have its newline yet — let it keep accumulating up to the higher
    // structured cap. Only non-JSON runaway output hard-fails at the 1 MiB cap.
    if (worker.lineBuffer.length > MAX_LINE_BUFFER_BYTES) {
      this.abortOnOversizedLine(worker, worker.lineBuffer);
    }
  }

  /** Returns true (and fails+kills the worker) if `line` is over the hard limit
   * for its kind: non-stream-json over 1 MiB, or stream-json over 64 MiB. */
  private abortOnOversizedLine(worker: ClaudeWorker, line: string): boolean {
    const isStructured = looksLikeClaudeStreamJsonLine(line);
    if (!isStructured || line.length > MAX_STRUCTURED_LINE_BUFFER_BYTES) {
      this.failWorker(worker, new Error(isStructured
        ? "Engine structured output exceeded maximum buffer size"
        : "Engine output exceeded maximum buffer size"));
      killProcessTree(worker.child.pid);
      return true;
    }
    return false;
  }

  private handleMessage(worker: ClaudeWorker, line: string): void {
    // Termination and pipe draining are asynchronous. A removed worker must
    // never re-register its session ID or publish late events into a new turn.
    if (worker.retired) return;
    let parsed: ClaudeStreamEvent;
    try {
      parsed = JSON.parse(line) as ClaudeStreamEvent;
    } catch {
      return;
    }
    // Side-question responses belong to the side channel only; they never
    // reach the foreground turn, task reviews or session bookkeeping.
    if (worker.side?.handle(parsed as Record<string, unknown>)) return;
    // Host-originated control responses and lifecycle frames; task frames are
    // only observed here and keep their existing routing below.
    if (worker.control.handle(parsed as Record<string, unknown>)) return;

    // A launch acknowledgement may precede task_started, or arrive after the
    // foreground result. Refresh only this known call, once; replayed results
    // and unrelated stream activity must not hold a never-started call forever.
    if (parsed.type === "user" && Array.isArray(parsed.message?.content)) {
      for (const item of parsed.message.content) {
        if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string") continue;
        const key = backgroundCallKey(item.tool_use_id, parsed.parent_tool_use_id);
        const owner = worker.backgroundToolOwners.get(key);
        if (owner && worker.explicitBackgroundToolUseIds.has(key) && !owner.launchResultSeen) {
          owner.launchResultSeen = true;
          owner.lastSeenAt = Date.now();
        }
      }
    }

    // --forward-subagent-text marks child events with the parent Agent tool id.
    // Keep those events out of the main transcript and out of the parent's tool
    // completion accounting. Public steps have their own immutable scope;
    // child control traffic cannot acquire the parent host capabilities.
    if (typeof parsed.parent_tool_use_id === "string" && parsed.parent_tool_use_id) {
      if (parsed.type === "control_request" && parsed.request_id) {
        void this.handleControlRequest(worker, parsed);
        return;
      }
      const childScope = worker.scoped.findDelegate(parsed.parent_tool_use_id);
      if (childScope) {
        worker.scoped.accept(childScope, parsed);
        if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
          for (const item of parsed.message.content) if (item?.type === "tool_use" && typeof item.id === "string" && isExplicitBackgroundToolInput(item.input)) {
            this.rememberBackgroundTool(worker, item.id, { inputOwnerKey: childScope.owner.inputOwnerKey, turnId: childScope.owner.turnId, onEngineEvent: childScope.owner.emit, lastSeenAt: Date.now(), parentToolUseId: parsed.parent_tool_use_id });
          }
          for (const item of parsed.message.content) if (item?.type === "tool_use" && typeof item.id === "string") {
            const taskId = taskOutputTaskId(item.name, item.input);
            if (taskId) worker.taskOutputToolUseIds.set(`${childScope.scope.id}\0${item.id}`, taskId);
          }
        }
        if (parsed.type === "user" && Array.isArray(parsed.message?.content)) for (const item of parsed.message.content) {
          if (item?.type !== "tool_result" || typeof item.tool_use_id !== "string") continue;
          const key = `${childScope.scope.id}\0${item.tool_use_id}`, taskId = worker.taskOutputToolUseIds.get(key);
          worker.taskOutputToolUseIds.delete(key);
          if (taskId && worker.backgroundTasks.get(taskId)?.parentToolUseId === parsed.parent_tool_use_id) this.settleCollectedBackgroundTask(worker, taskId, item.content);
        }
        if (parsed.type === "system" && parsed.subtype === "task_started") this.trackBackgroundTask(worker, toTaskNotificationMetadata(parsed), {
          inputOwnerKey: childScope.owner.inputOwnerKey, turnId: childScope.owner.turnId, onEngineEvent: childScope.owner.emit, parentToolUseId: parsed.parent_tool_use_id, lastSeenAt: Date.now(),
        });
      }
      const childNotification = parsed.type === "system" && parsed.subtype === "task_notification" ? toTaskNotificationMetadata(parsed) : toUserTaskNotificationMetadata(parsed);
      if (childNotification?.taskId) {
        const task = worker.backgroundTasks.get(childNotification.taskId);
        if (task?.parentToolUseId === parsed.parent_tool_use_id && !childNotification.isMonitorEvent) {
          this.emitBackgroundTaskFinished(worker, childNotification, task);
          // Child review remains inside its own Agent. Consume the lifecycle,
          // never open the root review slot or borrow root permissions.
          if (childNotification.status && CLAUDE_TERMINAL_TASK_OUTPUT_STATUSES.has(childNotification.status)) this.settleCollectedTask(worker, { taskId: childNotification.taskId, status: childNotification.status });
        }
      }
      if (!childScope && parsed.type === "system" && parsed.subtype === "task_started") {
        const captured = parsed.tool_use_id ? worker.backgroundToolOwners.get(backgroundCallKey(parsed.tool_use_id, parsed.parent_tool_use_id)) : undefined;
        if (captured?.parentToolUseId === parsed.parent_tool_use_id) this.trackBackgroundTask(worker, toTaskNotificationMetadata(parsed), captured);
      }
      if (childScope && worker.pendingTurn && childScope.owner.turnId === worker.pendingTurn?.turnId && childScope.owner.emit === worker.pendingTurn.onEngineEvent && !worker.taskNotificationTurnActive && worker.pendingTurn.outstandingToolUseIds.has(parsed.parent_tool_use_id)) {
        this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
        if (parsed.type === "assistant") {
          const rawText = (Array.isArray(parsed.message?.content) ? parsed.message.content : [])
            .filter((item) => item?.type === "text" && typeof item.text === "string")
            .map((item) => item.text as string)
            .join("");
          const text = sanitizeClaudeUserVisibleText(rawText);
          if (text) {
            this.emitEngineEvent(worker, {
              type: "tool_progress",
              toolUseId: parsed.parent_tool_use_id,
              text,
              delta: false,
              sessionId: worker.currentSessionId ?? undefined,
            });
          }
        }
      }
      return;
    }

    const waitingInput = worker.pendingTurn;
    if (waitingInput?.nativeAdmission && !waitingInput.nativeStarted
      && markerList(parsed.user_message_uuids, parsed.user_message_uuid).includes(waitingInput.nativeCommand)
      && (parsed.type === "assistant" || parsed.type === "result"
        || parsed.type === "system" && parsed.subtype === "status" && parsed.status === "requesting"
        || parsed.type === "stream_event" && (parsed.event as { type?: string } | undefined)?.type === "message_start")) {
      // A stamped model request/reply is stronger evidence than a missing
      // lifecycle notification. Do the ownership handoff before routing it.
      this.startReviewInput(worker, waitingInput);
    }
    if (parsed.type === "result") worker.nativeTurnOpen = false;
    this.observeNativeReceipt(worker, parsed);
    if (parsed.type === "assistant" || parsed.type === "user"
      || parsed.type === "system" && (parsed.subtype === "init" || parsed.subtype === "status" && parsed.status === "requesting")
      || parsed.type === "stream_event" && (parsed.event as { type?: string } | undefined)?.type === "message_start") worker.nativeTurnOpen = true;
    if (worker.appMcp?.handle(parsed as Record<string, unknown>)) return;

    if (parsed.session_id) {
      const owner = this.workers.get(parsed.session_id);
      if (owner && owner !== worker) {
        const error = new Error(`Claude session ${parsed.session_id} is already owned by another live worker`);
        this.failWorker(worker, error);
        killProcessTree(worker.child.pid);
        this.removeWorker(worker);
        return;
      }
      worker.currentSessionId = parsed.session_id;
      // Keep the logical alias until sendUserMessage returns, but publish the
      // real session id immediately. A second surface can now find this worker
      // during the first turn instead of spawning another CLI against the same
      // Claude session file.
      this.workers.set(parsed.session_id, worker);
    }
    const eventSeenAt = Date.now();
    if (worker.taskNotificationTurnActive && worker.pendingTaskNotification) {
      worker.pendingTaskNotification.lastSeenAt = eventSeenAt;
    }

    if (parsed.type === "system" && (parsed.subtype === "status" || parsed.subtype === "compact_boundary")) {
      // Parent-tool events were routed above. Do not borrow the foreground
      // sink while an out-of-band task review owns this stream.
      const pending = worker.taskNotificationTurnActive ? undefined : this.activePendingTurn(worker);
      if (!pending || !pending.promptWritten) return;
      if (parsed.subtype === "status" && parsed.status === "compacting" && !pending.compactionId) {
        pending.compactionId = randomUUID();
        void this.emitEngineEvent(worker, { type: "context_compaction", id: pending.compactionId, status: "started", sessionId: worker.currentSessionId ?? undefined });
      } else if (parsed.subtype === "compact_boundary") {
        if (parsed.uuid) {
          const seen = pending.compactionBoundaries ??= new Set();
          if (seen.has(parsed.uuid)) return;
          seen.add(parsed.uuid);
          if (seen.size > 128) seen.delete(seen.values().next().value!);
        }
        void this.emitEngineEvent(worker, { type: "context_compaction", id: pending.compactionId ?? parsed.uuid ?? randomUUID(), status: "completed", sessionId: worker.currentSessionId ?? undefined });
        pending.compactionId = undefined;
      }
      // status:null/requesting is not evidence that compaction succeeded.
      return;
    }

    if (parsed.type === "system" && parsed.subtype === "task_updated" && parsed.patch?.is_backgrounded === true && typeof parsed.task_id === "string") {
      this.adoptBackgroundedCall(worker, worker.control.task(parsed.task_id)?.toolUseId, parsed.task_id);
    }

    if (parsed.type === "system" && parsed.subtype === "task_started") {
      const metadata = toTaskNotificationMetadata(parsed);
      // Claude 2.1.222 emits task_started/task_notification for foreground
      // local Bash calls once they run for a few seconds. Only a matching tool
      // use with run_in_background=true is detached work; treating the
      // foreground lifecycle as background leaves the restart guard busy after
      // the turn has already completed. Events without tool_use_id are kept for
      // compatibility with older Claude versions and non-tool task sources.
      if (
        metadata.toolUseId
        && !worker.explicitBackgroundToolUseIds.has(metadata.toolUseId)
      ) {
        return;
      }
      this.trackBackgroundTask(worker, metadata);
      return;
    }

    if (parsed.type === "system" && parsed.subtype === "task_notification") {
      const metadata = toTaskNotificationMetadata(parsed);
      if (metadata.taskId && worker.collectedBackgroundTaskIds.has(metadata.taskId)) {
        // Preserve the id until the associated origin=result arrives so that a
        // result without task_id can still be recognized and suppressed.
        const collectedEntry = {
          ...metadata,
          onEngineEvent: worker.onEngineEvent,
          lastSeenAt: eventSeenAt,
        };
        if (this.foreignReviewActive(worker, metadata.taskId)) {
          worker.queuedTaskNotifications.push({ entry: collectedEntry, reviewTurn: false });
        } else {
          worker.pendingTaskNotification = collectedEntry;
        }
        return;
      }
      const task = metadata.taskId ? worker.backgroundTasks.get(metadata.taskId) : undefined;
      if (
        metadata.toolUseId
        && !task
        && !worker.explicitBackgroundToolUseIds.has(metadata.toolUseId)
      ) {
        return;
      }
      this.emitBackgroundTaskFinished(worker, metadata, task);
      const pendingEntry = {
        ...task,
        ...metadata,
        onEngineEvent: task?.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: task?.onApprovalRequest,
        lastSeenAt: eventSeenAt,
      };
      if (this.foreignReviewActive(worker, metadata.taskId)) {
        worker.queuedTaskNotifications.push({ entry: pendingEntry, reviewTurn: false });
        return;
      }
      worker.pendingTaskNotification = pendingEntry;
      return;
    }

    const userTaskNotification = toUserTaskNotificationMetadata(parsed);
    if (userTaskNotification) {
      const task = userTaskNotification.taskId
        ? worker.backgroundTasks.get(userTaskNotification.taskId)
        : undefined;
      this.emitBackgroundTaskFinished(worker, userTaskNotification, task);
      const reviewEntry = {
        ...task,
        ...userTaskNotification,
        onEngineEvent: task?.onEngineEvent ?? worker.onEngineEvent,
        onApprovalRequest: task?.onApprovalRequest,
        lastSeenAt: eventSeenAt,
      };
      if (this.foreignReviewActive(worker, userTaskNotification.taskId)) {
        worker.queuedTaskNotifications.push({ entry: reviewEntry, reviewTurn: true });
        return;
      }
      if (worker.stopFence?.openTurn) {
        // Taken into the fenced turn, not a review of its own: keep only the
        // ownership metadata, exactly as for the system-frame variant.
        worker.pendingTaskNotification = reviewEntry;
        return;
      }
      this.ensureReviewScope(worker, reviewEntry);
      worker.pendingTaskNotification = reviewEntry;
      worker.taskNotificationTurnActive = true;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
      return;
    }

    if (parsed.type === "result" && worker.stopFence?.openTurn
      && (markerList(parsed.user_message_uuids, parsed.user_message_uuid).some(uuid => worker.stopFence!.ownedCommands.has(uuid))
        || !parsed.user_message_uuid && !parsed.user_message_uuids && !isTaskNotificationResult(parsed) && !worker.pendingTurn && !worker.taskNotificationTurnActive)) {
      // The interrupted (or withdrawn-then-started) turn's own terminal frame,
      // named by the command that opened it. Never an answer or a review.
      const fence = worker.stopFence;
      // A clean result for the stopped command without a stop receipt: the
      // turn had already finished when the interrupt arrived.
      if (fence.turn && !fence.receiptStopped && !parsed.is_error && (!parsed.user_message_uuid || parsed.user_message_uuid === fence.command)) fence.tooLate = true;
      fence.openTurn = false;
      worker.nativeTurnOpen = false;
      this.maybeReleaseStopFence(worker);
      return;
    }

    const namedPending = worker.pendingTurn?.nativeStarted && this.resultNamesTurn(parsed, worker.pendingTurn);
    if (!namedPending && (isTaskNotificationResult(parsed) || (parsed.type === "result" && worker.taskNotificationTurnActive))) {
      this.finishReview(worker, parsed);
      return;
    }

    // Only arm task-notification suppression when NO real turn is in flight.
    // Otherwise a mid-turn re-init (e.g. /compact re-initializes the session)
    // would arm the flag and swallow the FIRST assistant chunk of the resumed
    // turn. The pendingTurn init handler below covers the in-turn re-init case.
    if (parsed.type === "system" && parsed.subtype === "init" && worker.pendingTaskNotification && !this.activePendingTurn(worker) && !worker.stopFence?.openTurn) {
      this.ensureReviewScope(worker, worker.pendingTaskNotification);
      worker.suppressNextTaskNotificationAssistant = true;
      worker.taskNotificationTurnActive = true;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
      return;
    }

    if (parsed.type === "system" && parsed.subtype === "init" && worker.pendingTurn && this.activePendingTurn(worker)) {
      const warnings = readClaudeMcpServerWarnings(parsed.mcp_server_errors)
        .filter((warning) => !worker.pendingTurn!.engineWarnings.includes(warning));
      if (warnings.length > 0) {
        worker.pendingTurn.engineWarnings.push(...warnings);
        this.emitEngineEvent(worker, {
          type: "assistant_text",
          text: renderClaudeMcpWarnings(warnings),
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      this.emitEngineEvent(worker, {
        type: "session",
        sessionId: worker.currentSessionId ?? undefined,
      });
      return;
    }

    if (parsed.type === "assistant" && worker.taskNotificationTurnActive) {
      const scope = worker.pendingTaskNotification?.reviewScope;
      if (scope) worker.scoped.accept(scope, parsed);
      for (const item of parsed.message?.content ?? []) {
        if (item.type === "thinking") reportAnswerProgress(worker.pendingTaskNotification, { phase: "thinking" });
        if (item.type === "tool_use" && typeof item.id === "string" && item.id) {
          reportAnswerProgress(worker.pendingTaskNotification, { phase: "working", toolName: item.name });
          if (isExplicitBackgroundToolInput(item.input)) {
            const owner = worker.pendingTaskNotification;
            if (owner) this.rememberBackgroundTool(worker, item.id, { inputOwnerKey: owner.inputOwnerKey, turnId: owner.turnId, onEngineEvent: owner.onEngineEvent, onApprovalRequest: owner.onApprovalRequest, reviewIdentity: owner.reviewIdentity, lastSeenAt: Date.now() });
          }
          const taskId = taskOutputTaskId(item.name, item.input);
          if (taskId) {
            worker.taskOutputToolUseIds.set(item.id, taskId);
          }
          continue;
        }
        if (item.type === "text" && typeof item.text === "string" && item.text) {
          const visibleText = sanitizeClaudeUserVisibleText(item.text);
          if (!visibleText) {
            continue;
          }
          reportAnswerProgress(worker.pendingTaskNotification, { phase: "replying" });
          worker.taskNotificationAssistantText = appendAssistantText(
            worker.taskNotificationAssistantText,
            visibleText,
          );
          if (hasDeliveryTag(visibleText)) {
            worker.taskNotificationDeliveryText = appendAssistantText(
              worker.taskNotificationDeliveryText,
              visibleText,
            );
          }
        }
      }
      return;
    }

    if (parsed.type === "user" && worker.taskNotificationTurnActive) {
      const scope = worker.pendingTaskNotification?.reviewScope;
      if (scope) worker.scoped.accept(scope, parsed);
      for (const item of parsed.message?.content ?? []) {
        if (item.type !== "tool_result" || typeof item.tool_use_id !== "string" || !item.tool_use_id) {
          continue;
        }
        reportAnswerProgress(worker.pendingTaskNotification, { phase: "thinking" });
        const taskId = worker.taskOutputToolUseIds.get(item.tool_use_id);
        worker.taskOutputToolUseIds.delete(item.tool_use_id);
        if (taskId) {
          this.settleCollectedBackgroundTask(worker, taskId, item.content);
        }
      }
      return;
    }

    if (parsed.type === "stream_event") {
      const pending = this.activePendingTurn(worker);
      if (worker.taskNotificationTurnActive) {
        const scope = worker.pendingTaskNotification?.reviewScope;
        if (scope) worker.scoped.accept(scope, parsed);
        const partial = claudePartialEventSchema.safeParse(parsed.event);
        if (partial.success) {
          const item = partial.data;
          const thinking = item.type === "content_block_start" ? item.content_block.type === "thinking" : item.delta.type === "thinking_delta";
          reportAnswerProgress(worker.pendingTaskNotification, { phase: thinking ? "thinking" : "replying" });
        }
        return;
      }
      // Synthetic background reviews and child-agent text keep their existing
      // dedicated delivery path. Never mix them into a foreground transcript.
      if (!pending || worker.taskNotificationTurnActive || worker.suppressNextTaskNotificationAssistant) return;
      const result = claudePartialEventSchema.safeParse(parsed.event);
      if (!result.success) return;
      const event = result.data;
      if (event.type === "content_block_start") {
        const key = event.content_block.type === "text" ? "partialText" : "partialThinking";
        pending[key] = { index: event.index, raw: event.content_block.text ?? event.content_block.thinking ?? "", visible: "" };
      } else {
        const thinking = event.delta.type === "thinking_delta", block = thinking ? pending.partialThinking : pending.partialText;
        if (!block || block.index !== event.index) return;
        block.raw += event.delta.type === "text_delta" ? event.delta.text : event.delta.thinking;
      }
      const thinking = event.type === "content_block_start" ? event.content_block.type === "thinking" : event.delta.type === "thinking_delta";
      const block = thinking ? pending.partialThinking : pending.partialText;
      if (!block) return;
      const visible = sanitizeClaudeUserVisibleText(block.raw, true);
      if (!visible.startsWith(block.visible)) return;
      const text = visible.slice(block.visible.length), continuation = !!block.visible;
      block.visible = visible;
      if (!text) return;
      this.clearBackgroundTaskTurnSettlement(pending);
      if (thinking) this.emitEngineEvent(worker, { type: "thinking", text, delta: continuation, sessionId: worker.currentSessionId ?? undefined });
      else {
        pending.onProgress?.(appendAssistantText(pending.assistantText, visible));
        this.emitEngineEvent(worker, { type: "assistant_text", text, delta: continuation, sessionId: worker.currentSessionId ?? undefined });
      }
      return;
    }

    if (parsed.type === "assistant" && worker.suppressNextTaskNotificationAssistant) {
      worker.suppressNextTaskNotificationAssistant = false;
      return;
    }

    if (parsed.type === "assistant" && worker.pendingTurn && this.activePendingTurn(worker)) {
      const failure = claudeAssistantError(parsed);
      if (failure) {
        this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
        worker.pendingTurn.assistantError = sanitizeClaudeUserVisibleText(failure);
        return;
      }
      worker.pendingTurn.assistantError = undefined;
      // CLI resume placeholders are transcript padding, not model answers.
      // Keep the real foreground slot waiting for its own terminal result.
      if (parsed.message?.model === "<synthetic>" && parsed.message.content?.length === 1
        && isClaudeNoResponsePlaceholder(parsed.message.content[0]?.text)) {
        worker.pendingTurn.lastAssistantWasNoResponsePlaceholder = true;
        return;
      }
      worker.pendingTurn.lastAssistantWasNoResponsePlaceholder = false;
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      const textParts: string[] = [];
      for (const item of parsed.message?.content ?? []) {
        if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking) {
          const partial = worker.pendingTurn.partialThinking?.visible;
          const complete = sanitizeClaudeUserVisibleText(item.thinking);
          const text = partial && complete.startsWith(partial) ? complete.slice(partial.length) : complete;
          worker.pendingTurn.partialThinking = undefined;
          if (text) this.emitEngineEvent(worker, { type: "thinking", text, delta: !!partial && complete.startsWith(partial), sessionId: worker.currentSessionId ?? undefined });
          continue;
        }

        if (item.type === "tool_use") {
          if (typeof item.id === "string" && item.id) {
            if (!parsed.parent_tool_use_id && worker.currentSessionId && worker.pendingTurn.promptWritten && worker.pendingTurn.appPlatformTools && typeof item.name === "string") {
              worker.appMcp?.observe(item.id, item.name, item.input, worker.pendingTurn.appPlatformTools, worker.currentSessionId, worker.pendingTurn.approvalAbortController.signal);
            }
            // Tracked so a long SILENT tool call is not mistaken for a finished
            // turn by the background-task settle timer.
            if (!worker.pendingTurn.outstandingToolUseIds.has(item.id)) worker.pendingTurn.observedToolCalls += 1;
            worker.pendingTurn.outstandingToolUseIds.add(item.id);
            if (worker.pendingTurn.pendingToolNames.size < 8) {
              worker.pendingTurn.pendingToolNames.set(item.id, typeof item.name === "string" ? item.name.slice(0, 80) : "Unknown tool");
            }
            if (worker.pendingTurn.onEngineEvent) worker.scoped.registerDelegate(item.id, item.name, item.input, {
              emit: worker.pendingTurn.onEngineEvent, turnId: worker.pendingTurn.turnId, origin: "bound", inputOwnerKey: worker.pendingTurn.inputOwnerKey,
            });
            if (isExplicitBackgroundToolInput(item.input)) {
              this.rememberBackgroundTool(worker, item.id, { inputOwnerKey: worker.pendingTurn.inputOwnerKey, turnId: worker.pendingTurn.turnId, onEngineEvent: worker.pendingTurn.onEngineEvent, onApprovalRequest: worker.pendingTurn.onApprovalRequest, lastSeenAt: Date.now() });
            }
            const taskId = taskOutputTaskId(item.name, item.input);
            if (taskId) {
              worker.taskOutputToolUseIds.set(item.id, taskId);
            }
          }
          this.emitEngineEvent(worker, {
            type: "tool_use",
            toolName: typeof item.name === "string" && item.name ? item.name : "Unknown tool",
            toolInput: item.input,
            ...(typeof item.id === "string" && item.id ? { toolUseId: item.id } : {}),
            sessionId: worker.currentSessionId ?? undefined,
          });
          continue;
        }

        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        }
      }
      const text = sanitizeClaudeUserVisibleText(textParts.join(""));
      if (text) {
        worker.pendingTurn.assistantText = appendAssistantText(worker.pendingTurn.assistantText, text);
        if (hasDeliveryTag(text)) {
          worker.pendingTurn.intermediateDeliveryText = appendAssistantText(worker.pendingTurn.intermediateDeliveryText, text);
        }
        worker.pendingTurn.onProgress?.(worker.pendingTurn.assistantText);
        const partial = worker.pendingTurn.partialText?.visible;
        worker.pendingTurn.partialText = undefined;
        const remaining = partial && text.startsWith(partial) ? text.slice(partial.length) : text;
        if (remaining) this.emitEngineEvent(worker, {
          type: "assistant_text", text: remaining, ...(partial && text.startsWith(partial) ? { delta: true } : {}),
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      return;
    }

    if (parsed.type === "user" && worker.pendingTurn && this.activePendingTurn(worker)) {
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      const results = parsed.message?.content?.filter(item => item.type === "tool_result") ?? [];
      const moved = results.length === 1 ? backgroundedTaskId(parsed.tool_use_result) : undefined;
      for (const item of parsed.message?.content ?? []) {
        if (item.type !== "tool_result") {
          continue;
        }
        if (typeof item.tool_use_id === "string" && item.tool_use_id) {
          // Claude moved this blocking call aside; its task now reports later.
          if (moved) this.adoptBackgroundedCall(worker, item.tool_use_id, moved);
          if (worker.pendingTurn.outstandingToolUseIds.delete(item.tool_use_id)) worker.pendingTurn.observedToolResults += 1;
          worker.pendingTurn.pendingToolNames.delete(item.tool_use_id);
          worker.scoped.finishDelegate(item.tool_use_id, worker.pendingTurn.turnId, item.is_error ? "error" : "done");
          const taskId = worker.taskOutputToolUseIds.get(item.tool_use_id);
          worker.taskOutputToolUseIds.delete(item.tool_use_id);
          if (taskId) {
            this.settleCollectedBackgroundTask(worker, taskId, item.content);
          }
        }
        this.emitEngineEvent(worker, {
          type: "tool_result",
          ...(typeof item.tool_use_id === "string" && item.tool_use_id ? { toolUseId: item.tool_use_id } : {}),
          output: flattenClaudeToolResultContent(item.content),
          ...(results.length === 1 ? claudeToolEvidence(parsed.tool_use_result) : {}),
          isError: item.is_error === true,
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      return;
    }

    if (parsed.type === "control_request") {
      if (worker.pendingTurn && this.activePendingTurn(worker)) {
        this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      }
      void this.handleControlRequest(worker, parsed);
      return;
    }

    if (parsed.type === "control_cancel_request") {
      return;
    }

    if (parsed.type === "result" && worker.pendingTurn && this.activePendingTurn(worker)) {
      const opener = parsed.user_message_uuid;
      if (worker.pendingTurn.nativeAdmission && !this.resultNamesTurn(parsed, worker.pendingTurn)) return;
      const ownState = worker.control.commandState(worker.pendingTurn.nativeCommand);
      // Messages that ran together as one turn name the last as opener; the
      // marker list (request_marker_lists_v1) still names this turn's command.
      const carriesOwn = opener === worker.pendingTurn.nativeCommand || markerList(parsed.user_message_uuids).includes(worker.pendingTurn.nativeCommand);
      if (opener && !carriesOwn && worker.control.commandState(opener) !== undefined && ownState !== "completed") {
        // Another own command's native turn (this turn's command was not
        // folded into it): never this turn's answer.
        return;
      }
      // Claude can publish task_started only after finishing its main reply.
      // A long summary must not consume this bounded start grace in advance.
      // Anchor only this turn's still-unregistered calls, never older owners.
      for (const owner of this.unstartedBackgroundCalls(worker)) {
        if (!owner.reviewIdentity && owner.turnId === worker.pendingTurn.turnId && owner.onEngineEvent === worker.pendingTurn.onEngineEvent) {
          owner.lastSeenAt = eventSeenAt;
        }
      }
      // An empty/error-echo terminal result cannot turn an unresolved API
      // failure into success. Genuine subsequent assistant output clears it.
      if (claudeResultRepeatsError(worker.pendingTurn.assistantError, sanitizeClaudeUserVisibleText(parsed.result ?? ""))) {
        parsed.is_error = true;
        parsed.result = worker.pendingTurn.assistantError;
      }
      if (!parsed.is_error && worker.pendingTurn.lastAssistantWasNoResponsePlaceholder
        && (!parsed.result?.trim() || isClaudeNoResponsePlaceholder(parsed.result))) {
        // This is a foreground terminal frame, not a process failure. Unrelated
        // background tasks and their waiters still belong to the live worker.
        const pending = worker.pendingTurn;
        this.rememberInterruptedTurn(worker, pending);
        worker.scoped.finishTurn(pending.turnId, "error");
        worker.pendingTurn = null;
        this.clearPendingTurnTimeout(pending);
        this.markWorkerActivity(worker);
        this.abandonUnfoldedSteers(worker, pending);
        pending.reject(claudeNoResponseError(pending.locale));
        return;
      }
      worker.nativeTurnOpen = false;
      this.clearBackgroundTaskTurnSettlement(worker.pendingTurn);
      worker.suppressNextTaskNotificationAssistant = false;
      const pending = worker.pendingTurn;
      // Claude cut this turn for a send-now input that still waits: that input
      // runs next and continues this host turn through the steer continuation.
      const sendNowCut = parsed.is_error === true && this.isSendNowCut(worker, pending, parsed);
      worker.scoped.finishTurn(pending.turnId, sendNowCut ? "stopped" : parsed.is_error ? "error" : "done");
      if (parsed.is_error && !sendNowCut) {
        this.rememberInterruptedTurn(worker, pending);
        worker.pendingTurn = null;
        this.markWorkerActivity(worker);
        this.clearPendingTurnTimeout(pending);
        this.abandonUnfoldedSteers(worker, pending);
        const renderedError = sanitizeClaudeUserVisibleText(
          renderClaudeStreamError(parsed, worker.stderrTail),
        );
        const detail = sanitizeClaudeUserVisibleText(parsed.result ?? "")
          || pending.assistantError
          || pending.assistantText.trim()
          || renderedError
          || "Claude reported an error";
        this.rejectWithRetryReceipt(worker, pending, parsed, claudeError(appendClaudeMcpWarnings(detail, pending.engineWarnings)));
        return;
      }
      const rawResultText = parsed.result && !sendNowCut
        ? mergeIntermediateDeliveryText(parsed.result, pending.intermediateDeliveryText)
        : appendAssistantText(pending.assistantText, sanitizeClaudeUserVisibleText(pending.partialText?.raw ?? ""));
      const resultText = sanitizeClaudeUserVisibleText(rawResultText);
      // A direct-result turn has no streamed answer block. When an init warning
      // created one, seed the actual result explicitly so the run card cannot
      // finish showing only the warning.
      if (pending.engineWarnings.length > 0 && !pending.assistantText.trim() && resultText.trim()) {
        this.emitEngineEvent(worker, {
          type: "assistant_text",
          text: resultText,
          sessionId: worker.currentSessionId ?? undefined,
        });
      }
      const segmentText = appendClaudeMcpWarnings(resultText, pending.engineWarnings);
      const usage = parsed.usage;
      const toUsage = (costUsd?: number): AdapterUsage | undefined => usage
        ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cachedTokens: usage.cache_read_input_tokens,
            costUsd,
          }
        : undefined;
      const missed = this.unfoldedSteers(worker, pending);
      // Publish the cost only after its baseline is durable. Without recorded
      // usage the baseline stays put, so the interval is charged later instead.
      // A held segment is never baselined: Claude's ledger is cumulative, so
      // the segment that settles the turn (or the next turn) charges it once.
      const segmentUsage = usage && missed.length === 0 ? this.turnCostUsd(worker, parsed).then(toUsage, () => toUsage()) : Promise.resolve(toUsage());
      const earlier = pending.continuation;
      // A segment Claude cut for a send-now input that did run says so.
      const text = earlier ? appendAssistantText(earlier.cut ? withSendNowCutNotice(earlier.text, pending.locale) : earlier.text, segmentText) : segmentText;
      const turnUsage = earlier ? Promise.all([earlier.usage, segmentUsage]).then(([a, b]) => sumUsage(a, b)) : segmentUsage;
      worker.pendingTurn = null;
      this.markWorkerActivity(worker);
      if (worker.pendingTaskNotification) {
        // A review cannot start until this foreground turn closes. Measure its
        // bounded start window from here, not from the earlier terminal frame.
        // This also covers an older task that finished during a newer turn.
        worker.pendingTaskNotification.lastSeenAt = eventSeenAt;
      }
      if (missed.length > 0) {
        // Claude starts a steer that missed the fold as its own native turn
        // (~1 ms later; withdrawing it now is unreliable). That turn continues
        // this host turn; its result settles both segments together.
        this.holdForSteerContinuation(worker, pending, text, turnUsage, missed, earlier?.dropped ?? 0);
        if (sendNowCut) pending.continuation!.cut = true;
        return;
      }
      this.settleTurnSuccess(worker, pending, text, turnUsage, earlier?.dropped ?? 0);
      return;
    }

    if (parsed.type === "result") {
      worker.nativeTurnOpen = false;
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
      worker.taskNotificationTurnActive = false;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
      this.resolveTaskNotificationWaiters(worker);
    }
  }

  /** Close only the review segment actually observed. Adoption keeps its
   * pre-input text in the old readonly scope; later output belongs to the new
   * human turn. No synthetic CLI completion or current-run controls are made. */
  private finishReview(worker: ClaudeWorker, parsed: ClaudeStreamEvent, adopted = false): void {
    const eventSeenAt = Date.now();
    const resultMetadata = toTaskNotificationMetadata(parsed);
    const activeReview = worker.pendingTaskNotification;
    // Explicit task identity takes precedence over the currently open review.
    // A late result for B must not borrow A's callback, text or completion slot.
    const ownsReviewSlot = !resultMetadata.taskId || !activeReview
      || activeReview.taskId === resultMetadata.taskId;
    const pendingNotification = ownsReviewSlot ? activeReview
      : worker.queuedTaskNotifications.find(({ entry }) => entry.taskId === resultMetadata.taskId)?.entry;
    const resultTask = resultMetadata.taskId ? worker.backgroundTasks.get(resultMetadata.taskId) : undefined;
    const reviewScope = pendingNotification?.reviewScope ?? resultTask?.reviewScope;
    const collectedTaskId = resultMetadata.taskId ?? pendingNotification?.taskId;
    if (collectedTaskId) {
      worker.queuedTaskNotifications = worker.queuedTaskNotifications
        .filter(({ entry }) => entry.taskId !== collectedTaskId);
    }
    const clearOwnedReview = (hasReply = false) => {
      if (!ownsReviewSlot) return;
      reportAnswerProgress(activeReview, { phase: parsed.is_error ? "interrupted" : hasReply ? "finished" : "unknown" });
      if (!adopted) worker.nativeTurnOpen = false;
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
      worker.taskNotificationTurnActive = false;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
      this.resolveTaskNotificationWaiters(worker);
    };
    if (collectedTaskId && worker.collectedBackgroundTaskIds.delete(collectedTaskId)) {
      if (reviewScope) void worker.scoped.finish(reviewScope, "unknown");
      clearOwnedReview();
      return;
    }
    if (!ownsReviewSlot && !pendingNotification && !resultTask) return;
    // A review can launch more background work and then write a long summary
    // before task_started arrives. Anchor only its still-unregistered calls;
    // foreign, collected or replayed review results cannot renew this grace.
    if (ownsReviewSlot && worker.taskNotificationTurnActive && pendingNotification) {
      for (const owner of this.unstartedBackgroundCalls(worker)) {
        if (pendingNotification.reviewIdentity && owner.reviewIdentity === pendingNotification.reviewIdentity
          && owner.turnId === pendingNotification.turnId && owner.onEngineEvent === pendingNotification.onEngineEvent) {
          owner.lastSeenAt = eventSeenAt;
        }
      }
    }
    const taskId = resultMetadata.taskId ?? pendingNotification?.taskId;
    const registeredReview = taskId ? worker.backgroundTasks.get(taskId) : undefined;
    if (registeredReview) { delete registeredReview.reviewIdentity; delete registeredReview.reviewInputToken; }
    const metadata = {
      taskId,
      toolUseId: resultMetadata.toolUseId
        ?? pendingNotification?.toolUseId
        ?? resultTask?.toolUseId,
      status: parsed.is_error ? "failed" : resultMetadata.status ?? pendingNotification?.status ?? resultTask?.status,
      summary: resultMetadata.summary ?? pendingNotification?.summary ?? resultTask?.summary,
      outputFile: resultMetadata.outputFile ?? pendingNotification?.outputFile ?? resultTask?.outputFile,
      isMonitorEvent: pendingNotification?.isMonitorEvent ?? resultTask?.isMonitorEvent,
      parentToolUseId: pendingNotification?.parentToolUseId ?? resultTask?.parentToolUseId,
      turnId: pendingNotification?.turnId ?? resultTask?.turnId,
      onEngineEvent: pendingNotification?.onEngineEvent ?? resultTask?.onEngineEvent ?? worker.onEngineEvent,
      lastSeenAt: eventSeenAt,
    };
    if (taskId && !metadata.isMonitorEvent) {
      worker.backgroundTasks.delete(taskId);
    }
    if (metadata.toolUseId && !metadata.isMonitorEvent) {
      worker.explicitBackgroundToolUseIds.delete(backgroundCallKey(metadata.toolUseId, metadata.parentToolUseId));
      worker.backgroundToolOwners.delete(backgroundCallKey(metadata.toolUseId, metadata.parentToolUseId));
    }
    const rawResultText = parsed.result
      ? mergeIntermediateDeliveryText(parsed.result, ownsReviewSlot ? worker.taskNotificationDeliveryText : "")
      : ownsReviewSlot ? worker.taskNotificationAssistantText : "";
    const resultText = sanitizeClaudeUserVisibleText(rawResultText);
    // Capture the text before advancing the queue: installing a queued review
    // resets its buffers and must not erase this task's streamed-only result.
    if (reviewScope) {
      if (adopted) void worker.scoped.finish(reviewScope, "done");
      else worker.scoped.accept(reviewScope, { ...parsed, result: resultText });
    }
    clearOwnedReview(Boolean(resultText.trim()));
    const text = adopted && !resultText.trim() ? "" : renderBackgroundTaskTurnResult(metadata, resultText);
    if (text) {
      const settlesCurrentTurn = !adopted && !metadata.isMonitorEvent && metadata.turnId !== undefined && worker.pendingTurn?.turnId === metadata.turnId && !worker.pendingTurn.assistantError;
      const deliver = () => this.emitEngineEvent(worker, {
        type: "task_notification",
        ...(reviewScope ? { scopeId: reviewScope.scope.id } : {}),
        text,
        origin: metadata.turnId !== undefined && (pendingNotification?.onEngineEvent || resultTask?.onEngineEvent) ? "bound" : "unattributed",
        ...(!resultText.trim() && !metadata.summary?.trim() ? { reason: "no_result" as const } : {}),
        sessionId: worker.currentSessionId ?? undefined,
        taskId,
        status: parsed.is_error ? "failed" : metadata.isMonitorEvent ? "update" : metadata.status,
        summary: metadata.summary,
        outputFile: metadata.outputFile,
        ...(settlesCurrentTurn ? { settlesCurrentTurn: true } : {}),
      }, metadata.onEngineEvent);
      void deliver();
      if (!adopted) this.armBackgroundTaskTurnSettlement(worker, metadata, text, parsed.is_error === true);
    } else if (reviewScope) {
      // A monitor may intentionally have no separate report. Still close an
      // already-published process card instead of leaving it delivering.
      void this.emitEngineEvent(worker, { type: "task_notification", scopeId: reviewScope.scope.id,
        text: "", origin: "bound", taskId, status: parsed.is_error ? "failed" : "completed",
        reason: "no_result", suppressUserDelivery: true,
      }, metadata.onEngineEvent);
    }

  }

  private settleCollectedBackgroundTask(worker: ClaudeWorker, expectedTaskId: string, content: unknown): void {
    const terminal = parseClaudeTaskOutputTerminal(content);
    if (!terminal || terminal.taskId !== expectedTaskId) {
      return;
    }
    this.settleCollectedTask(worker, terminal);
  }

  private settleCollectedTask(worker: ClaudeWorker, terminal: { taskId: string; status: string }): void {
    const task = worker.backgroundTasks.get(terminal.taskId);
    if (!task) {
      return;
    }

    const status = terminal.status === "completed" ? "done" : /^(failed|error)$/.test(terminal.status) ? "error" : "unknown";
    worker.scoped.finishTask(terminal.taskId, status);
    if (task.reviewScope) void worker.scoped.finish(task.reviewScope, status);
    worker.backgroundTasks.delete(terminal.taskId);
    worker.collectedBackgroundTaskIds.add(terminal.taskId);
    if (task.toolUseId) {
      worker.explicitBackgroundToolUseIds.delete(backgroundCallKey(task.toolUseId, task.parentToolUseId));
      worker.backgroundToolOwners.delete(backgroundCallKey(task.toolUseId, task.parentToolUseId));
    }
    this.emitEngineEvent(worker, {
      type: "task_notification",
      text: `${task.summary?.trim() || "Background task"}: ${terminal.status}; result collected in the active turn.`,
      sessionId: worker.currentSessionId ?? undefined,
      taskId: terminal.taskId,
      origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed",
      ...(task.reviewScope ? { scopeId: task.reviewScope.scope.id } : {}),
      status: terminal.status,
      suppressUserDelivery: true,
      ...(task.summary ? { summary: task.summary } : {}),
      ...(task.outputFile ? { outputFile: task.outputFile } : {}),
    }, task.onEngineEvent);
  }

  private emitBackgroundTaskFinished(
    worker: ClaudeWorker,
    metadata: ClaudeTaskNotificationMetadata,
    task: ClaudeBackgroundTask | undefined,
  ): void {
    const taskId = metadata.taskId ?? task?.taskId;
    if (metadata.isMonitorEvent || !taskId || !task || worker.finishedBackgroundTaskIds.has(taskId)) {
      return;
    }

    worker.scoped.finishTask(taskId, /^(completed|done|success)$/.test(metadata.status ?? task.status ?? "") ? "done" : /^(failed|error)$/.test(metadata.status ?? task.status ?? "") ? "error" : "unknown");
    worker.finishedBackgroundTaskIds.add(taskId);
    const status = metadata.status ?? task.status;
    const summary = metadata.summary ?? task.summary;
    const outputFile = metadata.outputFile ?? task.outputFile;
    worker.backgroundTasks.set(taskId, {
      ...task,
      ...metadata,
      taskId,
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
      ...(outputFile ? { outputFile } : {}),
      lastSeenAt: Date.now(),
    });
    this.emitEngineEvent(worker, {
      type: "background_task_finished",
      origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed",
      taskId,
      sessionId: worker.currentSessionId ?? undefined,
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
      ...(outputFile ? { outputFile } : {}),
    }, task.onEngineEvent);
  }

  private armBackgroundTaskTurnSettlement(
    worker: ClaudeWorker,
    metadata: ClaudeTaskNotificationMetadata & { turnId?: number },
    text?: string,
    reviewFailed = false,
  ): void {
    const pending = worker.pendingTurn;
    if (metadata.isMonitorEvent || !pending || metadata.turnId === undefined || metadata.turnId !== pending.turnId) {
      return;
    }
    if (metadata.toolUseId) {
      pending.outstandingToolUseIds.delete(metadata.toolUseId);
    }
    this.clearBackgroundTaskTurnSettlement(pending);
    const resultText = renderBackgroundTaskTurnResult(metadata, text);
    pending.backgroundCompletionTimer = setTimeout(() => {
      if (worker.pendingTurn !== pending || pending.assistantError) {
        return;
      }
      // The turn is only "finished" if it has no tool call still running. Any
      // event clears this timer, so the dangerous case is a LONG SILENT tool call:
      // settling there would resolve the turn with the background task's text and
      // throw away the real answer (and its usage) that arrives seconds later.
      if (pending.outstandingToolUseIds.size > 0) {
        return;
      }
      worker.scoped.finishTurn(pending.turnId, reviewFailed ? "error" : "done");
      worker.pendingTurn = null;
      this.markWorkerActivity(worker);
      this.clearPendingTurnTimeout(pending);
      this.abandonUnfoldedSteers(worker, pending);
      if (reviewFailed) {
        pending.reject(new Error(appendClaudeMcpWarnings(resultText || "Claude background review failed", pending.engineWarnings)));
        return;
      }
      this.emitEngineEvent(worker, {
        type: "result",
        text: resultText,
        sessionId: worker.currentSessionId ?? undefined,
      }, pending.onEngineEvent);
      pending.resolve({
        text: resultText,
        sessionId: worker.currentSessionId ?? undefined,
      });
    }, BACKGROUND_TASK_TURN_SETTLE_GRACE_MS);
    pending.backgroundCompletionTimer.unref?.();
  }

  private clearBackgroundTaskTurnSettlement(pending: PendingTurn | null | undefined): void {
    if (pending?.backgroundCompletionTimer) {
      clearTimeout(pending.backgroundCompletionTimer);
      pending.backgroundCompletionTimer = undefined;
    }
  }

  /**
   * An `is_error` result for the written foreground prompt is Claude's terminal
   * frame; the worker stays alive and its transcript keeps the prompt plus any
   * completed tool results. Recovery therefore continues the real native session.
   * Background tasks or a pending review could absorb or interleave with that
   * continuation, so they withhold the receipt. The CLI has already applied its
   * own API retries (`system/api_retry`) before reporting this result.
   */
  private rejectWithRetryReceipt(worker: ClaudeWorker, pending: PendingTurn, frame: ClaudeStreamEvent, failure: Error): void {
    if (pending.absorbedReview) { pending.reject(failure); return; }
    // Eligibility reflects the worker at this terminal frame, before any I/O.
    const sessionId = worker.currentSessionId;
    const reason = !sessionId || isLogicalSessionId(sessionId) || !pending.promptWritten || this.workers.get(sessionId) !== worker
      || [...worker.backgroundTasks.keys()].some((taskId) => !worker.finishedBackgroundTaskIds.has(taskId))
      || worker.pendingTaskNotification
      || this.taskNotificationTurnBusy(worker)
      || worker.taskNotificationWaiters.size > 0
      ? undefined
      : claudeTransientRetryReason(frame);
    if (!sessionId || !reason) {
      pending.reject(failure);
      return;
    }
    const usage = frame.usage;
    const receipt = (costUsd?: number) => new EngineRetryableError(failure.message, {
      sessionId,
      mode: "continue",
      reason,
      ...(usage ? { usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.cache_read_input_tokens,
        costUsd,
      } } : {}),
    }, { cause: failure });
    // Like success, the failed attempt's cost is released only with a durable baseline.
    if (usage) void this.turnCostUsd(worker, frame).then((costUsd) => pending.reject(receipt(costUsd)), () => pending.reject(receipt()));
    else pending.reject(receipt());
  }

  /**
   * This foreground result's cost from Claude's session-cumulative ledger; the
   * same normalization serves success and failure receipts. Background review
   * results are not baselines, so their cost folds into the next recorded
   * foreground turn instead of being lost.
   */
  private async turnCostUsd(worker: ClaudeWorker, frame: ClaudeStreamEvent): Promise<number | undefined> {
    const sessionId = worker.currentSessionId;
    if (!sessionId) return undefined;
    const recorded = await this.sessionUsage.recordResult({
      sessionId,
      workspace: worker.workspacePath,
      totalCostUsd: frame.total_cost_usd,
      resultId: frame.uuid,
      freshLedger: worker.freshCostLedger,
    });
    // Until a baseline is stored, a fresh session's ledger still counts from zero.
    if (recorded.baselineSaved) worker.freshCostLedger = false;
    return recorded.costUsd;
  }

  private taskNotificationTurnBusy(worker: ClaudeWorker): boolean {
    if (worker.taskNotificationTurnActive) {
      return true;
    }

    // The terminal system notification only records ownership metadata. Give
    // Claude a bounded window to start its synthetic review, but do not reserve
    // stdin forever when that follow-up frame never arrives.
    const pending = worker.pendingTaskNotification;
    return pending !== null
      && Date.now() - pending.lastSeenAt < this.taskNotificationStartGraceMs;
  }

  private activePendingTurn(worker: ClaudeWorker): PendingTurn | null {
    const pending = worker.pendingTurn;
    return pending?.nativeAdmission && !pending.nativeStarted ? null : pending;
  }

  private resultNamesTurn(frame: ClaudeStreamEvent, turn: PendingTurn): boolean {
    return frame.type === "result" && markerList(frame.user_message_uuids, frame.user_message_uuid).includes(turn.nativeCommand);
  }

  private reviewInputProtocolReady(worker: ClaudeWorker): boolean {
    return this.softStopReady(worker) && worker.control.has(CLAUDE_REQUEST_MARKER_LISTS);
  }

  private canAdmitReviewInput(worker: ClaudeWorker, input: Pick<CodexUserMessageInput, "inputOwnerKey" | "reviewAdmission" | "engineRecoveryContinuation">, ownPending?: PendingTurn): boolean {
    if (input.reviewAdmission !== "native" || input.engineRecoveryContinuation || !input.inputOwnerKey || worker.retired
      || worker.pendingTurn && worker.pendingTurn !== ownPending || worker.continuationTurn
      || worker.stopFence || !this.reviewInputProtocolReady(worker)
      || !worker.control.canTrack() || !this.hasNativeInputRoom(worker)) return false;
    const review = worker.pendingTaskNotification;
    if (!review || review.inputOwnerKey !== input.inputOwnerKey || review.turnId === undefined || !review.onEngineEvent) return false;
    // The CLI may choose a queued review before taking this prompt. Even a
    // later review must belong to the same conversation, never a shared one.
    const owners = [...worker.backgroundTasks.values(), ...this.unstartedBackgroundCalls(worker), ...worker.queuedTaskNotifications.map(item => item.entry)];
    return owners.every(owner => owner.inputOwnerKey === input.inputOwnerKey && owner.turnId !== undefined && !!owner.onEngineEvent);
  }

  backgroundInputTarget(sessionId: string, ownerKey: string): string | undefined {
    const worker = this.workers.get(sessionId);
    if (!worker || this.destroyPromise || worker.pendingTurn || worker.continuationTurn || !this.taskNotificationTurnBusy(worker)
      || !this.canAdmitReviewInput(worker, { inputOwnerKey: ownerKey, reviewAdmission: "native" })) return undefined;
    const review = worker.pendingTaskNotification!;
    review.reviewInputToken ??= randomUUID();
    const task = review.taskId ? worker.backgroundTasks.get(review.taskId) : undefined;
    if (task) task.reviewInputToken = review.reviewInputToken;
    return review.reviewInputToken;
  }

  private rejectReviewInput(input: CodexUserMessageInput): never {
    try { input.nativeInput?.onProgress({ state: "dropped", reason: "not_admitted" }); } catch { /* receipt observer is best effort */ }
    throw new EngineNativeInputUnsentError("not_admitted");
  }

  private startReviewInput(worker: ClaudeWorker, pending: PendingTurn): void {
    if (pending.nativeStarted) return;
    pending.nativeStarted = true;
    const native = worker.nativeInputByUuid.get(pending.nativeCommand);
    if (native) this.reportNativeInput(native, "dequeued");
    void this.emitEngineEvent(worker, { type: "native_input_wait", status: "finished", sessionId: worker.currentSessionId ?? undefined }, pending.onEngineEvent);
    worker.onEngineEvent = pending.onEngineEvent;
    this.adoptReviewForTurn(worker, pending);
    worker.nativeTurnOpen = true;
    this.armTurnInactivityWatchdog(worker);
  }

  private adoptReviewForTurn(worker: ClaudeWorker, pending?: PendingTurn): void {
    if (!worker.taskNotificationTurnActive) return;
    if (worker.nativeTurnOpen) {
      if (pending) pending.absorbedReview = true;
      this.finishReview(worker, { type: "review_adopted" }, true);
    }
    // A preinstalled notification is bookkeeping, not evidence that its
    // native turn has begun. Keep it pending behind this actual human turn.
    if (worker.taskNotificationTurnActive && worker.pendingTaskNotification) {
      worker.queuedTaskNotifications.unshift({ entry: worker.pendingTaskNotification, reviewTurn: false });
      worker.pendingTaskNotification = null;
      worker.taskNotificationTurnActive = false;
      worker.suppressNextTaskNotificationAssistant = false;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
    }
  }

  private settleExpiredTaskNotification(worker: ClaudeWorker, now = Date.now()): void {
    if (worker.taskNotificationTurnActive) {
      return;
    }
    const pending = worker.pendingTaskNotification;
    if (!pending || now - pending.lastSeenAt < this.taskNotificationStartGraceMs) {
      return;
    }

    worker.pendingTaskNotification = null;
    const taskId = pending.taskId;
    const task = taskId ? worker.backgroundTasks.get(taskId) : undefined;
    if (!taskId || !task || !worker.finishedBackgroundTaskIds.has(taskId)) {
      return;
    }

    if (pending.reviewScope) void worker.scoped.finish(pending.reviewScope, "unknown");
    worker.backgroundTasks.delete(taskId);
    worker.collectedBackgroundTaskIds.add(taskId);
    const toolUseId = pending.toolUseId ?? task.toolUseId;
    if (toolUseId) {
      worker.explicitBackgroundToolUseIds.delete(backgroundCallKey(toolUseId, pending.parentToolUseId ?? task.parentToolUseId));
      worker.backgroundToolOwners.delete(backgroundCallKey(toolUseId, pending.parentToolUseId ?? task.parentToolUseId));
    }
    const status = pending.status ?? task.status ?? "unknown";
    const summary = pending.summary ?? task.summary;
    const outputFile = pending.outputFile ?? task.outputFile;
    this.emitEngineEvent(worker, {
      type: "task_notification",
      origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed",
      ...(pending.reviewScope ? { scopeId: pending.reviewScope.scope.id } : {}),
      reason: "no_result",
      text: `${summary?.trim() || "Background task"}: ${status}; no separate review started within the bounded grace window.`,
      sessionId: worker.currentSessionId ?? undefined,
      taskId,
      status,
      suppressUserDelivery: true,
      ...(summary ? { summary } : {}),
      ...(outputFile ? { outputFile } : {}),
    }, task.onEngineEvent);
  }

  /** True when a review turn is running for a DIFFERENT task than taskId. */
  private foreignReviewActive(worker: ClaudeWorker, taskId: string | undefined): boolean {
    return worker.taskNotificationTurnActive
      && worker.pendingTaskNotification !== null
      && worker.pendingTaskNotification.taskId !== undefined
      && taskId !== undefined
      && worker.pendingTaskNotification.taskId !== taskId;
  }

  /** Install the next queued cross-turn notification once the slot is free.
   *  The finished banner already went out when the task completed; installing
   *  only restores the attribution/review bookkeeping the clobber used to
   *  destroy. */
  private installNextQueuedTaskNotification(worker: ClaudeWorker): void {
    if (worker.taskNotificationTurnActive || worker.queuedTaskNotifications.length === 0) {
      return;
    }
    const now = Date.now();
    if (
      worker.pendingTaskNotification !== null
      && now - worker.pendingTaskNotification.lastSeenAt < this.taskNotificationStartGraceMs
    ) {
      return;
    }
    const next = worker.queuedTaskNotifications.shift()!;
    worker.pendingTaskNotification = { ...next.entry, lastSeenAt: now };
    if (next.reviewTurn) {
      this.ensureReviewScope(worker, worker.pendingTaskNotification);
      worker.taskNotificationTurnActive = true;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
    }
  }

  private rememberBackgroundTool(worker: ClaudeWorker, id: string, owner: ClaudeBackgroundTask): void {
    if (!id || id.length > 512) return;
    const key = backgroundCallKey(id, owner.parentToolUseId);
    if (worker.ambiguousBackgroundCalls.has(key)) return;
    const previous = worker.backgroundToolOwners.get(key);
    if (previous && (previous.inputOwnerKey !== owner.inputOwnerKey || previous.turnId !== owner.turnId || previous.onEngineEvent !== owner.onEngineEvent || previous.reviewIdentity !== owner.reviewIdentity)) {
      worker.backgroundToolOwners.delete(key); worker.explicitBackgroundToolUseIds.delete(key);
      worker.ambiguousBackgroundCalls.add(key);
      while (worker.ambiguousBackgroundCalls.size > 1024) worker.ambiguousBackgroundCalls.delete(worker.ambiguousBackgroundCalls.values().next().value!);
      return;
    }
    // Keep the first binding and its acknowledgement marker on a replay.
    if (previous || worker.backgroundToolOwners.size >= 1024) return;
    worker.backgroundToolOwners.set(key, owner); worker.explicitBackgroundToolUseIds.add(key);
  }

  /** Existing explicit call bindings that have not acquired a native task ID.
   * A per-read projection, not another task registry; completed/collected tasks
   * keep their existing cleanup and must never acquire a new start grace. */
  private unstartedBackgroundCalls(worker: ClaudeWorker): ClaudeBackgroundTask[] {
    const registeredCalls = new Set<string>();
    for (const task of worker.backgroundTasks.values()) {
      if (task.toolUseId) registeredCalls.add(backgroundCallKey(task.toolUseId, task.parentToolUseId));
    }
    return [...worker.backgroundToolOwners].filter(([key]) => worker.explicitBackgroundToolUseIds.has(key)
      && !registeredCalls.has(key)).map(([, owner]) => owner);
  }

  private trackBackgroundTask(worker: ClaudeWorker, metadata: ClaudeTaskNotificationMetadata, childOwner?: ClaudeBackgroundTask): void {
    if (!metadata.taskId) return;
    // The CLI can report task_started AFTER the originating foreground turn
    // completed. A call-id binding outranks whichever turn is active now.
    const captured = metadata.toolUseId ? worker.backgroundToolOwners.get(backgroundCallKey(metadata.toolUseId, childOwner?.parentToolUseId)) : undefined;
    if (metadata.toolUseId && !captured) return;
    // A start without a native call ID has no provable foreground owner.
    // Keep its lifecycle, but never borrow a newer prompt or its permissions.
    const owner = captured ?? childOwner;
    const existing = worker.backgroundTasks.get(metadata.taskId);
    if (existing) return; // A replay cannot replace a task's captured owner.
    worker.scoped.bindTask(metadata.toolUseId, metadata.taskId);
    worker.collectedBackgroundTaskIds.delete(metadata.taskId);
    worker.finishedBackgroundTaskIds.delete(metadata.taskId);
    const task: ClaudeBackgroundTask = { ...metadata, inputOwnerKey: owner?.inputOwnerKey, turnId: owner?.turnId,
      onEngineEvent: owner?.onEngineEvent ?? (!metadata.toolUseId ? worker.onEngineEvent : undefined),
      onApprovalRequest: owner?.onApprovalRequest, ...(childOwner ? { parentToolUseId: childOwner.parentToolUseId } : {}), lastSeenAt: Date.now() };
    worker.backgroundTasks.set(metadata.taskId, task);
    void this.emitEngineEvent(worker, { type: "background_task_started", origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed", taskId: metadata.taskId,
      sessionId: worker.currentSessionId ?? undefined, ...(metadata.summary ? { description: metadata.summary } : {}),
    }, task.onEngineEvent);
  }

  private ensureReviewScope(worker: ClaudeWorker, task: ClaudeBackgroundTask): void {
    if (task.taskId && worker.collectedBackgroundTaskIds.has(task.taskId)) return;
    task.reviewIdentity ??= {};
    const registered = task.taskId ? worker.backgroundTasks.get(task.taskId) : undefined;
    // Native notification replays copy the registered task into a fresh slot
    // object. Retain this review's identity until its result, even without UI.
    if (registered) registered.reviewIdentity = task.reviewIdentity;
    if ((task.reviewScope && !task.reviewScope.closed) || task.turnId === undefined || !task.onEngineEvent) return;
    task.reviewScope = worker.scoped.startReview({ emit: task.onEngineEvent, turnId: task.turnId, origin: "bound", inputOwnerKey: task.inputOwnerKey }, task.taskId, task.summary);
    if (registered) registered.reviewScope = task.reviewScope;
  }

  private async waitForReviewAdmission(worker: ClaudeWorker, input: CodexUserMessageInput): Promise<void> {
    if (input.reviewAdmission === "native") {
      if (!this.canAdmitReviewInput(worker, input)) this.rejectReviewInput(input);
      return;
    }
    if (!this.taskNotificationTurnBusy(worker) || this.canAdmitReviewInput(worker, input)) return;
    const report = (status: "started" | "finished" | "cancelled") => input.onEngineEvent ? this.emitEngineEvent(worker,
      { type: "background_review_wait", status, sessionId: worker.currentSessionId ?? undefined }, input.onEngineEvent) : Promise.resolve();
    await report("started");
    try {
      while (this.taskNotificationTurnBusy(worker)) await this.waitForTaskNotificationTurn(worker, input.abortSignal);
      await report("finished");
    } catch (error) { await report("cancelled"); throw error; }
  }

  private waitForTaskNotificationTurn(
    worker: ClaudeWorker,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!this.taskNotificationTurnBusy(worker)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: ClaudeTaskNotificationWaiter = { resolve, reject, abortSignal };
      if (abortSignal) {
        waiter.abortHandler = () => {
          worker.taskNotificationWaiters.delete(waiter);
          if (waiter.graceTimer) {
            clearTimeout(waiter.graceTimer);
          }
          abortSignal.removeEventListener("abort", waiter.abortHandler!);
          reject(new Error("Task was stopped by user"));
        };
        if (abortSignal.aborted) {
          waiter.abortHandler();
          return;
        }
        abortSignal.addEventListener("abort", waiter.abortHandler, { once: true });
      }

      worker.taskNotificationWaiters.add(waiter);
      if (!worker.taskNotificationTurnActive && worker.pendingTaskNotification) {
        const elapsedMs = Date.now() - worker.pendingTaskNotification.lastSeenAt;
        const remainingMs = Math.max(0, this.taskNotificationStartGraceMs - elapsedMs);
        waiter.graceTimer = setTimeout(() => {
          waiter.graceTimer = undefined;
          this.resolveTaskNotificationWaiters(worker);
        }, remainingMs + 1);
        waiter.graceTimer.unref?.();
      }
      if (!this.taskNotificationTurnBusy(worker)) {
        this.resolveTaskNotificationWaiters(worker);
      }
    });
  }

  private resolveTaskNotificationWaiters(worker: ClaudeWorker): void {
    this.advanceTaskNotificationQueue(worker);
    if (this.taskNotificationTurnBusy(worker)) {
      // Still busy — either a review turn runs, or a (possibly just-installed or
      // replaced) notification holds a fresh grace window. A waiter whose grace
      // timer already fired has none left, and nothing else re-arms it: before
      // this re-arm, a notification replaced during the window left queued
      // foreground turns waiting forever (stdin never written) until /stop,
      // worker death, or the 6h prune.
      if (!worker.taskNotificationTurnActive && worker.pendingTaskNotification) {
        const remainingMs = Math.max(
          0,
          this.taskNotificationStartGraceMs - (Date.now() - worker.pendingTaskNotification.lastSeenAt),
        );
        for (const waiter of worker.taskNotificationWaiters) {
          if (!waiter.graceTimer) {
            waiter.graceTimer = setTimeout(() => {
              waiter.graceTimer = undefined;
              this.resolveTaskNotificationWaiters(worker);
            }, remainingMs + 1);
            waiter.graceTimer.unref?.();
          }
        }
      }
      return;
    }
    for (const waiter of worker.taskNotificationWaiters) {
      if (waiter.graceTimer) {
        clearTimeout(waiter.graceTimer);
      }
      if (waiter.abortSignal && waiter.abortHandler) {
        waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.resolve();
    }
    worker.taskNotificationWaiters.clear();
  }

  private advanceTaskNotificationQueue(worker: ClaudeWorker): void {
    // Drain already-expired system-only notifications before releasing a
    // foreground waiter. With a zero grace (tests/operator override), more
    // than one queued completion may be ready in the same stdout batch.
    while (true) {
      this.settleExpiredTaskNotification(worker);
      this.installNextQueuedTaskNotification(worker);
      if (this.taskNotificationTurnBusy(worker) || !worker.pendingTaskNotification) {
        break;
      }
    }
  }

  private rejectTaskNotificationWaiters(worker: ClaudeWorker, error: Error): void {
    for (const waiter of worker.taskNotificationWaiters) {
      if (waiter.graceTimer) {
        clearTimeout(waiter.graceTimer);
      }
      if (waiter.abortSignal && waiter.abortHandler) {
        waiter.abortSignal.removeEventListener("abort", waiter.abortHandler);
      }
      waiter.reject(error);
    }
    worker.taskNotificationWaiters.clear();
  }

  private async handleControlRequest(worker: ClaudeWorker, parsed: ClaudeStreamEvent): Promise<void> {
    const requestId = parsed.request_id;
    const pending = this.activePendingTurn(worker);
    const taskNotificationOwner = worker.taskNotificationTurnActive
      ? worker.pendingTaskNotification
      : null;
    const approvalHandler = taskNotificationOwner ? taskNotificationOwner.onApprovalRequest : pending?.onApprovalRequest;
    if (!requestId) {
      return;
    }
    if (parsed.request?.subtype !== "can_use_tool") {
      this.writeJson(worker, { type: "control_response", response: { subtype: "error", request_id: requestId, error: "Unsupported control request" } });
      return;
    }

    const request = toApprovalInput(parsed, worker.currentSessionId);
    if (taskNotificationOwner) {
      if (isAskUserQuestionRequest(request)) request.supportsAnswerProgress = true;
    }
    if (request.abortSignal === undefined && !taskNotificationOwner && pending?.approvalAbortController) {
      request.abortSignal = pending.approvalAbortController.signal;
    }

    const toolInput = parsed.request?.input ?? parsed.request?.tool_input ?? parsed.request?.toolInput ?? {};
    const childTools = typeof parsed.request?.tool_use_id === "string" ? worker.scoped.toolScopes(parsed.request.tool_use_id) : [];
    const childRequest = Boolean(parsed.parent_tool_use_id)
      || (typeof parsed.request?.tool_use_id === "string" && worker.scoped.hasChildTool(parsed.request.tool_use_id));
    const childScope = parsed.parent_tool_use_id
      ? worker.scoped.findDelegate(parsed.parent_tool_use_id)
      : childTools.length === 1 ? childTools[0] : undefined;
    const ownsChildApproval = (): boolean => Boolean(childScope && !childScope.closed && pending
      && worker.pendingTurn === pending && !pending.approvalAbortController.signal.aborted
      && !worker.taskNotificationTurnActive && childScope.owner.turnId === pending.turnId
      && childScope.owner.emit === pending.onEngineEvent);
    if (childRequest) {
      if (childScope) worker.scoped.emit(childScope, { type: "permission_request", toolName: request.toolName, toolInput: request.toolInput,
        ...(typeof parsed.request?.tool_use_id === "string" ? { toolUseId: parsed.request.tool_use_id } : {}) });
      // A live child may ask its owning turn for tool consent, but never gains
      // App capabilities or borrows a newer foreground turn's approval handler.
      if (!ownsChildApproval() || worker.appMcp?.owns(request.toolName)) {
        this.writeJson(worker, { type: "control_response", response: { subtype: "error", request_id: requestId,
          error: "Child requests cannot use the parent conversation's host capabilities" } });
        return;
      }
    }
    // These installed host tools enforce authorization in tools/call. Do not
    // show an approval card that cannot grant a missing/stale App capability;
    // permission callbacks may also arrive before their assistant tool_use.
    if (worker.appMcp?.owns(request.toolName)) {
      this.writeJson(worker, { type: "control_response", response: { subtype: "success", request_id: requestId, response: renderPermissionResponse({ behavior: "allow" }, toolInput) } });
      return;
    }
    const permissionEvent: Extract<EngineStreamEvent, { type: "permission_request" }> = {
      type: "permission_request",
      toolName: request.toolName,
      toolInput: request.toolInput,
      ...(typeof parsed.request?.tool_use_id === "string" && parsed.request.tool_use_id ? { toolUseId: parsed.request.tool_use_id } : {}),
      sessionId: worker.currentSessionId ?? undefined,
    };
    if (taskNotificationOwner) {
      if (taskNotificationOwner.reviewScope) worker.scoped.emit(taskNotificationOwner.reviewScope, permissionEvent);
    } else if (!childRequest) void this.emitEngineEvent(worker, permissionEvent);
    let decision: EngineApprovalDecision;
    if (isAskUserQuestionRequest(request)) {
      if (!approvalHandler) {
        decision = { behavior: "deny" };
      } else {
        try {
          reportAnswerProgress(taskNotificationOwner, { phase: "waiting_input" });
          decision = await approvalHandler(request);
        } catch {
          decision = { behavior: "deny" };
        }
      }
    } else if (worker.approvalMode !== "normal") {
      decision = { behavior: "allow", scope: "session" };
    } else if (!approvalHandler) {
      decision = { behavior: "deny" };
    } else {
      const key = sessionApprovalKey(request);
      if (worker.sessionApprovedKeys.has(key)) {
        decision = { behavior: "allow", scope: "session" };
      } else {
        try {
          const inFlight = worker.pendingApprovalByKey.get(key);
          if (inFlight) {
            decision = await inFlight;
          } else {
            reportAnswerProgress(taskNotificationOwner, { phase: "waiting_input" });
            const decisionPromise = approvalHandler(request);
            worker.pendingApprovalByKey.set(key, decisionPromise);
            try {
              decision = await decisionPromise;
            } finally {
              if (worker.pendingApprovalByKey.get(key) === decisionPromise) {
                worker.pendingApprovalByKey.delete(key);
              }
            }
          }
          if (decision.behavior === "allow" && decision.scope === "session" && (!childRequest || ownsChildApproval())) {
            worker.sessionApprovedKeys.add(key);
          }
        } catch {
          decision = { behavior: "deny" };
        }
      }
    }

    if (childRequest && !ownsChildApproval()) decision = { behavior: "deny" };

    if (taskNotificationOwner && decision.behavior === "allow" && decision.onAnswerProgress) {
      const current = worker.pendingTaskNotification;
      const sameReview = current === taskNotificationOwner || Boolean(current && taskNotificationOwner.taskId
        && current.taskId === taskNotificationOwner.taskId && current.turnId === taskNotificationOwner.turnId);
      if (worker.retired || !worker.taskNotificationTurnActive || !sameReview) {
        try { decision.onAnswerProgress({ phase: "unknown" }); } catch { /* best effort */ }
        decision = { behavior: "deny" };
      } else {
        current!.onAnswerProgress = decision.onAnswerProgress;
        const tracked = current!.taskId ? worker.backgroundTasks.get(current!.taskId) : undefined;
        if (tracked) tracked.onAnswerProgress = decision.onAnswerProgress;
      }
    }
    this.writeJson(worker, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: renderPermissionResponse(decision, toolInput),
      },
    });
    if (!worker.retired && taskNotificationOwner && decision.behavior === "allow") {
      reportAnswerProgress(worker.pendingTaskNotification, { phase: "sent" });
    }
  }

  private async sendTurn(worker: ClaudeWorker, prompt: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    // Only authenticated ordinary input can overlap an owned review. It owns
    // no output or tools until the CLI starts its command; the same result can
    // then finish the adopted review and this host turn. Other sources wait.
    do {
      await this.waitForStopFence(worker, input.abortSignal);
      await this.waitForReviewAdmission(worker, input);
      this.advanceTaskNotificationQueue(worker);
    } while (worker.stopFence || this.taskNotificationTurnBusy(worker) && !this.canAdmitReviewInput(worker, input));
    if (worker.retired) throw new ClaudeWorkerReplacedBeforeWriteError();
    if (input.reviewAdmission === "native" && !this.canAdmitReviewInput(worker, input)) this.rejectReviewInput(input);
    if (input.reviewAdmission !== "native") worker.onEngineEvent = input.onEngineEvent;

    if (worker.pendingTurn || worker.continuationTurn) {
      throw new Error("Claude session already has an in-flight turn");
    }

    return await new Promise<CodexAdapterResponse>((resolve, reject) => {
      this.markWorkerActivity(worker);
      const commandUuid = randomUUID();
      const pendingTurn: PendingTurn = {
        inputOwnerKey: input.inputOwnerKey,
        nativeAdmission: input.reviewAdmission === "native" && this.reviewInputProtocolReady(worker),
        commandUuid,
        nativeCommand: commandUuid,
        appPlatformTools: input.appPlatformTools,
        locale: input.locale,
        promptWritten: false,
        turnId: ++nextPendingTurnId,
        assistantText: "",
        intermediateDeliveryText: "",
        engineWarnings: [],
        onProgress: input.onProgress,
        onApprovalRequest: input.onApprovalRequest,
        onEngineEvent: input.onEngineEvent,
        approvalAbortController: new AbortController(),
        inactivityTimeoutDisabled: input.disableRuntimeTimeout === true,
        outstandingToolUseIds: new Set<string>(),
        startedAt: Date.now(), observedToolCalls: 0, observedToolResults: 0, pendingToolNames: new Map(),
        resolve,
        reject,
      };
      worker.pendingTurn = pendingTurn;
      if (pendingTurn.nativeAdmission) void this.emitEngineEvent(worker, { type: "native_input_wait", status: "started", sessionId: worker.currentSessionId ?? undefined }, pendingTurn.onEngineEvent);
      worker.stderrTail = "";
      // Start the inactivity watchdog now: a CLI that wedges before emitting its
      // first event must still settle the turn instead of holding the session lock.
      this.armTurnInactivityWatchdog(worker);

      if (input.abortSignal) {
        const onAbort = () => {
          // An explicit App stop interrupts only the native turn when Claude
          // advertises the receipt and lifecycle contracts. An unconsumed
          // review input is also withdrawn on any abort: the process still
          // belongs to the unrelated review, not to this queued input.
          if (this.stopTurnSoftly(worker, pendingTurn, input.abortSignal)) return;
          // Between two native segments the first one already answered.
          if (worker.continuationTurn === pendingTurn) this.dropHeldContinuation(worker, pendingTurn, "stopped", false);
          for (const uuid of pendingTurn.steers ?? []) this.reportSteer(worker, uuid, { status: "dropped", reason: "stopped" });
          killProcessTree(worker.child.pid, appStopKillOptions(input.abortSignal));
          this.failWorker(worker, new Error("Task was stopped by user"));
          this.removeWorker(worker);
        };
        if (input.abortSignal.aborted) { onAbort(); return; }
        pendingTurn.abortSignal = input.abortSignal;
        pendingTurn.abortHandler = onAbort;
        input.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      const writePrompt = () => {
        if (pendingTurn.nativeAdmission && !this.canAdmitReviewInput(worker, input, pendingTurn)) {
          worker.pendingTurn = null;
          this.clearPendingTurnTimeout(pendingTurn);
          try { this.rejectReviewInput(input); } catch (error) { pendingTurn.reject(error as Error); }
          return;
        }
        pendingTurn.promptWritten = true;
        worker.control.track(commandUuid);
        if (pendingTurn.nativeAdmission && input.nativeInput) this.registerNativeInput(worker, input.nativeInput, commandUuid, pendingTurn);
        worker.child.stdin?.write(
        JSON.stringify({
          type: "user",
          uuid: commandUuid,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        }) + "\n",
        (error) => {
          if (error) {
            // A pipe callback can arrive after native events (or a later turn).
            // Fail the worker's actual active turn through the common path so
            // its observed work survives and its promise is always settled.
            this.failWorker(worker, error);
            // Kill before forgetting the worker — removeWorker only drops the map
            // entry, so without this a child orphaned by a broken stdin pipe is
            // untracked and never reaped.
            killProcessTree(worker.child.pid);
            this.removeWorker(worker);
          }
        },
        );
        if (pendingTurn.nativeAdmission) void worker.control.waitForCommand(commandUuid, STEER_ADMITTED, CLAUDE_STEER_ACK_TIMEOUT_MS).then(state => {
          if (state !== undefined || worker.pendingTurn !== pendingTurn || worker.retired) return;
          const entry = worker.nativeInputByUuid.get(commandUuid);
          if (entry) this.reportNativeInput(entry, "unknown", "no_admission_receipt");
        });
      };
      if (worker.appMcp) {
        void worker.appMcp.ready.then(() => {
          if (!worker.retired && worker.pendingTurn === pendingTurn && !pendingTurn.approvalAbortController.signal.aborted) writePrompt();
        }).catch((error: unknown) => {
          if (worker.pendingTurn !== pendingTurn) return;
          this.failWorker(worker, error instanceof Error ? error : new Error("Claude App tools initialization failed"));
          killProcessTree(worker.child.pid);
          this.removeWorker(worker);
        });
      } else writePrompt();
    });
  }

  /**
   * Native mid-turn input (Claude Code CLI behavior for messages typed while it
   * works): the user's real text is written with a uuid and no priority, and
   * Claude takes it in at the running turn's next model request. `true` means
   * Claude admitted it (`queued`/`started`), not that output changed yet;
   * `onOutcome` reports what became of it. `priority: "now"` is never used: its
   * effect depends on the CLI (2.1.307 aborted the turn; 2.1.309 waits for the
   * running tool) and it returns no receipt.
   *
   * With `nativeInput` (ordinary App input typed by the signed-in user) the host
   * id maps to this worker's native uuid, the message is marked as a person's
   * own (`origin: human`, so a later send-now may move blocking work aside),
   * and progress is reported from native evidence only: queued, dequeued
   * (`started`), received (the model began replying to a request carrying it).
   * A retried id is never written twice to the same worker.
   */
  async steerActiveTurn(sessionId: string, input: { text: string; throwOnError?: boolean; onOutcome?: (outcome: ClaudeSteerOutcome) => void; nativeInput?: NativeInputObserver }): Promise<boolean> {
    const reject = (reason: EngineSteeringRejectedError["reason"]): false => {
      if (input.throwOnError) throw new EngineSteeringRejectedError(reason);
      return false;
    };
    const worker = this.workers.get(sessionId);
    const known = input.nativeInput && worker && !worker.retired ? worker.nativeInputs.get(input.nativeInput.id) : undefined;
    if (known) return this.resumeNativeInput(worker!, known, input.nativeInput!, reject, input.throwOnError);
    const pending = worker?.pendingTurn;
    if (!worker || worker.retired || worker.stopFence || this.destroyPromise) return reject("stale");
    if (!pending) return reject(worker.continuationTurn ? "not_ready" : "stale");
    if (!worker.control.has(CLAUDE_MESSAGE_LIFECYCLE)) return reject("unsupported");
    if (pending.approvalAbortController.signal.aborted) return reject("stale");
    if (!pending.promptWritten || worker.control.commandState(pending.nativeCommand) !== "started") return reject("queued");
    if (worker.taskNotificationTurnActive || !input.text.trim()) return reject("not_ready");
    // A native input is never written when its ownership could not be kept:
    // tracking it must not evict another written-but-unsettled input or command.
    if (input.nativeInput && (!worker.control.canTrack() || !this.hasNativeInputRoom(worker))) return reject("not_ready");
    const uuid = randomUUID();
    worker.control.track(uuid);
    (pending.steers ??= new Set()).add(uuid);
    if (input.onOutcome) worker.steerObservers.set(uuid, input.onOutcome);
    const native = input.nativeInput ? this.registerNativeInput(worker, input.nativeInput, uuid, pending) : undefined;
    this.writeJson(worker, { type: "user", uuid, message: { role: "user", content: [{ type: "text", text: input.text }] }, ...(native ? { origin: { kind: "human" } } : {}) });
    const state = await worker.control.waitForCommand(uuid, STEER_ADMITTED, CLAUDE_STEER_ACK_TIMEOUT_MS);
    if (state === "queued" || state === "started" || state === "completed") return true;
    if (state === undefined) {
      // Still owned by this turn's continuation/stop bookkeeping if it arrives late.
      if (native) this.reportNativeInput(native, "unknown", "no_admission_receipt");
      if (input.throwOnError) throw new Error("Claude did not acknowledge the steering message");
      return false;
    }
    worker.steerObservers.delete(uuid);
    return reject(state === "refused" ? "not_ready" : "stale");
  }

  /** The same native input asked again (a retry): report what is known, write nothing. */
  private async resumeNativeInput(worker: ClaudeWorker, entry: ClaudeNativeInput, observer: NativeInputObserver,
    reject: (reason: EngineSteeringRejectedError["reason"]) => false, throwOnError?: boolean): Promise<boolean> {
    entry.observer = observer;
    if (entry.reported) this.notifyNativeInput(entry);
    if (entry.rank < 1 && worker.control.commandState(entry.uuid) === "written") {
      await worker.control.waitForCommand(entry.uuid, STEER_ADMITTED, CLAUDE_STEER_ACK_TIMEOUT_MS);
    }
    // Withdrawn or dropped: no longer live, whatever was admitted before.
    if (entry.reported === "dropped" || entry.reported === "cancelled") return reject("stale");
    if (entry.rank >= 1) return true;
    if (throwOnError) throw new Error("Claude did not acknowledge the steering message");
    return false;
  }

  /** Native input controls this worker's CLI actually advertised; none before its init. */
  nativeInputCapability(sessionId: string): NativeInputCapability | undefined {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.retired || !worker.control.has(CLAUDE_MESSAGE_LIFECYCLE)) return undefined;
    return {
      sendNow: worker.control.has(CLAUDE_INTERRUPT_SEND_NOW),
      // cancel_async_message answers {cancelled} under the lifecycle contract.
      cancel: true,
      modelReceipt: worker.control.has(CLAUDE_REQUEST_MARKER_LISTS),
    };
  }

  /**
   * Send-now or withdrawal of one native input of this session's current
   * worker, named by the host id it was written with. Acts only while Claude
   * reports it still queued; never a Stop, never a process stop, never a
   * rewrite of its text. Results are Claude's own answers; a missing answer is
   * unknown, never assumed.
   */
  async controlNativeInput(sessionId: string, input: { inputId: string; action: NativeInputAction }): Promise<NativeInputControlResult> {
    const worker = this.workers.get(sessionId);
    const entry = worker && !worker.retired ? worker.nativeInputs.get(input.inputId) : undefined;
    if (!worker || !entry) return { outcome: "rejected", reason: "stale" };
    // An older CLI would treat interrupt{send_now} as a plain Stop.
    if (!worker.control.has(CLAUDE_MESSAGE_LIFECYCLE) || (input.action === "send-now" && !worker.control.has(CLAUDE_INTERRUPT_SEND_NOW))) {
      return { outcome: "rejected", reason: "unsupported" };
    }
    if (input.action === "cancel" && entry.withdrawn === "retracted" && entry.cancelConfirmed) return { outcome: "accepted", result: "cancelled" };
    // Claude acts only on a message it already holds.
    if (worker.control.commandState(entry.uuid) === "written") await worker.control.waitForCommand(entry.uuid, STEER_ADMITTED, CLAUDE_STEER_ACK_TIMEOUT_MS);
    if (this.workers.get(sessionId) !== worker || worker.retired || worker.nativeInputs.get(input.inputId) !== entry) return { outcome: "rejected", reason: "stale" };
    const state = worker.control.commandState(entry.uuid);
    // Claude has not acknowledged the input itself, so no control was written.
    // That is a definite "not done"; an unknown would be cached as this
    // request's final answer and the user could never retry it.
    if (state === undefined || state === "written") return { outcome: "rejected", reason: "stale" };
    // Already taken in (or ended): nothing is waiting to send now or withdraw.
    if (state !== "queued" || entry.rank >= 2) return { outcome: "rejected", result: "not_queued" };
    // A stop or an ended turn is already withdrawing it; one control at a time.
    if (worker.stopFence || entry.withdrawn || entry.retracting || entry.controlPending || this.destroyPromise) return { outcome: "rejected", reason: "stale" };
    // Send-now is only for the input's own running turn: never Claude's own
    // background review, nor a turn already waiting for this input to run next.
    if (input.action === "send-now" && (!entry.turn || entry.turn.nativeAdmission || worker.pendingTurn !== entry.turn || worker.taskNotificationTurnActive
      || worker.control.commandState(entry.turn.nativeCommand) !== "started")) return { outcome: "rejected", reason: "stale" };
    entry.controlPending = true;
    try {
      return input.action === "cancel" ? await this.retractNativeInput(worker, entry) : await this.sendNativeInputNow(worker, entry, entry.turn!);
    } finally {
      entry.controlPending = false;
    }
  }

  private async sendNativeInputNow(worker: ClaudeWorker, entry: ClaudeNativeInput, turn: PendingTurn): Promise<NativeInputControlResult> {
    // Marked before asking: Claude's cut of the running turn can precede its answer.
    const requested = (turn.sendNowRequested ??= new Set());
    requested.add(entry.uuid);
    // Nothing done for it: a later cut of the turn is not for this input.
    const unmark = () => { if (!entry.sendNowEffective) requested.delete(entry.uuid); };
    let response: Record<string, unknown>;
    try {
      response = await worker.control.request("interrupt", { send_now: true, message_uuid: entry.uuid }, CLAUDE_SEND_NOW_ACK_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ClaudeControlError && error.kind === "rejected") { unmark(); return nativeControlRejection(error); }
      entry.sendNowEffective = true;
      return { outcome: "unknown", reason: "uncertain" };
    }
    const result = response.send_now;
    if (result === "nothing_waiting") { unmark(); return { outcome: "accepted", result }; }
    entry.sendNowEffective = true;
    if (result === "delivering" || result === "stopped") return { outcome: "accepted", result };
    return { outcome: "unknown", reason: "uncertain" };
  }

  private async retractNativeInput(worker: ClaudeWorker, entry: ClaudeNativeInput): Promise<NativeInputControlResult> {
    entry.retracting = true;
    entry.cancelPending += 1;
    let response: Record<string, unknown>;
    try {
      response = await worker.control.request("cancel_async_message", { message_uuid: entry.uuid }, CLAUDE_CANCEL_ACK_TIMEOUT_MS);
    } catch (error) {
      entry.retracting = false;
      this.answerNativeWithdraw(worker, entry, false);
      return error instanceof ClaudeControlError && error.kind === "rejected" ? nativeControlRejection(error) : { outcome: "unknown", reason: "uncertain" };
    }
    entry.retracting = false;
    if (response.cancelled === true) {
      // Claude removed it from its queue: it never reaches the model.
      entry.withdrawn = "retracted";
      worker.steerObservers.delete(entry.uuid);
      this.answerNativeWithdraw(worker, entry, true);
      this.reportNativeInput(entry, "cancelled", "retracted");
      return { outcome: "accepted", result: "cancelled" };
    }
    this.answerNativeWithdraw(worker, entry, false);
    return response.cancelled === false ? { outcome: "rejected", result: "not_queued" } : { outcome: "unknown", reason: "uncertain" };
  }

  steeringCapability(): typeof CLAUDE_STEERING_CAPABILITY { return CLAUDE_STEERING_CAPABILITY; }

  /** Read the same native lifecycle that protects idle workers. Do not query
   * CLI state, start a turn, expire tasks or publish cards during a drain read. */
  hasPendingNativeWork(): boolean {
    if (this.pendingEventDeliveries) return true;
    for (const worker of new Set(this.workers.values())) {
      if (!worker.retired && this.workerHasPendingWork(worker)) return true;
    }
    return false;
  }

  private workerHasPendingWork(worker: ClaudeWorker): boolean {
    return Boolean(worker.pendingTurn || worker.continuationTurn || worker.stopFence
      || [...worker.backgroundTasks.keys()].some(taskId => !worker.finishedBackgroundTaskIds.has(taskId))
      || this.unstartedBackgroundCalls(worker).some(owner => Date.now() - owner.lastSeenAt < this.taskNotificationStartGraceMs)
      || this.taskNotificationTurnBusy(worker) || worker.queuedTaskNotifications.length
      || worker.taskNotificationWaiters.size || worker.scoped.hasPendingDeliveries());
  }

  /** True only when this session's live worker advertised the lifecycle contract. */
  supportsSessionSteering(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    return Boolean(worker && !worker.retired && worker.control.has(CLAUDE_MESSAGE_LIFECYCLE));
  }

  /** Live and recently ended native tasks of this session's worker. */
  async listTasks(sessionId: string): Promise<ClaudeEngineTaskSnapshot> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.retired) return { supported: true, tasks: [] };
    // Shared bound: every live task first, then the most recent ended ones.
    const live = worker.control.listTasks().slice(-128);
    const room = 128 - live.length;
    const ended = room > 0 ? worker.control.endedTasks().slice(-room) : [];
    const all = new Map<string, ClaudeNativeTask | ClaudeEndedTask>([...ended, ...live].map((task) => [task.taskId, task]));
    const owners = new Map<string, "bound" | "unattributed">();
    const ownerOf = (task: ClaudeNativeTask | ClaudeEndedTask, depth = 0): "bound" | "unattributed" => {
      const known = owners.get(task.taskId);
      if (known) return known;
      const tracked = worker.backgroundTasks.get(task.taskId);
      // A subagent's own tool calls belong to whoever owns that subagent.
      const parent = !tracked && task.parentTaskId && depth < 8 ? all.get(task.parentTaskId) : undefined;
      const owner = parent ? ownerOf(parent, depth + 1)
        : (tracked ? tracked.turnId !== undefined && Boolean(tracked.onEngineEvent) : !task.background && Boolean(this.activePendingTurn(worker))) ? "bound" : "unattributed";
      owners.set(task.taskId, owner);
      return owner;
    };
    const liveIds = new Set(live.map((task) => task.taskId));
    for (const [token, taskId] of worker.taskTokens) if (!all.has(taskId)) { worker.taskTokens.delete(token); worker.tokenByTask.delete(taskId); }
    const view = (task: ClaudeNativeTask | ClaudeEndedTask): ClaudeEngineTask => {
      const running = liveIds.has(task.taskId);
      const parent = task.parentTaskId && all.has(task.parentTaskId) ? this.taskToken(worker, task.parentTaskId) : undefined;
      return {
        id: this.taskToken(worker, task.taskId),
        label: task.description || task.subagentType || task.kind,
        kind: task.kind === "agent" ? "subagent" : task.kind === "bash" ? "shell" : "unknown",
        mode: task.background ? "background" : "foreground",
        status: running ? "running" : (task as ClaudeEndedTask).status,
        canStop: running,
        startedAt: task.startedAt,
        updatedAt: task.updatedAt,
        ...(task.progress ? { progress: task.progress } : {}),
        ...(parent ? { parentId: parent } : {}),
        owner: ownerOf(task),
      };
    };
    // What an App stop of the running turn also ends: the native interrupt ends
    // background subagents; the bounded process stop (no capability) ends all.
    const fence = worker.stopFence;
    return {
      supported: true,
      tasks: [...ended.map(view), ...live.map(view)],
      foregroundStopScope: this.softStopReady(worker) ? "subagents" : "all",
      ...(fence?.unconfirmed && fence.recoveryToken ? { recovery: { token: fence.recoveryToken, reason: "stop_unconfirmed" as const } } : {}),
    };
  }

  /** Native `stop_task` for one task token of this session's current worker.
   * Its completion notification keeps the existing owner-bound delivery path. */
  async stopTask(sessionId: string, input: { taskId: string }): Promise<ClaudeEngineTaskControlResult> {
    const worker = this.workers.get(sessionId);
    const taskId = worker && !worker.retired ? worker.taskTokens.get(input.taskId) : undefined;
    // Unknown, foreign, rebuilt-worker or already-ended tokens never reach Claude.
    if (!worker || !taskId || !worker.control.task(taskId)) return { outcome: "rejected", reason: "stale" };
    try {
      await worker.control.request("stop_task", { task_id: taskId }, CLAUDE_TASK_STOP_ACK_TIMEOUT_MS);
      return { outcome: "accepted" };
    } catch (error) {
      if (error instanceof ClaudeControlError && error.kind === "rejected") {
        if (/not supported|unknown|unrecognized/i.test(error.message)) return { outcome: "rejected", reason: "unsupported" };
        if (/is not running|already finished|been stopped|never this session|not found/i.test(error.message)) return { outcome: "rejected", reason: "stale" };
      }
      return { outcome: "unknown", reason: "uncertain" };
    }
  }

  /** Explicit forced cleanup: bounded process-tree stop; outstanding background
   * tasks are terminalized as interrupted by the worker's close handling. */
  /**
   * Explicit recovery from an unconfirmed stop. Only the exact token of this
   * session's current worker and its current unconfirmed fence is accepted, so
   * a stale token can never reach a replacement worker or a later fence.
   * `accepted` means the forced process-tree stop was issued, not that the
   * process has already exited; outstanding background tasks are then
   * terminalized as interrupted by the worker's close handling.
   */
  async recoverSession(sessionId: string, input: { token: string }): Promise<ClaudeEngineTaskControlResult> {
    const worker = this.workers.get(sessionId);
    const fence = worker && !worker.retired ? worker.stopFence : undefined;
    if (!worker || !fence?.unconfirmed || !fence.recoveryToken || fence.recoveryToken !== input.token) return { outcome: "rejected", reason: "stale" };
    this.forceStopWorker(worker);
    return { outcome: "accepted" };
  }

  async forceStopSession(sessionId: string): Promise<boolean> {
    const worker = this.workers.get(sessionId);
    if (!worker || worker.retired) return false;
    this.forceStopWorker(worker);
    return true;
  }

  private taskToken(worker: ClaudeWorker, taskId: string): string {
    let token = worker.tokenByTask.get(taskId);
    if (!token) {
      token = randomUUID();
      worker.tokenByTask.set(taskId, token);
      worker.taskTokens.set(token, taskId);
    }
    return token;
  }

  /**
   * Soft App stop. Claude must confirm it: the host turn settles when the
   * interrupted native turn's own terminal frames arrive (stopped, or too late
   * when it had already finished), or as unconfirmed after the window. The
   * worker, native session and background shells stay; nothing is killed to
   * make a stop look complete. Claude 2.1.307's own interrupt still ends
   * background subagents (`local_agent`), which then report their native
   * `stopped` state to their original owner.
   */
  private stopTurnSoftly(worker: ClaudeWorker, pending: PendingTurn, signal: AbortSignal | undefined): boolean {
    const held = worker.continuationTurn === pending;
    const queuedReviewInput = pending.nativeAdmission === true && !pending.nativeStarted;
    if ((signal?.reason !== APP_USER_STOP_REASON && !queuedReviewInput) || worker.retired || worker.stopFence
      || (worker.pendingTurn !== pending && !held)
      || !this.softStopReady(worker)) return false;
    if (held) {
      // The first native segment already answered; only the waiting addition is withdrawn.
      this.dropHeldContinuation(worker, pending, "stopped");
      return true;
    }
    const control = worker.control;
    // Interrupt only while this turn's own native turn runs; otherwise it
    // would stop whatever Claude runs at that moment (e.g. a background review).
    const live = control.commandState(pending.nativeCommand) === "started" || pending.nativeAdmission === true && pending.nativeStarted === true && worker.nativeTurnOpen;
    const commands = [pending.commandUuid, ...pending.steers ?? []].filter((uuid) => {
      const state = control.commandState(uuid);
      return live && uuid === pending.nativeCommand || state !== undefined && !isTerminalCommandState(state);
    });
    worker.pendingTurn = null;
    // Late frames of the stopped turn are never a model receipt.
    worker.nativeAwaitingReply.clear();
    // Approvals, host tool calls and timers of the stopped turn end now; its
    // promise settles with Claude's confirmation.
    this.clearPendingTurnTimeout(pending);
    this.markWorkerActivity(worker);
    for (const uuid of pending.steers ?? []) if (control.commandState(uuid) !== "started" && control.commandState(uuid) !== "completed") this.reportSteer(worker, uuid, { status: "dropped", reason: "stopped" });
    if (commands.length === 0 && !live) {
      // Nothing of this turn ever reached Claude.
      this.settleStoppedTurn(worker, pending, "stopped");
      return true;
    }
    this.installStopFence(worker, commands, live, pending);
    for (const uuid of commands) if (control.commandState(uuid) !== "started") this.withdrawCommand(worker, uuid);
    if (live) void this.interruptNative(worker, [pending.nativeCommand, ...pending.steers ?? []]);
    return true;
  }

  /** Both contracts the soft stop relies on, advertised by this process. */
  private softStopReady(worker: ClaudeWorker): boolean {
    return worker.control.has(CLAUDE_INTERRUPT_RECEIPT) && worker.control.has(CLAUDE_MESSAGE_LIFECYCLE);
  }

  private settleStoppedTurn(worker: ClaudeWorker, pending: PendingTurn, outcome: "stopped" | "too_late" | "unconfirmed"): void {
    worker.scoped.finishTurn(pending.turnId, outcome === "too_late" ? "done" : outcome === "stopped" ? "stopped" : "error");
    if (outcome !== "too_late") this.rememberInterruptedTurn(worker, pending);
    pending.reject(outcome === "stopped" ? new Error("Task was stopped by user")
      : outcome === "too_late" ? new EngineStopTooLateError() : new EngineCancellationUnconfirmedError());
  }

  private installStopFence(worker: ClaudeWorker, commands: Iterable<string>, openTurn: boolean, turn?: PendingTurn): void {
    const existing = worker.stopFence;
    if (existing) {
      for (const uuid of commands) {
        existing.ownedCommands.add(uuid);
        if (!isTerminalCommandState(worker.control.commandState(uuid))) existing.commands.add(uuid);
      }
      existing.openTurn ||= openTurn;
      return;
    }
    // A completed command may still own an open native turn. Keep its identity
    // for the result, but never wait for a second terminal lifecycle frame.
    const ownedCommands = new Set(commands);
    const waiting = new Set([...ownedCommands].filter(uuid => !isTerminalCommandState(worker.control.commandState(uuid))));
    const fence = { commands: waiting, ownedCommands, openTurn, unconfirmed: false, ...(turn ? { turn, command: turn.nativeCommand, nativeAdmission: turn.nativeAdmission } : {}) } as ClaudeStopFence;
    fence.done = new Promise<void>((resolve) => { fence.release = resolve; });
    fence.timer = setTimeout(() => {
      if (worker.stopFence !== fence) return;
      // Report it as unconfirmed; keep the turn isolated and every process alive.
      fence.unconfirmed = true;
      fence.recoveryToken = randomUUID();
      const stopped = fence.turn;
      fence.turn = undefined;
      if (stopped) this.settleStoppedTurn(worker, stopped, "unconfirmed");
    }, CLAUDE_STOP_CONFIRM_TIMEOUT_MS);
    fence.timer.unref?.();
    worker.stopFence = fence;
    this.maybeReleaseStopFence(worker);
  }

  private maybeReleaseStopFence(worker: ClaudeWorker): void {
    const fence = worker.stopFence;
    if (fence && fence.commands.size === 0 && !fence.openTurn) this.releaseStopFence(worker);
  }

  private releaseStopFence(worker: ClaudeWorker): void {
    const fence = worker.stopFence;
    if (!fence) return;
    worker.stopFence = undefined;
    if (fence.timer) clearTimeout(fence.timer);
    const stopped = fence.turn;
    fence.turn = undefined;
    if (stopped) this.settleStoppedTurn(worker, stopped, worker.retired ? "unconfirmed" : fence.tooLate ? "too_late" : "stopped");
    fence.release();
  }

  /** The next prompt never passes an open fence and is never written before
   * it opens. It waits — also past an unconfirmed stop, since it did not run
   * and must not be consumed as a failure — until Claude settles the fence or
   * an explicit recovery replaces the worker. Only its own abort ends the wait.
   * The stopped turn itself still settles as unconfirmed. */
  private async waitForStopFence(worker: ClaudeWorker, abortSignal?: AbortSignal): Promise<void> {
    while (worker.stopFence) {
      const fence = worker.stopFence;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(new Error("Task was stopped by user"));
        if (abortSignal?.aborted) { onAbort(); return; }
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        void fence.done.then(() => { abortSignal?.removeEventListener("abort", onAbort); resolve(); });
      });
    }
  }

  /** A stop of this session's live worker is still settling (any fence,
   * confirmed or not): new input would only wait. Never creates a worker. */
  isSessionInputBlocked(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    return Boolean(worker && !worker.retired && worker.stopFence);
  }

  /** Stops only the native turn opened by (or taking in) these own commands.
   * Claude spares any other turn, e.g. its own background review. A missing
   * or failed receipt leaves the fence to report the stop as unconfirmed. */
  private async interruptNative(worker: ClaudeWorker, commands: string[]): Promise<void> {
    const fence = worker.stopFence;
    let receipt: Record<string, unknown>;
    try {
      receipt = await worker.control.request("interrupt", { for_user_message_uuids: commands.slice(0, 8) }, CLAUDE_INTERRUPT_ACK_TIMEOUT_MS);
    } catch {
      return;
    }
    if (!fence || worker.stopFence !== fence) return;
    if (receipt.turn === "stopped") { fence.receiptStopped = true; fence.tooLate = false; }
    else if ((receipt.turn === "idle" || receipt.turn === "spared") && fence.turn && commands.includes(fence.command ?? "")) fence.tooLate = !fence.receiptStopped;
    // No cancel_queued: it would also drop uuid-less background task
    // notifications. Withdraw only this host's own commands that survived.
    if (!Array.isArray(receipt.still_queued)) return;
    for (const uuid of receipt.still_queued) if (typeof uuid === "string" && fence.commands.has(uuid)) this.withdrawCommand(worker, uuid);
  }

  private withdrawCommand(worker: ClaudeWorker, uuid: string, reason: "stopped" | "turn_failed" | "not_started" = "stopped"): void {
    const native = worker.nativeInputByUuid.get(uuid);
    if (native) { native.withdrawn ??= reason; native.cancelPending += 1; }
    void worker.control.request("cancel_async_message", { message_uuid: uuid }).then(
      (response) => { if (native) this.answerNativeWithdraw(worker, native, response.cancelled === true); },
      () => { if (native) this.answerNativeWithdraw(worker, native, false); },
    );
  }

  private forceStopWorker(worker: ClaudeWorker): void {
    if (worker.retired) return;
    killProcessTree(worker.child.pid, { graceMs: APP_STOP_PROCESS_GRACE_MS });
    this.failWorker(worker, new Error("Task was stopped by user"));
    this.removeWorker(worker);
  }

  /** Settled: its progress is final, so no control or later evidence needs it. */
  private nativeInputSettled(entry: ClaudeNativeInput): boolean {
    return entry.reported === "received" || entry.reported === "cancelled" || entry.reported === "dropped"
      || (entry.reported === "unknown" && entry.terminal === true);
  }

  private hasNativeInputRoom(worker: ClaudeWorker): boolean {
    return worker.nativeInputs.size < MAX_NATIVE_INPUTS || [...worker.nativeInputs.values()].some((entry) => this.nativeInputSettled(entry));
  }

  private registerNativeInput(worker: ClaudeWorker, observer: NativeInputObserver, uuid: string, turn: PendingTurn): ClaudeNativeInput {
    const entry: ClaudeNativeInput = { id: observer.id, uuid, observer, turn, rank: 0, cancelPending: 0 };
    worker.nativeInputs.set(entry.id, entry);
    worker.nativeInputByUuid.set(uuid, entry);
    // Only settled inputs are forgotten (hasNativeInputRoom guarantees one).
    while (worker.nativeInputs.size > MAX_NATIVE_INPUTS) {
      const oldest = [...worker.nativeInputs.values()].find((candidate) => this.nativeInputSettled(candidate));
      if (!oldest) break;
      worker.nativeInputs.delete(oldest.id);
      worker.nativeInputByUuid.delete(oldest.uuid);
      worker.nativeAwaitingReply.delete(oldest.uuid);
    }
    return entry;
  }

  /** A settled input keeps only its identity and last progress (for duplicate
   * checks and replay): its host turn and observer callbacks are released. */
  private releaseSettledNativeInput(entry: ClaudeNativeInput): void {
    if (!this.nativeInputSettled(entry)) return;
    entry.turn = undefined;
    entry.observer = { id: entry.id, onProgress: NO_PROGRESS };
  }

  /** Reports native evidence once, in order: queued < dequeued < received.
   * Cancelled and dropped are final and only possible before dequeueing;
   * received is never withdrawn; unknown yields to later evidence and is
   * reported again only when its reason changes. */
  private reportNativeInput(entry: ClaudeNativeInput, state: NativeInputState, reason?: string): void {
    const previous = entry.reported;
    if (previous === "cancelled" || previous === "dropped") return;
    const rank = NATIVE_INPUT_RANK[state];
    if (rank !== undefined) {
      if (rank <= entry.rank) return;
      entry.rank = rank;
    } else if (state === "unknown") {
      if (entry.rank >= 3) return;
      // A changed reason is news (published before the observer is released);
      // the same reason is not, and a process exit never replaces a known one.
      if (previous === "unknown" && (reason === entry.reason || reason === "engine_exit")) return;
    } else if (entry.rank >= 2) {
      // Taken in already: withdrawing it is impossible.
      return;
    }
    entry.reported = state;
    entry.reason = reason;
    this.notifyNativeInput(entry);
    this.releaseSettledNativeInput(entry);
  }

  private notifyNativeInput(entry: ClaudeNativeInput): void {
    if (!entry.reported) return;
    try { entry.observer.onProgress(entry.reason ? { state: entry.reported, reason: entry.reason } : { state: entry.reported }); }
    catch { /* observers cannot break the stream */ }
  }

  private observeNativeLifecycle(worker: ClaudeWorker, entry: ClaudeNativeInput, state: ClaudeCommandState): void {
    if (isTerminalCommandState(state)) {
      entry.terminal = true;
      entry.turn?.sendNowRequested?.delete(entry.uuid);
    }
    switch (state) {
      case "queued": this.reportNativeInput(entry, "queued"); break;
      case "started": entry.turn?.sendNowRequested?.delete(entry.uuid); this.reportNativeInput(entry, "dequeued"); break;
      case "completed":
        // The consuming turn ended cleanly. That is no evidence the model
        // received it (the CLI's own known gaps). An input that opened its own
        // turn ends after that turn's result, so without a receipt by now none
        // will come; a folded one ends before its turn's result, which decides
        // (observeNativeReceipt). An older CLI gives no receipt at all.
        entry.ended = true;
        if (entry.rank < 2 || (entry.rank === 2 && entry.resultSeen)) this.reportNativeInput(entry, "unknown", "ended_without_model_receipt");
        break;
      case "discarded": this.reportNativeInput(entry, entry.rank >= 2 ? "unknown" : "dropped", entry.rank >= 2 ? "interrupted_before_receipt" : "discarded"); break;
      case "refused": this.reportNativeInput(entry, "dropped", "refused"); break;
      case "cancelled":
        // Taken into a turn that was then cut or failed: it may remain in the
        // session's history although no reply to it began.
        if (entry.rank >= 2) this.reportNativeInput(entry, "unknown", "interrupted_before_receipt");
        else this.settleNativeWithdraw(worker, entry);
        break;
      default: break;
    }
    this.releaseSettledNativeInput(entry);
  }

  /** Only this host's own answered `cancelled:true` proves an input never ran;
   * otherwise its fate is unknown. Waits while an own withdrawal is unanswered. */
  private settleNativeWithdraw(worker: ClaudeWorker, entry: ClaudeNativeInput): void {
    if (entry.rank >= 2 || (!entry.cancelConfirmed && worker.control.commandState(entry.uuid) !== "cancelled")) return;
    const pending = entry.turn;
    if (entry.cancelConfirmed) {
      this.reportNativeInput(entry, entry.withdrawn === "retracted" ? "cancelled" : "dropped", entry.withdrawn ?? "cancelled");
      if (pending?.nativeAdmission && entry.uuid === pending.commandUuid && worker.pendingTurn === pending && !pending.nativeStarted) {
        worker.pendingTurn = null;
        this.clearPendingTurnTimeout(pending);
        pending.reject(new EngineNativeInputUnsentError("withdrawn"));
      }
    }
    else if (entry.cancelPending === 0) {
      this.reportNativeInput(entry, "unknown", entry.withdrawn ? "withdraw_unconfirmed" : "cancelled_unconfirmed");
      if (pending?.nativeAdmission && entry.uuid === pending.commandUuid && worker.pendingTurn === pending && !pending.nativeStarted) {
        worker.pendingTurn = null;
        this.clearPendingTurnTimeout(pending);
        pending.reject(new Error("Claude ended the pending input without confirming that the model received it."));
      }
    }
  }

  /** Claude answered (or failed to answer) one own cancel_async_message. */
  private answerNativeWithdraw(worker: ClaudeWorker, entry: ClaudeNativeInput, cancelled: boolean): void {
    entry.cancelPending = Math.max(0, entry.cancelPending - 1);
    if (cancelled) entry.cancelConfirmed = true;
    this.settleNativeWithdraw(worker, entry);
  }

  /** Model receipt, from `request_marker_lists_v1` evidence of the main
   * model's own reply on this worker (top-level frames only; subagent frames
   * are routed away earlier):
   * - an input that opened its turn is named on that turn's first reply
   *   (`user_message_uuid(s)` on a non-synthetic assistant message);
   * - an input folded into a running turn is never named on later replies
   *   (2.1.309 stamps a typed prompt's turn once). Requests are serial, so the
   *   uuids the latest `status "requesting"` announced are received when the
   *   reply to that request starts: a real `message_start` (an API message with
   *   a model) or a non-synthetic, non-error assistant message. A new request,
   *   a compaction, a result or a stop clears that link, so late frames never
   *   count; neither does dequeueing or the announcement alone.
   * - as a fallback, a successful result naming the input counts once a main
   *   model reply arrived after it was dequeued.
   * Without such evidence the input stays dequeued or becomes unknown. */
  private observeNativeReceipt(worker: ClaudeWorker, parsed: ClaudeStreamEvent): void {
    if (worker.nativeInputByUuid.size === 0) return;
    const markers = worker.control.has(CLAUDE_REQUEST_MARKER_LISTS);
    if (parsed.type === "system" && parsed.subtype === "status") {
      if (parsed.status === "requesting") {
        worker.nativeAwaitingReply.clear();
        if (markers) for (const uuid of markerList(parsed.user_message_uuids)) {
          const entry = worker.nativeInputByUuid.get(uuid);
          if (entry && entry.rank >= 1 && entry.rank < 3 && !this.nativeInputSettled(entry)) worker.nativeAwaitingReply.add(uuid);
        }
      } else if (parsed.status === "compacting") {
        // A compaction is not the model's reply to the input: one must follow it.
        worker.nativeAwaitingReply.clear();
        for (const entry of worker.nativeInputs.values()) if (entry.reported === "dequeued") entry.repliedAfterDequeue = false;
      }
      return;
    }
    if (parsed.type === "stream_event") {
      const event = parsed.event && typeof parsed.event === "object" ? parsed.event as { type?: unknown; message?: { id?: unknown; model?: unknown } } : undefined;
      const model = event?.message?.model;
      if (!markers || event?.type !== "message_start" || typeof event.message?.id !== "string" || typeof model !== "string" || !model || model === "<synthetic>") return;
      this.settleNativeAwaitingReply(worker);
      return;
    }
    if (parsed.type === "assistant") {
      if (!markers || parsed.error !== undefined || parsed.message?.model === "<synthetic>") return;
      for (const uuid of markerList(parsed.user_message_uuids, parsed.user_message_uuid)) this.markNativeReceived(worker, uuid);
      this.settleNativeAwaitingReply(worker);
      for (const entry of worker.nativeInputs.values()) if (entry.reported === "dequeued") entry.repliedAfterDequeue = true;
      return;
    }
    if (parsed.type !== "result") return;
    worker.nativeAwaitingReply.clear();
    // The end of the turn that holds each dequeued input decides the rest.
    const consumed = new Set(markerList(parsed.user_message_uuids));
    const success = parsed.is_error !== true && parsed.subtype === "success";
    for (const entry of [...worker.nativeInputs.values()]) {
      if (entry.reported !== "dequeued") continue;
      if (success && markers && consumed.has(entry.uuid) && entry.repliedAfterDequeue) this.reportNativeInput(entry, "received");
      else if (!success && consumed.has(entry.uuid)) this.reportNativeInput(entry, "unknown", "interrupted_before_receipt");
      // Folded: its `completed` came first, and this result shows no receipt.
      else if (entry.ended) this.reportNativeInput(entry, "unknown", "ended_without_model_receipt");
      else entry.resultSeen = true;
    }
  }

  /** The reply to the latest announced request started: its dequeued inputs are received. */
  private settleNativeAwaitingReply(worker: ClaudeWorker): void {
    for (const uuid of worker.nativeAwaitingReply) {
      const entry = worker.nativeInputByUuid.get(uuid);
      if (entry && entry.rank >= 2) this.reportNativeInput(entry, "received");
    }
    worker.nativeAwaitingReply.clear();
  }

  private markNativeReceived(worker: ClaudeWorker, uuid: string): void {
    const entry = worker.nativeInputByUuid.get(uuid);
    if (entry) this.reportNativeInput(entry, "received");
  }

  /** The process is gone: inputs without a final state have an unknown fate. */
  private finishNativeInputs(worker: ClaudeWorker): void {
    for (const entry of worker.nativeInputs.values()) this.reportNativeInput(entry, "unknown", entry.ended ? "ended_without_model_receipt" : "engine_exit");
    worker.nativeInputs.clear();
    worker.nativeInputByUuid.clear();
    worker.nativeAwaitingReply.clear();
  }

  /** A legacy observer or a native-input observer saw this steer's fate. */
  private reportSteerObserved(worker: ClaudeWorker, uuid: string, outcome: ClaudeSteerOutcome): boolean {
    const native = worker.nativeInputByUuid.get(uuid);
    if (native?.retracting || native?.withdrawn === "retracted") {
      // The user withdrew it; its own receipt says so.
      worker.steerObservers.delete(uuid);
      return true;
    }
    return this.reportSteer(worker, uuid, outcome) || native !== undefined;
  }

  /** Claude cut this turn for a send-now input that still waits (an interrupt
   * with send_now that it answered `stopped`, or its later fallback). That
   * input runs next and continues this host turn; it is not a failure. */
  private isSendNowCut(worker: ClaudeWorker, pending: PendingTurn, parsed: ClaudeStreamEvent): boolean {
    const requested = pending.sendNowRequested;
    if (!requested?.size || typeof parsed.terminal_reason !== "string" || !parsed.terminal_reason.startsWith("aborted")) return false;
    return this.unfoldedSteers(worker, pending).some((uuid) => requested.has(uuid));
  }

  /** A blocking call of the running foreground turn that Claude moved to the
   * background (send-now, or the Ctrl+B equivalent): it keeps that turn as
   * its owner, exactly like an explicit run_in_background call. */
  private adoptBackgroundedCall(worker: ClaudeWorker, toolUseId: string | undefined, taskId: string | undefined): void {
    const pending = worker.pendingTurn;
    if (!toolUseId || !taskId || !pending || worker.taskNotificationTurnActive || worker.backgroundTasks.has(taskId)
      || !pending.outstandingToolUseIds.has(toolUseId)) return;
    if (!worker.explicitBackgroundToolUseIds.has(toolUseId)) {
      this.rememberBackgroundTool(worker, toolUseId, { inputOwnerKey: pending.inputOwnerKey, turnId: pending.turnId, onEngineEvent: pending.onEngineEvent, onApprovalRequest: pending.onApprovalRequest, lastSeenAt: Date.now() });
    }
    const summary = worker.control.task(taskId)?.description;
    this.trackBackgroundTask(worker, { taskId, toolUseId, ...(summary ? { summary } : {}) });
  }

  /** Calls a steer's observer once; false when nobody observes it. */
  private reportSteer(worker: ClaudeWorker, uuid: string, outcome: ClaudeSteerOutcome): boolean {
    const observer = worker.steerObservers.get(uuid);
    if (!observer) return false;
    worker.steerObservers.delete(uuid);
    try { observer(outcome); } catch { /* observers cannot break the stream */ }
    return true;
  }

  private handleCommandLifecycle(worker: ClaudeWorker, uuid: string, state: ClaudeCommandState): void {
    const native = worker.nativeInputByUuid.get(uuid);
    const completing = worker.pendingTurn;
    if (state === "completed" && completing?.nativeAdmission && completing.nativeCommand === uuid && !completing.nativeStarted) {
      this.startReviewInput(worker, completing);
    }
    if (native) this.observeNativeLifecycle(worker, native, state);
    const fence = worker.stopFence;
    if (fence?.commands.has(uuid)) {
      if (state === "started" && !fence.openTurn && (!worker.taskNotificationTurnActive || fence.nativeAdmission)) {
        // A withdrawn prompt or steer still reached Claude as its own turn.
        fence.openTurn = true;
        if (fence.nativeAdmission) { if (fence.turn) fence.turn.nativeStarted = true; this.adoptReviewForTurn(worker, fence.turn); }
        void this.interruptNative(worker, [uuid]);
      }
      if (isTerminalCommandState(state)) fence.commands.delete(uuid);
      this.maybeReleaseStopFence(worker);
      return;
    }
    const live = worker.pendingTurn;
    if (live?.nativeAdmission && live.nativeCommand === uuid && !live.nativeStarted && isTerminalCommandState(state) && state !== "completed"
      && !(state === "cancelled" && native && native.cancelPending > 0)) {
      // No native turn started for this input. Its terminal lifecycle must
      // release the host slot without taking down the unrelated review.
      worker.pendingTurn = null;
      this.clearPendingTurnTimeout(live);
      live.reject(state === "refused" || state === "discarded" ? new EngineNativeInputUnsentError("not_admitted")
        : new Error("Claude ended the pending input without confirming that the model received it."));
      return;
    }
    if (live?.nativeAdmission && live.nativeCommand === uuid && (state === "started" || state === "completed")) {
      this.startReviewInput(worker, live);
      return;
    }
    if (live?.steers?.has(uuid)) {
      // Taken in at the running turn's next model request.
      if (state === "started") this.reportSteer(worker, uuid, { status: "applied", via: "fold" });
      return;
    }
    const held = worker.continuationTurn;
    const continuation = held?.continuation;
    if (!held || !continuation?.awaiting.has(uuid)) return;
    if (state === "started") {
      continuation.awaiting.delete(uuid);
      if (worker.taskNotificationTurnActive) {
        // Absorbed by Claude's own review turn, which this host turn does not own.
        if (!this.reportSteerObserved(worker, uuid, { status: "absorbed" })) continuation.dropped += 1;
        if (continuation.awaiting.size === 0) this.settleHeldContinuation(worker, held);
        return;
      }
      if (continuation.timer) clearTimeout(continuation.timer);
      continuation.timer = undefined;
      worker.continuationTurn = undefined;
      held.nativeCommand = uuid;
      worker.pendingTurn = held;
      this.reportSteer(worker, uuid, { status: "applied", via: "continuation" });
      this.markWorkerActivity(worker);
      return;
    }
    if (isTerminalCommandState(state)) {
      continuation.awaiting.delete(uuid);
      if (!this.reportSteerObserved(worker, uuid, { status: "dropped", reason: "not_started" })) continuation.dropped += 1;
      if (continuation.awaiting.size === 0) this.settleHeldContinuation(worker, held);
    }
  }

  private unfoldedSteers(worker: ClaudeWorker, pending: PendingTurn): string[] {
    return [...pending.steers ?? []].filter((uuid) => {
      const state = worker.control.commandState(uuid);
      return state === "written" || state === "queued";
    });
  }

  /** Queued steers of a turn that ended without continuing are withdrawn
   * behind a fence: the next prompt waits until none can start as an unowned
   * turn, and one that still starts is interrupted. Returns unobserved drops. */
  private abandonSteers(worker: ClaudeWorker, uuids: string[], reason: Extract<ClaudeSteerOutcome, { status: "dropped" }>["reason"]): number {
    if (uuids.length === 0) return 0;
    let unobserved = 0;
    for (const uuid of uuids) if (!this.reportSteerObserved(worker, uuid, { status: "dropped", reason })) unobserved += 1;
    this.installStopFence(worker, uuids, false);
    for (const uuid of uuids) this.withdrawCommand(worker, uuid, reason === "engine_exit" ? "stopped" : reason);
    return unobserved;
  }

  private abandonUnfoldedSteers(worker: ClaudeWorker, pending: PendingTurn): void {
    this.abandonSteers(worker, this.unfoldedSteers(worker, pending), "turn_failed");
  }

  private holdForSteerContinuation(worker: ClaudeWorker, pending: PendingTurn, text: string, usage: Promise<AdapterUsage | undefined>, missed: string[], dropped: number): void {
    if (pending.timeout) { clearTimeout(pending.timeout); pending.timeout = undefined; }
    this.clearBackgroundTaskTurnSettlement(pending);
    pending.continuation = { text, usage, awaiting: new Set(missed), dropped };
    pending.assistantText = "";
    pending.intermediateDeliveryText = "";
    pending.partialText = undefined;
    pending.partialThinking = undefined;
    pending.lastAssistantWasNoResponsePlaceholder = false;
    worker.continuationTurn = pending;
    const timer = setTimeout(() => this.dropHeldContinuation(worker, pending, "not_started"), CLAUDE_STEER_CONTINUATION_START_MS);
    timer.unref?.();
    pending.continuation.timer = timer;
  }

  /** Settles a held turn with its finished first segment and withdraws the
   * additions still waiting for their own native turn. */
  private dropHeldContinuation(worker: ClaudeWorker, pending: PendingTurn, reason: "stopped" | "not_started" | "engine_exit", withdraw = true): void {
    const continuation = pending.continuation;
    if (worker.continuationTurn !== pending || !continuation) return;
    const waiting = [...continuation.awaiting];
    continuation.awaiting.clear();
    if (!withdraw) {
      for (const uuid of waiting) if (!this.reportSteerObserved(worker, uuid, { status: "dropped", reason })) continuation.dropped += 1;
    } else {
      continuation.dropped += this.abandonSteers(worker, waiting, reason);
    }
    this.settleHeldContinuation(worker, pending);
  }

  private settleHeldContinuation(worker: ClaudeWorker, pending: PendingTurn): void {
    const continuation = pending.continuation;
    if (worker.continuationTurn === pending) worker.continuationTurn = undefined;
    if (!continuation) return;
    if (continuation.timer) clearTimeout(continuation.timer);
    // The held segment's cost was never baselined; the next recorded result
    // charges it, so nothing is lost or counted twice.
    const text = continuation.cut ? withInterruptedAnswerNotice(continuation.text, pending.locale) : continuation.text;
    this.settleTurnSuccess(worker, pending, text, continuation.usage, continuation.dropped);
  }

  private settleTurnSuccess(worker: ClaudeWorker, pending: PendingTurn, text: string, usage: Promise<AdapterUsage | undefined>, dropped: number): void {
    this.clearPendingTurnTimeout(pending);
    const eventText = withDroppedSteerNotice(text, dropped, pending.locale);
    if (worker.currentSessionId) this.turnRecovery.clear(worker.currentSessionId, worker.workspacePath);
    this.emitEngineEvent(worker, { type: "result", text: eventText, sessionId: worker.currentSessionId ?? undefined }, pending.onEngineEvent);
    const finalText = eventText.trim() || (pending.locale === "zh" ? "Claude 本轮已结束，未返回文字回复。" : "Claude ended this turn without a text reply.");
    const sessionId = worker.currentSessionId ?? undefined;
    void usage.then((value) => pending.resolve({ text: finalText, sessionId, usage: value }), () => pending.resolve({ text: finalText, sessionId }));
  }

  private writeJson(worker: ClaudeWorker, payload: unknown): void {
    if (worker.retired) return;
    this.markWorkerActivity(worker);
    worker.child.stdin?.write(JSON.stringify(payload) + "\n", (error) => {
      if (error) {
        this.failWorker(worker, error);
        killProcessTree(worker.child.pid);
        this.removeWorker(worker);
      }
    });
  }

  private emitEngineEvent(
    worker: ClaudeWorker,
    event: EngineStreamEvent,
    handlerOverride?: (event: EngineStreamEvent) => void | Promise<void>,
  ): Promise<void> {
    const handler = handlerOverride ?? this.activePendingTurn(worker)?.onEngineEvent ?? worker.onEngineEvent;
    if (!handler) {
      return Promise.resolve();
    }

    this.pendingEventDeliveries++;
    try {
      return Promise.resolve(handler(event)).catch(() => undefined)
        .finally(() => { this.pendingEventDeliveries--; });
    } catch {
      this.pendingEventDeliveries--;
      // Event delivery is best-effort; it must not break the engine turn.
      return Promise.resolve();
    }
  }

  destroy(): Promise<void> {
    if (!this.destroyPromise) {
      // Publish the shared promise before cleanup invokes any event handler;
      // a handler that re-enters destroy() must join this same shutdown.
      this.destroyPromise = Promise.resolve().then(() => this.destroyInternal());
    }
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
    }
    const deliveries: Array<Promise<void>> = [];
    const workers = [...new Set(this.workers.values())];
    this.workers.clear();
    for (const worker of workers) {
      this.rejectTaskNotificationWaiters(worker, new Error("Adapter destroyed"));
      if (worker.pendingTurn) {
        this.rememberInterruptedTurn(worker, worker.pendingTurn);
        this.clearPendingTurnTimeout(worker.pendingTurn);
        worker.pendingTurn.reject(new Error("Adapter destroyed"));
        worker.pendingTurn = null;
      }
      const held = worker.continuationTurn;
      if (held) {
        if (held.continuation?.timer) clearTimeout(held.continuation.timer);
        worker.continuationTurn = undefined;
        this.clearPendingTurnTimeout(held);
        for (const uuid of held.steers ?? []) this.reportSteer(worker, uuid, { status: "dropped", reason: "engine_exit" });
        held.reject(new Error("Adapter destroyed"));
      }
      // failBackgroundTasks clears its in-memory records before its first await,
      // so the ensuing child close cannot emit duplicate terminal events.
      deliveries.push(this.failBackgroundTasks(worker));
      killProcessTree(worker.child.pid);
      this.removeWorker(worker);
    }
    await Promise.allSettled([...deliveries, ...[...this.sideProcesses].map((side) => side.dispose())]);
    await this.turnRecovery.flush();
    await this.sessionUsage.flush();
  }

  private markWorkerActivity(worker: ClaudeWorker): void {
    worker.lastActivityAt = Date.now();
    // Any byte from the worker (stdout event, stderr line, our own write) proves
    // the CLI is alive, so the inactivity watchdog restarts from zero.
    this.armTurnInactivityWatchdog(worker);
  }

  /**
   * (Re)arms the per-turn INACTIVITY watchdog. Fires only when the worker has been
   * completely silent for turnInactivityTimeoutMs, in which case the CLI is wedged:
   * kill it and reject the turn with a message the failure classifier maps to
   * `engine-timeout` ("turn became inactive after N minutes"), so the user is told
   * the turn stalled and how to lift the cap instead of "restart the instance".
   */
  private armTurnInactivityWatchdog(worker: ClaudeWorker): void {
    const pending = worker.pendingTurn;
    const timeoutMs = this.turnInactivityTimeoutMs;
    if (!pending || pending.inactivityTimeoutDisabled || timeoutMs === null || timeoutMs <= 0) {
      return;
    }
    // Even a missing admission receipt cannot prove that the review's long
    // silent tool is wedged. Keep the input uncertain, owned and cancellable;
    // only its own native started event arms a foreground watchdog.
    if (pending.nativeAdmission && !pending.nativeStarted) return;

    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }

    pending.timeout = setTimeout(() => {
      pending.timeout = undefined;
      if (worker.pendingTurn !== pending) {
        return;
      }

      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      const error = new Error(
        `Claude turn became inactive after ${minutes} minutes with no engine output; the wedged CLI was stopped. Send /timeout off before a genuinely long silent task.`,
      );
      killProcessTree(worker.child.pid);
      this.failWorker(worker, error);
      this.removeWorker(worker);
    }, timeoutMs);
    pending.timeout.unref?.();
  }

  private reapIdleWorkers(): void {
    const now = Date.now();
    const seen = new Set<ClaudeWorker>();
    for (const worker of this.workers.values()) {
      if (seen.has(worker)) {
        continue;
      }
      seen.add(worker);
      this.advanceTaskNotificationQueue(worker);
      this.pruneExpiredBackgroundTasks(worker, now);
      if (this.workerHasPendingWork(worker)) {
        continue;
      }
      if (now - worker.lastActivityAt < this.idleWorkerTtlMs) {
        continue;
      }
      killProcessTree(worker.child.pid);
      this.removeWorker(worker);
    }
  }

  private pruneExpiredBackgroundTasks(worker: ClaudeWorker, now: number): void {
    if (this.backgroundTaskMaxAgeMs <= 0) {
      return;
    }

    for (const [callId, owner] of worker.backgroundToolOwners) {
      if (now - owner.lastSeenAt >= this.backgroundTaskMaxAgeMs && ![...worker.backgroundTasks.values()].some(task => task.toolUseId && backgroundCallKey(task.toolUseId, task.parentToolUseId) === callId)) {
        worker.backgroundToolOwners.delete(callId); worker.explicitBackgroundToolUseIds.delete(callId);
      }
    }
    let prunedPendingTaskNotification = false;
    for (const [taskId, task] of worker.backgroundTasks.entries()) {
      if (now - task.lastSeenAt >= this.backgroundTaskMaxAgeMs) {
        worker.scoped.finishTask(taskId);
        if (task.reviewScope) void worker.scoped.finish(task.reviewScope, "unknown");
        worker.backgroundTasks.delete(taskId);
        if (worker.pendingTaskNotification?.taskId === taskId) {
          prunedPendingTaskNotification = true;
        }
        if (task.toolUseId) {
          worker.explicitBackgroundToolUseIds.delete(backgroundCallKey(task.toolUseId, task.parentToolUseId));
          worker.backgroundToolOwners.delete(backgroundCallKey(task.toolUseId, task.parentToolUseId));
        }
        // Emit a terminal notification so the timeline pair settles (the
        // restart busy-guard would otherwise block restarts until ITS stale
        // cutoff) — but SUPPRESSED: six silent hours with a live worker means
        // the result was almost always consumed in-turn (TaskOutput), where
        // the CLI never sends an out-of-band completion. The first real-world
        // firing produced only false "failed" alarms for succeeded gates.
        this.emitEngineEvent(worker, {
          type: "task_notification",
          origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed",
          ...(task.reviewScope ? { scopeId: task.reviewScope.scope.id } : {}),
          text: `${task.summary ?? "Background task"} produced no completion notification for ${Math.round(this.backgroundTaskMaxAgeMs / 3_600_000)}h and was settled quietly.`,
          sessionId: worker.currentSessionId ?? undefined,
          taskId: task.taskId,
          status: "unknown",
          suppressUserDelivery: true,
          ...(task.summary ? { summary: task.summary } : {}),
        }, task.onEngineEvent);
      }
    }

    const pendingTaskNotification = worker.pendingTaskNotification;
    const untrackedPendingExpired = Boolean(
      pendingTaskNotification
      && now - pendingTaskNotification.lastSeenAt >= this.backgroundTaskMaxAgeMs
      && (
        !pendingTaskNotification.taskId
        || !worker.backgroundTasks.has(pendingTaskNotification.taskId)
      ),
    );
    if (untrackedPendingExpired && !prunedPendingTaskNotification && pendingTaskNotification) {
      if (pendingTaskNotification.reviewScope) void worker.scoped.finish(pendingTaskNotification.reviewScope, "unknown");
      if (pendingTaskNotification.toolUseId) {
        worker.explicitBackgroundToolUseIds.delete(backgroundCallKey(pendingTaskNotification.toolUseId, pendingTaskNotification.parentToolUseId));
        worker.backgroundToolOwners.delete(backgroundCallKey(pendingTaskNotification.toolUseId, pendingTaskNotification.parentToolUseId));
      }
      this.emitEngineEvent(worker, {
        type: "task_notification",
        origin: pendingTaskNotification.turnId !== undefined ? "bound" : "unattributed",
        ...(pendingTaskNotification.reviewScope ? { scopeId: pendingTaskNotification.reviewScope.scope.id } : {}),
        text: `${pendingTaskNotification.summary ?? "Background task review"} produced no terminal result before the safety timeout and was settled quietly.`,
        sessionId: worker.currentSessionId ?? undefined,
        taskId: pendingTaskNotification.taskId,
        status: "unknown",
        suppressUserDelivery: true,
        ...(pendingTaskNotification.summary ? { summary: pendingTaskNotification.summary } : {}),
      }, pendingTaskNotification.onEngineEvent);
    }

    if (prunedPendingTaskNotification || untrackedPendingExpired) {
      reportAnswerProgress(worker.pendingTaskNotification, { phase: "unknown" });
      worker.pendingTaskNotification = null;
      worker.suppressNextTaskNotificationAssistant = false;
      worker.taskNotificationTurnActive = false;
      worker.taskNotificationAssistantText = "";
      worker.taskNotificationDeliveryText = "";
      this.resolveTaskNotificationWaiters(worker);
    }
  }

  private failWorker(worker: ClaudeWorker, error: Error): void {
    worker.side?.failAll(new ClaudeSideChannelClosedError());
    worker.control.close(error);
    const held = worker.continuationTurn;
    if (held) this.dropHeldContinuation(worker, held, "engine_exit", false);
    for (const uuid of worker.pendingTurn?.steers ?? []) this.reportSteer(worker, uuid, { status: "dropped", reason: "engine_exit" });
    this.finishNativeInputs(worker);
    this.releaseStopFence(worker);
    reportAnswerProgress(worker.pendingTaskNotification, { phase: "interrupted" });
    this.rejectTaskNotificationWaiters(worker, error);
    if (worker.pendingTurn) {
      const pending = worker.pendingTurn;
      this.rememberInterruptedTurn(worker, pending);
      worker.scoped.finishTurn(pending.turnId, "error");
      worker.pendingTurn = null;
      this.clearPendingTurnTimeout(pending);
      pending.reject(pending.engineWarnings.length > 0
        ? Object.assign(new Error(appendClaudeMcpWarnings(error.message, pending.engineWarnings)), { name: error.name })
        : error);
    }
  }

  private rememberInterruptedTurn(worker: ClaudeWorker, pending: PendingTurn): void {
    if (!worker.currentSessionId || !pending.promptWritten || pending.observedToolCalls === 0) return;
    this.turnRecovery.remember(worker.currentSessionId, worker.workspacePath, {
      startedAt: pending.startedAt, stoppedAt: Date.now(), toolCalls: pending.observedToolCalls,
      toolResults: pending.observedToolResults, pendingTools: [...pending.pendingToolNames.values()],
    });
  }

  private clearPendingTurnTimeout(pending: PendingTurn | null | undefined): void {
    this.clearBackgroundTaskTurnSettlement(pending);
    pending?.approvalAbortController.abort();
    if (pending?.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
      pending.abortHandler = undefined;
    }
    if (pending?.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
  }

  /**
   * Terminalize outstanding background tasks when their worker dies (parity
   * with the Kimi adapter): the CLI process that would deliver the completion
   * notification is gone, so without this the timeline pair stays open — the
   * user never learns the task died, and the restart busy-guard blocks
   * service restarts until the 6h stale cutoff (the ccfcc1 astock incident).
   */
  private async failBackgroundTasks(worker: ClaudeWorker): Promise<void> {
    reportAnswerProgress(worker.pendingTaskNotification, { phase: "interrupted" });
    // Queued cross-turn notifications reference tasks terminalized right here;
    // installing one later would resurrect a pending review on a dead worker.
    worker.queuedTaskNotifications = [];
    const scopeClose = worker.scoped.close();
    if (worker.backgroundTasks.size === 0) {
      await this.settleShutdownDeliveries([scopeClose]);
      return;
    }
    const deliveries: Array<Promise<void>> = [scopeClose];
    const now = Date.now();
    for (const task of worker.backgroundTasks.values()) {
      // A task that has been silent for over an hour was almost always
      // consumed in-turn already (no out-of-band completion ever comes for
      // those) — settle its pairing quietly instead of alarming the user.
      // A recently-active task killed mid-run stays visible: that is a real
      // interruption worth reporting.
      const silentMs = now - task.lastSeenAt;
      const suppressAfterMs = this.backgroundTaskSilentSuppressMs;
      const terminalObserved = Boolean(task.taskId && worker.finishedBackgroundTaskIds.has(task.taskId));
      const status = terminalObserved ? task.status ?? "unknown" : "interrupted";
      deliveries.push(this.emitEngineEvent(worker, {
        type: "task_notification",
        origin: task.turnId !== undefined && task.onEngineEvent ? "bound" : "unattributed",
        ...(task.reviewScope ? { scopeId: task.reviewScope.scope.id } : {}),
        reason: terminalObserved ? "no_result" : "engine_exit",
        text: terminalObserved
          ? `${task.summary ?? "Background task"}: ${status}; completion was observed and no separate review remained when the worker closed.`
          : `${task.summary ?? "Background task"} stopped because the Claude engine process exited before completion.`,
        sessionId: worker.currentSessionId ?? undefined,
        taskId: task.taskId,
        status,
        ...(terminalObserved || silentMs >= suppressAfterMs ? { suppressUserDelivery: true } : {}),
        ...(task.summary ? { summary: task.summary } : {}),
        ...(task.outputFile ? { outputFile: task.outputFile } : {}),
      }, task.onEngineEvent));
    }
    worker.backgroundTasks.clear();
    worker.finishedBackgroundTaskIds.clear();
    worker.taskOutputToolUseIds.clear();
    worker.explicitBackgroundToolUseIds.clear();
    worker.backgroundToolOwners.clear();
    worker.pendingTaskNotification = null;
    worker.suppressNextTaskNotificationAssistant = false;
    worker.taskNotificationTurnActive = false;
    worker.taskNotificationAssistantText = "";
    worker.taskNotificationDeliveryText = "";
    await this.settleShutdownDeliveries(deliveries);
  }

  private async settleShutdownDeliveries(deliveries: Promise<void>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled(deliveries), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private removeWorker(worker: ClaudeWorker): void {
    worker.side?.failAll(new ClaudeSideChannelClosedError());
    worker.control.close(new Error("Claude worker removed"));
    this.finishNativeInputs(worker);
    this.releaseStopFence(worker);
    reportAnswerProgress(worker.pendingTaskNotification, { phase: "interrupted" });
    if (!worker.retired) {
      worker.retired = true;
      // Scope observers bypass emitEngineEvent. Retain their existing aggregate
      // delivery after deleting the worker, including already-closed final cards.
      // Do not use the bounded shutdown wait: natural CLI close must not let a
      // graceful Host drain overtake persistence that is still in progress.
      this.pendingEventDeliveries++;
      try {
        void worker.scoped.close().catch(() => undefined)
          .finally(() => { this.pendingEventDeliveries--; });
      } catch { this.pendingEventDeliveries--; }
    }
    worker.appMcp?.close();
    for (const [key, candidate] of this.workers.entries()) {
      if (candidate === worker) {
        this.workers.delete(key);
      }
    }
    void worker.instructionsFile?.cleanup().catch(() => {});
    void worker.appMcpConfigFile?.cleanup().catch(() => {});
  }
}
