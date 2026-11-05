import { deliverEngineQuestion } from "./engine-question.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { channelProfile, isGatewayChannel } from "./channel-profile.js";
import { workspaceArtifactRoot } from "./artifact-paths.js";
import { createScopedRunPresentation, finishScopedRunPresentation } from "./scoped-run-presentation.js";
import { deliverBackgroundTaskResponse } from "./background-task-delivery.js";
import { backgroundTaskBody, backgroundTaskContext, backgroundTaskReplyTo } from "./background-task-notice.js";
import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";

import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { applyConversationResumeScope } from "../runtime/conversation-resume.js";
import { CronAccessDeniedError } from "../runtime/cron-errors.js";
import { createFreshCronSessionId } from "../runtime/cron-session.js";
import type { CronExecutor } from "../runtime/cron-scheduler.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { larkAgentInstructions, larkMediaTaskInstruction, type LarkAgentInstructionOptions } from "./agent-instructions.js";
import { claimCoreRunSlot, isCoreRunActive } from "./bus.js";
import { deliverCoreContinuationCards, sendCoreCardWithFallback } from "./card-delivery.js";
import {
  ELEMENT_CONTENT_MAX_BYTES,
  CORE_MAX_OVERFLOW_CARDS,
  cleanCardText,
  renderCoreReminderCard,
  splitCoreAnswerIntoCardChunks,
} from "./card-renderer.js";
import { hasCorePostTurnDelivery, sendCoreMarkdown, type CoreDeliveryResult } from "./delivery.js";
import { coreAccessChatIdFromConversationKey, stableCoreNumericId } from "./message-normalizer.js";
import { LARK_OVERFLOW_DOC_MIN_CHARS, postLarkOverflowAnswerDoc } from "./overflow-doc.js";
import type { CoreServiceRuntime } from "./runtime.js";
import type { CoreBridgeLike, CoreChannelLike, CoreSendOptions } from "./types.js";

const LARK_CRON_TEXT_LIMIT = 3500;
const LARK_CRON_FAILURE_PROMPT_LIMIT = 700;

type CoreCronDeliverResponse = (input: {
  channel: CoreChannelLike;
  runtime: CoreServiceRuntime;
  chatId: string;
  text: string;
  stateDir: string;
  requestOutputDir: string;
  workspaceOverride?: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  bridgeChatId?: number;
  bridgeUserId?: number;
  larkThreadId?: string;
  larkMessageId?: string;
  replyTo?: string;
  replyInThread?: boolean;
  /** When false, only files/overflow are delivered (the text is already in the run card). */
  sendText?: boolean;
  allowCronMutations?: boolean;
}) => Promise<CoreDeliveryResult | void>;

