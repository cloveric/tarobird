const STORAGE_KEY = 'tarobot-widget-quarantine-v1';
const TTL = 7 * 24 * 60 * 60 * 1000;
export type WidgetStopReason = 'cpu' | 'error' | 'limit';
type Entry = { hash: string; at: number; reason: WidgetStopReason };
const memory = new Map<string, Entry>();
const fingerprints = new Map<string, Promise<string>>();
export function parseWidgetQuarantine(raw: string | null, now = Date.now()): Entry[] {
  if (!raw || raw.length > 20_000) return [];
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 64) return [];
    return value.entries.filter((entry: Entry) => entry && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isFinite(entry.at) && entry.at <= now + 60_000 && entry.at > now - TTL && ['cpu','error','limit'].includes(entry.reason));
  } catch { return []; }
}
function entries(): Entry[] {
  let saved: Entry[] = [];
  try { saved = parseWidgetQuarantine(localStorage.getItem(STORAGE_KEY)); } catch { /* Private modes can deny storage; retain this window's failures. */ }
  const combined = new Map(saved.map(entry => [entry.hash, entry]));
  for (const entry of memory.values()) if (entry.at > Date.now() - TTL) combined.set(entry.hash, entry);
  return [...combined.values()].sort((a,b) => b.at - a.at).slice(0,64);
}
export function widgetStopReason(hash: string): WidgetStopReason | undefined { return entries().find(entry => entry.hash === hash)?.reason; }
export function stopWidget(hash: string, reason: WidgetStopReason): void {
  const next = entries().filter(entry => entry.hash !== hash);
  next.unshift({ hash, reason, at: Date.now() });
  memory.clear(); for (const entry of next.slice(0,64)) memory.set(entry.hash, entry);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: next.slice(0,64) })); } catch { /* Memory still prevents this window from rerunning it. */ }
}
export function retryWidget(hash: string): void {
  memory.delete(hash);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries: entries().filter(entry => entry.hash !== hash) })); } catch { /* Explicit retry remains available when storage is denied. */ }
}
export function widgetFingerprint(html: string): Promise<string> {
  let result = fingerprints.get(html);
  if (!result) {
    result = Promise.resolve().then(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))).then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join(''));
    if (fingerprints.size >= 8) fingerprints.delete(fingerprints.keys().next().value!);
    fingerprints.set(html, result);
  }
  return result;
}
