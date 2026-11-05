import { isBotControl } from "../client-protocol/bot-messages.js";
import { backgroundTaskBody, backgroundTaskContext, backgroundTaskReplyTo } from "./background-task-notice.js";
import { createRunRecord, recordRunEvent } from "./run-record.js";
import { createScopedRunPresentation, finishScopedRunPresentation } from "./scoped-run-presentation.js";
import { channelProfile } from "./channel-profile.js";
import { workspaceArtifactRoot } from "./artifact-paths.js";
import { applyGatewayGroupMode, gatewayNativeCommandHelp } from "./platform-policy.js";
import { gatewayRequiresMention } from "./platform-policy.js";
import { stripAlreadyDeliveredAppArtifacts, type AppDeliveryReceipt, type AppDeliveryCache } from "./app-delivery.js";
import { isCloudAsrCancelledError, isCloudAsrRequiredError } from "../runtime/asr-cloud.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { EngineStreamEvent } from "../codex/adapter.js";
import { EngineCancellationUnconfirmedError, EngineSteeringRejectedError, EngineStopTooLateError, EngineNativeInputUnsentError } from "../codex/adapter.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import type { ChatQueueWaitEvent } from "../runtime/chat-queue.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import type { TurnPoolWaitEvent } from "../runtime/turn-pool.js";
import { engineEventTimelineMetadata, shouldPersistEngineTimelineEvent } from "../runtime/timeline-events.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import {
  hasConversationResume,
  migrateLegacyConversationResume,
  resolveConversationResume,
} from "../runtime/conversation-resume.js";
import { SessionStore } from "../state/session-store.js";
import {
  DEFAULT_STEER_WINDOW_SECONDS,
  loadInstanceConfig,
  resolveInstanceWorkspacePath,
  updateInstanceConfig,
  type ResumeState,
} from "../state/instance-config.js";
import { createDefaultTranscribeVoice } from "../core/voice.js";
import { CoreGoalRunController, claimCoreRunSlot, handleCoreAgentBusRun, handleCoreCrewWorkflow, isCoreRunActive } from "./bus.js";
import {
  larkAgentInstructions,
  larkMediaTaskInstruction,
  mergeTurnInstructions,
} from "./agent-instructions.js";
import {
  stopCoreConversation,
  handleCoreApprovalTextCommand,
  isCoreApprovalTextCommand,
  renderCoreConversationStop,
  requestCoreApproval,
} from "./card-actions.js";
import { deliverCoreContinuationCards, sendCoreCardWithFallback } from "./card-delivery.js";
import {
  ELEMENT_CONTENT_MAX_BYTES,
  CORE_CARD_ANSWER_MAX,
  CORE_MAX_OVERFLOW_CARDS,
  applyCoreEngineEvent,
  cleanCardText,
  hasCoreFileBlockDirective,
  initialCoreRunState,
  liveRunCardStreamElement,
  renderCoreNotificationCard,
  renderCoreQueueWaitCard,
  renderCoreQueueLifecycleCard,
  renderCoreRunCard,
  renderCoreRunCardCompact,
  renderCoreRunCardMinimal,
  resolveCoreFinalAnswerText,
  splitCoreAnswerIntoCardChunks,
  trimToStreamSafeBoundary,
  type CoreRunState,
} from "./card-renderer.js";
import {
  extractCoreMessageBody,
  formatCoreAccessReply,
  handleCoreBgCommandText,
  handleCoreGroupCommandBeforeAccess,
  handleCoreSimpleCommand,
  isCoreBgCommand,
  isCoreLocalEngineCommand,
  isStopCommand,
} from "./commands.js";
import {
  deliverCoreResponse,
  deliverCoreUserInputRequest,
  hasCorePostTurnDelivery,
  sendCoreMarkdown,
  sendTrackedCoreChoiceCard,
  trackCoreChoiceCard,
} from "./delivery.js";
import {
  buildCoreDeliveryRepairBase,
  isCoreDeliveryFollowupRequest,
  coreDeliveryFollowupInstruction,
  coreDeliveryFollowupRepairPrompt,
  coreDeliveryPreflightRepairPrompt,
  preflightCoreResponseDeliveryDirectives,
  renderCoreMergedDeliveryRepairDirectives,
  renderCoreDeliveryPreflightFailure,
  renderUnverifiedCoreDeliveryClaim,
  shouldRepairCoreDeliveryFollowup,
} from "./delivery-followup.js";
import { isReplaySafeCoreToolName, isSuspectedStaleCoreResponse } from "./stale-response-guard.js";
import {
  hasTranscribableMediaExtension,
  hasTranscribableVideoExtension,
} from "../runtime/media-extensions.js";
import {
  formatBridgeMediaTranscript,
  formatBridgePartialMediaTranscript,
  isPartialMediaTranscriptionError,
} from "../runtime/media-transcript.js";
import {
  formatPreparedVideoInput,
  prepareVideoInput,
  type PreparedVideoInput,
} from "../runtime/video-input.js";
import {
  deliveryLedgerEnabled,
  markDeliveryAttempting,
  markDeliveryDelivered,
  markDeliveryFailed,
  recordDeliveryObligation,
} from "../state/delivery-obligation-store.js";
import { LARK_OVERFLOW_DOC_MIN_CHARS, postLarkOverflowAnswerDoc } from "./overflow-doc.js";
import { renderCoreUserFacingError } from "./errors.js";
import { CoreGroupModeStore } from "./group-mode-store.js";
import { CoreKnownChatStore } from "./known-chats.js";
import {
  renderCoreBackgroundTaskHeader,
  renderCoreChatAccessDenied,
  renderCoreConversationQueueWait,
  renderCoreAudioTranscriptionFailure,
  renderCoreQueuedTaskSkipped,
  renderCoreTurnPoolWait,
  resolveCoreLocale,
} from "./locale.js";
import {
  boundCoreArchiveSummary,
  cleanupCoreMessageArtifacts,
  downloadCoreAttachments,
  prepareCoreFileWorkflow,
  renderCoreArchiveSummaryCard,
  renderCoreArchiveSummaryText,
  safeSegment,
  type DownloadedCoreAttachment,
} from "./files.js";
import {
  buildCoreConversationKey,
  normalizeCoreMessage,
  splitMessageContext,
  stableCoreNumericId,
  type CoreChatMode,
  type CoreIncomingMessage,
  type CoreNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { sendManagedCard, updateManagedCard, updateManagedCardElement, type ManagedCardHandle } from "./managed-card.js";
import { redactCoreErrorDetail } from "./redaction.js";
import { isTaroCubCoreSlashCommand } from "./slash-command-registry.js";
import { verifyCoreNumericIds } from "./id-map.js";
import type { CoreQueueCardRef, CoreServiceRuntime, PendingCoreBatch } from "./runtime.js";
import { type LarkReactionSettings, withLarkMessageReactions } from "./reactions.js";
import type { CoreBridgeLike, CoreChannelLike, CoreFetchedMessage, CoreSendOptions } from "./types.js";
import type { Locale } from "../runtime/locale.js";
import { appendCoreTimelineEvent } from "./timeline.js";

const defaultTranscribeLarkMedia = createDefaultTranscribeVoice();
const defaultPrepareLarkVideoInput = prepareVideoInput;

type CoreTurnUsage = Awaited<ReturnType<CoreBridgeLike["handleAuthorizedMessage"]>>["usage"];

function mergeCoreTurnUsage(first: CoreTurnUsage, second: CoreTurnUsage): CoreTurnUsage {
  if (!first) return second;
  if (!second) return first;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    ...(
      first.cachedTokens !== undefined || second.cachedTokens !== undefined
        ? { cachedTokens: (first.cachedTokens ?? 0) + (second.cachedTokens ?? 0) }
        : {}
    ),
    ...(
      first.costUsd !== undefined || second.costUsd !== undefined
        ? { costUsd: (first.costUsd ?? 0) + (second.costUsd ?? 0) }
        : {}
    ),
  };
}

/**
 * How long a chat's resolved session mode (conversation vs topic form) is cached.
 * Short enough that toggling a group's 群消息形式 takes effect within the window
 * without a service restart, long enough to avoid a chat.get on every message.
 */
const CHAT_FORM_CACHE_TTL_MS = 30_000;

function coreReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): CoreSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }
  return replyInThread ? { replyTo, replyInThread: true } : { replyTo };
}

function isWholeResponseFileBlockText(text: string): boolean {
  const fileMatch = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/);
  return Boolean(
    fileMatch
    && fileMatch[1]?.trim()
    && Buffer.byteLength(fileMatch[2] ?? "", "utf8") > 0
    && text.replace(fileMatch[0], "").trim().length === 0,
  );
}

type CoreTurnTermination =
  | { kind: "interrupted" }
  | { kind: "idle_timeout"; minutes: number }
  | { kind: "error" };

/**
 * Classify why an engine turn ended in error so the run card can show the
 * right terminal marker: user/stop interruption, an idle-timeout auto-stop
 * (the adapter kills a turn that goes silent for N minutes), or a real error.
 */
// Exported for focused testing: this predicate is what feeds the reaction layer's
// `isFailure` gate. A turn ended by the user (/stop, abort) or by the idle watchdog
// must classify as interrupted/idle_timeout — NOT "error" — so it is not stamped with
// the failure reaction.
export function classifyCoreTurnTermination(error: unknown, signal: AbortSignal | undefined): CoreTurnTermination {
  if (error instanceof EngineCancellationUnconfirmedError || error instanceof EngineStopTooLateError) return { kind: "error" };
  const text = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const idleMatch = text.match(/inactive after (\d+)\s*minute/);
  if (idleMatch) {
    return { kind: "idle_timeout", minutes: Number.parseInt(idleMatch[1] ?? "0", 10) || 0 };
  }
  // "stopped by user" / "task was stopped" are our adapters' explicit user-stop
  // messages. A bare "aborted" also appears in engine-INTERNAL AbortErrors (e.g.
  // reconnect exhaustion), so it only counts as a user interruption when the
  // caller's abort signal actually fired — which `signal?.aborted` covers.
  if (signal?.aborted || /\b(stopped by user|task was stopped)\b/.test(text)) {
    return { kind: "interrupted" };
  }
  return { kind: "error" };
}

function isAwaitedUnmentionedCoreAttachment(
  runtime: CoreServiceRuntime,
  normalized: CoreNormalizedBridgeMessage,
  exactConversation = true,
): boolean {
  if (normalized.bridgeChatType !== "group" || normalized.attachments.length === 0) {
    return false;
  }
  const batches = exactConversation
    ? [runtime.pendingBatches.get(normalized.conversationKey)]
    : [...runtime.pendingBatches.values()].filter((batch) => batch.normalized.chatId === normalized.chatId);
  return batches.some((batch) => (
    batch?.awaitingAttachment === true
    && batch.normalized.senderId === normalized.senderId
  ));
}

export async function handleCoreMessage(input: {
  channel: CoreChannelLike;
  bridge: CoreBridgeLike;
  runtime: CoreServiceRuntime;
  stateDir: string;
  instanceName?: string;
  message: CoreIncomingMessage;
  requireMentionInGroup?: boolean;
  workspaceOverride?: string;
  reactionSettings?: LarkReactionSettings;
}): Promise<boolean> {
  const requireMentionInGroup = await resolveCoreMessageMentionRequirement({
    stateDir: input.stateDir,
    message: input.message,
    defaultRequireMentionInGroup: input.requireMentionInGroup,
  });
  const preflightNormalized = normalizeCoreMessage(input.message, {
    requireMentionInGroup,
  });
  if (!preflightNormalized) {
    const unmentionedCandidate = normalizeCoreMessage(input.message, { requireMentionInGroup: false });
    if (
      !unmentionedCandidate
      || !isAwaitedUnmentionedCoreAttachment(input.runtime, unmentionedCandidate, false)
    ) {
      return false;
    }
  }

  const message = await resolveCoreMessageChatMode(input.channel, input.runtime, input.message);
  let baseNormalized = normalizeCoreMessage(message, {
    requireMentionInGroup,
  });
  if (!baseNormalized) {
    const unmentionedCandidate = normalizeCoreMessage(message, { requireMentionInGroup: false });
    if (
      !unmentionedCandidate
      || !isAwaitedUnmentionedCoreAttachment(input.runtime, unmentionedCandidate)
    ) {
      return false;
    }
    baseNormalized = unmentionedCandidate;
  }
  const expandedNormalized = await enrichCoreMergedForwardContext(input.channel, baseNormalized, message);
  const cardNormalized = await enrichCoreInteractiveCardContext(input.channel, expandedNormalized, message);
  const normalized = await enrichCoreReplyContext(input.channel, cardNormalized);
  return await runAcceptedCoreMessage(input, normalized);
}

async function resolveCoreMessageChatMode(
  channel: CoreChannelLike,
  runtime: CoreServiceRuntime,
  message: CoreIncomingMessage,
): Promise<CoreIncomingMessage> {
  if (message.chatType === "p2p") {
    return { ...message, chatMode: "p2p" };
  }
  const now = Date.now();
  // An explicitly-provided mode (e.g. tests) wins.
  if (message.chatMode) {
    cacheCoreChatMode(runtime, message.chatId, message.chatMode, now);
    return { ...message };
  }
  const cached = runtime.chatModeCache.get(message.chatId);
  if (cached && cached.expiresAt > now) {
    return { ...message, chatMode: cached.mode };
  }
  if (cached) runtime.chatModeCache.delete(message.chatId);
  // Resolve the chat's message form. Topic form (a native topic group, or a
  // conversation group switched to the topic message form) isolates each topic;
  // conversation form shares one group session. We map both to "topic"/"group"
  // so larkSessionThreadIdForMessage isolates only the former. Cached briefly so
  // toggling 群消息形式 takes effect without a restart.
  const mode = await resolveCoreChatSessionMode(channel, message.chatId);
  if (mode) {
    cacheCoreChatMode(runtime, message.chatId, mode, now);
    return { ...message, chatMode: mode };
  }
  // Couldn't determine the form (no channel support, or a transient error): do
  // NOT cache, so the next message retries. A threaded message is most likely a
  // topic (isolate to avoid bleeding contexts); a plain one is a group.
  return { ...message, chatMode: message.threadId ? "topic" : "group" };
}

const LARK_CHAT_MODE_CACHE_MAX_ENTRIES = 1_000;

function cacheCoreChatMode(runtime: CoreServiceRuntime, chatId: string, mode: CoreChatMode, now: number): void {
  for (const [key, entry] of runtime.chatModeCache) {
    if (entry.expiresAt <= now) runtime.chatModeCache.delete(key);
  }
  if (!runtime.chatModeCache.has(chatId) && runtime.chatModeCache.size >= LARK_CHAT_MODE_CACHE_MAX_ENTRIES) {
    const oldestKey = runtime.chatModeCache.keys().next().value as string | undefined;
    if (oldestKey) runtime.chatModeCache.delete(oldestKey);
  }
  runtime.chatModeCache.set(chatId, { mode, expiresAt: now + CHAT_FORM_CACHE_TTL_MS });
}

/**
 * Resolve whether a group chat should isolate each topic ("topic") or share one
 * session ("group"). Prefers the topic-message-form signal (chat_mode='topic'
 * OR group_message_type='thread'); falls back to chat_mode alone, then gives up
 * (undefined) so the caller can apply a transient default without caching it.
 */
async function resolveCoreChatSessionMode(
  channel: CoreChannelLike,
  chatId: string,
): Promise<"topic" | "group" | undefined> {
  if (channel.getChatTopicForm) {
    try {
      return (await channel.getChatTopicForm(chatId)) ? "topic" : "group";
    } catch {
      // Transient failure of the precise signal: don't downgrade to the coarser
      // chat_mode (which can't see group_message_type and would mislabel a
      // thread-form group as shared). Give up so the caller retries uncached.
      return undefined;
    }
  }
  // Older channel without topic-form support: chat_mode is the best we have.
  if (channel.getChatMode) {
    try {
      return (await channel.getChatMode(chatId)) === "topic" ? "topic" : "group";
    } catch {
      // fall through to the caller's transient default
    }
  }
  return undefined;
}