export function buildCoreCronExecutor(input: {
  channel: CoreChannelLike;
  bridge: CoreBridgeLike;
  runtime: CoreServiceRuntime;
  stateDir: string;
  workspaceOverride?: string;
  agentInstructions?: (options: LarkAgentInstructionOptions) => string;
  deliverResponse?: CoreCronDeliverResponse;
  /** Factory for the run card an AI-task cron renders its result into (injected to avoid a cron→message-handler import cycle). */
  createRunCard?: typeof import("./message-handler.js")["createCoreRunCardController"];
  requestApproval?: typeof import("./card-actions.js")["requestCoreApproval"];
}): CronExecutor {
  return async (job, abortSignal, lifecycle): Promise<void> => {
    const startExecution = lifecycle?.deferTimeoutUntilStarted();
    abortSignal?.throwIfAborted();
    if (job.channel !== "lark") {
      throw new Error(`cannot execute non-Lark cron job ${job.id} on Lark service`);
    }
    if (!job.larkChatId) {
      throw new Error(`Lark cron job ${job.id} is missing larkChatId`);
    }
    if (job.larkChatId.startsWith("gw_") && !isGatewayChannel(input.channel)) throw new Error("gateway_channel_required_for_scheduled_job");
    const bridgeChatType = job.chatType === "group" ? "group" : "private";
    const conversationKey = job.conversationKey ?? `lark:${job.larkChatId}`;
    const accessChatId = coreAccessChatIdFromConversationKey(conversationKey);
    const conversationChatId = stableCoreNumericId(conversationKey);
    const accessDecision = input.bridge.checkAccess
      ? await input.bridge.checkAccess({
        chatId: accessChatId,
        conversationChatId,
        userId: job.userId,
        chatType: bridgeChatType,
        conversationKey,
        locale: job.locale ?? "zh",
      })
      : { kind: "allow" as const };
    if (accessDecision.kind !== "allow") {
      throw new CronAccessDeniedError(accessDecision.text ? `cron access denied: ${accessDecision.text}` : undefined);
    }

    if (job.deliveryMode === "notify") {
      await startExecution?.();
      abortSignal?.throwIfAborted();
      if (!job.mute) {
        const locale = job.locale === "en" ? "en" : "zh";
        // Reminder card — each fire sends its own card, so it is still a separate
        // push (never batched). Falls back to the plain "⏰ 提醒" text if the card
        // can't be sent, so a reminder is never silently dropped.
        await sendCoreCardWithFallback({
          channel: input.channel,
          chatId: job.larkChatId,
          card: renderCoreReminderCard(coreReminderBody(job), locale),
          fallbackText: renderCoreCronNotification(job),
          options: coreCronReplyOptions(job),
          locale,
        });
      }
      return;
    }

    const runCronTurn = async (): Promise<void> => {
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (abortSignal?.aborted) {
        controller.abort();
      } else {
        abortSignal?.addEventListener("abort", forwardAbort, { once: true });
      }
      // Claim the conversation's activeRuns slot — or ATTACH to a live /goal
      // pursuit instead of aborting it (a scheduled firing used to kill the
      // pursuit exactly like an ordinary message did; a pursued goal must
      // survive cron traffic and only /stop or /goal clear may end it). See
      // claimLarkRunSlot / LarkGoalRunController in bus.ts for the stop routing.
      const releaseRunSlot = claimCoreRunSlot(input.runtime, conversationKey, {
        abortController: controller,
        startedAt: Date.now(),
      });

      try {
        controller.signal.throwIfAborted();
        await startExecution?.();
        controller.signal.throwIfAborted();
        // A pending App session selection and its workspace belong to this
        // queued conversation, just as they do for ordinary message turns.
        await input.channel.prepareConversation?.(job.larkChatId!);
        const requestOutputDir = path.join(workspaceArtifactRoot(input.stateDir, "output"), `cron-${job.id}`);
        await mkdir(requestOutputDir, { recursive: true });
        const replyFields = coreCronReplyFields(job);
        const locale = job.locale === "en" ? "en" : "zh";
        const cfg = await loadInstanceConfig(input.stateDir);
        await applyConversationResumeScope(input.stateDir, conversationKey, cfg);
        const workspaceOverride = input.workspaceOverride ?? resolveInstanceWorkspacePath(cfg);
        const budgetExhausted = await checkBudgetAvailability(input.stateDir, cfg.budgetUsd, locale);
        if (budgetExhausted) {
          if (!job.mute) {
            await sendCoreMarkdown(input.channel, job.larkChatId!, budgetExhausted.message, replyFields);
          }
          return;
        }
        // Render the AI task's result into a run card (same UX as a chat reply):
        // open the card, run the turn, then finish it with the answer.
        const runCard = !job.mute && input.createRunCard
          ? await input.createRunCard({
              channel: input.channel,
              chatId: job.larkChatId!,
              conversationKey,
              bridgeChatType,
              locale,
              abortSignal: controller.signal,
              elementStream: cfg.elementStream !== false,
              ...(replyFields.replyTo
                ? { replyTo: replyFields.replyTo, replyInThread: replyFields.replyInThread ?? false }
                : {}),
            })
          : undefined;
        const activeRun = input.runtime.activeRuns.get(conversationKey);
        if (activeRun?.abortController === controller) {
          activeRun.hasRunCard = Boolean(runCard);
        }
        const scopedRuns = createScopedRunPresentation({ channel: input.channel, chatId: job.larkChatId!,
          conversationKey, ...replyFields, locale });
        let result: Awaited<ReturnType<typeof input.bridge.handleAuthorizedMessage>>;
        try {
          result = await input.bridge.handleAuthorizedMessage({
            chatId: accessChatId,
            userId: job.userId,
            chatType: bridgeChatType,
            text: job.prompt,
            conversationKey,
            locale: job.locale ?? "zh",
            files: [],
            requestOutputDir,
            workspaceOverride,
            sessionIdOverride: job.sessionMode === "new_per_run" ? createFreshCronSessionId(job) : undefined,
            abortSignal: controller.signal,
            disableRuntimeTimeout: cfg.disableRuntimeTimeout === true,
            ...(job.mute && channelProfile() === "gateway" ? { suppressAppDelivery: true } : {}),
            ...(channelProfile() === "gateway" && replyFields.replyTo ? { appDeliveryReplyTo: replyFields.replyTo } : {}),
            instructions: (input.agentInstructions ?? larkAgentInstructions)({
              engine: cfg.engine,
              claudeChrome: cfg.claudeChrome,
              timezone: cfg.timezone,
              context: "cron",
            }),
            turnInstructions: larkMediaTaskInstruction(job.prompt),
            onEngineEvent: job.mute ? undefined : async event => {
              if (event.type === "scoped") { await scopedRuns.apply(event, { foreground: runCard }); return; }
              if (await deliverEngineQuestion(event, { ...input, chatId: job.larkChatId!, conversationKey,
                bridgeChatType, ...replyFields, locale, abortSignal: controller.signal,
                isCurrentTurn: () => isCoreRunActive(input.runtime, conversationKey, controller),
              })) return;
              if (event.type === "task_notification") {
                const replyTo = backgroundTaskReplyTo(event, replyFields.replyTo, input.channel.profile);
                if (event.settlesCurrentTurn || event.suppressUserDelivery) {
                  await finishScopedRunPresentation({ channel: input.channel, conversationKey, replyTo }, event);
                  return;
                }
                await deliverBackgroundTaskResponse({ channel: input.channel, runtime: input.runtime,
                  chatId: job.larkChatId!, conversationKey, bridgeChatType,
                  replyTo, replyInThread: Boolean(replyTo && replyFields.replyInThread),
                  text: [renderBackgroundTaskHeader(locale, event.status), backgroundTaskContext(event, locale), backgroundTaskBody(event, locale)].filter(Boolean).join("\n"),
                  stateDir: input.stateDir, requestOutputDir, workspaceOverride,
                  bridgeChatId: job.chatId, bridgeUserId: job.userId,
                  larkThreadId: job.larkThreadId, larkMessageId: job.larkMessageId,
                }, event, locale);
                return;
              }
              await runCard?.apply(event);
            },
            onApprovalRequest: input.requestApproval
              ? async (request) => {
                  runCard?.setPhase?.(request.toolName === "AskUserQuestion" ? "waiting_answer" : "waiting_approval");
                  try { return await input.requestApproval!({
                  channel: input.channel,
                  runtime: input.runtime,
                  chatId: job.larkChatId!,
                  conversationKey,
                  bridgeChatType,
                  requesterUserId: job.userId,
                  ...replyFields,
                  locale,
                  request,
                  abortSignal: AbortSignal.any([controller.signal, ...(request.abortSignal ? [request.abortSignal] : [])]),
                }); } finally { runCard?.setPhase?.("working"); }
              }
              : undefined,
          });
        } catch (error) {
          if (runCard) {
            if (controller.signal.aborted) {
              await runCard.interrupt().catch(() => {});
            } else {
              await runCard.fail(job.locale === "en" ? "Scheduled task failed." : "定时任务执行失败。").catch(() => {});
            }
          }
          throw error;
        }

        scopedRuns.markForegroundEnded();
        await recordBridgeTurnUsage(input.stateDir, result.usage, cfg.budgetUsd);
        if (job.mute) {
          return;
        }
        const finalText = result.text || renderCoreEmptyCronAgentReply(job);
        const cardDisplayText = runCard ? cleanCardText(finalText, locale) : finalText;
        const answerChunks = runCard ? splitCoreAnswerIntoCardChunks(cardDisplayText) : [cardDisplayText];
        const spillToContinuationCards = Boolean(runCard)
          && answerChunks.length > 1
          && answerChunks.length <= CORE_MAX_OVERFLOW_CARDS;
        const needsOverflowDocument = Boolean(runCard)
          && answerChunks.length > CORE_MAX_OVERFLOW_CARDS;
        const requiresVisibleDeliveryPhase = spillToContinuationCards
          || needsOverflowDocument
          || hasCorePostTurnDelivery(result.text);
        const runCardAnswerText = spillToContinuationCards ? answerChunks[0]! : cardDisplayText;
        let answerShownInCard = false;
        try {
          if (runCard) {
            answerShownInCard = (await (requiresVisibleDeliveryPhase
              ? runCard.beginDelivery(runCardAnswerText)
              : runCard.finish(runCardAnswerText))).shown;
          }
          let overflowDelivered = false;
          if (spillToContinuationCards && answerShownInCard) {
            await deliverCoreContinuationCards({
              channel: input.channel,
              chatId: job.larkChatId!,
              chunks: answerChunks,
              replyOptions: replyFields,
              locale,
            });
            overflowDelivered = true;
          } else if (
            channelProfile() !== "gateway" && runCard
            && !answerShownInCard
            && (finalText.length > LARK_OVERFLOW_DOC_MIN_CHARS
              || Buffer.byteLength(finalText, "utf8") > ELEMENT_CONTENT_MAX_BYTES)
          ) {
            const overflow = await postLarkOverflowAnswerDoc({
              channel: input.channel,
              createDocument: input.runtime.createDocument,
              chatId: job.larkChatId!,
              replyOptions: replyFields,
              text: finalText,
              locale,
            });
            overflowDelivered = overflow.delivered;
          }
          if (input.deliverResponse) {
            const deliveryResult = await input.deliverResponse({
              channel: input.channel,
              runtime: input.runtime,
              chatId: job.larkChatId!,
              text: result.text,
              stateDir: input.stateDir,
              requestOutputDir,
              workspaceOverride,
              conversationKey,
              bridgeChatType,
              bridgeChatId: job.chatId,
              bridgeUserId: job.userId,
              larkThreadId: job.larkThreadId,
              larkMessageId: job.larkMessageId,
              sendText: runCard ? !answerShownInCard && !overflowDelivered : true,
              allowCronMutations: false,
              ...replyFields,
            });
            if (deliveryResult && !deliveryResult.ok) {
              throw new Error("scheduled post-turn delivery remained unconfirmed");
            }
          } else if (!runCard) {
            await sendCoreMarkdown(input.channel, job.larkChatId!, finalText, {
              ...replyFields,
            });
          }
          if (requiresVisibleDeliveryPhase) {
            await runCard?.finish(runCardAnswerText);
          }
        } catch (error) {
          await runCard?.failDelivery(
            finalText,
            locale === "en"
              ? "The scheduled result was generated, but its delivery did not finish."
              : "定时任务结果已生成，但交付未完成。",
          ).catch(() => undefined);
          throw error;
        }
      } finally {
        abortSignal?.removeEventListener("abort", forwardAbort);
        // Guarded release (claimLarkRunSlot): detaches from a pursuit when
        // attached; deletes the slot only while this cron turn still owns it.
        releaseRunSlot();
      }
    };

    // Scheduled AI turns share the same conversation queue as chat messages.
    // This prevents cron from racing a user turn before the bridge session bind is
    // visible, and makes the run card's Stop button target the cron controller.
    await input.runtime.chatQueue.enqueue(conversationKey, runCronTurn);
  };
}

