import { idSchema } from "../client-protocol/index.js";
import { CONVERSATION_HISTORY_CAPABILITY, HISTORY_SIDE_REASON_QUERY, historyAnchorPageSchema, historyChangeSchema, historyClientOperationSchema, historyClientSnapshotSchema, type HistoryClientOperation } from "../client-protocol/conversation-history.js";
import type { LocalHostClient } from "./client.js";

export async function runHistoryCommand(client: Pick<LocalHostClient, "request" | "supports">, command: string | undefined, conversationId: string | undefined,
  options: { bot?: string; anchor?: string; message?: string; cursor?: string; revision?: string; requestId?: string; title?: string; action?: string }) {
  if (!client.supports(CONVERSATION_HISTORY_CAPABILITY)) throw new Error("此主机尚不支持原生会话历史操作，请先更新主机。");
  const conversation = idSchema.parse(conversationId), botId = idSchema.parse(options.bot);
  const base = `/api/conversations/${conversation}/history`, botQuery = `botId=${botId}`, reasonQuery = `${HISTORY_SIDE_REASON_QUERY}=1`;
  if (command === "snapshot") return historyClientSnapshotSchema.parse(await client.request(`${base}?${botQuery}&${reasonQuery}`));
  if (command === "anchors") return historyAnchorPageSchema.parse(await client.request(`${base}/anchors?${botQuery}${options.message ? `&messageId=${idSchema.parse(options.message)}` : ""}${options.cursor ? `&cursor=${idSchema.parse(options.cursor)}` : ""}`));
  if (command === "status") return historyClientOperationSchema.parse(await client.request(`${base}/operations/${idSchema.parse(options.requestId)}?${botQuery}&${reasonQuery}`));
  const kind = command === "reconcile" ? options.action : command;
  if (kind !== "rewind" && kind !== "fork") throw new Error("history 支持 snapshot、anchors、rewind、fork、status、reconcile；reconcile 需要原 --action rewind|fork。");
  if (!options.revision || !options.requestId) throw new Error("历史操作需要 --revision 和 --request-id；结果未知时保留原参数，用 history status 查询或 history reconcile 核对，不要换编号重试。");
  const action = kind === "rewind" ? { kind: "rewind", anchorId: idSchema.parse(options.anchor) }
    : options.anchor ? { kind: "fork", scope: "anchor", anchorId: idSchema.parse(options.anchor), title: options.title }
      : { kind: "fork", scope: "whole", title: options.title };
  const input = historyChangeSchema.parse({ botId, requestId: options.requestId, expectedRevision: options.revision, action });
  return historyClientOperationSchema.parse(await client.request(command === "reconcile" ? `${base}/operations/${input.requestId}/reconcile?${reasonQuery}` : `${base}/operations?${reasonQuery}`, "POST", input));
}

/** A change that did not apply exits non-zero, as `steer send` does. The
 * receipt is still printed first; reads (snapshot, anchors, status) report
 * what they found and never fail on its content. */
export function historyCommandFailure(command: string | undefined, result: unknown): string | undefined {
  if (command !== "rewind" && command !== "fork" && command !== "reconcile") return;
  const operation = result as HistoryClientOperation;
  if (operation.state === "applied") return;
  if (operation.state === "rejected") return `历史操作未执行（${operation.reason ?? "rejected"}）。原生会话没有改动，也没有自动重试。`;
  return "历史操作结果待确认。请保留原编号和原参数，用 history status 查询或 history reconcile 核对，不要换编号重试。";
}
