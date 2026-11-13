import type { NativeInputAction, NativeInputCapability, NativeInputControlResult, NativeInputObserver } from "../client-protocol/native-input.js";
import type { ClaudeNativeGoalUpdate } from "../codex/claude-native-goal.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import { EngineSteeringRejectedError } from "../codex/adapter.js";
import { botInstructionsGuidance } from "./bot-instructions.js";
import type { EngineTaskSnapshot, EngineTaskControlResult } from "../client-protocol/engine-tasks.js";
import type {
  CodexAdapter,
  AppPlatformTools,
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineContextUsage,
  EngineStreamEvent,
  ExternalSessionInfo,
} from "../codex/adapter.js";
import { findConflictingLockedChatId } from "../state/access-store.js";

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

export interface SessionManagerLike {
  getLockNamespace?(): Promise<string>;
  getOrCreateSession(scope: number | BridgeConversationScope): Promise<{ sessionId: string }>;
  getExistingSession?(scope: number | BridgeConversationScope): Promise<{ sessionId: string } | null>;
  bindSession(scope: number | BridgeConversationScope, sessionId: string): Promise<void>;
}

export interface BridgeConversationScope {
  chatId: number;
  messageThreadId?: number;
  conversationKey?: string;
}

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

export class Bridge {
  readonly supportsTurnScopedEnv: boolean;
  private authenticatedSurface = false;
  /** Native session -> the turn driving it in this process. Conversations bound
   * to one session share it. */
  private sessionTurnOwners = new Map<string, SessionTurnHold>();

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
    return surface;
  }

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
      workspaceOverride: input.workspaceOverride,
    });
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
    return await withBridgeTurnLock(
      scopeLockId,
      async () => await this.handleAuthorizedTurn(input, turnStartedAt, sessionScope, scopeLockId),
      {
        signal: input.abortSignal,
        waitNotifyAfterMs: input.turnLockWaitNotifyAfterMs,
        onWait: input.onTurnLockWait,
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
    const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
      if (event.type === "subagent_activity") {
        if (event.kind === "completed") unfinishedAgents.delete(event.agentId);
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
          const adapterResponse = await this.adapter.sendUserMessage(nativeSessionId, {
            inputOwnerKey: scopeLockId,
            ...(input.reviewAdmission && !receipt && !continuation ? { reviewAdmission: input.reviewAdmission, nativeInput: input.nativeInput } : {}),
            text,
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
            onEngineEvent: handleEngineEvent,
            onNativeGoal: input.onNativeGoal,
            requestOutputDir: input.requestOutputDir,
            workspaceOverride: input.workspaceOverride,
            extraEnv: turnEnvSupported ? input.extraEnv : undefined,
            abortSignal: signal,
            disableRuntimeTimeout: disableRuntimeTimeout || undefined,
            ...(continuation ? { engineRecoveryContinuation: true } : {}),
            ...(input.engineOverride ? { engineOverride: input.engineOverride } : {}),
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
      }), lockWait), lockWait);

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
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason); return; }
          const abort = () => reject(signal!.reason);
          signal?.addEventListener("abort", abort, { once: true });
          void released.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
        });
      }
      options.signal?.throwIfAborted();
    } finally {
      clearTimeout(timer);
    }
  }

  /** A conversation may offer, steer or control the native turn of a session
   * unless another conversation's turn drives it here (a session shared through
   * "use this session" runs their turns in order). */
  private async sessionTurnAccess(scope: BridgeConversationScope): Promise<(sessionId: string) => boolean> {
    const scopeLockId = bridgeConversationLockId(scope, await this.sessionManager.getLockNamespace?.());
    return (sessionId) => {
      const owner = this.sessionTurnOwner(sessionId);
      return owner === undefined || owner.scopeLockId === scopeLockId;
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
    if (!this.adapter.isSessionInputBlocked || !this.sessionManager.getExistingSession) return true;
    const scope = this.conversationScope(input), session = await this.sessionManager.getExistingSession(scope);
    if (!session) return true;
    const current = await this.sessionManager.getExistingSession(scope);
    return current?.sessionId === session.sessionId && !this.adapter.isSessionInputBlocked(session.sessionId);
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
    if (!session || input.isCurrentSession && !await input.isCurrentSession()) return { outcome: "rejected", reason: "stale" };
    const current = await this.sessionManager.getExistingSession(scope);
    if (current?.sessionId !== session.sessionId) return { outcome: "rejected", reason: "binding_changed" };
    if (!mayUse(session.sessionId)) return { outcome: "rejected", reason: "stale" };
    return this.adapter.controlNativeInput(session.sessionId, { inputId: input.inputId, action: input.action });
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
  async openSideSession(input: { chatId: number; userId: number; chatType: string; conversationKey: string; workspaceOverride?: string; tools?: "inherited"; locale?: "en" | "zh"; abortSignal?: AbortSignal }): Promise<import("../codex/adapter.js").EngineSideSession> {
    if (!this.adapter.openSideSession || !this.sessionManager.getExistingSession) throw new Error("unsupported");
    if ((await this.checkAccess(input)).kind !== "allow") throw new Error("unsupported");
    const session = await this.sessionManager.getExistingSession(this.conversationScope(input));
    if (!session || /^(tarobot|telegram)-/.test(session.sessionId)) throw new Error("no_main_session");
    input.abortSignal?.throwIfAborted();
    const side = await this.adapter.openSideSession({ sourceSessionId: session.sessionId, workspaceOverride: input.workspaceOverride, ...(input.tools ? { tools: input.tools } : {}), locale: input.locale, abortSignal: input.abortSignal });
    if (input.abortSignal?.aborted) { await side.dispose(); input.abortSignal.throwIfAborted(); }
    return {
      nativeId: side.nativeId,
      dispose: () => side.dispose(),
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
    if (!session || input.isCurrentSession && !await input.isCurrentSession()) return { outcome: "rejected", reason: "stale" };
    const current = await this.sessionManager.getExistingSession(scope);
    if (current?.sessionId !== session.sessionId) return { outcome: "rejected", reason: "stale" };
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
    const useConversationScope = input.conversationKey !== undefined || input.messageThreadId !== undefined;
    const mayUse = await this.sessionTurnAccess(this.conversationScope(input));
    const session = await this.sessionManager.getExistingSession(
      useConversationScope ? this.conversationScope(input) : input.chatId,
    );
    if (!session || input.isCurrentTurn && !input.isCurrentTurn()) {
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
      if (external && !await external()) return false;
      return !this.sessionManager.getExistingSession || (await this.sessionManager.getExistingSession(scope))?.sessionId === sessionId;
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
