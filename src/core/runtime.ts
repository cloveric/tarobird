import type { EngineApprovalDecision, EngineApprovalRequest } from "../codex/adapter.js";
import { delegateToInstance as defaultDelegateToInstance } from "../bus/bus-client.js";
import { loadBusConfig as defaultLoadBusConfig } from "../bus/bus-config.js";
import type { TranscribeMediaOptions } from "../runtime/asr-cloud.js";
import type { PreparedVideoInput } from "../runtime/video-input.js";
import { ChatQueue, type ChatQueueWaitEvent } from "../runtime/chat-queue.js";
import type { CronScheduler } from "../runtime/cron-scheduler.js";
import type { ScannedSession } from "../runtime/session-scanner.js";
import type { CronStore } from "../state/cron-store.js";
import type { MiniBusCommandContext } from "./shared/mini-bus-commands.js";
import type { CoreTurnContext } from "./shared/turn-bookkeeping.js";
import type { LarkCliStatus, LarkChatCreateInput, LarkChatCreateResult, LarkDocumentCreateInput, LarkDocumentCreateResult, LarkCommentClientLike } from "./integration-ports.js";
import type { ManagedCardHandle } from "./managed-card.js";
import type { CoreChatMode, CoreNormalizedBridgeMessage } from "./message-normalizer.js";
const unavailable = async (): Promise<never> => { throw new Error("platform_integration_unavailable"); };

export interface CoreActiveRun {
  abortController: AbortController;
  // Set true once a live run card (managed or inline) exists for this run. When a
  // task is stopped, that card updates IN PLACE to "已中断", so the stop handlers
  // must NOT also post a redundant "已停止。" text. Absent/false → no card (the
  // CardKit-unavailable fallback), so the text is the only acknowledgment.
  hasRunCard?: boolean;
  /**
   * Set true for an autonomous Codex /goal watcher (vs a normal turn). `/goal
   * clear` aborts only a goal watcher — a normal turn must not be killed, nor
   * falsely reported as "goal cleared", by `/goal clear`.
   */
  goalWatch?: boolean;
  /** Update only this observer's banner after an explicit native goal edit. */
  updateGoalObjective?: (objective: string) => void;
  /**
   * Epoch ms when the run was claimed. Steering is only eligible within the
   * first LARK_STEER_ELIGIBILITY_WINDOW_MS of a run (operator decision: a task
   * deep in progress should not be derailed mid-flight — later messages queue
   * as their own turn instead). Absent → treated as steer-eligible.
   */
  startedAt?: number;
  /** The queued input this run executes, for an exactly targeted Stop. */
  sourceMessageId?: string;
}

export interface CoreQueuePolicy {
  preempt: boolean;
  batchWindowMs: number;
}

export interface PendingCoreBatch {
  normalized: CoreNormalizedBridgeMessage;
  members: CoreNormalizedBridgeMessage[];
  texts: string[];
  awaitingAttachment: boolean;
  onWait: (event: ChatQueueWaitEvent) => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  resolve: Array<(value: boolean) => void>;
  reject: Array<(error: unknown) => void>;
}

export interface CoreCronRuntime {
  store: CronStore;
  scheduler: Pick<CronScheduler, "refresh" | "runJobNow">;
}

export interface CoreBusRuntime {
  loadBusConfig?: typeof defaultLoadBusConfig;
  delegateToInstance?: typeof defaultDelegateToInstance;
  /** Present only while one Hub-dispatched Agent Bus input executes. */
  agentBusRun?: CoreAgentBusRun;
}

export interface CoreAgentBusRun {
  /** Stops exactly this run, independent of other work in the conversation. */
  signal: AbortSignal;
  started(): void;
  /** The handled outcome the existing delegation/crew audit records. */
  outcome: NonNullable<CoreTurnContext["onHandleOutcome"]>;
}

export interface CoreMiniRuntime {
  runQueuedBridgeTurn?: MiniBusCommandContext["runQueuedBridgeTurn"];
}

