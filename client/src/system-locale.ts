import {
  normalizeLocale,
  SUPPORTED_LANGUAGES,
  type Locale,
  type SupportedLocale,
} from "../../src/runtime/locale.js";

export type { Locale, SupportedLocale };
export { SUPPORTED_LANGUAGES };
export type LocalePreference = "system" | Locale;
type LanguageSource = { languages?: readonly string[]; language?: string };

/** The platform's first preferred language decides: Chinese tags use Chinese, Japanese tags use Japanese, everything else English. */
export function systemLocale(source: LanguageSource | undefined = globalThis.navigator): SupportedLocale {
  const preferred = source?.languages?.length ? source.languages[0] : source?.language;
  return normalizeLocale(preferred, "en");
}

/** Resolve a stored or selected language preference (including "system") to a concrete Locale. */
export function resolveLocalePreference(
  preference: LocalePreference | unknown,
  source?: LanguageSource,
): SupportedLocale {
  if (preference === "system") return systemLocale(source);
  return normalizeLocale(preference, "en");
}

/**
 * A stored preferences record always carries the language it was saved with,
 * so any record keeps its language (records older than the language setting
 * stay Chinese). Only a device with no record follows the system language.
 */
export function storedLocale(saved: { locale?: unknown } | null | undefined): LocalePreference {
  if (!saved) return "system";
  if (saved.locale === "system") return "system";
  if (typeof saved.locale === "string") {
    const base = saved.locale.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
    if (SUPPORTED_LANGUAGES.some((entry) => entry.code === base)) return base as SupportedLocale;
  }
  return "zh";
}
