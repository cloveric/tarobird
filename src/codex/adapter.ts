import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver } from "../client-protocol/native-input.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import type { RunScope } from "../client-protocol/run.js";
import type { Locale } from "../runtime/locale.js";
import type { EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";
import type { EngineOverride } from "../state/instance-config.js";
import type { ClaudeNativeGoalReceipt, ClaudeNativeGoalUpdate } from "./claude-native-goal.js";
import type { EngineQuotaReadOptions, EngineQuotaReadResult } from "./adapter-account-quota.js";
export type { EngineQuotaReadOptions, EngineQuotaReadResult } from "./adapter-account-quota.js";
export type { EngineTask, EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";

/** A terminal frame arrived without a complete answer. Never blindly replay tools. */
export class EngineIncompleteResponseError extends Error {
  constructor(message: string, readonly reason: "placeholder" | "interrupted" = "placeholder",
    /** Set only from an engine's terminal request error, never tools or stderr. */
    readonly requestRejection?: "invalid-argument",
    /** Set only by an adapter whose native history can rewind this conversation
     * to before an earlier input (Codex app-server); never for side turns. */
    readonly nativeRewind?: boolean,
  ) { super(message); this.name = "EngineIncompleteResponseError"; }
}

/** Codex reported an unavailable model in a failed native turn. */
export class CodexModelUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "CodexModelUnavailableError"; }
}

/** A local native history mutation excludes ordinary input until it settles. */
export class EngineHistoryBusyError extends Error {
  constructor() { super("Native conversation history operation is still in progress"); this.name = "EngineHistoryBusyError"; }
}

/** A stop request was sent, but the engine did not confirm that work stopped. */
export class EngineCancellationUnconfirmedError extends Error {
  constructor(options?: ErrorOptions, readonly reason?: "goal-active" | "merged" | "runtime-deadline" | "tool-recovery") {
    super("Engine cancellation could not be confirmed", options);
    this.name = "EngineCancellationUnconfirmedError";
  }
}

/** Preventive context compaction has no confirmed result. The original session
 * is preserved and still owned by that operation; nothing was replaced. */
export class EngineContextCompactionPendingError extends Error {
  constructor(message: string, readonly state: "timed-out" | "waiting" | "recovering", readonly limitMs: number) {
    super(message); this.name = "EngineContextCompactionPendingError";
  }
}

export class EngineStopTooLateError extends Error {
  constructor() { super("Engine turn finished before the stop request arrived"); this.name = "EngineStopTooLateError"; }
}

/** A native input definitely never entered the model; the input receipt owns
 * its UI, so Core must remove its unused reply card instead of posting an error. */
export class EngineNativeInputUnsentError extends Error {
  constructor(readonly reason: "not_admitted" | "withdrawn") {
    super(`Native input was not sent: ${reason}`); this.name = "EngineNativeInputUnsentError";
  }
}

/** A native steering guard refused the instruction before admission. */
export class EngineSteeringRejectedError extends Error {
  constructor(readonly reason: "queued" | "stale" | "not_ready" | "unsupported") {
    super(`Engine steering rejected: ${reason}`); this.name = "EngineSteeringRejectedError";
  }
}

export interface CodexSessionHandle {
  sessionId: string;
}

export interface ExternalSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface AdapterUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
}

const FAILED_TURN_USAGE = Symbol.for("tarobird.failedTurnUsage");
/**
 * Attach what the engine already reported for model calls of a turn that then
 * failed, was stopped or lost its process. The Host records it as it records a
 * completed turn's usage; it says nothing about the outcome and replays nothing.
 */
export function withFailedTurnUsage<T>(error: T, usage: AdapterUsage | undefined): T {
  // All zero is a request that was refused or aborted before anything was billed (Pi zeroes a provider error's
  // usage): it is not a metered request and is not counted as one.
  const billed = usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || (usage.cachedTokens ?? 0) > 0 || (usage.costUsd ?? 0) > 0);
  if (billed && error && typeof error === "object") Object.defineProperty(error, FAILED_TURN_USAGE, { value: { ...usage }, enumerable: false, configurable: true });
  return error;
}
/** The usage attached by `withFailedTurnUsage`, also when a wrapper keeps the engine error as its cause. */
export function failedTurnUsage(error: unknown): AdapterUsage | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const usage = (current as { [FAILED_TURN_USAGE]?: AdapterUsage })[FAILED_TURN_USAGE];
    if (usage) return usage;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface EngineContextUsage {
  /** Provider-reported prompt size for the most recent request. */
  pressureTokens?: number;
  /** Estimated prompt size for the next request after surface changes. */
  projectedTokens?: number;
  contextWindow?: number;
  /** Where the engine compacts by itself, when it reports that. */
  autoCompactTokens?: number;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
  usage?: AdapterUsage;
  /** Claude's native command/stream evidence; an ended turn is not goal success. */
  nativeGoal?: ClaudeNativeGoalReceipt;
}

