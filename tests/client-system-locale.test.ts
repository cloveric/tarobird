import { expect, it } from "vitest";
import { resolveLocalePreference, storedLocale, systemLocale } from "../client/src/system-locale.js";

it.each([
  [{ languages: ["zh-CN", "en-US"], language: "zh-CN" }, "zh"],
  [{ languages: ["zh-Hant-TW"] }, "zh"],
  [{ languages: ["zh"] }, "zh"],
  [{ languages: ["en-US", "zh-CN"], language: "en-US" }, "en"],
  [{ languages: ["ja-JP", "zh-CN"] }, "ja"],
  [{ languages: ["ja"] }, "ja"],
  [{ languages: ["fr-FR"] }, "en"],
  [{ languages: ["zha"] }, "en"],
  [{ languages: [], language: "zh-Hans-CN" }, "zh"],
  [{ languages: [], language: "ja" }, "ja"],
  [{ language: "en-GB" }, "en"],
  [{}, "en"],
  [undefined, "en"],
] as const)("maps the first preferred system language %j to %s", (source, expected) => {
  expect(systemLocale(source)).toBe(expected);
});

it("follows the system language by default when no preferences were saved", () => {
  expect(storedLocale(undefined)).toBe("system");
  expect(storedLocale(null)).toBe("system");
  expect(storedLocale({ locale: "system" })).toBe("system");
  expect(resolveLocalePreference("system", { language: "ja-JP" })).toBe("ja");
  expect(resolveLocalePreference("system", { language: "zh-CN" })).toBe("zh");
  expect(resolveLocalePreference("system", { language: "fr-FR" })).toBe("en");
});

it("keeps a saved language on any system", () => {
  expect(storedLocale({ locale: "en" })).toBe("en");
  expect(storedLocale({ locale: "zh" })).toBe("zh");
  expect(storedLocale({ locale: "ja" })).toBe("ja");
  expect(storedLocale({ locale: "ja-JP" })).toBe("ja");
  expect(resolveLocalePreference("ja", { language: "en-US" })).toBe("ja");
});

it("keeps Chinese for records saved before the language setting existed", () => {
  expect(storedLocale({})).toBe("zh");
  expect(storedLocale({ locale: "fr" })).toBe("zh");
});
