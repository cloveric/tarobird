import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { expect, it } from "vitest";
const exec = promisify(execFile);

it.each([["scripts/search-mcp.mjs"], ["dist/src/index.js", "search-mcp"]])("starts MCP %j from any cwd with private config and no secret output", async (...entry) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "integration-mcp-"));
  try {
    await mkdir(path.join(home, ".tarobot"));
    await writeFile(path.join(home, ".tarobot/integrations.env"), "BRAVE_API_KEY=PRIVATE_BRAVE_FIXTURE\nTAVILY_API_KEY=PRIVATE_TAVILY_FIXTURE\n");
    const child = spawn(process.execPath, [path.resolve(entry[0]!), ...entry.slice(1)], { cwd: home, env: { HOME: home, PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    const closed = once(child, "close");
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "provider_status", arguments: {} } }) + "\n");
      const deadline = Date.now() + 5000;
      while (stdout.trim().split("\n").length < 3 && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 20));
      const messages = stdout.trim().split("\n").map(line => JSON.parse(line));
      expect(messages.find(m => m.id === 1).result.protocolVersion).toBe("2025-11-25");
      expect(messages.find(m => m.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["web_search", "web_extract", "provider_status"]));
      const status = JSON.parse(messages.find(m => m.id === 3).result.content[0].text);
      expect(status.providers.brave.configured).toBe(true); expect(status.providers.tavily.configured).toBe(true);
      expect(stdout + stderr).not.toContain("PRIVATE_");
    } finally { child.kill("SIGTERM"); await closed; }
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("reports prerequisites without exposing env values or reading cloud credential contents", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "integration-doctor-"));
  try {
    await mkdir(path.join(home, ".tarobot")); const cloud = path.join(home, "cloud"); await mkdir(cloud);
    await writeFile(path.join(cloud, ".env.local"), "CLOUD_SECRET_FIXTURE");
    await writeFile(path.join(home, ".tarobot/integrations.env"), `BRAVE_API_KEY=PRIVATE_BRAVE_FIXTURE\nASR_HTTP_URL=\nTINGWU_ASR_DIR=${cloud}\n`);
    const { stdout, stderr } = await exec(process.execPath, [path.resolve("scripts/check-integrations.mjs")], { cwd: home, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    const result = JSON.parse(stdout);
    expect(result.search.braveConfigured).toBe(true); expect(result.localAsr.http).toBe("disabled");
    expect(result.longAsr).toMatchObject({ configured: true, adapterPresent: false, credentialFilePresent: true, providerCalls: "not_run" });
    for (const value of ["PRIVATE_BRAVE_FIXTURE", "CLOUD_SECRET_FIXTURE", cloud]) expect(stdout + stderr).not.toContain(value);
  } finally { await rm(home, { recursive: true, force: true }); }
});
