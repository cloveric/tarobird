// Migrated for issue #48 from tests/telegram-simple-commands.test.ts. The retired
// Telegram command implementation duplicated the shared model/effort/fast rules;
// these cases assert the same rules through the Core command handler (default
// compatibility channel profile, explicit English locale) that the App also uses.
// Rules already asserted by tests/core-service-compat.test.ts are recorded as
// "covered" in disposition.json instead of being repeated here.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleCoreMessage } from "../src/core/message-handler.js";
import { stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { SessionStore } from "../src/state/session-store.js";
import { fakeChannel, fakeLarkMessage, type FakeLarkChannel } from "./helpers/core-compat-fixtures.js";

function markdownReplies(channel: FakeLarkChannel): string[] {
  return (channel.send.mock.calls as unknown[][])
    .map((call) => (call[1] as { markdown?: unknown } | undefined)?.markdown)
    .filter((value): value is string => typeof value === "string");
}

async function readConfig(stateDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
}

/** Runs local commands against one instance config and returns what was replied. */
async function withCommandInstance(
  config: Record<string, unknown>,
  run: (send: (text: string) => Promise<string[]>, stateDir: string) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-engine-command-rules-"));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale: "en", ...config }) + "\n", "utf8");
  const bridge = {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
  };
  let sequence = 0;
  const send = async (text: string): Promise<string[]> => {
    const channel = fakeChannel();
    sequence += 1;
    await handleCoreMessage({
      channel,
      bridge,
      runtime: createCoreServiceRuntime(),
      stateDir,
      message: fakeLarkMessage({ messageId: `om_command_${sequence}`, content: text }),
    });
    return markdownReplies(channel);
  };

  try {
    await run(send, stateDir);
    // Local commands never reach the engine.
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe("shared engine command rules", () => {
  it("preserves the complete ordered Codex model choices after adapter retirement", async () => {
    await withCommandInstance({ engine: "codex" }, async (send) => {
      expect((await send("/model")).join("\n")).toBe([
        "Current model: default", "Choose a model with /model <name>:",
        "/model gpt-6-astra", "/model gpt-6.1-sol", "/model gpt-6-sol", "/model gpt-6-luna",
        "/model gpt-5.6-sol", "/model gpt-5.6-terra", "/model gpt-5.6-luna", "/model gpt-5.5", "/model off",
        "Astra/Sol/Terra support max and ultra; Luna supports max but not ultra.",
      ].join("\n"));
    });
  });
  it("rejects GPT-6 Luna when the existing effort is ultra without changing config", async () => {
    await withCommandInstance({ engine: "codex", model: "gpt-6.1-sol", effort: "ultra" }, async (send, stateDir) => {
      expect((await send("/model gpt-6-luna")).join("\n")).toContain("ultra");
      expect(await readConfig(stateDir)).toMatchObject({ model: "gpt-6.1-sol", effort: "ultra" });
    });
  });

  it("appends the Claude-only budget note to /usage on non-Claude engines with a budget set", async () => {
    await withCommandInstance({ engine: "codex", budgetUsd: 25 }, async (send) => {
      expect((await send("/usage")).join("\n")).toContain(
        "Note: Codex/Antigravity engines do not report dollar cost; the budget cap currently only takes effect on Claude.",
      );
    });
  });

  it("keeps /usage note-free when the engine is Claude or no budget is configured", async () => {
    // Claude engine with a budget: the cap is real, no note.
    await withCommandInstance({ engine: "claude", budgetUsd: 25 }, async (send) => {
      expect((await send("/usage")).join("\n")).not.toContain("budget cap");
    });
    // Codex engine without a budget: nothing to warn about (compatibility
    // profile; the App profile always notes Codex's missing dollar telemetry).
    await withCommandInstance({ engine: "codex" }, async (send) => {
      expect((await send("/usage")).join("\n")).not.toContain("budget cap");
    });
  });

  it("rejects DeepSeek Harness effort values outside off/low/high/max", async () => {
    await withCommandInstance({ engine: "deepseek", effort: "high" }, async (send, stateDir) => {
      for (const level of ["xhigh", "medium", "ultra"]) {
        expect(await send(`/effort ${level}`)).toContain("DeepSeek Harness effort supports only low, high, max, or off.");
      }
      expect((await readConfig(stateDir)).effort).toBe("high");
      // The supported levels still persist.
      expect(await send("/effort max")).toContain("Effort set to max.");
      expect((await readConfig(stateDir)).effort).toBe("max");
    });
  });

  it("rejects Kimi effort values outside the live ACP range", async () => {
    await withCommandInstance({ engine: "kimi", effort: "high" }, async (send, stateDir) => {
      expect(await send("/effort xhigh")).toContain("Kimi effort supports only low, high, max, or off.");
      expect((await readConfig(stateDir)).effort).toBe("high");
    });
  });

  it("rejects switching an ultra instance to GPT-5.6 Luna", async () => {
    await withCommandInstance({ engine: "codex", model: "gpt-5.6-sol", effort: "ultra" }, async (send, stateDir) => {
      expect(await send("/model gpt-5.6-luna")).toContain(
        "gpt-5.6-luna supports up to max, which is incompatible with current effort ultra; change /effort first.",
      );
      expect(await readConfig(stateDir)).toMatchObject({ model: "gpt-5.6-sol", effort: "ultra" });
    });
  });

  it("rejects Claude /effort ultra without changing config", async () => {
    await withCommandInstance({ engine: "claude" }, async (send, stateDir) => {
      expect(await send("/effort ultra")).toContain("Claude does not support ultra; use max for its highest effort.");
      expect((await readConfig(stateDir)).effort).toBeUndefined();
    });
  });

  it.each(["high", "xhigh", "max"])("sets Antigravity effort %s supported by the agy startup flag", async (effort) => {
    await withCommandInstance({ engine: "antigravity" }, async (send, stateDir) => {
      expect(await send(`/effort ${effort}`)).toContain(`Effort set to ${effort}.`);
      expect((await readConfig(stateDir)).effort).toBe(effort);
    });
  });

  it("refuses conflicting Antigravity presets in both slash commands and allows an explicit repair", async () => {
    await withCommandInstance({ engine: "antigravity", model: "gemini-3.8-flash-high", effort: "high" }, async (send, stateDir) => {
      expect((await send("/effort low")).join("\n")).toContain("incompatible");
      expect(await readConfig(stateDir)).toMatchObject({ model: "gemini-3.8-flash-high", effort: "high" });
      expect((await send("/model gemini-3.8-flash-low")).join("\n")).toContain("incompatible");
      expect(await readConfig(stateDir)).toMatchObject({ model: "gemini-3.8-flash-high", effort: "high" });
      await send("/effort default");
      await send("/model gemini-3.8-flash-low");
      await send("/effort low");
      expect(await readConfig(stateDir)).toMatchObject({ model: "gemini-3.8-flash-low", effort: "low" });
    });
  });

  it("rejects /fast for Claude instances", async () => {
    await withCommandInstance({ engine: "claude" }, async (send, stateDir) => {
      expect(await send("/fast on")).toContain("Fast Mode is Codex-only.");
      expect((await readConfig(stateDir)).codexServiceTier).toBeUndefined();
    });
  });

  it("disables Codex fast mode through /fast off", async () => {
    await withCommandInstance({ engine: "codex", codexServiceTier: "fast" }, async (send, stateDir) => {
      expect(await send("/fast off")).toContain("Codex Fast Mode disabled.");
      expect((await readConfig(stateDir)).codexServiceTier).toBeUndefined();
    });
  });

  it("keeps malformed /fast commands local instead of forwarding them to the engine", async () => {
    await withCommandInstance({ engine: "codex" }, async (send, stateDir) => {
      expect(await send("/fast on extra")).toContain("Usage: /fast [on|off|status]");
      expect((await readConfig(stateDir)).codexServiceTier).toBeUndefined();
    });
  });

  it("explains Kimi's provider-defined model IDs on bare /model", async () => {
    await withCommandInstance({ engine: "kimi", model: "moonshot-v1" }, async (send) => {
      expect((await send("/model")).join("\n")).toContain(
        "Kimi validates the exact model ID through ACP when the next turn starts.",
      );
    });
  });

  it("rejects multi-token /model values for Codex before they can break startup", async () => {
    await withCommandInstance({ engine: "codex" }, async (send, stateDir) => {
      expect(await send("/model foo bar")).toContain("Usage: /model <single-token-name|off>");
      expect((await readConfig(stateDir)).model).toBeUndefined();
    });
  });

  async function expectStatusSessionLine(engine: string, sessionId: string, line: string): Promise<void> {
    await withCommandInstance({ engine }, async (_send, stateDir) => {
      await new SessionStore(path.join(stateDir, "session.json")).upsert({
        telegramChatId: stableCoreNumericId("lark:oc_chat"),
        conversationKey: "lark:oc_chat",
        codexSessionId: sessionId,
        status: "idle",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      const channel = fakeChannel();
      await handleCoreMessage({
        channel,
        bridge: {
          checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
          handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
        },
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: `om_status_${engine}`, content: "/status" }),
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain(`Engine: ${engine}`);
      expect(rendered).toContain("Session bound: yes");
      expect(rendered).toContain(line);
    });
  }

  it("includes the current Antigravity conversation id in /status when available", async () => {
    await expectStatusSessionLine(
      "antigravity",
      "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
      "Current conversation: fdfc8ab1-7936-4599-98b0-d8ba2593c250",
    );
  });

  it("includes the current Kimi session id in /status when available", async () => {
    await expectStatusSessionLine("kimi", "kimi-session-123", "Current Kimi session: kimi-session-123");
  });
});
