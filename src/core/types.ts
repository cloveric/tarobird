import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver } from "../client-protocol/native-input.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import type {
  CardActionEvent,
  CommentEvent,
  NormalizedMessage,
  RejectEvent,
} from "./channel-events.js";

import type {
  CodexThreadGoal,
  AppPlatformTools,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineContextUsage,
  EngineStreamEvent,
} from "../codex/adapter.js";
import type { BridgeAccessDecision } from "../runtime/bridge.js";
import type { EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import type { TurnPoolWaitEvent } from "../runtime/turn-pool.js";
import type { CoreChatMode } from "./message-normalizer.js";
import type { AppDeliveryReceipt, AppDeliveryCache } from "./app-delivery.js";

export interface CoreSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface CoreStreamControllerLike {
  messageId: string;
  current: object;
  update(card: object | ((current: object) => object)): Promise<void>;
}

export type CoreMessageResourceType = "image" | "file";

export interface CoreMessageResourceResponseLike {
  getReadableStream(): NodeJS.ReadableStream;
}

export interface CoreChannelLike {
  /** Optional App protocol feature; absent for non-Gateway channels. */
  supportsScopedRunPresentation?(): boolean;
  /** Release ordered ingress once a message has reserved its queue/batch slot. */
  releaseMessageAdmission?(): void;
  /** A Gateway pull may already own this exact message's execution slot. */
  ownsMessageQueueSlot?(chatId: string, messageId: string): boolean;
  /** Optional authenticated-surface preparation, executed inside the conversation queue. */
  prepareConversation?(chatId: string): Promise<void>;
  canSteerConversation?(chatId: string): Promise<boolean>;
  profile?: import("./channel-profile.js").ChannelProfile;
  send(to: string, input: unknown, opts?: CoreSendOptions): Promise<{ messageId: string }>;
  stream(to: string, input: {
    card: {
      initial: object;
      producer: (controller: CoreStreamControllerLike) => Promise<void>;
    };
  }, opts?: CoreSendOptions): Promise<{ messageId: string }>;
  updateCard?(messageId: string, card: object): Promise<void>;
  recallMessage?(messageId: string): Promise<void>;
  addReaction?(messageId: string, emojiType: string): Promise<string>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  removeReactionByEmoji?(messageId: string, emojiType: string): Promise<boolean>;
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
  /** Explicit transport ports. No SDK discovery or implicit network fallback. */
  uploadImage?(body: Buffer): Promise<string | undefined>;
  downloadMessageResource?(messageId: string, fileKey: string, type: CoreMessageResourceType): Promise<NodeJS.ReadableStream>;
  closeInactiveQuestion?(input: { chatId: string; messageId: string; requestId: string; card: object }): Promise<boolean>;
  fetchCardContent?(messageId: string): Promise<Record<string, unknown> | null>;
  resolveMentions?(chatId: string, text: string): Promise<string>;
  managedCards?: import("./managed-card.js").ManagedCardTransport;
  fetchMessage?(messageId: string): Promise<CoreFetchedMessage | null>;
  getChatMode?(chatId: string): Promise<CoreChatMode>;
  /**
   * Whether the chat is in topic-message form, i.e. each topic should be its own
   * isolated session. True for a native topic group (chat_mode='topic') and for
   * a conversation group switched to the topic message form
   * (group_message_type='thread'); false for the default conversation form
   * (group_message_type='chat'), whose topic replies share the one group session.
   */
  getChatTopicForm?(chatId: string): Promise<boolean>;
}

export interface CoreFetchedMessage {
  messageId: string;
  messageType?: string;
  content?: string;
  senderId?: string;
  senderName?: string;
  createTime?: string;
  children?: CoreFetchedMessage[];
}

export interface CoreRuntimeChannelLike extends CoreChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: "reject", handler: (event: RejectEvent) => void): () => void;
  on(name: "cardAction", handler: (event: CardActionEvent) => void | Promise<void>): () => void;
  on(name: "comment", handler: (event: CommentEvent) => void | Promise<void>): () => void;
  on(name: "error", handler: (error: Error) => void): () => void;
}

