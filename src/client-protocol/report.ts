import { z } from "zod";

const label = z.string().trim().min(1).max(160);
const cell = z.union([z.string().max(500), z.number().finite().min(-1e12).max(1e12), z.null()]);
const columnIndex = z.number().int().min(0).max(11);
export const reportSchema = z.object({
  version: z.literal(1),
  columns: z.array(label).min(1).max(12),
  rows: z.array(z.array(cell).min(1).max(12)).max(200),
  chart: z.object({ kind: z.enum(["bar", "line"]), category: columnIndex, values: z.array(columnIndex).min(1).max(4), unit: z.string().max(30).optional() }).strict().optional(),
  timeline: z.object({ date: columnIndex, title: columnIndex, detail: columnIndex.optional() }).strict().optional(),
  metrics: z.array(z.object({ label, column: columnIndex, operation: z.enum(["sum", "average", "min", "max", "count"]), unit: z.string().max(30).optional() }).strict()).max(4).optional(),
  source: z.string().max(1000).optional(),
  note: z.string().max(2000).optional(),
}).strict().superRefine((report, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (new TextEncoder().encode(JSON.stringify(report)).length > 64 * 1024) issue("Report exceeds 64 KiB");
  if (report.rows.some(row => row.length !== report.columns.length)) issue("Each row must match the columns");
  if (report.chart && report.timeline) issue("Choose one chart or timeline");
  const indexes = [...(report.chart ? [report.chart.category, ...report.chart.values] : []), ...(report.timeline ? [report.timeline.date, report.timeline.title, ...(report.timeline.detail === undefined ? [] : [report.timeline.detail])] : []), ...(report.metrics ?? []).map(metric => metric.column)];
  if (indexes.some(index => index >= report.columns.length)) issue("Unknown column index");
  if (report.chart && (new Set(report.chart.values).size !== report.chart.values.length || report.chart.values.includes(report.chart.category))) issue("Chart columns must be distinct");
  const numeric = [...(report.chart?.values ?? []), ...(report.metrics ?? []).filter(metric => metric.operation !== "count").map(metric => metric.column)];
  if (numeric.some(index => report.rows.some(row => row[index] !== null && typeof row[index] !== "number"))) issue("Chart and aggregate columns require numbers or null");
  if (report.chart && report.rows.length > 60) issue("Charts accept at most 60 rows; aggregate first or use a table");
});
export type ReportData = z.infer<typeof reportSchema>;
export type ReportRow = ReportData["rows"][number];

export function reportMetric(rows: ReportRow[], metric: NonNullable<ReportData["metrics"]>[number]): number | null {
  if (metric.operation === "count") return rows.length;
  const values = rows.map(row => row[metric.column]).filter((value): value is number => typeof value === "number");
  if (!values.length) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return metric.operation === "sum" ? sum : metric.operation === "average" ? sum / values.length : metric.operation === "min" ? Math.min(...values) : Math.max(...values);
}

const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** Old clients receive a useful script-free table, while current Apps render
 * the typed report directly. No generated JavaScript is needed on either path. */
export function reportFallback(report: ReportData): string {
  return `<table><thead><tr>${report.columns.map(column => `<th>${escape(column)}</th>`).join("")}</tr></thead><tbody>${report.rows.slice(0, 12).map(row => `<tr>${row.map(value => `<td>${escape(typeof value === "string" && value.length > 80 ? value.slice(0, 80) + "…" : value)}</td>`).join("")}</tr>`).join("")}</tbody></table><p>Preview: ${Math.min(12, report.rows.length)} / ${report.rows.length}</p>${report.source ? `<p>${escape(report.source)}</p>` : ""}${report.note ? `<details><summary>Notes</summary><p>${escape(report.note)}</p></details>` : ""}`;
}
