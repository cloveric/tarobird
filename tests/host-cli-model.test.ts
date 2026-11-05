import { it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runHostCli } from "../src/host-cli/cli.js";
import { HostManagement } from "../src/host-cli/management.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { kimiModelConfig } from "./fixtures/kimi-model-config.js";

it("CLI lists native Kimi models and resets effort without replacing sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-kimi-cli-"));
  vi.stubEnv("KIMI_CODE_HOME", root); await writeFile(path.join(root, "config.toml"), kimiModelConfig);
  await initializeHost(root, "Kimi fixture");
  const hub = await HubServer.start({ stateDir: root }), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", effort: "max" }));
  await writeFile(path.join(stateDir, "session.json"), "preserved-session");
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["bot", "Kimi", hashSecret(secret)]);
  const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })) };
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "kimi", effort: "max", runtime: createCoreServiceRuntime(), bridge });
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const local = await LocalHostClient.connect(root, { enroll: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const cli = (args: string[]) => runHostCli(["bots", "model", "bot", ...args, "--state-dir", root, "--json"]);
  try {
    await cli([]); const before = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(before).toMatchObject({ engine: "kimi", model: "", effort: "max", choices: [{ id: "", label: "K3.1 Pro" }, {}, {}, { efforts: [""] }] });
    await cli(["--model", "kimi-code/k3.1-pro", "--revision", before.revision]);
    const pinned = JSON.parse(log.mock.calls.at(-1)![0] as string); expect(pinned.effort).toBe("max");
    await cli(["--model", "default", "--effort", "default", "--revision", pinned.revision]);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ model: "", effort: "" });
    expect(await readFile(path.join(stateDir, "session.json"), "utf8")).toBe("preserved-session");
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  } finally { log.mockRestore(); local.close(); await gateway.disconnect(); await control(); await hub.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("CLI and App share authenticated model updates, scope, conflicts and permission checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-model-cli-"));
  await initializeHost(root, "Model fixture");
  const hub = await HubServer.start({ stateDir: root });
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-5.6-sol", effort: "high", workspacePath: "/unchanged" }));
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", ["bot", "Test", hashSecret(secret)]);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,model) VALUES('other','Other','unused','unchanged-model')");
  let engineCalls = 0;
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "codex", model: "gpt-5.6-sol", effort: "high", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => { engineCalls++; return { text: "unused" }; } } });
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const local = await LocalHostClient.connect(root, { enroll: true }), management = new HostManagement(local);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const cli = (args: string[]) => runHostCli(["bots", "model", "bot", ...args, "--state-dir", root, "--json"]);
  try {
    await cli([]); const before = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(before).toMatchObject({ engine: "codex", model: "gpt-5.6-sol", effort: "high" });
    expect(before.choices.some((choice: { id: string }) => choice.id === "gpt-6.1-sol")).toBe(true);
    await expect(cli(["--model", "gpt-6.1-sol"])).rejects.toThrow("--revision");
    await expect(cli(["--effort", "low"])).rejects.toThrow("--model");
    await cli(["--model", "gpt-6.1-sol", "--effort", "ultra", "--revision", before.revision]);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ model: "gpt-6.1-sol", effort: "ultra" });
    await expect(management.botModel("bot", { model: "gpt-6-luna", revision: before.revision })).rejects.toThrow("model_conflict");
    const current = await management.botModel("bot");
    await expect(management.botModel("bot", { model: "gpt-6-luna", revision: current.revision })).rejects.toThrow("model_effort_incompatible");
    await cli(["--model", "default", "--effort", "default", "--revision", current.revision]);
    expect(await management.botModel("bot")).toMatchObject({ model: "", effort: "" });
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toMatchObject({ engine: "codex", workspacePath: "/unchanged" });
    expect((await hub.store.bots("owner")).find(bot => bot.id === "other")?.model).toBe("unchanged-model");
    expect((await fetch(`${hub.url}/api/bots/bot/model`)).status).toBe(401);
    await expect(management.botModel("missing")).rejects.toThrow("bot_forbidden");
    await expect(management.botModel("other")).rejects.toThrow("bot_offline");
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(management.botModel("bot")).rejects.toThrow();
    await expect(management.botModel("bot", { revision: current.revision, model: "gpt-6.1-sol" })).rejects.toThrow();
    expect(engineCalls).toBe(0); expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
  } finally { log.mockRestore(); local.close(); await gateway.disconnect(); await control(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
