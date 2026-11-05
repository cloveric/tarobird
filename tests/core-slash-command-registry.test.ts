import { describe, expect, it } from "vitest";

import { CORE_SLASH_COMMANDS } from "../src/core/slash-command-registry.js";

describe("core slash command catalog", () => {
  it("is unique, localized, and includes the primary control surface", () => {
    const names = CORE_SLASH_COMMANDS.map((item) => item.command);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "help", "status", "usage", "model", "effort", "stop", "group", "newgroup", "meeting",
    ]));
    for (const item of CORE_SLASH_COMMANDS) {
      expect(item.command).not.toMatch(/^\//);
      expect(item.description.defaultValue.trim()).not.toBe("");
      expect(item.description.i18n.en_us?.trim()).not.toBe("");
      expect(item.description.i18n.zh_cn?.trim()).not.toBe("");
    }
  });
});
