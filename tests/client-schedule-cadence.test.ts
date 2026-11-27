import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "../client/src/i18n.js";
import { scheduleCadence } from "../client/src/schedule-cadence.js";

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("zh");
});
afterEach(() => {
  setLocale("zh");
  vi.unstubAllGlobals();
});

it("describes saved presets and exact minute intervals", () => {
  const cases = [["30 9 * * 1-5", "工作日 09:30"], ["0 9 * * *", "每天 09:00"], ["5 8 * * 0", "每周日 08:05"], ["* * * * *", "每分钟"], ["*/15 * * * *", "每 15 分钟"], ["0 * * * *", "每小时"]];
  for (const [expression, label] of cases) expect(scheduleCadence({ kind: "cron", expression: expression! })).toBe(label);
  expect(scheduleCadence({ kind: "once", at: "2035-01-02T01:00:00Z" })).toBe("只执行一次");
});

it("does not misrepresent hourly-reset intervals, restricted days or unsupported cron syntax", () => {
  for (const expression of ["*/45 * * * *", "*/7 * * * *", "*/0 * * * *", "0 9 1 * *", "0 9 * * 1,3,5", "0 9 * * MON", "0 25 * * *"]) {
    expect(scheduleCadence({ kind: "cron", expression })).toBe("自定义 Cron");
  }
  expect(scheduleCadence({ kind: "cron", expression: "  30   9 * * 1-5 " })).toBe("工作日 09:30");
});

it("renders cadence labels in Japanese", () => {
  setLocale("ja");
  expect(scheduleCadence({ kind: "cron", expression: "30 9 * * 1-5" })).toBe("平日 09:30");
  expect(scheduleCadence({ kind: "cron", expression: "0 9 * * *" })).toBe("毎日 09:00");
  expect(scheduleCadence({ kind: "once", at: "2035-01-02T01:00:00Z" })).toBe("1 回のみ");
});
