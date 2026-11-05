import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readBotCapabilities } from "../src/runtime/bot-capabilities.js";
import { botCapabilitiesSchema } from "../src/client-protocol/capabilities.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function save(file: string, text: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
async function fixture(engine = "codex") {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-capabilities-")); roots.push(root);
  const stateDir = path.join(root, "bot"), workspace = path.join(stateDir, "workspace"), home = path.join(root, "home");
  await save(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
  return { root, stateDir, workspace, home, env: { HOME: home } };
}
const skill = (name: string) => `---\nname: ${name}\ndescription: |\n  A useful workflow\n  token=fixture-secret\n---\nPRIVATE BODY NEVER RETURNED\n`;
it("reads real TOML including quoted names, disables skills, deduplicates symlinks and excludes secrets", async () => {
  const f = await fixture(), codex = path.join(f.home, ".codex"), skillPath = path.join(codex, "skills", "first", "SKILL.md");
  const config = `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false\n[mcp_servers."server.with.dot"]\ncommand = "sh"\nargs = ["secret-argument"]\nenabled = false\n[mcp_servers.remote]\nurl = "https://user:password@example.test/secret?token=secret-query"\nhttp_headers = { Authorization = "Bearer fixture-secret" }`;
  await save(path.join(codex, "config.toml"), config); await save(skillPath, skill("analysis"));
  await mkdir(path.join(f.workspace, ".agents"), { recursive: true }); await symlink(path.join(codex, "skills"), path.join(f.workspace, ".agents/skills"));
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.entries).toHaveLength(3); expect(result.entries.find((r) => r.kind === "skill")).toMatchObject({ name: "analysis", status: "disabled" });
  expect(result.entries.find((r) => r.name === "server.with.dot")).toMatchObject({ status: "disabled", transport: "stdio" });
  const text = JSON.stringify(result); for (const secret of ["fixture-secret", "secret-argument", "secret-query", "password", "PRIVATE BODY"]) expect(text).not.toContain(secret);
  expect(await readFile(path.join(codex, "config.toml"), "utf8")).toBe(config);
  expect(result).toMatchObject({ runtime: "unverified", coverage: "partial" });
});
it("preserves per-workspace Claude sources and disabled plugin configuration without importing other Bot projects", async () => {
  const f = await fixture("claude"), plugin = path.join(f.root, "plugin");
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { shared: { command: "node", env: { TOKEN: "fixture-secret" } } }, projects: { [f.workspace]: { mcpServers: { local: { type: "http", url: "private" } } }, "/other-bot": { mcpServers: { forbidden: { command: "no" } } } } }));
  await save(path.join(f.workspace, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "node" } } }));
  await save(path.join(f.home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "sample@local": false }, disabledMcpjsonServers: ["project"] }));
  await save(path.join(f.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "sample@local": [{ installPath: plugin }] } }));
  await save(path.join(plugin, "skills/report/SKILL.md"), skill("report")); await save(path.join(plugin, ".mcp.json"), JSON.stringify({ pluginTool: { command: "node" } }));
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.entries.map((r) => r.name)).toEqual(["local", "pluginTool", "project", "report", "shared"]);
  expect(result.entries.filter((r) => r.status === "disabled").map((r) => r.name)).toEqual(["pluginTool", "project", "report"]);
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});
it.each(["kimi", "antigravity"])("uses %s native configuration paths and does not mix other engine configs", async (engine) => {
  const f = await fixture(engine), relative = engine === "kimi" ? ".kimi-code/mcp.json" : ".agents/mcp_config.json";
  await save(path.join(f.workspace, relative), JSON.stringify({ mcpServers: { workspaceTool: { serverUrl: "https://private/secret", disabled: true } } }));
  await save(path.join(f.workspace, ".agents/skills/task/SKILL.md"), skill("task"));
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { wrongEngine: { command: "node" } } }));
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.entries.find((r) => r.name === "workspaceTool")).toMatchObject({ status: "disabled", scope: "workspace" });
  expect(result.entries.find((r) => r.name === "task")?.kind).toBe("skill"); expect(result.entries.some((r) => r.name === "wrongEngine")).toBe(false);
  expect(result.entries.some((r) => r.name === "cctb_search")).toBe(false);
});
it("does not evaluate Harness patches or claim a complete MCP catalog", async () => {
  const f = await fixture("deepseek"); await save(path.join(f.stateDir, "dsh-home/cordis.patch.yml"), "- insert: !!js throw new Error('must not run')");
  await save(path.join(f.workspace, ".dsh/skills/local/SKILL.md"), skill("local"));
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.warnings).toContain("deepseek_dynamic_config"); expect(result.entries.map((r) => r.name)).toEqual(["local"]);
});
it("keeps offline reads within the registered Bot, handles corrupt/oversized files, and never repairs state", async () => {
  const f = await fixture(); await save(path.join(f.home, ".codex/config.toml"), '[mcp_servers.private]\ncommand="node"');
  await save(path.join(f.workspace, ".agents/skills/local/SKILL.md"), skill("local"));
  const offline = await readBotCapabilities(f.stateDir, { env: f.env, offline: true }); expect(offline.entries.map((r) => r.name)).toEqual(["local"]); expect(offline.warnings).toContain("offline_workspace_only");
  await save(path.join(f.workspace, ".codex/config.toml"), "x".repeat(2 * 1024 * 1024 + 1));
  expect((await readBotCapabilities(f.stateDir, { env: f.env })).sources.find((r) => r.source === "workspace/.codex/config.toml")?.status).toBe("unreadable");
  await save(path.join(f.stateDir, "config.json"), "{bad"); const broken = await readBotCapabilities(f.stateDir, { env: f.env }); expect(broken.engine).toBe(null); expect(broken.warnings).toContain("config_unreadable"); expect(await readFile(path.join(f.stateDir, "config.json"), "utf8")).toBe("{bad");
});
it.each(["null", "[]", "true", "42", '"codex"'])("does not infer a Codex inventory from a non-object Bot config: %s", async (config) => {
  const f = await fixture();
  await save(path.join(f.home, ".codex/config.toml"), '[mcp_servers.unrelated]\ncommand="node"');
  await save(path.join(f.stateDir, "config.json"), config);
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.engine).toBeNull(); expect(result.workspace).toBeNull();
  expect(result.entries).toEqual([]); expect(result.warnings).toContain("config_unreadable");
  expect(result.sources[0]?.status).toBe("unreadable");
});
async function token(hub: HubServer, id: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner", userId); const challenge = await hub.auth.challenge(id, id, nonce, id);
  return (await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
}
it("serves only paired owners, rejects client paths and revocation, and reads managed offline Bot scope", async () => {
  const f = await fixture("antigravity"), hub = await HubServer.start({ stateDir: path.join(f.root, "hub"), managedBots: { entrypoint: "unused" } }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir: f.stateDir, botId: "alpha", secret, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  try {
    const owner = await token(hub, "desktop"), phone = await token(hub, "phone"); await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest = await token(hub, "guest", "guest");
    const get = (auth: string, endpoint = "/api/bots/alpha/capabilities") => fetch(hub.url + endpoint, { headers: { Authorization: `Bearer ${auth}` } });
    expect((await get("")).status).toBe(401); expect((await get(guest)).status).toBe(403);
    expect(botCapabilitiesSchema.parse(await (await get(owner)).json()).engine).toBe("antigravity");
    expect((await get(owner, "/api/bots/unknown/capabilities")).status).toBe(403); expect((await get(owner, "/api/bots/alpha/capabilities?path=/private")).status).toBe(400);
    await hub.auth.revoke("phone", "local-owner"); expect((await get(phone)).status).toBe(401);
    await channel.disconnect(); expect((await get(owner)).status).toBe(503);
    await hub.store.db.run("INSERT INTO managed_bots VALUES('alpha','owner','fixture','{}')");
    await save(path.join(f.root, "hub/bots/alpha/config.json"), '{"engine":"codex"}');
    expect(botCapabilitiesSchema.parse(await (await get(owner)).json()).warnings).toContain("offline_workspace_only");
  } finally { await channel.disconnect(); await hub.close(); }
}, 20000);
it("matches physical Claude project keys and deduplicates shared plugin registrations", async () => {
  const f = await fixture("claude"), physical = path.join(f.root, "physical"), linked = path.join(f.root, "linked"), plugin = path.join(f.root, "plugin");
  await mkdir(physical); await symlink(physical, linked); await save(path.join(f.stateDir, "config.json"), JSON.stringify({ engine: "claude", workspacePath: linked }));
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { shared: { command: "node" } }, projects: { [physical]: { disabledMcpServers: ["shared"], mcpServers: { local: { command: "node" } } } } }));
  await save(path.join(f.home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ plugins: { "fixture@local": [{ installPath: plugin, scope: "user" }, { installPath: plugin, scope: "project", projectPath: physical }] } }));
  await save(path.join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { pluginServer: { command: "node" } } }));
  const result = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(result.entries.filter((r) => r.name === "pluginServer")).toHaveLength(1); expect(result.entries.find((r) => r.name === "shared")?.status).toBe("disabled"); expect(result.entries.some((r) => r.name === "local")).toBe(true);
});
it("reads large Claude metadata without disclosing unrelated contents, and labels private Harness skills", async () => {
  const f = await fixture("claude");
  await save(path.join(f.home, ".claude.json"), JSON.stringify({ unrelated: "x".repeat(3 * 1024 * 1024), mcpServers: { tool: { command: "node" } } }));
  const result = await readBotCapabilities(f.stateDir, { env: f.env }); expect(result.entries.map((row) => row.name)).toEqual(["tool"]); expect(JSON.stringify(result).length).toBeLessThan(8000);
  await save(path.join(f.stateDir, "config.json"), '{"engine":"deepseek"}'); await save(path.join(f.stateDir, "dsh-home/skills/private/SKILL.md"), skill("private"));
  expect((await readBotCapabilities(f.stateDir, { env: f.env, offline: true })).entries[0]).toMatchObject({ name: "private", scope: "bot" });
});

