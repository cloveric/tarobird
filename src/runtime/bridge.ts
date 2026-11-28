import { EngineHistoryBusyError } from "../codex/adapter.js";
import { piSessionCommands } from "../client-protocol/pi-commands.js";
import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver } from "../client-protocol/native-input.js";
import type { ClaudeNativeGoalUpdate } from "../codex/claude-native-goal.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import { EngineSteeringRejectedError } from "../codex/adapter.js";
import { botInstructionsGuidance } from "./bot-instructions.js";
import type { EngineTask, EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";
import { createHash } from "node:crypto";
import { getPiNativeControls } from "../codex/pi-rpc-adapter.js";
import { decodePiModel, encodePiModel, parsePiModels } from "../codex/pi-models.js";
import { PiNativeRejectedError, type PiNativeState, type PiNativeLiveSession } from "../codex/pi-native-types.js";
import { piSessionSnapshotSchema, piSessionThinkingSchema, type PiSessionSnapshot, type PiSessionResult, type PiSessionChange, type PiSessionThinking } from "../client-protocol/pi-session.js";
import type { PiModelRef } from "../codex/pi-rpc-protocol.js";
import type {
  CodexAdapter,
  AppPlatformTools,
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineContextUsage,
  EngineSessionRestartResult,
  EngineStreamEvent,
  ExternalSessionInfo,
} from "../codex/adapter.js";
import { findConflictingLockedChatId } from "../state/access-store.js";

type PiSessionScope = { chatId: number; conversationKey: string; isCurrentSession?: () => Promise<boolean> };
const piSessionToken = (scope: PiSessionScope, sessionId: string, live: PiNativeLiveSession): string => createHash("sha256").update(JSON.stringify([scope.conversationKey, sessionId, live.token])).digest("hex");
const piUiText = (value: string, max: number): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
function piUi(state: PiNativeState): PiNativeState["ui"] {
  const safeKey = (key: string) => key.length > 0 && key.length <= 80 && !["__proto__", "prototype", "constructor"].includes(key);
  return {
    status: Object.fromEntries(Object.entries(state.ui?.status ?? {}).filter(([key, value]) => safeKey(key) && typeof value === "string").slice(0, 20).map(([key, value]) => [key, piUiText(value, 1000)])),
    widgets: Object.fromEntries(Object.entries(state.ui?.widgets ?? {}).filter(([key, value]) => safeKey(key) && Array.isArray(value?.lines) && ["aboveEditor", "belowEditor"].includes(value.placement)).slice(0, 10).map(([key, value]) => [key, { placement: value.placement, lines: value.lines.filter(line => typeof line === "string").slice(0, 20).map(line => piUiText(line, 1000)) }])),
    ...(typeof state.ui?.title === "string" ? { title: piUiText(state.ui.title, 200) } : {}),
  };
}

/** Native tool adapters may select a previous thread's tool schema. Keep the
 * Bot file reference in that turn too, without changing stable worker settings. */
function withBotFileGuidance(tools: AppPlatformTools, guidance: string): AppPlatformTools {
  return {
    ...tools,
    turnInstructions: [guidance, tools.turnInstructions].filter(Boolean).join("\n\n"),
    ...(tools.forSession ? { forSession: async (sessionId: string) => {
      const selected = await tools.forSession!(sessionId);
      return selected ? withBotFileGuidance(selected, guidance) : undefined;
    } } : {}),
  };
}
import {
  type Locale,
  renderPairingMessage,
  renderSingleChatLockedMessage,
  renderUnauthorizedMessage,
} from "./message-renderer.js";
import type { EngineOverride, GroupModeConfig } from "../state/instance-config.js";
import { type BridgeTurnLockWaitEvent, TURN_LOCK_WAIT_NOTIFY_AFTER_MS, bridgeConversationLockId, resolveBridgeTurnLockPath, withBridgeTurnLock } from "./turn-lock.js";
import type { TelemetryAdapter, TelemetryTags } from "./telemetry.js";
import type { TurnPoolLike, TurnPoolWaitEvent } from "./turn-pool.js";
import type { EngineRetryReceipt } from "../codex/turn-retry.js";
import { ENGINE_RECOVERY_CONTINUATION, EngineRecoveryUnconfirmedError, recoverEngineTurn } from "./engine-recovery.js";
import { runToolAction } from "../client-protocol/run-tools.js";
import { ConversationHistoryController, nativeHistoryAnchor, type ConversationHistoryScope, type ConversationHistoryApply, type ConversationHistoryFinalize, type HistorySessionManager, type NativeConversationHistoryAdapter } from "./conversation-history.js";
import type { HistoryAnchorEvidence } from "../client-protocol/conversation-history.js";

export interface AccessStoreLike {
  load(): Promise<{
    multiChat: boolean;
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: Array<{
      telegramUserId: number;
      telegramChatId: number;
    }>;
  }>;
  issuePairingCode(input: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<{
    code: string;
  }>;
}

export interface SessionManagerLike extends HistorySessionManager {
  getLockNamespace?(): Promise<string>;
  getOrCreateSession(scope: number | BridgeConversationScope): Promise<{ sessionId: string }>;
  getExistingSession?(scope: number | BridgeConversationScope): Promise<{ sessionId: string } | null>;
  isSessionShared?(conversationKey: string, sessionId: string): Promise<boolean>;
  bindSession(scope: number | BridgeConversationScope, sessionId: string): Promise<void>;
  assertHistoryAvailable?(scope: number | BridgeConversationScope): Promise<void>;
}

export interface BridgeConversationScope {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}

export interface BridgeConversationRestartInput extends BridgeConversationScope {
  conversationKey: string;
  signal: AbortSignal;
  isCurrentBinding(): Promise<boolean>;
  confirm(tasks: readonly EngineTask[]): Promise<boolean>;
  /** Stops the running work; the restart waits for it (bounded) before closing the process. */
  onStopping(): void | Promise<unknown>;
}

export type BridgeConversationRestartOutcome = EngineSessionRestartResult["outcome"]
  | "unsupported" | "no_session" | "binding_changed" | "shared_session" | "busy" | "cancelled" | "failed";

export interface BridgeAccessInput {
  chatId: number;
  conversationChatId?: number;
  userId: number;
  chatType: string;
  messageThreadId?: number;
  conversationKey?: string;
  locale?: Locale;
}

export interface BridgeAuthorizedMessageInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
  text: string;
  /** The owner's own typed text for this turn; see `CodexUserMessageInput.authoredText`. Never set for other sources. */
  authoredText?: string;
  /** Only the first, unbatched direct owner input may acquire a native anchor. */
  historyInputMessageId?: string;
  onHistoryAnchor?: (evidence: Omit<HistoryAnchorEvidence, "conversationId">) => Promise<void>;
  replyContext?: {
    messageId: number | string;
    text: string;
  };
  messageThreadId?: number;
  conversationKey?: string;
  files: string[];
  onProgress?: (partialText: string) => void;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onNativeGoal?: (update: ClaudeNativeGoalUpdate) => void;
  requestOutputDir?: string;
  workspaceOverride?: string;
  instructions?: string;
  turnInstructions?: string;
  reviewAdmission?: "native";
  nativeInput?: NativeInputObserver;
  appPlatformTools?: AppPlatformTools;
  sideChannelCommand?: string;
  extraEnv?: Record<string, string>;
  engineOverride?: EngineOverride;
  abortSignal?: AbortSignal;
  disableRuntimeTimeout?: boolean;
  sessionIdOverride?: string;
  turnLockWaitNotifyAfterMs?: number;
  onTurnLockWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
  /** Called once the conversation's turn lock is held, with how long it took. */
  onTurnLockAcquired?: (event: { waitedMs: number }) => void | Promise<void>;
  turnPoolWaitNotifyAfterMs?: number;
  onTurnPoolWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
}

export interface BridgeGroupJoinInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
}

export interface BridgeAccessDecision {
  kind: "allow" | "reply" | "deny";
  text?: string;
  reason?: "single_chat_locked";
}