async function runAcceptedCoreMessage(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: CoreNormalizedBridgeMessage,
): Promise<boolean> {
  await recordKnownCoreChat(input.stateDir, normalized);
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "input.received",
    outcome: "accepted",
    metadata: {
      messageId: normalized.messageId,
      attachments: normalized.attachments.length,
    },
  });
  await verifyCoreNumericIds(input.stateDir, normalized);

  const commandText = extractCoreMessageBody(normalized.text);
  const messageLocale = await resolveCoreLocale(input.stateDir);
  if (normalized.agentBus) {
    // A Hub-owned Agent Bus input is likewise always a new queued task, but its
    // saved mode (not its text) selects the existing delegation/crew command.
    queuePendingCoreBatchNow(input, normalized.conversationKey, messageLocale);
    return enqueueCoreTurn(input, normalized, messageLocale, async () => undefined);
  }
  if (normalized.groupDiscussion) {
    // A Hub-owned group discussion turn is always a new queued task. Its text is
    // the user's topic, never a slash command, card answer, approval, steering
    // input or part of an attachment batch.
    queuePendingCoreBatchNow(input, normalized.conversationKey, messageLocale);
    return enqueueCoreTurn(input, normalized, messageLocale, async () => undefined);
  }
  if (normalized.botSource) {
    // A signed Bot input is always a new queued task. Never run card-answer,
    // approval, steering, batching, /stop or other pre-queue control handlers.
    if (isBotControl(commandText)) throw new Error("bot_message_control_forbidden");
    queuePendingCoreBatchNow(input, normalized.conversationKey, messageLocale);
    return enqueueCoreTurn(input, normalized, messageLocale, async () => undefined);
  }
  if (isStopCommand(commandText)) {
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: normalized.bridgeAccessChatId,
        conversationChatId: normalized.bridgeChatId,
        userId: normalized.bridgeUserId,
        chatType: normalized.bridgeChatType,
        conversationKey: normalized.conversationKey,
        locale: messageLocale,
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      await input.channel.send(normalized.chatId, {
        text: formatCoreDeniedAccessReply(accessDecision.text ?? renderCoreChatAccessDenied(messageLocale), normalized, messageLocale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "denied",
        detail: "/stop",
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
    const stopped = await stopCoreConversation(input.runtime, normalized.conversationKey, input.stateDir);
    const { active, droppedBurst } = stopped;
    const stopText = renderCoreConversationStop(stopped, messageLocale);
    if (stopText) {
      await input.channel.send(normalized.chatId, { text: stopText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
    }
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled",
      outcome: active || droppedBurst ? "success" : "noop",
      detail: "/stop",
      ...(droppedBurst ? { metadata: { cancelledPendingBurst: droppedBurst.members.length } } : {}),
    });
    return true;
  }

  // Shared access gate for the pre-queue command fast paths below: a denied
  // sender gets the standard denial reply, an allowed one proceeds. Mirrors the
  // inline checks the /stop and approval blocks run.
  const checkPreQueueAccess = async (detail: string): Promise<boolean> => {
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: normalized.bridgeAccessChatId,
        conversationChatId: normalized.bridgeChatId,
        userId: normalized.bridgeUserId,
        chatType: normalized.bridgeChatType,
        conversationKey: normalized.conversationKey,
        locale: messageLocale,
      })
      : { kind: "allow" as const };
    if (accessDecision.kind === "allow") {
      return true;
    }
    await input.channel.send(normalized.chatId, {
      text: formatCoreDeniedAccessReply(accessDecision.text ?? renderCoreChatAccessDenied(messageLocale), normalized, messageLocale),
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendCoreTimelineEvent(input.stateDir, normalized, detail === "message"
      ? {
        type: "turn.completed",
        outcome: "denied",
        detail: "access denied",
      }
      : {
        type: "command.handled",
        outcome: "denied",
        detail,
        metadata: { rejected: "unauthorized-user" },
      });
    return false;
  };

  // /bg is instance-scoped process control, independent of the conversation
  // session — run it pre-queue like /stop so it is never serialized behind the
  // running turn (a wedged engine turn must not block "what's running / kill it").
  if (isCoreBgCommand(commandText)) {
    if (!(await checkPreQueueAccess("/bg"))) {
      return true;
    }
    const message = await handleCoreBgCommandText(commandText, messageLocale);
    if (message !== null) {
      await sendCoreMarkdown(input.channel, normalized.chatId, message, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "success",
        detail: "/bg",
      });
    }
    return true;
  }

  // Native client alternatives must run before Feishu-specific group/VC
  // handlers, which can mutate the shared fleet access configuration.
  if (channelProfile() === "gateway") {
    const command = commandText.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s|$)/i)?.[1]?.toLowerCase();
    const explanation = command && gatewayNativeCommandHelp(command, messageLocale);
    if (explanation) {
      if (!(await checkPreQueueAccess(`/${command}`))) return true;
      const text = command === "group"
        ? await applyGatewayGroupMode(input.stateDir, normalized.chatId, normalized.bridgeChatType === "group", commandText.trim().split(/\s+/).slice(1).join(" ").toLowerCase(), messageLocale, input.requireMentionInGroup !== false)
        : explanation;
      await sendCoreMarkdown(input.channel, normalized.chatId, text, { replyTo: normalized.messageId, replyInThread: Boolean(normalized.threadId) });
      await appendCoreTimelineEvent(input.stateDir, normalized, { type: "command.handled", outcome: "success", detail: `/${command}`, metadata: { surface: "gateway", alternative: "native" } });
      return true;
    }
  }

  // /meeting is VC bot-meeting control (experimental, gated). Runs pre-queue
  // like /bg: joining/leaving a meeting must not serialize behind a running
  // turn. When the feature is disabled (the default), reply with how to enable
  // it instead of silently treating the command as a normal message.
  if (/^\/meeting\b/i.test(commandText)) {
    if (!(await checkPreQueueAccess("/meeting"))) {
      return true;
    }
    const meetingReply = input.runtime.meetingSupport
      ? await input.runtime.meetingSupport.handleMeetingCommand(commandText, messageLocale, {
          mentionOpenIds: extractMeetingMentionOpenIds(
            normalized.mentions,
            (input.channel as unknown as { botIdentity?: { openId?: string } }).botIdentity?.openId,
          ),
        })
      : (messageLocale === "zh"
        ? "VC 入会功能未启用。在 `~/.cctb/<instance>/config.json` 中设置 `\"meeting\": {\"enabled\": true}` 并重启后可用。注意：机器人入会接口需要飞书侧 beta 白名单，详见 docs/full-reference.md。"
        : "VC meeting support is disabled. Set `\"meeting\": {\"enabled\": true}` in `~/.cctb/<instance>/config.json` and restart. Note: the bot-join API additionally requires Feishu-side beta allowlisting; see docs/full-reference.md.");
    if (meetingReply !== null) {
      await sendCoreMarkdown(input.channel, normalized.chatId, meetingReply, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "success",
        detail: "/meeting",
      });
    }
    return true;
  }

  if (await handleCoreGroupCommandBeforeAccess({ ...input, requestApproval: requestCoreApproval }, normalized, commandText, messageLocale)) {
    return true;
  }

  if (isCoreApprovalTextCommand(commandText)) {
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: normalized.bridgeAccessChatId,
        conversationChatId: normalized.bridgeChatId,
        userId: normalized.bridgeUserId,
        chatType: normalized.bridgeChatType,
        conversationKey: normalized.conversationKey,
        locale: messageLocale,
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      await input.channel.send(normalized.chatId, {
        text: formatCoreDeniedAccessReply(accessDecision.text ?? renderCoreChatAccessDenied(messageLocale), normalized, messageLocale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: "denied",
        detail: "approval",
        metadata: { rejected: "unauthorized-user" },
      });
      return true;
    }
    const approvalResult = await handleCoreApprovalTextCommand({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      userId: normalized.bridgeUserId,
      replyInThread: Boolean(normalized.threadId),
      text: commandText,
      locale: messageLocale,
    });
    if (approvalResult.handled) {
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "command.handled",
        outcome: approvalResult.outcome,
        detail: "approval",
        metadata: {
          command: "approval",
          choice: approvalResult.choice,
          ...(approvalResult.requestId ? { requestId: approvalResult.requestId } : {}),
          ...(approvalResult.reason ? { reason: approvalResult.reason } : {}),
        },
      });
    }
    return approvalResult.handled;
  }

  // Reject/pair before batching or entering the conversation queue. Otherwise
  // an unknown DM sender can occupy the single-chat queue during the pairing
  // window and delay the actual owner even though the turn will never run.
  if (!(await checkPreQueueAccess("message"))) {
    return true;
  }

  const handleConversationQueueWait = async (event: ChatQueueWaitEvent): Promise<void> => {
    // If the user already cancelled this queued task from its card, do not
    // re-render a "queued" wait card. The cancel tap terminalizes the card to
    // "cancelled"; a wait notification that fires just after (in-flight) would
    // otherwise overwrite it back to "queued" — the reported flicker-then-revert.
    const taskStillPending = (): boolean => {
      const queue = input.runtime.chatQueue as typeof input.runtime.chatQueue & {
        isPending?: (chatId: string | number, taskId: string) => boolean;
      };
      // Preserve compatibility with lightweight queue stubs used by embedders.
      // The real ChatQueue exposes isPending and closes the async send race.
      return typeof queue.isPending !== "function"
        || queue.isPending(normalized.conversationKey, normalized.messageId);
    };
    if (input.runtime.cancelledQueueTaskIds.has(normalized.messageId) || !taskStillPending()) {
      return;
    }
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "engine.lock.waiting",
      detail: "waiting for Lark conversation queue",
      metadata: {
        waitedMs: event.waitedMs,
        reason: event.reason,
      },
    });
    try {
      const card = renderCoreQueueWaitCard({
        profile: input.channel.profile,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        taskId: normalized.messageId,
        waitedMs: event.waitedMs,
        replyInThread: Boolean(normalized.threadId),
        locale: messageLocale,
      });
      // Reuse a single card across repeated wait notifications, and remember it
      // so the run card can take it over (queued → running → done) instead of
      // leaving a stale "queued" card behind once the task starts.
      const existing = input.runtime.queueCards.get(normalized.messageId);
      if (existing) {
        if (await updateCoreQueueCardInPlace(input.channel, existing, card)) {
          if (!taskStillPending()) {
            input.runtime.queueCards.delete(normalized.messageId);
            await settleLingeringCoreQueueCard(input.channel, existing, messageLocale);
          }
          return;
        }
        // In-place refresh failed and a fresh card replaces it below: recall the
        // stale card so its live Cancel/Wait buttons can't linger and mislead.
        input.runtime.queueCards.delete(normalized.messageId);
        if (input.channel.recallMessage) {
          await input.channel.recallMessage(existing.messageId).catch(() => undefined);
        }
      }
      // Prefer a CardKit managed card so the cancel tap can flip it to "已取消"
      // IN PLACE (CardKit survives a post-interaction update; im.message.patch
      // reverts a just-clicked card). Fall back to a normal inline card when
      // CardKit is unavailable.
      const managed = await sendManagedCard(input.channel, normalized.chatId, card, {
        replyTo: normalized.messageId,
        ...(normalized.threadId ? { replyInThread: true } : {}),
      });
      if (managed) {
        const ref = { messageId: managed.messageId, handle: managed };
        if (!taskStillPending()) {
          await settleLingeringCoreQueueCard(input.channel, ref, messageLocale);
          return;
        }
        input.runtime.queueCards.set(normalized.messageId, ref);
        return;
      }
      const sent = await sendCoreCardWithFallback({
        channel: input.channel,
        chatId: normalized.chatId,
        card,
        fallbackText: renderCoreConversationQueueWait(messageLocale),
        options: coreReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
        locale: messageLocale,
      });
      if (!sent.fallback) {
        const ref = { messageId: sent.messageId };
        if (!taskStillPending()) {
          await settleLingeringCoreQueueCard(input.channel, ref, messageLocale);
          return;
        }
        input.runtime.queueCards.set(normalized.messageId, ref);
      }
    } catch (error) {
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "engine.event.delivery_failed",
        outcome: "error",
        detail: redactCoreErrorDetail(error),
        metadata: {
          eventType: "engine.lock.waiting",
          phase: "queue",
        },
      });
    }
  };

  const queueEscape = parseCoreQueueEscape(commandText);
  if (queueEscape?.kind === "bare") {
    // Gate the usage reply behind access like every other post-accept handler:
    // an unauthorized sender must not be able to probe the bot with a bare /q.
    if (!(await checkPreQueueAccess("/q"))) {
      return true;
    }
    await input.channel.send(normalized.chatId, {
      text: messageLocale === "zh"
        ? "用法：/q <消息> — 强制作为独立任务排队执行（不注入当前正在运行的任务）。"
        : "Usage: /q <message> — force the message to run as its own queued turn (never steered into the running one).",
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled", outcome: "success", detail: "/q",
    });
    return true;
  }
  // /q strips its slash prefix so the engine sees clean text. Strip it off
  // normalized.text directly with a prefix regex rather than .replace(commandText,
  // payload): a string replacement would interpret $-sequences in the payload
  // ("/q price $$100" → "$100"), and a mention-normalized commandText ("/q@bot …")
  // is no longer a substring of the raw text, so the old strip silently no-op'd and
  // leaked "/q@bot" into the prompt.
  const effectiveNormalized = queueEscape
    ? { ...normalized, text: stripCoreQueuePrefix(normalized.text) }
    : normalized;

  // FIFO: /q and quoted replies deliberately never JOIN an attachment burst
  // (shouldBatchLarkMessage excludes both), so with a burst still parked in its
  // quiet window they used to enqueue AHEAD of images the user sent earlier —
  // inverting send order and answering the caption before the pictures exist.
  // Flush the burst first; this message then queues behind it.
  let flushedBatchAhead = false;
  if (
    (queueEscape || normalized.replyContext) &&
    input.runtime.pendingBatches.has(normalized.conversationKey)
  ) {
    flushedBatchAhead = queuePendingCoreBatchNow(
      input,
      normalized.conversationKey,
      messageLocale,
    );
  }
  if (queueEscape && flushedBatchAhead) {
    await input.channel.send(normalized.chatId, {
      text: messageLocale === "zh"
        ? "已先提交上一批附件；这条消息已紧接着排队。"
        : "Submitted the earlier attachment batch first; this message is queued immediately after it.",
    }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
  }

  // A /q message must never batch (preempt-batch mode would merge it into another
  // turn and break its "runs as its own queued turn" guarantee) and must never
  // steer. Treat queueEscape like a command for the batch decision and skip the
  // steer path, so it always lands on the single-turn queued path with preempt
  // suppressed (preemptActiveLarkTurnIfEnabled gets the original slash-shaped
  // commandText below, so isSlashCommand keeps it a no-op).
  if (!queueEscape && !input.channel.ownsMessageQueueSlot?.(normalized.chatId, normalized.messageId) && shouldBatchCoreMessage(input.runtime, effectiveNormalized, commandText)) {
    const pending = scheduleBatchedCoreTurn(
      input,
      effectiveNormalized,
      commandText,
      messageLocale,
      handleConversationQueueWait,
    );
    input.channel.releaseMessageAdmission?.();
    return await pending;
  }

  if (!queueEscape && await trySteerActiveCoreTurn(input, effectiveNormalized, commandText, messageLocale)) {
    return true;
  }

  // Pass the ORIGINAL command text: a /q message stays slash-shaped here so an
  // explicit preempt policy does not abort the turn the user asked to queue behind.
  await preemptActiveCoreTurnIfEnabled(input, effectiveNormalized, commandText, messageLocale);

  return await enqueueCoreTurn(input, effectiveNormalized, messageLocale, handleConversationQueueWait);
}

function extractMeetingMentionOpenIds(mentions: readonly unknown[], botOpenId?: string): string[] {
  const ids: string[] = [];
  for (const mention of mentions) {
    const record = isRecord(mention) ? mention : {};
    if (record.isBot === true || record.is_bot === true) continue;
    const identity = isRecord(record.id) ? record.id : {};
    const openId = [identity.openId, identity.open_id, record.openId, record.open_id]
      .find((value): value is string => typeof value === "string" && value.startsWith("ou_"));
    if (openId && openId !== botOpenId && !ids.includes(openId)) ids.push(openId);
  }
  return ids;
}

const LARK_QUEUE_ESCAPE_RE = /^\/(?:q|queue)(?:\s+([\s\S]+))?$/i;

function parseCoreQueueEscape(commandText: string): { kind: "bare" } | { kind: "payload"; payload: string } | null {
  const match = commandText.trim().match(LARK_QUEUE_ESCAPE_RE);
  if (!match) {
    return null;
  }
  const payload = match[1]?.trim();
  return payload ? { kind: "payload", payload } : { kind: "bare" };
}

// Strip a leading "/q" / "/queue" (+ optional "@botname") prefix from the body of
// normalized.text, leaving the rest verbatim. Feishu bodies follow their context
// envelope; App bodies start at the beginning. Anchoring on that boundary
// keeps the envelope intact and works whether or not the slash command carried a
// group @-mention. A function-free literal replace would be enough here (no $ in
// the matched prefix), but we cut the prefix by index to avoid any replacement-
// string semantics touching the payload.
const LARK_QUEUE_PREFIX_RE = /^(\s*\/(?:q|queue)(?:@[\w.-]+)?)(?:[ \t]+|(?=\n)|$)/i;

function stripCoreQueuePrefix(text: string): string {
  const { envelope, body: tail } = splitMessageContext(text);
  // The body starts after the envelope's trailing whitespace; strip the prefix
  // from the body and re-join with the original separator preserved.
  const leadingWs = tail.match(/^\s*/)?.[0] ?? "";
  const body = tail.slice(leadingWs.length);
  return `${envelope}${leadingWs}${body.replace(LARK_QUEUE_PREFIX_RE, "")}`;
}

async function enqueueCoreTurn(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: CoreNormalizedBridgeMessage,
  locale: "zh" | "en",
  onWait: (event: ChatQueueWaitEvent) => Promise<void>,
): Promise<boolean> {
  if (input.channel.ownsMessageQueueSlot?.(normalized.chatId, normalized.messageId)) {
    input.channel.releaseMessageAdmission?.();
    return runNormalizedCoreMessage(input, normalized);
  }
  const pending = input.runtime.chatQueue.enqueue(normalized.conversationKey, async () => {
    return await runNormalizedCoreMessage(input, normalized);
  }, {
    taskId: normalized.messageId,
    waitNotifyAfterMs: 10_000,
    onWait,
    onSkipped: async () => {
      // A task the user cancelled from its card was already acknowledged (card
      // updated to "cancelled") by the stop handler — stay silent here so the
      // skip doesn't post a duplicate notice.
      if (input.runtime.cancelledQueueTaskIds.delete(normalized.messageId)) {
        input.runtime.queueCards.delete(normalized.messageId);
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "skipped",
          detail: "queued turn cancelled by user",
          metadata: { phase: "queue" },
        });
        return true;
      }
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "skipped",
        detail: "queued turn skipped",
        metadata: {
          phase: "queue",
        },
      });
      // A skipped turn must not leave its "queued" card spinning forever.
      const queuedRef = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      const skippedText = renderCoreQueuedTaskSkipped(locale);
      if (queuedRef && await updateCoreQueueCardInPlace(input.channel, queuedRef, input.channel.profile === "gateway" ? renderCoreQueueLifecycleCard({ profile: "gateway", taskId: normalized.messageId, conversationKey: normalized.conversationKey }, "skipped", skippedText) : {
        schema: "2.0",
        config: { update_multi: true },
        body: {
          direction: "vertical",
          padding: "12px 12px 12px 12px",
          elements: [{ tag: "markdown", content: skippedText }],
        },
      })) {
        return true;
      }
      await input.channel.send(normalized.chatId, { text: skippedText }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    },
  });
  input.channel.releaseMessageAdmission?.();
  return await pending;
}

/**
 * Update a "queued" card in place. Prefers CardKit (lands even right after the
 * user taps the card's cancel button, where im.message.patch reverts), falling
 * back to im.message.patch for a plain inline card. Returns whether the in-place
 * update landed; on false the caller sends a fresh card/notice instead.
 */
