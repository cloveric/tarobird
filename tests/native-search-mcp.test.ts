import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import * as processTree from "../src/codex/process-tree.js";
import {
  claudeManagedSearchServers,
  codexManagedSearchCliOverrides,
  codexManagedSearchConfig,
  collectClaudeSearchMcpEntries,
  createNativeSearchMcpPlanner,
  MANAGED_SEARCH_MCP_NAME,
  searchMcpBlocksManaged,
  type NativeSearchMcpPlan,
} from "../src/runtime/native-search-mcp.js";
import { removeTempRoot } from "./helpers/temp-files.js";

// Synthetic values only; every fixture uses a temporary HOME and CODEX_HOME.
const BRAVE = "fake-brave-value-123";
const TAVILY = "fake-tavily-value-456";
const INVOCATION = { command: "/opt/tarobot/node", args: ["/opt/tarobot/dist/deepseek-harness-plugin/src/search-mcp-server.js"] };
const roots: string[] = [];
// An existing script path stands in for a working registration.
const LIVE_ENTRY = path.resolve("tests/native-search-mcp.test.ts");

async function tempHome(): Promise<{ home: string; workspace: string; env: NodeJS.ProcessEnv }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-search-"));
  roots.push(home);
  const workspace = path.join(home, "workspace");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  return { home, workspace, env: { HOME: home, CODEX_HOME: path.join(home, ".codex") } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const plan = (overrides: Partial<NativeSearchMcpPlan> = {}): NativeSearchMcpPlan => ({
  name: MANAGED_SEARCH_MCP_NAME,
  ...INVOCATION,
  envKeys: ["BRAVE_API_KEY", "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"],
  processEnv: {},
  ...overrides,
});
const noValues = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text.includes(BRAVE)).toBe(false);
  expect(text.includes(TAVILY)).toBe(false);
};

describe("native search MCP planner", () => {
  it("keeps the native default without effective credentials", async () => {
    const { env } = await tempHome();
    expect(createNativeSearchMcpPlanner(env, () => INVOCATION)()).toBeNull();
    expect(createNativeSearchMcpPlanner({ ...env, BRAVE_API_KEY: "", TAVILY_API_KEY: "" }, () => INVOCATION)()).toBeNull();
  });

  it("plans the current package entrypoint with variable names, not values", async () => {
    const { env } = await tempHome();
    const planned = createNativeSearchMcpPlanner({ ...env, BRAVE_API_KEY: BRAVE, TAROBOT_SEARCH_CREDENTIAL_FALLBACK: "0" }, () => INVOCATION)();
    expect(planned).toEqual({ name: "tarobot_search", ...INVOCATION, envKeys: ["BRAVE_API_KEY", "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"], processEnv: {} });
    noValues({ ...planned, processEnv: undefined });
  });

  it("supplies only resolved values the engine env lacks, and honors an explicit blank", async () => {
    const { home, env } = await tempHome();
    await writeFile(path.join(home, ".codex/config.toml"), `[mcp_servers.legacy.env]\nTAVILY_API_KEY = "${TAVILY}"\n`);
    const planned = createNativeSearchMcpPlanner(env, () => INVOCATION)();
    expect(planned?.envKeys).toEqual(["TAVILY_API_KEY", "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"]);
    expect(Object.keys(planned?.processEnv ?? {})).toEqual(["TAVILY_API_KEY", "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"]);
    noValues([planned?.command, planned?.args, planned?.envKeys]);
    expect(createNativeSearchMcpPlanner({ ...env, TAVILY_API_KEY: "" }, () => INVOCATION)()).toBeNull();
  });

  it("returns no plan instead of failing the Bot when the entrypoint is missing", async () => {
    const { env } = await tempHome();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const planner = createNativeSearchMcpPlanner({ ...env, BRAVE_API_KEY: BRAVE }, () => { throw new Error("missing"); });
    expect(planner()).toBeNull();
    expect(planner()).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    noValues(error.mock.calls);
  });
});

