import { randomUUID } from "node:crypto";
import { deliverEngineQuestion } from "./engine-question.js";
import { deliverBackgroundTaskResponse } from "./background-task-delivery.js";
import { createScopedRunPresentation, finishScopedRunPresentation } from "./scoped-run-presentation.js";
import { backgroundTaskBody, backgroundTaskContext, backgroundTaskReplyTo } from "./background-task-notice.js";
import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import { engineEventTimelineMetadata, shouldPersistEngineTimelineEvent } from "../runtime/timeline-events.js";
import { BoardService } from "../state/board-service.js";
import { handleBoardCoreCommand, type BoardCommandContext } from "./shared/board-commands.js";
import { normalizeBoardTaskId } from "../state/board-store.js";
import {
  handleCrewCoreWorkflow,
  type CrewWorkflowContext,
} from "./shared/crew-workflow.js";
import type { BusCrewConfig } from "../bus/bus-config.js";
import { delegationCommand } from "../bus/delegation-plan.js";
import {
  handleDelegationCoreCommand,
  type DelegationCommandBridge,
  type DelegationCommandContext,
} from "./shared/delegation-commands.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import {
  handleMiniBusCoreCommand,
  type MiniBusCommandBridge,
  type MiniBusCommandContext,
} from "./shared/mini-bus-commands.js";
import type { CoreCommandMessage } from "./shared/command-message.js";
import { isGatewayChannel } from "./channel-profile.js";
import type { Locale } from "../runtime/locale.js";
import {
  stableCoreNumericId,
  type CoreNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { renderCoreBoardTaskCard } from "./board-card.js";
import { larkAgentInstructions, larkMediaTaskInstruction } from "./agent-instructions.js";
import { sendCoreCardWithFallback } from "./card-delivery.js";
import { deliverCoreResponse, hasCorePostTurnDelivery, sendCoreMarkdown } from "./delivery.js";
import { renderCoreBackgroundTaskHeader, resolveCoreLocale } from "./locale.js";
import { redactCoreErrorDetail } from "./redaction.js";
import type { CoreActiveRun, CoreServiceRuntime } from "./runtime.js";
import { appendCoreTimelineEvent } from "./timeline.js";
import type { CoreBridgeLike, CoreChannelLike } from "./types.js";

/**
 * Stop-target router for an autonomous /goal pursuit.
 *
 * A running /goal holds its conversation's activeRuns slot for the WHOLE
 * pursuit. Ordinary turns (chat messages, cron fires, board/mini/ask turns)
 * still run while it does — the chat queue already serializes their engine
 * turns behind the goal's turns at the bridge session-lock level; the
 * activeRuns slot is only stop-button/card bookkeeping. Instead of stealing
 * (and previously killing) the pursuit's slot, those turns ATTACH here, and
 * `abort()` — what /stop and every card stop button invoke on the slot's
 * controller — routes to the attached turn first. The resulting stop design:
 *
 * - /stop (or a stop button) while an ordinary turn runs alongside the
 *   pursuit stops that ORDINARY turn; the pursuit survives.
 * - /stop with nothing else running stops the pursuit itself.
 * - `/goal clear` (and a replacing /goal) call `abortGoal()`, which always
 *   ends the pursuit no matter what else is running.
 *
 * Defined here (not runtime.ts/commands.ts) so commands.ts, message-handler.ts
 * and cron.ts can all import it without a module cycle.
 */
export class CoreGoalRunController extends AbortController {
  private readonly concurrentTurns = new Set<CoreActiveRun>();

  /** The attached concurrent turn, if it is still live (not yet aborted). */
  liveConcurrentTurn(): CoreActiveRun | null {
    return [...this.concurrentTurns].reverse().find(turn => !turn.abortController.signal.aborted) ?? null;
  }

  /**
   * Attach an ordinary or concurrent bus turn. Returns a release for this
   * exact turn, so completion cannot discard another cancellation handle.
   */
  attachConcurrentTurn(turn: CoreActiveRun): () => void {
    this.concurrentTurns.add(turn);
    return () => { this.concurrentTurns.delete(turn); };
  }

  detachConcurrentTurn(turn: CoreActiveRun): void { this.concurrentTurns.delete(turn); }

  override abort(reason?: unknown): void {
    const turn = this.liveConcurrentTurn();
    if (turn) {
      for (const concurrent of this.concurrentTurns) concurrent.abortController.abort(reason);
      return;
    }
    super.abort(reason);
  }

  /** End the pursuit itself, bypassing the concurrent-turn stop routing. */
  abortGoal(reason?: unknown): void {
    super.abort(reason);
  }

  /**
   * End the pursuit AND any attached ordinary turn. Used by a replacing /goal,
   * which claims the slot for a new pursuit — leaving either running would
   * orphan it where no stop control can reach it.
   */
  abortAll(reason?: unknown): void {
    for (const turn of this.concurrentTurns) turn.abortController.abort(reason);
    super.abort(reason);
  }
}

/** Questions belong to the turn that asked them, including when that turn is
 * attached to a longer-lived goal or promoted after the goal ends. */
export function isCoreRunActive(runtime: CoreServiceRuntime, conversationKey: string, controller: AbortController): boolean {
  if (controller.signal.aborted) return false;
  const holder = runtime.activeRuns.get(conversationKey);
  const turn = holder?.abortController instanceof CoreGoalRunController
    ? holder.abortController.liveConcurrentTurn()
    : holder;
  return turn?.abortController === controller || [...(runtime.concurrentRuns.get(conversationKey) ?? [])].some(run => run.abortController === controller);
}

/**
 * Claim the conversation's activeRuns slot for a turn — or, when a live /goal
 * pursuit holds the slot, attach the turn to the pursuit as its concurrent
 * turn instead (a pursuit must survive ordinary traffic; see
 * CoreGoalRunController). Returns a guarded release for the claimer's finally
 * block: it deletes the slot only while this turn still owns it (mirroring the
 * cron executor's guard, so a newer handle is never clobbered) and detaches
 * from the pursuit otherwise. A goalWatch holder without routing support (not
 * created by the /goal watcher) is left untouched; the turn still keeps its
 * own cancellation handle in concurrentRuns.
 *
 * `onOccupied` controls what happens when a live NON-goal run already holds the
 * slot: "replace" (default — chat-queue turns and cron, where serialization
 * guarantees any occupant is stale) overwrites it; "leave" (the bus command
 * handlers, which claim speculatively before their command even parses) keeps
 * the occupant and registers a separate cancellation handle, so e.g. a /status probe or an unrelated
 * detached run is never clobbered by a command that turns out to be a no-op.
 */
export function claimCoreRunSlot(
  runtime: CoreServiceRuntime,
  conversationKey: string,
  run: CoreActiveRun,
  options?: { onOccupied?: "replace" | "leave" },
): () => void {
  const active = runtime.activeRuns.get(conversationKey);
  let detach: (() => void) | undefined;
  if (active?.goalWatch) {
    detach = active.abortController instanceof CoreGoalRunController
      ? active.abortController.attachConcurrentTurn(run)
      : undefined;
  } else if (!active || options?.onOccupied !== "leave") {
    runtime.activeRuns.set(conversationKey, run);
  }
  if (active?.goalWatch || active && options?.onOccupied === "leave") {
    const concurrent = runtime.concurrentRuns.get(conversationKey) ?? new Set<CoreActiveRun>();
    concurrent.add(run);
    runtime.concurrentRuns.set(conversationKey, concurrent);
  }
  return () => {
    detach?.();
    // A resumed goal may have adopted this turn after its original claim.
    const holder = runtime.activeRuns.get(conversationKey)?.abortController;
    if (holder instanceof CoreGoalRunController) holder.detachConcurrentTurn(run);
    const concurrent = runtime.concurrentRuns.get(conversationKey);
    concurrent?.delete(run);
    if (!concurrent?.size) runtime.concurrentRuns.delete(conversationKey);
    // The pursuit may have ended mid-turn and promoted this turn into the
    // slot (the /goal watcher's finally), so the guarded delete applies to
    // the attached case too.
    if (runtime.activeRuns.get(conversationKey)?.abortController === run.abortController) {
      runtime.activeRuns.delete(conversationKey);
      const next = [...(concurrent ?? [])].find(candidate => !candidate.abortController.signal.aborted);
      if (next) runtime.activeRuns.set(conversationKey, next);
    }
  };
}

type CoreBusCommandInput = {
  channel: CoreChannelLike;
  bridge: CoreBridgeLike;
  runtime: CoreServiceRuntime;
  stateDir: string;
  instanceName?: string;
  requestApproval: (input: {
    channel: CoreChannelLike;
    runtime: CoreServiceRuntime;
    chatId: string;
    conversationKey?: string;
    bridgeChatType?: "private" | "group";
    requesterUserId?: number;
    replyTo?: string;
    replyInThread?: boolean;
    locale?: Locale;
    request: EngineApprovalRequest;
    abortSignal?: AbortSignal;
  }) => Promise<EngineApprovalDecision>;
};

export async function handleCoreBoardCommand(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveCoreLocale(input.stateDir);
  const abortController = new AbortController();
  const pendingReplies: string[] = [];
  const boardContext: BoardCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        pendingReplies.push(text);
      },
    },
    channel: isGatewayChannel(input.channel) ? "gateway" : "lark",
    instanceName: input.instanceName ?? (isGatewayChannel(input.channel) ? "default" : "lark"),
    cfg: {
      budgetUsd: cfg.budgetUsd,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
      resume: cfg.resume,
    },
    bridge: input.bridge,
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: AbortSignal.any([abortController.signal, ...(request.abortSignal ? [request.abortSignal] : [])]),
    }),
    onEngineEvent: createCoreBusEngineEventHandler(input, normalized, {
      locale,
      source: "board",
      controller: abortController,
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };

  // Register the command's turn(s) under the ORIGINATING conversation so /stop
  // (and the stop button) can reach a running /board run — previously this
  // controller existed but nothing could ever abort it, so /stop reported
  // "nothing running" while the board turn kept going. claimCoreRunSlot attaches
  // to a live /goal pursuit instead of stealing its slot; "leave" keeps any
  // other live occupant (this claim happens before the command even parses);
  // the guarded release mirrors the cron executor's cleanup so a newer claim
  // is never clobbered.
  const releaseRunSlot = claimCoreRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  let handled: boolean;
  try {
    handled = await handleBoardCoreCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      normalized: toBoardCommandMessage(normalized, commandText),
      context: boardContext,
    });
  } finally {
    releaseRunSlot();
  }
  if (!handled) {
    return false;
  }
  for (const reply of pendingReplies) {
    await sendCoreBoardReply({
      channel: input.channel,
      stateDir: input.stateDir,
      normalized,
      commandText,
      reply,
      locale,
    });
  }
  return true;
}

