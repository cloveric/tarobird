import { randomUUID } from "node:crypto";
import { loadInstanceConfig } from "../state/instance-config.js";

import type { Bridge } from "../runtime/bridge.js";
import { appendAuditEventBestEffort } from "../runtime/audit-events.js";
import { classifyFailure, getBusErrorSemantics } from "../runtime/error-classification.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import {
  checkBudgetAvailability,
  recordBridgeTurnUsage,
} from "../runtime/bridge-turn.js";
import { createBusErrorResponse, createBusTalkResponseEnvelope } from "./bus-protocol.js";
import type { BusTalkHandler, BusTalkResponse } from "./bus-server.js";

export function createBusTalkHandler(input: {
  bridge: Pick<Bridge, "handleAuthorizedMessage">;
  stateDir: string;
  instanceName: string;
}): BusTalkHandler {
  // Process-local synthetic chat IDs for bus turns, used only for timeline/audit
  // labelling. They must NOT key a persisted session: a per-process counter would
  // reset to -1 on restart and resume an unrelated previous bus session (context
  // bleed) while accumulating stored sessions without bound. Each bus turn instead
  // runs on a fresh ephemeral session via sessionIdOverride (never persisted/resumed),
  // minted as a logical `tarobot-bus-<uuid>` id (see runBusTurn).
  let busSessionCounter = 0;

  const runBusTurn: BusTalkHandler = async (req, context): Promise<BusTalkResponse> => {
    const startedAt = Date.now();
    const busChatId = -(++busSessionCounter);
    // A neutral logical ID starts a fresh, unbound session on every engine.
    const ephemeralSessionId = `tarobot-bus-${randomUUID()}`;
    await appendTimelineEventBestEffort(input.stateDir, {
      type: "turn.started",
      instanceName: input.instanceName,
      channel: "bus",
      chatId: busChatId,
      userId: 0,
      metadata: {
        fromInstance: req.fromInstance,
        depth: req.depth,
      },
    }, "bus timeline event");
    const cfg = await loadInstanceConfig(input.stateDir).catch((error: unknown) => {
      console.error("Failed to load delegated turn configuration; keeping runtime timeouts, budget not enforced:", error instanceof Error ? error.message : error);
      return null;
    });
    const budgetUsd = cfg?.budgetUsd;
    const exhausted = await checkBudgetAvailability(input.stateDir, budgetUsd, "en");

    if (exhausted) {
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.reply",
        instanceName: input.instanceName,
        outcome: "reply",
        detail: "budget exhausted",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
        },
      }, "bus audit event");
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "budget.blocked",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        detail: "budget exhausted",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          budgetUsd: exhausted.budgetUsd,
          totalCostUsd: exhausted.usage.totalCostUsd,
        },
      }, "bus timeline event");
      return createBusErrorResponse({
        fromInstance: input.instanceName,
        error: exhausted.message,
        errorCode: "budget_exhausted",
        retryable: false,
        durationMs: Date.now() - startedAt,
      });
    }

    try {
      context?.abortSignal?.throwIfAborted();
      const result = await input.bridge.handleAuthorizedMessage({
        chatId: busChatId,
        userId: 0,
        chatType: "bus",
        text: req.prompt,
        files: [],
        sessionIdOverride: ephemeralSessionId,
        disableRuntimeTimeout: cfg?.disableRuntimeTimeout === true,
        abortSignal: context?.abortSignal,
      });

      const recorded = await recordBridgeTurnUsage(input.stateDir, result.usage, budgetUsd);
      // Preserve reported usage even if cancellation races a completed turn,
      // but never label a cancelled request as a successful delivery.
      context?.abortSignal?.throwIfAborted();
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.handle",
        instanceName: input.instanceName,
        outcome: "success",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          responseChars: result.text.length,
        },
      }, "bus audit event");
      if (recorded?.reachedBudget && budgetUsd !== undefined) {
        await appendAuditEventBestEffort(input.stateDir, {
          type: "bus.reply",
          instanceName: input.instanceName,
          outcome: "reply",
          detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
          metadata: {
            fromInstance: req.fromInstance,
            depth: req.depth,
            durationMs: Date.now() - startedAt,
          },
        }, "bus audit event");
        await appendTimelineEventBestEffort(input.stateDir, {
          type: "budget.threshold_reached",
          instanceName: input.instanceName,
          channel: "bus",
          chatId: busChatId,
          userId: 0,
          detail: `budget threshold reached: $${recorded.usage.totalCostUsd.toFixed(4)} / $${budgetUsd.toFixed(2)}`,
          metadata: {
            fromInstance: req.fromInstance,
            depth: req.depth,
            totalCostUsd: recorded.usage.totalCostUsd,
            budgetUsd,
          },
        }, "bus timeline event");
      }

      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        outcome: "success",
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          responseChars: result.text.length,
          durationMs: Date.now() - startedAt,
        },
      }, "bus timeline event");
      return createBusTalkResponseEnvelope({
        success: true,
        text: result.text,
        fromInstance: input.instanceName,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const cancelled = context?.abortSignal?.aborted === true;
      const failureCategory = classifyFailure(error);
      const mapped = getBusErrorSemantics(failureCategory);
      await appendAuditEventBestEffort(input.stateDir, {
        type: "bus.handle",
        instanceName: input.instanceName,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          failureCategory,
          ...(cancelled ? { cancelled: true } : {}),
        },
      }, "bus audit event");
      await appendTimelineEventBestEffort(input.stateDir, {
        type: "turn.completed",
        instanceName: input.instanceName,
        channel: "bus",
        chatId: busChatId,
        userId: 0,
        outcome: cancelled ? "interrupted" : "error",
        detail: error instanceof Error ? error.message : String(error),
        metadata: {
          fromInstance: req.fromInstance,
          depth: req.depth,
          durationMs: Date.now() - startedAt,
          failureCategory,
        },
      }, "bus timeline event");
      return createBusErrorResponse({
        fromInstance: input.instanceName,
        error: error instanceof Error ? error.message : String(error),
        errorCode: cancelled ? "cancelled" : mapped.code,
        retryable: cancelled ? false : mapped.retryable,
        durationMs: Date.now() - startedAt,
      });
    }
  };

  return runBusTurn;
}
