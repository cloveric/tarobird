import { expect, it } from "vitest";
import { MAX_PINNED_PLUGINS, pinnedPluginKeys, pluginEntryKey, togglePinnedPlugin } from "./plugin-pins.js";

const entries = [
  { key: pluginEntryKey("c", "panel"), installedAt: 30 },
  { key: pluginEntryKey("a", "panel"), installedAt: 10 },
  { key: pluginEntryKey("b", "panel"), installedAt: 20 },
  { key: pluginEntryKey("d", "panel"), installedAt: 40 },
];

it("pins the first two installed until the user chooses", () => {
  expect(pinnedPluginKeys(entries, undefined)).toEqual(["a:panel", "b:panel"]);
  expect(pinnedPluginKeys(entries.slice(0, 1), undefined)).toEqual(["c:panel"]);
  expect(pinnedPluginKeys([], undefined)).toEqual([]);
});

it("after a choice, keeps only that choice: a newly installed plugin is not pinned, uninstalled ones drop out", () => {
  expect(pinnedPluginKeys(entries, ["d:panel"])).toEqual(["d:panel"]);
  expect(pinnedPluginKeys(entries, [])).toEqual([]);
  expect(pinnedPluginKeys(entries, ["gone:panel", "b:panel", "b:panel"])).toEqual(["b:panel"]);
  expect(pinnedPluginKeys(entries, ["a:panel", "b:panel", "c:panel", "d:panel"])).toHaveLength(MAX_PINNED_PLUGINS);
});

it("toggles a pin and refuses a fourth", () => {
  expect(togglePinnedPlugin(["a:panel"], "b:panel")).toEqual(["a:panel", "b:panel"]);
  expect(togglePinnedPlugin(["a:panel", "b:panel"], "a:panel")).toEqual(["b:panel"]);
  expect(togglePinnedPlugin(["a:panel", "b:panel", "c:panel"], "d:panel")).toBeUndefined();
  expect(togglePinnedPlugin(["a:panel", "b:panel", "c:panel"], "c:panel")).toEqual(["a:panel", "b:panel"]);
});
