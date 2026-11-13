export type Locale = "zh" | "en";
type LanguageSource = { languages?: readonly string[]; language?: string };

/** The platform's first preferred language decides: Chinese tags use Chinese, everything else English. */
export function systemLocale(source: LanguageSource | undefined = globalThis.navigator): Locale {
  const preferred = source?.languages?.length ? source.languages[0] : source?.language;
  return /^zh(?:[-_]|$)/i.test(preferred ?? "") ? "zh" : "en";
}

/**
 * A stored preferences record always carries the language it was saved with,
 * so any record keeps its language (records older than the language setting
 * stay Chinese). Only a device with no record follows the system language.
 */
export function storedLocale(saved: { locale?: unknown } | null | undefined, system: Locale = systemLocale()): Locale {
  if (!saved) return system;
  return saved.locale === "en" ? "en" : "zh";
}
