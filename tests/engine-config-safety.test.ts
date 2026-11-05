import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEngineSelection, readValidatedConfigFile, updateInstanceApprovalMode, updateInstanceConfig } from "../src/state/instance-config.js";
import { EngineConfigError } from "../src/state/engine-config-error.js";
import { classifyFailure, getBusErrorSemantics, renderEngineSettingsError } from "../src/runtime/error-classification.js";
import { ProcessClaudeAdapter } from "../src/codex/claude-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { KimiAcpAdapter } from "../src/codex/kimi-acp-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

beforeEach(() => { for (const key of ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"]) vi.stubEnv(key, ""); });
afterEach(() => vi.unstubAllEnvs());

describe("execution configuration safety", () => {
  let root: string, file: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "engine-config-safety-")); file = path.join(root, "config.json"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each(["missing", "{broken-private-secret", "null", "[]", '{"approvalMode":"typo"}', '{"approvalMode":null}', '{"claudePermissionMode":"bad"}', '{"kimiAutoNeverAskAcknowledged":"true"}', '{"codexRuntime":"bad"}', '{"engine":"unknown"}'])("rejects %s without exposing config contents", async content => {
    if (content !== "missing") await writeFile(file, content);
    await expect(readValidatedConfigFile(file, { forExecution: true })).rejects.toBeInstanceOf(EngineConfigError);
    const error = await readValidatedConfigFile(file, { forExecution: true }).catch(e => e);
    expect(String(error)).not.toContain("private-secret");
    expect(classifyFailure(error)).toBe("engine-settings");
    expect(getBusErrorSemantics(classifyFailure(error)).retryable).toBe(false);
    expect(renderEngineSettingsError(error, "zh")).toContain("本次执行已停止");
    expect(renderEngineSettingsError(error.message, "en")).toContain("full access was not enabled");
    // Repair is read on the next turn without clearing the session or restart.
    await writeFile(file, '{"approvalMode":"normal"}');
    expect(await readValidatedConfigFile(file, { forExecution: true })).toMatchObject({ approvalMode: "normal" });
  });

  it("preserves legacy defaults and unrelated compatibility salvage on valid config", async () => {
    await writeFile(file, '{}');
    expect(await readValidatedConfigFile(file, { forExecution: true })).toEqual({});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(file, '{"engine":"claude","approvalMode":"normal","budgetUsd":"bad","effort":"ultra"}');
      expect(await readValidatedConfigFile(file, { forExecution: true })).toEqual({ engine: "claude", approvalMode: "normal" });
    } finally { log.mockRestore(); }
  });

  it.each(['{"approvalMode":"normal", broken', "null", "[]"])("requires approval after an unrelated setting repairs %s", async content => {
    await writeFile(file, content);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await updateInstanceConfig(root, config => { config.model = "repaired-model"; }); }
    finally { log.mockRestore(); }
    expect(await readValidatedConfigFile(file, { forExecution: true })).toMatchObject({ model: "repaired-model", approvalMode: "normal" });
    const backups = (await readdir(root)).filter(name => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(root, backups[0]!), "utf8")).toBe(content);
    // Choosing wider access explicitly after recovery remains possible.
    await updateInstanceApprovalMode(root, "bypass");
    expect(await readValidatedConfigFile(file, { forExecution: true })).toMatchObject({ approvalMode: "bypass" });
  });

  it.each(["codex", "claude", "kimi", "deepseek", "antigravity"] as const)("does not replace invalid %s permissions with its permissive default during engine selection", async engine => {
    for (const previousEngine of [engine, undefined, engine === "kimi" ? "codex" : "kimi"]) for (const approvalMode of [null, "typo", "normal"]) {
      await writeFile(file, JSON.stringify({ engine: previousEngine, approvalMode }));
      await updateInstanceConfig(root, config => applyEngineSelection(config, engine));
      expect(await readValidatedConfigFile(file, { forExecution: true })).toMatchObject({ engine, approvalMode: "normal" });
    }
    const fresh: Record<string, unknown> = {};
    applyEngineSelection(fresh, engine);
    expect(fresh.approvalMode).toBe(engine === "kimi" ? "full-auto" : "bypass");
  });

  it.each(["{broken", "null"])("leaves %s untouched if its recovery backup cannot be made", async content => {
    await writeFile(file, content);
    await mkdir(`${file}.corrupt.123.bak`);
    const clock = vi.spyOn(Date, "now").mockReturnValue(123), updater = vi.fn();
    try { await expect(updateInstanceConfig(root, updater)).rejects.toThrow(); }
    finally { clock.mockRestore(); }
    expect(updater).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it.each(["{broken", "null"])("keeps %s fail-closed after the recovery updater throws, then retries safely", async content => {
    await writeFile(file, content);
    const clock = vi.spyOn(Date, "now").mockReturnValue(123);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(updateInstanceConfig(root, () => { throw new Error("fixture update failure"); })).rejects.toThrow("fixture update failure");
      expect(await readFile(file, "utf8")).toBe(content);
      await expect(readValidatedConfigFile(file, { forExecution: true })).rejects.toBeInstanceOf(EngineConfigError);
      clock.mockReturnValue(124);
      await updateInstanceConfig(root, config => { config.model = "retry-model"; });
      expect(await readValidatedConfigFile(file, { forExecution: true })).toMatchObject({ model: "retry-model", approvalMode: "normal" });
    } finally { clock.mockRestore(); log.mockRestore(); }
  });

  it("does not overwrite an existing recovery backup", async () => {
    await writeFile(file, "{broken");
    const backup = `${file}.corrupt.123.bak`;
    await writeFile(backup, "preserve this older backup");
    const clock = vi.spyOn(Date, "now").mockReturnValue(123), updater = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await expect(updateInstanceConfig(root, updater)).rejects.toThrow(); }
    finally { clock.mockRestore(); log.mockRestore(); }
    expect(updater).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("{broken");
    expect(await readFile(backup, "utf8")).toBe("preserve this older backup");
  });

  it("keeps damaged config and removes the temporary file when replacement sync fails", async () => {
    await writeFile(file, "{broken");
    const handle = await open(file, "r"), prototype = Object.getPrototypeOf(handle) as typeof handle;
    await handle.close();
    const realSync = prototype.sync;
    const sync = vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof handle) {
      if ((await readdir(root)).some(name => name.endsWith(".tmp"))) throw new Error("fixture fsync failure");
      await realSync.call(this);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await expect(updateInstanceConfig(root, config => { config.model = "updated"; })).rejects.toThrow("fixture fsync failure"); }
    finally { sync.mockRestore(); log.mockRestore(); }
    expect(await readFile(file, "utf8")).toBe("{broken");
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
    await expect(readValidatedConfigFile(file, { forExecution: true })).rejects.toBeInstanceOf(EngineConfigError);
  });

  it("does not run the updater or replace the original if backup sync fails", async () => {
    await writeFile(file, "{broken");
    const handle = await open(file, "r"), prototype = Object.getPrototypeOf(handle) as typeof handle;
    await handle.close();
    const sync = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("fixture backup sync failure"));
    const updater = vi.fn(config => { config.model = "updated"; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await expect(updateInstanceConfig(root, updater)).rejects.toThrow("fixture backup sync failure"); }
    finally { sync.mockRestore(); log.mockRestore(); }
    expect(updater).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("{broken");
    expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each(["claude", "claude-process", "kimi", "codex", "process", "antigravity"] as const)("never launches %s with fallback permissions after an unreadable config", async engine => {
    const spawn = vi.fn((): never => { throw new Error("unexpected native launch"); });
    const adapter = engine === "claude" ? new ClaudeStreamAdapter("claude", { configPath: file, spawnFn: spawn })
      : engine === "claude-process" ? new ProcessClaudeAdapter("claude", { configPath: file, spawnFn: spawn })
      : engine === "kimi" ? new KimiAcpAdapter("kimi", { configPath: file, spawnFn: spawn })
      : engine === "codex" ? new CodexAppServerAdapter("codex", root, {}, spawn, undefined, undefined, file)
      : engine === "process" ? new ProcessCodexAdapter("codex", {}, spawn, undefined, file)
      : new ProcessAntigravityAdapter("agy", {}, spawn, undefined, file);
    try {
      for (const content of ['{broken', '{"approvalMode":"not-a-mode"}']) {
        await writeFile(file, content);
        await expect(adapter.sendUserMessage("telegram-12345", { text: "hello", files: [] })).rejects.toBeInstanceOf(EngineConfigError);
      }
      expect(spawn).not.toHaveBeenCalled();
    } finally { if ("destroy" in adapter) await adapter.destroy(); }
  });
});