export async function sendCoreCronFailureNotification(
  channel: CoreChannelLike,
  job: CronJobRecord,
  detail: string,
): Promise<void> {
  if (job.channel !== "lark" || !job.larkChatId || job.mute) {
    return;
  }
  if (job.larkChatId.startsWith("gw_") && !isGatewayChannel(channel)) throw new Error("gateway_channel_required_for_failure_notice");
  const message = buildCoreCronFailureMessage(job, detail);
  const replyOptions = coreCronReplyOptions(job);
  if (replyOptions) {
    await channel.send(job.larkChatId, { text: message }, replyOptions);
    return;
  }
  await channel.send(job.larkChatId, { text: message });
}

function buildCoreCronFailureMessage(job: CronJobRecord, detail: string): string {
  const prompt = truncateCoreCronText(
    job.prompt,
    LARK_CRON_FAILURE_PROMPT_LIMIT,
    job.locale === "en" ? "..." : "…",
  );
  const prefix = job.locale === "en"
    ? `⚠️ Scheduled task failed\nID  ${job.id}\n📝 ${prompt}\nError: `
    : `⚠️ 定时任务执行失败\nID  ${job.id}\n📝 ${prompt}\n错误：`;
  const remaining = Math.max(0, LARK_CRON_TEXT_LIMIT - prefix.length);
  const truncationNotice = job.locale === "en"
    ? "\n... (error detail truncated; see service logs or timeline.)"
    : "\n…（错误详情过长，已截断；完整详情见服务日志或 timeline。）";
  return `${prefix}${truncateCoreCronText(detail, remaining, truncationNotice)}`;
}

