// Boot-time redelivery of Lark delivery obligations recorded by the ledger
// (state/delivery-obligation-store.ts). Runs once per service boot, after the
// channel connects; kept separate from service.ts so it is unit-testable with
// a mock channel. Best-effort: a redelivery failure marks the row failed (a
// later boot retries up to the attempts cap) and never blocks startup.

import {
  markDeliveryAbandoned,
  markDeliveryAttempting,
  markDeliveryDelivered,
  markDeliveryFailed,
  readDeliveryObligationContent,
  sweepRecoverableDeliveries,
} from "../state/delivery-obligation-store.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { buildCoreRecoveryResponse, deliverCoreResponse } from "./delivery.js";
import { preflightCoreResponseDeliveryDirectives } from "./delivery-followup.js";
import { extractWholeResponseFileBlock } from "./delivery-preflight.js";
import { stableCoreNumericId } from "./message-normalizer.js";
import { redactCoreErrorDetail } from "./redaction.js";
import { createCoreServiceRuntime, type CoreServiceRuntime } from "./runtime.js";
import type { CoreChannelLike } from "./types.js";
import { isGatewayChannel } from "./channel-profile.js";

export interface CoreRedeliveryChannel {
  profile?: "gateway" | "feishu";
  inConversation?<T>(chatId: string, operation: () => T): T;
  send(to: string, input: unknown, opts?: { replyTo?: string; replyInThread?: boolean }): Promise<unknown>;
  uploadImage?: CoreChannelLike["uploadImage"];
  managedCards?: CoreChannelLike["managedCards"];
}

/** Visible prefix for redeliveries that might duplicate an already-received
 *  message (crash mid-send / post-rejection retry). Honest at-least-once. */
export function recoveredReplyMarker(locale: "en" | "zh"): string {
  return locale === "zh"
    ? "♻️ 服务重启前有一条回复未确认送达，现补发（可能与之前收到的重复）："
    : "♻️ Recovered reply — the service restarted during delivery, so this may be a duplicate:";
}

export async function redeliverRecoveredCoreObligations(input: {
  channel: CoreRedeliveryChannel;
  stateDir: string;
  workspaceOverride?: string;
  instanceName?: string;
  locale: "en" | "zh";
  runtime?: CoreServiceRuntime;
  log?: (message: string) => void;
}): Promise<{ recovered: number; failed: number; abandoned: number }> {
  let recovered = 0;
  let failed = 0;
  let abandoned = 0;
  const gateway = isGatewayChannel(input.channel);
  if (gateway && !input.channel.inConversation) throw new Error("gateway_recovery_requires_context");
  const claimed = await sweepRecoverableDeliveries(input.stateDir, {
    channel: "lark",
    matches: (row) => row.chatId.startsWith("gw_") === gateway,
  });
  for (const row of claimed) {
    const recover = async () => {
      const conversationKey = row.conversationKey ?? `lark:${row.chatId}`;
      try {
        const content = await readDeliveryObligationContent(input.stateDir, row);
        const safeReplay = buildCoreRecoveryResponse(content).trim() || (input.locale === "en"
          ? "A recovered reply contained only actions that are unsafe to rerun, so those actions were skipped."
          : "恢复的回复只包含不适合自动重跑的操作，因此已跳过这些操作。");
        const replayPreflight = await preflightCoreResponseDeliveryDirectives(safeReplay, {
          stateDir: input.stateDir,
          workspaceOverride: input.workspaceOverride,
        });
        // A failed row was already attempted and its deterministic path errors
        // were surfaced to the user. Replaying valid siblings cannot fix a
        // missing/refused path; it only duplicates artifacts on every restart.
        if (row.state === "failed" && replayPreflight.issues.length > 0) {
          const reasons = [...new Set(replayPreflight.issues.map((issue) => issue.reason))];
          const detail = `unrecoverable delivery directives: ${reasons.join(", ")}`;
          await markDeliveryAbandoned(input.stateDir, row.id, detail);
          abandoned += 1;
          await appendTimelineEventBestEffort(input.stateDir, {
            type: "delivery.recovered",
            ...(input.instanceName ? { instanceName: input.instanceName } : {}),
            channel: "lark",
            chatId: stableCoreNumericId(conversationKey),
            conversationKey,
            outcome: "abandoned",
            detail: `abandoned obligation ${row.id}: ${detail}`,
            metadata: {
              obligationId: row.id,
              attempts: row.attempts,
              rejectedPaths: replayPreflight.issues.length,
              reasons,
            },
          }, "Lark delivery recovery abandonment timeline event");
          input.log?.(`delivery recovery abandoned obligation ${row.id}: ${detail}`);
          return;
        }
        const wholeFile = Boolean(extractWholeResponseFileBlock(safeReplay));
        const replyOptions = {
          ...(row.replyTo ? { replyTo: row.replyTo } : {}),
          ...(row.replyInThread !== undefined ? { replyInThread: row.replyInThread } : {}),
        };
        // A crash during this recovery is also an ambiguous send. A subsequent
        // boot must mark it visibly even if the original row was still pending.
        await markDeliveryAttempting(input.stateDir, row.id);
        if (row.needsMarker && wholeFile) {
          await input.channel.send(row.chatId, { markdown: recoveredReplyMarker(input.locale) }, replyOptions);
        }
        const delivery = await deliverCoreResponse({
          channel: input.channel as CoreChannelLike,
          runtime: input.runtime ?? createCoreServiceRuntime(),
          chatId: row.chatId,
          text: row.needsMarker && !wholeFile
            ? `${recoveredReplyMarker(input.locale)}\n\n${safeReplay}`
            : safeReplay,
          stateDir: input.stateDir,
          workspaceOverride: input.workspaceOverride,
          conversationKey,
          bridgeChatId: stableCoreNumericId(conversationKey),
          ...(row.replyTo ? { replyTo: row.replyTo } : {}),
          ...(row.replyInThread !== undefined ? { replyInThread: row.replyInThread } : {}),
          ...(input.instanceName ? { instanceName: input.instanceName } : {}),
        });
        if (!delivery.ok) {
          throw new Error("recovered delivery remained unconfirmed");
        }
        await markDeliveryDelivered(input.stateDir, row.id);
        recovered += 1;
        await appendTimelineEventBestEffort(input.stateDir, {
          type: "delivery.recovered",
          ...(input.instanceName ? { instanceName: input.instanceName } : {}),
          channel: "lark",
          chatId: stableCoreNumericId(conversationKey),
          conversationKey,
          outcome: "success",
          detail: `redelivered obligation ${row.id} (attempt ${row.attempts})`,
          metadata: {
            obligationId: row.id,
            attempts: row.attempts,
            withMarker: row.needsMarker,
            contentChars: content.length,
          },
        }, "Lark delivery recovery timeline event");
      } catch (error) {
        failed += 1;
        await markDeliveryFailed(input.stateDir, row.id, redactCoreErrorDetail(error));
        await appendTimelineEventBestEffort(input.stateDir, {
          type: "delivery.recovered",
          ...(input.instanceName ? { instanceName: input.instanceName } : {}),
          channel: "lark",
          chatId: stableCoreNumericId(conversationKey),
          conversationKey,
          outcome: "error",
          detail: redactCoreErrorDetail(error),
          metadata: {
            obligationId: row.id,
            attempts: row.attempts,
          },
        }, "Lark delivery recovery timeline event");
        input.log?.(`delivery recovery failed for obligation ${row.id}: ${redactCoreErrorDetail(error)}`);
      }
    };
    if (gateway) await input.channel.inConversation!(row.chatId, recover);
    else await recover();
  }
  return { recovered, failed, abandoned };
}
