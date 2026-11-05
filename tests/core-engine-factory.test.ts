// Migrated for issue #48 from tests/lark-service.test.ts (createDefaultLarkBridge) and
// tests/service.test.ts (resolveEngineRuntime/readInstanceRuntimeConfig re-exports and
// createServiceDependenciesForInstance). Both retired entries only forwarded env into
// core/engine-factory; these cases call it directly with the options the remaining
// production caller uses (gateway/worker.ts createGatewayBridge).
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import type { EnvSource } from "../src/config.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { DeepSeekHarnessAdapter } from "../src/codex/deepseek-harness-adapter.js";
import { KimiAcpAdapter } from "../src/codex/kimi-acp-adapter.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import {
  createBridgeDependencies,
  buildEngineEnvironment,
  readInstanceRuntimeConfig,
  resolveEngineRuntime,
} from "../src/core/engine-factory.js";
import { appAgentInstructions } from "../src/gateway/agent-instructions.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// Never resolve the developer's real Codex credentials into fixture adapters.
beforeEach(() => { for (const key of ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"]) vi.stubEnv(key, ""); });
afterEach(() => vi.unstubAllEnvs());

/** Same options as gateway/worker.ts createGatewayBridge. */
function createGatewayBridgeDependencies(env: EnvSource) {
  return createBridgeDependencies(env, { transport: "gateway", startupInstructions: appAgentInstructions });
}

it("removes inherited MCP-only flags before resolving a new engine", () => {
  vi.stubEnv("TAROBOT_SEARCH_CREDENTIAL_FALLBACK", "0");
  expect(buildEngineEnvironment({}, "gateway").TAROBOT_SEARCH_CREDENTIAL_FALLBACK).toBeUndefined();
});

describe("createBridgeDependencies with the Gateway worker options", () => {
  it("synchronizes current Kimi system instructions during bridge startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-kimi-startup-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const agentPath = path.join(stateDir, "workspace", ".kimi-code", "agents", "agent.md");
    try {
      await mkdir(path.dirname(agentPath), { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
        engine: "kimi",
        timezone: "Asia/Shanghai",
      }) + "\n", "utf8");
      await writeFile(agentPath, [
        "---",
        "name: agent",
        "description: Project main agent",
        "override: true",
        "---",
        "",
        "${base_prompt}",
        "",
        "${plugin_sections}",
        "",
        "<!-- TaroCub Kimi system instructions: start -->",
        "Browser: 9222/9223 only for a named skill.",
        "<!-- TaroCub Kimi system instructions: end -->",
        "",
      ].join("\n"), "utf8");

      const { bridge } = await createGatewayBridgeDependencies({
        HOME: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_TELEGRAM_STATE_DIR: stateDir,
      });

      const updated = await readFile(agentPath, "utf8");
      // The stale managed block is replaced by the current startup contract. The
      // original asserted Lark contract lines (src/lark/agent-instructions.ts, retired
      // with the adapter); the remaining caller syncs the App contract instead.
      expect(updated).toContain("<!-- TaroCub Kimi system instructions: start -->");
      expect(updated).toContain("You are replying in TaroBird App (desktop/mobile)");
      expect(updated).not.toContain("9222/9223 only for a named skill");
      await (bridge as any).adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards the configured DeepSeek executable and shared home through createBridgeDependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-deepseek-env-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "deepseek" }) + "\n", "utf8");

      const { bridge } = await createGatewayBridgeDependencies({
        HOME: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_TELEGRAM_STATE_DIR: stateDir,
        DSH_EXECUTABLE: "/opt/dsh-lark",
        DSH_HOME: path.join(root, "shared-dsh-home"),
      });

      const adapter = (bridge as any).adapter;
      expect(adapter).toBeInstanceOf(DeepSeekHarnessAdapter);
      const gateway = adapter.gateway;
      expect(gateway.executable).toBe("/opt/dsh-lark");
      expect(gateway.options.sharedHome).toBe(path.join(root, "shared-dsh-home"));
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("engine runtime resolution", () => {
  it("reports Claude's default runtime as stream", () => {
    expect(resolveEngineRuntime("claude", "normal")).toBe("stream");
  });

  it("reports Codex's default runtime as app-server", () => {
    expect(resolveEngineRuntime("codex", "normal")).toBe("app-server");
  });

  it("reports Kimi's runtime as ACP", () => {
    expect(resolveEngineRuntime("kimi", "normal")).toBe("acp");
  });

  it("reports DeepSeek Harness runtime as web", () => {
    expect(resolveEngineRuntime("deepseek", "normal")).toBe("web");
  });

  it("honors the Codex runtime override", () => {
    expect(resolveEngineRuntime("codex", "normal", "process")).toBe("process");
  });

  it("defaults Kimi without an approval mode to ACP yolo and keeps other engines on bypass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const configPath = path.join(root, "config.json");

    try {
      for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
        await writeFile(configPath, JSON.stringify({ engine }) + "\n", "utf8");

        await expect(readInstanceRuntimeConfig(configPath)).resolves.toMatchObject({
          engine,
          approvalMode: engine === "kimi" ? "full-auto" : "bypass",
          claudeChrome: false,
        });
      }
    } finally {
      await removeTempRoot(root);
    }
  });

  it("enables Claude's native Chrome integration only when configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({
        engine: "claude",
        claudeChrome: true,
      }) + "\n", "utf8");

      await expect(readInstanceRuntimeConfig(configPath)).resolves.toMatchObject({
        engine: "claude",
        claudeChrome: true,
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("requires a Kimi 0.41 Never Ask acknowledgement before resolving bypass to ACP auto", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({
        engine: "kimi",
        approvalMode: "bypass",
      }) + "\n", "utf8");
      await expect(readInstanceRuntimeConfig(configPath)).resolves.toMatchObject({
        engine: "kimi",
        approvalMode: "full-auto",
      });

      await writeFile(configPath, JSON.stringify({
        engine: "kimi",
        approvalMode: "bypass",
        kimiAutoNeverAskAcknowledged: true,
      }) + "\n", "utf8");
      await expect(readInstanceRuntimeConfig(configPath)).resolves.toMatchObject({
        engine: "kimi",
        approvalMode: "bypass",
      });
    } finally {
      await removeTempRoot(root);
    }
  });
});

