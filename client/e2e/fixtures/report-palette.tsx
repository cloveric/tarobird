import { createRoot } from "react-dom/client";
import { Report } from "../../src/Report.js";
import type { ReportData } from "../../../src/client-protocol/report.js";
import { widgetTheme } from "../../src/widget-document.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
const report: ReportData = { version: 1,
  columns: ["日期", "计划进度", "实际进度", "上轮预测", "参考方案"],
  rows: Array.from({ length: 53 }, (_, i) => [`2026-${String(1 + Math.floor(i / 5)).padStart(2, "0")}-${String(1 + i % 5 * 5).padStart(2, "0")}`, 22 + i * 1.3, 21 + i * 1.3 + Math.sin(i * .65) * 7, i === 27 ? null : 28 + i * 1.05, 17 + i * 1.15]),
  chart: { kind: "line", category: 0, values: [1, 2, 3, 4], unit: "%" },
  metrics: [{ label: "计划平均进度", column: 1, operation: "average", unit: "%" }, { label: "实际平均进度", column: 2, operation: "average", unit: "%" }],
  source: "配色与交互验收示例 · 合成数据，非真实业务统计。",
};
const container = document.createElement("main");
container.style.cssText = "width:calc(100% - 32px);max-width:900px;margin:16px auto";
document.body.append(container);
const root = createRoot(container);
function render(kind: "line" | "bar" | "timeline", longLabels = false, sampleRows = report.rows.length) { root.render(<Report title="项目进度对比" summary="同一主题下，以颜色和线型区分四个系列；点击图例可分别显示或隐藏。" report={{ ...report, rows: report.rows.slice(0, sampleRows).map(row => sampleRows < report.rows.length ? [String(row[0]).slice(5), ...row.slice(1)] : row), columns: longLabels ? ["日期", "本季度项目计划完成进度", "当前团队实际完成进度", "根据上轮数据预测的进度", "作为比较参考的实施方案"] : report.columns, chart: kind === "timeline" ? undefined : { ...report.chart!, kind }, timeline: kind === "timeline" ? { date: 0, title: 1 } : undefined }}/>); }
Object.assign(window, { reportPalette: { render, theme: () => widgetTheme(container) } });
render("line");
