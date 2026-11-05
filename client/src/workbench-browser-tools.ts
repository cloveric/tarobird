export const BROWSER_ZOOM_STEPS = [.25, .33, .5, .67, .75, .8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
export const BROWSER_SEARCH_ENGINES = ["google", "bing", "duckduckgo", "baidu"] as const;
export type BrowserSearchEngine = typeof BROWSER_SEARCH_ENGINES[number];
export type BrowserSettings = { searchEngine: BrowserSearchEngine; defaultZoom: number; recordHistory: boolean };
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { searchEngine: "google", defaultZoom: 1, recordHistory: true };
export type BrowserDevicePreview = { preset: "desktop" | "phone" | "tablet"; landscape: boolean; width: number; height: number; scale: number };
export type BrowserHistoryEntry = { id: string; url: string; title: string; visitedAt: number };
export function browserSearchURL(text: string, engine: BrowserSearchEngine = "google"): string {
  const prefix = { google: "https://www.google.com/search?q=", bing: "https://www.bing.com/search?q=", duckduckgo: "https://duckduckgo.com/?q=", baidu: "https://www.baidu.com/s?wd=" }[engine];
  return `${prefix}${encodeURIComponent(text)}`;
}
export function browserZoomStep(factor: number, direction: -1 | 1): number {
  return direction > 0 ? BROWSER_ZOOM_STEPS.find(value => value > factor + .001) ?? 3 : [...BROWSER_ZOOM_STEPS].reverse().find(value => value < factor - .001) ?? .25;
}
export function readBrowserSettings(value: unknown): BrowserSettings | undefined {
  if (!value || typeof value !== "object") return;
  const s = value as Record<string, unknown>;
  if (!BROWSER_SEARCH_ENGINES.includes(s.searchEngine as BrowserSearchEngine) || typeof s.defaultZoom !== "number" || !Number.isFinite(s.defaultZoom) || s.defaultZoom < .25 || s.defaultZoom > 3 || typeof s.recordHistory !== "boolean") return;
  return { searchEngine: s.searchEngine as BrowserSearchEngine, defaultZoom: s.defaultZoom, recordHistory: s.recordHistory };
}
export function readBrowserDevicePreview(value: unknown): BrowserDevicePreview | undefined {
  if (!value || typeof value !== "object") return;
  const d = value as Record<string, unknown>;
  if (!["desktop", "phone", "tablet"].includes(String(d.preset)) || typeof d.landscape !== "boolean" || ![d.width, d.height, d.scale].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return;
  return { preset: d.preset as BrowserDevicePreview["preset"], landscape: d.landscape, width: d.width as number, height: d.height as number, scale: d.scale as number };
}
export function readBrowserHistory(value: unknown): BrowserHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.url !== "string" || typeof raw.title !== "string" || typeof raw.visitedAt !== "number" || !Number.isFinite(raw.visitedAt)) return [];
    try { const url = new URL(raw.url); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return []; } catch { return []; }
    return [{ id: raw.id.slice(0, 128), url: raw.url.slice(0, 8192), title: raw.title.slice(0, 512), visitedAt: raw.visitedAt }];
  });
}