async function sendCoreBoardReply(input: {
  channel: CoreChannelLike;
  stateDir: string;
  normalized: CoreNormalizedBridgeMessage;
  commandText: string;
  reply: string;
  locale: Locale;
}): Promise<void> {
  const showMatch = input.commandText.trim().match(/^\/(?:board|kanban)(?:@\w+)?\s+(?:show|view)\s+(\S+)/i);
  const taskId = showMatch ? normalizeBoardTaskId(showMatch[1]!) : null;
  if (taskId) {
    const task = await new BoardService(input.stateDir).getTask(taskId);
    if (task) {
      await sendCoreCardWithFallback({
        channel: input.channel,
        chatId: input.normalized.chatId,
        card: renderCoreBoardTaskCard({
          task,
          markdown: input.reply,
          locale: input.locale,
          conversationKey: input.normalized.conversationKey,
          bridgeChatType: input.normalized.bridgeChatType,
          bridgeChatId: input.normalized.bridgeChatId,
          replyInThread: Boolean(input.normalized.threadId),
        }),
        fallbackText: input.reply,
        options: coreCommandReplyOptions(input.normalized),
        locale: input.locale,
      });
      return;
    }
  }
  await sendCoreMarkdown(input.channel, input.normalized.chatId, input.reply, coreCommandReplyOptions(input.normalized));
}