// Each case below previously wrote a Telegram .env with TELEGRAM_BOT_TOKEN and called
// createServiceDependenciesForInstance(env, "alpha"); that wrapper only resolved the
// token and the TAROCUB_INSTANCE/CODEX_TELEGRAM_INSTANCE names before calling the
// core factory, so the instance name is now passed directly.
describe("engine adapter construction", () => {
  it("uses the app-server Codex adapter by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(CodexAppServerAdapter);
      // Codex bots now share ~/.codex/ directly — same reasoning as Claude.
      expect((result.bridge as any).adapter.childEnv.CODEX_HOME).toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps the shared turn pool disabled by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      expect((result.bridge as any).options.turnPool).toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("enables the shared turn pool only when explicitly configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
        TAROCUB_MAX_CONCURRENT_TURNS: "2",
      });

      expect((result.bridge as any).options.turnPool).toBeDefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("honours CODEX_HOME injected through the EnvSource", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
        CODEX_HOME: "/tmp/custom-main-codex-home",
      });

      expect((result.bridge as any).adapter.childEnv.CODEX_HOME).toBe("/tmp/custom-main-codex-home");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("honours APPDATA injected through the EnvSource", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));

    try {
      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
        APPDATA: "/tmp/custom-appdata",
      });

      expect((result.bridge as any).adapter.childEnv.APPDATA).toBe("/tmp/custom-appdata");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("honours CLAUDE_CONFIG_DIR injected through the EnvSource", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CLAUDE_EXECUTABLE: "claude",
        CLAUDE_CONFIG_DIR: "/tmp/custom-main-claude-config",
      });

      expect((result.bridge as any).adapter.childEnv.CLAUDE_CONFIG_DIR).toBe("/tmp/custom-main-claude-config");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not create an engine-home for Codex instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const authPath = path.join(root, ".codex", "auth.json");
    const configTomlPath = path.join(root, ".codex", "config.toml");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.dirname(authPath), { recursive: true });
      await writeFile(authPath, '{"access_token":"shared-token"}\n', "utf8");
      await writeFile(configTomlPath, 'model = "gpt-5.3-codex"\n', "utf8");

      await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      await expect(readFile(path.join(stateDir, "engine-home", "auth.json"), "utf8")).rejects.toThrow();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps using the app-server adapter when codex yolo mode is enabled", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(CodexAppServerAdapter);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses the process Codex adapter when configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ codexRuntime: "process" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessCodexAdapter);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses shared config validation when the service resolves codex runtime options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, "{bad json\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CODEX_EXECUTABLE: "codex",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(CodexAppServerAdapter);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Malformed ${configPath}`),
      );
    } finally {
      consoleErrorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("uses the Claude adapter when the instance engine is claude", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CLAUDE_EXECUTABLE: "claude",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(ClaudeStreamAdapter);
      // Claude bots no longer isolate CLAUDE_CONFIG_DIR — they share the
      // user's ~/.claude/ so OAuth refresh tokens don't race across instances.
      expect((result.bridge as any).adapter.childEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses the Antigravity process adapter when the instance engine is antigravity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "antigravity" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        ANTIGRAVITY_EXECUTABLE: "agy-test",
      });

      expect((result.bridge as any).adapter).toBeInstanceOf(ProcessAntigravityAdapter);
      expect((result.bridge as any).adapter.antigravityExecutable).toBe("agy-test");
      expect((result.bridge as any).adapter.childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses the Kimi ACP adapter and forwards its explicit executable and home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(path.join(root, ".codex", "skills", "astock"), { recursive: true });
      await writeFile(path.join(root, ".codex", "skills", "astock", "SKILL.md"), "shared skill\n", "utf8");
      await mkdir(path.join(stateDir, "workspace", ".kimi-code", "skills", "project-skill"), { recursive: true });
      await writeFile(
        path.join(stateDir, "workspace", ".kimi-code", "skills", "project-skill", "SKILL.md"),
        "project skill\n",
        "utf8",
      );
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        KIMI_EXECUTABLE: "/opt/kimi",
        KIMI_CODE_HOME: path.join(root, "kimi-home"),
      });

      const adapter = (result.bridge as any).adapter;
      expect(adapter).toBeInstanceOf(KimiAcpAdapter);
      expect(adapter.kimiExecutable).toBe("/opt/kimi");
      expect(adapter.childEnv.KIMI_CODE_HOME).toBe(path.join(root, "kimi-home"));
      expect(adapter.childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(await realpath(path.join(stateDir, "workspace", ".kimi-code", "skills", "astock")))
        .toBe(await realpath(path.join(root, ".codex", "skills", "astock")));
      expect(await readFile(
        path.join(stateDir, "workspace", ".kimi-code", "skills", "project-skill", "SKILL.md"),
        "utf8",
      )).toBe("project skill\n");
      adapter.destroy();
    } finally {
      await removeTempRoot(root);
    }
  });

  it.each(["claude", "codex"])("wires credential-gated native search for %s without starting the engine", async engine => {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-search-factory-"));
    const stateDir = path.join(root, "bot");
    try {
      await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
      for (const key of ["", "fixture-brave"]) {
        const { bridge } = await createGatewayBridgeDependencies({ HOME: root, CODEX_HOME: path.join(root, ".codex"), TAROBOT_STATE_DIR: stateDir, BRAVE_API_KEY: key, BRAVE_SEARCH_API_KEY: "", TAVILY_API_KEY: "" });
        const adapter = (bridge as any).adapter;
        expect(typeof adapter.nativeSearchMcp).toBe("function");
        const plan = adapter.nativeSearchMcp();
        if (key) { expect(plan.name).toBe("tarobot_search"); expect(plan.envKeys).toContain("BRAVE_API_KEY"); }
        else expect(plan).toBeNull();
        await adapter.destroy();
      }
    } finally { await removeTempRoot(root); }
  });

  it("keeps a new DeepSeek installation on native search without API keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "search-default-"));
    const stateDir = path.join(root, "bot");
    try {
      await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "deepseek" }));
      const { bridge } = await createGatewayBridgeDependencies({ HOME: root, CODEX_HOME: path.join(root, ".codex"), TAROBOT_STATE_DIR: stateDir, BRAVE_API_KEY: "", BRAVE_SEARCH_API_KEY: "", TAVILY_API_KEY: "" });
      const adapter = (bridge as any).adapter;
      expect(adapter.gateway.options.searchMcp).toBeUndefined();
      expect(adapter.searchMcpEnabled).toBe(false);
      await adapter.destroy();
    } finally { await removeTempRoot(root); }
  });

  it("uses the DeepSeek Harness adapter and forwards its explicit executable and shared home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "deepseek" }) + "\n", "utf8");

      const result = await createGatewayBridgeDependencies({
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: path.join(root, ".codex"),
        BRAVE_API_KEY: "fixture-brave",
        TAVILY_API_KEY: "",
        TAROCUB_INSTANCE: "alpha",
        DSH_EXECUTABLE: "/opt/dsh",
        DSH_HOME: path.join(root, "shared-dsh-home"),
      });

      const adapter = (result.bridge as any).adapter;
      expect(adapter).toBeInstanceOf(DeepSeekHarnessAdapter);
      const gateway = adapter.gateway;
      expect(gateway.executable).toBe("/opt/dsh");
      expect(gateway.options.sharedHome).toBe(path.join(root, "shared-dsh-home"));
      expect(gateway.options.childEnv.DSH_HOME).toBe(path.join(root, "shared-dsh-home"));
      expect(gateway.options.childEnv.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(gateway.options.searchMcp.command).toBeTruthy();
      expect(gateway.options.searchMcp.args).toHaveLength(1);
      expect(gateway.options.searchMcp.args[0]).toMatch(/search-mcp(?:-server)?\.(?:js|ts)$/);
      expect(gateway.options.searchMcp.cwd).toBe(path.join(stateDir, "workspace"));
      await adapter.destroy();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not create an engine-home for Claude instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");
    const globalClaudeDir = path.join(root, ".claude");
    const globalClaudeCredentialsPath = path.join(globalClaudeDir, ".credentials.json");
    const globalClaudeJsonPath = path.join(root, ".claude.json");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(globalClaudeDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(globalClaudeCredentialsPath, '{"claudeAiOauth":{"accessToken":"shared-token"}}\n', "utf8");
      await writeFile(globalClaudeJsonPath, '{"projects":{}}\n', "utf8");

      await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CLAUDE_EXECUTABLE: "claude",
      });

      // engine-home should not exist — nothing to seed anymore
      await expect(readFile(path.join(stateDir, "engine-home", ".credentials.json"), "utf8")).rejects.toThrow();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("migrates legacy engine-home/projects into ~/.claude/projects on upgrade", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");
    const legacyProjectsDir = path.join(stateDir, "engine-home", "projects");
    const legacyWorkspaceDir = path.join(legacyProjectsDir, "-tmp-alpha-workspace");
    const legacyMemoryDir = path.join(legacyWorkspaceDir, "memory");
    const targetProjectsDir = path.join(root, ".claude", "projects");

    try {
      await mkdir(stateDir, { recursive: true });
      await mkdir(legacyMemoryDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(path.join(legacyWorkspaceDir, "abc.jsonl"), '{"old":"session"}\n', "utf8");
      await writeFile(path.join(legacyMemoryDir, "MEMORY.md"), "- remembered fact\n", "utf8");

      await createGatewayBridgeDependencies({ USERPROFILE: root, TAROCUB_INSTANCE: "alpha", CLAUDE_EXECUTABLE: "claude" });

      // Files were copied into ~/.claude/projects/, preserving the workspace-keyed tree
      await expect(readFile(path.join(targetProjectsDir, "-tmp-alpha-workspace", "abc.jsonl"), "utf8"))
        .resolves.toBe('{"old":"session"}\n');
      await expect(readFile(path.join(targetProjectsDir, "-tmp-alpha-workspace", "memory", "MEMORY.md"), "utf8"))
        .resolves.toBe("- remembered fact\n");

      // Legacy engine-home renamed out of the way
      await expect(readFile(path.join(stateDir, "engine-home", "projects", "-tmp-alpha-workspace", "abc.jsonl"), "utf8"))
        .rejects.toThrow();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("migrates into CLAUDE_CONFIG_DIR when it's set, not the default home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");
    const legacyWorkspaceDir = path.join(stateDir, "engine-home", "projects", "-tmp-alpha-workspace");
    const customClaudeConfigDir = path.join(root, "custom-claude-config");

    try {
      await mkdir(legacyWorkspaceDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(path.join(legacyWorkspaceDir, "abc.jsonl"), '{"legacy":"value"}\n', "utf8");

      await createGatewayBridgeDependencies({
        USERPROFILE: root,
        TAROCUB_INSTANCE: "alpha",
        CLAUDE_EXECUTABLE: "claude",
        CLAUDE_CONFIG_DIR: customClaudeConfigDir,
      });

      // Migrated into the custom config dir, not the default ~/.claude
      await expect(readFile(path.join(customClaudeConfigDir, "projects", "-tmp-alpha-workspace", "abc.jsonl"), "utf8"))
        .resolves.toBe('{"legacy":"value"}\n');
      // The default ~/.claude/projects should not have received the file
      await expect(readFile(path.join(root, ".claude", "projects", "-tmp-alpha-workspace", "abc.jsonl"), "utf8"))
        .rejects.toThrow();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not overwrite existing files at the target during migration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const stateDir = path.join(root, ".cctb", "alpha");
    const configPath = path.join(stateDir, "config.json");
    const legacyWorkspaceDir = path.join(stateDir, "engine-home", "projects", "-tmp-alpha-workspace");
    const targetWorkspaceDir = path.join(root, ".claude", "projects", "-tmp-alpha-workspace");

    try {
      await mkdir(legacyWorkspaceDir, { recursive: true });
      await mkdir(targetWorkspaceDir, { recursive: true });
      await writeFile(configPath, JSON.stringify({ engine: "claude" }) + "\n", "utf8");
      await writeFile(path.join(legacyWorkspaceDir, "abc.jsonl"), '{"legacy":"value"}\n', "utf8");
      await writeFile(path.join(targetWorkspaceDir, "abc.jsonl"), '{"existing":"value"}\n', "utf8");

      await createGatewayBridgeDependencies({ USERPROFILE: root, TAROCUB_INSTANCE: "alpha", CLAUDE_EXECUTABLE: "claude" });

      // Existing file was NOT clobbered by the legacy copy
      await expect(readFile(path.join(targetWorkspaceDir, "abc.jsonl"), "utf8"))
        .resolves.toBe('{"existing":"value"}\n');
    } finally {
      await removeTempRoot(root);
    }
  });
});
