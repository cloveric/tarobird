import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withChannelProfile } from "../src/core/channel-profile.js";
import { applyCoreConfigCardAction } from "../src/core/config-card.js";
import { SessionStore } from "../src/state/session-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

async function botState(config?: Record<string, unknown>): Promise<string> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-engine-switch-"));
  roots.push(stateDir);
  await mkdir(stateDir, { recursive: true });
  if (config) await writeFile(path.join(stateDir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  return stateDir;
}

// The App /config card switches the Bot engine through this Core path.
function switchEngine(stateDir: string, engine: string) {
  return withChannelProfile("gateway", () => applyCoreConfigCardAction(stateDir, {
    cctb_lark: "config",
    action: "engine",
    value: engine,
    conversationKey: "lark:gw_chat",
  }, "en"));
}

describe("core engine switch (App config card)", () => {
  it("clears incompatible model overrides when switching engines", async () => {
    const stateDir = await botState({ engine: "claude", model: "opus" });

    const notice = await switchEngine(stateDir, "codex");

    expect(notice).toContain("Engine set to codex");
    expect(notice).toContain("cleared model override");
    expect(notice).not.toContain("Lark service");
    await expect(readFile(path.join(stateDir, "config.json"), "utf8")).resolves.not.toContain('"model"');
  });

  it("clears session bindings when switching engines", async () => {
    const stateDir = await botState();
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: 123,
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-04-22T00:00:00.000Z",
    });

    const notice = await switchEngine(stateDir, "claude");

    expect(notice).toContain("reset session bindings");
    await expect(sessionStore.findByChatId(123)).resolves.toBeNull();
  });

  it("keeps the old engine when session bindings cannot be reset first", async () => {
    const stateDir = await botState({ engine: "claude", model: "opus" });
    vi.spyOn(SessionStore.prototype, "clearAll").mockRejectedValue(new Error("session store unavailable"));

    await expect(switchEngine(stateDir, "codex")).rejects.toThrow("session store unavailable");

    const config = await readFile(path.join(stateDir, "config.json"), "utf8");
    expect(config).toContain('"engine": "claude"');
    expect(config).toContain('"model": "opus"');
  });
});
