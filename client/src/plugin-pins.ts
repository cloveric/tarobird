/** Header pins for side-panel plugins: which ones get their own icon next to the 「插件」 menu. Per device. */
export const MAX_PINNED_PLUGINS = 3;
export const DEFAULT_PINNED_PLUGINS = 2;

export const pluginEntryKey = (pluginId: string, contributionId: string) => `${pluginId}:${contributionId}`;

/** The pinned entries, in header order. Until the user chooses (`saved` undefined), the first two installed count as
 * pinned; after that only the saved choice counts, so a newly installed plugin is not pinned by itself. Entries that
 * are no longer installed drop out, and never more than the limit. */
export function pinnedPluginKeys(entries: readonly { key: string; installedAt: number }[], saved: readonly string[] | undefined): string[] {
  const available = new Set(entries.map(entry => entry.key));
  if (saved === undefined) {
    return [...entries].sort((a, b) => a.installedAt - b.installedAt || a.key.localeCompare(b.key)).slice(0, DEFAULT_PINNED_PLUGINS).map(entry => entry.key);
  }
  return [...new Set(saved)].filter(key => available.has(key)).slice(0, MAX_PINNED_PLUGINS);
}

/** The new saved list after pinning or unpinning `key`; undefined when pinning would pass the limit. */
export function togglePinnedPlugin(current: readonly string[], key: string): string[] | undefined {
  if (current.includes(key)) return current.filter(item => item !== key);
  if (current.length >= MAX_PINNED_PLUGINS) return undefined;
  return [...current, key];
}

type SavedPins = { pinnedPlugins?: string[]; pinnedPluginsByScope?: Record<string, string[]> };

export function savedPluginPins(preferences: SavedPins, scope: string | null): string[] | undefined {
  const pins = scope && preferences.pinnedPluginsByScope?.[scope];
  // A saved empty list is intentional. The old device-wide list still
  // applies until the user makes a choice for this installation scope.
  return Array.isArray(pins) ? pins : preferences.pinnedPlugins;
}

export function storePluginPins<T extends SavedPins>(preferences: T, scope: string, pins: string[]): T {
  return { ...preferences, pinnedPluginsByScope: { ...preferences.pinnedPluginsByScope, [scope]: pins } };
}