function shouldDisableRuntimeTimeout(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "不设超时",
    "无超时",
    "不要超时",
  ].some((keyword) => text.includes(keyword)) || [
    "no timeout",
    "disable timeout",
    "without timeout",
  ].some((keyword) => normalized.includes(keyword));
}

function isAuthorizedGroupUser(
  accessState: Awaited<ReturnType<AccessStoreLike["load"]>>,
  input: BridgeAccessInput,
): boolean {
  if (accessState.policy === "allowlist") {
    return accessState.allowlist.includes(input.userId);
  }
  return accessState.allowlist.includes(input.userId) ||
    accessState.pairedUsers.some((user) => user.telegramUserId === input.userId);
}

function isAllowedGroupChat(groupMode: GroupModeConfig, input: BridgeAccessInput): boolean {
  return [input.chatId, input.conversationChatId]
    .filter((chatId): chatId is number => Number.isInteger(chatId))
    .some((chatId) => groupMode.allowedChatIds.includes(chatId));
}

function hasPairedPrivateUser(
  accessState: Awaited<ReturnType<AccessStoreLike["load"]>>,
  input: BridgeAccessInput,
): boolean {
  // A pairing record binds (user, chat). Honor both dimensions so a paired user
  // is authorized only in the chat they paired from. When multiChat is off there
  // is at most one authorized chat (enforced by the chat lock), so matching only
  // the user is already safe there; the chat match closes the gap once multiChat
  // is enabled, without changing behavior for the default single-chat setup.
  return accessState.pairedUsers.some(
    (user) =>
      user.telegramUserId === input.userId &&
      (!accessState.multiChat || user.telegramChatId === input.chatId),
  );
}

/** One turn of this process driving native sessions. `released` settles once
 * the turn ended and its claims are removed, before its turn lock is released. */
type SessionTurnHold = { scopeLockId: string; lockedSessionId: string; released: Promise<void>; ended?: true };
type SessionTurnWaitOptions = NonNullable<Parameters<typeof withBridgeTurnLock>[2]>;

/**
 * Why Pi refused a value. Pi words an unknown model and a provider without
 * credentials alike ("Model not found"); its catalog lists only signed-in
 * providers, so a provider absent from it is the sign-in case.
 */
async function piRejectionDetail(error: PiNativeRejectedError, model: PiModelRef | null, listModels: () => Promise<unknown[]>): Promise<NonNullable<PiSessionResult["detail"]>> {
  if (error.reason === "thinking-unsupported") {
    const allowed = (error.allowed ?? []).filter((level): level is PiSessionThinking => piSessionThinkingSchema.safeParse(level).success);
    return { kind: "thinking_unsupported", ...(allowed.length ? { allowed } : {}) };
  }
  if (!model) return { kind: "default_unavailable" };
  let catalog: unknown[];
  try { catalog = await listModels(); } catch { return { kind: "model_unavailable" }; }
  const signedIn = catalog.some(entry => Boolean(entry) && typeof entry === "object" && (entry as { provider?: unknown }).provider === model.provider);
  return { kind: signedIn ? "model_not_found" : "provider_unavailable" };
}