function toBoardCommandMessage(
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): CoreCommandMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleCoreMiniBusCommand(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveCoreLocale(input.stateDir);
  const abortController = new AbortController();
  const context: MiniBusCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await deliverCoreBusReply(input, normalized, text, resolveInstanceWorkspacePath(cfg));
      },
    },
    channel: isGatewayChannel(input.channel) ? "gateway" : "lark",
    instanceName: input.instanceName ?? (isGatewayChannel(input.channel) ? "default" : "lark"),
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: input.runtime.miniRuntime?.runQueuedBridgeTurn
      ?? (async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job)),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: AbortSignal.any([abortController.signal, ...(request.abortSignal ? [request.abortSignal] : [])]),
    }),
    onEngineEvent: createCoreBusEngineEventHandler(input, normalized, {
      locale,
      source: "mini",
      controller: abortController,
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };
  const bridge: MiniBusCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage({
      ...bridgeInput,
      instructions: larkAgentInstructions({
        engine: cfg.engine,
        claudeChrome: cfg.claudeChrome,
        timezone: cfg.timezone,
        context: "bus",
      }),
      turnInstructions: larkMediaTaskInstruction(bridgeInput.text),
    }),
  };

  // Same stop wiring as the board handler above: register under the originating
  // conversation so a running /mini or /ask turn is abortable via /stop and the
  // stop button instead of being an untracked controller nothing ever aborts.
  const releaseRunSlot = claimCoreRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  try {
    return await handleMiniBusCoreCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      cfg: {
        budgetUsd: cfg.budgetUsd,
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        resume: cfg.resume,
      },
      normalized: toMiniBusCommandMessage(normalized, commandText),
      context,
      bridge,
    });
  } finally {
    releaseRunSlot();
  }
}