describe("same-purpose registrations", () => {
  const existing = (name: string, server: Record<string, unknown>, disabled = false) => [{ name, server, disabled }];

  it("keeps a working or disabled user search MCP and supplements only a broken one", async () => {
    const { home } = await tempHome();
    const script = path.join(home, "search-mcp.mjs");
    await writeFile(script, "");
    expect(searchMcpBlocksManaged(existing("web-search", { command: "node", args: [script] }))).toBe(true);
    expect(searchMcpBlocksManaged(existing("research", { command: "node", args: [LIVE_ENTRY, "search-mcp"] }))).toBe(true);
    expect(searchMcpBlocksManaged(existing("tavily", { command: "npx", args: ["-y", "tavily-mcp"] }))).toBe(true);
    expect(searchMcpBlocksManaged(existing("web-search", { command: "node", args: [script], enabled: false }))).toBe(true);
    expect(searchMcpBlocksManaged(existing("cctb_search", {}, true))).toBe(true);
    expect(searchMcpBlocksManaged(existing("web-search", { command: "node", args: [path.join(home, "moved/dist/src/index.js"), "search-mcp"] }))).toBe(false);
    expect(searchMcpBlocksManaged(existing("filesystem", { command: "fs-mcp" }))).toBe(false);
  });

  it("reads Claude user, local, project and same-workspace plugin sources only", async () => {
    const { home, workspace, env } = await tempHome();
    const otherPlugin = path.join(home, "plugins/other"), ownPlugin = path.join(home, "plugins/own");
    await mkdir(path.join(otherPlugin, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(ownPlugin, ".claude-plugin"), { recursive: true });
    await writeFile(path.join(otherPlugin, ".mcp.json"), JSON.stringify({ mcpServers: { tavily: { command: "npx", args: ["tavily-mcp"] } } }));
    await writeFile(path.join(ownPlugin, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "fs-mcp" } } }));
    await mkdir(path.join(home, ".claude/plugins"), { recursive: true });
    await writeFile(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: {
      other: [{ installPath: otherPlugin, scope: "project", projectPath: path.join(home, "elsewhere") }],
      own: [{ installPath: ownPlugin, scope: "user" }],
    } }));
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { files: { command: "fs-mcp" } }, projects: { [workspace]: { disabledMcpServers: [] } } }));
    expect(searchMcpBlocksManaged(await collectClaudeSearchMcpEntries(env, workspace))).toBe(false);

    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ projects: { [workspace]: { disabledMcpServers: ["tarobot_search"] } } }));
    expect(searchMcpBlocksManaged(await collectClaudeSearchMcpEntries(env, workspace))).toBe(true);

    await writeFile(path.join(home, ".claude.json"), JSON.stringify({}));
    await writeFile(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { "web-search": { command: "node", args: [LIVE_ENTRY, "search-mcp"] } } }));
    expect(searchMcpBlocksManaged(await collectClaudeSearchMcpEntries(env, workspace))).toBe(true);
  });

  it("builds a Claude entry whose values come from Claude's own ${VAR:-} expansion", async () => {
    const { workspace, env } = await tempHome();
    const servers = await claudeManagedSearchServers(plan(), { ...env, BRAVE_API_KEY: BRAVE }, workspace);
    expect(servers).toEqual({ tarobot_search: { type: "stdio", ...INVOCATION, env: { BRAVE_API_KEY: "${BRAVE_API_KEY:-}", TAROBOT_SEARCH_CREDENTIAL_FALLBACK: "0" } } });
    noValues(servers);
  });

  it("does not add a Claude server when its configuration cannot be read", async () => {
    const { home, workspace, env } = await tempHome();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeFile(path.join(home, ".claude.json"), "{not json");
    await expect(claudeManagedSearchServers(plan(), env, workspace)).resolves.toBeNull();
    await expect(claudeManagedSearchServers(null, env, workspace)).resolves.toBeNull();
  });

  it("expresses Codex servers as flat keys and env_vars names", () => {
    expect(codexManagedSearchConfig(plan())).toEqual({
      "mcp_servers.tarobot_search.command": INVOCATION.command,
      "mcp_servers.tarobot_search.args": INVOCATION.args,
      "mcp_servers.tarobot_search.env_vars": ["BRAVE_API_KEY", "TAROBOT_SEARCH_CREDENTIAL_FALLBACK"],
    });
    expect(codexManagedSearchCliOverrides(plan())).toEqual([
      "-c", `mcp_servers.tarobot_search.command=${JSON.stringify(INVOCATION.command)}`,
      "-c", `mcp_servers.tarobot_search.args=${JSON.stringify(INVOCATION.args)}`,
      "-c", 'mcp_servers.tarobot_search.env_vars=["BRAVE_API_KEY","TAROBOT_SEARCH_CREDENTIAL_FALLBACK"]',
    ]);
  });
});

