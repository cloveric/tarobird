/** Small per-window emergency drafts survive a Host/profile switch or reload.
 * Normal content remains in IndexedDB; this is used only when a save fails. */
export type NoteRecovery = { content: string; revision: number };
const prefix = "tarobot-note-recovery:", memory = new Map<string, NoteRecovery>();
let listening = false;
const clearedDevices = new Set<string>();
const protect = (event: BeforeUnloadEvent) => { if (memory.size) { event.preventDefault(); event.returnValue = ""; } };
export const noteRecoveryKey = (device: string, scope: string, id: string) => prefix + JSON.stringify([device, scope, id]);
export function rememberNoteRecovery(key: string, value: NoteRecovery | undefined) {
  try { if (clearedDevices.has(JSON.parse(key.slice(prefix.length))[0])) value = undefined; } catch { return; }
  if (value) memory.set(key, value); else memory.delete(key);
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* In-memory recovery and close guard remain available. */ }
  if (memory.size && !listening) { globalThis.addEventListener?.("beforeunload", protect); listening = true; }
  if (!memory.size && listening) { globalThis.removeEventListener?.("beforeunload", protect); listening = false; }
}
export function readNoteRecovery(key: string): NoteRecovery | undefined {
  const current = memory.get(key); if (current) return current;
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (typeof value?.content === "string" && new TextEncoder().encode(value.content).length <= 128 * 1024 && Number.isSafeInteger(value.revision) && value.revision >= 0) return value;
  } catch { /* Missing or malformed recovery is not authoritative content. */ }
}
export function clearNoteRecoveries(device: string) {
  clearedDevices.add(device);
  const matches = (key: string) => { try { return key.startsWith(prefix) && JSON.parse(key.slice(prefix.length))[0] === device; } catch { return false; } };
  const keys = new Set(memory.keys());
  try { for (let index = 0; index < sessionStorage.length; index++) { const key = sessionStorage.key(index); if (key) keys.add(key); } } catch { /* Memory cleanup still applies. */ }
  for (const key of keys) if (matches(key)) rememberNoteRecovery(key, undefined);
}