function toMiniBusCommandMessage(
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): CoreCommandMessage {
  // Historical salts are persisted Mini Bus routing identities, not transports.
  const groupChatId = normalized.bridgeChatType === "group"
    ? stableCoreNumericId(`lark-group:${normalized.chatId}`)
    : normalized.bridgeChatId;
  const messageThreadId = normalized.threadId
    ? stableCoreNumericId(`lark-thread:${normalized.threadId}`)
    : undefined;

  return {
    chatId: groupChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleCoreDelegationCommand(
  input: CoreBusCommandInput & { agentBusMembers?: string[] },
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveCoreLocale(input.stateDir);
  // /ask (cross-instance delegation) previously ran with NO abort signal at
  // all: /stop said "nothing running" while the delegated turn kept going.
  // Same stop wiring as the board/mini handlers: a controller registered under
  // the originating conversation, its signal threaded through the context.
  const abortController = new AbortController();
  const agentBusRun = input.runtime.busRuntime?.agentBusRun;
  if (agentBusRun?.signal.aborted) abortController.abort();
  else agentBusRun?.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  const context: DelegationCommandContext = {
    ...createCoreBusReplyContext(input, normalized, resolveInstanceWorkspacePath(cfg)),
    channel: isGatewayChannel(input.channel) ? "gateway" : "lark",
    instanceName: input.instanceName ?? (isGatewayChannel(input.channel) ? "default" : "lark"),
    abortSignal: abortController.signal,
    onEngineEvent: createCoreBusEngineEventHandler(input, normalized, {
      locale,
      source: "delegation",
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };
  const bridge: DelegationCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => {
      const delegatedInput: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] = {
        ...bridgeInput,
        workspaceOverride: bridgeInput.workspaceOverride,
        instructions: larkAgentInstructions({
          engine: cfg.engine,
          claudeChrome: cfg.claudeChrome,
          timezone: cfg.timezone,
          context: "bus",
        }),
        turnInstructions: larkMediaTaskInstruction(bridgeInput.text),
      };
      if (bridgeInput.chatType !== "bus") {
        delegatedInput.conversationKey = normalized.conversationKey;
      }
      // An Agent Bus run is self-contained: its local answer also uses an
      // independent temporary session, like its members and crew coordinator.
      // The conversation key still orders the turn behind other chat work.
      if (agentBusRun && !delegatedInput.sessionIdOverride) delegatedInput.sessionIdOverride = `tarobot-bus-${randomUUID()}`;
      return await input.bridge.handleAuthorizedMessage(delegatedInput);
    },
  };

  const releaseRunSlot = claimCoreRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  try {
    return await handleDelegationCoreCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      cfg: {
        budgetUsd: cfg.budgetUsd,
        disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
        resume: cfg.resume,
      },
      normalized: toDelegationCommandMessage(normalized, commandText),
      context,
      bridge,
      loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
      delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
      ...(agentBusRun && input.agentBusMembers ? { agentBusMembers: input.agentBusMembers } : {}),
    });
  } finally {
    releaseRunSlot();
  }
}

