import { describe, expect, it } from "vitest";
import { appCapabilityInstructions, appTurnInstructions, workbenchInstructions } from "../src/gateway/agent-instructions.js";
import { workbenchDesignGuidance, workbenchPptRouting } from "../src/gateway/design-guidance.js";

describe("Workbench presentation routing (#90): neutral, simplified, no Baoyu PPT special rules", () => {
  it("does not attach a long Baoyu PPT routing wall or mention baoyu-ppt on ordinary turns", () => {
    expect(workbenchPptRouting).not.toMatch(/baoyu|宝玉|宝育/i);
    expect(workbenchDesignGuidance).not.toMatch(/baoyu-ppt|宝玉|宝育/i);
    const ordinary = appTurnInstructions("帮我做一个季度汇报 PPT", { engine: "claude", nativeDelivery: true, nativeWidgets: true }) ?? "";
    expect(ordinary).not.toMatch(/baoyu|宝玉|宝育/i);
    expect(ordinary).not.toContain("PPT selection:");
  });

  it("guides Bots to open Workbench Presentation for explicit Workbench slide requests without Baoyu naming", () => {
    const opener = { deviceId: "d", windowId: "opener" };
    const guide = workbenchInstructions("chat", "input", { target: opener, openTarget: opener }) ?? "";
    expect(guide).toContain("format:'slides'");
    expect(guide).not.toMatch(/baoyu-ppt|宝玉|宝育/i);

    for (const topic of ["browser", "widgets"] as const) {
      const cap = appCapabilityInstructions(topic, { widgetsEnabled: true });
      expect(cap).toContain("project/deck.json");
      expect(cap).toContain("project/slides/");
      expect(cap).not.toMatch(/baoyu-ppt|宝玉|宝育/i);
    }
  });
});
