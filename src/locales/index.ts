import { normalizeLocale, translateFromCatalogs, type Locale } from "../runtime/locale.js";
import { HOST_EN } from "./host-en.js";
import { HOST_JA } from "./host-ja.js";

/** Chinese display overrides for disambiguated catalog keys. */
const HOST_ZH: Readonly<Record<string, string>> = {
  "语言区块": "语言",
};

export const HOST_MESSAGE_CATALOGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  zh: HOST_ZH,
  en: HOST_EN,
  ja: HOST_JA,
};

/**
 * Resolve a Host/Gateway/Core user-facing message from typed catalogs.
 * Empty/undefined locale defaults to "zh" for backward compatibility with Host config defaults;
 * unknown non-Chinese locales fall back to English ("en").
 */
export function hostT(
  locale: Locale | undefined,
  key: string,
  ...values: (string | number | undefined)[]
): string {
  const resolved = typeof locale === "string" && locale.trim()
    ? normalizeLocale(locale, "en")
    : "zh";
  return translateFromCatalogs(resolved, HOST_MESSAGE_CATALOGS, key, values);
}

export function createHostTranslator(locale: Locale | undefined) {
  return (key: string, ...values: (string | number | undefined)[]): string =>
    hostT(locale, key, ...values);
}
