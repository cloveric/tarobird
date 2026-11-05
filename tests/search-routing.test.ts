import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSearchRouting } from "../src/runtime/search-routing.js";
import { resolveDefaultKimiMcpServers } from "../src/codex/kimi-acp-adapter.js";
import { loadGatewayEnvironment } from "../src/gateway/environment.js";
import { appAgentInstructions, appCapabilityInstructions } from "../src/gateway/agent-instructions.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(text = '[mcp_servers."web-search".env]\nBRAVE_API_KEY="fixture-brave"\nTAVILY_API_KEY="fixture-tavily"') {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-routing-")); roots.push(root);
  await mkdir(path.join(root, ".codex")); await writeFile(path.join(root, ".codex/config.toml"), text);
  return { HOME: root };
}
it("leaves a clean install on default search without resolving an MCP executable", async () => {
  const env = await fixture(""); const resolve = vi.fn(() => { throw new Error("must not run"); });
  expect(await resolveSearchRouting(env)).toMatchObject({ enabled: false, source: "none" });
  expect(resolveDefaultKimiMcpServers(env, resolve)).toEqual([]); expect(resolve).not.toHaveBeenCalled();
});
it("uses direct API keys and does not mutate the supplied environment", async () => {
  const env = { BRAVE_SEARCH_API_KEY: "fixture-direct", TAVILY_API_KEY: "" };
  const routing = await resolveSearchRouting(env);
  expect(routing).toMatchObject({ enabled: true, providers: { brave: true, tavily: false }, source: "env" });
  expect(env).toEqual({ BRAVE_SEARCH_API_KEY: "fixture-direct", TAVILY_API_KEY: "" });
  expect(routing.env.TAROBOT_SEARCH_CREDENTIAL_FALLBACK).toBe("0");
});
it.each(["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY"])("preserves an explicit blank %s against legacy aliases", async key => {
  const env = { ...await fixture(), [key]: " ", TAVILY_API_KEY: "" };
  expect(await resolveSearchRouting(env)).toMatchObject({ enabled: false, source: "none" });
});
it("uses missing credentials from enabled Codex registrations only", async () => {
  const env = await fixture();
  expect(await resolveSearchRouting(env)).toMatchObject({ enabled: true, source: "codex-fallback", providers: { brave: true, tavily: true } });
  const disabled = await fixture('[mcp_servers."web.search"]\nenabled=false\n[mcp_servers."web.search".env]\nBRAVE_API_KEY="disabled-fixture"');
  expect((await resolveSearchRouting(disabled)).enabled).toBe(false);
  const malformed = await fixture('not valid TOML!'); expect((await resolveSearchRouting(malformed)).enabled).toBe(false);
});
it("passes Kimi search credentials through ACP env only and degrades on missing package entry", async () => {
  const env = { ...await fixture(""), TAVILY_API_KEY: "fixture-secret" };
  const servers = resolveDefaultKimiMcpServers(env, () => ({ command: "/host/node", args: ["/host/search.js"] }));
  expect(servers).toHaveLength(1); expect(servers[0]).toMatchObject({ name: "cctb_search", env: expect.arrayContaining([{ name: "TAVILY_API_KEY", value: "fixture-secret" }, { name: "TAROBOT_SEARCH_CREDENTIAL_FALLBACK", value: "0" }]) });
  expect(JSON.stringify({ command: (servers[0] as any).command, args: (servers[0] as any).args })).not.toContain("fixture-secret");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(resolveDefaultKimiMcpServers(env, () => { throw new Error("fixture-secret"); })).toEqual([]);
  expect(warn.mock.calls.flat().join(" ")).not.toContain("fixture-secret");
});
it("prefers available configured MCP and explicitly preserves native fallback in App guidance", () => {
  for (const engine of ["codex", "claude", "kimi", "deepseek", "antigravity"] as const) {
    const standing = appAgentInstructions({ engine });
    expect(standing).toContain("Prefer configured Search MCP.");
    expect(appCapabilityInstructions("browser", { engine })).toContain("If MCP fails, use native tools");
  }
});

it("does not let an MCP-child fallback flag disable future Host workers", async () => {
  const env = { ...await fixture(), TAROBOT_SEARCH_CREDENTIAL_FALLBACK: "0" };
  const loaded = await loadGatewayEnvironment(path.join(env.HOME, "bot"), "fixture", env);
  expect(loaded.TAROBOT_SEARCH_CREDENTIAL_FALLBACK).toBeUndefined();
  expect(await resolveSearchRouting(loaded)).toMatchObject({ enabled: true, source: "codex-fallback" });
  expect((await resolveSearchRouting(env)).enabled).toBe(false);
});
