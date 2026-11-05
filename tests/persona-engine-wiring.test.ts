import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBridgeDependencies } from "../src/core/engine-factory.js";
import { Bridge, type AccessStoreLike, type SessionManagerLike } from "../src/runtime/bridge.js";
import type { AppPlatformTools, CodexAdapter } from "../src/codex/adapter.js";

afterEach(() => vi.unstubAllEnvs());
it.each(["missing-end", "duplicate", "oversized-section", "linked-file", "linked-workspace", "oversized-legacy"])("keeps a Bot startable while rejecting unsafe persona edits: %s", async kind => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persona-startup-repair-"));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let bridge: Bridge | undefined;
  try {
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "config.json"), '{"engine":"claude"}');
    const file = path.join(root, "workspace", "AGENTS.md");
    const start = "<!-- TaroBot persona: start -->", end = "<!-- TaroBot persona: end -->";
    let original = "# Keep working rules\n";
    if (kind === "missing-end") original += start + "\nUnfinished manual edit";
    if (kind === "duplicate") original += start + "\n" + start + "\n" + end;
    if (kind === "oversized-section") original += start + "\n" + "x".repeat(16001) + "\n" + end;
    if (kind === "linked-workspace") {
      await mkdir(path.join(root, "shared")); await rm(path.join(root, "workspace"), { recursive: true });
      await symlink(path.join(root, "shared"), path.join(root, "workspace"), "dir");
    }
    if (kind === "linked-file") {
      await writeFile(path.join(root, "shared.md"), original); await symlink(path.join(root, "shared.md"), file);
    } else await writeFile(file, original);
    if (kind === "oversized-legacy") await writeFile(path.join(root, "agent.md"), "x".repeat(16001));
    const problem = kind.startsWith("oversized") ? "persona_too_large" : "persona_unreadable";
    ({ bridge } = await createBridgeDependencies({ HOME: root, USERPROFILE: root, TAROBOT_STATE_DIR: root }, { transport: "gateway" }));
    expect(await readFile(file, "utf8")).toBe(original);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(problem));
    const { personaSettings } = await import("../src/runtime/persona-settings.js");
    expect(await personaSettings(root, 0)).toEqual({ ok: false, error: problem });
  } finally { warning.mockRestore(); await bridge?.destroy(); await rm(root, { recursive: true, force: true }); }
});

it.each(["codex", "claude", "deepseek", "antigravity"])("%s uses the Bot AGENTS.md and no legacy persona injection", async engine => {
  const root = await mkdtemp(path.join(os.tmpdir(), "persona-engine-")), stateDir = path.join(root, "bot");
  vi.stubEnv("TAROBOT_SEARCH_CREDENTIAL_FALLBACK", "0");
  for (const key of ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"]) vi.stubEnv(key, "");
  let bridge: Bridge | undefined;
  try {
    await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
    await writeFile(path.join(stateDir, "agent.md"), "Persona to migrate");
    ({ bridge } = await createBridgeDependencies({ HOME: root, USERPROFILE: root, TAROBOT_STATE_DIR: stateDir, TAROBOT_INSTANCE: "alpha" }, { transport: "gateway" }));
    const adapter = (bridge as any).adapter;
    expect(engine === "deepseek" ? adapter.gateway.options.instructionsPath : adapter.instructionsPath).toBeUndefined();
    expect(await readFile(path.join(stateDir, "workspace", "AGENTS.md"), "utf8")).toContain("Persona to migrate");
    expect(await readFile(path.join(stateDir, "agent.md.migrated"), "utf8")).toBe("Persona to migrate");
  } finally { await (bridge as any)?.adapter.destroy?.(); await rm(root, { recursive: true, force: true }); }
});

it("keeps the exact Bot file reference in ordinary, native and resumed-schema App turns", async () => {
  const access: AccessStoreLike = { load: vi.fn(async () => ({ policy: "allowlist", pairedUsers: [], allowlist: [84], pendingPairs: [] })), issuePairingCode: vi.fn() };
  const sessions: SessionManagerLike = { getOrCreateSession: vi.fn(async () => ({ sessionId: "test-session" })), bindSession: vi.fn() };
  const send = vi.fn(async () => ({ text: "done" }));
  const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: send };
  const file = "/bots/alpha/workspace/AGENTS.md";
  const bridge = new Bridge(access, sessions, adapter, { botInstructionsPath: file });
  const compat: AppPlatformTools = { definitions: [], instructions: "Compatible native contract", turnInstructions: "Compatible turn", isRegistered: async () => true, register: async () => {}, call: async () => ({ text: "ok" }) };
  const tools = { ...compat, instructions: "Current native contract", turnInstructions: "Current turn", forSession: async () => compat };
  for (const appPlatformTools of [undefined, tools]) {
    await bridge.handleAuthorizedMessage({ chatId: 84, userId: 42, chatType: "private", text: "Reload your AGENTS.md", files: [], workspaceOverride: "/shared/project", instructions: "Stable contract", turnInstructions: "Delivery guidance", appPlatformTools });
    const input = (send.mock.calls.at(-1) as unknown as [string, import("../src/codex/adapter.js").CodexUserMessageInput])[1];
    expect(input.turnInstructions).toContain(file);
    expect(input.turnInstructions).toContain("Delivery guidance");
    expect(input.instructions).toBe("Stable contract");
    if (appPlatformTools) {
      expect(input.appPlatformTools?.turnInstructions).toContain(file);
      const selected = await input.appPlatformTools?.forSession?.("test-session");
      expect(selected?.turnInstructions).toContain(file);
      expect(selected?.turnInstructions).toContain("Compatible turn");
      expect(selected?.instructions).toBe("Compatible native contract");
    }
  }
  expect(tools.turnInstructions).toBe("Current turn"); expect(compat.turnInstructions).toBe("Compatible turn");
});
