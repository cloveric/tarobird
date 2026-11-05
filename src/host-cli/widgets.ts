import { workbenchPublishedSource } from "../client-protocol/workbench.js";
import { readFile, stat } from "node:fs/promises";
import { idSchema, messageSchema } from "../client-protocol/index.js";
import { MAX_WIDGET_BYTES } from "../client-protocol/widget.js";
import { validateWidget } from "../runtime/widget.js";
import type { LocalHostClient } from "./client.js";

export const WIDGET_PUBLISH_USAGE = "widgets publish CONVERSATION --html-file FILE --title TITLE --summary TEXT --request-id ID\n    Default: HTML. Only for an explicit structured-report request, replace --html-file with --report-file JSON.";

export async function runWidgetsCommand(client: Pick<LocalHostClient, "request">, command: string | undefined, conversationId: string | undefined,
  options: { htmlFile?: string; reportFile?: string; title?: string; summary?: string; requestId?: string }) {
  if (command !== "publish") throw new Error(`用法：tarobot ${WIDGET_PUBLISH_USAGE}`);
  const conversation = idSchema.parse(conversationId), requestId = idSchema.parse(options.requestId);
  if (!!options.htmlFile === !!options.reportFile) throw new Error("widget_choose_html_or_report_file");
  const file = options.reportFile ?? options.htmlFile!;
  if ((await stat(file)).size > MAX_WIDGET_BYTES) throw new Error("widget_file_too_large");
  const text = await readFile(file, "utf8");
  const widget = validateWidget({ title: options.title, summary: options.summary, ...(options.reportFile ? { report: JSON.parse(text) } : { html: text }) });
  const message = messageSchema.parse(await client.request(`/api/conversations/${conversation}/widgets`, "POST", { ...widget, requestId }));
  return { delivered: true, messageId: message.id, conversationId: message.conversationId, authorType: message.authorType, source: workbenchPublishedSource(message) };
}