async function updateCoreQueueCardInPlace(
  channel: CoreChannelLike,
  ref: CoreQueueCardRef,
  card: Record<string, unknown>,
): Promise<boolean> {
  if (ref.handle) {
    return await updateManagedCard(channel, ref.handle, card);
  }
  if (channel.updateCard) {
    try {
      await channel.updateCard(ref.messageId, card);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function settleLingeringCoreQueueCard(
  channel: CoreChannelLike,
  ref: CoreQueueCardRef,
  locale: "zh" | "en",
): Promise<void> {
  // A queued task ran without a run card taking this "queued" card over — most
  // commonly a slash command, which handleLarkSimpleCommand processes and returns
  // from before the run-card hand-off (that hand-off is what normally transitions
  // the card in place). The task's real outcome was already posted as its own
  // message, so this card is now stale. Recall it for a clean thread; if the
  // channel can't recall, at least flip it out of the "排队中" state so its
  // now-dead Cancel/Wait buttons can't mislead the user into thinking it's stuck.
  if (channel.recallMessage) {
    await channel.recallMessage(ref.messageId).catch(() => undefined);
    return;
  }
  await updateCoreQueueCardInPlace(channel, ref, {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{ tag: "markdown", content: locale === "en" ? "✅ Done." : "✅ 已结束。" }],
    },
  }).catch(() => undefined);
}

async function transitionQueuedCoreCardToStarted(
  channel: CoreChannelLike,
  runtime: CoreServiceRuntime,
  normalized: CoreNormalizedBridgeMessage,
  locale: "zh" | "en",
): Promise<void> {
  const queuedRef = runtime.queueCards.get(normalized.messageId);
  if (!queuedRef) {
    return;
  }

  const hasMedia = normalized.attachments.some((attachment) =>
    attachment.kind === "audio"
    || attachment.kind === "video"
    || (attachment.kind === "file" && hasTranscribableMediaExtension(attachment.fileName ?? "")));
  const hasAttachments = normalized.attachments.length > 0;
  const progressText = locale === "en"
    ? hasMedia
      ? "Queue finished. Downloading and transcribing the media now; the model will continue automatically when it is ready."
      : hasAttachments
        ? "Queue finished. Reading the attachments now; processing will continue automatically when they are ready."
        : "Queue finished. This task has started processing."
    : hasMedia
      ? "已结束排队，正在转写音视频（包含下载准备）；完成后会自动交给模型继续处理。"
      : hasAttachments
        ? "已结束排队，正在读取附件；完成后会自动继续处理。"
        : "已结束排队，当前任务已经开始处理。";
  const state: CoreRunState = {
    ...initialCoreRunState(normalized.conversationKey, normalized.bridgeChatType),
    blocks: [{ kind: "text", content: progressText, streaming: false }],
    footer: null,
  };
  const card = channel.profile === "gateway"
    ? renderCoreQueueLifecycleCard({ profile: "gateway", taskId: normalized.messageId, conversationKey: normalized.conversationKey }, "started", progressText)
    : renderCoreRunCard(state, locale);
  if (await updateCoreQueueCardInPlace(channel, queuedRef, card)) {
    return;
  }

  // If the in-place transition failed, remove the misleading live queue card.
  // The regular run-card path will create a fresh card after preparation.
  runtime.queueCards.delete(normalized.messageId);
  if (channel.recallMessage) {
    await channel.recallMessage(queuedRef.messageId).catch(() => undefined);
  }
}

function shouldBatchCoreMessage(
  runtime: CoreServiceRuntime,
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
): boolean {
  if (isSlashCommand(commandText)) {
    return false;
  }
  // Opt-in text batching (batch / preempt-batch queue modes): private chats
  // only. In a group, text on one conversationKey can come from DIFFERENT
  // users; merging would run a second user's text under the first sender's
  // authorization (and attribution). p2p has a single sender, so it's safe.
  if (
    runtime.queuePolicy.batchWindowMs > 0 &&
    normalized.bridgeChatType === "private" &&
    normalized.attachments.length === 0
  ) {
    return true;
  }
  // Always-on attachment-burst coalescing (p2p AND groups): an
  // attachment-bearing message opens (or joins) a short quiet window, and a
  // follow-up from the SAME sender (typically the caption text) joins it.
  // Group safety: only one sender's burst ever merges — a different sender
  // neither joins nor disturbs the pending burst. Quoted replies keep their
  // own path (their composed quote would be lost in a merge).
  if (normalized.replyContext) {
    return false;
  }
  const pending = runtime.pendingBatches.get(normalized.conversationKey);
  if (pending && pending.normalized.senderId !== normalized.senderId) {
    return false;
  }
  if (normalized.attachments.length > 0) {
    return true;
  }
  return pending !== undefined || announcesUpcomingCoreAttachment(commandText);
}

async function preemptActiveCoreTurnIfEnabled(
  input: { bridge: CoreBridgeLike; runtime: CoreServiceRuntime },
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<void> {
  if (!input.runtime.queuePolicy.preempt || isSlashCommand(commandText)) {
    return;
  }
  const active = input.runtime.activeRuns.get(normalized.conversationKey);
  if (!active && input.runtime.chatQueue.pendingCount(normalized.conversationKey) === 0) {
    return; // nothing to preempt or clear — skip the access round-trip
  }
  const pendingBeforeAuthorization = input.runtime.chatQueue.pendingTaskSnapshot(normalized.conversationKey);
  // Authorization BEFORE the abort (same bridge.checkAccess pattern as the
  // steer path): preempting used to run pre-access, so in preempt mode an
  // unauthorized group member's message could kill an authorized user's active
  // turn. On deny, do nothing here — the queued path renders the denial reply
  // exactly as it does today.
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeAccessChatId,
      conversationChatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale,
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    return;
  }
  if (active?.goalWatch) {
    // A pursued /goal survives ordinary traffic even under an explicit preempt
    // policy (only /stop and /goal clear end it): replace just the concurrently
    // running ordinary turn, if one is attached — never the pursuit itself.
    if (active.abortController instanceof CoreGoalRunController) {
      active.abortController.liveConcurrentTurn()?.abortController.abort();
    }
  } else {
    active?.abortController.abort();
  }
  // Later /q admissions were never part of this preemption request.
  for (const id of pendingBeforeAuthorization) input.runtime.chatQueue.cancel(normalized.conversationKey, id);
}

// Always-on quiet window that coalesces an attachment burst (e.g. a multi-image
// send from the mobile picker, which arrives as N separate messages) plus the
// same sender's caption text into ONE turn — instead of N turns where only one
// carries the question. Independent of the opt-in batch queue mode. 500ms
// (operator-tuned): a drag-drop batch arrives back-to-back over one WS
// connection, and the window RESETS on every join, so only the gap between
// consecutive messages must fit — while a lone image only costs 0.5s latency.
const LARK_ATTACHMENT_BURST_WINDOW_MS = 500;

// A text-first request such as "我发你个图" and its image are separate Feishu
// messages. Hold only explicit attachment announcements long enough for a human
// to pick and send the file; ordinary text still enters the queue immediately.
const LARK_ANNOUNCED_ATTACHMENT_WINDOW_MS = 15_000;

function announcesUpcomingCoreAttachment(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  const attachment = "(?:截图|图片?|照片|文件|附件|文档|表格|压缩包|视频|音频|录音)";
  const send = "(?:发(?!现|布|票|生|挥|明|起|热|言|的)|传|上传|补发|贴)";
  const resendFailureQuestion = new RegExp(
    `我(?:再|又).{0,8}${send}.{0,12}${attachment}.{0,12}(?:还是|又|也).{0,8}(?:打不开|看不到|收不到|读不到|识别不了)`,
  );
  if (resendFailureQuestion.test(normalized)) {
    return false;
  }
  const chineseTimedAnnouncement = new RegExp(
    `(?:马上|待会儿?|等会儿?|等下|稍后|随后|接着|下一(?:条|个)|下条|一会儿?|这就|我(?:会|准备|打算|马上|待会儿?|等会儿?|等下|稍后|随后|接着|先|再|这就)).{0,8}${send}.{0,16}${attachment}`,
  );
  const chineseImmediateAnnouncement = new RegExp(
    `(?:^|[，。！？!?\\s])我(?:先|再)?${send}(?:给你|你|过来)?(?:一|两|几)?(?:个|张|份|组|段)?${attachment}(?:给你|过来)?`,
  );
  const englishAnnouncement = /\b(?:i(?:['’]ll| will| am going to|['’]m going to| am about to)|let me|next message(?: will)?)\s+(?:(?:send|share)\s+(?:you\s+)?(?:an?\s+|the\s+|this\s+|that\s+|my\s+)?(?:image|photo|picture|screenshot|file|attachment|document|pdf|video|audio)\b|(?:upload|attach|post)\b.{0,40}\b(?:image|photo|picture|screenshot|file|attachment|document|pdf|video|audio)\b)/i;
  return chineseTimedAnnouncement.test(normalized)
    || chineseImmediateAnnouncement.test(normalized)
    || englishAnnouncement.test(normalized);
}

const LARK_STEER_ACK_EMOJI = "OK";

/**
 * Inject a follow-up message into the conversation's currently running engine
 * turn instead of queueing it behind the turn (Codex app-server turn/steer or
 * DeepSeek Harness session steer; engines without steer support simply return false here). Only a plain text
 * message steers: slash commands keep their command semantics, attachments
 * need the staging pipeline, an explicit preempt policy keeps its
 * replace-the-turn behavior, an existing queued backlog keeps FIFO order, and
 * a run older than LARK_STEER_ELIGIBILITY_WINDOW_MS no longer accepts steers.
 * A steer definitively rejected before admission falls back to the queue.
 * An uncertain native receipt must never replay an already-admitted instruction.
 */
async function trySteerActiveCoreTurn(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
  },
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: Locale,
): Promise<boolean> {
  // App users choose steering explicitly; ordinary sends always use the queue.
  if (input.channel.profile === "gateway") return false;
  if (typeof input.bridge.steerActiveTurn !== "function") {
    return false;
  }
  if (input.runtime.queuePolicy.preempt || isSlashCommand(commandText)) {
    return false;
  }
  // Gate on the BODY (commandText = extractLarkMessageBody output), not on
  // normalized.text: the Feishu surface also carries a context envelope, so
  // it is never empty and the empty-message guard was dead — a content-less
  // message (e.g. a sticker/unsupported type) would "steer" pure envelope
  // metadata into the running turn.
  if (normalized.attachments.length > 0 || !normalized.text.trim() || !commandText.trim()) {
    return false;
  }
  // A quoted reply gets its quoted text composed into the prompt inside
  // handleAuthorizedMessage; steering passes normalized.text only, which
  // would silently drop the quote — queue those normally instead.
  if (normalized.replyContext) {
    return false;
  }
  // A pending attachment burst owns same-conversation follow-ups: the caption
  // text must join its images, not be steered into the running turn.
  if (input.runtime.pendingBatches.get(normalized.conversationKey)) {
    return false;
  }
  const activeRun = input.runtime.activeRuns.get(normalized.conversationKey);
  if (!activeRun) {
    return false;
  }
  // A live /goal pursuit holds the conversation's activeRuns slot for its WHOLE
  // life, and ordinary turns ATTACH to it rather than replacing it (see
  // LarkGoalRunController in bus.ts). Two consequences for steering:
  //  - The pursuit itself is never steerable. Injecting an unrelated chat message
  //    into a running pursuit derails the autonomous objective, and the sender
  //    only ever sees an OK reaction — never an answer. Per the established
  //    stop design, only /stop and `/goal clear` touch a pursuit.
  //  - When an ordinary turn IS attached (that is what the engine is actually
  //    running), steer THAT turn — and age it by ITS startedAt. The slot holder's
  //    startedAt is the GOAL's start time, so measuring the window against it
  //    killed steering for the entire conversation for the pursuit's whole life.
  const attachedTurn = activeRun.abortController instanceof CoreGoalRunController
    ? activeRun.abortController.liveConcurrentTurn()
    : null;
  if (activeRun.goalWatch && !attachedTurn) {
    return false;
  }
  const steerTarget = attachedTurn ?? activeRun;
  // Steering policy is instance config (/steer command): off → always queue;
  // window N seconds (default 30, operator decision 2026-07-12: a task deep in
  // progress must not be derailed mid-flight) → later messages queue as their
  // own turn; 0 → unlimited (steer any time). Loaded only when a turn is
  // actually active, so the idle path stays free of the config read.
  const steerCfg = await loadInstanceConfig(input.stateDir);
  if (steerCfg.steerEnabled === false) {
    return false;
  }
  const steerWindowSeconds = steerCfg.steerWindowSeconds ?? DEFAULT_STEER_WINDOW_SECONDS;
  if (
    steerWindowSeconds > 0 &&
    steerTarget.startedAt !== undefined &&
    Date.now() - steerTarget.startedAt > steerWindowSeconds * 1000
  ) {
    return false;
  }
  if (input.runtime.chatQueue.pendingCount(normalized.conversationKey) > 0) {
    return false;
  }
  // The normal path is authorized inside handleAuthorizedMessage; steering
  // bypasses it, so an explicit check is required here — otherwise an
  // unauthorized group member could inject text into an authorized user's
  // running turn. On deny, fall back silently: the queued path renders the
  // denial exactly as it does today.
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeAccessChatId,
      conversationChatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale,
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    return false;
  }
  let steered = false;
  // Capability/binding lookup cannot inject a message, so a failed lookup can
  // safely use the ordinary queue. After native admission starts, it cannot.
  try {
    if (input.channel.canSteerConversation && !await input.channel.canSteerConversation(normalized.chatId)) return false;
  } catch { return false; }
  const isCurrentTurn = () => input.runtime.activeRuns.get(normalized.conversationKey) === activeRun
    && !steerTarget.abortController.signal.aborted
    && (!attachedTurn || (activeRun.abortController instanceof CoreGoalRunController
      && activeRun.abortController.liveConcurrentTurn() === attachedTurn));
  if (!isCurrentTurn()) return false;
  try {
    steered = await input.bridge.steerActiveTurn({
      chatId: normalized.bridgeAccessChatId,
      conversationKey: normalized.conversationKey,
      text: normalized.text,
      isCurrentTurn,
      throwOnError: true,
    });
  } catch (error) {
    if (error instanceof EngineSteeringRejectedError) return false;
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "command.handled", outcome: "unknown", detail: "steer",
      metadata: { eventType: "engine.turn.steer_uncertain" },
    });
    await sendCoreMarkdown(input.channel, normalized.chatId, locale === "en"
      ? "The Bot may have received this follow-up, but its receipt could not be confirmed. It has not been queued again. Check the Bot's reply before resending to avoid duplicate work."
      : "这条补充可能已被 Bot 接收，但暂时无法确认回执，因此没有再次排队。请先核对 Bot 的回复，再决定是否重发，避免重复执行。", {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    }).catch(async () => {
      // A failed warning must not invite an upstream retry of native admission.
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "engine.event", outcome: "error", detail: "steer receipt notice delivery failed",
        metadata: { eventType: "engine.turn.steer_notice_failed" },
      });
    });
    return true;
  }
  if (!steered) {
    return false;
  }
  if (input.channel.addReaction) {
    await input.channel.addReaction(normalized.messageId, LARK_STEER_ACK_EMOJI).catch(() => undefined);
  }
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "engine.event",
    outcome: "success",
    metadata: { eventType: "engine.turn.steered" },
  });
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "command.handled",
    outcome: "success",
    detail: "steer",
    metadata: { eventType: "engine.turn.steered" },
  });
  return true;
}

function isSlashCommand(text: string): boolean {
  return isTaroCubCoreSlashCommand(text);
}

function scheduleBatchedCoreTurn(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: CoreNormalizedBridgeMessage,
  commandText: string,
  locale: "zh" | "en",
  onWait: (event: ChatQueueWaitEvent) => Promise<void>,
): Promise<boolean> {
  const configuredWindowMs = input.runtime.queuePolicy.batchWindowMs;
  const announcesAttachment = normalized.attachments.length === 0
    && announcesUpcomingCoreAttachment(commandText);
  // Stamp each attachment with its carrier message: after a merge the batch's
  // messageId is the NEWEST member, but Feishu resource downloads require the
  // original carrier message_id for each file_key.
  const stampedAttachments = normalized.attachments.map((attachment) => ({
    ...attachment,
    sourceMessageId: attachment.sourceMessageId ?? normalized.messageId,
  }));
  const existing = input.runtime.pendingBatches.get(normalized.conversationKey);
  if (existing) {
    clearTimeout(existing.timer);
    if (configuredWindowMs <= 0) {
      if (stampedAttachments.length > 0) {
        existing.awaitingAttachment = false;
      } else if (announcesAttachment) {
        existing.awaitingAttachment = true;
      }
    }
    existing.normalized = {
      ...existing.normalized,
      messageId: normalized.messageId,
      // Merge on the raw MEMBERS (envelope + body + attachments each), not on the
      // already-merged text — see mergeBatchedTexts.
      text: mergeBatchedTexts([...existing.members, normalized]),
      asrRoutingText: [...existing.members, normalized].map(member => member.asrRoutingText ?? member.text).join("\n"),
      attachments: [...existing.normalized.attachments, ...stampedAttachments],
    };
    existing.texts.push(normalized.text);
    existing.members.push(normalized);
    existing.onWait = onWait;
    const windowMs = configuredWindowMs > 0
      ? configuredWindowMs
      : existing.awaitingAttachment
        ? LARK_ANNOUNCED_ATTACHMENT_WINDOW_MS
        : LARK_ATTACHMENT_BURST_WINDOW_MS;
    return new Promise<boolean>((resolve, reject) => {
      existing.resolve.push(resolve);
      existing.reject.push(reject);
      existing.timer = setTimeout(() => {
        void flushBatchedCoreTurn(input, normalized.conversationKey, locale);
      }, windowMs);
      existing.timer.unref?.();
    });
  }

  const awaitingAttachment = configuredWindowMs <= 0 && announcesAttachment;
  const windowMs = configuredWindowMs > 0
    ? configuredWindowMs
    : awaitingAttachment
      ? LARK_ANNOUNCED_ATTACHMENT_WINDOW_MS
      : LARK_ATTACHMENT_BURST_WINDOW_MS;
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      void flushBatchedCoreTurn(input, normalized.conversationKey, locale);
    }, windowMs);
    timer.unref?.();
    input.runtime.pendingBatches.set(normalized.conversationKey, {
      normalized: { ...normalized, attachments: stampedAttachments },
      members: [normalized],
      texts: [normalized.text],
      awaitingAttachment,
      onWait,
      timer,
      resolve: [resolve],
      reject: [reject],
    });
  });
}

async function flushBatchedCoreTurn(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  conversationKey: string,
  locale: "zh" | "en",
): Promise<void> {
  const batch = input.runtime.pendingBatches.get(conversationKey);
  if (!batch) {
    return;
  }
  input.runtime.pendingBatches.delete(conversationKey);
  try {
    await preemptActiveCoreTurnIfEnabled(input, batch.normalized, batch.normalized.text, locale);
    const result = await enqueueCoreTurn(input, batch.normalized, locale, batch.onWait);
    await markMergedBatchMembersTerminal(input.stateDir, batch, "success");
    for (const resolve of batch.resolve) {
      resolve(result);
    }
  } catch (error) {
    // All waiters belong to ONE merged turn; rejecting them all would make the
    // service-level catch post N identical error replies. Reject only the newest
    // waiter (the merged turn replies to its message) and settle the rest silently.
    await markMergedBatchMembersTerminal(input.stateDir, batch, "error");
    for (const resolve of batch.resolve.slice(0, -1)) {
      resolve(true);
    }
    batch.reject[batch.reject.length - 1]?.(error);
  }
}

/**
 * Atomically reserve queue order for a parked attachment batch. The enqueue
 * call happens synchronously before this function returns, so the caller can
 * immediately enqueue /q behind it without waiting for the batch turn itself.
 */
function queuePendingCoreBatchNow(
  input: Parameters<typeof flushBatchedCoreTurn>[0],
  conversationKey: string,
  locale: "zh" | "en",
): boolean {
  const batch = input.runtime.pendingBatches.get(conversationKey);
  if (!batch) return false;

  clearTimeout(batch.timer);
  input.runtime.pendingBatches.delete(conversationKey);
  const turn = enqueueCoreTurn(input, batch.normalized, locale, batch.onWait);
  void turn.then(async (result) => {
    await markMergedBatchMembersTerminal(input.stateDir, batch, "success");
    for (const resolve of batch.resolve) resolve(result);
  }).catch(async (error) => {
    await markMergedBatchMembersTerminal(input.stateDir, batch, "error");
    for (const resolve of batch.resolve.slice(0, -1)) resolve(true);
    batch.reject[batch.reject.length - 1]?.(error);
  });
  return true;
}

async function markMergedBatchMembersTerminal(
  stateDir: string,
  batch: PendingCoreBatch,
  outcome: "success" | "error",
): Promise<void> {
  const mergedInto = batch.normalized.messageId;
  // The newest member owns the actual merged turn and gets its turn.completed
  // event there. Earlier inputs were consumed into that turn, so terminalize
  // them explicitly to keep startup recovery from calling them interrupted.
  await Promise.allSettled(batch.members.slice(0, -1).map(async (member) => {
    await appendCoreTimelineEvent(stateDir, member, {
      type: "command.handled",
      outcome,
      detail: "batch-merged",
      metadata: { mergedInto },
    });
  }));
}

/**
 * Merge a burst's members into ONE prompt.
 *
 * Merge bodies and append the attachment summaries once. Only Feishu has a
 * transport envelope: keep its newest member's envelope to avoid conflicting
 * message IDs. App text stays free of transport metadata, including when the
 * user's own text discusses literal context tags. Number only real text bodies.
 */
function mergeBatchedTexts(members: CoreNormalizedBridgeMessage[]): string {
  const newest = members[members.length - 1];
  if (!newest) {
    return "";
  }
  const { envelope } = splitMessageContext(newest.text);

  const bodies = members
    .map((member) => stripCoreAttachmentSummary(extractCoreMessageBody(member.text), member.attachments).trim())
    .filter((body) => body.length > 0);
  const mergedBody = bodies.length > 1
    ? bodies.map((body, index) => `#${index + 1}\n${body}`).join("\n\n")
    : bodies[0] ?? "";

  const attachmentSummary = coreAttachmentSummary(members.flatMap((member) => member.attachments));
  return [envelope, mergedBody, attachmentSummary].filter((part) => part.length > 0).join("\n\n");
}

/**
 * Render attachment reference lines exactly as message-normalizer's buildLarkText
 * does, so a merged burst carries ONE combined summary block instead of one per
 * member (and so the per-member block can be recognized and stripped).
 */
function coreAttachmentSummary(attachments: CoreNormalizedBridgeMessage["attachments"]): string {
  return attachments
    .map((attachment) => `[${attachment.kind}:${attachment.fileKey}${attachment.fileName ? ` ${attachment.fileName}` : ""}]`)
    .join("\n");
}

/** Remove a member's own trailing attachment-summary block from its body. */
function stripCoreAttachmentSummary(body: string, attachments: CoreNormalizedBridgeMessage["attachments"]): string {
  const summary = coreAttachmentSummary(attachments);
  if (!summary) {
    return body;
  }
  const trimmed = body.trimEnd();
  return trimmed.endsWith(summary) ? trimmed.slice(0, trimmed.length - summary.length) : body;
}

function formatCoreDeniedAccessReply(
  text: string,
  normalized: CoreNormalizedBridgeMessage,
  locale: "zh" | "en",
): string {
  const base = formatCoreAccessReply(text);
  if (normalized.bridgeChatType !== "group" || base.includes("/invite group") || base.includes("/group allow")) {
    return base;
  }
  const hint = locale === "en"
    ? "If you are an authorized user, send `/invite group` or `/group allow` in this group. Otherwise, pair with the bot in private chat first."
    : "如果你是已授权用户，可在本群发送 `/invite group` 或 `/group allow` 允许当前群；否则请先私聊 bot 完成配对。";
  return `${base}\n\n${hint}`;
}

async function recordKnownCoreChat(stateDir: string, normalized: CoreNormalizedBridgeMessage): Promise<void> {
  try {
    await new CoreKnownChatStore(stateDir).record(normalized);
  } catch {
    // Chat labels are diagnostic metadata; never let them block message handling.
  }
}

