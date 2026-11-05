import type { Json } from "../client-protocol/index.js";
import { widgetsEnabled } from "../runtime/widget-policy.js";
import { createHash } from "node:crypto";
import type { AppPlatformTools } from "../codex/adapter.js";
import type { GatewayChannel } from "./channel.js";
import type { GatewayReceipts } from "./receipts.js";
import { validateWidget } from "../runtime/widget.js";

export const widgetDefinition: AppPlatformTools["definitions"][number] = {
  name: "app_show_widget",
  description: "Publish an interactive visual inline in the current chat. Use proactively when a chart, timeline, comparison or local controls help understanding; use text when clearer. Read app_capability topic=widgets for design and authoring guidance. Self-contained HTML/CSS/JavaScript only, no network or host APIs. Returns a durable messageId; do not also send an attachment or delivery directive.",
  inputSchema: { type: "object", properties: {
    title: { type: "string", description: "Short title, up to 160 characters." },
    summary: { type: "string", description: "Readable conclusion, key values and sources for fallback/search/quotes, up to 4000 characters." },
    html: { type: "string", description: "HTML fragment with optional inline style and classic script, max 128 KiB UTF-8. Responsive from 280px. Use host theme variables, native SVG/CSS and local interactions." },
  }, required: ["title", "summary", "html"], additionalProperties: false },
};

// widgetDefinition is frozen for persisted v4 contracts. This report description
// is frozen for v5-v7 hashes only; new threads use htmlWidgetDefinition below.
export const reportWidgetDefinition: AppPlatformTools["definitions"][number] = {
  ...widgetDefinition,
  description: "Publish an inline visual report or interactive widget in this chat. Prefer bounded report data for charts, tables and timelines: the App renders it without generated scripts. Read app_capability topic=widgets for the schema and guidance. Returns a durable messageId; do not duplicate delivery.",
  inputSchema: { ...widgetDefinition.inputSchema,
    properties: { ...widgetDefinition.inputSchema.properties as object,
      report: { type: "object", description: "Version 1 report data: columns, rows, optional chart/timeline, metrics, source and note. Read app_capability topic=widgets. Use either report or html." },
    }, required: ["title", "summary"], oneOf: [{required:["html"]}, {required:["report"]}],
  },
};

// Keep the report input for explicit requests and old-message interoperability.
export const htmlWidgetDefinition: AppPlatformTools["definitions"][number] = {
  ...reportWidgetDefinition,
  description: "Publish an interactive visual inline in this chat. Use HTML by default for charts, tables, timelines and custom controls; use report only when the user explicitly requests that format. Use proactively when helpful; text when clearer. No network or host APIs. Read app_capability topic=widgets for design and authoring guidance. Returns a durable messageId; do not duplicate delivery.",
  inputSchema: { ...reportWidgetDefinition.inputSchema,
    properties: { ...reportWidgetDefinition.inputSchema.properties as object,
      report: { type: "object", description: "Only on explicit user request: version 1 structured report data. Read app_capability topic=widgets for its schema. Otherwise use html. Never supply both." },
    },
  },
};

export async function deliverAppWidget(input: {
  channel: Pick<GatewayChannel, "sendWidget">; conversationId: string; replyTo?: string;
  receipts: Pick<GatewayReceipts, "run">; signal: AbortSignal; widgetsAllowed?: boolean;
}, call: Parameters<AppPlatformTools["call"]>[0]) {
  const result = (value: unknown, isError = false) => ({ text: JSON.stringify(value), ...(isError ? { isError: true } : {}) });
  let widget;
  try { widget = validateWidget(call.arguments); }
  catch (error) { return result({ error: "invalid_widget", detail: error instanceof Error ? error.message : String(error), published: false }, true); }
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const fingerprint = hash(JSON.stringify(widget));
  const key = `app-widget:${input.conversationId}:${call.sessionId}:${call.callId}`;
  const receipt = await input.receipts.run(key, async (): Promise<Json> => {
    input.signal.throwIfAborted();
    // Check only inside the operation: a durable successful replay must retain
    // its receipt even if the user subsequently disabled new publications.
    if (input.widgetsAllowed === false || !widgetsEnabled()) return { fingerprint, error: "widgets_disabled", published: false };
    try {
      const sent = await input.channel.sendWidget({ ...input, widget, messageId: `msg_${hash(key).slice(0, 32)}` });
      call.onActivity?.();
      return { fingerprint, delivered: true, messageId: sent.messageId, title: widget.title, ...(sent.source ? {source:sent.source} : {}) };
    } catch (error) {
      // The authoritative Hub may disable publication after our local check.
      // Its explicit denial is definite; network failures remain uncertain.
      if (error instanceof Error && ["widgets_disabled", "widget_settings_unavailable"].includes(error.message)) return { fingerprint, error: error.message, published: false };
      throw error;
    }
  });
  if (!receipt.ok) return result({ error: input.signal.aborted ? "turn_ended" : "delivery_uncertain", hint: "Check history before retrying; this call will not publish twice." }, true);
  const saved = receipt.result as { fingerprint: string; delivered: boolean; messageId: string; title: string; error?: string; published?: boolean };
  if (saved.fingerprint !== fingerprint) return result({ error: "tool_call_id_reused_with_different_arguments" }, true);
  const { fingerprint: _private, ...visible } = saved;
  return result(visible, !!saved.error);
}
