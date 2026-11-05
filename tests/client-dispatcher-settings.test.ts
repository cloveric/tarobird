import { describe, expect, it } from "vitest";
import { laterInstalledEngines, normalizedDispatcherSettings, toggledDispatcherEngine } from "../client/src/DispatcherSettings.js";

const base = { mode: "ask" as const, maxConcurrent: 2 };

describe("dispatcher settings keep an explicit CLI allowlist", () => {
  it("keeps allowed CLIs that are not installed or not yet listed", () => {
    expect(normalizedDispatcherSettings({ ...base, allowedEngines: ["kimi"] }, ["claude"])).toEqual({ ...base, allowedEngines: ["kimi"] });
    expect(normalizedDispatcherSettings({ ...base, allowedEngines: ["kimi"] }, [])).toEqual({ ...base, allowedEngines: ["kimi"] });
  });

  it("does not turn an allowlist naming every installed CLI into allowing future CLIs", () => {
    expect(normalizedDispatcherSettings({ ...base, allowedEngines: ["codex"] }, ["codex"])).toEqual({ ...base, allowedEngines: ["codex"] });
    expect(normalizedDispatcherSettings({ ...base, allowedEngines: ["claude", "codex"] }, ["codex", "claude"])).toEqual({ ...base, allowedEngines: ["codex", "claude"] });
  });

  it("keeps an omitted allowlist (every CLI, including later installs) omitted", () => {
    expect(normalizedDispatcherSettings(base, ["codex"])).toEqual(base);
    expect(normalizedDispatcherSettings(base, [])).toEqual(base);
  });

  it("ticking and unticking keep the list explicit and never empty", () => {
    // Every CLI allowed: unticking one narrows to the other installed CLIs.
    expect(toggledDispatcherEngine(base, ["codex", "claude"], "claude", false)).toEqual({ ...base, allowedEngines: ["codex"] });
    // Ticking the remaining installed CLI does not allow CLIs installed later.
    expect(toggledDispatcherEngine({ ...base, allowedEngines: ["codex"] }, ["codex", "claude"], "claude", true)).toEqual({ ...base, allowedEngines: ["codex", "claude"] });
    // A missing CLI stays allowed while another one is ticked or unticked.
    expect(toggledDispatcherEngine({ ...base, allowedEngines: ["kimi"] }, ["codex"], "codex", true)).toEqual({ ...base, allowedEngines: ["codex", "kimi"] });
    expect(toggledDispatcherEngine({ ...base, allowedEngines: ["codex", "kimi"] }, ["codex"], "codex", false)).toEqual({ ...base, allowedEngines: ["kimi"] });
    expect(toggledDispatcherEngine({ ...base, allowedEngines: ["kimi"] }, ["codex"], "kimi", false)).toBeUndefined();
  });

  it("allows CLIs installed later only by the explicit choice, and leaving it lists what is installed", () => {
    expect(laterInstalledEngines({ ...base, allowedEngines: ["codex"] }, ["codex", "claude"], true)).toEqual(base);
    expect(laterInstalledEngines(base, ["claude", "codex"], false)).toEqual({ ...base, allowedEngines: ["codex", "claude"] });
    // Nothing installed: an empty allowlist is invalid, so the choice stays.
    expect(laterInstalledEngines(base, [], false)).toBeUndefined();
  });
});