async function resolveCoreMessageMentionRequirement(input: {
  stateDir: string;
  message: CoreIncomingMessage;
  defaultRequireMentionInGroup?: boolean;
}): Promise<boolean> {
  if (input.message.chatType === "p2p") {
    return false;
  }
  if (channelProfile() === "gateway") {
    return gatewayRequiresMention(input.stateDir, input.message.chatId, input.defaultRequireMentionInGroup !== false);
  }
  const groupMode = (await loadInstanceConfig(input.stateDir)).groupMode;
  if (!groupMode.enabled) {
    return true;
  }
  if (input.defaultRequireMentionInGroup === false) {
    return false;
  }
  if (await new CoreGroupModeStore(input.stateDir).isListenAll(input.message.chatId)) {
    return false;
  }
  const accessChatId = stableCoreNumericId(buildCoreConversationKey(input.message.chatId));
  const conversationChatId = stableCoreNumericId(buildCoreConversationKey(input.message.chatId, input.message.threadId));
  if (groupMode.listenAllChatIds.includes(accessChatId) || groupMode.listenAllChatIds.includes(conversationChatId)) {
    return false;
  }
  return true;
}

async function runNormalizedCoreMessage(
  input: {
    channel: CoreChannelLike;
    bridge: CoreBridgeLike;
    runtime: CoreServiceRuntime;
    stateDir: string;
    instanceName?: string;
    requireMentionInGroup?: boolean;
    workspaceOverride?: string;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: CoreNormalizedBridgeMessage,
): Promise<boolean> {
  await appendCoreTimelineEvent(input.stateDir, normalized, {
    type: "turn.started",
    metadata: {
      phase: "queued-job",
    },
  });
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveCoreLocale(input.stateDir);
  const accessDecision = input.bridge.checkAccess
    ? await input.bridge.checkAccess({
      chatId: normalized.bridgeAccessChatId,
      conversationChatId: normalized.bridgeChatId,
      userId: normalized.bridgeUserId,
      chatType: normalized.bridgeChatType,
      conversationKey: normalized.conversationKey,
      locale,
    })
    : { kind: "allow" as const };
  if (accessDecision.kind !== "allow") {
    await input.channel.send(normalized.chatId, { text: formatCoreDeniedAccessReply(accessDecision.text ?? renderCoreChatAccessDenied(locale), normalized, locale) }, {
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
    });
    await appendCoreTimelineEvent(input.stateDir, normalized, {
      type: "turn.completed",
      outcome: "denied",
      detail: "access denied",
    });
    return true;
  }

  const sessionStore = new SessionStore(path.join(input.stateDir, "session.json"));
  if (cfg.resume && await migrateLegacyConversationResume(sessionStore, cfg.resume)) {
    const migratedSessionId = cfg.resume.sessionId;
    await updateInstanceConfig(input.stateDir, (config) => {
      const legacy = config.resume as ResumeState | undefined;
      if (legacy?.sessionId === migratedSessionId) delete config.resume;
    });
    cfg.resume = undefined;
  }
  try { await input.channel.prepareConversation?.(normalized.chatId); }
  catch (error) {
    await appendCoreTimelineEvent(input.stateDir, normalized, { type: "turn.completed", outcome: "error", detail: redactCoreErrorDetail(error), metadata: { phase: "conversation-prepare" } });
    const queued = input.runtime.queueCards.get(normalized.messageId);
    input.runtime.queueCards.delete(normalized.messageId);
    if (queued) await settleLingeringCoreQueueCard(input.channel, queued, locale).catch(() => undefined);
    await cleanupCoreMessageArtifacts(input.stateDir, normalized.messageId).catch(() => undefined);
    throw error;
  }
  const conversationSession = await sessionStore.findByConversationKeySafe(normalized.conversationKey);
  const conversationResume = conversationSession.warning
    ? undefined
    : resolveConversationResume(conversationSession.record, cfg.resume);
  if (conversationResume && conversationSession.record && !hasConversationResume(conversationSession.record)) {
    await sessionStore.upsert({ ...conversationSession.record, resume: conversationResume });
    await updateInstanceConfig(input.stateDir, (config) => {
      const legacy = config.resume as ResumeState | undefined;
      if (legacy?.sessionId === conversationResume.sessionId) delete config.resume;
    });
  }
  cfg.resume = conversationResume;
  const workspaceOverride = input.workspaceOverride ?? normalized.workspaceOverride ?? resolveInstanceWorkspacePath(cfg);

  const commandText = extractCoreMessageBody(normalized.text);

  // Claim the conversation's activeRuns slot — or, when a live /goal pursuit
  // holds it, ATTACH this turn to the pursuit instead (claimLarkRunSlot /
  // LarkGoalRunController in bus.ts document the full design). An ordinary
  // message used to abort the goal watcher here, whose abort path cleared the
  // goal — a casual "how's it going?" silently killed the pursuit. Now:
  // - the pursuit keeps the slot and its goalWatch handle for its whole life;
  // - this turn runs on its OWN controller (attached, not slotted);
  // - /stop or a stop button abort() the slot's controller, which routes to
  //   this attached turn first and to the pursuit only when nothing else runs;
  // - /goal clear (abortGoal) still always ends the pursuit.
  let abortController: AbortController | undefined;
  let releaseRunSlot: (() => void) | undefined;
  let workflowRecordId: string | undefined;
  let workflowOutcome: "not_started" | "failed" | "delivered" = "not_started";
  const activateRun = (): AbortController => {
    if (!abortController) {
      abortController = new AbortController();
      releaseRunSlot = claimCoreRunSlot(input.runtime, normalized.conversationKey, {
        abortController,
        startedAt: Date.now(),
        sourceMessageId: normalized.messageId,
      });
    }
    return abortController;
  };

  try {
    // Never falls through to slash commands or an ordinary chat turn.
    if (normalized.agentBus) return await handleCoreAgentBusRun({ ...input, requestApproval: requestCoreApproval }, normalized, activateRun);
    const simpleCommandController = isCoreLocalEngineCommand(commandText) ? activateRun() : undefined;
    if (!normalized.botSource && !normalized.groupDiscussion && await handleCoreSimpleCommand({
      ...input,
      conversationResume: conversationResume ?? null,
      workspaceOverride,
      requestApproval: requestCoreApproval,
      abortSignal: simpleCommandController?.signal,
      createRunCard: createCoreRunCardController,
    }, normalized, commandText)) {
      return true;
    }

    const runController = activateRun();
    await transitionQueuedCoreCardToStarted(input.channel, input.runtime, normalized, locale);

    if (!normalized.botSource && !normalized.groupDiscussion && await handleCoreCrewWorkflow({
      ...input,
      requestApproval: requestCoreApproval,
      abortSignal: runController.signal,
    }, normalized, commandText)) {
      return true;
    }

    let downloadedAttachments: DownloadedCoreAttachment[];
    let files: string[];
    let requestText = normalized.text;
    let requestOutputDir: string;
    try {
      downloadedAttachments = await downloadCoreAttachments({
        channel: input.channel,
        stateDir: input.stateDir,
        messageId: normalized.messageId,
        attachments: normalized.attachments,
      });
      const mediaDownloads = downloadedAttachments.filter(isTranscribableCoreMedia);
      const workflowDownloads = downloadedAttachments.filter((attachment) => !isTranscribableCoreMedia(attachment));
      const engineVideoPaths: string[] = [];
      if (mediaDownloads.length > 0) {
        const transcribeMedia = input.runtime.transcribeMedia ?? defaultTranscribeLarkMedia;
        const prepareLarkVideoInput = input.runtime.prepareVideoInput ?? defaultPrepareLarkVideoInput;
        for (const media of mediaDownloads) {
          const isVideo = isVideoCoreMedia(media);
          if (isVideo) {
            let prepared: PreparedVideoInput;
            try {
              prepared = await prepareLarkVideoInput(media.localPath, {
                abortSignal: runController.signal,
              });
            } catch (error) {
              if (runController.signal.aborted) {
                throw error;
              }
              prepared = { durationSeconds: null, framePaths: [], mode: "direct" };
            }
            engineVideoPaths.push(...prepared.framePaths, media.localPath);
            const fileName = media.attachment.fileName ?? path.basename(media.localPath);
            const preparationBlock = formatPreparedVideoInput(fileName, prepared);
            requestText = requestText.trim()
              ? `${requestText.trim()}\n${preparationBlock}`
              : preparationBlock;

            // Long/unprobeable clips are handed directly to the agent. It can
            // choose its own inspection strategy instead of paying for an
            // automatic full-audio transcription the user did not request.
            if (prepared.mode === "direct") {
              continue;
            }
          }
          try {
            // Message text enables the 强制云端转写/强制本地转写 routing
            // overrides; stateDir hosts cloud ASR job dirs (`asr-jobs/`).
            const transcript = await transcribeMedia(media.localPath, {
              messageText: normalized.asrRoutingText ?? normalized.text,
              mediaKind: isVideo ? "video" : media.attachment.kind === "audio" ? "audio" : "unknown",
              stateDir: input.stateDir,
              ...(channelProfile() === "gateway" ? { reuse: { conversationId: normalized.chatId, attachmentId: media.attachment.fileKey } } : {}),
              // /stop and the run-card stop button must actually kill a cloud
              // transcription: without this the child ran to its wall clock while
              // the chat's queue slot stayed held and the stop reported success.
              abortSignal: runController.signal,
            });
            if (transcript.trim()) {
              const fileName = media.attachment.fileName ?? path.basename(media.localPath);
              const transcriptBlock = formatBridgeMediaTranscript(fileName, transcript);
              requestText = requestText.trim() ? `${requestText.trim()}\n${transcriptBlock}` : transcriptBlock;
            } else if (media.attachment.kind === "file") {
              const fileName = (media.attachment.fileName ?? path.basename(media.localPath))
                .replace(/[\r\n\t]+/g, " ")
                .slice(0, 240);
              const marker = `[Bridge media transcription unavailable for ${fileName}; inspect or transcribe the attached file if needed.]`;
              requestText = requestText.trim() ? `${requestText.trim()}\n${marker}` : marker;
            } else if (!isVideo) {
              // An empty voice transcript has no usable engine input. Use the
              // existing failure path instead of dispatching an empty turn.
              throw new Error("empty_voice_transcript");
            }
          } catch (error) {
            // An operator stop is not a transcription failure: reporting it as
            // one produced a misleading "转写失败" notice plus an error timeline
            // entry right after the user pressed stop. The turn's own abort path
            // already reports the interruption.
            if (isCloudAsrCancelledError(error) || runController.signal.aborted) {
              throw error;
            }
            if (isPartialMediaTranscriptionError(error)) {
              const transcriptBlock = formatBridgePartialMediaTranscript(
                media.attachment.fileName ?? path.basename(media.localPath),
                error.transcript,
                error.failedChunkNumbers,
                error.totalChunks,
              );
              requestText = requestText.trim()
                ? `${requestText.trim()}\n${transcriptBlock}`
                : transcriptBlock;
              await appendCoreTimelineEvent(input.stateDir, normalized, {
                type: "file.accepted",
                outcome: "partial",
                detail: "media transcription incomplete; partial transcript preserved",
                metadata: {
                  fileName: media.attachment.fileName,
                  kind: media.attachment.kind,
                  failedChunkNumbers: error.failedChunkNumbers,
                  totalChunks: error.totalChunks,
                  phase: "prepare",
                },
              });
              continue;
            }
            if (isCloudAsrRequiredError(error)) {
              const marker = "[Bridge cloud-only transcription did not produce usable text. Do not automatically re-upload, retry transcription, or switch to local. Explain the result to the user; wait for an explicit retry request.]";
              requestText = requestText.trim() ? `${requestText.trim()}\n${marker}` : marker;
            }
            // A video always has a usable fallback: extracted frames for a
            // short clip, or the original local path for a long/unprobeable
            // one. Silent clips and ASR outages must not prevent the model from
            // seeing the visual content.
            if (isVideo) {
              await appendCoreTimelineEvent(input.stateDir, normalized, {
                type: "file.accepted",
                outcome: "accepted",
                detail: "video audio transcription failed; visual input passed through",
                metadata: {
                  fileName: media.attachment.fileName,
                  kind: media.attachment.kind,
                  phase: "prepare",
                },
              });
              continue;
            }
            // A PROMOTED file (a recording sent as a document) still has the
            // file itself to work with, so a failed transcription must NOT end
            // the turn with "转写失败" — before this promotion existed the file
            // simply reached the engine. Log it and fall through; the engine
            // gets the path and can handle it. A genuine voice/video MESSAGE
            // has nothing else, so it keeps the failure reply.
            if (media.attachment.kind === "file") {
              const fileName = (media.attachment.fileName ?? path.basename(media.localPath))
                .replace(/[\r\n\t]+/g, " ")
                .slice(0, 240);
              if (!isCloudAsrRequiredError(error)) {
                const marker = `[Bridge media transcription unavailable for ${fileName}; inspect or transcribe the attached file if needed.]`;
                requestText = requestText.trim() ? `${requestText.trim()}\n${marker}` : marker;
              }
              await appendCoreTimelineEvent(input.stateDir, normalized, {
                type: "file.accepted",
                outcome: "accepted",
                detail: "promoted media transcription failed; file passed through",
                metadata: {
                  fileName: media.attachment.fileName,
                  kind: media.attachment.kind,
                  phase: "prepare",
                },
              });
              continue;
            }
            await input.channel.send(normalized.chatId, {
              text: renderCoreAudioTranscriptionFailure(locale, isCloudAsrRequiredError(error) ? error.reason : false),
            }, {
              replyTo: normalized.messageId,
              replyInThread: Boolean(normalized.threadId),
            });
            await appendCoreTimelineEvent(input.stateDir, normalized, {
              type: "turn.completed",
              outcome: "error",
              detail: "lark media transcription failed",
              metadata: {
                phase: "prepare",
                kind: media.attachment.kind,
              },
            });
            return true;
          }
        }
      }
      // A PROMOTED audio file (an .m4a sent as a document, not as a Feishu
      // voice message) is transcribed above, but it is still a file the user
      // handed over. Videos are handled separately: every engine gets the
      // original path, plus sampled frames when the clip is short enough.
      const promotedMediaPaths = mediaDownloads
        .filter((downloaded) => downloaded.attachment.kind === "file" && !isVideoCoreMedia(downloaded))
        .map((downloaded) => downloaded.localPath);
      files = [...new Set([
        ...workflowDownloads.map((attachment) => attachment.localPath),
        ...promotedMediaPaths,
        ...engineVideoPaths,
      ])];
      // A discussion turn always reaches the engine: an archive summary card or
      // an "archive continue" match would replace the speaker's answer.
      const workflowResult = normalized.groupDiscussion ? null : await prepareCoreFileWorkflow({
        stateDir: input.stateDir,
        normalized: { ...normalized, text: requestText },
        commandText,
        locale,
        downloadedAttachments: workflowDownloads,
      });
      if (workflowResult?.workflowRecordId) {
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "workflow.prepared",
          detail: downloadedAttachments.length > 0 ? "attachment workflow prepared" : "workflow prepared",
          metadata: {
            workflowRecordId: workflowResult.workflowRecordId,
            kind: workflowResult.kind,
          },
        });
      }
      if (workflowResult?.kind === "reply") {
        // An archive-summary reply gets ONE localized card (summary + inline
        // Continue button). If a "queued" card is still showing for this upload
        // (it arrived while the bot was busy), TAKE IT OVER in place so the
        // queued→summary transition happens on the same card — no "撤回了一条
        // 回复" recall, no plain-text English blob, no duplicate continue card.
        if (workflowResult.workflowRecordId && workflowResult.archive) {
          const summaryCard = renderCoreArchiveSummaryCard({
            data: workflowResult.archive,
            uploadId: workflowResult.workflowRecordId,
            conversationKey: normalized.conversationKey,
            bridgeChatType: normalized.bridgeChatType,
            replyInThread: Boolean(normalized.threadId),
            locale,
          });
          const queuedRef = input.runtime.queueCards.get(normalized.messageId);
          let delivered = false;
          if (queuedRef) {
            delivered = await updateCoreQueueCardInPlace(input.channel, queuedRef, summaryCard);
            if (delivered) {
              trackCoreChoiceCard(input.runtime, queuedRef.messageId, queuedRef.handle);
              // Taken over in place → drop tracking so the finally-block's
              // lingering-card settle won't recall the card we just reused.
              input.runtime.queueCards.delete(normalized.messageId);
            }
            // If the in-place update failed, leave it tracked: the finally-block
            // recalls the stale queued card and we post a fresh summary below
            // (no orphaned "排队中" card left behind).
          }
          if (!delivered) {
            await sendTrackedCoreChoiceCard({
              channel: input.channel,
              runtime: input.runtime,
              chatId: normalized.chatId,
              card: summaryCard,
              // Card delivery failed → keep the operator on the same short,
              // localized summary, not the English Telegram blob.
              fallbackText: renderCoreArchiveSummaryText(workflowResult.archive, locale),
              options: {
                replyTo: normalized.messageId,
                replyInThread: Boolean(normalized.threadId),
              },
              locale,
            });
          }
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "turn.completed",
            outcome: "success",
            metadata: {
              responseChars: workflowResult.text.length,
              attachments: normalized.attachments.length,
              workflowRecordId: workflowResult.workflowRecordId,
              archiveCard: true,
            },
          });
          return true;
        }
        // Non-archive reply (e.g. "too many active file tasks"): plain markdown.
        const deliveryText = workflowResult.workflowRecordId
          ? boundCoreArchiveSummary(workflowResult.text)
          : workflowResult.text;
        await sendCoreMarkdown(input.channel, normalized.chatId, deliveryText, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "success",
          metadata: {
            responseChars: deliveryText.length,
            attachments: normalized.attachments.length,
            workflowRecordId: workflowResult.workflowRecordId,
          },
        });
        return true;
      }
      if (workflowResult?.kind === "direct") {
        requestText = workflowResult.text;
        files = [...workflowResult.files];
        workflowRecordId = workflowResult.workflowRecordId;
      }
      requestOutputDir = path.join(workspaceArtifactRoot(input.stateDir, "output"), safeSegment(normalized.messageId));
      await mkdir(requestOutputDir, { recursive: true });
    } catch (error) {
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "error",
        detail: redactCoreErrorDetail(error),
        metadata: {
          phase: "prepare",
        },
      });
      await input.channel.send(normalized.chatId, {
        text: renderCoreUserFacingError(error, "prepare", locale),
      }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      return true;
    }

    // Enforce the spend budget before running the engine — parity with the
    // Telegram and bus entry points, which both gate here. Without this the
    // Lark channel only recorded usage after the fact and silently ignored the
    // configured budgetUsd. Slash commands (handled above) are not gated.
    const budgetExhausted = await checkBudgetAvailability(input.stateDir, cfg.budgetUsd, locale);
    if (budgetExhausted) {
      await input.channel.send(normalized.chatId, { text: budgetExhausted.message }, {
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
      });
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: "noop",
        detail: "budget exhausted",
        metadata: { phase: "budget", budgetUsd: budgetExhausted.budgetUsd, totalCostUsd: budgetExhausted.usage.totalCostUsd },
      });
      return true;
    }

    let runCard: CoreRunCardController | undefined;
    let completedEngineText: string | undefined;
    let runCardFinished = false;
    let obligationId: string | null = null;
    let deliveryPreflightFailed = false;
    let obligationRequiresRecovery = false;
    // True once the FULL answer is visible to the user (card, continuation
    // cards, overflow doc, or markdown). Artifact obligations remain recoverable
    // until every requested upload has a definite platform acknowledgement.
    let answerVisibleToUser = false;
    try {
      // If a "queued" card was already shown for this conversation, take it over
      // as the run card so it transitions in place instead of being orphaned: a
      // CardKit-managed queue card is updated by card_id (seamless, survives the
      // take-over), a plain inline one via im.message.patch.
      const queuedRef = input.runtime.queueCards.get(normalized.messageId);
      input.runtime.queueCards.delete(normalized.messageId);
      runCard = await createCoreRunCardController({
        channel: input.channel,
        chatId: normalized.chatId,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
        locale,
        elementStream: cfg.elementStream !== false,
        abortSignal: runController.signal,
        ...(queuedRef ? { existingCard: queuedRef } : {}),
        ...(normalized.goalObjective ? { goalObjective: normalized.goalObjective } : {}),
      });
      // Record whether a live run card exists so the stop handlers can skip the
      // redundant "已停止。" text — the card itself updates in place to "已中断".
      // Guarded on ownership: when this turn is ATTACHED to a /goal pursuit the
      // slot (and its hasRunCard flag) belongs to the goal's card, not ours.
      const activeHandle = input.runtime.activeRuns.get(normalized.conversationKey);
      if (activeHandle?.abortController === runController) {
        activeHandle.hasRunCard = Boolean(runCard);
      }
      const scopedRuns = createScopedRunPresentation({ channel: input.channel, chatId: normalized.chatId,
        conversationKey: normalized.conversationKey, replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId), locale });
      const handleEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
        if (event.type === "scoped") { await scopedRuns.apply(event, { foreground: runCard }); return; }
        if (event.type === "engine_retry" && event.status === "retrying") runCard?.beginAnswerAttempt();
        if (
          (event.type !== "task_notification" || !event.suppressUserDelivery)
        ) {
          await runCard?.apply(event);
        }
        if (shouldPersistEngineTimelineEvent(event)) {
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event",
            detail: event.type,
            metadata: engineEventTimelineMetadata(event),
          });
        }

        if (event.type === "user_input_request") {
          const isCurrentTurn = () => isCoreRunActive(input.runtime, normalized.conversationKey, runController);
          try {
            await deliverCoreUserInputRequest({
              channel: input.channel,
              runtime: input.runtime,
              chatId: normalized.chatId,
              toolInput: event.toolInput,
              requestId: event.requestId,
              sessionId: event.sessionId,
              abortSignal: runController.signal,
              isCurrentTurn,
              ...(input.bridge.supportsSteering?.() && input.bridge.steerActiveTurn ? {
                answerActiveTurn: async (text: string) => isCurrentTurn() && input.bridge.steerActiveTurn!({
                  chatId: stableCoreNumericId(normalized.conversationKey), conversationKey: normalized.conversationKey, text, isCurrentTurn, throwOnError: true,
                }),
              } : {}),
              conversationKey: normalized.conversationKey,
              bridgeChatType: normalized.bridgeChatType,
              replyTo: normalized.messageId,
              replyInThread: Boolean(normalized.threadId),
              locale,
            });
          } catch (error) {
            await appendCoreTimelineEvent(input.stateDir, normalized, {
              type: "engine.event.delivery_failed",
              outcome: "error",
              detail: redactCoreErrorDetail(error),
              metadata: {
                eventType: event.type,
                requestId: event.requestId,
              },
            });
          }
          return;
        }

        if (event.type !== "task_notification" || event.settlesCurrentTurn || event.suppressUserDelivery) {
          if (event.type === "task_notification") await finishScopedRunPresentation({ channel: input.channel, conversationKey: normalized.conversationKey,
            replyTo: backgroundTaskReplyTo(event, normalized.messageId, input.channel.profile) }, event);
          return;
        }

        const bodyText = backgroundTaskBody(event, locale);
        const replyTo = backgroundTaskReplyTo(event, normalized.messageId, input.channel.profile);
        const context = backgroundTaskContext(event, locale);
        const background = event.origin && context ? { origin: event.origin, context, status: event.reason === "engine_exit" ? "interrupted" : event.status } : undefined;
        const headerText = renderCoreBackgroundTaskHeader(locale, event.status);
        const notificationText = [headerText, context, bodyText.trim()].filter(Boolean).join("\n");
        const notificationFallbackText = [headerText, context, cleanCardText(bodyText, locale)].filter(Boolean).join("\n");
        // Render the out-of-band background-task notification as a card to match
        // the bot's card-based UX. An oversize body spills into continuation cards —
        // the same card 1 + "↪ 接上" flow as a long main answer — instead of dropping
        // to a plain-text dump; only a document-sized body (over the overflow-card
        // budget) or a file-block directive still takes the plain-text path. Within
        // the card path, sendLarkCardWithFallback drops to plain text per card.
        const notificationCard = renderCoreNotificationCard(headerText, bodyText, locale, background, input.channel.profile);
        let notificationChunks: string[] | undefined;
        if (!notificationCard && !hasCoreFileBlockDirective(bodyText)) {
          const cleanedNotification = cleanCardText(bodyText, locale);
          const chunks = cleanedNotification ? splitCoreAnswerIntoCardChunks(cleanedNotification) : [];
          if (chunks.length > 1 && chunks.length <= CORE_MAX_OVERFLOW_CARDS) {
            notificationChunks = chunks;
          }
        }
        const deliverArgs = {
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo,
          replyInThread: Boolean(replyTo && normalized.threadId),
          stateDir: input.stateDir,
          requestOutputDir,
          workspaceOverride,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          bridgeChatId: normalized.bridgeChatId,
          bridgeUserId: normalized.bridgeUserId,
          larkThreadId: normalized.threadId,
          larkMessageId: normalized.messageId,
          instanceName: input.instanceName,
          ...(normalized.groupDiscussion ? { allowCronMutations: false, cronMutationContext: "discussion" as const } : {}),
        };
        // A background-task result is the costliest thing to lose: it arrives
        // out-of-band (possibly hours after the triggering turn) and nothing
        // retries it. Ledger it like a final answer.
        let notificationObligationId: string | null = null;
        let notificationDeliveryConfirmed = true;
        try {
          if (deliveryLedgerEnabled()) {
            notificationObligationId = await recordDeliveryObligation(input.stateDir, {
              channel: "lark",
              chatId: normalized.chatId,
              conversationKey: normalized.conversationKey,
              replyTo,
              replyInThread: Boolean(replyTo && normalized.threadId),
              content: notificationText,
              allowLargeContent: channelProfile() === "gateway",
            });
            if (notificationObligationId) {
              await markDeliveryAttempting(input.stateDir, notificationObligationId);
            }
          }
          if (notificationCard) {
            // Still deliver any files/images/tool-tags embedded in the
            // notification (sendText: false), then post the card carrying the text.
            const artifactDelivery = await deliverCoreResponse({ ...deliverArgs, text: bodyText, sendText: false });
            notificationDeliveryConfirmed = artifactDelivery.ok;
            if (!artifactDelivery.ok && notificationCard.appBackgroundTask) notificationCard.appBackgroundTask = { ...(notificationCard.appBackgroundTask as object), delivery: "unconfirmed" };
            if (!await finishScopedRunPresentation({ channel: input.channel, conversationKey: normalized.conversationKey, replyTo }, event, artifactDelivery.ok)) await sendCoreCardWithFallback({
              channel: input.channel,
              chatId: normalized.chatId,
              card: notificationCard,
              fallbackText: notificationFallbackText,
              options: coreReplyOptions(replyTo, Boolean(replyTo && normalized.threadId)),
              locale,
            });
          } else if (notificationChunks) {
            // Oversize notification → notification card carrying chunk 1, then the
            // remaining chunks as continuation cards (chunks are pre-sized to fit a
            // card, so the chunk-1 render cannot decline for size).
            notificationDeliveryConfirmed = (await deliverCoreResponse({ ...deliverArgs, text: bodyText, sendText: false })).ok;
            const replyOptions = coreReplyOptions(replyTo, Boolean(replyTo && normalized.threadId));
            const firstCard = renderCoreNotificationCard(headerText, notificationChunks[0]!, locale, background, input.channel.profile);
            if (firstCard) {
              await sendCoreCardWithFallback({
                channel: input.channel,
                chatId: normalized.chatId,
                card: firstCard,
                fallbackText: [headerText, context, notificationChunks[0]!].filter(Boolean).join("\n"),
                options: replyOptions,
                locale,
              });
              await deliverCoreContinuationCards({
                channel: input.channel,
                chatId: normalized.chatId,
                chunks: notificationChunks,
                replyOptions,
                locale,
              });
            } else {
              notificationDeliveryConfirmed = (await deliverCoreResponse({ ...deliverArgs, text: notificationText })).ok && notificationDeliveryConfirmed;
            }
          } else {
            notificationDeliveryConfirmed = (await deliverCoreResponse({
              ...deliverArgs,
              text: isWholeResponseFileBlockText(bodyText) ? bodyText : notificationText,
            })).ok;
          }
          if (!notificationCard) await finishScopedRunPresentation({ channel: input.channel, conversationKey: normalized.conversationKey, replyTo }, event, notificationDeliveryConfirmed);
          if (notificationObligationId) {
            if (notificationDeliveryConfirmed) await markDeliveryDelivered(input.stateDir, notificationObligationId);
            else await markDeliveryFailed(input.stateDir, notificationObligationId, "background delivery remained unconfirmed");
          }
        } catch (error) {
          await finishScopedRunPresentation({ channel: input.channel, conversationKey: normalized.conversationKey, replyTo },
            { ...event, suppressUserDelivery: true }, false).catch(() => undefined);
          if (notificationObligationId) {
            await markDeliveryFailed(input.stateDir, notificationObligationId, redactCoreErrorDetail(error));
          }
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactCoreErrorDetail(error),
            metadata: {
              eventType: event.type,
            },
          });
        }
      };
      const deliveryFollowupGuardActive = isCoreDeliveryFollowupRequest(commandText);
      // Keep a private copy of the initial engine stream. It is normally only
      // needed by the delivery-followup guard, but it also lets us safely recover
      // complete artifact directives when an engine dies before its result event.
      let initialResponseState = initialCoreRunState(
        normalized.conversationKey,
        normalized.bridgeChatType,
      );
      let initialTurnSawToolActivity = false;
      let initialTurnSawUnsafeToolActivity = false;
      const handleInitialEngineEvent = async (event: EngineStreamEvent): Promise<void> => {
        if (event.type === "scoped") { await handleEngineEvent(event); return; }
        if (event.type === "engine_retry" && event.status === "retrying") {
          initialResponseState = initialCoreRunState(normalized.conversationKey, normalized.bridgeChatType);
        }
        initialResponseState = applyCoreEngineEvent(initialResponseState, event);
        if (event.type === "tool_use") {
          initialTurnSawToolActivity = true;
          if (!isReplaySafeCoreToolName(event.toolName)) {
            initialTurnSawUnsafeToolActivity = true;
          }
        }
        if (deliveryFollowupGuardActive) {
          // A stale session can stream "already sent; scroll up" before the
          // post-turn guard inspects the complete answer. Keep only answer text
          // off the card here; tools, thinking, errors, and tasks still flow.
          if (event.type === "assistant_text" || event.type === "result") {
            if (shouldPersistEngineTimelineEvent(event)) {
              await appendCoreTimelineEvent(input.stateDir, normalized, {
                type: "engine.event",
                detail: event.type,
                metadata: {
                  ...engineEventTimelineMetadata(event),
                  suppressedBy: "delivery-followup-guard",
                },
              });
            }
            return;
          }
        }
        await handleEngineEvent(event);
      };
      const handleTurnLockWait = async (event: BridgeTurnLockWaitEvent): Promise<void> => {
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "engine.lock.waiting",
          detail: "waiting for shared engine session lock",
          metadata: {
            sessionId: event.sessionId,
            waitedMs: event.waitedMs,
            reason: event.reason,
          },
        });
        const waitText = locale === "zh"
          ? "另一个入口正在使用同一个 AI session，这条消息已排队等待。前一个任务完成后会继续处理。"
          : "Another entry is using the same AI session. This message is queued and will continue after the active turn finishes.";
        try {
          await deliverCoreResponse({
            channel: input.channel,
            runtime: input.runtime,
            chatId: normalized.chatId,
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
            text: waitText,
            stateDir: input.stateDir,
            requestOutputDir,
            workspaceOverride,
            conversationKey: normalized.conversationKey,
            bridgeChatType: normalized.bridgeChatType,
            bridgeChatId: normalized.bridgeChatId,
            bridgeUserId: normalized.bridgeUserId,
            larkThreadId: normalized.threadId,
            larkMessageId: normalized.messageId,
            instanceName: input.instanceName,
          });
        } catch (error) {
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactCoreErrorDetail(error),
            metadata: {
              eventType: "engine.lock.waiting",
            },
          });
        }
      };
      const handleTurnPoolWait = async (event: TurnPoolWaitEvent): Promise<void> => {
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "engine.lock.waiting",
          detail: "waiting for shared AI worker capacity",
          metadata: {
            waitedMs: event.waitedMs,
            activeCount: event.activeCount,
            maxActive: event.maxActive,
            reason: event.reason,
          },
        });
        try {
          await sendCoreMarkdown(
            input.channel,
            normalized.chatId,
            renderCoreTurnPoolWait(locale),
            coreReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
          );
        } catch (error) {
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: redactCoreErrorDetail(error),
            metadata: {
              eventType: "engine.lock.waiting",
              phase: "turn-pool",
            },
          });
        }
      };

      // Reconcile a stale Codex thread-goal before this ordinary turn. If the thread
      // still carries a goal but no live watcher owns it — the watcher was killed by a
      // service restart, or the goal finished without being cleared — clear it so a
      // normal message is never silently resumed into, or shaped by, an old goal. A goal
      // that IS being actively pursued holds the activeRuns slot and is left untouched;
      // engines without a structured thread-goal API (Claude/Antigravity native /goal)
      // expose no get/clearThreadGoal and are skipped. Best-effort — never blocks a turn.
      if (
        input.bridge.getThreadGoal
        && input.bridge.clearThreadGoal
        && !input.runtime.activeRuns.get(normalized.conversationKey)?.goalWatch
      ) {
        const goalReconcileInput = {
          chatId: normalized.bridgeChatId,
          userId: normalized.bridgeUserId,
          chatType: normalized.bridgeChatType,
          conversationKey: normalized.conversationKey,
          workspaceOverride,
        };
        try {
          const { goal } = await input.bridge.getThreadGoal(goalReconcileInput);
          if (goal) {
            await input.bridge.clearThreadGoal(goalReconcileInput);
          }
        } catch {
          // Best-effort: never block an ordinary turn on goal-state reconciliation.
        }
      }

      return await runAuthorizedCoreTurnWithReactions(input, normalized, async () => {
        const resolveRunCardFinalText = (text: string): string => runCard?.resolveFinalText(text) ?? text;
        // Keep confirmed side effects outside an engine result: an engine can
        // fail after publishing, and repair attempts share the same user turn.
        const appDeliveries = new Map<string, AppDeliveryReceipt>();
        const appDeliveryCache: AppDeliveryCache = new Map();
        const cleanAppDeliveryText = async (text: string): Promise<string> => {
          const cleaned = await stripAlreadyDeliveredAppArtifacts(text, [...appDeliveries.values()]);
          return cleaned || (appDeliveries.size ? (locale === "en" ? "Attachment delivered." : "附件已发送。") : cleaned);
        };
        const resolveFinalText = async (text: string): Promise<string> => cleanAppDeliveryText(resolveRunCardFinalText(text));
        const deliveryPreflight = { stateDir: input.stateDir, requestOutputDir, workspaceOverride };
        const bridgeTurnInput: Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0] = {
          chatId: normalized.bridgeAccessChatId,
          userId: normalized.bridgeUserId,
          chatType: normalized.bridgeChatType,
          locale,
          text: requestText,
          ...(normalized.replyContext ? { replyContext: normalized.replyContext } : {}),
          conversationKey: normalized.conversationKey,
          ...(channelProfile() === "gateway" && cfg.engine === "claude" && normalized.reviewAdmission === "native" && !normalized.botSource && !normalized.agentBus && !normalized.groupDiscussion && !normalized.replyContext && files.length === 0 && !normalized.text.trimStart().startsWith("/")
            ? { reviewAdmission: "native" as const, nativeInput: normalized.nativeInput } : {}),
          files,
          requestOutputDir,
          workspaceOverride,
          ...(normalized.engineOverride ? { engineOverride: normalized.engineOverride } : {}),
          // One native batch message can contain several distinct file versions.
          ...(channelProfile() === "gateway" ? { onAppDelivery: (receipt: AppDeliveryReceipt) => { appDeliveries.set(JSON.stringify([receipt.messageId, receipt.path, receipt.sha256]), receipt); } } : {}),
          ...(channelProfile() === "gateway" ? { appDeliveryReplyTo: normalized.messageId, appDeliveryCache } : {}),
          abortSignal: runController.signal,
          disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
          onApprovalRequest: async (request) => {
            runCard?.setPhase?.(request.toolName === "AskUserQuestion" ? "waiting_answer" : "waiting_approval");
            try { return await requestCoreApproval({
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
            abortSignal: AbortSignal.any([runController.signal, ...(request.abortSignal ? [request.abortSignal] : [])]),
          }); } finally { runCard?.setPhase?.("working"); }
          },
          onEngineEvent: handleInitialEngineEvent,
          onTurnLockWait: handleTurnLockWait,
          turnPoolWaitNotifyAfterMs: 10_000,
          onTurnPoolWait: handleTurnPoolWait,
          instructions: larkAgentInstructions({
            engine: cfg.engine,
            claudeChrome: cfg.claudeChrome,
            timezone: cfg.timezone,
            context: "chat",
          }),
          turnInstructions: mergeTurnInstructions(
            coreDeliveryFollowupInstruction(commandText),
            larkMediaTaskInstruction(requestText),
          ),
          extraEnv: {
            [channelProfile() === "gateway" ? "TAROBOT_ACTIVE_TURN" : "CCTB_LARK_ACTIVE_TURN"]: "1",
            [channelProfile() === "gateway" ? "TAROBOT_ACTIVE_INSTANCE" : "CCTB_LARK_ACTIVE_INSTANCE"]: input.instanceName ?? path.basename(input.stateDir),
            [channelProfile() === "gateway" ? "TAROBOT_ACTIVE_STATE_DIR" : "CCTB_LARK_ACTIVE_STATE_DIR"]: input.stateDir,
          },
        };
        runCard?.beginAnswerAttempt();
        let recoveredEngineError: unknown;
        let result: Awaited<ReturnType<CoreBridgeLike["handleAuthorizedMessage"]>>;
        try {
          workflowOutcome = "failed";
          result = await input.bridge.handleAuthorizedMessage(bridgeTurnInput);
        } catch (error) {
          if (error instanceof EngineNativeInputUnsentError) throw error;
          if (classifyCoreTurnTermination(error, runController.signal).kind !== "error") {
            throw error;
          }
          // Some engines can stream a complete answer (including delivery tags)
          // and then fail before their terminal result event. Recover that answer
          // only when every referenced artifact passes preflight. Delivery-followup
          // turns keep answer text off the live card, so this private stream snapshot
          // is the canonical recovery source for both paths.
          const candidate = await cleanAppDeliveryText(resolveCoreFinalAnswerText(initialResponseState, "").trim());
          const preflight = candidate
            ? await preflightCoreResponseDeliveryDirectives(candidate, deliveryPreflight)
            : undefined;
          if (
            (!appDeliveries.size && (!preflight?.sawDirective || preflight.artifactCount === 0))
            || (preflight?.issues.length ?? 0) > 0
          ) {
            throw error;
          }
          recoveredEngineError = error;
          result = { text: candidate };
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event",
            outcome: "recovered",
            detail: deliveryFollowupGuardActive
              ? "delivery_followup_partial_recovered"
              : "streamed_artifact_partial_recovered",
            metadata: {
              artifactCount: (preflight?.artifactCount ?? 0) + appDeliveries.size,
              engineError: redactCoreErrorDetail(error),
            },
          });
        }
        result = { ...result, text: await resolveFinalText(result.text) };
        if (!appDeliveries.size && await isSuspectedStaleCoreResponse({
          stateDir: input.stateDir,
          conversationKey: normalized.conversationKey,
          replyTo: normalized.messageId,
          responseText: result.text,
          sawToolActivity: initialTurnSawToolActivity,
          sawUnsafeToolActivity: initialTurnSawUnsafeToolActivity,
        })) {
          // Text similarity also matches valid short answers. Preserve the
          // actual returned answer/session; only adapter identity checks can
          // reject a mismatched turn. Never replay work on this heuristic.
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event", outcome: "observed", detail: "response_matches_previous_prefix",
            metadata: { phase: "stale-response-guard", automaticReplay: false, sessionPreserved: true },
          });
        }
        // Use the sender's complete root set and preflight, not only an optional
        // workspace override. Most instances use the default state workspace.
        if (!appDeliveries.size && await shouldRepairCoreDeliveryFollowup(commandText, result.text, deliveryPreflight)) {
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event",
            outcome: "retry",
            detail: "delivery_followup_unverified_claim",
            metadata: { phase: "delivery-followup-guard" },
          });
          const firstUsage = result.usage;
          runCard?.beginAnswerAttempt();
          const repaired = await input.bridge.handleAuthorizedMessage({
            ...bridgeTurnInput,
            reviewAdmission: undefined, nativeInput: undefined,
            text: coreDeliveryFollowupRepairPrompt(),
            replyContext: undefined,
            onEngineEvent: handleEngineEvent,
          });
          const repairedText = await resolveFinalText(repaired.text);
          result = {
            ...repaired,
            text: !appDeliveries.size && await shouldRepairCoreDeliveryFollowup(commandText, repairedText, deliveryPreflight)
              ? renderUnverifiedCoreDeliveryClaim(locale)
              : repairedText,
            usage: mergeCoreTurnUsage(firstUsage, repaired.usage),
          };
        }
        const initialDeliveryDirectivePreflight = await preflightCoreResponseDeliveryDirectives(
          result.text,
          deliveryPreflight,
        );
        const deliveryIssues = initialDeliveryDirectivePreflight.issues;
        const hasRepairableDeliveryIssue = deliveryIssues.some(
          (issue) => issue.reason === "outside-workspace"
            || issue.reason === "invalid-directive"
            || issue.reason === "too-large",
        );
        // Repair rejected artifacts before sending any sibling. The bridge
        // preserves the first answer, actions, and verified files while the
        // retry supplies only replacements for rejected artifacts.
        if (initialDeliveryDirectivePreflight.sawDirective && hasRepairableDeliveryIssue) {
          for (const issue of deliveryIssues) {
            await appendCoreTimelineEvent(input.stateDir, normalized, {
              type: "file.rejected",
              outcome: "rejected",
              detail: issue.reason,
              metadata: {
                path: issue.path,
                ...(issue.realPath ? { realPath: issue.realPath } : {}),
                reason: issue.reason,
                ...(issue.kind ? { kind: issue.kind } : {}),
                via: "preflight",
              },
            });
          }
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event",
            outcome: "retry",
            detail: "delivery_preflight_rejected_path",
            metadata: {
              phase: "delivery-preflight-guard",
              rejectedPaths: deliveryIssues.length,
            },
          });
          const firstUsage = result.usage;
          const repairBase = buildCoreDeliveryRepairBase(
            result.text,
            initialDeliveryDirectivePreflight,
          );
          const previouslyDelivered = new Set(appDeliveries.keys());
          const previousVersions = new Set([...appDeliveries.values()].map((receipt) => `${receipt.path}:${receipt.sha256}`));
          runCard?.beginAnswerAttempt();
          const repaired = await input.bridge.handleAuthorizedMessage({
            ...bridgeTurnInput,
            text: coreDeliveryPreflightRepairPrompt(initialDeliveryDirectivePreflight),
            reviewAdmission: undefined, nativeInput: undefined,
            replyContext: undefined,
            onEngineEvent: handleEngineEvent,
          });
          const repairedText = await resolveFinalText(repaired.text);
          const repairedDeliveryDirectivePreflight = await preflightCoreResponseDeliveryDirectives(
            repairedText,
            deliveryPreflight,
          );
          const nativeRepairs = new Set([...appDeliveries.entries()]
            .filter(([key, receipt]) => !previouslyDelivered.has(key) && !previousVersions.has(`${receipt.path}:${receipt.sha256}`))
            .map(([, receipt]) => `${receipt.path}:${receipt.sha256}`));
          const repairSucceeded = repairedDeliveryDirectivePreflight.acceptedArtifacts.length + nativeRepairs.size >= deliveryIssues.length
            && repairedDeliveryDirectivePreflight.issues.length === 0;
          const verifiedDirectives = renderCoreMergedDeliveryRepairDirectives(
            initialDeliveryDirectivePreflight,
            repairedDeliveryDirectivePreflight,
          );
          const repairResult = repairSucceeded
            ? verifiedDirectives
            : [
                verifiedDirectives,
                renderCoreDeliveryPreflightFailure(
                  locale,
                  repairedDeliveryDirectivePreflight,
                  initialDeliveryDirectivePreflight,
                ),
              ].filter((part) => part.trim()).join("\n\n");
          result = {
            ...repaired,
            text: await cleanAppDeliveryText([repairBase, repairResult].filter((part) => part.trim()).join("\n\n")),
            usage: mergeCoreTurnUsage(firstUsage, repaired.usage),
          };
          if (!repairSucceeded) {
            deliveryPreflightFailed = true;
            await appendCoreTimelineEvent(input.stateDir, normalized, {
              type: "engine.event.delivery_failed",
              outcome: "error",
              detail: "delivery_preflight_retry_rejected",
              metadata: {
                phase: "delivery-preflight-guard",
                sawDirective: repairedDeliveryDirectivePreflight.sawDirective,
                artifactCount: repairedDeliveryDirectivePreflight.artifactCount,
                rejectedPaths: repairedDeliveryDirectivePreflight.issues.length,
              },
            });
          }
        }
        completedEngineText = result.text;
        if (deliveryLedgerEnabled()) {
          // Durable delivery obligation: the engine's answer now exists only in
          // this local. If the process dies before platform ACK, the next boot
          // redelivers it (state/delivery-obligation-store.ts).
          obligationId = await recordDeliveryObligation(input.stateDir, {
            channel: "lark",
            chatId: normalized.chatId,
            conversationKey: normalized.conversationKey,
            replyTo: normalized.messageId,
            replyInThread: Boolean(normalized.threadId),
            content: result.text,
            allowLargeContent: channelProfile() === "gateway",
          });
        }
        // A reply too long for one card spills into continuation cards (card 2 continues
        // card 1) rather than a Feishu Doc, which the operator finds more natural to read
        // inline. The run card becomes card 1 (chunk 1); the rest follow as their own
        // cards. Only a genuinely document-sized reply (more than LARK_MAX_OVERFLOW_CARDS
        // chunks) still uses a Doc, where a long stream of cards would be worse.
        // Split the CLEANED display text (tags stripped, headings downgraded) — the same
        // transform the run card applies — so chunk sizing/boundaries match what is shown,
        // a tag-heavy reply isn't over-split into near-empty cards, and continuation cards
        // render consistently with the run card. deliverLarkResponse still gets the raw
        // result.text below so file/image tags are actually processed.
        const cardDisplayText = runCard !== undefined ? cleanCardText(result.text, locale) : result.text;
        const answerChunks = runCard !== undefined
          ? splitCoreAnswerIntoCardChunks(cardDisplayText)
          : [cardDisplayText];
        const spillToContinuationCards = runCard !== undefined
          && answerChunks.length > 1
          && answerChunks.length <= CORE_MAX_OVERFLOW_CARDS;
        const requiresPostTurnDelivery = hasCorePostTurnDelivery(result.text);
        const requiresVisibleDeliveryPhase = spillToContinuationCards
          || answerChunks.length > CORE_MAX_OVERFLOW_CARDS
          || requiresPostTurnDelivery;
        // Anything after this point can fail before the artifact pipeline runs
        // (for example usage-ledger persistence). Keep the obligation recoverable
        // until every requested post-turn delivery has a definite acknowledgement.
        obligationRequiresRecovery = requiresPostTurnDelivery;
        if (obligationId) {
          // From here on the platform may have (part of) the answer — a crash
          // past this point redelivers WITH the recovered-reply marker.
          await markDeliveryAttempting(input.stateDir, obligationId);
        }
        const runCardAnswerText = spillToContinuationCards ? answerChunks[0]! : cardDisplayText;
        const deliveryCardResult = runCard
          ? await (requiresVisibleDeliveryPhase
              ? runCard.beginDelivery(runCardAnswerText)
              : runCard.finish(runCardAnswerText))
          : undefined;
        runCardFinished = Boolean(runCard) && !requiresVisibleDeliveryPhase;
        const answerShownInCard = deliveryCardResult?.shown ?? false;
        if (answerShownInCard && !spillToContinuationCards) {
          answerVisibleToUser = true;
        }
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        let overflowDelivered = false;
        if (spillToContinuationCards && answerShownInCard) {
          // Run card carries chunk 1; send chunks 2..N as continuation cards, each its
          // own push in order. sendLarkCardWithFallback drops to plain text per card, so
          // a chunk is never lost even if a card render is rejected.
          await deliverCoreContinuationCards({
            channel: input.channel,
            chatId: normalized.chatId,
            chunks: answerChunks,
            replyOptions: coreReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
            locale,
          });
          overflowDelivered = true;
          answerVisibleToUser = true;
        } else if (
          // The card couldn't fit the answer and it's too big to spill into a bounded
          // number of cards → stash the full text in a Feishu Doc and post just the link,
          // instead of dumping a huge multi-part markdown message. The card keeps its
          // truncated preview. If doc creation fails, fall through to the markdown dump so
          // the content is never lost.
          channelProfile() !== "gateway" && runCard !== undefined
          && !answerShownInCard
          && (result.text.length > LARK_OVERFLOW_DOC_MIN_CHARS
            || Buffer.byteLength(result.text, "utf8") > ELEMENT_CONTENT_MAX_BYTES)
        ) {
          const overflow = await postLarkOverflowAnswerDoc({
            channel: input.channel,
            createDocument: input.runtime.createDocument,
            chatId: normalized.chatId,
            replyOptions: coreReplyOptions(normalized.messageId, Boolean(normalized.threadId)),
            text: result.text,
            locale,
          });
          overflowDelivered = overflow.delivered;
          if (overflow.delivered) {
            answerVisibleToUser = true;
          }
          if (overflow.mode !== "doc") {
            // The Feishu Doc step failed — surface why (it is otherwise swallowed) so
            // the .md-file fallback the operator sees can be traced to its cause.
            await appendCoreTimelineEvent(input.stateDir, normalized, {
              type: "engine.event.delivery_failed",
              detail: "overflow_doc_create_failed",
              metadata: {
                fallback: overflow.mode,
                docError: overflow.docError,
                ...(overflow.mode === "failed" ? { fileError: overflow.fileError } : {}),
              },
            });
          }
        }
        const deliveryResult = await deliverCoreResponse({
          channel: input.channel,
          runtime: input.runtime,
          chatId: normalized.chatId,
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
          // A group discussion turn speaks; it never creates or changes schedules.
          ...(normalized.groupDiscussion ? { allowCronMutations: false, cronMutationContext: "discussion" as const } : {}),
          text: result.text,
          // The run card is normally the single canonical reply. Send a separate
          // markdown message only when there is no card, OR when the answer was too
          // long to show in the card AND we couldn't post it as a Feishu Doc — so the
          // full text is never lost. deliverLarkResponse still processes tool tags /
          // files / images regardless.
          sendText: runCard === undefined || (!answerShownInCard && !overflowDelivered),
          stateDir: input.stateDir,
          requestOutputDir,
          workspaceOverride,
          conversationKey: normalized.conversationKey,
          bridgeChatType: normalized.bridgeChatType,
          bridgeChatId: normalized.bridgeChatId,
          bridgeUserId: normalized.bridgeUserId,
          larkThreadId: normalized.threadId,
          larkMessageId: normalized.messageId,
          instanceName: input.instanceName,
        });
        obligationRequiresRecovery = !deliveryResult.ok;
        answerVisibleToUser = answerVisibleToUser || deliveryResult.textDelivered;
        if (obligationId) {
          await (deliveryResult.ok
            ? markDeliveryDelivered(input.stateDir, obligationId)
            : markDeliveryFailed(input.stateDir, obligationId, "post-turn delivery remained unconfirmed"));
        }
        const postTurnDeliveryFailed = !deliveryResult.ok;
        const deliveryFailed = deliveryPreflightFailed || postTurnDeliveryFailed;
        workflowOutcome = deliveryFailed ? "failed" : "delivered";
        if (postTurnDeliveryFailed) {
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.delivery_failed",
            outcome: "error",
            detail: "post_turn_delivery_unconfirmed",
            metadata: { phase: "post-engine" },
          });
        }
        if (workflowRecordId) {
          await new FileWorkflowStore(input.stateDir).update(workflowRecordId, (record) => {
            record.status = deliveryFailed ? "failed" : "completed";
          });
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: deliveryFailed ? "workflow.failed" : "workflow.completed",
            outcome: deliveryFailed ? "error" : "success",
            detail: deliveryFailed ? "workflow delivery failed" : "workflow marked completed",
            metadata: {
              workflowRecordId,
            },
          });
        }
        const finishResult = runCard
          ? requiresVisibleDeliveryPhase
            ? postTurnDeliveryFailed
              ? await runCard.failDelivery(
                  runCardAnswerText,
                  locale === "en"
                    ? "The result was generated, but attachments or follow-up content could not be confirmed."
                    : "结果已生成，但附件或后续内容未确认送达。",
                )
              : recoveredEngineError !== undefined
                ? await runCard.finishPartial(
                    runCardAnswerText,
                    renderCoreUserFacingError(recoveredEngineError, "engine", locale),
                  )
              : await runCard.finish(runCardAnswerText)
            : deliveryCardResult
          : undefined;
        runCardFinished = Boolean(runCard);
        answerVisibleToUser = answerVisibleToUser || finishResult?.shown === true;
        if (finishResult) {
          // This event now marks end-to-end delivery completion, not merely the
          // earlier engine result. Until this patch lands, the card remains in
          // "delivering" and the serial conversation queue remains occupied.
          await appendCoreTimelineEvent(input.stateDir, normalized, {
            type: "engine.event.card_finish",
            detail: finishResult.reason,
            metadata: {
              shown: finishResult.shown,
              reason: finishResult.reason,
              answerChars: cardDisplayText.length,
              answerBytes: Buffer.byteLength(cardDisplayText, "utf8"),
              ...(spillToContinuationCards ? { spillCards: answerChunks.length } : {}),
            },
          });
        }
        const recoveredPartial = recoveredEngineError !== undefined;
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: deliveryFailed || recoveredPartial ? "partial" : "success",
          ...(deliveryFailed || recoveredPartial ? {
            detail: deliveryPreflightFailed
              ? "engine completed; artifact delivery preflight failed"
              : postTurnDeliveryFailed
                ? "engine completed; post-turn delivery unconfirmed"
                : "engine interrupted after recoverable artifact response",
          } : {}),
          metadata: {
            responseChars: result.text.length,
            attachments: normalized.attachments.length,
            ...(recoveredPartial ? { recoveredEnginePartial: true } : {}),
          },
        });
        return true;
      }, runController.signal, async (error) => {
        if (completedEngineText === undefined) {
          throw error;
        }
        let salvaged = answerVisibleToUser;
        if (runCard && !runCardFinished) {
          const salvageResult = await runCard.failDelivery(
            completedEngineText,
            locale === "en"
              ? "The result was generated, but attachments or follow-up content could not be delivered."
              : "结果已生成，但附件或后续内容交付失败。",
          ).catch(() => undefined);
          salvaged = salvaged || salvageResult?.shown === true;
        }
        if (obligationId) {
          // The user already has the full answer (card/continuations/doc), or
          // the salvage finish just showed it → settle delivered; otherwise
          // leave the obligation failed so the next boot redelivers.
          await (salvaged && !obligationRequiresRecovery
            ? markDeliveryDelivered(input.stateDir, obligationId)
            : markDeliveryFailed(input.stateDir, obligationId, redactCoreErrorDetail(error)));
        }
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "engine.event.delivery_failed",
          outcome: "error",
          detail: redactCoreErrorDetail(error),
          metadata: { phase: "post-engine" },
        });
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "partial",
          detail: "engine completed; post-engine delivery failed",
          metadata: { responseChars: completedEngineText.length },
        });
        return true;
      });
    } catch (error) {
      if (error instanceof EngineNativeInputUnsentError) {
        if (runCard?.discard) await runCard.discard(error.reason);
        await appendCoreTimelineEvent(input.stateDir, normalized, { type: "turn.completed", outcome: "interrupted", detail: `native_input_${error.reason}` });
        return true;
      }
      if (completedEngineText !== undefined) {
        // The engine already completed successfully. A failure in card finishing,
        // continuation delivery, file upload, usage recording, or workflow cleanup
        // must not rewrite that completed run as "execution failed" and encourage a
        // duplicate rerun. Preserve/finish the card and record a partial delivery.
        let salvaged = answerVisibleToUser;
        if (runCard && !runCardFinished) {
          const salvageResult = await runCard.failDelivery(
            completedEngineText,
            locale === "en"
              ? "The result was generated, but attachments or follow-up content could not be delivered."
              : "结果已生成，但附件或后续内容交付失败。",
          ).catch(() => undefined);
          salvaged = salvaged || salvageResult?.shown === true;
        }
        if (obligationId) {
          await (salvaged && !obligationRequiresRecovery
            ? markDeliveryDelivered(input.stateDir, obligationId)
            : markDeliveryFailed(input.stateDir, obligationId, redactCoreErrorDetail(error)));
        }
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "engine.event.delivery_failed",
          outcome: "error",
          detail: redactCoreErrorDetail(error),
          metadata: { phase: "post-engine" },
        });
        await appendCoreTimelineEvent(input.stateDir, normalized, {
          type: "turn.completed",
          outcome: "partial",
          detail: "engine completed; post-engine delivery failed",
          metadata: { responseChars: completedEngineText.length },
        });
        return true;
      }
      const terminal = classifyCoreTurnTermination(error, runController.signal);
      let engineFailureOutcome: "error" | "partial" = "error";
      if (terminal.kind === "interrupted") {
        await runCard?.interrupt();
      } else if (terminal.kind === "idle_timeout") {
        await runCard?.idleTimeout(terminal.minutes);
      } else {
        engineFailureOutcome = await runCard?.fail(renderCoreUserFacingError(error, "engine", locale)) ?? "error";
      }
      // The run card already surfaces the terminal state; only send a separate
      // message when no card is present (fallback) so we don't duplicate it.
      if (!runCard) {
        await input.channel.send(normalized.chatId, {
          text: terminal.kind === "interrupted"
            ? (locale === "en" ? "Stopped." : "已停止。")
            : terminal.kind === "idle_timeout"
              ? (locale === "en"
                ? `No response for ${terminal.minutes} minute(s); the task was auto-stopped. Restart the instance if it keeps happening.`
                : `${terminal.minutes} 分钟无响应，任务已自动终止。若反复出现，请重启实例。`)
              : renderCoreUserFacingError(error, "engine", locale),
        }, {
          replyTo: normalized.messageId,
          replyInThread: Boolean(normalized.threadId),
        });
      }
      await appendCoreTimelineEvent(input.stateDir, normalized, {
        type: "turn.completed",
        outcome: terminal.kind === "interrupted"
          ? "interrupted"
          : terminal.kind === "idle_timeout"
            ? "idle_timeout"
            : engineFailureOutcome,
        detail: redactCoreErrorDetail(error),
      });
      return true;
    }
  } finally {
    if (workflowRecordId) await new FileWorkflowStore(input.stateDir)
      .settleProcessing(workflowRecordId, workflowOutcome).catch(() => undefined);
    // Guarded release from claimLarkRunSlot: detaches from a /goal pursuit when
    // attached, and deletes the slot only while this turn still owns it (a
    // newer claim is never clobbered).
    releaseRunSlot?.();
    // A "queued" card is normally taken over by the run card, whose creation
    // deletes this entry. If it's still tracked, the task finished via an
    // early-return path that never reached that hand-off — most commonly a queued
    // slash command (e.g. /effort max) — so settle the now-stale card instead of
    // leaving it stuck on "排队中" with dead Cancel/Wait buttons. The task's real
    // outcome was already posted as its own message.
    const lingeringQueuedRef = input.runtime.queueCards.get(normalized.messageId);
    if (lingeringQueuedRef) {
      input.runtime.queueCards.delete(normalized.messageId);
      await settleLingeringCoreQueueCard(input.channel, lingeringQueuedRef, locale).catch(() => undefined);
    }
    await cleanupCoreMessageArtifacts(input.stateDir, normalized.messageId).catch(() => undefined);
  }
}

