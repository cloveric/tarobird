import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver } from "../client-protocol/native-input.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import type { RunScope } from "../client-protocol/run.js";
import type { Locale } from "../runtime/locale.js";
import type { EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";
import type { EngineOverride } from "../state/instance-config.js";
export type { EngineTask, EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";

/** A terminal frame arrived without a real answer. Never blindly replay tools. */
export class EngineIncompleteResponseError extends Error {
  constructor(message: string) { super(message); this.name = "EngineIncompleteResponseError"; }
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

export interface EngineContextUsage {
  /** Provider-reported prompt size for the most recent request. */
  pressureTokens?: number;
  /** Estimated prompt size for the next request after surface changes. */
  projectedTokens?: number;
  contextWindow?: number;
}

export interface CodexAdapterResponse {
  text: string;
  sessionId?: string;
  usage?: AdapterUsage;
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
  status: "active" | "paused" | "budgetLimited" | "complete";
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

/** Actual lifetime of the adapter's two legacy allow decisions. Missing keys
 * mean the native request does not offer that decision. */
export interface EngineApprovalScopes {
  once?: "once" | "turn";
  session?: "turn" | "session" | "always";
}

export interface EngineApprovalRequest {
  engine: "claude" | "codex" | "antigravity" | "kimi" | "deepseek";
  toolName: string;
  toolInput: unknown;
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
      agentId: string;
      label: string;
      model?: string;
      effort?: string;
      sessionId?: string;
    }
  | { /** Host admission state, never model output or a fabricated tool call. */
      type: "background_review_wait" | "native_input_wait"; status: "started" | "finished" | "cancelled"; sessionId?: string;
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
      sources?: Array<{ url: string; title?: string }>;
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
  files: string[];
  locale?: "en" | "zh";
  /** Stable channel/runtime contract. Changes may reconfigure persistent workers. */
  instructions?: string;
  /** Private guidance for this request only. Must never participate in worker settings. */
  turnInstructions?: string;
  appPlatformTools?: AppPlatformTools;
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
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

export interface CodexAdapter {
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
  getContextUsage?(
    sessionId: string,
    input?: { workspaceOverride?: string },
  ): Promise<EngineContextUsage | null>;
  getThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<CodexThreadGoalResponse>;
  setThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse>;
  // Set a goal and watch Codex's autonomous pursuit of it, streaming turn/item events
  // to onEngineEvent until it reaches a terminal status (or abortSignal fires).
  watchThreadGoal?(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse>;
  clearThreadGoal?(sessionId: string, input?: { workspaceOverride?: string }): Promise<{ cleared: boolean; sessionId?: string }>;
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
  destroy?(): void | Promise<void>;
}
