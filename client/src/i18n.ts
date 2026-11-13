import { useSyncExternalStore } from "react";
import english from "./locales/en.json" with { type: "json" };
import type { Locale } from "./system-locale.js";
export type { Locale };
let locale: Locale = "zh";
const listeners = new Set<() => void>();
export function setLocale(next: Locale): void { if (next === locale) return; locale = next; document.documentElement.lang = next === "zh" ? "zh-CN" : "en"; listeners.forEach((listener) => listener()); }
export function useLocale(): Locale { return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => locale); }
/** Only application-owned strings are translated. Bot output stays verbatim. */
export function t(key: string, ...values: (string | number | undefined)[]): string {
  const text = locale === "en" ? (english as Record<string, string>)[key] ?? key : key;
  return text.replace(/\{(\d+)\}/g, (match, index: string) => values[Number(index)] === undefined ? match : String(values[Number(index)]));
}

/** App-owned lists use the selected UI locale, leaving each name unchanged. */
export function formatList(items: Iterable<string>): string {
  return new Intl.ListFormat(locale === "zh" ? "zh-CN" : "en", { style: "narrow", type: "conjunction" }).format(items);
}
