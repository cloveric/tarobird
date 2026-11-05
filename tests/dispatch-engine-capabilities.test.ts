import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBotCapabilities, readEngineCapabilities } from "../src/runtime/bot-capabilities.js";
import { botCapabilitiesSchema } from "../src/client-protocol/capabilities.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function save(file: string, text: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
async function host() {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-capabilities-")); roots.push(root);
  const home = path.join(root, "home"); await mkdir(home, { recursive: true });
  return { root, home, env: { HOME: home } as NodeJS.ProcessEnv };
}
const skill = (name: string) => `---\nname: ${name}\ndescription: |\n  A useful workflow\n  token=fixture-secret\n---\nPRIVATE BODY NEVER RETURNED\n`;
const engines = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    out.push(`${path.relative(root, file)}:${entry.isDirectory() ? "dir" : (await stat(file).catch(() => undefined))?.size ?? "link"}`);
    if (entry.isDirectory()) out.push(...(await tree(file)).map(row => `${entry.name}/${row}`));
  }
  return out.sort();
}

it.each(engines)("reports %s as a partial, unverified user-scope inventory without a Bot or workspace", async (engine) => {
  const f = await host();
  const result = await readEngineCapabilities(engine, { env: f.env });
  expect(botCapabilitiesSchema.parse(result)).toMatchObject({ engine, workspace: null, runtime: "unverified", coverage: "partial", entries: [] });
  // Missing configuration is an empty partial catalog, not an unavailable engine.
  expect(result.warnings).toEqual(engine === "deepseek" ? ["runtime_unverified", "partial_catalog", "deepseek_dynamic_config"] : ["runtime_unverified", "partial_catalog"]);
  expect(result.sources.every(row => row.status === "missing")).toBe(true);
  expect(result.sources.some(row => /^(workspace|Bot)\//.test(row.source) || row.source.includes("· workspace"))).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(/rating|rank|quality|score|price/i);
});

it("reads Codex user declarations with disabled skills and redaction, but no workspace or other Bot state", async () => {
  const f = await host(), codex = path.join(f.home, ".codex"), skillPath = path.join(codex, "skills/first/SKILL.md");
  const config = `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n[mcp_servers.remote]\nurl = "https://user:password@example.test/secret?token=secret-query"\nhttp_headers = { Authorization = "Bearer fixture-secret" }\n[mcp_servers.off]\ncommand = "sh"\nargs = ["secret-argument"]\nenabled = false`;
  await save(path.join(codex, "config.toml"), config); await save(skillPath, skill("analysis"));
  await save(path.join(f.home, ".agents/skills/shared/SKILL.md"), skill("shared"));
  // A registered Bot with its own workspace declarations must stay invisible.
  const bot = path.join(f.root, "bot"), workspace = path.join(bot, "workspace");
  await save(path.join(bot, "config.json"), JSON.stringify({ engine: "codex" }));
  await save(path.join(workspace, ".codex/config.toml"), '[mcp_servers.projectOnly]\ncommand="node"');
  await save(path.join(workspace, ".agents/skills/project/SKILL.md"), skill("projectSkill"));
  const result = await readEngineCapabilities("codex", { env: f.env });
  expect(result.entries.map(row => [row.name, row.scope, row.status])).toEqual([["analysis", "user", "disabled"], ["off", "user", "disabled"], ["remote", "user", "configured"], ["shared", "user", "discovered"]]);
  const text = JSON.stringify(result); for (const secret of ["fixture-secret", "secret-argument", "secret-query", "password", "PRIVATE BODY", "projectOnly", "projectSkill"]) expect(text).not.toContain(secret);
  expect(await readFile(path.join(codex, "config.toml"), "utf8")).toBe(config);
  // The registered Bot still sees its own workspace through the shared scanner.
  expect((await readBotCapabilities(bot, { env: f.env })).entries.map(row => row.name)).toEqual(expect.arrayContaining(["projectOnly", "projectSkill", "analysis"]));
});

it("excludes Claude project servers, project/local plugins and workspace settings from the user scope", async () => {
  const f = await host(), userPlugin = path.join(f.root, "user-plugin"), projectPlugin = path.join(f.root, "project-plugin"), localPlugin = path.join(f.root, "local-plugin"), project = path.join(f.root, "project");
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { shared: { command: "node", env: { TOKEN: "fixture-secret" } } }, projects: { [project]: { mcpServers: { projectServer: { command: "node" } }, disabledMcpServers: ["shared"] } } }));
  await save(path.join(f.home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "user@market": false } }));
  await save(path.join(project, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "user@market": true } }));
  await save(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { projectMcp: { command: "node" } } }));
  await save(path.join(project, ".claude/skills/projectSkill/SKILL.md"), skill("projectSkill"));
  await save(path.join(f.home, ".claude/skills/video/SKILL.md"), skill("video"));
  await save(path.join(f.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: {
    "user@market": [{ installPath: userPlugin, scope: "user" }],
    "project@market": [{ installPath: projectPlugin, scope: "project", projectPath: project }],
    "local@market": [{ installPath: localPlugin, scope: "local" }],
  } }));
  for (const [dir, name] of [[userPlugin, "userPluginSkill"], [projectPlugin, "projectPluginSkill"], [localPlugin, "localPluginSkill"]] as const) await save(path.join(dir, `skills/${name}/SKILL.md`), skill(name));
  await save(path.join(userPlugin, ".mcp.json"), JSON.stringify({ mcpServers: { userPluginTool: { command: "node" } } }));
  const result = await readEngineCapabilities("claude", { env: f.env });
  expect(result.entries.map(row => [row.name, row.scope, row.status])).toEqual([
    ["shared", "user", "configured"], ["userPluginSkill", "plugin", "disabled"], ["userPluginTool", "plugin", "disabled"], ["video", "user", "discovered"],
  ]);
  expect(JSON.stringify(result)).not.toMatch(/fixture-secret|PRIVATE BODY|project-plugin|local-plugin/);
});