export interface CoreBridgeLike {
  sideCapability?(input?: { workspaceOverride?: string; tools?: "inherited" }): import("../codex/adapter.js").SideCapability;
  openSideSession?(input: { chatId: number; userId: number; chatType: string; conversationKey: string; workspaceOverride?: string; tools?: "inherited"; locale?: "en" | "zh"; abortSignal?: AbortSignal }): Promise<import("../codex/adapter.js").EngineSideSession>;
  /** Shares the underlying engine/session state for an independently authenticated transport. */
  createAuthenticatedSurface?(): CoreBridgeLike;
  /** Native background work/reviews still owned by this worker, without polling the engine. */
  hasPendingNativeWork?(): boolean;
  destroy?(): void | Promise<void>;
  checkAccess?(input: {
    chatId: number;
    conversationChatId?: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  checkUserAuthorization?(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    locale?: "en" | "zh";
    text: string;
    replyContext?: {
      messageId: string;
      text: string;
    };
    conversationKey?: string;
    files: string[];
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    instructions?: string;
    turnInstructions?: string;
    reviewAdmission?: "native";
    nativeInput?: NativeInputObserver;
    appPlatformTools?: AppPlatformTools;
    /** Host-owned receipts survive engine errors and automatic repair attempts. */
    onAppDelivery?: (receipt: AppDeliveryReceipt) => void;
    /** Muted jobs may generate local artifacts, but cannot publish them. */
    suppressAppDelivery?: boolean;
    appDeliveryReplyTo?: string;
    appDeliveryCache?: AppDeliveryCache;
    extraEnv?: Record<string, string>;
    engineOverride?: import("../state/instance-config.js").EngineOverride;
    sessionIdOverride?: string;
    abortSignal?: AbortSignal;
    disableRuntimeTimeout?: boolean;
    onTurnLockWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
    turnPoolWaitNotifyAfterMs?: number;
    onTurnPoolWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
  }): Promise<{ text: string; appDeliveries?: AppDeliveryReceipt[]; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } }>;
  validateCodexThread?(
    threadId: string,
    input?: { workspaceOverride?: string },
  ): Promise<{
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
  } | void>;
  listExternalSessions?(input?: { cwd?: string; limit?: number }): Promise<Array<{
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
  }>>;
  getContextUsage?(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<EngineContextUsage | null>;
  supportsSteering?(): boolean;
  canStartQueuedTurn?(input: { chatId: number; conversationKey: string }): Promise<boolean>;
  inFlightSendBehavior?(input: { chatId: number; conversationKey: string }): Promise<"steer" | undefined> | "steer" | undefined;
  nativeInputCapability?(input: { chatId: number; conversationKey: string }): Promise<NativeInputCapability | undefined>;
  backgroundInputTarget?(input: { chatId: number; conversationKey: string }): Promise<string | undefined>;
  controlNativeInput?(input: { chatId: number; conversationKey: string; inputId: string; action: NativeInputAction; isCurrentSession?: () => Promise<boolean> }): Promise<NativeInputControlResult>;
  listTasks?(input: { chatId: number; conversationKey: string }): Promise<EngineTaskSnapshot>;
  stopTask?(input: { chatId: number; conversationKey: string; taskId: string; isCurrentSession?: () => Promise<boolean> }): Promise<EngineTaskControlResult>;
  recoverSession?(input: { chatId: number; conversationKey: string; token: string; isCurrentSession?: () => Promise<boolean> }): Promise<EngineTaskControlResult>;
  steerActiveTurn?(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    text: string;
    isCurrentTurn?: () => boolean;
    throwOnError?: boolean;
    onOutcome?: (outcome: SteeringApplication) => void; nativeInput?: NativeInputObserver;
  }): Promise<boolean>;
  getThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  setThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  watchThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<{ goal: CodexThreadGoal | null; sessionId?: string }>;
  clearThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
    sessionId?: string;
  }): Promise<{ cleared: boolean }>;
}

export interface CoreServiceLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}