class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeWritable {
  lines: string[] = [];
  writes: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk.toString());
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
  end() {}
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable(); stdout = new FakeStream(); stderr = new FakeStream();
  pid = 4242;
  kill() { return true; }
  close(code: number | null) { this.emit("close", code); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

describe("Codex app-server managed search", () => {
  function harness(planner: (() => NativeSearchMcpPlan | null) | undefined, env: NodeJS.ProcessEnv = { HOME: "/nonexistent" }) {
    const children: FakeChild[] = [];
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => { const child = new FakeChild(); children.push(child); spawned.push(options); return child; };
    const adapter = new CodexAppServerAdapter("codex", "/tmp/search-fixture", env, spawnFn as never, undefined, undefined, undefined, undefined, undefined, undefined, planner ? { nativeSearchMcp: planner } : {});
    const frames = () => (children.at(-1)?.stdin.lines ?? []).map((line) => JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> });
    const requests = (method: string) => frames().filter((frame) => frame.method === method);
    const respond = async (method: string, result: unknown, nth = 1) => {
      await waitFor(() => requests(method).length >= nth);
      children.at(-1)!.stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, result }) + "\n");
    };
    const emit = (method: string, params: Record<string, unknown>) => children.at(-1)!.stdout.emitData(JSON.stringify({ method, params }) + "\n");
    return { adapter, spawned, requests, respond, emit };
  }

  async function newThread(h: ReturnType<typeof harness>, configRead: unknown) {
    const turn = h.adapter.sendUserMessage("tarobot-1", { text: "hi", files: [] });
    await h.respond("initialize", {});
    if (configRead !== undefined) await h.respond("config/read", configRead);
    await h.respond("thread/start", { thread: { id: "thread-1" } });
    await h.respond("turn/start", { turn: { id: "turn-1" } });
    h.emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] } });
    await turn;
    return h.requests("thread/start")[0]!.params!;
  }

  it("adds the server per thread and gives values only to the app-server env", async () => {
    const h = harness(() => plan({ processEnv: { BRAVE_API_KEY: BRAVE } }));
    try {
      const params = await newThread(h, { config: { mcp_servers: { fs: { command: "fs-mcp" } } } });
      expect(params.config).toEqual(codexManagedSearchConfig(plan()));
      noValues(h.requests("thread/start"));
      expect(h.spawned[0]!.env?.BRAVE_API_KEY).toBe(BRAVE);
    } finally { h.adapter.destroy(); }
  });

  it("respects an existing, disabled or unreadable search configuration", async () => {
    for (const read of [
      { config: { mcp_servers: { "web-search": { command: "node", args: [LIVE_ENTRY, "search-mcp"] } } } },
      { config: { mcp_servers: { tavily: { command: "npx", args: ["tavily-mcp"], enabled: false } } } },
      { config: null },
      null,
      { config: { mcp_servers: [] } },
    ]) {
      const h = harness(() => plan());
      try {
        expect(await newThread(h, read)).not.toHaveProperty("config");
      } finally { h.adapter.destroy(); }
    }
  });

  it("neither reads configuration nor adds a server without credentials", async () => {
    const h = harness(() => null);
    try {
      expect(await newThread(h, undefined)).not.toHaveProperty("config");
      expect(h.requests("config/read")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });

  it("checks the requested workspace's disabled search policy when resuming", async () => {
    const h = harness(() => plan());
    try {
      const turn = h.adapter.sendUserMessage("project-thread", { text: "hi", files: [], workspaceOverride: "/tmp/search-other-workspace" });
      await h.respond("initialize", {});
      await h.respond("config/read", { config: { mcp_servers: { "web-search": { enabled: false } } } });
      expect(h.requests("config/read")[0]!.params!.cwd).toBe("/tmp/search-other-workspace");
      await h.respond("thread/resume", { thread: { id: "project-thread" } });
      expect(h.requests("thread/resume")[0]!.params).not.toHaveProperty("config");
      await h.respond("turn/start", { turn: { id: "turn-1" } });
      h.emit("turn/completed", { threadId: "project-thread", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] } });
      await turn;
    } finally { h.adapter.destroy(); }
  });

  it("adds the server on resume and keeps it out of restricted sides", async () => {
    const h = harness(() => plan());
    try {
      const turn = h.adapter.sendUserMessage("parent-thread", { text: "hi", files: [] });
      await h.respond("initialize", {});
      await h.respond("config/read", { config: {} });
      await h.respond("thread/resume", { thread: { id: "parent-thread" } });
      expect(h.requests("thread/resume")[0]!.params!.config).toEqual(codexManagedSearchConfig(plan()));
      await h.respond("turn/start", { turn: { id: "turn-1" } });
      h.emit("turn/completed", { threadId: "parent-thread", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] } });
      await turn;

      const restricted = h.adapter.openSideSession({ sourceSessionId: "parent-thread" });
      await h.respond("config/read", { config: { mcp_servers: { fs: { command: "fs-mcp" } } } }, 2);
      await h.respond("thread/fork", { thread: { id: "side-1", ephemeral: true } });
      await h.respond("thread/inject_items", {});
      await (await restricted).dispose();
      expect(h.requests("thread/fork")[0]!.params!.config).toMatchObject({
        "mcp_servers.fs.enabled": false,
        ...codexManagedSearchConfig(plan()),
        "mcp_servers.tarobot_search.enabled": false,
        web_search: "disabled",
      });

      const inherited = h.adapter.openSideSession({ sourceSessionId: "parent-thread", tools: "inherited" });
      await h.respond("thread/fork", { thread: { id: "side-2", ephemeral: true } }, 2);
      await h.respond("thread/inject_items", {}, 2);
      await (await inherited).dispose();
      const inheritedConfig = h.requests("thread/fork")[1]!.params!.config as Record<string, unknown>;
      expect(inheritedConfig).toMatchObject({ web_search: "live", ...codexManagedSearchConfig(plan()) });
      expect(inheritedConfig).not.toHaveProperty("mcp_servers.tarobot_search.enabled");
    } finally { h.adapter.destroy(); }
  });
});