/** What an adapter's native side conversation can honestly promise. An engine
 * without verified native context and reliable cleanup reports `none`; a fresh
 * session is never presented as a side conversation. */
export interface SideCapability {
  context: "native" | "none";
  /** Can run while the parent turn is still active, without waiting for it. */
  concurrent: boolean;
  /** enforced: the engine blocks writes; no-tools: the side cannot call tools. */
  readOnly: "enforced" | "no-tools" | "advisory";
  /** Opt-in native side with the Bot's tools and permissions, not a read-only sandbox. */
  toolAccess?: "inherited";
  /** Can route inherited native App file tools to this side's own receiver. */
  delivery?: true;
  /** Native residue after dispose(): none, deleted-on-close, or residual. */
  residue: "none" | "deleted-on-close" | "residual";
  /** Whether native context includes the parent's in-progress turn. */
  seesInProgressTurn: boolean;
  /** Side attachments the engine can actually read. Absent: none.
   * images: pixels reach the model natively. files: "any" also reads binary
   * documents with read-only tools; "text" reads UTF-8 text only.
   * paths: read-only tools can open the private copies beyond inlined text. */
  attachments?: { images: boolean; files: "any" | "text"; paths: boolean };
}

/** A host-verified private copy of a side attachment. The path stays readable
 * until the side handle is disposed; it never points at Hub storage. */
export interface EngineSideAttachment {
  attachmentId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
  /** Decided by content: a supported image, UTF-8 text, or anything else. */
  kind: "image" | "text" | "binary";
  /** Bounded UTF-8 content for kind "text". */
  text?: string;
  /** `text` is only a prefix of the file. */
  partial?: boolean;
}

export const NO_SIDE_CAPABILITY: SideCapability = Object.freeze({
  context: "none", concurrent: false, readOnly: "no-tools", residue: "none", seesInProgressTurn: false,
});

/** A temporary conversation borrowing a parent session's native context. It is
 * never bound to a chat; follow-up context lives in the handle. dispose() is
 * idempotent, cancels only this side conversation and removes native residue. */
export interface EngineSideSession {
  readonly nativeId: string;
  send(input: {
    /** May be empty when attachments carry the whole question. */
    text: string;
    attachments?: EngineSideAttachment[];
    appPlatformTools?: AppPlatformTools;
    turnInstructions?: string;
    onEngineEvent: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal: AbortSignal;
  }): Promise<CodexAdapterResponse>;
  dispose(): Promise<void>;
}

export interface CodexThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  /** DeepSeek counts native goal-round provider usage, excluding ordinary/child turns. */
  usageScope?: "nativeGoalTurns" | "unavailable";
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodexThreadGoalResponse {
  goal: CodexThreadGoal | null;
  sessionId?: string;
}

/** Where a fork taken at an anchor ends: before that input, or after the turn it started. */
export type NativeHistoryBoundary = "before-input" | "after-turn";

/**
 * A place in one native session's history, made by the adapter when the engine
 * accepted a user input. It is never derived from text, time or position. The
 * holder stores it whole and hands it back; only the adapter reads `data`.
 */
export interface NativeHistoryAnchor {
  /** The native session this anchor belongs to. It is valid nowhere else. */
  sessionId: string;
  /** The engine's own id of that user input. A rewind names what it removed by these. */
  inputId: string;
  rewind: boolean;
  fork: boolean;
  /** Present when `fork` is true. */
  forkBoundary?: NativeHistoryBoundary;
  /** Engine-private location data. */
  data?: Record<string, string | number | null>;
}

/** What one native session can do now, from the engine's own handshake and state. */
export interface NativeHistoryState {
  /** Absent: this session cannot be forked. */
  fork?: { whole: boolean; anchored: boolean };
  rewind?: boolean;
  /** Changes whenever the native history changes. Null: there is no native session, or it cannot be read. */
  head: string | null;
  /** Why nothing can be done at the moment; a call made now is rejected with the same reason. */
  blocked?: "busy" | "goal_active" | "background_work" | "not_ready" | "source_missing";
}

