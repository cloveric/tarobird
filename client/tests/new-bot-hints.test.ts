import { describe, expect, it } from "vitest";
import type { BotCatalog } from "../../src/client-protocol/bots.js";
import { formatUnavailableEngineList, unavailableEngines } from "../src/new-bot-hints.js";

function engineEntry(id: BotCatalog["engines"][number]["id"], available: boolean): BotCatalog["engines"][number] {
  return { id, available, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" };
}

describe("New Bot unavailable engine hints", () => {
  it("handles undefined or empty catalogs safely", () => {
    expect(unavailableEngines(undefined)).toEqual({
      allUnavailable: false,
      partialUnavailable: false,
      unavailableIds: [],
      unavailableLabels: [],
    });
    expect(unavailableEngines({ engines: [] })).toEqual({
      allUnavailable: false,
      partialUnavailable: false,
      unavailableIds: [],
      unavailableLabels: [],
    });
  });

  it("reports allUnavailable when no engines are detected", () => {
    const summary = unavailableEngines({
      engines: [engineEntry("codex", false), engineEntry("antigravity", false)],
    });
    expect(summary.allUnavailable).toBe(true);
    expect(summary.partialUnavailable).toBe(false);
    expect(summary.unavailableIds).toEqual(["codex", "antigravity"]);
    expect(summary.unavailableLabels).toEqual(["Codex", "Antigravity"]);
  });

  it("reports partialUnavailable with readable labels when only some engines are missing", () => {
    const summary = unavailableEngines({
      engines: [
        engineEntry("codex", true),
        engineEntry("claude", false),
        engineEntry("antigravity", false),
        engineEntry("pi", true),
      ],
    });
    expect(summary.allUnavailable).toBe(false);
    expect(summary.partialUnavailable).toBe(true);
    expect(summary.unavailableIds).toEqual(["claude", "antigravity"]);
    expect(formatUnavailableEngineList(summary.unavailableLabels, "、")).toBe("Claude Code、Antigravity");
    expect(formatUnavailableEngineList(summary.unavailableLabels, ", ")).toBe("Claude Code, Antigravity");
  });

  it("reports neither banner nor partial hint when all engines are available", () => {
    const summary = unavailableEngines({
      engines: [engineEntry("codex", true), engineEntry("antigravity", true)],
    });
    expect(summary.allUnavailable).toBe(false);
    expect(summary.partialUnavailable).toBe(false);
    expect(summary.unavailableIds).toEqual([]);
  });
});