export class Bridge {
  readonly supportsTurnScopedEnv: boolean;
  private authenticatedSurface = false;
  /** Native session -> the turn driving it in this process. Conversations bound
   * to one session share it. */
  private sessionTurnOwners = new Map<string, SessionTurnHold>();
  private sessionRestarts = new Map<string, Promise<void>>();
  private sideSessionReaders = new Map<string, number>();
  private historyMutations = new Set<string>();
  private readonly history: ConversationHistoryController;

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
    private readonly options: {
      loadGroupMode?: () => Promise<GroupModeConfig>;
      runtimeInstructions?: () => string | undefined;
      botInstructionsPath?: string;
      turnPool?: TurnPoolLike;
      turnPoolMetadata?: {
        channel?: string;
        instanceName?: string;
      };
      telemetry?: TelemetryAdapter;
      telemetryTags?: TelemetryTags;
      recordFailedAttempt?: (receipt: EngineRetryReceipt) => Promise<void>;
      beforeRetry?: (locale: Locale) => Promise<void>;
    } = {},
  ) {
    this.supportsTurnScopedEnv = adapter.supportsTurnScopedEnv !== false;
    this.history = new ConversationHistoryController(sessionManager, adapter as CodexAdapter & NativeConversationHistoryAdapter,
      sessionId => !!this.sessionTurnOwner(sessionId) || !!this.waitingForRestart(sessionId),
      sessionId => { if (this.waitingForRestart(sessionId) || this.historyMutations.has(sessionId) || (this.sideSessionReaders.get(sessionId) ?? 0) > 0) return undefined;
        this.historyMutations.add(sessionId); return () => { this.historyMutations.delete(sessionId); }; },
      sessionId => (this.sideSessionReaders.get(sessionId) ?? 0) > 0);
  }

  async readAccountQuota(options: import("../codex/adapter.js").EngineQuotaReadOptions): Promise<import("../codex/adapter.js").EngineQuotaReadResult | undefined> {
    return this.adapter.getAccountQuota?.(options);
  }

  async destroy(): Promise<void> {
    await this.adapter.destroy?.();
  }

  hasPendingNativeWork(): boolean {
    return this.adapter.hasPendingNativeWork?.() ?? false;
  }

  /** Internal transport boundary: only a surface which has already authenticated
   * its incoming requests may use this facade. It shares the engine, sessions,
   * session locks, pool and telemetry; the original bridge access policy is intact.
   * This flag is not an engine input, environment variable or user configuration. */
  createAuthenticatedSurface(): Bridge {
    const surface = new Bridge(this.accessStore, this.sessionManager, this.adapter, this.options);
    surface.authenticatedSurface = true;
    surface.sessionTurnOwners = this.sessionTurnOwners;
    surface.sessionRestarts = this.sessionRestarts;
    surface.sideSessionReaders = this.sideSessionReaders;
    surface.historyMutations = this.historyMutations;
    return surface;
  }

  getConversationHistory(input: ConversationHistoryScope, options?: { turnPending?: boolean }) { return this.history.get(input, options); }
  applyConversationHistory(input: ConversationHistoryApply) { return this.history.apply(input); }
  finalizeConversationHistory(input: ConversationHistoryFinalize) { return this.history.finalize(input); }

  async validateCodexThread(
    threadId: string,
    input?: { workspaceOverride?: string },
  ): Promise<ExternalSessionInfo | void> {
    if (!this.adapter.validateExternalSession) {
      throw new Error("codex thread validation unsupported");
    }

    return input === undefined
      ? await this.adapter.validateExternalSession(threadId)
      : await this.adapter.validateExternalSession(threadId, input);
  }

  async listExternalSessions(input?: { cwd?: string; limit?: number }): Promise<ExternalSessionInfo[]> {
    if (!this.adapter.listExternalSessions) {
      throw new Error("external session listing unsupported");
    }
    return await this.adapter.listExternalSessions(input);
  }

  async getContextUsage(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
    passive?: boolean;
  }): Promise<EngineContextUsage | null> {
    if (!this.adapter.getContextUsage) {
      throw new Error("Context usage is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = this.sessionManager.getExistingSession
      ? await this.sessionManager.getExistingSession(scope)
      : await this.sessionManager.getOrCreateSession(scope);
    if (!session) {
      return null;
    }
    return await this.adapter.getContextUsage(session.sessionId, {
      ...(input.passive ? { passive: true } : {}),
      workspaceOverride: input.workspaceOverride,
    });
  }

  supportsConversationRestart(): boolean {
    return !!this.adapter.restartSession && !!this.sessionManager.getExistingSession;
  }

  /** Reserve the native session before reviewing its impact. The actual stop
   * must never act on a stale binding or on a worker owned by another chat. */
  async restartConversationSession(input: BridgeConversationRestartInput): Promise<BridgeConversationRestartOutcome> {
    if (!this.supportsConversationRestart()) return "unsupported";
    const scope = this.conversationScope(input);
    if (!await input.isCurrentBinding()) return "binding_changed";
    const session = await this.sessionManager.getExistingSession!(scope);
    if (!session) return "no_session";
    const { sessionId } = session;
    const scopeLockId = bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.());
    if (this.sessionRestarts.has(sessionId)) return "busy";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.sessionRestarts.set(sessionId, gate);
    const ownedByAnotherChat = () => {
      const owner = this.sessionTurnOwner(sessionId);
      return owner && owner.scopeLockId !== scopeLockId;
    };
    const inUse = () => this.historyMutations.has(sessionId) || (this.sideSessionReaders.get(sessionId) ?? 0) > 0;
    const confirmed = new Set<string>();
    try {
      for (;;) {
        if (input.signal.aborted) return "cancelled";
        if (!await input.isCurrentBinding() || (await this.sessionManager.getExistingSession!(scope))?.sessionId !== sessionId) return "binding_changed";
        if (await this.sessionManager.isSessionShared?.(input.conversationKey, sessionId) || ownedByAnotherChat()) return "shared_session";
        if (inUse()) return "busy";
        const snapshot = this.adapter.listRestartTasks ? undefined : await this.adapter.listTasks?.(sessionId);
        const knownTasks = this.adapter.listRestartTasks
          ? await this.adapter.listRestartTasks(sessionId)
          : snapshot?.tasks ?? [];
        const tasks = knownTasks.filter(task => task.status === "running" && task.mode === "background");
        // An active swarm is background work even while none of its members is reported as running.
        if (snapshot?.swarm?.active && !tasks.some(task => task.swarmState)) {
          tasks.push({
            id: `swarm:${sessionId}`, label: snapshot.swarm.title?.trim() || "Swarm", kind: "subagent", mode: "background",
            status: "running", canStop: false, updatedAt: snapshot.swarm.updatedAt,
          });
        }
        if (tasks.some(task => !confirmed.has(task.id))) {
          if (!await input.confirm(tasks)) return "cancelled";
          for (const task of tasks) confirmed.add(task.id);
          continue;
        }
        if (input.signal.aborted) return "cancelled";
        if (ownedByAnotherChat()) return "shared_session";
        if (inUse()) return "busy";
        // The adapter captures the exact old worker synchronously, before the
        // turn's abort handler can remove that worker from its lookup table.
        // It then runs onStopping (the /stop path, swarms included) to completion
        // while that worker can still answer, and only then signals the process.
        const retryingExit = this.adapter.sessionRestartPending?.(sessionId);
        const closing = this.adapter.restartSession!(sessionId, retryingExit ? undefined : { beforeStop: () => input.onStopping() });
        return (await closing).outcome;
      }
    } finally {
      this.sessionRestarts.delete(sessionId);
      release();
    }
  }

  private waitingForRestart(sessionId: string): Promise<void> | undefined {
    return this.sessionRestarts.get(sessionId) ?? this.adapter.sessionRestartPending?.(sessionId);
  }

  async checkAccess(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    if (this.authenticatedSurface) return { kind: "allow" };
    if (input.chatType === "bus") {
      return { kind: "allow" };
    }

    let accessState: Awaited<ReturnType<AccessStoreLike["load"]>>;
    try {
      accessState = await this.accessStore.load();
    } catch (error) {
      console.error(
        "Failed to load access state; denying access:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "deny", text: renderUnauthorizedMessage(input.locale) };
    }

    if (input.chatType !== "private") {
      const groupMode = await this.loadGroupMode();
      if (
        groupMode.enabled &&
        isAllowedGroupChat(groupMode, input) &&
        isAuthorizedGroupUser(accessState, input)
      ) {
        return { kind: "allow" };
      }
      return {
        kind: "reply",
        text: renderUnauthorizedMessage(input.locale),
      };
    }

    const conflictingChatId = findConflictingLockedChatId(accessState as Parameters<typeof findConflictingLockedChatId>[0], input.chatId);

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      return {
        kind: conflictingChatId === null ? "deny" : "reply",
        text:
          conflictingChatId === null
            ? renderUnauthorizedMessage(input.locale)
            : renderSingleChatLockedMessage(input.locale),
        ...(conflictingChatId === null ? {} : { reason: "single_chat_locked" as const }),
      };
    }

    if (accessState.policy === "pairing" && !hasPairedPrivateUser(accessState, input)) {
      if (conflictingChatId !== null) {
        return {
          kind: "reply",
          text: renderSingleChatLockedMessage(input.locale),
          reason: "single_chat_locked",
        };
      }

      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        kind: "reply",
        text: renderPairingMessage(pendingPair.code, input.locale),
      };
    }

    return { kind: "allow" };
  }

  async checkUserAuthorization(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    if (this.authenticatedSurface) return { kind: "allow" };
    let accessState: Awaited<ReturnType<AccessStoreLike["load"]>>;
    try {
      accessState = await this.accessStore.load();
    } catch (error) {
      console.error(
        "Failed to load access state; denying access:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "deny", text: renderUnauthorizedMessage(input.locale) };
    }

    if (isAuthorizedGroupUser(accessState, input)) {
      return { kind: "allow" };
    }
    return { kind: "reply", text: renderUnauthorizedMessage(input.locale) };
  }

  async checkGroupJoin(input: BridgeGroupJoinInput): Promise<BridgeAccessDecision> {
    if (input.chatType === "private") {
      return { kind: "allow" };
    }

    const groupMode = await this.loadGroupMode();
    if (!groupMode.enabled) {
      return { kind: "reply", text: renderUnauthorizedMessage(input.locale) };
    }

    return this.checkUserAuthorization({
      chatId: input.chatId,
      userId: input.userId,
      chatType: input.chatType,
      locale: input.locale,
    });
  }

  private async loadGroupMode(): Promise<GroupModeConfig> {
    return this.options.loadGroupMode
      ? await this.options.loadGroupMode()
      : { enabled: true, allowedChatIds: [], listenAllChatIds: [] };
  }

  async handleAuthorizedMessage(input: BridgeAuthorizedMessageInput) {
    const turnStartedAt = Date.now();
    const decision = await this.checkAccess(input);
    if (decision.kind === "deny") {
      throw new Error(decision.text ?? renderUnauthorizedMessage(input.locale));
    }
    if (decision.kind === "reply") {
      return {
        text: decision.text ?? renderUnauthorizedMessage(input.locale),
      };
    }

    const sessionScope: BridgeConversationScope = {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      conversationKey: input.conversationKey,
    };
    // Keep session resolution, engine execution, and the eventual session bind in
    // one logical-conversation critical section. Otherwise a cron entry can resolve
    // the old session id while a chat turn is rebinding it, then run a second turn
    // against the stale id after the existing session lock is released.
    const scopeLockId = bridgeConversationLockId(sessionScope, await this.sessionManager.getLockNamespace?.());
    const lockRequestedAt = Date.now();
    return await withBridgeTurnLock(
      scopeLockId,
      async () => {
        // An observer only records timing; it never delays or fails the turn.
        const waitedMs = Date.now() - lockRequestedAt;
        void Promise.resolve().then(() => input.onTurnLockAcquired?.({ waitedMs })).catch(() => undefined);
        return await this.handleAuthorizedTurn(input, turnStartedAt, sessionScope, scopeLockId);
      },
      {
        signal: input.abortSignal,
        waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs,
        onWait: input.onTurnLockWait,
        interruptHistorySnapshot: true,
      },
    );
  }

  private async handleAuthorizedTurn(
    input: BridgeAuthorizedMessageInput,
    turnStartedAt: number,
    sessionScope: BridgeConversationScope,
    scopeLockId: string,
  ) {
    const useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const session = input.sessionIdOverride
      ? { sessionId: input.sessionIdOverride }
      : await this.sessionManager.getOrCreateSession(useConversationScope ? sessionScope : input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    let text = baseText;
    let files = input.files;
    let continuation = false;
    let nativeSessionId = session.sessionId;
    let reportProgress: (() => Promise<void>) | undefined;
    let attemptSessionId: string | undefined;
    let attemptHasOutput = false;
    const unfinishedAgents = new Set<string>(), unfinishedBackground = new Set<string>();
    const unfinishedTools = new Map<string | symbol, string>();
    const turnEnvSupported = this.adapter.supportsTurnScopedEnv !== false;
    const disableRuntimeTimeout = input.disableRuntimeTimeout === true || shouldDisableRuntimeTimeout(input.text);
    const runtimeLimit = disableRuntimeTimeout ? undefined : this.adapter.turnRuntimeLimitMs;
    let nativeStartedAt: number | undefined;
    let boundSessionIdFromEvent: string | undefined;
    const pendingSessionBinds = new Map<string, Promise<void>>();
    let historyObserverOpen = false, historyAttempt = 0;
    const historyPublications = new Map<string, Promise<void>>();
    const ownership = this.sessionTurnOwnership(scopeLockId);
    const bindEngineSession = async (sessionId: string): Promise<void> => {
      if (sessionId === boundSessionIdFromEvent) {
        return;
      }
      const existing = pendingSessionBinds.get(sessionId);
      if (existing) {
        await existing;
        return;
      }

      const bindPromise = this.sessionManager
        .bindSession(useConversationScope ? sessionScope : input.chatId, sessionId)
        .then(() => {
          boundSessionIdFromEvent = sessionId;
        })
        .finally(() => {
          pendingSessionBinds.delete(sessionId);
        });
      pendingSessionBinds.set(sessionId, bindPromise);
      await bindPromise;
    };
    // A native engine can accept the provisional ID as its durable ID (Harness
    // does). Persist that confirmation too, otherwise the conversation stays
    // absent from session state, backups and runtime controls despite real turns.
    const handleEngineEvent = async (event: EngineStreamEvent, anchorAttempt?: number): Promise<void> => {
      const anchor = historyObserverOpen && anchorAttempt === historyAttempt && !continuation && input.historyInputMessageId && input.onHistoryAnchor && !input.sessionIdOverride
        ? nativeHistoryAnchor(event) : undefined;
      if (anchor && this.sessionManager.getHistoryBinding && input.conversationKey) {
        const key = JSON.stringify([anchor.sessionId, anchor.inputId]);
        if (!historyPublications.has(key)) {
          const publication = (async () => {
            await bindEngineSession(anchor.sessionId);
            const binding = await this.sessionManager.getHistoryBinding!({ chatId: input.chatId, conversationKey: input.conversationKey! });
            if (binding?.record.codexSessionId !== anchor.sessionId || !binding.record.historyGeneration || !binding.record.historyRevision) return;
            await input.onHistoryAnchor!({ messageId: input.historyInputMessageId!, sessionId: anchor.sessionId,
              bindingGeneration: binding.record.historyGeneration, revision: binding.record.historyRevision, nativeAnchor: { ...anchor } });
          })().catch(async () => { await this.recordError(new Error("history_anchor_not_recorded"), {}); });
          historyPublications.set(key, publication);
        }
        await historyPublications.get(key);
        return;
      }
      if (event.type === "subagent_activity") {
        if (event.kind === "completed" || (event.kind === "interrupted" && event.terminal)) unfinishedAgents.delete(event.agentId);
        else unfinishedAgents.add(event.agentId); // An interrupt request alone is not a terminal receipt.
      }
      if (event.type === "background_task_started") unfinishedBackground.add(event.taskId);
      if (event.type === "background_task_finished") unfinishedBackground.delete(event.taskId);
      if (event.type === "tool_use" && runToolAction(event.toolName) !== "plan") unfinishedTools.set(event.toolUseId ?? Symbol(event.toolName), event.toolName);
      if (event.type === "tool_result") {
        if (event.toolUseId) unfinishedTools.delete(event.toolUseId);
        else {
          const candidates = [...unfinishedTools].filter(([, name]) => !event.toolName || name === event.toolName);
          if (candidates.length === 1) unfinishedTools.delete(candidates[0]![0]);
        }
      }
      if (event.type === "session" && event.sessionId) { attemptSessionId = event.sessionId; ownership.own(event.sessionId); }
      if ((event.type === "assistant_text" || event.type === "thinking") && event.text.trim()
        || ["tool_use", "tool_result", "tool_progress", "permission_request", "user_input_request", "background_task_started", "result"].includes(event.type)) attemptHasOutput = true;
      // Native adapters do not await observers between stream fragments. Start
      // delivery without waiting for recovery bookkeeping: otherwise standalone
      // whitespace, tool progress and results can overtake useful output.
      await Promise.all([
        (event.type === "assistant_text" && event.text.trim()) || event.type === "tool_use" || event.type === "tool_result"
          ? reportProgress?.() : undefined,
        (async () => {
          if (event.type === "session" && event.sessionId && !input.sessionIdOverride) {
            await bindEngineSession(event.sessionId);
          }
          await input.onEngineEvent?.(event);
        })(),
      ]);
    };
    const lockWait: SessionTurnWaitOptions = { signal: input.abortSignal, waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs, onWait: input.onTurnLockWait };
    try {
      const response = await withBridgeTurnLock(session.sessionId, () => ownership.hold(session.sessionId, () => recoverEngineTurn(async (receipt, progress, signal) => {
        reportProgress = progress;
        attemptSessionId = undefined;
        attemptHasOutput = false;
        if (receipt) {
          nativeSessionId = receipt.sessionId;
          ownership.own(nativeSessionId);
          if (!input.sessionIdOverride) await bindEngineSession(nativeSessionId);
          // A pre-admission rejection repeats only the immediately preceding
          // input. After retained native work, never replay the original task.
          if (receipt.mode === "continue") { text = ENGINE_RECOVERY_CONTINUATION; files = []; continuation = true; }
        }
        const sendMessage = async () => {
          signal?.throwIfAborted();
          if (receipt) await this.options.beforeRetry?.(input.locale ?? "en");
          signal?.throwIfAborted();
          nativeStartedAt ??= performance.now();
          const botGuidance = this.options.botInstructionsPath ? botInstructionsGuidance(this.options.botInstructionsPath) : undefined;
          const anchorAttempt = ++historyAttempt; historyObserverOpen = true;
          const adapterResponse = await this.adapter.sendUserMessage(nativeSessionId, {
            inputOwnerKey: scopeLockId,
            ...(input.reviewAdmission && !receipt && !continuation ? { reviewAdmission: input.reviewAdmission, nativeInput: input.nativeInput } : {}),
            text,
            // A recovery continuation is the Host's own prompt, not something the owner typed.
            ...(input.authoredText !== undefined && !continuation ? { authoredText: input.authoredText } : {}),
            files,
            locale: input.locale,
            instructions: [this.options.runtimeInstructions?.(), input.instructions]
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value))
              .join("\n\n") || undefined,
            turnInstructions: [botGuidance, input.turnInstructions].filter(Boolean).join("\n\n") || undefined,
            ...(input.appPlatformTools ? { appPlatformTools: botGuidance ? withBotFileGuidance(input.appPlatformTools, botGuidance) : input.appPlatformTools } : {}),
            onProgress: input.onProgress,
            onApprovalRequest: input.onApprovalRequest,
            onEngineEvent: event => handleEngineEvent(event, anchorAttempt),
            onNativeGoal: input.onNativeGoal,
            requestOutputDir: input.requestOutputDir,
            workspaceOverride: input.workspaceOverride,
            extraEnv: turnEnvSupported ? input.extraEnv : undefined,
            abortSignal: signal,
            disableRuntimeTimeout: disableRuntimeTimeout || undefined,
            ...(continuation ? { engineRecoveryContinuation: true } : {}),
            ...(input.engineOverride ? { engineOverride: input.engineOverride } : {}),
          }).finally(async () => {
            if (anchorAttempt === historyAttempt) historyObserverOpen = false;
            await Promise.all(historyPublications.values());
          });

          if (
            !input.sessionIdOverride &&
            adapterResponse.sessionId &&
            adapterResponse.sessionId !== boundSessionIdFromEvent
          ) {
            const pendingBind = pendingSessionBinds.get(adapterResponse.sessionId);
            if (pendingBind) {
              await pendingBind.catch(() => undefined);
            }
            if (adapterResponse.sessionId !== boundSessionIdFromEvent) {
              await this.sessionManager.bindSession(useConversationScope ? sessionScope : input.chatId, adapterResponse.sessionId);
            }
          }

          return adapterResponse;
        };

        if (this.options.turnPool) {
          return await this.options.turnPool.run(sendMessage, {
            signal,
            waitNotifyAfterMs: input.turnPoolWaitNotifyAfterMs,
            onWait: input.onTurnPoolWait,
            metadata: {
              ...this.options.turnPoolMetadata,
              conversationKey: input.conversationKey,
              sessionId: nativeSessionId,
            },
          });
        }

        return await sendMessage();
      }, {
        signal: input.abortSignal,
        ...(typeof runtimeLimit === "number" && Number.isFinite(runtimeLimit) && runtimeLimit > 0 ? {
          runtimeBudget: () => ({ limitMs: runtimeLimit, remainingMs: runtimeLimit - (performance.now() - nativeStartedAt!) }),
        } : {}),
        onEvent: handleEngineEvent,
        onFailure: async (receipt, error, signal) => {
          await this.options.recordFailedAttempt?.(receipt);
          const confirmedSession = attemptSessionId ?? boundSessionIdFromEvent;
          if (receipt.mode === "input" && attemptHasOutput || confirmedSession && confirmedSession !== receipt.sessionId) {
            throw new EngineRecoveryUnconfirmedError(error);
          }
          // Persist the confirmed context before waiting, including when Stop
          // or host shutdown prevents another attempt from starting.
          if (!input.sessionIdOverride) await bindEngineSession(receipt.sessionId);
          // A confirmed failed foreground may leave a yielded command running.
          // Wait for exact native receipts, without replaying the request or
          // clearing any ledger entry merely because the foreground ended.
          if (!receipt.unfinishedWork && !unfinishedAgents.size && !unfinishedBackground.size
            && unfinishedTools.size && [...unfinishedTools.keys()].every(id => typeof id === "string")
            && receipt.mode === "continue" && receipt.reconcileTools) {
            await receipt.reconcileTools([...unfinishedTools.keys()] as string[], signal, input.locale);
          }
          if (unfinishedAgents.size || unfinishedBackground.size || unfinishedTools.size) {
            throw new EngineRecoveryUnconfirmedError(error, "unfinished-work");
          }
        },
      }), lockWait), { ...lockWait, interruptHistorySnapshot: true });

      await this.recordTurnTelemetry(response, turnStartedAt, {
        outcome: "success",
        chatType: input.chatType,
      });
      return response;
    } catch (error) {
      await this.recordTurnErrorTelemetry(error, turnStartedAt, {
        outcome: "error",
        phase: "turn",
        chatType: input.chatType,
      });
      throw error;
    }
  }

  /** One turn's claim on the native sessions it drives. Claims are taken only
   * while the turn holds the session lock: Claude can confirm another native ID
   * mid-turn, and callbacks of tasks bound to the turn may run after it ends. */
  private sessionTurnOwnership(scopeLockId: string) {
    let current: SessionTurnHold | undefined;
    const owned = new Set<string>();
    const own = (sessionId: string): void => {
      if (!current || this.sessionTurnOwner(sessionId)) return;
      this.sessionTurnOwners.set(sessionId, current);
      owned.add(sessionId);
    };
    const hold = async <T>(sessionId: string, task: () => Promise<T>, wait: SessionTurnWaitOptions): Promise<T> => {
      await this.waitForSessionTurn(sessionId, scopeLockId, wait);
      for (let restart; (restart = this.waitingForRestart(sessionId));) {
        await this.waitForSessionRelease(restart, wait.signal);
      }
      wait.signal?.throwIfAborted();
      let release!: () => void;
      const turn: SessionTurnHold = { scopeLockId, lockedSessionId: sessionId, released: new Promise<void>((resolve) => { release = resolve; }) };
      current = turn;
      own(sessionId);
      try { return await task(); } finally {
        current = undefined;
        turn.ended = true;
        for (const id of owned) if (this.sessionTurnOwners.get(id) === turn) this.sessionTurnOwners.delete(id);
        owned.clear();
        release();
      }
    };
    return { own, hold };
  }

  /** The lock of `sessionId` is not enough while another conversation's first
   * turn, still under its provisional ID's lock, drives the native ID Claude
   * confirmed. Run after that turn, as a shared session promises: wait for its
   * release (no polling), abortably, with the usual lock-wait notice. */
  private async waitForSessionTurn(sessionId: string, scopeLockId: string, options: SessionTurnWaitOptions): Promise<void> {
    let other = this.sessionTurnOwner(sessionId);
    if (!other || other.scopeLockId === scopeLockId) return;
    const startedAt = Date.now();
    // A notice observer, even one throwing synchronously, cannot affect either turn.
    const timer = options.onWait ? setTimeout(() => {
      void Promise.resolve().then(() => options.onWait?.({ sessionId, waitedMs: Date.now() - startedAt, reason: "in_process_queue", lockPath: resolveBridgeTurnLockPath(other!.lockedSessionId) }))
        .catch((error: unknown) => console.error("Failed to notify session turn wait:", error instanceof Error ? error.message : error));
    }, Math.max(0, options.waitNotifyAfterMs ?? TURN_LOCK_WAIT_NOTIFY_AFTER_MS)) : undefined;
    timer?.unref?.();
    try {
      for (; other && other.scopeLockId !== scopeLockId; other = this.sessionTurnOwner(sessionId)) {
        const { released } = other, signal = options.signal;
        await this.waitForSessionRelease(released, signal);
      }
      options.signal?.throwIfAborted();
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForSessionRelease(released: Promise<void>, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!signal) return released;
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try { await Promise.race([released, stopped]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  /** A conversation may offer, steer or control the native turn of a session
   * unless another conversation's turn drives it here (a session shared through
   * "use this session" runs their turns in order). */
  private async sessionTurnAccess(scope: BridgeConversationScope): Promise<(sessionId: string) => boolean> {
    const scopeLockId = bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.());
    return (sessionId) => {
      const owner = this.sessionTurnOwner(sessionId);
      return !this.waitingForRestart(sessionId) && (owner === undefined || owner.scopeLockId === scopeLockId);
    };
  }

  /** An ended turn never blocks or owns, even if a claim of it were left behind. */
  private sessionTurnOwner(sessionId: string): SessionTurnHold | undefined {
    const owner = this.sessionTurnOwners.get(sessionId);
    return owner?.ended ? undefined : owner;
  }

  private async recordTurnTelemetry(
    response: { usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } },
    startedAt: number,
    tags: TelemetryTags,
  ): Promise<void> {
    const telemetryTags = this.telemetryTags(tags);
    await this.recordMetric("run_e2e_ms", Math.max(0, Date.now() - startedAt), telemetryTags);
    if (!response.usage) {
      return;
    }
    await this.recordMetric("tokens_in", response.usage.inputTokens, telemetryTags);
    await this.recordMetric("tokens_out", response.usage.outputTokens, telemetryTags);
    if (typeof response.usage.cachedTokens === "number") {
      await this.recordMetric("tokens_cached", response.usage.cachedTokens, telemetryTags);
    }
    if (typeof response.usage.costUsd === "number") {
      await this.recordMetric("cost_usd", response.usage.costUsd, telemetryTags);
    }
  }

  private async recordTurnErrorTelemetry(error: unknown, startedAt: number, tags: TelemetryTags): Promise<void> {
    const telemetryTags = this.telemetryTags(tags);
    await this.recordMetric("run_e2e_ms", Math.max(0, Date.now() - startedAt), telemetryTags);
    await this.recordMetric("command_fail", 1, telemetryTags);
    await this.recordError(error, telemetryTags);
  }

  private telemetryTags(tags: TelemetryTags = {}): TelemetryTags {
    return {
      ...this.options.telemetryTags,
      ...tags,
    };
  }

  private async recordMetric(name: string, value: number, tags: TelemetryTags): Promise<void> {
    try {
      await this.options.telemetry?.recordMetric?.(name, value, tags);
    } catch {
      // Telemetry is best-effort and must never affect the bridge turn.
    }
  }

  private async recordError(error: unknown, tags: TelemetryTags): Promise<void> {
    try {
      await this.options.telemetry?.recordError?.(
        error instanceof Error ? error : new Error(String(error)),
        tags,
      );
    } catch {
      // Telemetry is best-effort and must never affect the bridge turn.
    }
  }

  private conversationScope(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
  }): BridgeConversationScope {
    return {
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      conversationKey: input.conversationKey,
    };
  }

  private async historyAvailable(scope: BridgeConversationScope): Promise<boolean> {
    try {
      await this.sessionManager.assertHistoryAvailable?.(scope);
      const session = await this.sessionManager.getExistingSession?.(scope);
      return !session || !this.historyMutations.has(session.sessionId);
    } catch { return false; }
  }

  /**
   * Inject a follow-up message into the chat's currently running engine turn
   * (Codex app-server turn/steer or DeepSeek Harness session steer). Returns
   * false when the runtime does not support steering, the chat has no bound session, or no turn is active —
   * the caller then delivers the message through the normal turn queue.
   * Session resolution mirrors handleAuthorizedMessage so the steer targets
   * exactly the session a queued message would have used.
   */
  supportsSteering(): boolean { return typeof this.adapter.steerActiveTurn === "function"; }
  async canStartQueuedTurn(input: { chatId: number; conversationKey: string }): Promise<boolean> {
    const scope = this.conversationScope(input), session = await this.sessionManager.getExistingSession?.(scope);
    if (!await this.historyAvailable(scope)) return false;
    const current = await this.sessionManager.getExistingSession?.(scope);
    if (current?.sessionId !== session?.sessionId) return false;
    return !current || !this.waitingForRestart(current.sessionId)
      && !this.historyMutations.has(current.sessionId) && !this.adapter.isSessionInputBlocked?.(current.sessionId);
  }

  async inFlightSendBehavior(input: { chatId: number; conversationKey: string }): Promise<"steer" | undefined> {
    if (!this.supportsSteering() || this.adapter.inFlightSendBehavior !== "steer") return undefined;
    if (!this.adapter.supportsSessionSteering) return undefined;
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const session = await this.sessionManager.getExistingSession?.(scope);
    return session && mayUse(session.sessionId) && this.adapter.supportsSessionSteering(session.sessionId) ? "steer" : undefined;
  }

  async nativeInputCapability(input: { chatId: number; conversationKey: string }): Promise<NativeInputCapability | undefined> {
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const session = await this.sessionManager.getExistingSession?.(scope);
    return session && mayUse(session.sessionId) ? this.adapter.nativeInputCapability?.(session.sessionId) : undefined;
  }

  async backgroundInputTarget(input: { chatId: number; conversationKey: string }): Promise<string | undefined> {
    if (!this.adapter.backgroundInputTarget || !this.sessionManager.getExistingSession) return undefined;
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const ownerKey = bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.());
    const session = await this.sessionManager.getExistingSession(scope);
    return session && mayUse(session.sessionId) ? this.adapter.backgroundInputTarget(session.sessionId, ownerKey) : undefined;
  }

  async controlNativeInput(input: { chatId: number; conversationKey: string; inputId: string; action: NativeInputAction; isCurrentSession?: () => Promise<boolean> }): Promise<NativeInputControlResult> {
    if (!this.adapter.controlNativeInput || !this.sessionManager.getExistingSession) return { outcome: "rejected", reason: "unsupported" };
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const session = await this.sessionManager.getExistingSession(scope);
    if (!session || !await this.historyAvailable(scope)) return { outcome: "rejected", reason: "stale" };
    if (input.isCurrentSession && !await input.isCurrentSession()) return { outcome: "rejected", reason: "stale" };
    const current = await this.sessionManager.getExistingSession(scope);
    if (current?.sessionId !== session.sessionId) return { outcome: "rejected", reason: "binding_changed" };
    if (!mayUse(session.sessionId) || this.historyMutations.has(session.sessionId)) return { outcome: "rejected", reason: "stale" };
    return this.adapter.controlNativeInput(session.sessionId, { inputId: input.inputId, action: input.action });
  }

  async getPiSession(input: PiSessionScope): Promise<PiSessionSnapshot> {
    const controls = getPiNativeControls(this.adapter);
    if (!controls?.getLiveSession || !this.sessionManager.getExistingSession) return { supported: false };
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const session = await this.sessionManager.getExistingSession(scope);
    if (!session || !mayUse(session.sessionId)) return { supported: true };
    const live = controls.getLiveSession(session.sessionId);
    if (!live) return { supported: true };
    const isCurrent = async () => {
      if (input.isCurrentSession && !await input.isCurrentSession()) return false;
      const current = await this.sessionManager.getExistingSession!(scope);
      return current?.sessionId === session.sessionId && mayUse(session.sessionId) && !this.historyMutations.has(session.sessionId) && live.isCurrent();
    };
    if (!await isCurrent()) return { supported: true };
    try {
      const [state, models, commands] = await Promise.all([live.getState(), live.listModels(), live.listCommands?.().catch(() => []) ?? []]);
      if (!await isCurrent() || state.sessionId !== session.sessionId) return { supported: true };
      const model = state.model ? encodePiModel(state.model.provider, state.model.modelId) : undefined;
      const snapshot = piSessionSnapshotSchema.safeParse({ supported: true, session: {
        token: piSessionToken(input, session.sessionId, live),
        ...(model && decodePiModel(model) ? { model } : {}),
        modelSource: state.modelSource, thinking: state.thinkingLevel, thinkingLevels: state.availableThinkingLevels,
        choices: parsePiModels(models).slice(0, 5000), busy: state.isStreaming || state.isCompacting,
        bridge: state.bridge, ui: piUi(state), commands: piSessionCommands(commands),
      } });
      return snapshot.success ? snapshot.data : { supported: true };
    } catch { return { supported: true }; }
  }

  async changePiSession(input: PiSessionScope & Pick<PiSessionChange, "expectedSession" | "action" | "value">): Promise<PiSessionResult> {
    const controls = getPiNativeControls(this.adapter);
    if (!controls?.getLiveSession || !this.sessionManager.getExistingSession) return { outcome: "rejected", reason: "unsupported" };
    const scope = this.conversationScope(input), mayUse = await this.sessionTurnAccess(scope);
    const session = await this.sessionManager.getExistingSession(scope);
    if (!session || !mayUse(session.sessionId)) return { outcome: "rejected", reason: "stale" };
    const live = controls.getLiveSession(session.sessionId);
    if (!live || piSessionToken(input, session.sessionId, live) !== input.expectedSession) return { outcome: "rejected", reason: "stale" };
    const isCurrent = async () => {
      if (!await this.historyAvailable(scope)) return false;
      if (input.isCurrentSession && !await input.isCurrentSession()) return false;
      const current = await this.sessionManager.getExistingSession!(scope);
      return current?.sessionId === session.sessionId && mayUse(session.sessionId) && !this.historyMutations.has(session.sessionId) && live.isCurrent();
    };
    if (!await isCurrent()) return { outcome: "rejected", reason: "stale" };
    const model = input.action === "model" && input.value !== null ? decodePiModel(input.value) : null;
    const thinking = input.action === "thinking" && input.value !== null ? piSessionThinkingSchema.safeParse(input.value) : undefined;
    if (input.action === "model" && input.value !== null && !model) return { outcome: "rejected", reason: "invalid", detail: { kind: "model_invalid" } };
    if (thinking && !thinking.success) return { outcome: "rejected", reason: "invalid", detail: { kind: "thinking_invalid", allowed: [...piSessionThinkingSchema.options] } };
    try {
      // The handle repeats isCurrent immediately before its actual native write,
      // after any asynchronous lookup of defaults or supported thinking levels.
      const result = input.action === "model"
        ? await live.setModel(model ?? null, { isCurrent })
        : await live.setThinkingLevel(thinking?.success ? thinking.data : null, { isCurrent });
      return await isCurrent() && result.sessionId === session.sessionId ? { outcome: "accepted" } : { outcome: "unknown", reason: "uncertain" };
    } catch (error) {
      // These typed value rejections occur before a write or after an explicit native refusal,
      // including a single-field reset to the Bot default. Post-write reads/guards stay uncertain.
      if (error instanceof PiNativeRejectedError && ["model-unavailable", "thinking-unsupported"].includes(error.reason)) {
        return { outcome: "rejected", reason: "invalid", detail: await piRejectionDetail(error, model ?? null, () => live.listModels()) };
      }
      return { outcome: "unknown", reason: "uncertain" };
    }
  }

  advertisedCommands(): Array<{ name: string; description: string }> {
    return this.adapter.advertisedCommands?.() ?? [];
  }

  hasReceivedAdvertisedCommands(): boolean {
    return this.adapter.hasReceivedAdvertisedCommands?.() ?? false;
  }

  async stopBackgroundWork(input: { chatId: number; conversationKey: string; locale?: "en" | "zh"; scope?: "swarm" | "all" }): Promise<{ stopped: boolean; summary?: string }> {
    if (!this.adapter.stopBackgroundWork || !this.sessionManager.getExistingSession) return { stopped: false };
    const session = await this.sessionManager.getExistingSession(this.conversationScope(input));
    if (!session) return { stopped: false };
    return this.adapter.stopBackgroundWork(session.sessionId, {
      locale: input.locale,
      ...(input.scope ? { scope: input.scope } : {}),
    });
  }

  async listTasks(input: { chatId: number; conversationKey: string }): Promise<EngineTaskSnapshot> {
    if (!this.adapter.listTasks || !this.sessionManager.getExistingSession) return { supported: false, tasks: [] };
    const session = await this.sessionManager.getExistingSession(this.conversationScope(input));
    if (!session) return { supported: true, tasks: [] };
    const snapshot = await this.adapter.listTasks(session.sessionId);
    const current = await this.sessionManager.getExistingSession(this.conversationScope(input));
    return current?.sessionId === session.sessionId ? snapshot : { supported: true, tasks: [] };
  }

  async stopTask(input: { chatId: number; conversationKey: string; taskId: string; isCurrentSession?: () => Promise<boolean> }): Promise<EngineTaskControlResult> {
    if (!this.adapter.stopTask || !this.sessionManager.getExistingSession) return { outcome: "rejected", reason: "unsupported" };
    const session = await this.sessionManager.getExistingSession(this.conversationScope(input));
    if (!session || input.isCurrentSession && !await input.isCurrentSession()) return { outcome: "rejected", reason: "stale" };
    // Recheck the native binding after the async Gateway binding guard. The
    // adapter additionally rejects handles from an old worker or another task.
    const current = await this.sessionManager.getExistingSession(this.conversationScope(input));
    if (current?.sessionId !== session.sessionId) return { outcome: "rejected", reason: "stale" };
    return this.adapter.stopTask(session.sessionId, { taskId: input.taskId });
  }

  sideCapability(input?: { workspaceOverride?: string; tools?: "inherited" }): import("../codex/adapter.js").SideCapability {
    return this.adapter.sideCapability?.(input) ?? { context: "none", concurrent: false, readOnly: "no-tools", residue: "none", seesInProgressTurn: false };
  }

  /** A side session borrows context, never the parent's binding or turn lock. */
  async openSideSession(input: { chatId: number; userId: number; chatType: string; conversationKey: string; workspaceOverride?: string; tools?: "inherited"; locale?: Locale; abortSignal?: AbortSignal }): Promise<import("../codex/adapter.js").EngineSideSession> {
    if (!this.adapter.openSideSession || !this.sessionManager.getExistingSession) throw new Error("unsupported");
    if ((await this.checkAccess(input)).kind !== "allow") throw new Error("unsupported");
    const scope = this.conversationScope(input);
    const session = await this.sessionManager.getExistingSession(scope);
    if (!session || (!this.adapter.acceptsHostSessionKeyForSide && /^(tarobot|telegram)-/.test(session.sessionId))) {
      throw new Error("no_main_session");
    }
    input.abortSignal?.throwIfAborted();
    if (this.waitingForRestart(session.sessionId)) throw new Error("engine_restart_pending");
    if (this.historyMutations.has(session.sessionId)) throw new Error("history_outcome_pending");
    this.sideSessionReaders.set(session.sessionId, (this.sideSessionReaders.get(session.sessionId) ?? 0) + 1);
    let released = false;
    const release = () => { if (released) return; released = true;
      const left = (this.sideSessionReaders.get(session.sessionId) ?? 1) - 1;
      if (left > 0) this.sideSessionReaders.set(session.sessionId, left); else this.sideSessionReaders.delete(session.sessionId); };
    let side: import("../codex/adapter.js").EngineSideSession;
    try {
      await this.sessionManager.assertHistoryAvailable?.(scope);
      if ((await this.sessionManager.getExistingSession(scope))?.sessionId !== session.sessionId) throw new Error("history_source_changed");
      side = await this.adapter.openSideSession({ sourceSessionId: session.sessionId, workspaceOverride: input.workspaceOverride, ...(input.tools ? { tools: input.tools } : {}), locale: input.locale, abortSignal: input.abortSignal });
      if (input.abortSignal?.aborted) { await side.dispose(); input.abortSignal.throwIfAborted(); }
    } catch (error) { release(); throw error; }
    return {
      nativeId: side.nativeId,
      dispose: async () => { try { await side.dispose(); } finally { release(); } },
      send: turn => {
        const guidance = this.options.botInstructionsPath ? botInstructionsGuidance(this.options.botInstructionsPath) : undefined;
        const current = guidance ? { ...turn,
          turnInstructions: [guidance, turn.turnInstructions].filter(Boolean).join("\n\n"),
          ...(turn.appPlatformTools ? { appPlatformTools: withBotFileGuidance(turn.appPlatformTools, guidance) } : {}),
        } : turn;
        return this.options.turnPool
          ? this.options.turnPool.run(() => side.send(current), { signal: turn.abortSignal })
          : side.send(current);
      },
    };
  }

  async recoverSession(input: { chatId: number; conversationKey: string; token: string; isCurrentSession?: () => Promise<boolean> }): Promise<EngineTaskControlResult> {
    if (!this.adapter.recoverSession || !this.sessionManager.getExistingSession) return { outcome: "rejected", reason: "unsupported" };
    const scope = this.conversationScope(input), session = await this.sessionManager.getExistingSession(scope);
    if (!session || !await this.historyAvailable(scope)) return { outcome: "rejected", reason: "stale" };
    if (input.isCurrentSession && !await input.isCurrentSession()) return { outcome: "rejected", reason: "stale" };
    const current = await this.sessionManager.getExistingSession(scope);
    if (current?.sessionId !== session.sessionId || this.historyMutations.has(session.sessionId)) return { outcome: "rejected", reason: "stale" };
    return this.adapter.recoverSession(session.sessionId, { token: input.token });
  }

  async steerActiveTurn(input: {
    chatId: number;
    messageThreadId?: number;
    conversationKey?: string;
    text: string;
    isCurrentTurn?: () => boolean;
    throwOnError?: boolean;
    onOutcome?: (outcome: SteeringApplication) => void; nativeInput?: NativeInputObserver;
  }): Promise<boolean> {
    if (!this.adapter.steerActiveTurn || !this.sessionManager.getExistingSession) {
      if (input.throwOnError) throw new EngineSteeringRejectedError("unsupported");
      return false;
    }
    const scope = this.conversationScope(input), useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const session = await this.sessionManager.getExistingSession(useConversationScope ? scope : input.chatId);
    if (!session || !await this.historyAvailable(scope)) {
      if (input.throwOnError) throw new EngineSteeringRejectedError("stale");
      return false;
    }
    const mayUse = await this.sessionTurnAccess(scope);
    const current = await this.sessionManager.getExistingSession(useConversationScope ? scope : input.chatId);
    if (current?.sessionId !== session.sessionId || this.historyMutations.has(session.sessionId) || input.isCurrentTurn && !input.isCurrentTurn()) {
      if (input.throwOnError) throw new EngineSteeringRejectedError("stale");
      return false;
    }
    // The running native turn belongs to another conversation sharing this
    // session; this conversation's turn is still queued behind it. Write nothing.
    if (!mayUse(session.sessionId)) {
      if (input.throwOnError) throw new EngineSteeringRejectedError("queued");
      return false;
    }
    return await this.adapter.steerActiveTurn(session.sessionId, { text: input.text, throwOnError: input.throwOnError, ...(input.onOutcome ? { onOutcome: input.onOutcome } : {}), ...(input.nativeInput ? { nativeInput: input.nativeInput } : {}) });
  }

  async getThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.getThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = this.sessionManager.getExistingSession
      ? await this.sessionManager.getExistingSession(scope)
      : await this.sessionManager.getOrCreateSession(scope);
    if (!session) {
      return { goal: null };
    }
    const response = await this.adapter.getThreadGoal(session.sessionId, {
      workspaceOverride: input.workspaceOverride,
    });
    // A status query must never change the conversation binding. Only native
    // setup publishes a session; a delayed read cannot undo /reset or /resume.
    return { goal: response.goal };
  }

  async setThreadGoal(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.setThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    return await withBridgeTurnLock(bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.()), async () => {
      const session = await this.sessionManager.getOrCreateSession(scope);
      const response = await this.adapter.setThreadGoal!(session.sessionId, {
        objective: input.objective,
        tokenBudget: input.tokenBudget,
        workspaceOverride: input.workspaceOverride,
      });
      if (response.sessionId) await this.sessionManager.bindSession(scope, response.sessionId);
      return { goal: response.goal };
    });
  }

  private goalSessionIsCurrent(scope: BridgeConversationScope, sessionId: string, external?: () => boolean | Promise<boolean>): () => Promise<boolean> {
    return async () => {
      if (!await this.historyAvailable(scope)) return false;
      if (external && !await external()) return false;
      const current = await this.sessionManager.getExistingSession?.(scope);
      return (!this.sessionManager.getExistingSession || current?.sessionId === sessionId) && !this.historyMutations.has(sessionId);
    };
  }

  async updateThreadGoal(input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    sessionId?: string;
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    objective?: string;
    status?: CodexThreadGoal["status"];
    tokenBudget?: number | null;
    origin?: "user" | "automatic";
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }> {
    if (!this.adapter.updateThreadGoal) throw new Error("Native goal controls are not available for this runtime");
    const scope = this.conversationScope(input);
    // Controls must reach a running goal without waiting behind an attached user
    // turn. The adapter serializes these against native goal initialization.
    const session = await this.sessionManager.getExistingSession?.(scope);
    if (!session || (input.sessionId && input.sessionId !== session.sessionId)) return { goal: null };
    const isCurrentSession = this.goalSessionIsCurrent(scope, session.sessionId, input.isCurrentSession);
    if (!await isCurrentSession()) throw new Error("Goal session binding changed");
    const response = await this.adapter.updateThreadGoal(session.sessionId, {
      isCurrentSession,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
      origin: input.origin ?? "user",
      workspaceOverride: input.workspaceOverride,
    });
    // Never rebind a stale control over a concurrent /reset or /resume.
    return { goal: response.goal };
  }

  async watchThreadGoal(input: {
    sessionId?: string;
    isCurrentSession?: () => boolean | Promise<boolean>;
    mode?: "replace" | "resume" | "observe";
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<{ goal: CodexThreadGoal | null; sessionId?: string }> {
    if (!this.adapter.watchThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    let pursuit!: Promise<{ goal: CodexThreadGoal | null; sessionId?: string }>;
    const start = async () => {
      await this.sessionManager.assertHistoryAvailable?.(scope);
      input.abortSignal?.throwIfAborted();
      const session = input.mode && input.mode !== "replace"
        ? await this.sessionManager.getExistingSession?.(scope)
        : await this.sessionManager.getOrCreateSession(scope);
      if (!session || (input.sessionId && session.sessionId !== input.sessionId)) { pursuit = Promise.resolve({ goal: null }); return; }
      input.abortSignal?.throwIfAborted();
      let published = false, confirmedSessionId: string | undefined, publication: Promise<void> | undefined, releaseStartup!: () => void;
      const startup = new Promise<void>((resolve) => { releaseStartup = resolve; });
      const publish = async (sessionId: string) => {
        publication ??= (input.mode && input.mode !== "replace" ? Promise.resolve() : this.sessionManager.bindSession(scope, sessionId)).then(() => {
          published = true;
          confirmedSessionId = sessionId;
          releaseStartup();
        });
        await publication;
      };
      const isCurrentSession = input.mode && input.mode !== "replace"
        ? this.goalSessionIsCurrent(scope, session.sessionId, input.isCurrentSession) : input.isCurrentSession;
      if (isCurrentSession && !await isCurrentSession()) throw new Error("Goal session binding changed");
      if (this.historyMutations.has(session.sessionId)) throw new EngineHistoryBusyError();
      pursuit = this.adapter.watchThreadGoal!(session.sessionId, {
        ...(isCurrentSession ? { isCurrentSession } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        objective: input.objective,
        tokenBudget: input.tokenBudget,
        workspaceOverride: input.workspaceOverride,
        onEngineEvent: async (event) => {
          if (event.type === "session" && event.sessionId) await publish(event.sessionId);
          await input.onEngineEvent?.(event);
        },
        onApprovalRequest: input.onApprovalRequest,
        abortSignal: input.abortSignal,
      }).then(async (response) => {
        // Older adapters may only confirm their session in the final response.
        // Once published, never revive it over a later /reset or /resume.
        if (!published && response.sessionId) await publish(response.sessionId);
        return { goal: response.goal, sessionId: confirmedSessionId ?? response.sessionId };
      }).finally(releaseStartup);
      // Startup may fail before the outer method can await pursuit.
      void pursuit.catch(() => {});
      // Hold the conversation lock only through native session establishment,
      // so ordinary turns can continue while the goal runs in the background.
      await startup;
    };
    // Existing-goal controls must not wait behind an attached ordinary turn.
    // They observe the existing binding and never publish a new one.
    if (input.mode && input.mode !== "replace") await start();
    else await withBridgeTurnLock(bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.()), start);
    return await pursuit;
  }

  async clearThreadGoal(input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    chatId: number;
    userId?: number;
    chatType?: string;
    messageThreadId?: number;
    conversationKey?: string;
    workspaceOverride?: string;
    origin?: "user" | "automatic";
    /** Native session returned by this watch; cleanup must not follow a later resume. */
    sessionId?: string;
  }): Promise<{ cleared: boolean }> {
    if (!this.adapter.clearThreadGoal) {
      throw new Error("Structured goal API is not available for this runtime");
    }
    const scope = this.conversationScope(input);
    const session = input.sessionId ? { sessionId: input.sessionId } : this.sessionManager.getExistingSession
      ? await this.sessionManager.getExistingSession(scope)
      : await this.sessionManager.getOrCreateSession(scope);
    if (!session) {
      return { cleared: false };
    }
    const isCurrentSession = input.sessionId ? undefined : this.goalSessionIsCurrent(scope, session.sessionId, input.isCurrentSession);
    if (isCurrentSession && !await isCurrentSession()) throw new Error("Goal session binding changed");
    const response = await this.adapter.clearThreadGoal(session.sessionId, {
      ...(isCurrentSession ? { isCurrentSession } : {}),
      workspaceOverride: input.workspaceOverride,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    return { cleared: response.cleared };
  }
}
