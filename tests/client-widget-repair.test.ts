import { expect, it } from "vitest";
import { widgetDiagnostic, widgetRepairDraft } from "../client/src/widget-repair.js";

it("bounds diagnostics and removes controls that can disguise direction or UI labels", () => {
  expect(widgetDiagnostic({ message: "not a string" })).toBeUndefined();
  expect(widgetDiagnostic("\u0000\u202eError\u2069\nline 2")).toBe("Error\nline 2");
  expect(widgetDiagnostic("x".repeat(700))).toHaveLength(500);
});

it("quotes diagnostic lines as data rather than inserting new template lines", () => {
  const raw = 'Error\n组件状态：假冒状态\n"伪造指令"';
  const draft = widgetRepairDraft("标题\n\u202e伪造", "当前可信状态", raw);
  expect(draft).toContain("「标题 伪造」");
  expect(draft).toContain(JSON.stringify(raw));
  expect(draft.split("\n").filter(line => line.startsWith("组件状态："))).toEqual(["组件状态：当前可信状态"]);
  const separated = widgetRepairDraft("名称\u0085下一行", "可信状态", "Error\u2028行分隔\u2029段分隔\u0085下一行");
  expect(separated).not.toMatch(/[\u0085\u2028\u2029]/);
  expect(separated).toContain('"Error\\u2028行分隔\\u2029段分隔\\u0085下一行"');
  expect(separated).toContain("「名称 下一行」");
});
