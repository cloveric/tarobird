/** Per-window, bounded authored state. No storage, network or executable data.
 * The scope is App-owned (Host/user/conversation/message/block), never supplied
 * by the guest. A source change receives a different SHA-256 identity. */
export const MAX_WIDGET_STATE_BYTES = 16 * 1024;
const states = new Map<string, string>();
const stateKey = (scope: string, hash: string) => JSON.stringify([scope, hash]);
export function readWidgetState(scope: string, hash: string): string | undefined {
  const key = stateKey(scope, hash), value = states.get(key);
  if (value !== undefined) { states.delete(key); states.set(key, value); }
  return value;
}
export function saveWidgetState(scope: string, hash: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_WIDGET_STATE_BYTES || new TextEncoder().encode(value).length > MAX_WIDGET_STATE_BYTES) return false;
  try { JSON.parse(value); } catch { return false; }
  const key = stateKey(scope, hash);
  states.delete(key); states.set(key, value);
  while (states.size > 64) states.delete(states.keys().next().value!);
  return true;
}