export type NativeHistoryRejection =
  | "unsupported" | "busy" | "goal_active" | "background_work"
  /** The chat has no native session yet, or the engine cannot be asked right now. Nothing was changed. */
  | "not_ready"
  /** The native session no longer exists. No replacement is created. */
  | "source_missing"
  /** `expectedHead` is not the native head. */
  | "source_changed"
  /** The anchor is not on this session's active history, or its turn has not ended. */
  | "anchor_unavailable"
  /** Cancelled before anything was sent to the engine. */
  | "cancelled";

/**
 * `rejected`: the engine was not asked, or refused; native state is unchanged.
 * `unknown`: the request reached the engine and no confirmed answer came back.
 * An adapter never repeats a fork or a rewind by itself.
 */
export type NativeHistoryResult =
  | {
      outcome: "applied";
      /** Fork: the new durable session. Rewind: the same session. */
      sessionId: string;
      head: string | null;
      boundary: NativeHistoryBoundary | "whole";
      /** Rewind only: the inputs no longer in context, oldest first. */
      excludedInputIds?: string[];
    }
  | { outcome: "rejected"; reason: NativeHistoryRejection; detail?: string }
  | {
      outcome: "unknown";
      detail?: string;
      /** A fork id the engine returned without confirming it durable. Never bind it. */
      candidateSessionId?: string;
    };

/** Actual lifetime of the adapter's two legacy allow decisions. Missing keys
 * mean the native request does not offer that decision. */
export interface EngineApprovalScopes {
  once?: "once" | "turn";
  session?: "turn" | "session" | "always";
}

export interface EngineApprovalRequest {
  engine: "claude" | "codex" | "antigravity" | "kimi" | "deepseek" | "pi" | "omp";
  toolName: string;
  toolInput: unknown;
  /** Name of the worker / subagent requesting approval or asking a question (e.g. swarm worker). */
  workerName?: string;
  cwd?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  permissionSuggestions?: unknown[];
  approvalScopes?: EngineApprovalScopes;
  /** This request's background continuation can report status to its answer receipt. */
  supportsAnswerProgress?: boolean;
}

/** Host-local status only. Never serialized into CLI permission responses. */
export interface EngineAnswerProgress {
  phase: "sent" | "thinking" | "working" | "replying" | "finished" | "interrupted" | "unknown" | "waiting_input";
  toolName?: string;
}

export type EngineApprovalDecision =
  | {
      behavior: "allow";
      scope?: "once" | "session";
      updatedInput?: unknown;
      onAnswerProgress?: (progress: EngineAnswerProgress) => void;
    }
  | {
      behavior: "deny";
    };