export type CoreRunFinishReason =
  // In-place card update landed and the answer fits → shown in the run card.
  | "fit"
  // Answer exceeds the card's char/byte budget → must be delivered out-of-band.
  | "too-big"
  // In-place update kept failing (e.g. a post-interaction inline patch reverts), so the
  // finished answer was re-sent as a FRESH card (a new message, not a patch) → still shown.
  | "fresh-card"
  // Every attempt to put the answer in a card failed → caller delivers it as text.
  | "update-failed";

export interface CoreRunFinishResult {
  /** Whether the full answer is visible in a card (in place or a fresh one). */
  shown: boolean;
  reason: CoreRunFinishReason;
}

export interface CoreRunCardController {
  apply(event: EngineStreamEvent): Promise<void>;
  /** The original controller, never a newer conversation run, owns this fence. */
  isFinished?(): boolean;
  setPhase?(phase: "waiting_approval" | "waiting_answer" | "working"): void;
  /** Start a new engine attempt so repair-turn text cannot reuse an earlier attempt's narration. */
  beginAnswerAttempt(): void;
  /** Resolve a terminal result against user-visible assistant text from this attempt. */
  resolveFinalText(text: string): string;
  /** Show the final answer while its files/cards are still being delivered. */
  beginDelivery(text: string): Promise<CoreRunFinishResult>;
  /** Finalize with the answer; resolves to whether/how the answer was shown in a card. */
  finish(text: string): Promise<CoreRunFinishResult>;
  /** Preserve the generated answer while surfacing a post-engine delivery failure. */
  failDelivery(text: string, errorText: string): Promise<CoreRunFinishResult>;
  /** Preserve and label a verified partial answer when the engine terminates after producing it. */
  finishPartial(text: string, errorText: string): Promise<CoreRunFinishResult>;
  fail(text: string): Promise<"error" | "partial">;
  interrupt(): Promise<void>;
  discard?(reason: "not_admitted" | "withdrawn"): Promise<void>;
  idleTimeout(minutes: number): Promise<void>;
}