it.each(["kimi", "deepseek", "claude", "codex"])("shows %s managed search only with configured private credentials", async (engine) => {
  const f = await fixture(engine);
  await save(path.join(f.home, ".tarobot/integrations.env"), "BRAVE_API_KEY=PRIVATE_SEARCH_FIXTURE\n");
  const name = engine === "claude" || engine === "codex" ? "tarobot_search" : "cctb_search";
  const enabled = await readBotCapabilities(f.stateDir, { env: f.env });
  expect(enabled.entries.find(row => row.name === name)).toMatchObject({ status: "configured" });
  expect(JSON.stringify(enabled)).not.toContain("PRIVATE_SEARCH_FIXTURE");
  await save(path.join(f.stateDir, "bot.env"), "BRAVE_API_KEY=\n");
  expect((await readBotCapabilities(f.stateDir, { env: f.env, offline: true })).entries.some(row => row.name === name)).toBe(false);
  expect((await readBotCapabilities(f.stateDir, { env: f.env })).entries.some(row => row.name === name)).toBe(false);
});

it.each(["claude", "codex"])("does not advertise %s managed search over a working or disabled native registration", async engine => {
  const f = await fixture(engine);
  await save(path.join(f.stateDir, "bot.env"), "BRAVE_API_KEY=PRIVATE_CATALOG_FIXTURE\n");
  const config = engine === "claude" ? path.join(f.workspace, ".mcp.json") : path.join(f.workspace, ".codex/config.toml");
  for (const disabled of [false, true]) {
    await save(config, engine === "claude"
      ? JSON.stringify({ mcpServers: { web_search: { command: "search-cli", disabled } } })
      : `[mcp_servers.web_search]\ncommand = "search-cli"\nenabled = ${!disabled}\n`);
    const result = await readBotCapabilities(f.stateDir, { env: f.env });
    expect(result.entries.some(row => row.name === "tarobot_search")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CATALOG_FIXTURE");
  }
});
