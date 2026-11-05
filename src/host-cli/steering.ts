import { nativeInputControlResultSchema } from "../client-protocol/native-input.js";
import { randomUUID } from "node:crypto";
import { idSchema, messageSchema } from "../client-protocol/index.js";
import { nativeInputControlRequestSchema, steerRequestSchema, steerStatusSchema } from "../client-protocol/steering.js";
import type { LocalHostClient } from "./client.js";

/** Native message controls are re-checked by message ID; steering by its original target and text. */
export function steeringReceiptHint(command: string | undefined, id: string) {
  return command === "send-now" || command === "cancel"
    ? `原生消息操作编号：${id}。结果未确认时用原编号和同一 --message 核对，不会重复执行。`
    : `补充操作编号：${id}。结果未确认时用原编号、原目标和原内容核对，不会自动重发。`;
}

/** Exact-target input uses the same receipt as the App; never falls back to queue. */
export async function runSteeringCommand(client: Pick<LocalHostClient, "request">, command: string | undefined, conversation: string | undefined,
  options: { mode?: string; message?: string; bot?: string; target?: string; text?: string; "request-id"?: string }, receipt?: (id: string) => void) {
  const conversationId = idSchema.parse(conversation);
  if (command === "send-now" || command === "cancel") {
    if (options.bot || options.target || options.text || options.mode) throw new Error("原生消息操作只接受 --message 和 --request-id。");
    const messageId = idSchema.parse(options.message), input = nativeInputControlRequestSchema.parse({ requestId: options["request-id"] ?? randomUUID(), action: command });
    receipt?.(input.requestId);
    return nativeInputControlResultSchema.parse(await client.request(`/api/conversations/${conversationId}/inputs/${messageId}`, "POST", input));
  }
  if (options.message) throw new Error("--message 仅用于 steer send-now|cancel。");
  const botId = idSchema.parse(options.bot), route = `/api/conversations/${conversationId}/steer`;
  if (command === "status") {
    if (Object.entries(options).some(([key, value]) => key !== "bot" && value !== undefined)) throw new Error("steer status 只接受 --bot。");
    // Same opt-in as the App: a background-review target accepts ordinary
    // input as a new turn; it is never a Stop or send-now target.
    return steerStatusSchema.parse(await client.request(`${route}?botId=${botId}&review=1`));
  }
  if (command !== "send") throw new Error("请使用 steer status|send CONVERSATION --bot BOT，或 steer send-now|cancel CONVERSATION --message ID。");
  const input = steerRequestSchema.parse({ botId, targetId: options.target, text: options.text, ...(options.mode ? { mode: options.mode } : {}), requestId: options["request-id"] ?? randomUUID() });
  receipt?.(input.requestId);
  return messageSchema.parse(await client.request(route, "POST", input));
}

/** HTTP 200 means a receipt was persisted, not that the input was delivered.
 * Keep stdout's wire shape intact; the CLI reports failure separately. This
 * inspects the latest stored adoption evidence without polling or resending. */
export function steeringCommandFailure(command: string | undefined, result: Awaited<ReturnType<typeof runSteeringCommand>>): string | undefined {
  if (command === "status") return;
  if (command === "send-now" || command === "cancel") {
    if ("outcome" in result && result.outcome === "accepted") return;
    return "outcome" in result && result.outcome === "rejected"
      ? "原生消息操作未执行。请核对当前消息状态；没有自动重试。"
      : "原生消息操作结果待确认。请用原编号和同一 --message 核对，不要换新编号重试。";
  }
  const block = "blocks" in result ? result.blocks.find(item => item.type === "steering") : undefined;
  if (block?.application?.status === "applied" || block?.application?.status === "absorbed" || block?.nativeInput?.state === "received") return;
  if (block?.application?.status === "dropped" || block?.nativeInput?.state === "dropped") return "补充未进入模型，没有自动重发。请先核对原回执和任务状态，再决定是否重新发送。";
  if (block?.nativeInput?.state === "cancelled") return "消息已撤回，未作为新任务发送。";
  const uncertain = "补充结果待确认。请用原编号、原目标和原内容核对回执；不要换新编号或转普通消息重发。";
  if (block?.nativeInput?.state === "unknown") return uncertain;
  if (block?.outcome === "accepted") return;
  if (block?.outcome !== "rejected") return uncertain;
  if (block.reason === "binding_changed") return "补充未投递：对话的会话绑定已改变。请核对目标会话，不要自动重发。";
  if (block.reason === "stale" || block.reason === "idle") return "补充未投递：目标任务已结束或切换，也没有排队。确认内容仍有效后，可作为新消息发送（Bot 间协作用 messages send）。";
  return "补充未投递：当前任务不支持或暂不能接收，也没有排队。Bot 常规协作及跨轮补充请使用 messages send。";
}

/** A successful idempotent control can be a no-op, not new delivery evidence. */
export function steeringCommandNotice(command: string | undefined, result: Awaited<ReturnType<typeof runSteeringCommand>>): string | undefined {
  if ((command === "send-now" || command === "cancel") && "outcome" in result && result.outcome === "accepted"
    && "result" in result && result.result === "nothing_waiting") {
    return "当前没有等待处理的消息，本次未改变任务。这不代表模型已收到消息；没有重发或重试。";
  }
}
