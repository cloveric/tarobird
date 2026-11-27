import { useSyncExternalStore } from "react";
import english from "./locales/en.json" with { type: "json" };
import japanese from "./locales/ja.json" with { type: "json" };
import {
  localeBcp47,
  localeIntlTag,
  normalizeLocale,
  translateFromCatalogs,
} from "../../src/runtime/locale.js";
import {
  resolveLocalePreference,
  SUPPORTED_LANGUAGES,
  type Locale,
  type LocalePreference,
  type SupportedLocale,
} from "./system-locale.js";

export type { Locale, LocalePreference, SupportedLocale };
export { localeBcp47, localeIntlTag, normalizeLocale, SUPPORTED_LANGUAGES };

export const UI_CATALOGS: Record<string, Record<string, string>> = {
  en: english,
  ja: japanese,
};

let preference: LocalePreference = "system";
let locale: SupportedLocale = "zh";
const listeners = new Set<() => void>();

export function getLocale(): SupportedLocale {
  return locale;
}

export function setLocale(next: LocalePreference): void {
  preference = next;
  const resolved = resolveLocalePreference(next);
  const htmlLang = localeBcp47(resolved);
  const changed = resolved !== locale;
  locale = resolved;
  if (typeof document !== "undefined" && document.documentElement && document.documentElement.lang !== htmlLang) {
    document.documentElement.lang = htmlLang;
  }
  if (changed) listeners.forEach((listener) => listener());
}

/** Re-evaluate OS/browser language when "Follow system" is active. */
export function syncSystemLocale(): void {
  if (preference !== "system") return;
  setLocale("system");
}

export function useLocale(): SupportedLocale {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => locale,
  );
}

/**
 * The UI locale to put in a request a Host validates. Hosts up to 1.6.0 accept only
 * "zh" or "en" there and answer 400 otherwise, so any other UI locale (such as "ja")
 * is sent as "en" unless the Host announced REQUEST_LOCALES_CAPABILITY.
 */
export function hostRequestLocale(active: Locale, hostAcceptsLocales: boolean | undefined): Locale {
  const resolved = normalizeLocale(active, "en");
  if (resolved === "zh" || resolved === "en") return resolved;
  return hostAcceptsLocales ? resolved : "en";
}

/** Only application-owned strings are translated. Bot output stays verbatim. */
export function t(key: string, ...values: (string | number | undefined)[]): string {
  return translateFromCatalogs(locale, UI_CATALOGS, key, values);
}

/** App-owned lists use the selected UI locale, leaving each name unchanged. */
export function formatList(items: Iterable<string>): string {
  return new Intl.ListFormat(localeBcp47(locale), { style: "narrow", type: "conjunction" }).format(items);
}

/** Pick the best description for a Hub/engine slash command, falling back to English. */
const COMMAND_I18N_KEYS: Record<string, string> = {
  zh: "zh_cn",
  en: "en_us",
  ja: "ja_jp",
};

export function commandDescription(
  description: { defaultValue?: string; i18n?: Record<string, string | undefined> },
  activeLocale: Locale = locale,
): string {
  const key = COMMAND_I18N_KEYS[normalizeLocale(activeLocale, "en")];
  const i18n = description.i18n;
  if (key && i18n?.[key]) return i18n[key];
  return i18n?.en_us ?? description.defaultValue ?? i18n?.zh_cn ?? "";
}