export async function createCoreRunCardController(input: {
  channel: CoreChannelLike;
  chatId: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  /** Optional: a scheduled (cron) run card has no originating message to reply to → send fresh. */
  replyTo?: string;
  replyInThread?: boolean;
  locale: "zh" | "en";
  /** Reuse the queued card (managed → CardKit in place; inline → patch) instead of sending a new one. */
  existingCard?: CoreQueueCardRef;
  /** When set, frames the card as an autonomous /goal pursuit (🎯 banner). */
  goalObjective?: string;
  /** Element-level streaming (native typewriter). Default on; pass false when
   * the instance config has elementStream === false (/stream off). */
  elementStream?: boolean;
  abortSignal?: AbortSignal;
}): Promise<CoreRunCardController | undefined> {
  if (!input.channel.updateCard) {
    return undefined;
  }
  const nativeApp = input.channel.profile === "gateway";
  let state: CoreRunState = initialCoreRunState(input.conversationKey, input.bridgeChatType);
  if (nativeApp) state.nativeRun = createRunRecord();
  let answerAttemptStartBlock = 0;
  if (input.goalObjective && input.goalObjective.trim()) {
    state = { ...state, goalObjective: input.goalObjective.trim() };
  }
  // When set, the run card is a CardKit managed card updated in place by card_id
  // (it survives the queue→run take-over and post-interaction updates, where
  // im.message.patch reverts). Otherwise it's a plain inline card patched by
  // message id — the fallback when CardKit is unavailable.
  let handle: ManagedCardHandle | undefined;
  let sent: { messageId: string; fallback: boolean } = { messageId: "", fallback: true };

  // 1) Take the queued card over as the run card, in place.
  if (input.existingCard?.handle) {
    handle = input.existingCard.handle;
    if (await updateManagedCard(input.channel, handle, renderCoreRunCard(state, input.locale))) {
      sent = { messageId: handle.messageId, fallback: false };
    } else {
      // CardKit take-over failed → recall the orphan and create a fresh card.
      handle = undefined;
      if (input.channel.recallMessage) {
        await input.channel.recallMessage(input.existingCard.messageId).catch(() => undefined);
      }
    }
  } else if (input.existingCard?.messageId) {
    try {
      await input.channel.updateCard(input.existingCard.messageId, renderCoreRunCard(state, input.locale));
      sent = { messageId: input.existingCard.messageId, fallback: false };
    } catch {
      // Inline take-over failed → recall the orphan (parity with the managed
      // branch above) so its stale live buttons can't outlive the queue and
      // later abort the wrong run. A fresh card is sent below.
      if (input.channel.recallMessage) {
        await input.channel.recallMessage(input.existingCard.messageId).catch(() => undefined);
      }
      sent = { messageId: "", fallback: true };
    }
  }

  // 2) No reusable card (or take-over failed) → send a fresh one. Prefer a
  // CardKit managed card so the whole run card updates in place; fall back to a
  // plain inline card when CardKit is unavailable.
  if (sent.fallback) {
    const managed = await sendManagedCard(input.channel, input.chatId, renderCoreRunCard(state, input.locale), {
      replyTo: input.replyTo,
      ...(input.replyInThread ? { replyInThread: true } : {}),
    });
    if (managed) {
      handle = managed;
      sent = { messageId: managed.messageId, fallback: false };
    } else {
      sent = await sendCoreCardWithFallback({
        channel: input.channel,
        chatId: input.chatId,
        card: renderCoreRunCard(state, input.locale),
        fallbackText: input.locale === "en"
          ? "Task is running. Send /stop to cancel it."
          : "任务处理中，可发送 /stop 停止。",
        options: coreReplyOptions(input.replyTo, input.replyInThread),
        locale: input.locale,
      });
    }
  }
  if (sent.fallback) {
    return undefined;
  }
  // Once the full card is too large for Feishu's update limit, every update
  // fails; switch to the compact render so live progress (and finalization)
  // keep landing instead of freezing the card in its "running" state.
  let degraded = false;
  let consecutiveFullUpdateFailures = 0;
  const FULL_UPDATE_DEGRADE_THRESHOLD = 2;
  const tryUpdate = async (card: Record<string, unknown>): Promise<boolean> => {
    if (handle) {
      return await updateManagedCard(input.channel, handle, card);
    }
    if (!input.channel.updateCard) {
      return false;
    }
    try {
      await input.channel.updateCard(sent.messageId, card);
      return true;
    } catch {
      return false;
    }
  };
  // Re-send a card as a NEW message (not an in-place patch). Used as the terminal
  // fallback when every in-place update is rejected — a fresh send dodges the
  // post-interaction patch-revert an inline run card can hit, keeping the finished
  // answer in a card instead of spilling to plain text.
  const trySendFreshInlineCard = async (
    card: Record<string, unknown>,
  ): Promise<{ messageId: string } | undefined> => {
    try {
      return await input.channel.send(input.chatId, { card }, coreReplyOptions(input.replyTo, input.replyInThread));
    } catch {
      return undefined;
    }
  };
  // Element-level streaming fast path: while only the live (last) text element
  // is growing, push just that element's text through the CardKit
  // element-content endpoint (Feishu renders the delta with its native
  // typewriter) instead of re-sending the whole card JSON. Structural changes
  // (new tool group, status/footer changes, finalize) still go through the
  // full-card patch path. Any element-update failure permanently degrades back
  // to full-card patching for this turn — the previous behavior, never worse.
  // 150ms ≈ 6.7 ticks/s. The documented per-card-entity limit for card and
  // component OpenAPIs is 10/s (open.feishu.cn cardkit-v1
  // streaming-updates-openapi-overview, and streaming mode is explicitly
  // built for continuous updates), so this keeps a 1/3 headroom — important
  // because a rate-limit error permanently degrades the turn to full-card
  // patching. Going to 100ms (10/s, zero margin) would also let two
  // concurrently streaming cards exceed the app-level 1000 req/min budget.
  const ELEMENT_STREAM_THROTTLE_MS = 150;
  // Cadence for rolling-tail refreshes once the live text outgrows the element
  // cap (each tick replaces the whole element instead of appending).
  const ROLLING_STREAM_THROTTLE_MS = 3_000;
  const elementStreamEnabled = Boolean(handle && !handle.native) &&
    input.elementStream !== false &&
    !["off", "0", "false"].includes((process.env.TAROBOT_ELEMENT_STREAM ?? process.env.CCTB_LARK_ELEMENT_STREAM ?? "").trim().toLowerCase());
  let elementStreamRetryAt = 0;
  let remoteStructureSig: string | null = null;
  let remoteLiveElementId: string | null = null;
  let lastElementContentSent = "";
  let elementTimer: ReturnType<typeof setTimeout> | undefined;
  // The card minus the live element's text: when this is unchanged since the
  // last successful full patch, the remote card's structure matches ours and an
  // element-content update is addressable + sufficient.
  const structureSignatureOf = (card: Record<string, unknown>, liveElementId: string | null): string => {
    const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
    const elements = (body?.elements ?? []).map((element) =>
      liveElementId !== null && element.element_id === liveElementId ? { ...element, content: "" } : element);
    return JSON.stringify({ ...card, body: { ...body, elements } });
  };
  const update = async (): Promise<boolean> => {
    if (!degraded) {
      // Snapshot the live element from the SAME synchronous state the card was
      // rendered from, BEFORE the network await — deltas keep arriving during
      // tryUpdate, and recording the newer state would claim the remote shows
      // content it never received (the monotonic guard would then skip sends
      // and freeze the streamed text until finalize).
      const card = renderCoreRunCard(state, input.locale);
      const liveAtRender = elementStreamEnabled ? liveRunCardStreamElement(state, input.locale) : null;
      if (await tryUpdate(card)) {
        consecutiveFullUpdateFailures = 0;
        // Native App patches do not use CardKit element addresses. Avoid
        // serializing the complete process journal just to compare that path.
        if (elementStreamEnabled) {
          remoteLiveElementId = liveAtRender?.elementId ?? null;
          remoteStructureSig = structureSignatureOf(card, remoteLiveElementId);
          lastElementContentSent = liveAtRender?.content ?? "";
        }
        return true;
      }
      // App transport failures do not imply Feishu's card-size limit. Retry
      // the full native state instead of permanently simplifying this run.
      if (nativeApp) return false;
      consecutiveFullUpdateFailures += 1;
      // One failed patch is commonly a transient network/rate-limit wobble.
      // Keep the full run card (including Stop + process stream) for one retry;
      // only repeated failures indicate the card itself is persistently invalid.
      if (consecutiveFullUpdateFailures < FULL_UPDATE_DEGRADE_THRESHOLD) {
        return false;
      }
      degraded = true;
    }
    return await tryUpdate(renderCoreRunCardCompact(state, input.locale));
  };
  // Coalesce live updates to at most one patch per THROTTLE_MS, and run every
  // patch through a single serial chain so they never race — same idea as the
  // SDK's streaming throttle + patch queue. Engine events fire-and-forget into
  // this without waiting. Native App updates need no Feishu rate-limit delay;
  // legacy cards retain their existing cadence. The chain guarantees the terminal patch lands
  // last (a late "running" patch can't revert a finished card).
  // Prioritize responsiveness for native replies of every size. Do not extend
  // the interval to save bandwidth on long answers; slow receivers still have
  // bounded pending work, and transport failures still use retry backoff.
  const THROTTLE_MS = nativeApp ? 100 : 400;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let updateDueAt = 0;
  let liveRevision = 0, publishedRevision = -1;
  let nativeFailures = 0, nativeRetryAt = 0;
  let lastNativeUpdateAt = -Infinity;
  const MAX_AUTOMATIC_RETRIES = 3;
  // Set the moment a terminal path (finish/fail/interrupt/idleTimeout) begins.
  // cancelScheduledUpdate only clears timers that exist RIGHT THEN; a
  // flushElementStream tick already sitting in patchChain runs before the terminal
  // finalize, finds the structure moved on, and calls scheduleFullUpdate() — arming
  // a fresh 400ms timer nothing can reach any more, so a stale "running" full-card
  // patch landed 400ms AFTER the card had been finalized. Once terminal, every
  // scheduling entry point is a no-op; only finalize itself still patches.
  let terminal = false;
  let patchChain: Promise<void> = Promise.resolve();
  const enqueuePatch = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = patchChain.then(fn, fn);
    patchChain = next.then(() => undefined, () => undefined);
    return next;
  };
  // A slow receiver may have one patch in flight and one waiting. Render the
  // latest state when the waiting patch starts instead of building a backlog
  // of obsolete frames that delays completion or wastes bandwidth.
  let fullUpdateQueued = false;
  const enqueueLiveUpdate = (): void => {
    if (terminal || fullUpdateQueued) return;
    fullUpdateQueued = true;
    void enqueuePatch(async () => {
      fullUpdateQueued = false;
      if (terminal || (nativeApp && publishedRevision === liveRevision)) return;
      // A waiting patch may have been queued before the in-flight write failed.
      // It must obey the same backoff as new events and automatic retries.
      if (nativeApp && performance.now() < nativeRetryAt) { scheduleNativeRetry(); return; }
      // A slow in-flight write can move the waiting patch's actual start past
      // its timer. Enforce cadence here too, rather than allowing a stale timer
      // to publish another frame immediately after that waiting patch.
      if (nativeApp && performance.now() < lastNativeUpdateAt + THROTTLE_MS) { scheduleNativeDeadline(lastNativeUpdateAt + THROTTLE_MS); return; }
      const revision = liveRevision;
      if (nativeApp) lastNativeUpdateAt = performance.now();
      const delivered = await update();
      if (!nativeApp) return;
      if (delivered) {
        publishedRevision = revision;
        nativeFailures = 0; nativeRetryAt = 0;
      } else {
        nativeFailures++;
        nativeRetryAt = performance.now() + Math.min(2000, 250 * 2 ** Math.min(nativeFailures - 1, 3));
        // No new CLI event is needed to repair a failed last delta. Bound the
        // automatic attempts; later events can retry, still respecting backoff.
        if (!terminal && nativeFailures <= MAX_AUTOMATIC_RETRIES) scheduleNativeRetry();
      }
    });
  };
  const flushUpdate = (): void => {
    updateTimer = undefined;
    updateDueAt = 0;
    if (nativeApp && performance.now() < nativeRetryAt) { scheduleNativeRetry(); return; }
    enqueueLiveUpdate();
  };
  const flushElementStream = (): void => {
    elementTimer = undefined;
    void enqueuePatch(async () => {
      // `terminal` can flip while this tick sits in the patch chain — a streamed
      // element write after finalize would put live text back on a finished card.
      if (terminal || !handle || Date.now() < elementStreamRetryAt || degraded) {
        return;
      }
      const live = liveRunCardStreamElement(state, input.locale);
      if (!live || live.elementId !== remoteLiveElementId) {
        // Structure moved on while this tick was queued; the full path owns it.
        scheduleFullUpdate();
        return;
      }
      const card = renderCoreRunCard(state, input.locale);
      if (structureSignatureOf(card, live.elementId) !== remoteStructureSig) {
        scheduleFullUpdate();
        return;
      }
      // Pre-cap: monotonic typewriter — the element shows everything sent so
      // far, and a shorter boundary-trimmed payload would visually roll it
      // back. Past the cap (rolling tail): payloads are full replacements that
      // are NOT extensions of each other, so send whenever the content changed.
      const trimmed = live.rolling ? live.content : trimToStreamSafeBoundary(live.content);
      if (live.rolling ? trimmed === lastElementContentSent : trimmed.length <= lastElementContentSent.length) {
        return;
      }
      if (await updateManagedCardElement(input.channel, handle, live.elementId, trimmed)) {
        elementStreamRetryAt = 0;
        lastElementContentSent = trimmed;
      } else {
        // Retry element streaming after a short cooldown. A single transient
        // failure must not disable native streaming for the rest of a long turn.
        elementStreamRetryAt = Date.now() + 1_000;
        scheduleFullUpdate();
      }
    });
  };
  // Leading edge: the very first live update fires immediately so the card
  // shows progress without waiting a full throttle interval; the rest coalesce.
  let firstLiveUpdateDone = false;
  const scheduleFullUpdate = (urgent = false): void => {
    if (terminal) {
      return;
    }
    if (!firstLiveUpdateDone) {
      firstLiveUpdateDone = true;
      enqueueLiveUpdate();
      return;
    }
    // Wall-clock corrections must not stretch a 250ms retry into hours.
    const now = performance.now();
    // Sparse native bursts (e.g. Codex stdout chunks) should not each pay a
    // fresh 100ms delay after an idle gap. Allow a short aggregation window,
    // while continuous streams retain the same maximum publication rate.
    const delay = nativeApp
      ? Math.max(16, lastNativeUpdateAt + THROTTLE_MS - now, nativeRetryAt - now)
      : THROTTLE_MS;
    const dueAt = now + delay;
    if (updateTimer && (!urgent || dueAt >= updateDueAt)) return;
    if (updateTimer) clearTimeout(updateTimer);
    updateDueAt = dueAt;
    updateTimer = setTimeout(flushUpdate, delay);
    updateTimer.unref?.();
  };
  const scheduleNativeDeadline = (deadline: number): void => {
    if (terminal) return;
    // Node timers can fire fractionally before a monotonic deadline. Only
    // wait the remainder, not another native aggregation/throttle interval.
    const now = performance.now(), delay = Math.max(1, Math.ceil(deadline - now));
    if (updateTimer) clearTimeout(updateTimer);
    updateDueAt = now + delay;
    updateTimer = setTimeout(flushUpdate, delay);
    updateTimer.unref?.();
  };
  const scheduleNativeRetry = (): void => scheduleNativeDeadline(nativeRetryAt);
  const scheduleUpdate = (urgent = false): void => {
    if (terminal) {
      return;
    }
    liveRevision++;
    // Phase changes must never push an existing deadline back. Failure
    // backoff still applies.
    if (
      elementStreamEnabled && Date.now() >= elementStreamRetryAt && !degraded &&
      remoteStructureSig !== null && firstLiveUpdateDone
    ) {
      const live = liveRunCardStreamElement(state, input.locale);
      if (live && live.elementId === remoteLiveElementId) {
        if (!elementTimer) {
          // Rolling-tail mode replaces the whole element each tick, so slow the
          // cadence down — a 3s tail refresh reads fine and stays well inside
          // CardKit rate limits; the pre-cap typewriter keeps its fast tick.
          elementTimer = setTimeout(
            flushElementStream,
            live.rolling ? ROLLING_STREAM_THROTTLE_MS : ELEMENT_STREAM_THROTTLE_MS,
          );
          elementTimer.unref?.();
        }
        return;
      }
    }
    scheduleFullUpdate(urgent);
  };
  // Enter the terminal phase: no further scheduling, and any timer armed so far
  // is cleared. Idempotent, so a fail() after an interrupt() is still safe.
  const cancelScheduledUpdate = (removeAbortListener = true): void => {
    terminal = true;
    if (removeAbortListener) input.abortSignal?.removeEventListener("abort", stopping);
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
      updateDueAt = 0;
    }
    if (elementTimer) {
      clearTimeout(elementTimer);
      elementTimer = undefined;
    }
  };
  // Terminal update: guarantee the card leaves the "running" state and the
  // answer is not lost. Try the full card, then the compact card, and as a
  // last resort deliver the text directly so a failed patch never swallows it.
  // Returns whether the full answer is visible in the rendered card. When it is
  // not (the card was truncated or fell back to the tiny terminal card), the
  // caller delivers the answer as a separate text message so nothing is lost.
  const finalize = async (text?: string): Promise<CoreRunFinishResult> => {
    // Byte-aware, not just char-count: Feishu's element limit is in BYTES (CJK is
    // ~3 bytes/char), so a long Chinese answer can be byte-truncated in the card
    // while its char length is well under the cap. Checking chars alone reported
    // "fit" for a truncated answer → the overflow fallback never fired and the rest
    // was lost. Require BOTH char and byte budgets so a too-big answer is delivered
    // out-of-band instead.
    const answerFitsCard = nativeApp || !text
      || (text.length <= CORE_CARD_ANSWER_MAX && Buffer.byteLength(text, "utf8") <= ELEMENT_CONTENT_MAX_BYTES);
    const fitReason: CoreRunFinishReason = answerFitsCard ? "fit" : "too-big";
    if ((nativeApp || !degraded) && await tryUpdate(renderCoreRunCard(state, input.locale))) {
      consecutiveFullUpdateFailures = 0;
      return { shown: answerFitsCard, reason: fitReason };
    }
    degraded = true;
    if (await tryUpdate(renderCoreRunCardCompact(state, input.locale))) {
      return { shown: answerFitsCard, reason: fitReason };
    }
    // Every in-place update was rejected. When the card is a fits-in-a-card answer,
    // the usual cause is a post-interaction inline patch that Feishu reverts — but a
    // fresh SEND is a new message, not a patch, so it lands where the update can't.
    // Re-send the finished card (managed first, plain inline as a backstop) so the
    // answer stays a card instead of spilling to plain text. (Skip when the answer is
    // too big for a card — that genuinely needs the out-of-band text/doc path.)
    if (answerFitsCard && text) {
      // The stale in-place card (sent.messageId) can't be updated — that's exactly why
      // we're re-sending — so best-effort RECALL it once the fresh card lands, otherwise it
      // stays frozen in "running" next to the answer card. Recall is a different API from
      // update, so it can succeed where the patch failed; if it can't, no worse than before.
      const staleMessageId = sent.messageId;
      const recallStale = async (): Promise<void> => {
        if (input.channel.recallMessage && staleMessageId) {
          await input.channel.recallMessage(staleMessageId).catch(() => undefined);
        }
      };
      const freshManaged = await sendManagedCard(input.channel, input.chatId, renderCoreRunCard(state, input.locale), {
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.replyInThread ? { replyInThread: true } : {}),
      });
      if (freshManaged) {
        await recallStale();
        handle = freshManaged; // future updates target the fresh card
        sent = { messageId: freshManaged.messageId, fallback: false };
        degraded = false;
        consecutiveFullUpdateFailures = 0;
        return { shown: true, reason: "fresh-card" };
      }
      const freshInline = await trySendFreshInlineCard(renderCoreRunCard(state, input.locale));
      if (freshInline) {
        await recallStale();
        handle = undefined;
        sent = { messageId: freshInline.messageId, fallback: false };
        degraded = false;
        consecutiveFullUpdateFailures = 0;
        return { shown: true, reason: "fresh-card" };
      }
    }
    // Both the full and compact cards can be rejected when a single element
    // (e.g. a long CJK answer) exceeds Feishu's limit. Fall back to a guaranteed-
    // tiny terminal card so the card never freezes in "running"; the caller then
    // delivers the answer as text.
    await tryUpdate(renderCoreRunCardMinimal(state, input.locale));
    return { shown: false, reason: answerFitsCard ? "update-failed" : "too-big" };
  };
  const stopping = () => {
    if (state.nativeRun && !state.nativeRun.endedAt && ["running", "delivering"].includes(state.status)) {
      state.nativeRun.phase = "stopping"; state.nativeRun.revision++; state.nativeRun.updatedAt = Date.now();
      // Delivery seals engine deltas but is still an active turn. Publish the
      // stop request to other devices without reopening the engine stream.
      if (terminal) void enqueuePatch(() => finalize()).catch(() => undefined);
      else scheduleUpdate(true);
    }
  };
  if (input.abortSignal?.aborted) stopping();
  else input.abortSignal?.addEventListener("abort", stopping, { once: true });
  return {
    isFinished: () => terminal,
    setPhase: (phase) => { if (!terminal && state.nativeRun && state.nativeRun.phase !== "stopping") { state.nativeRun.phase = phase; state.nativeRun.revision++; state.nativeRun.updatedAt = Date.now(); scheduleUpdate(true); } },
    apply: async (event) => {
      // A late engine event after the card was finalized must not mutate the
      // rendered state, nor re-arm a patch that would revert the finished card.
      if (terminal) {
        return;
      }
      const previousPhase = state.nativeRun?.phase;
      if (state.nativeRun) { recordRunEvent(state.nativeRun, event); if (input.abortSignal?.aborted) state.nativeRun.phase = "stopping"; }
      // A child contributes public evidence, never parent answer text, tools or
      // terminal state. The scoped presenter handles detached/background work.
      if (event.type === "scoped") { scheduleUpdate(); return; }
      state = applyCoreEngineEvent(state, event);
      // Engine completion is not turn completion: files, images, continuation
      // cards, and durable delivery bookkeeping may still be pending while the
      // conversation queue remains intentionally held. Never show "Done" yet.
      if (event.type === "result") {
        state = { ...state, status: "delivering" };
      }
      // Coalesced, non-blocking: never await the live patch.
      scheduleUpdate(state.nativeRun?.phase !== previousPhase);
    },
    beginAnswerAttempt: () => {
      const lastBlock = state.blocks[state.blocks.length - 1];
      if (lastBlock?.kind === "text" && lastBlock.streaming) {
        state = {
          ...state,
          blocks: [
            ...state.blocks.slice(0, -1),
            { ...lastBlock, streaming: false },
          ],
        };
      }
      answerAttemptStartBlock = state.blocks.length;
    },
    resolveFinalText: (text) => resolveCoreFinalAnswerText(state, text, answerAttemptStartBlock),
    beginDelivery: async (text): Promise<CoreRunFinishResult> => {
      const finalText = resolveCoreFinalAnswerText(state, text, answerAttemptStartBlock);
      state = { ...state, finalAnswerBlockStart: answerAttemptStartBlock };
      state = applyCoreEngineEvent(state, { type: "result", text: finalText });
      state = { ...state, status: "delivering" };
      cancelScheduledUpdate(false);
      return await enqueuePatch(() => finalize(finalText));
    },
    finish: async (text): Promise<CoreRunFinishResult> => {
      const finalText = resolveCoreFinalAnswerText(state, text, answerAttemptStartBlock);
      state = { ...state, finalAnswerBlockStart: answerAttemptStartBlock };
      // Reuse the reducer so non-streaming engines (which emit no incremental
      // assistant_text) still get the final answer seeded into the block stream.
      state = applyCoreEngineEvent(state, { type: "result", text: finalText });
      cancelScheduledUpdate();
      // Returns whether/how the answer was shown in a card.
      return await enqueuePatch(() => finalize(finalText));
    },
    failDelivery: async (text, errorText): Promise<CoreRunFinishResult> => {
      const finalText = resolveCoreFinalAnswerText(state, text, answerAttemptStartBlock);
      state = { ...state, finalAnswerBlockStart: answerAttemptStartBlock };
      state = applyCoreEngineEvent(state, { type: "result", text: finalText });
      state = {
        ...state,
        status: "delivery_error",
        errorText,
        footer: null,
      };
      cancelScheduledUpdate();
      return await enqueuePatch(() => finalize(finalText));
    },
    finishPartial: async (text, errorText): Promise<CoreRunFinishResult> => {
      const finalText = resolveCoreFinalAnswerText(state, text, answerAttemptStartBlock);
      state = { ...state, finalAnswerBlockStart: answerAttemptStartBlock };
      state = applyCoreEngineEvent(state, { type: "result", text: finalText });
      state = {
        ...state,
        status: "partial",
        errorText,
        footer: null,
      };
      cancelScheduledUpdate();
      return await enqueuePatch(() => finalize(finalText));
    },
    fail: async (text) => {
      // "partial" must mean "part of the ANSWER already arrived": only when the
      // latest text block landed AFTER the last tool event was the engine
      // already writing its reply when it died (text→crash with no tools also
      // qualifies). Text that only PRECEDES the last tool call is pre-tool
      // narration ("let me check…") — a crash there is a plain error, not a
      // partial answer the operator can trust.
      let lastTextIndex = -1;
      let lastToolIndex = -1;
      state.blocks.forEach((block, index) => {
        if (block.kind === "tool") {
          lastToolIndex = index;
        } else if (cleanCardText(block.content, input.locale).trim().length > 0) {
          lastTextIndex = index;
        }
      });
      const failureStatus = lastTextIndex > lastToolIndex ? "partial" : "error";
      state = {
        ...state,
        status: failureStatus,
        errorText: text,
        footer: null,
      };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
      return failureStatus;
    },
    interrupt: async () => {
      state = { ...state, status: "interrupted", footer: null };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
    },
    discard: async (reason) => {
      state = { ...state, status: "interrupted", footer: null,
        errorText: input.locale === "en" ? reason === "withdrawn" ? "Message withdrawn." : "Message not sent."
          : reason === "withdrawn" ? "消息已撤回。" : "消息未发送。" };
      cancelScheduledUpdate();
      await enqueuePatch(async () => {
        await finalize();
        if (sent.messageId && input.channel.recallMessage) await input.channel.recallMessage(sent.messageId);
      });
    },
    idleTimeout: async (minutes) => {
      state = { ...state, status: "idle_timeout", idleTimeoutMinutes: minutes, footer: null };
      cancelScheduledUpdate();
      await enqueuePatch(() => finalize());
    },
  };
}