type UnscopedEngineStreamEvent =
  | { /** Host recovery state after a confirmed terminal or unadmitted request. */
      type: "engine_retry";
      status: "waiting" | "retrying" | "resumed" | "cancelled" | "failed";
      attempt: number;
      reason: "capacity" | "connection" | "rate-limit";
      delayMs: number;
      sessionId?: string;
    }
  | {
      /** Public native child lifecycle receipt, not a child transcript or a
       * completion of the parent turn. */
      type: "subagent_activity";
      id: string;
      kind: "started" | "interacted" | "interrupted" | "completed";
      /** True when an "interrupted" receipt is already confirmed settled by the
       * engine (no separate "completed" receipt follows). */
      terminal?: boolean;
      agentId: string;
      label: string;
      model?: string;
      effort?: string;
      sessionId?: string;
    }
  | { /** Host admission state, never model output or a fabricated tool call. */
      type: "background_review_wait" | "native_input_wait"; status: "started" | "finished" | "cancelled"; sessionId?: string;
      /** Names a non-Claude engine in the waiting copy; absent for Claude. */
      engine?: "kimi";
    }
  | {
      /** Explicit engine context maintenance, before or during a user turn. */
      type: "context_compaction";
      id: string;
      status: "started" | "completed" | "failed" | "unknown";
      /** AGY checkpoints summarize context but do not prove history pruning. */
      checkpoint?: boolean;
      durationMs?: number;
      sessionId?: string;
    }
  | {
      type: "session";
      sessionId?: string;
    }
  | {
      /** The engine has accepted one foreground user input; its history can be cut here. */
      type: "history_anchor";
      anchor: NativeHistoryAnchor;
    }
  | {
      type: "assistant_text";
      text: string;
      /**
       * True when `text` is a streaming token fragment that must be concatenated
       * to the previous fragment with no separator (Codex app-server emits one
       * event per `item/agentMessage/delta`). Engines that emit a complete
       * message per event (legacy Claude blocks, Codex process) leave this unset so the run
       * card keeps them on separate lines.
       */
      delta?: boolean;
      sessionId?: string;
    }
  | {
      type: "thinking";
      text: string;
      /** False starts a distinct public block; unset preserves legacy fragments. */
      delta?: boolean;
      sessionId?: string;
    }
  | {
      type: "tool_use";
      toolName: string;
      toolInput?: unknown;
      /** Engine-assigned tool call id, used to match a later tool_result. */
      toolUseId?: string;
      sessionId?: string;
    }
  | {
      type: "tool_result";
      /** Structured public evidence, only when explicitly supplied by the engine. */
      exitCode?: number; durationMs?: number;
      /** Upstream CLI/terminal explicitly reported bounded output. */
      truncated?: boolean;
      changes?: Array<{ path: string; diff: string }>;
      sources?: Array<{ url: string; title?: string; refId?: string }>;
      /** Matches the toolUseId of the originating tool_use event. */
      toolUseId?: string;
      toolName?: string;
      output?: string;
      isError?: boolean;
      sessionId?: string;
    }
  | {
      /** Incremental text produced by a child agent while its parent tool call
       * is still running. It belongs to the tool panel, not the main answer. */
      type: "tool_progress";
      toolUseId: string;
      text: string;
      /** False denotes a complete child message, not a token fragment. */
      delta?: boolean;
      sessionId?: string;
    }
  | {
      type: "permission_request";
      toolName: string;
      toolInput?: unknown;
      /** Same native call ID as tool_use, when the engine provides one. */
      toolUseId?: string;
      sessionId?: string;
    }
  | {
      /** Codex accepted a non-blocking request for user input. The host must
       * surface it separately; it is not the turn's final assistant message. */
      type: "user_input_request";
      toolName: "request_user_input_async";
      toolInput: unknown;
      requestId?: string;
      sessionId?: string;
    }
  | {
      type: "result";
      text: string;
      sessionId?: string;
    }
  | {
      /** A Claude background task (run_in_background shell / subagent) was
       * spawned. Logged to the timeline so the restart busy-guard — which runs
       * in a SEPARATE process and can only see the timeline — knows the engine
       * still owns live background work after the foreground turn settles. */
      type: "background_task_started";
      origin?: "bound" | "unattributed";
      taskId: string;
      sessionId?: string;
      description?: string;
    }
  | {
      /** Lifecycle-only terminal marker for a background task. It is persisted
       * immediately and recorded in process details; the later task_notification is the
       * user-facing reviewed result. */
      type: "background_task_finished";
      origin?: "bound" | "unattributed";
      taskId: string;
      sessionId?: string;
      status?: string;
      summary?: string;
      outputFile?: string;
    }
  | {
      type: "task_notification";
      /** Host-created review scope, never a CLI session or another conversation. */
      scopeId?: string;
      text: string;
      /** Whether this callback belongs to the task's original request. */
      origin?: "bound" | "unattributed";
      /** Host-authored fallback only; engine-authored text is never translated. */
      reason?: "no_result" | "engine_exit";
      /** A Host-authored remark shown after the text, in the reader's language: why the engine's own review
       * of this result did not end normally. */
      note?: "review_timeout" | "review_failed" | "review_interrupted";
      sessionId?: string;
      taskId?: string;
      status?: string;
      summary?: string;
      outputFile?: string;
      /** True when this notification is being promoted into the active turn's final answer. */
      settlesCurrentTurn?: boolean;
      /** Persist lifecycle state but do not render or deliver this internal transition to the user. */
      suppressUserDelivery?: boolean;
    };

/** Child observations are a separate discriminant: generic foreground reducers
 * cannot mistake them for their own text, tool receipts or terminal result. */
export type ScopedEngineEvent = Extract<UnscopedEngineStreamEvent,
  { type: "thinking" | "assistant_text" | "tool_use" | "tool_result" | "tool_progress" | "permission_request" | "result" }>
  | { type: "scope_status"; status: "running" | "done" | "error" | "stopped" | "unknown"; text?: string };
export type EngineStreamEvent = UnscopedEngineStreamEvent | {
  type: "scoped"; scope: RunScope; rootScope?: RunScope;
  origin: "bound" | "unattributed"; event: ScopedEngineEvent; taskId?: string; detached?: boolean;
};

/** Host-owned tools; closures are bound to one authorized App conversation.
 * Adapters that cannot expose native tools keep input.instructions unchanged. */
