import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { SWARM_TASKS_CAPABILITY, stripSwarmTaskFields, engineSessionRecoverySchema, engineTaskSnapshotSchema, engineTaskStopSchema, engineTaskControlResultSchema } from "../client-protocol/engine-tasks.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import { resolveCoreLocale } from "../core/locale.js";
import { isChineseLocale } from "../runtime/locale.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayChannel } from "./channel.js";
import { GatewayReceipts } from "./receipts.js";

/** Task controls bypass the foreground queue without obtaining its permissions
 * or cancelling its controller. A task handle never creates/resumes a session. */
export function gatewayEngineTasks(bridge: CoreBridgeLike, channel: GatewayChannel, stateDir: string) {
  const receipts = new GatewayReceipts(stateDir);
  return async (method: string, raw: unknown) => {
    if (method === "tasks.list") {
      const { conversationId } = z.object({ conversationId: idSchema }).strict().parse(raw);
      if (!bridge.listTasks) return { supported: false, tasks: [] };
      if (!await channel.canSteerConversation?.(conversationId)) return { supported: true, tasks: [] };
      const conversationKey = buildCoreConversationKey(conversationId);
      const snapshot = engineTaskSnapshotSchema.parse(await bridge.listTasks({ chatId: stableCoreNumericId(conversationKey), conversationKey }));
      if (!await channel.canSteerConversation?.(conversationId)) return { supported: true, tasks: [] };
      const hubCapabilities = channel.transport?.capabilities;
      return hubCapabilities && !hubCapabilities.includes(SWARM_TASKS_CAPABILITY) ? stripSwarmTaskFields(snapshot) : snapshot;
    }
    if (method === "tasks.recover") {
      const p = engineSessionRecoverySchema.omit({ botId: true }).extend({ conversationId: idSchema, userId: idSchema }).strict().parse(raw);
      const receipt = await receipts.run(`tasks.recover:${p.userId}:${p.requestId}`, async () => {
        const wrap = (result: unknown) => ({ conversationId: p.conversationId, token: p.token, result: engineTaskControlResultSchema.parse(result) });
        if (!bridge.recoverSession) return wrap({ outcome: "rejected", reason: "unsupported" });
        const isCurrentSession = async () => await channel.canSteerConversation?.(p.conversationId) === true;
        if (!await isCurrentSession()) return wrap({ outcome: "rejected", reason: "stale" });
        const conversationKey = buildCoreConversationKey(p.conversationId);
        return wrap(await bridge.recoverSession({ chatId: stableCoreNumericId(conversationKey), conversationKey, token: p.token, isCurrentSession }));
      });
      if (!receipt.ok) return { outcome: "unknown", reason: "uncertain" };
      const stored = z.object({ conversationId: idSchema, token: idSchema, result: engineTaskControlResultSchema }).strict().parse(receipt.result);
      return stored.conversationId === p.conversationId && stored.token === p.token ? stored.result : { outcome: "rejected", reason: "stale" };
    }
    if (method !== "tasks.stop") throw new Error("unsupported_task_operation");
    const p = engineTaskStopSchema.omit({ botId: true }).extend({ conversationId: idSchema, userId: idSchema }).strict().parse(raw);
    const receipt = await receipts.run(`tasks.stop:${p.userId}:${p.requestId}`, async () => {
      const wrap = (result: unknown) => ({ conversationId: p.conversationId, taskId: p.taskId, result: engineTaskControlResultSchema.parse(result) });
      const isCurrentSession = async () => await channel.canSteerConversation?.(p.conversationId) === true;
      const conversationKey = buildCoreConversationKey(p.conversationId);
      if (p.taskId === "swarm") {
        if (!bridge.stopBackgroundWork) return wrap({ outcome: "rejected", reason: "unsupported" });
        if (!await isCurrentSession()) return wrap({ outcome: "rejected", reason: "stale" });
        const locale = await resolveCoreLocale(stateDir);
        const bg = await bridge.stopBackgroundWork({
          chatId: stableCoreNumericId(conversationKey),
          conversationKey,
          locale: isChineseLocale(locale) ? "zh" : "en",
          scope: "swarm",
        });
        if (bg.stopped && bg.summary) {
          await channel.inConversation(p.conversationId, () => channel.send(p.conversationId, { text: bg.summary! })).catch(() => undefined);
        }
        return wrap(bg.stopped ? { outcome: "accepted" } : { outcome: "rejected", reason: "stale" });
      }
      if (!bridge.stopTask) return wrap({ outcome: "rejected", reason: "unsupported" });
      if (!await isCurrentSession()) return wrap({ outcome: "rejected", reason: "stale" });
      return wrap(await bridge.stopTask({ chatId: stableCoreNumericId(conversationKey), conversationKey, taskId: p.taskId, isCurrentSession }));
    });
    if (!receipt.ok) return { outcome: "unknown", reason: "uncertain" };
    const stored = z.object({ conversationId: idSchema, taskId: idSchema, result: engineTaskControlResultSchema }).strict().parse(receipt.result);
    // A changed request ID payload must neither return a misleading success
    // from another task nor initiate a second side effect.
    return stored.conversationId === p.conversationId && stored.taskId === p.taskId ? stored.result : { outcome: "rejected", reason: "stale" };
  };
}
