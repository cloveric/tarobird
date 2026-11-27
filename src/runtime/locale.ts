import { z } from "zod";

export const SUPPORTED_LANGUAGES = [
  { code: "zh", bcp47: "zh-CN", intl: "zh-CN", nativeName: "中文" },
  { code: "en", bcp47: "en", intl: "en-US", nativeName: "English" },
  { code: "ja", bcp47: "ja", intl: "ja-JP", nativeName: "日本語" },
] as const;

export const SUPPORTED_LOCALES = ["zh", "en", "ja"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export type Locale = SupportedLocale | (string & {});

const SUPPORTED_SET = new Set<string>(SUPPORTED_LOCALES);
const LANGUAGE_BY_CODE = new Map<string, (typeof SUPPORTED_LANGUAGES)[number]>(
  SUPPORTED_LANGUAGES.map((entry) => [entry.code, entry]),
);

/** Schema for persisted/wire locale tags; accepts any valid BCP-47-like code. */
export const LocaleSchema = z.string().trim().min(1).max(35);

/**
 * Normalize a raw locale or BCP-47 tag (e.g. "zh-CN", "ja-JP", "en-US") to a
 * supported language code, falling back to `fallback` (default "en") when
 * unrecognized.
 */
export function normalizeLocale(
  raw: unknown,
  fallback: SupportedLocale = "en",
): SupportedLocale {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const base = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? "";
  if (SUPPORTED_SET.has(base)) return base as SupportedLocale;
  return fallback;
}

/**
 * True when two-language (Chinese/English) Host copy should use its Chinese text.
 * Mirrors `hostT`: a missing or empty locale stays Chinese, every other non-Chinese
 * locale (including "ja") gets the English text instead of the Chinese one.
 */
export function isChineseLocale(locale: unknown): boolean {
  if (typeof locale !== "string" || !locale.trim()) return true;
  return normalizeLocale(locale, "en") === "zh";
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && SUPPORTED_SET.has(value);
}

export function localeBcp47(locale: Locale): string {
  const base = locale.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_BY_CODE.get(base)?.bcp47 ?? locale;
}

export function localeIntlTag(locale: Locale): string {
  const base = locale.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
  return LANGUAGE_BY_CODE.get(base)?.intl ?? locale;
}

export function formatPlaceholders(
  template: string,
  values: readonly (string | number | undefined)[],
): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve a translation key from language catalogs.
 * Chinese ("zh") returns the source key (unless overridden in `catalogs.zh`);
 * any other language resolves its own catalog and falls back to English ("en"),
 * never returning raw Chinese or blank text.
 */
export function translateFromCatalogs(
  locale: Locale,
  catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>,
  key: string,
  values: readonly (string | number | undefined)[] = [],
): string {
  const base = locale.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
  let text = key;
  if (base === "zh") {
    const override = catalogs.zh?.[key];
    if (typeof override === "string" && override.trim() !== "") {
      text = override;
    }
  } else {
    const localized = catalogs[base]?.[key] ?? catalogs[locale]?.[key];
    if (typeof localized === "string" && localized.trim() !== "") {
      text = localized;
    } else {
      const english = catalogs.en?.[key];
      if (typeof english === "string" && english.trim() !== "") {
        text = english;
      }
    }
  }
  return values.length > 0 ? formatPlaceholders(text, values) : text;
}