async function runAuthorizedCoreTurnWithReactions<T>(
  input: {
    channel: CoreChannelLike;
    reactionSettings?: LarkReactionSettings;
  },
  normalized: CoreNormalizedBridgeMessage,
  run: () => Promise<T>,
  // The turn's own stop signal, classified exactly as the run card does: engine
  // abort errors (DeepSeek, turn pool, app-server) rarely say "stopped by user".
  // Unconfirmed and too-late stops still classify as failures.
  stopSignal: AbortSignal | undefined,
  recoverError?: (error: unknown) => Promise<T> | T,
): Promise<T> {
  const protectedRun = recoverError
    ? async (): Promise<T> => {
        try {
          return await run();
        } catch (error) {
          return await recoverError(error);
        }
      }
    : run;
  if (!input.reactionSettings) {
    return await protectedRun();
  }
  return await withLarkMessageReactions({
    channel: input.channel,
    messageId: normalized.messageId,
    settings: input.reactionSettings,
    isFailure: (error) => classifyCoreTurnTermination(error, stopSignal).kind === "error",
    run: protectedRun,
  });
}

async function enrichCoreReplyContext(
  channel: CoreChannelLike,
  normalized: CoreNormalizedBridgeMessage,
): Promise<CoreNormalizedBridgeMessage> {
  if (!normalized.replyToMessageId) {
    return normalized;
  }
  try {
    const fetched = await fetchCoreMessage(channel, normalized.replyToMessageId);
    const text = fetched ? summarizeCoreFetchedMessage(fetched) : "";
    if (!text) {
      return normalized;
    }
    return {
      ...normalized,
      replyContext: {
        messageId: normalized.replyToMessageId,
        text,
      },
    };
  } catch {
    return normalized;
  }
}