export async function handleCoreCrewWorkflow(
  input: CoreBusCommandInput & {
    abortSignal?: AbortSignal;
    /** Task-local crew; the Bot's saved bus.crew stays untouched. */
    crewConfig?: BusCrewConfig;
  },
  normalized: CoreNormalizedBridgeMessage,
  prompt: string,
): Promise<boolean> {
  if (normalized.attachments.length > 0) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveCoreLocale(input.stateDir);
  const context: CrewWorkflowContext = {
    ...createCoreBusReplyContext(input, normalized, resolveInstanceWorkspacePath(cfg)),
    channel: isGatewayChannel(input.channel) ? "gateway" : "lark",
    instanceName: input.instanceName ?? (isGatewayChannel(input.channel) ? "default" : "lark"),
    abortSignal: input.abortSignal,
    bridge: {
      handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage({
        ...bridgeInput,
        instructions: larkAgentInstructions({
          engine: cfg.engine,
          claudeChrome: cfg.claudeChrome,
          timezone: cfg.timezone,
          context: "bus",
        }),
        turnInstructions: larkMediaTaskInstruction(bridgeInput.text),
      }),
    },
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: AbortSignal.any([...(input.abortSignal ? [input.abortSignal] : []), ...(request.abortSignal ? [request.abortSignal] : [])]),
    }),
    onEngineEvent: createCoreBusEngineEventHandler(input, normalized, {
      locale,
      source: "crew",
      signal: input.abortSignal,
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };

  return await handleCrewCoreWorkflow({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
      resume: cfg.resume,
    },
    normalized: toDelegationCommandMessage(normalized, prompt),
    context,
    loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
    delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
    ...(input.crewConfig ? { crewConfig: input.crewConfig } : {}),
    ...(input.runtime.busRuntime?.agentBusRun ? { agentBus: true } : {}),
  });
}

/** Runs one Hub-dispatched Agent Bus input through the existing delegation or
 * research-crew workflow. Members come from the Hub run snapshot, never from
 * the prompt; Bus permission, budget and cancellation checks are unchanged. */
export async function handleCoreAgentBusRun(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  activateRun: () => AbortController,
): Promise<boolean> {
  const run = normalized.agentBus;
  if (!run) return false;
  const observer = input.runtime.busRuntime?.agentBusRun;
  if (observer?.signal.aborted) {
    const locale = await resolveCoreLocale(input.stateDir);
    await sendCoreMarkdown(input.channel, normalized.chatId, locale === "zh" ? "协作已停止，任务未启动。" : "Collaboration stopped before the task started.", coreCommandReplyOptions(normalized));
    return true;
  }
  observer?.started();
  const prompt = normalized.text.trim();
  if (run.mode !== "crew") return await handleCoreDelegationCommand({ ...input, agentBusMembers: run.members }, normalized, delegationCommand(run.mode, run.members, prompt));
  const controller = activateRun();
  const [researcher, analyst, writer, reviewer] = run.members;
  const handled = researcher && analyst && writer && reviewer && await handleCoreCrewWorkflow({
    ...input,
    abortSignal: observer ? AbortSignal.any([controller.signal, observer.signal]) : controller.signal,
    crewConfig: { enabled: true, workflow: "research-report", coordinator: input.instanceName ?? (isGatewayChannel(input.channel) ? "default" : "lark"), roles: { researcher, analyst, writer, reviewer },
      maxResearchQuestions: run.maxResearchQuestions, maxRevisionRounds: run.maxRevisionRounds },
  }, { ...normalized, attachments: [] }, prompt);
  if (!handled) {
    const locale = await resolveCoreLocale(input.stateDir);
    await sendCoreMarkdown(input.channel, normalized.chatId, locale === "zh" ? "研究团队任务未启动：成员配置无效。" : "Research crew was not started: invalid members.", coreCommandReplyOptions(normalized));
  }
  return true;
}

function coreCommandReplyOptions(normalized: CoreNormalizedBridgeMessage): { replyTo: string; replyInThread: boolean } {
  return {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  };
}

/** A completed engine turn does not prove its requested output was delivered.
 * Keep this receipt separate from stage execution and preserve failed/stopped
 * workflow outcomes. Throwing on an incomplete receipt would enter the chain
 * or verify recovery path and could resend already delivered artifact markers. */
function createCoreBusReplyContext(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  workspaceOverride?: string,
): Pick<DelegationCommandContext, "api" | "onHandleOutcome"> {
  const run = input.runtime.busRuntime?.agentBusRun;
  let deliveryFailed = false;
  return {
    api: { sendMessage: async (_chatId: number, text: string) => {
      if (!await deliverCoreBusReply(input, normalized, text, workspaceOverride)) deliveryFailed = true;
    } },
    ...(run ? { onHandleOutcome: (outcome, detail) => {
      if (deliveryFailed && outcome === "success") run.outcome("error", "agent_bus_output_not_delivered");
      else run.outcome(outcome, detail);
    } } : {}),
  };
}

