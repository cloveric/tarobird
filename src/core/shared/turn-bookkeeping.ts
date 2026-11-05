import type { AdapterUsage } from "../../codex/adapter.js";
import { appendAuditEventBestEffort } from "../../runtime/audit-events.js";
import { appendTimelineEventBestEffort } from "../../runtime/timeline-events.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../../runtime/bridge-turn.js";
import { classifyFailure } from "../../runtime/error-classification.js";
import type { Locale } from "../../runtime/locale.js";
import { chunkMarkdown } from "../../runtime/markdown-chunks.js";
import type { CoreCommandChannel } from "./command-reply.js";
import { getConversationLogScope } from "../../runtime/conversation-key.js";
import type { CoreCommandMessage, CoreCommandReplyApi } from "./command-message.js";

export interface CoreTurnContext {
  api: CoreCommandReplyApi;
  instanceName?: string;
  channel?: CoreCommandChannel;
  updateId?: number;
  /** Observes the same handled outcome written to audit; never changes it. */
  onHandleOutcome?: (outcome: HandleOutcome, detail?: string) => void;
}
type HandleOutcome = "success" | "error" | "reply" | "duplicate" | "invalid" | "empty" | "stopped";

export async function appendUpdateHandleAuditEventBestEffort(
  stateDir: string,
  context: CoreTurnContext,
  normalized: CoreCommandMessage,
  input: {
    outcome: HandleOutcome;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try { context.onHandleOutcome?.(input.outcome, input.detail); } catch { /* Observation is best effort. */ }
  const metadata = input.outcome === "error" && input.metadata?.failureCategory === undefined
    ? {
      ...input.metadata,
      failureCategory: classifyFailure(input.detail ?? "update.handle"),
    }
    : input.metadata;

  await appendAuditEventBestEffort(stateDir, {
    type: "update.handle",
    instanceName: context.instanceName,
    chatId: normalized.chatId,
    ...getConversationLogScope(normalized),
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: input.outcome,
    detail: input.detail,
    metadata,
  });

  await appendTimelineEventBestEffort(stateDir, {
    type: typeof input.metadata?.command === "string" ? "command.handled" : "turn.completed",
    instanceName: context.instanceName,
    channel: context.channel ?? "telegram",
    chatId: normalized.chatId,
    ...getConversationLogScope(normalized),
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: input.outcome,
    detail: input.detail,
    metadata,
  });
}

export async function appendUpdateReplyAuditEventBestEffort(
  stateDir: string,
  context: CoreTurnContext,
  normalized: CoreCommandMessage,
  input: {
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendAuditEventBestEffort(stateDir, {
    type: "update.reply",
    instanceName: context.instanceName,
    chatId: normalized.chatId,
    ...getConversationLogScope(normalized),
    userId: normalized.userId,
    updateId: context.updateId,
    outcome: "reply",
    detail: input.detail,
    metadata: input.metadata,
  });
}

export async function appendCommandSuccessAuditEventBestEffort(
  stateDir: string,
  context: CoreTurnContext,
  normalized: CoreCommandMessage,
  input: {
    startedAt: number;
    command: string;
    responseText?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
    outcome: "success",
    metadata: {
      durationMs: Date.now() - input.startedAt,
      command: input.command,
      attachments: normalized.attachments.length,
      responseChars: input.responseText?.length,
      // Engine/session command callers retain their existing chunk contract;
      // Bus commands record the actual count at their own send boundary.
      chunkCount: input.responseText ? chunkMarkdown(input.responseText, 4000).length : undefined,
      ...input.metadata,
    },
  });
}

export async function maybeReplyWithBudgetExhausted(
  stateDir: string,
  budgetUsd: number | undefined,
  locale: Locale,
  context: CoreTurnContext,
  normalized: CoreCommandMessage,
): Promise<boolean> {
  const exhausted = await checkBudgetAvailability(stateDir, budgetUsd, locale);
  if (!exhausted) {
    return false;
  }

  await context.api.sendMessage(normalized.chatId, exhausted.message);
  await appendUpdateReplyAuditEventBestEffort(stateDir, context, normalized, {
    detail: "budget exhausted",
  });
  await appendTimelineEventBestEffort(stateDir, {
    type: "budget.blocked",
    instanceName: context.instanceName,
    channel: context.channel ?? "telegram",
    chatId: normalized.chatId,
    ...getConversationLogScope(normalized),
    userId: normalized.userId,
    updateId: context.updateId,
    detail: "budget exhausted",
    metadata: {
      budgetUsd: exhausted.budgetUsd,
      totalCostUsd: exhausted.usage.totalCostUsd,
    },
  });
  return true;
}

export async function recordTurnUsageAndBudgetAudit(
  stateDir: string,
  budgetUsd: number | undefined,
  context: CoreTurnContext,
  normalized: CoreCommandMessage,
  usage: AdapterUsage | undefined,
): Promise<void> {
  const recorded = await recordBridgeTurnUsage(stateDir, usage, budgetUsd);
  if (!recorded?.reachedBudget || budgetUsd === undefined) {
    return;
  }

  await appendUpdateReplyAuditEventBestEffort(stateDir, context, normalized, {
    detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
  });
  await appendTimelineEventBestEffort(stateDir, {
    type: "budget.threshold_reached",
    instanceName: context.instanceName,
    channel: context.channel ?? "telegram",
    chatId: normalized.chatId,
    ...getConversationLogScope(normalized),
    userId: normalized.userId,
    updateId: context.updateId,
    detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
    metadata: {
      budgetUsd,
      totalCostUsd: recorded.usage.totalCostUsd,
      requestCount: recorded.usage.requestCount,
    },
  });
}