export interface AppPlatformTools {
  definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  instructions: string;
  turnInstructions?: string;
  /** Short Host-owned execution contract for THIS turn. Codex sends this in a
   * separate context entry so long persona/capability prose cannot clip it. */
  executionInstructions?: string;
  isRegistered(sessionId: string): Promise<boolean>;
  /** Select exactly the tools persisted by this native thread's schema version. */
  forSession?(sessionId: string): Promise<AppPlatformTools | undefined>;
  register(sessionId: string): Promise<void>;
  call(input: { name: string; arguments: unknown; callId: string; sessionId: string; abortSignal: AbortSignal; onActivity?: () => void }): Promise<{ text: string; isError?: boolean }>;
}

export interface CodexUserMessageInput {
  /** Trusted Bridge conversation identity, never supplied by prompt text. */
  inputOwnerKey?: string;
  /** Authenticated ordinary App input only; absent means wait for the review. */
  reviewAdmission?: "native";
  nativeInput?: NativeInputObserver;
  text: string;
  /**
   * Exactly what the conversation's owner typed for this turn, set only when the turn is their own
   * direct message. Absent for everything else the Host sends through here: another Bot's message,
   * agent-bus, delegated and group-discussion prompts, scheduled jobs, Host repair prompts and
   * recovery continuations. `text` is what a model should read and may carry context the Host
   * appended (a quoted message, a media transcript). An engine whose input is also a command
   * language (Pi's `/name` and `!shell`) takes commands from this alone and reads the rest as prose.
   */
  authoredText?: string;
  files: string[];
  locale?: Locale;
  /** Stable channel/runtime contract. Changes may reconfigure persistent workers. */
  instructions?: string;
  /** Private guidance for this request only. Must never participate in worker settings. */
  turnInstructions?: string;
  appPlatformTools?: AppPlatformTools;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onNativeGoal?: (update: ClaudeNativeGoalUpdate) => void;
  requestOutputDir?: string;
  workspaceOverride?: string;
  extraEnv?: Record<string, string>;
  abortSignal?: AbortSignal;
  disableRuntimeTimeout?: boolean;
  /** The host's automatic continuation after a confirmed transient failure
   * (`ENGINE_RECOVERY_CONTINUATION`), not a new user message. */
  engineRecoveryContinuation?: boolean;
  /** Hub-owned model/effort for this session only (a dispatcher ticket), in
   * place of config.json. An effort the engine rejects fails the turn. */
  engineOverride?: EngineOverride;
}

export interface EngineSessionRestartResult { outcome: "closed" | "not_running" | "exit_unconfirmed" }
/** `beforeStop`: stops the session's running work (the Host's /stop path) after the
 * adapter captured the old process and before it signals that process. */
export interface EngineSessionRestartOptions { beforeStop?: () => unknown }