async function deliverCoreBusReply(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  text: string,
  workspaceOverride?: string,
): Promise<boolean> {
  if (!hasCorePostTurnDelivery(text)) {
    await sendCoreMarkdown(
      input.channel,
      normalized.chatId,
      text,
      coreCommandReplyOptions(normalized),
    );
    return true;
  }
  const delivered = await deliverCoreResponse({
    channel: input.channel,
    runtime: input.runtime,
    chatId: normalized.chatId,
    ...coreCommandReplyOptions(normalized),
    text,
    stateDir: input.stateDir,
    workspaceOverride,
    conversationKey: normalized.conversationKey,
    bridgeChatType: normalized.bridgeChatType,
    bridgeChatId: normalized.bridgeChatId,
    bridgeUserId: normalized.bridgeUserId,
    larkThreadId: normalized.threadId,
    larkMessageId: normalized.messageId,
    instanceName: input.instanceName,
  });
  return delivered.ok;
}

function createCoreBusEngineEventHandler(
  input: CoreBusCommandInput,
  normalized: CoreNormalizedBridgeMessage,
  options: {
    locale: "en" | "zh";
    source: string;
    controller?: AbortController;
    signal?: AbortSignal;
    workspaceOverride?: string;
  },
): (event: EngineStreamEvent) => Promise<void> {
  const scopedRuns = createScopedRunPresentation({ channel: input.channel, chatId: normalized.chatId,
    conversationKey: normalized.conversationKey, replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId), locale: options.locale });
  return async (event) => {
    if (event.type === "scoped") { await scopedRuns.apply(event); return; }
    if (shouldPersistEngineTimelineEvent(event)) {
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "engine.event",
        detail: event.type,
        metadata: {
          source: options.source,
          ...engineEventTimelineMetadata(event),
        },
      });
    }

    if (await deliverEngineQuestion(event, { ...input, chatId: normalized.chatId,
      conversationKey: normalized.conversationKey, bridgeChatType: normalized.bridgeChatType,
      replyTo: normalized.messageId, replyInThread: Boolean(normalized.threadId), locale: options.locale,
      abortSignal: options.controller?.signal ?? options.signal,
      isCurrentTurn: () => options.controller ? isCoreRunActive(input.runtime, normalized.conversationKey, options.controller) : !!options.signal && !options.signal.aborted && (input.runtime.activeRuns.get(normalized.conversationKey)?.abortController.signal === options.signal || [...(input.runtime.concurrentRuns.get(normalized.conversationKey) ?? [])].some(run => run.abortController.signal === options.signal)),
    })) return;

    if (event.type !== "task_notification" || event.settlesCurrentTurn || event.suppressUserDelivery) {
      if (event.type === "task_notification") await finishScopedRunPresentation({ channel: input.channel, conversationKey: normalized.conversationKey,
        replyTo: backgroundTaskReplyTo(event, normalized.messageId, input.channel.profile) }, event);
      return;
    }

    const notificationText = [
      renderCoreBackgroundTaskHeader(options.locale, event.status),
      backgroundTaskContext(event, options.locale),
      backgroundTaskBody(event, options.locale).trim(),
    ].filter(Boolean).join("\n");

    try {
      await deliverBackgroundTaskResponse({
        channel: input.channel,
        runtime: input.runtime,
        chatId: normalized.chatId,
        replyTo: backgroundTaskReplyTo(event, normalized.messageId, input.channel.profile),
        replyInThread: Boolean(backgroundTaskReplyTo(event, normalized.messageId, input.channel.profile) && normalized.threadId),
        text: notificationText,
        stateDir: input.stateDir,
        workspaceOverride: options.workspaceOverride,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        bridgeChatId: normalized.bridgeChatId,
        bridgeUserId: normalized.bridgeUserId,
        larkThreadId: normalized.threadId,
        larkMessageId: normalized.messageId,
        instanceName: input.instanceName,
      }, event, options.locale);
    } catch (error) {
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "engine.event.delivery_failed",
        outcome: "error",
        detail: redactCoreErrorDetail(error),
        metadata: {
          source: options.source,
          eventType: event.type,
        },
      });
    }
  };
}

function toDelegationCommandMessage(
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): CoreCommandMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}