it.each(["kimi", "antigravity"] as const)("keeps %s to its own user configuration", async (engine) => {
  const f = await host();
  const userMcp = engine === "kimi" ? ".kimi-code/mcp.json" : ".gemini/config/mcp_config.json", userSkills = engine === "kimi" ? ".kimi-code/skills" : ".gemini/antigravity-cli/skills";
  await save(path.join(f.home, userMcp), JSON.stringify({ mcpServers: { userTool: { serverUrl: "https://private/secret" }, offTool: { command: "x", disabled: true } } }));
  await save(path.join(f.home, userSkills, "task/SKILL.md"), skill("task"));
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { wrongEngine: { command: "node" } } }));
  const result = await readEngineCapabilities(engine, { env: f.env });
  expect(result.entries.find(row => row.name === "userTool")).toMatchObject({ scope: "user", status: "configured", transport: "http" });
  expect(result.entries.find(row => row.name === "offTool")?.status).toBe("disabled");
  expect(result.entries.find(row => row.name === "task")).toMatchObject({ kind: "skill", scope: "user" });
  expect(result.entries.some(row => row.name === "wrongEngine")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private/secret");
});

it("does not guess DeepSeek Harness state or claim managed search from Host credentials", async () => {
  const f = await host();
  await save(path.join(f.home, ".tarobot/integrations.env"), "BRAVE_API_KEY=PRIVATE_SEARCH_FIXTURE\n");
  await save(path.join(f.home, ".codex/config.toml"), "");
  for (const engine of ["kimi", "deepseek", "claude", "codex"] as const) {
    const result = await readEngineCapabilities(engine, { env: f.env });
    expect(result.entries.some(row => row.scope === "bridge" || ["tarobot_search", "cctb_search"].includes(row.name))).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SEARCH_FIXTURE");
    if (engine === "deepseek") { expect(result.warnings).toContain("deepseek_dynamic_config"); expect(result.entries).toEqual([]); expect(result.sources).toEqual([]); }
  }
});

it("handles FIFO, oversized and symlinked user files safely without creating or changing anything", async () => {
  const f = await host(), skills = path.join(f.home, ".codex/skills");
  await save(path.join(skills, "real/SKILL.md"), skill("real"));
  await mkdir(path.join(f.home, ".agents"), { recursive: true }); await symlink(skills, path.join(f.home, ".agents/skills"));
  await save(path.join(f.home, ".codex/config.toml"), "x".repeat(2 * 1024 * 1024 + 1));
  if (process.platform !== "win32") { await mkdir(path.join(skills, "pipe"), { recursive: true }); execFileSync("mkfifo", [path.join(skills, "pipe/SKILL.md")]); }
  const before = await tree(f.root);
  const result = await readEngineCapabilities("codex", { env: f.env });
  expect(result.entries.map(row => row.name)).toEqual(["real"]);
  expect(result.sources.find(row => row.source === "$CODEX_HOME/config.toml")?.status).toBe("unreadable");
  for (const engine of engines) await readEngineCapabilities(engine, { env: f.env });
  expect(await tree(f.root)).toEqual(before);
}, 15000);

it("rejects an unknown engine instead of scanning a default", async () => {
  const f = await host();
  await expect(readEngineCapabilities("other" as never, { env: f.env })).rejects.toThrow("unknown_engine");
});