describe("Codex exec managed search", () => {
  it("adds -c overrides with names only, and none when the user already has search", async () => {
    const { home, workspace, env } = await tempHome();
    const run = async () => {
      const child = new FakeChild();
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      const spawnCodex = (_command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => { calls.push({ args, env: options.env }); return child; };
      const adapter = new ProcessCodexAdapter("codex", { ...env, BRAVE_API_KEY: BRAVE }, spawnCodex as never, undefined, undefined, undefined, workspace, undefined, undefined, { nativeSearchMcp: () => plan() });
      const turn = adapter.sendUserMessage("tarobot-1", { text: "hi", files: [] });
      await waitFor(() => calls.length > 0);
      child.stdout.emitData('{"type":"thread.started","thread_id":"thread-1"}\n');
      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);
      await turn;
      return calls[0]!;
    };
    const first = await run();
    expect(first.args.join(" ")).toContain("mcp_servers.tarobot_search.env_vars=");
    noValues(first.args);
    expect(first.env?.BRAVE_API_KEY).toBe(BRAVE);

    await writeFile(path.join(home, ".codex/config.toml"), '[mcp_servers.web-search]\ncommand = "node"\nargs = ["/pkg/dist/src/index.js", "search-mcp"]\nenabled = false\n');
    expect((await run()).args.join(" ")).not.toContain("tarobot_search");
  });
});

describe("Claude managed search", () => {
  it("merges the server into the existing --mcp-config without credential values", async () => {
    vi.spyOn(processTree, "killProcessTree").mockImplementation(() => Promise.resolve());
    const { workspace, env } = await tempHome();
    const children: FakeChild[] = [];
    const configs: string[] = [];
    const spawnFn = (_command: string, args: string[]) => {
      const index = args.indexOf("--mcp-config");
      if (index >= 0) configs.push(readFileSync(args[index + 1]!, "utf8"));
      expect(args.includes("--strict-mcp-config")).toBe(false);
      const child = new FakeChild(); children.push(child); return child;
    };
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn: spawnFn as never,
      childEnv: { ...env, BRAVE_API_KEY: BRAVE, TAROBOT_SEARCH_CREDENTIAL_FALLBACK: "0" },
      workspacePath: workspace,
      taskNotificationStartGraceMs: 0,
      nativeSearchMcp: () => plan(),
    });
    try {
      const turn = adapter.sendUserMessage("claude-S", { text: "hi", files: [] });
      await waitFor(() => children.length > 0 && children[0]!.stdin.lines.length > 0);
      children[0]!.stdout.emitData(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-S" }) + "\n");
      children[0]!.stdout.emitData(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "claude-S" }) + "\n");
      await turn;
      expect(configs).toHaveLength(1);
      const servers = (JSON.parse(configs[0]!) as { mcpServers: Record<string, unknown> }).mcpServers;
      expect(servers.tarobot_search).toEqual({ type: "stdio", ...INVOCATION, env: { BRAVE_API_KEY: "${BRAVE_API_KEY:-}", TAROBOT_SEARCH_CREDENTIAL_FALLBACK: "0" } });
      noValues(configs);
    } finally { await adapter.destroy(); }
  });
});