async function enrichCoreMergedForwardContext(
  channel: CoreChannelLike,
  normalized: CoreNormalizedBridgeMessage,
  message: CoreIncomingMessage,
): Promise<CoreNormalizedBridgeMessage> {
  if (message.rawContentType !== "merge_forward") {
    return normalized;
  }
  try {
    const fetched = await fetchCoreMessage(channel, message.messageId);
    const expanded = fetched ? summarizeCoreMergedForward(fetched) : "";
    if (!expanded) {
      return normalized;
    }
    return {
      ...normalized,
      text: replaceOrAppendCoreForwardedMessages(normalized.text, expanded),
    };
  } catch {
    return normalized;
  }
}

// The placeholder the channel emits when it can't read an interactive card from the
// receive event (managed/forwarded cards arrive as a reference, not inline content).
const LARK_INTERACTIVE_CARD_PLACEHOLDER = "[interactive card]";

/**
 * A forwarded/received interactive card arrives as an opaque reference, so the channel
 * surfaces only "[interactive card]" and the engine can't see the content. Re-fetch the
 * message with card_msg_content_type=user_card_content (official API: returns the original
 * card JSON) and splice the card's extracted text into the prompt, so the bot can read a
 * forwarded card. No cross-app issue: the bot reads its OWN received message.
 */
async function enrichCoreInteractiveCardContext(
  channel: CoreChannelLike,
  normalized: CoreNormalizedBridgeMessage,
  message: CoreIncomingMessage,
): Promise<CoreNormalizedBridgeMessage> {
  if (message.rawContentType !== "interactive") {
    return normalized;
  }
  if ((message.content ?? "").trim() !== LARK_INTERACTIVE_CARD_PLACEHOLDER) {
    return normalized; // the channel already extracted usable text
  }
  try {
    const cardJson = await fetchCoreCardContent(channel, message.messageId);
    const text = cardJson ? extractCoreCardText(cardJson) : "";
    if (!text) {
      return normalized;
    }
    const block = `<forwarded_card>\n${text.slice(0, 8000)}\n</forwarded_card>`;
    const newText = normalized.text.includes(LARK_INTERACTIVE_CARD_PLACEHOLDER)
      ? normalized.text.replace(LARK_INTERACTIVE_CARD_PLACEHOLDER, block)
      : [normalized.text, block].filter(Boolean).join("\n\n");
    return { ...normalized, text: newText };
  } catch {
    return normalized;
  }
}

async function fetchCoreCardContent(channel: CoreChannelLike, messageId: string): Promise<Record<string, unknown> | null> { return channel.fetchCardContent?.(messageId) ?? null; }
async function fetchCoreMessage(channel: CoreChannelLike, messageId: string): Promise<CoreFetchedMessage | null> { return channel.fetchMessage?.(messageId) ?? null; }

export function normalizeFetchedCoreMessage(value: unknown, fallbackMessageId: string): CoreFetchedMessage | null {
  const data = isRecord(value) ? value.data : undefined;
  const items = isRecord(data) && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const item = items[0];
  if (!item) {
    return null;
  }
  const parent = normalizeFetchedCoreMessageItem(item, fallbackMessageId);
  const children = items
    .slice(1)
    .filter((child) => child.upper_message_id === undefined || child.upper_message_id === parent.messageId)
    .map((child) => normalizeFetchedCoreMessageItem(child, fallbackMessageId));
  return children.length > 0 ? { ...parent, children } : parent;
}

function normalizeFetchedCoreMessageItem(item: Record<string, unknown>, fallbackMessageId: string): CoreFetchedMessage {
  const body = isRecord(item.body) ? item.body : undefined;
  const sender = isRecord(item.sender) ? item.sender : undefined;
  const messageId = typeof item.message_id === "string" ? item.message_id : fallbackMessageId;
  const messageType = typeof item.msg_type === "string"
    ? item.msg_type
    : typeof item.message_type === "string" ? item.message_type : undefined;
  const content = typeof body?.content === "string"
    ? body.content
    : typeof item.content === "string" ? item.content : undefined;
  const senderId = typeof sender?.id === "string"
    ? sender.id
    : typeof item.sender_id === "string" ? item.sender_id : undefined;
  const senderName = typeof sender?.name === "string"
    ? sender.name
    : typeof item.sender_name === "string" ? item.sender_name : undefined;
  const createTime = typeof item.create_time === "string"
    ? item.create_time
    : typeof item.createTime === "string" ? item.createTime : undefined;
  return {
    messageId,
    ...(messageType ? { messageType } : {}),
    ...(content ? { content } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(createTime ? { createTime } : {}),
  };
}

function replaceOrAppendCoreForwardedMessages(text: string, expanded: string): string {
  const block = `<forwarded_lark_messages>\n${expanded}\n</forwarded_lark_messages>`;
  if (/<forwarded_lark_messages>[\s\S]*?<\/forwarded_lark_messages>/.test(text)) {
    return text.replace(/<forwarded_lark_messages>[\s\S]*?<\/forwarded_lark_messages>/, block);
  }
  return [text, block].filter(Boolean).join("\n\n");
}

function summarizeCoreFetchedMessage(message: CoreFetchedMessage): string {
  const content = message.content?.trim();
  if (!content) {
    return "";
  }
  const parsed = parseJsonObject(content);
  const messageType = message.messageType;
  let text = "";
  if (parsed) {
    if (typeof parsed.text === "string") {
      text = parsed.text;
    } else if (typeof parsed.file_name === "string") {
      text = `[${messageType ?? "file"}: ${parsed.file_name}]`;
    } else if (messageType === "post") {
      text = extractPlainStrings(parsed).join("\n");
    } else if (messageType === "interactive") {
      text = extractCoreCardText(parsed);
    }
  }
  if (!text) {
    text = content;
  }
  return text.replace(/\s+\n/g, "\n").trim().slice(0, 2000);
}

function summarizeCoreMergedForward(message: CoreFetchedMessage): string {
  const children = message.children ?? [];
  if (children.length === 0) {
    return "";
  }
  return children
    .map((child, index) => {
      const text = summarizeCoreFetchedMessage(child);
      if (!text) {
        return "";
      }
      const sender = child.senderName ?? child.senderId ?? "unknown";
      return [
        `message ${index + 1}:`,
        `sender: ${sender}`,
        ...(child.messageType ? [`type: ${child.messageType}`] : []),
        text,
      ].join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 8000);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPlainStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractPlainStrings);
  }
  if (!isRecord(value)) {
    return [];
  }
  const direct = ["title", "text", "href"]
    .flatMap((key) => typeof value[key] === "string" ? [String(value[key]).trim()] : [])
    .filter(Boolean);
  const nested = Object.entries(value)
    .filter(([key]) => !["title", "text", "href"].includes(key))
    .flatMap(([, child]) => extractPlainStrings(child));
  return [...direct, ...nested];
}

/**
 * Pull human-readable text out of a Feishu interactive-card JSON tree (header titles,
 * plain_text / lark_md / markdown content, button labels, form fields, nested
 * elements/columns/body) so a forwarded card's content is readable by the engine.
 * Mirrors the channel SDK's card walker; handles Card 1.0 and 2.0 shapes.
 */
function extractCoreCardText(node: unknown): string {
  const pieces: string[] = [];
  visitCoreCard(node, pieces);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of pieces) {
    const key = piece.trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      lines.push(key);
    }
  }
  return lines.join("\n");
}

function visitCoreCard(node: unknown, out: string[]): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      visitCoreCard(child, out);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  const tag = obj.tag;
  if (typeof tag === "string" && (tag === "plain_text" || tag === "lark_md" || tag === "markdown")) {
    if (typeof obj.content === "string") {
      out.push(obj.content);
    }
    return;
  }
  if (isRecord(obj.header)) {
    visitCoreCard(obj.header.title, out);
  }
  if (obj.text) {
    visitCoreCard(obj.text, out);
  }
  if (obj.label) {
    visitCoreCard(obj.label, out);
  }
  if (obj.placeholder) {
    visitCoreCard(obj.placeholder, out);
  }
  if (Array.isArray(obj.options)) {
    for (const option of obj.options) {
      if (isRecord(option)) {
        visitCoreCard(option.text, out);
      }
    }
  }
  for (const key of ["elements", "fields", "actions", "columns"]) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const el of arr) {
        visitCoreCard(el, out);
      }
    }
  }
  if (obj.body) {
    visitCoreCard(obj.body, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTranscribableCoreMedia(downloaded: DownloadedCoreAttachment): boolean {
  if (downloaded.attachment.kind === "audio" || downloaded.attachment.kind === "video") {
    return true;
  }
  // A recording FORWARDED from another app (WeChat, a recorder, a meeting
  // export) arrives as an ordinary `file`, not as Feishu's `audio` kind. Those
  // used to skip transcription entirely — so a 24-minute .m4a never reached the
  // long-audio cloud route and the engine transcribed it locally by hand.
  // Decide by container instead. Images and documents are unaffected.
  if (downloaded.attachment.kind !== "file") {
    return false;
  }
  return hasTranscribableMediaExtension(downloaded.attachment.fileName ?? downloaded.localPath);
}

function isVideoCoreMedia(downloaded: DownloadedCoreAttachment): boolean {
  if (downloaded.attachment.kind === "video") {
    return true;
  }
  if (downloaded.attachment.kind !== "file") {
    return false;
  }
  return hasTranscribableVideoExtension(downloaded.attachment.fileName ?? downloaded.localPath);
}
