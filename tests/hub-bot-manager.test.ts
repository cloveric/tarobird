import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { botAvatarById } from "../src/client-protocol/bot-avatar-catalog.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { loadInstanceConfig, readValidatedConfigFile, updateInstanceConfig } from "../src/state/instance-config.js";
import { kimiModelConfig } from "./fixtures/kimi-model-config.js";

async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 8000; while (!await check()) { if (Date.now() > deadline) throw new Error("bot_not_online"); await new Promise((r) => setTimeout(r, 25)); } }
describe("client-created TaroCub instances", () => {
  let root: string, hub: HubServer, manager: BotManager;
  const spec = { requestId: "create_once", name: "研究助手", engine: "codex" as const, model: "gpt-6-astra", effort: "high" as const, workspace: "" };
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hub-bots-")); hub = await HubServer.start({ stateDir: root }); manager = new BotManager(hub.store, root, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.resolve("tests/fixtures/agy-models.mjs") } }, () => hub.instanceUrl, async () => {}); });
  afterEach(async () => { await manager.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  it("creates Kimi Bots following native defaults or preserving explicit effort", async () => {
    manager.options.env = { ...manager.options.env, KIMI_EXECUTABLE: process.execPath, KIMI_CODE_HOME: root };
    await writeFile(path.join(root, "config.toml"), kimiModelConfig);
    expect((await manager.catalog()).engines.find(engine => engine.id === "kimi")).toMatchObject({ defaultModel: "", defaultEffort: "", models: [{ id: "", label: "K3.1 Pro" }, {}, {}, { efforts: [""] }] });
    await expect(manager.create("owner", { ...spec, engine: "kimi", model: "kimi-code/kimi-for-coding-highspeed", effort: "max" })).rejects.toThrow("bot_effort_incompatible");
    for (const effort of ["", "max"] as const) {
      const bot = await manager.create("owner", { ...spec, requestId: `kimi_${effort || "default"}`, engine: "kimi", model: "", effort });
      expect((await loadInstanceConfig(path.join(root, "bots", bot.id))).effort).toBe(effort || undefined);
    }
  });
  it.each([["gpt-6.1-sol", "ultra"], ["gpt-6-sol", "ultra"], ["gpt-6-luna", "max"]] as const)("advertises and creates %s with its supported effort, retaining saved settings on restore", async (model, effort) => {
    const codex = (await manager.catalog()).engines.find(engine => engine.id === "codex")!;
    expect(codex.defaultModel).toBe("gpt-6-astra"); // Adding presets must not change the creation default.
    expect(codex.models.find(choice => choice.id === model)?.efforts).toContain(effort);
    await expect(manager.create("owner", { ...spec, model: "gpt-6-luna", effort: "ultra" })).rejects.toThrow("bot_effort_incompatible");
    expect(await hub.store.bots("owner")).toHaveLength(0);
    const bot = await manager.create("owner", { ...spec, model, effort });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    const stateDir = path.join(root, "bots", bot.id);
    expect(await loadInstanceConfig(stateDir)).toMatchObject({ model, effort });
    const options = manager.options; await manager.close();
    manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
    expect(await loadInstanceConfig(stateDir)).toMatchObject({ model, effort });
  });
  it("creates a dispatcher Bot with its role, settings and config marker, keeping ordinary specifications unchanged", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher", dispatcher: { mode: "auto", maxConcurrent: 3 } });
    expect(dispatcher).toMatchObject({ role: "dispatcher" });
    expect(await loadInstanceConfig(path.join(root, "bots", dispatcher.id))).toMatchObject({ role: "dispatcher" });
    expect(await hub.dispatch.settings("owner", dispatcher.id)).toMatchObject({ settings: { mode: "auto", maxConcurrent: 3 } });
    const ordinary = await manager.create("owner", spec);
    expect(ordinary).not.toHaveProperty("role");
    expect(JSON.parse(await readFile(path.join(root, "bots", ordinary.id, "managed-bot-spec.json"), "utf8"))).toEqual(spec);
    await expect(manager.create("owner", { ...spec, requestId: "settings-only", dispatcher: { mode: "ask", maxConcurrent: 2 } })).rejects.toThrow("dispatcher_settings_require_role");
  });
  it("creates one hidden worker per engine for a dispatcher on first use, in the dispatcher's workspace", async () => {
    await expect(manager.create("owner", { ...spec, requestId: "public-worker", role: "worker" })).rejects.toThrow("bot_role_forbidden");
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", name: "总管", role: "dispatcher" });
    const worker = await manager.dispatchWorker(dispatcher.id, "codex");
    expect(await manager.dispatchWorker(dispatcher.id, "codex")).toBe(worker);
    const bot = (await hub.store.bots("owner")).find(item => item.id === worker)!;
    expect(bot).toMatchObject({ role: "worker", name: "总管 · Codex", engine: "codex", model: "", effort: "" });
    const config = await loadInstanceConfig(path.join(root, "bots", worker));
    expect(config.workspacePath).toBe((await loadInstanceConfig(path.join(root, "bots", dispatcher.id))).workspacePath);
    expect(config).not.toHaveProperty("role");
    const ticketDir = await manager.ticketWorkspace(dispatcher.id, "tk_one");
    expect(ticketDir).toBe(path.join((await loadInstanceConfig(path.join(root, "bots", dispatcher.id))).workspacePath!, "tickets", "tk_one"));
    expect((await stat(ticketDir)).isDirectory()).toBe(true);
    await expect(manager.ticketWorkspace(dispatcher.id, "../escape")).rejects.toThrow();
  });
  it("replaces a deleted dispatcher worker once while retaining its old history", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher" });
    const worker = await manager.dispatchWorker(dispatcher.id, "codex");
    const old = (await hub.store.bots("owner")).find(bot => bot.id === worker)!;
    await manager.delete("owner", old.id, old.name);
    const replacements = await Promise.all([manager.dispatchWorker(dispatcher.id, "codex"), manager.dispatchWorker(dispatcher.id, "codex")]);
    expect(replacements[0]).not.toBe(worker);
    expect(replacements[0]).toBe(replacements[1]);
    expect(await manager.dispatchWorker(dispatcher.id, "codex")).toBe(replacements[0]);
    expect((await hub.store.bots("owner", true)).find(bot => bot.id === worker)?.deletedAt).toBeDefined();
  }, 60_000);
  it("inherits manual permission and replaces an idle worker after the dispatcher permission changes", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher", permission: "normal" });
    const worker = await manager.dispatchWorker(dispatcher.id, "codex");
    expect(await readValidatedConfigFile(path.join(root, "bots", worker, "config.json"))).toMatchObject({ approvalMode: "normal" });
    await updateInstanceConfig(path.join(root, "bots", dispatcher.id), cfg => { cfg.approvalMode = "full-auto"; });
    const replacement = await manager.dispatchWorker(dispatcher.id, "codex");
    expect(replacement).not.toBe(worker);
    expect(await readValidatedConfigFile(path.join(root, "bots", replacement, "config.json"))).toMatchObject({ approvalMode: "full-auto" });
    expect((await hub.store.bots("owner", true)).find(bot => bot.id === worker)?.deletedAt).toBeDefined();
  }, 60_000);
  it("does not replace a worker with pending inputs when the dispatcher permission changes", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher" });
    const worker = await manager.dispatchWorker(dispatcher.id, "codex");
    const conversation = await hub.store.db.transaction(() => hub.store.createConversationInTransaction("owner", [worker], "Ticket", "ticket", { dispatchWorker: true }));
    await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "run", text: "run", attachments: [] });
    await updateInstanceConfig(path.join(root, "bots", dispatcher.id), cfg => { cfg.approvalMode = "normal"; });
    await expect(manager.dispatchWorker(dispatcher.id, "codex")).rejects.toThrow("dispatch_worker_permissions_busy");
    expect((await hub.store.bots("owner")).find(bot => bot.id === worker)?.deletedAt).toBeUndefined();
  });
  it("does not leave a live worker when its dispatcher is deleted before creation commits", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher" });
    const original = manager.create.bind(manager);
    const spy = vi.spyOn(manager, "create").mockImplementationOnce(async (...args) => {
      await manager.delete("owner", dispatcher.id, dispatcher.name);
      return original(...args);
    });
    try { await expect(manager.dispatchWorker(dispatcher.id, "codex")).rejects.toThrow("dispatcher_required"); }
    finally { spy.mockRestore(); }
    expect((await hub.store.bots("owner")).filter(bot => bot.role === "worker")).toEqual([]);
  });
  it("records worker ownership before publishing its registration", async () => {
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher" });
    let registered = false;
    const spy = vi.spyOn(manager, "changed").mockImplementation(async botId => {
      const bot = await hub.store.db.get<{ role: string }>("SELECT role FROM bots WHERE id=?", [botId]);
      if (bot?.role !== "worker") return;
      expect(await hub.store.db.get("SELECT dispatcher_bot_id FROM dispatch_workers WHERE bot_id=?", [botId])).toEqual({ dispatcher_bot_id: dispatcher.id });
      registered = true;
    });
    try { await manager.dispatchWorker(dispatcher.id, "codex"); expect(registered).toBe(true); }
    finally { spy.mockRestore(); }
  });
  it("falls back to manual for an engine-specific auto mode on a different CLI", async () => {
    manager.options.env = { ...manager.options.env, CLAUDE_EXECUTABLE: process.execPath };
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher", engine: "claude", model: "", effort: "", permission: "claude-auto" });
    const worker = await manager.dispatchWorker(dispatcher.id, "codex");
    expect(await readValidatedConfigFile(path.join(root, "bots", worker, "config.json"))).toMatchObject({ approvalMode: "normal" });
  });
  it("detects the official agy executable and respects an explicit Antigravity override", async () => {
    await symlink(process.execPath, path.join(root, "agy"));
    manager.options.env = { PATH: root };
    expect((await manager.catalog()).engines.find((e) => e.id === "antigravity")?.available).toBe(true);
    manager.options.env.ANTIGRAVITY_EXECUTABLE = path.join(root, "missing-override");
    expect((await manager.catalog()).engines.find((e) => e.id === "antigravity")).toMatchObject({ available: false, defaultModel: "", models: [{ id: "", efforts: [""] }] });
  });
  it("defaults new AGY Bots to advertised Argon Medium without migrating existing model settings", async () => {
    const agy = (await manager.catalog()).engines.find(engine => engine.id === "antigravity")!;
    expect(agy).toMatchObject({ defaultModel: "gemini-4-argon-medium", defaultEffort: "" });
    expect(agy.models.find(model => model.id === agy.defaultModel)).toEqual({ id: agy.defaultModel, label: "Gemini 4 Argon (Medium)", efforts: ["", "medium"] });
    await expect(manager.create("owner", { ...spec, engine: "antigravity", model: agy.defaultModel, effort: "xhigh" })).rejects.toThrow("bot_effort_incompatible");
    const bot = await manager.create("owner", { ...spec, engine: "antigravity", model: agy.defaultModel, effort: "" });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    const stateDir = path.join(root, "bots", bot.id);
    expect(await loadInstanceConfig(stateDir)).toMatchObject({ model: "gemini-4-argon-medium" });
    await updateInstanceConfig(stateDir, config => { config.model = "gemini-3.8-flash-high"; config.effort = "high"; });
    const options = manager.options; await manager.close();
    manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
    expect(await loadInstanceConfig(stateDir)).toMatchObject({ model: "gemini-3.8-flash-high", effort: "high" });
  });
  it("offers only discovered Antigravity variants and validates effort before creating a worker", async () => {
    const agy = (await manager.catalog()).engines.find((engine) => engine.id === "antigravity")!;
    expect(agy.models.find((model) => model.id === "")).toEqual({ id: "", efforts: [""] });
    expect(agy.models.find((model) => model.id === "gemini-3.8-flash-high")?.efforts).toEqual(["", "high"]);
    await expect(manager.create("owner", { ...spec, engine: "antigravity", model: "gemini-3.8-flash-high", effort: "low" })).rejects.toThrow("bot_effort_incompatible");
    await expect(manager.create("owner", { ...spec, engine: "antigravity", model: "gemini-3.8-flash-high", effort: "xhigh" })).rejects.toThrow("bot_effort_incompatible");
    await expect(manager.create("owner", { ...spec, engine: "antigravity", model: "", effort: "high" })).rejects.toThrow("bot_effort_incompatible");
    expect(await hub.store.bots("owner")).toHaveLength(0);
    const bot = await manager.create("owner", { ...spec, engine: "antigravity", model: "gemini-3.8-flash-high", effort: "high" });
    expect(await loadInstanceConfig(path.join(root, "bots", bot.id))).toMatchObject({ model: "gemini-3.8-flash-high", effort: "high" });
  });
  it("offers Opus 5.5 as the App default and persists the exact selected model", async () => {
    manager.options.env = { ...process.env, CLAUDE_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.resolve("tests/fixtures/agy-models.mjs") };
    const claude = (await manager.catalog()).engines.find((engine) => engine.id === "claude")!;
    expect(claude).toMatchObject({ available: true, defaultModel: "claude-opus-5-5[1m]", defaultEffort: "xhigh" });
    expect(claude.models.find((model) => model.id === claude.defaultModel)?.efforts).toContain("xhigh");
    expect(claude.models.some((model) => model.id === "claude-opus-5[1m]")).toBe(false);
    const bot = await manager.create("owner", { ...spec, engine: "claude", model: claude.defaultModel, effort: "xhigh" });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    const stateDir = path.join(root, "bots", bot.id);
    expect(await loadInstanceConfig(stateDir)).toMatchObject({ model: "claude-opus-5-5[1m]", effort: "xhigh" });
    // Catalog updates must not rewrite a user's explicitly selected older model.
    await updateInstanceConfig(stateDir, (config) => { config.model = "claude-opus-5[1m]"; });
    const options = manager.options; await manager.close();
    manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
    expect((await loadInstanceConfig(stateDir)).model).toBe("claude-opus-5[1m]");
  });
  it("creates one isolated instance across parallel retries, persists settings and starts a supervised worker", async () => {
    const results = await Promise.all([manager.create("owner", spec), manager.create("owner", spec)]);
    expect(results[0]!.id).toBe(results[1]!.id); const bot = results[0]!;
    expect(botAvatarById(bot.defaultAvatar)).toBeDefined();
    expect(bot.defaultAvatar).toBe("pastel-fox");
    expect(results[1]!.defaultAvatar).toBe(bot.defaultAvatar);
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    const stateDir = path.join(root, "bots", bot.id);
    const config = await loadInstanceConfig(stateDir); expect(config).toMatchObject({ engine: spec.engine, model: spec.model, effort: spec.effort, workspacePath: path.join(stateDir, "workspace") });
    if (process.platform !== "win32") expect((await stat(path.join(stateDir, "gateway.key"))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await hub.store.bots("owner"))).not.toContain((await readFile(path.join(stateDir, "gateway.key"), "utf8")).trim());
    await updateInstanceConfig(stateDir, (c) => { c.effort = "max"; });
    await manager.create("owner", spec); expect((await loadInstanceConfig(stateDir)).effort).toBe("max");
    await expect(manager.create("owner", { ...spec, name: "changed" })).rejects.toThrow("idempotency_conflict");
    expect(await hub.store.bots("owner")).toHaveLength(1);
    const options = manager.options; await manager.close();
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 0);
    manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    expect((await hub.store.bots("owner"))[0]).toMatchObject({ effort: "max", defaultAvatar: bot.defaultAvatar });
  });
  it("validates permission choices and preserves explicit normal mode on creation and restore", async () => {
    await expect(manager.create("owner", { ...spec, permission: "claude-auto" })).rejects.toThrow("permissions_incompatible");
    expect(await hub.store.bots("owner")).toHaveLength(0);
    const bot = await manager.create("owner", { ...spec, engine: "antigravity", model: "", effort: "", permission: "normal" });
    const stateDir = path.join(root, "bots", bot.id);
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toMatchObject({ approvalMode: "normal" });
    const options = manager.options; await manager.close();
    manager = new BotManager(hub.store, root, options, () => hub.instanceUrl, async () => {}); await manager.restore();
    expect(JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"))).toMatchObject({ approvalMode: "normal" });
    const catalog = await manager.catalog();
    expect(catalog.engines.find(e => e.id === "kimi")?.permissions?.defaultChoice).toBe("full-auto");
    expect(catalog.engines.find(e => e.id === "claude")?.permissions?.choices.map(c => c.id)).toEqual(["bypass", "claude-auto", "claude-accept-edits", "normal"]);
  });
  it("uses existing model compatibility rules and rejects unauthorized creation or invalid workspace", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    await expect(manager.create("member", spec)).rejects.toThrow("owner_required");
    await expect(manager.create("owner", { ...spec, model: "gpt-5.5", effort: "ultra" })).rejects.toThrow("bot_effort_incompatible");
    await expect(manager.create("owner", { ...spec, workspace: "../escape" })).rejects.toThrow("bot_workspace_unavailable");
    const catalog = await manager.catalog();
    expect(catalog.engines.find((e) => e.id === "codex")?.models.find((m) => m.id === "gpt-5.5")?.efforts).not.toContain("ultra");
    expect(await hub.store.bots("owner")).toHaveLength(0);
  });
});