function truncateCoreCronText(value: string, limit: number, truncationNotice: string): string {
  const text = value.trim();
  if (text.length <= limit) {
    return text;
  }
  if (limit <= truncationNotice.length) {
    return truncationNotice.slice(0, limit);
  }
  return `${text.slice(0, limit - truncationNotice.length).trimEnd()}${truncationNotice}`;
}

function stripCoreReminderPrefix(prompt: string): string {
  const trimmed = prompt.trim();
  const stripped = trimmed
    .replace(/^(?:提醒我|提醒一下我|提醒一下|提醒)[\s:：,，。.]*/u, "")
    .replace(/^remind me(?:\s+to)?[\s:：,，.]*/i, "")
    .trim();
  return stripped || trimmed;
}

function stripLeadingCoreReminderTimeAnchors(prompt: string): string {
  let body = prompt.trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stripped = body
      .replace(
        /^(?:(?:大后天|明上午|明下午|明晚上|今天|明天|后天|今晚|今早|明早|明晚|早上|上午|中午|下午|晚上|凌晨)(?:的)?|(?:下下|本|这|下)?周[一二三四五六日天](?:的)?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?(?:的)?)[\s:：,，。.]*/u,
        "",
      )
      .replace(/^(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|next\s+\w+)(?:'s)?[\s:：,，.]*/i, "")
      .trim();
    if (stripped === body || stripped.length === 0) {
      break;
    }
    body = stripped;
  }
  return body || prompt.trim();
}

/** The reminder text with the "提醒我…" prefix and leading time anchors stripped — shared by the card body and the plain-text fallback. */
function coreReminderBody(job: CronJobRecord): string {
  return stripLeadingCoreReminderTimeAnchors(stripCoreReminderPrefix(job.prompt));
}

function renderCoreCronNotification(job: CronJobRecord): string {
  const prefix = job.locale === "en" ? "⏰ Reminder\n" : "⏰ 提醒\n";
  const truncationNotice = job.locale === "en"
    ? "\n... (reminder text truncated.)"
    : "\n…（提醒内容过长，已截断。）";
  return `${prefix}${truncateCoreCronText(coreReminderBody(job), LARK_CRON_TEXT_LIMIT - prefix.length, truncationNotice)}`;
}

function renderCoreEmptyCronAgentReply(job: CronJobRecord): string {
  return job.locale === "en" ? "(empty reply)" : "（空回复）";
}

function coreCronReplyOptions(job: CronJobRecord): CoreSendOptions | undefined {
  return coreReplyOptions(...coreCronReplyTuple(job));
}

function coreCronReplyFields(job: CronJobRecord): { replyTo?: string; replyInThread?: boolean } {
  const [replyTo, replyInThread] = coreCronReplyTuple(job);
  return replyTo ? { replyTo, replyInThread } : {};
}

function coreCronReplyTuple(job: CronJobRecord): [string | undefined, boolean | undefined] {
  return job.larkThreadId && job.larkMessageId ? [job.larkMessageId, true] : [undefined, undefined];
}

function coreReplyOptions(replyTo: string | undefined, replyInThread: boolean | undefined): CoreSendOptions | undefined {
  if (!replyTo) {
    return undefined;
  }
  return {
    replyTo,
    ...(replyInThread !== undefined ? { replyInThread } : {}),
  };
}
