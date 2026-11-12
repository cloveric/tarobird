import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appAgentInstructions, appCapabilityInstructions, appTurnInstructions } from "../src/gateway/agent-instructions.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";

// The existing 1600-character baseline plus a scoped native Chrome reminder.
const CLAUDE_NATIVE_INSTRUCTION_BUDGET = 1900;

describe("Claude Chrome recovery guidance", () => {
  it("refreshes the browser contract before native delegated work even without browser keywords", () => {
    for (const context of ["chat", "card", "comment", "cron", "bus", "meeting", "discussion"] as const) {
      for (const nativeBatchDelivery of [false, true]) for (const nativeWidgets of [false, true]) for (const widgetsEnabled of [false, true]) for (const ticketWorker of [false, true]) {
      const standing = appAgentInstructions({ engine: "claude", claudeChrome: true, nativeDelivery: true, context, nativeBatchDelivery, nativeWidgets, widgetsEnabled, ticketWorker });
      expect(standing).toContain("Before browser work or drafting a browser subtask");
      expect(standing).toContain("read app_capability topic=browser");
      expect(standing).toContain("Children without this tool use the parent-supplied steps");
      expect(standing.length).toBeLessThan(CLAUDE_NATIVE_INSTRUCTION_BUDGET);
      }
    }
    // The publishing request that previously bypassed the keyword-based hint.
    expect(appTurnInstructions("发红书 b站 抖音 youtube", { engine: "claude", claudeChrome: true, nativeDelivery: true }) ?? "").not.toContain("osascript");
    for (const engine of ["codex", "kimi", "deepseek", "antigravity", "claude"] as const) {
      expect(appAgentInstructions({ engine, claudeChrome: engine !== "claude", nativeDelivery: true })).not.toContain("drafting a browser subtask");
    }
  });

  it("gives non-native fallback Claude sessions the recovery procedure without requiring an unavailable native tool", () => {
    for (const text of ["发红书 b站 抖音 youtube", "继续", "Publish the approved video", "浏览器断开了"]) {
      const guide = appTurnInstructions(text, { engine: "claude", claudeChrome: true, nativeDelivery: false })!;
      expect(guide).toContain("A running Chrome process is not proof");
      expect(guide).toContain("if (count of windows) is 0 then make new window");
      expect(guide).not.toContain("read app_capability");
      expect(guide.match(/A running Chrome process is not proof/g)).toHaveLength(1);
    }
  });

  it("bounds zero-window recovery and preserves profile, approval and success-evidence boundaries", () => {
    const guide = appCapabilityInstructions("browser", { engine: "claude", claudeChrome: true }, false);
    expect(guide).toContain("A running Chrome process is not proof");
    expect(guide).toContain("only when the selected browser is the main Chrome");
    expect(guide).toContain("do not replace explicit user or skill restrictions");
    expect(guide).toContain("at most one recovery sequence");
    expect(guide).toContain("bounded connection retries");
    expect(guide).toContain("only after the browser tool succeeds");
    expect(guide).toContain("A process, window or socket alone");
    expect(guide).toContain("do not grant Automation permissions");
    expect(guide).toContain("ask before quitting or relaunching it");
    expect(guide).toContain("unless the user named that port or browser");
    expect(guide).toContain("never close a window's last tab");
    expect(guide).toContain("If still disconnected, one guarded AppleScript attempt is allowed");
    expect(guide).toContain("Do not force a profile or inspect Chrome profile files");
    expect(guide).toContain("If a restriction's source is unclear, honor it and ask");
    for (const options of [{ engine: "claude" as const, claudeChrome: false }, { engine: "codex" as const, claudeChrome: true }]) {
      expect(appCapabilityInstructions("browser", options, false)).not.toContain("if (count of windows) is 0 then make new window");
    }
  });

  it("refreshes a persisted native session without changing its tools, identity or Chrome setting", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "chrome-guidance-"));
    try {
      const id = "existing-native-thread", version = "4ced9591d11ef38a38d87d3df86297ebfa998d95d32d662a7e061d33cbe0344a";
      const file = path.join(stateDir, "app-tool-threads", `${createHash("sha256").update(id).digest("hex")}.json`);
      await mkdir(path.dirname(file));
      const record = JSON.stringify({ toolVersion: version });
      await writeFile(file, record);
      for (const enabled of [true, false]) {
        const signal = new AbortController().signal;
        const tools = createAppPlatformTools({
          channel: { sendArtifact: async () => { throw new Error("No artifacts may be sent"); } },
          stateDir, conversationId: "gw_recovery", signal, receipts: new GatewayReceipts(stateDir),
          options: { engine: "claude", claudeChrome: enabled }, turnText: "继续",
        });
        const resumed = (await tools.forSession!(id))!;
        expect(createHash("sha256").update(JSON.stringify(resumed.definitions)).digest("hex")).toBe(version);
        const result = await resumed.call({ name: "app_capability", arguments: { topic: "browser" }, callId: `guide-${enabled}`, sessionId: id, abortSignal: signal });
        expect(result.isError).not.toBe(true);
        expect(result.text.includes("A running Chrome process is not proof")).toBe(enabled);
        expect(resumed.instructions.includes("drafting a browser subtask")).toBe(enabled);
        expect(await readFile(file, "utf8")).toBe(record);
      }
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
