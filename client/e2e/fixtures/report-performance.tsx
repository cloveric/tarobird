import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Report } from "../../src/Report.js";
import { reportSchema } from "../../../src/client-protocol/report.js";
import "../../src/styles.css";

const report = reportSchema.parse({
  version: 1,
  columns: ["记录", ...Array.from({ length: 11 }, (_, i) => `数值 ${i + 1}`)],
  rows: Array.from({ length: 200 }, (_, row) => [`记录 ${row}`, ...Array.from({ length: 11 }, (_, column) => (row * 11 + column) / 7 - 100)]),
});
const container = document.createElement("main");
container.style.cssText = "max-width:900px;margin:auto";
document.body.append(container);
const root = createRoot(container);
Object.assign(window, { reportPerformance: {
  mount() { flushSync(() => root.render(<Report title="最大容量报告" summary="200 条记录，12 列。" report={report}/>)); },
  unmount() { flushSync(() => root.render(null)); },
} });