export interface CodexAdapter {
  /** Account quota only: never starts a model turn. Private proof must not enter public replies. */
  getAccountQuota?(options: EngineQuotaReadOptions): Promise<EngineQuotaReadResult>;
  /** Existing native total turn cap, carried across automatic continuations.
   * Undefined/null means this adapter has no total cap (inactivity is separate). */
  readonly turnRuntimeLimitMs?: number | null;
  bridgeInstructionMode?: "generic-file-blocks" | "output-directory";
  supportsTurnScopedEnv?: boolean;
  /** Opt-in only when native input can be adopted by the running turn. */
  readonly inFlightSendBehavior?: "steer";
  /** Required for inFlightSendBehavior opt-in: native capability of the already-live worker. */
  supportsSessionSteering?(sessionId: string): boolean;
  /** A native stop fence must settle before claiming another durable queued input. */
  isSessionInputBlocked?(sessionId: string): boolean;
  /** Pure lifecycle read across live sessions; retained native work can outlive
   * a foreground reply and must settle before a graceful Host restart. */
  hasPendingNativeWork?(): boolean;
  createSession(chatId: number): Promise<CodexSessionHandle>;
  sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse>;
  // Inject additional user input into this session's currently running turn
  // (Codex app-server turn/steer or DeepSeek Harness session steer). True only
  // when the engine accepted the steer; false means no active/addressable turn.
  // Explicit App steering must report failure without silently queueing it.
  // throwOnError preserves uncertain RPC outcomes instead of claiming rejection.
  steerActiveTurn?(sessionId: string, input: { text: string; throwOnError?: boolean; onOutcome?: (outcome: SteeringApplication) => void }): Promise<boolean>;
  nativeInputCapability?(sessionId: string): NativeInputCapability | undefined;
  backgroundInputTarget?(sessionId: string, ownerKey: string): string | undefined;
  controlNativeInput?(sessionId: string, input: { inputId: string; action: NativeInputAction }): Promise<NativeInputControlResult>;
  /** Slash commands the engine advertised (ACP available_commands_update); absent means none. */
  advertisedCommands?(): Array<{ name: string; description: string }>;
  /** Whether an authoritative advertised-commands snapshot has arrived. */
  hasReceivedAdvertisedCommands?(): boolean;
  /** Stop background native work (such as an active swarm) after its initiating turn ended. */
  stopBackgroundWork?(sessionId: string, input?: { locale?: "en" | "zh"; scope?: "swarm" | "all" }): Promise<{ stopped: boolean; summary?: string }>;
  /** Native live tasks; absent means unsupported. Handles must be worker-scoped. */
  listTasks?(sessionId: string): Promise<EngineTaskSnapshot>;
  stopTask?(sessionId: string, input: { taskId: string }): Promise<EngineTaskControlResult>;
  /** Explicit recovery of one unconfirmed stop; token must bind the exact live fence. */
  recoverSession?(sessionId: string, input: { token: string }): Promise<EngineTaskControlResult>;
  validateExternalSession?(
    sessionId: string,
    input?: { workspaceOverride?: string },
  ): Promise<ExternalSessionInfo | void>;
  listExternalSessions?(input?: { cwd?: string; limit?: number }): Promise<ExternalSessionInfo[]>;
  /** `passive`: a reading for display. Only what a running engine or this adapter already has is reported;
   * nothing is started, resumed, reconciled or marked as used, and null is the answer otherwise. */
  getContextUsage?(
    sessionId: string,
    input?: { workspaceOverride?: string; passive?: boolean },
  ): Promise<EngineContextUsage | null>;
  getThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<CodexThreadGoalResponse>;
  setThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse>;
  /** Patch an existing native goal without resetting its usage or objective. */
  updateThreadGoal?(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    status?: CodexThreadGoal["status"];
    objective?: string;
    tokenBudget?: number | null;
    origin?: "user" | "automatic";
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse>;
  // Observe autonomous pursuit until it stops, is suspended, or is cleared.
  // A suspended result retains native state and can be resumed.
  watchThreadGoal?(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    mode?: "replace" | "resume" | "observe";
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse>;
  clearThreadGoal?(sessionId: string, input?: { workspaceOverride?: string; origin?: "user" | "automatic"; isCurrentSession?: () => boolean | Promise<boolean> }): Promise<{ cleared: boolean; sessionId?: string }>;
  /**
   * Native history operations; an absent method means the engine has none.
   * None of them starts a turn, a model call or a replacement session, and the
   * source session's binding and live process are left as they were.
   */
  getHistoryState?(sessionId: string, input?: { workspaceOverride?: string; signal?: AbortSignal }): Promise<NativeHistoryState>;
  /** Without an anchor the whole history is forked. */
  forkHistory?(sessionId: string, input?: {
    anchor?: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  }): Promise<NativeHistoryResult>;
  /** Removes the anchor's input and everything after it from context. Files are not restored. */
  rewindHistory?(sessionId: string, input: {
    anchor: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  }): Promise<NativeHistoryResult>;
  /** Optional native side conversations; absent means unsupported. */
  sideCapability?(input?: { workspaceOverride?: string; tools?: "inherited" }): SideCapability;
  /** sourceSessionId must be the parent's real native ID (never a logical
   * `tarobot-` ID). The parent session, binding and active turn are untouched. */
  openSideSession?(input: {
    sourceSessionId: string;
    tools?: "inherited";
    workspaceOverride?: string;
    locale?: Locale;
    abortSignal?: AbortSignal;
  }): Promise<EngineSideSession>;
  /** Request process termination and acknowledge only an observed exit.
   * Future input lazily reopens the retained native session. */
  restartSession?(sessionId: string, options?: EngineSessionRestartOptions): Promise<EngineSessionRestartResult>;
  /** While an old process has an outstanding termination, input may wait on its exact exit. */
  sessionRestartPending?(sessionId: string): Promise<void> | undefined;
  /** Restart may also interrupt work known from lifecycle receipts outside the task panel. */
  listRestartTasks?(sessionId: string): Promise<EngineTaskSnapshot["tasks"]>;
  destroy?(): void | Promise<void>;
}
