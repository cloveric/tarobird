import { z } from "zod";
import { conversationSchema, idSchema, type Json } from "../client-protocol/index.js";
import { scheduleMutationSchema, type ScheduledTask } from "../client-protocol/schedules.js";
import { buildCronInput } from "../tools/cron-add-tool.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import { createCronSnapshotter } from "../runtime/cron-snapshot.js";
import { redactSecrets } from "../runtime/secret-redaction.js";
import { GatewayReceipts } from "./receipts.js";
import type { GatewayChannel } from "./channel.js";
import type { GatewayServiceOptions } from "./service.js";

/** App task management uses the worker's existing durable store and scheduler.
 * Historical lark:gw_ keys are retained; no Feishu transport is involved. */
export function gatewaySchedules(options: GatewayServiceOptions, channel: GatewayChannel) {
  const receipts = new GatewayReceipts(options.stateDir);
  return async (method: string, raw: unknown) => {
    const runtime = options.runtime.cronRuntime;
    if (!runtime) return { ok: false, error: "scheduler_unavailable" };
    if (method === "schedules.list") {
      z.object({}).strict().parse(raw);
      const snapshot = createCronSnapshotter();
      const jobs: ScheduledTask[] = (await runtime.store.list()).filter(job => job.channel === "lark" && job.larkChatId?.startsWith("gw_")).map(job => ({
        id: job.id, conversationId: job.larkChatId!, title: job.description || job.prompt.slice(0, 80), prompt: job.prompt,
        timezone: job.timezone ?? "UTC", timing: job.runOnce ? { kind: "once", at: job.targetAt ?? "" } : { kind: "cron", expression: job.cronExpr },
        ...(job.runOnce && !job.targetAt ? { validationError: "missing_run_time" as const } : {}),
        sessionMode: job.sessionMode, deliveryMode: job.deliveryMode, enabled: job.enabled, updatedAt: job.updatedAt,
        nextRunAt: snapshot(job).nextRunAt, lastRunAt: job.lastRunAt ?? null, lastError: job.lastError ? redactSecrets(job.lastError) : null,
      }));
      return { jobs, schedulerAvailable: true };
    }
    const { userId, locale, mutation } = z.object({ userId: idSchema, locale: z.enum(["zh", "en"]), mutation: scheduleMutationSchema }).strict().parse(raw);
    // Even replays check the Bot's current membership before accessing receipts.
    const conversation = conversationSchema.parse(await channel.transport.request("conversation", { conversationId: mutation.conversationId }));
    if (!conversation.botIds.includes(options.botId)) throw new Error("bot_forbidden");
    const key = buildCoreConversationKey(conversation.id);
    const receipt = await receipts.run(`schedule:${userId}:${mutation.requestId}`, async (): Promise<Json> => {
      let input;
      if (mutation.action === "create" || mutation.action === "update") {
        const s = mutation.settings;
        try {
          input = await buildCronInput({ prompt: s.prompt, description: s.title, timezone: s.timezone, sessionMode: s.sessionMode, deliveryMode: "agent",
            ...(s.timing.kind === "once" ? { at: s.timing.at } : { cron: s.timing.expression }) }, {
            stateDir: options.stateDir, channel: "lark", chatId: stableCoreNumericId(key), userId: stableCoreNumericId(`user:gwuser_${userId}`),
            chatType: conversation.type === "group" ? "group" : "private", conversationKey: key, larkChatId: conversation.id, locale,
          });
        } catch { return { ok: false, error: "invalid_schedule" }; }
      }
      if (mutation.action === "create") await runtime.store.add(input!);
      else {
        const old = await runtime.store.get(mutation.id);
        if (!old || old.channel !== "lark" || old.larkChatId !== conversation.id) return { ok: false, error: "schedule_not_found" };
        if (old.updatedAt !== mutation.expectedUpdatedAt) return { ok: false, error: "schedule_conflict" };
        if (mutation.action === "enabled" && mutation.enabled && old.runOnce && (!old.targetAt || Date.parse(old.targetAt) <= Date.now())) return { ok: false, error: "invalid_schedule" };
        try {
          if (mutation.action === "remove") await runtime.store.remove(old.id, mutation.expectedUpdatedAt);
          else await runtime.store.update(old.id, mutation.action === "enabled" ? { enabled: mutation.enabled } : {
            prompt: input!.prompt, description: input!.description, cronExpr: input!.cronExpr, timezone: input!.timezone,
            runOnce: input!.runOnce ?? false, targetAt: input!.targetAt ?? null, sessionMode: input!.sessionMode,
          }, mutation.expectedUpdatedAt);
        } catch (error) {
          if (error instanceof Error && error.message === "schedule_conflict") return { ok: false, error: "schedule_conflict" };
          throw error;
        }
      }
      await runtime.scheduler.refresh();
      return { ok: true };
    });
    return receipt.ok ? receipt.result! : { ok: false, error: "operation_uncertain" };
  };
}