export interface CoreSessionRuntime {
  scanRecentSessions?: (hours: number) => Promise<ScannedSession[]>;
  scanRecentAntigravitySessions?: (hours: number) => Promise<ScannedSession[]>;
}

export interface AsyncQuestionDelivery {
  nativeRequestId?: string;
  nativeSessionId?: string;
  isCurrentTurn?: () => boolean;
  answerActiveTurn?: (text: string) => Promise<boolean>;
}

export interface PendingCoreApproval {
  asyncQuestion?: AsyncQuestionDelivery;
  /** Stable identity for the separately cancellable queued answer follow-up. */
  asyncTaskId?: string;
  submitting?: boolean;
  cancelled?: boolean;
  requestId: string;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  requesterUserId?: number;
  replyTo?: string;
  replyInThread?: boolean;
  askUserQuestionInput?: unknown;
  approvalEngine?: EngineApprovalRequest["engine"];
  /** Tool name/input of a regular (non-AskUserQuestion) approval, kept so the decision handler can re-render the card in place as resolved. */
  approvalToolName?: string;
  approvalToolInput?: unknown;
  approvalScopes?: EngineApprovalRequest["approvalScopes"];
  supportsAnswerProgress?: boolean;
  /**
   * Set when the approval card (an AskUserQuestion form or a regular command
   * approval) was delivered as a CardKit managed card, so the decision handler
   * can update it IN PLACE (CardKit updates land even right after the user
   * interacts, unlike im.message.patch). Absent when CardKit was unavailable and
   * the card fell back to a normal send.
   */
  managedCard?: ManagedCardHandle;
  /** Native cards can be visible before the send receipt binds their handle. */
  presentation?: Promise<void>;
  /** Terminal state retained for a native send/retry receipt arriving after cancellation or timeout. */
  closedCard?: Record<string, unknown>;
  resolve: (decision: EngineApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

/**
 * A live "queued" card. `messageId` is always set (used to take the card over as
 * the run card, or to recall it). `handle` is set when the card was delivered as
 * a CardKit managed card, so the cancel tap can flip it to "已取消" IN PLACE
 * (CardKit survives a post-interaction update, where im.message.patch reverts).
 * Absent `handle` → a plain inline card (CardKit was unavailable).
 */
export interface CoreQueueCardRef {
  messageId: string;
  handle?: ManagedCardHandle;
  /** Answer receipts keep their submitted answers when the queued work is cancelled. */
  onCancelled?: () => void;
}

/**
 * A bridge-managed choice card. Keeping both active and resolved entries lets
 * the callback handler reject duplicate taps even before the terminal CardKit
 * update becomes visible on the client.
 */
export interface CoreChoiceCardRef {
  /** Answer a native asynchronous question in the originating live turn. */
  answerActiveTurn?: (text: string) => Promise<boolean>;
  messageId: string;
  handle?: ManagedCardHandle;
  originalCard?: Record<string, unknown>;
  preserveBody?: boolean;
  status: "active" | "resolved";
  createdAt: number;
  selectedLabel?: string;
}

export interface CoreServiceRuntime {
  activeRuns: Map<string, CoreActiveRun>;
  /** Concurrent commands retain independent cancellation ownership. */
  concurrentRuns: Map<string, Set<CoreActiveRun>>;
  pendingApprovals: Map<string, PendingCoreApproval>;
  chatQueue: ChatQueue;
  queuePolicy: CoreQueuePolicy;
  pendingBatches: Map<string, PendingCoreBatch>;
  /**
   * Per-chat cache of the resolved session mode (p2p/group/topic) with an expiry,
   * so switching a group's 群消息形式 (conversation ⇄ topic) takes effect within
   * the TTL instead of requiring a service restart.
   */
  chatModeCache: Map<string, { mode: CoreChatMode; expiresAt: number }>;
  /** queued message id → its "queued" card ref, so each task's run card reuses
   *  its own card and the cancel handler can update it in place. */
  queueCards: Map<string, CoreQueueCardRef>;
  /** Choice-card message id → delivery handle and one-shot callback state. */
  choiceCards: Map<string, CoreChoiceCardRef>;
  /**
   * Queued task ids the user explicitly cancelled from a card button. The
   * cancel handler already updated that task's card, so its eventual skip must
   * stay silent (no duplicate "skipped" notice).
   */
  cancelledQueueTaskIds: Set<string>;
  appInfo?: { appId: string; appSecret?: string; domain?: string };
  cronRuntime?: CoreCronRuntime;
  /** VC bot-meeting support; present ONLY when config.meeting.enabled (gated). */
  meetingSupport?: {
    handleMeetingCommand(text: string, locale: "en" | "zh", context?: { mentionOpenIds?: readonly string[] }): Promise<string | null>;
    dispose(): Promise<void>;
  };
  busRuntime?: CoreBusRuntime;
  miniRuntime?: CoreMiniRuntime;
  sessionRuntime?: CoreSessionRuntime;
  commentClient?: LarkCommentClientLike;
  transcribeMedia?: (filePath: string, options?: TranscribeMediaOptions) => Promise<string>;
  prepareVideoInput?: (filePath: string, options?: { abortSignal?: AbortSignal }) => Promise<PreparedVideoInput>;
  detectLarkCli: () => Promise<LarkCliStatus>;
  createChat: (input: LarkChatCreateInput) => Promise<LarkChatCreateResult>;
  createDocument: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
}

export function createCoreServiceRuntime(options: {
  createChat?: (input: LarkChatCreateInput) => Promise<LarkChatCreateResult>;
  createDocument?: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
  commentClient?: LarkCommentClientLike;
  cronRuntime?: CoreCronRuntime;
  /** VC bot-meeting support; present ONLY when config.meeting.enabled (gated). */
  meetingSupport?: {
    handleMeetingCommand(text: string, locale: "en" | "zh", context?: { mentionOpenIds?: readonly string[] }): Promise<string | null>;
    dispose(): Promise<void>;
  };
  busRuntime?: CoreBusRuntime;
  miniRuntime?: CoreMiniRuntime;
  sessionRuntime?: CoreSessionRuntime;
  transcribeMedia?: (filePath: string, options?: TranscribeMediaOptions) => Promise<string>;
  prepareVideoInput?: (filePath: string, options?: { abortSignal?: AbortSignal }) => Promise<PreparedVideoInput>;
  detectLarkCli?: () => Promise<LarkCliStatus>;
  queuePolicy?: Partial<CoreQueuePolicy>;
} = {}): CoreServiceRuntime {
  return {
    activeRuns: new Map(),
    concurrentRuns: new Map(),
    pendingApprovals: new Map(),
    chatQueue: new ChatQueue(),
    queuePolicy: {
      preempt: options.queuePolicy?.preempt === true,
      batchWindowMs: Math.max(0, Math.floor(options.queuePolicy?.batchWindowMs ?? 0)),
    },
    pendingBatches: new Map(),
    chatModeCache: new Map(),
    queueCards: new Map(),
    choiceCards: new Map(),
    cancelledQueueTaskIds: new Set(),
    ...(options.cronRuntime ? { cronRuntime: options.cronRuntime } : {}),
    ...(options.busRuntime ? { busRuntime: options.busRuntime } : {}),
    ...(options.miniRuntime ? { miniRuntime: options.miniRuntime } : {}),
    ...(options.sessionRuntime ? { sessionRuntime: options.sessionRuntime } : {}),
    ...(options.commentClient ? { commentClient: options.commentClient } : {}),
    ...(options.transcribeMedia ? { transcribeMedia: options.transcribeMedia } : {}),
    ...(options.prepareVideoInput ? { prepareVideoInput: options.prepareVideoInput } : {}),
    detectLarkCli: options.detectLarkCli ?? (async () => ({ available: false })),
    createChat: options.createChat ?? unavailable,
    createDocument: options.createDocument ?? unavailable,
  };
}
