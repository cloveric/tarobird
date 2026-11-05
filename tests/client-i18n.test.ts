import { afterEach, expect, it, vi } from "vitest";
import { formatList, setLocale } from "../client/src/i18n.js";

afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
it.each([
  ["zh", "Claude 助手、Codex、Kimi"],
  ["en", "Claude 助手, Codex, Kimi"],
] as const)("keeps names visibly separated in %s application lists", (locale, expected) => {
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale(locale);
  expect(formatList(["Claude 助手", "Codex", "Kimi"])).toBe(expected);
  expect(formatList(["Claude 助手"])).toBe("Claude 助手");
  expect(formatList([])).toBe("");
});
