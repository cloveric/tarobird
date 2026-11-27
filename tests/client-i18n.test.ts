import { afterEach, expect, it, vi } from "vitest";
import { formatList, hostRequestLocale, setLocale } from "../client/src/i18n.js";
import { CAPABILITIES, REQUEST_LOCALES_CAPABILITY, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";

afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
it.each([
  ["zh", "Claude 助手、Codex、Kimi"],
  ["en", "Claude 助手, Codex, Kimi"],
  ["ja", "Claude 助手、Codex、Kimi"],
] as const)("keeps names visibly separated in %s application lists", (locale, expected) => {
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale(locale);
  expect(formatList(["Claude 助手", "Codex", "Kimi"])).toBe(expected);
  expect(formatList(["Claude 助手"])).toBe("Claude 助手");
  expect(formatList([])).toBe("");
});

// A 1.6.0 Hub parses request locales as z.enum(["zh", "en"]) and answers 400 for "ja".
it("sends only zh or en to a Host that does not announce other request locales", () => {
  expect(hostRequestLocale("zh", false)).toBe("zh");
  expect(hostRequestLocale("en", undefined)).toBe("en");
  expect(hostRequestLocale("ja", false)).toBe("en");
  expect(hostRequestLocale("ja", undefined)).toBe("en");
  expect(hostRequestLocale("ja-JP", false)).toBe("en");
  expect(hostRequestLocale("ja", true)).toBe("ja");
  expect(hostRequestLocale("zh", true)).toBe("zh");
  expect(SERVER_CAPABILITIES).toContain(REQUEST_LOCALES_CAPABILITY);
  expect(CAPABILITIES as readonly string[]).not.toContain(REQUEST_LOCALES_CAPABILITY);
});
