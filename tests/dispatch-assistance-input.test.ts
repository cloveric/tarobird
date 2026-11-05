import { expect, it } from "vitest";
import { continuationInput, type AssistRow } from "../src/hub/dispatch-assistance.js";
const row = { id: "assist_test" } as AssistRow;
it.each([0, 1])("reports actual remaining allowance after a failed helper (%s)", remaining => {
  const text = continuationInput(row, "Claude", { kind: "failed", text: "Partial evidence", truncated: false, incomplete: true }, remaining);
  expect(text).toContain("它可能完成了一部分并产生了副作用");
  expect(text).toContain("Partial evidence");
  expect(text).toContain(remaining ? "还可请求 1 次协助" : "协助次数已用完");
  expect(text.includes("可选择一个可用目标再请求")).toBe(remaining > 0);
});
