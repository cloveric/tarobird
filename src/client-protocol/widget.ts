import { z } from "zod";
import { reportSchema, reportFallback, type ReportData } from "./report.js";
import type { Block } from "./index.js";

export const MAX_WIDGET_BYTES = 128 * 1024;
const htmlWidgetSchema = z.object({
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(4000),
  html: z.string().trim().min(1).refine(value => new TextEncoder().encode(value).length <= MAX_WIDGET_BYTES, "Widget HTML exceeds 128 KiB"),
}).strict();
export const widgetInputSchema = z.union([htmlWidgetSchema, htmlWidgetSchema.omit({ html: true }).extend({ report: reportSchema }).strict()]);
export const widgetSchema = htmlWidgetSchema.extend({ version: z.literal(1) });
export type WidgetInput = z.infer<typeof widgetInputSchema>;
export type Widget = z.infer<typeof widgetSchema>;

/** A v1 card envelope keeps old Apps, search, quotes and CLI history readable.
 * HTML is data, never part of the Markdown renderer or a model's quoted text. */
export function widgetBlock(input: WidgetInput): Extract<Block, { type: "card" }> {
  const parsed = widgetInputSchema.parse(input);
  const report = "report" in parsed ? parsed.report : undefined;
  const widget = widgetSchema.parse({ title: parsed.title, summary: parsed.summary, html: "html" in parsed ? parsed.html : reportFallback(parsed.report), version: 1 });
  return { type: "card", title: widget.title, summary: widget.summary,
    elements: [{ type: "markdown", text: widget.summary }], extra: { widget, ...(report ? { report } : {}) } };
}
export function readWidget(block: Block): Widget | undefined {
  if (block.type !== "card") return;
  const parsed = widgetSchema.safeParse(block.extra?.widget);
  return parsed.success ? parsed.data : undefined;
}

/** Report data is independent of the v1 HTML fallback for older readers. */
export function readReport(block: Block): ReportData | undefined {
  if (block.type !== "card") return;
  const parsed = reportSchema.safeParse(block.extra?.report);
  return parsed.success ? parsed.data : undefined;
}
