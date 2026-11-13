import { expect, it } from "vitest";
import { storedLocale, systemLocale } from "../client/src/system-locale.js";

it.each([
  [{ languages: ["zh-CN", "en-US"], language: "zh-CN" }, "zh"],
  [{ languages: ["zh-Hant-TW"] }, "zh"],
  [{ languages: ["zh"] }, "zh"],
  [{ languages: ["en-US", "zh-CN"], language: "en-US" }, "en"],
  [{ languages: ["ja-JP", "zh-CN"] }, "en"],
  [{ languages: ["zha"] }, "en"],
  [{ languages: [], language: "zh-Hans-CN" }, "zh"],
  [{ language: "en-GB" }, "en"],
  [{}, "en"],
  [undefined, "en"],
] as const)("maps the first preferred system language %j to %s", (source, expected) => {
  expect(systemLocale(source)).toBe(expected);
});

it("follows the system language only when no preferences were saved", () => {
  expect(storedLocale(undefined, "en")).toBe("en");
  expect(storedLocale(null, "zh")).toBe("zh");
});

it("keeps a saved language on any system", () => {
  expect(storedLocale({ locale: "en" }, "zh")).toBe("en");
  expect(storedLocale({ locale: "zh" }, "en")).toBe("zh");
});

it("keeps Chinese for records saved before the language setting existed", () => {
  expect(storedLocale({}, "en")).toBe("zh");
  expect(storedLocale({ locale: "fr" }, "en")).toBe("zh");
});
