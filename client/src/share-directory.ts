import type { HostDirectory } from "./HostApp.js";

// Directory data is bounded-depth plain metadata, never message bodies. IDB
// returns fresh arrays and records even when only one preview has changed.
function share<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) !== Array.isArray(next)) return next;
  const old = previous as Record<string, unknown>, value = next as Record<string, unknown>;
  const keys = Object.keys(value);
  let same = keys.length === Object.keys(old).length;
  const result = (Array.isArray(next) ? [] : {}) as Record<string, unknown>;
  for (const key of keys) {
    const item = share(old[key], value[key]);
    Object.defineProperty(result, key, { value: item, writable: true, configurable: true, enumerable: true });
    if (!Object.hasOwn(old, key) || !Object.is(item, old[key])) same = false;
  }
  return same ? previous : result as T;
}

export function shareDirectory(previous: HostDirectory | undefined, next: HostDirectory): HostDirectory {
  if (!previous) return next;
  const conversations = share(previous.conversations, next.conversations), activity = share(previous.activity, next.activity);
  const globalPins = share(previous.globalPins, next.globalPins);
  const pins = share(previous.pins, next.pins), bots = share(previous.bots, next.bots);
  return conversations === previous.conversations && activity === previous.activity && pins === previous.pins && bots === previous.bots && globalPins === previous.globalPins
    ? previous : { conversations, activity, pins, globalPins, bots };
}
