import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter, type AppServerSpawnCodex } from "../src/codex/app-server-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { buildClaudeCommandInvocation, ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { resolveClaudeConfigDir } from "../src/codex/claude-side-question.js";
import { AdapterQuotaCache } from "../src/codex/adapter-account-quota.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { executableCandidates, npmShimEntrypoint, resolveEngineExecutable } from "../src/runtime/engine-process.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const routing = (chatgptAccountId: string) => ({ workspaceRouting: { chatgptAccountId, backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" } });
const account = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: true, userId: "fixture-user", ...routing("fixture-account") };
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); methods: string[] = []; killCount = 0; closed = false;
  hold = new Set<string>(); closeDelayMs = 20; accounts: unknown[] = []; limits?: unknown; errors: Record<string, { code: number; message: string }> = {};
  /** Claude control requests: `answers[subtype]` is the success payload, `refuse` answers like a CLI that does not know the subtype. */
  controls: string[] = []; answers: Record<string, unknown> = {}; refuse = new Set<string>();
  stdin = { write: (line: string, callback?: (error?: Error | null) => void) => {
    const request = JSON.parse(line);
    if (request.type === "control_request") {
      const subtype = String(request.request?.subtype); this.controls.push(subtype);
      if (this.refuse.has(subtype)) queueMicrotask(() => this.event({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error: `Unsupported control request subtype: ${subtype}` } }));
      else if (subtype in this.answers) queueMicrotask(() => this.event({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: this.answers[subtype] } }));
      callback?.(null); return true;
    }
    this.methods.push(request.method);
    if (request.id != null && this.errors[request.method]) { const error = this.errors[request.method]; queueMicrotask(() => this.stdout.emit("data", JSON.stringify({ id: request.id, error }) + "\n")); }
    else if (request.id != null && !this.hold.has(request.method)) queueMicrotask(() => this.reply(request.id,
      request.method === "account/read" ? this.accounts.length ? this.accounts.shift() : account : request.method === "account/rateLimits/read" ? this.limits ?? { accountId: "fixture-account", rateLimits: { primary: { usedPercent: 25 } } } : {}));
    callback?.(null); return true;
  }, end: () => undefined, on: () => undefined };
  reply(id: unknown, result: unknown) { this.stdout.emit("data", JSON.stringify({ id, result }) + "\n"); }
  event(value: unknown) { this.stdout.emit("data", JSON.stringify(value) + "\n"); }
  kill() { this.killCount++; if (!this.closed) setTimeout(() => { if (this.closed) return; this.closed = true; this.emit("close", 0); }, this.closeDelayMs); }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-scope-")); roots.push(root);
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-fixture", account_id: "fixture-account" } }));
  return { root, home, codexHome, env: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH } };
}
it("cached quota reads never spawn; active Process reads close the owned child before resolving", async () => {
  const f = await fixture(), children: Child[] = [];
  const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child; });
  const adapter = new ProcessCodexAdapter("codex", f.env, spawn, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const cached = await adapter.getAccountQuota({ refresh: false }); expect(spawn).not.toHaveBeenCalled();
  expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
  const result = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
  expect(result.snapshot.state).toBe("ready");
  expect(children[0].closed).toBe(true);
  expect(children[0].methods.filter(method => !["initialize", "initialized"].includes(method))).toEqual(["account/read", "account/rateLimits/read", "account/read"]);
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0].windows[0]).toMatchObject({ usedPercent: 25 });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("a quota read timeout cannot kill an existing app-server", async () => {
  const f = await fixture(), child = new Child();
  const adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  child.hold.add("account/rateLimits/read");
  const result = await adapter.getAccountQuota({ refresh: true, timeoutMs: 30 });
  expect(result.snapshot.reason).toBe("timeout"); expect(child.killCount).toBe(0);
  await expect((adapter as any).request("config/read", {}, { timeoutMs: 100 })).resolves.toEqual({});
  expect(child.killCount).toBe(0);
});
it("changing credential bytes invalidates the cache and rejects the old revision", async () => {
  const f = await fixture(), adapter = new ProcessCodexAdapter("codex", f.env, () => new Child(), undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const first = await adapter.getAccountQuota({ refresh: true });
  await writeFile(path.join(f.codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "different-fixture", account_id: "other-fixture" } }));
  const next = await adapter.getAccountQuota({ refresh: false, expectedRevision: first.revision });
  expect(next.revision).not.toBe(first.revision); expect(next.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
});
it("an external login switch cannot attribute a live old worker to new on-disk credentials", async () => {
  const f = await fixture(), child = new Child(), adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  await writeFile(path.join(f.codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "changed", account_id: "other" } }));
  const result = await adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot.reason).toBe("auth_changed"); expect(child.methods).not.toContain("account/read"); expect(child.killCount).toBe(0);
});
it("a token refresh or an unrelated config.toml rewrite keeps the live worker's quota readable (#204)", async () => {
  const f = await fixture(), child = new Child(), adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  // Same account: Codex rotated the access token, and another tool rewrote an unrelated config key.
  await writeFile(path.join(f.codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "rotated-fixture", account_id: "fixture-account" } }));
  await writeFile(path.join(f.codexHome, "config.toml"), 'model = "fixture-model"\n[tui]\nnotifications = true\n');
  const result = await adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot.reason).toBeUndefined();
  expect(result.snapshot.pools[0].windows[0]).toMatchObject({ usedPercent: 25 });
  expect(child.methods).toContain("account/rateLimits/read"); expect(child.killCount).toBe(0);
});
it("a credential-source change in config.toml still disowns the live worker", async () => {
  const f = await fixture(), child = new Child(), adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  await writeFile(path.join(f.codexHome, "config.toml"), 'forced_chatgpt_workspace_id = "other-workspace"\n');
  const result = await adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot.reason).toBe("auth_changed"); expect(child.methods).not.toContain("account/read"); expect(child.killCount).toBe(0);
});
it("destroy during a quota helper's initialize cancels it and waits for its actual close", async () => {
  const f = await fixture(), child = new Child(); child.hold.add("initialize"); child.closeDelayMs = 60;
  const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
  const read = adapter.getAccountQuota({ refresh: true });
  const stopped = adapter.destroy();
  expect(child.closed).toBe(false);
  await stopped;
  expect(child.closed).toBe(true);
  expect((await read).snapshot.reason).toBe("cancelled");
  expect(child.methods).not.toContain("account/read");
});
it("app-server destroy cancels its own quota helper and waits for its actual close", async () => {
  const f = await fixture(), child = new Child(); child.hold.add("initialize"); child.closeDelayMs = 60;
  const adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  const read = adapter.getAccountQuota({ refresh: true });
  await vi.waitFor(() => expect(child.methods).toContain("initialize"));
  await adapter.destroy();
  expect(child.closed).toBe(true);
  expect((await read).snapshot.reason).toBe("cancelled");
});
it("Claude passive events of a verified login still count with a CLI that refuses get_usage, and a changed credential source hides them", async () => {
  const f = await fixture(), child = new Child(); child.refuse.add("get_usage");
  const env = { HOME: f.home, CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth" };
  const spawn = vi.fn(() => child);
  const adapter = new ClaudeStreamAdapter("claude", { childEnv: env, spawnFn: spawn, workspacePath: f.root, idleSweepIntervalMs: 0 });
  disposals.push(() => adapter.destroy());
  expect((await adapter.getAccountQuota({ refresh: true })).snapshot.reason).toBe("no_passive_event"); expect(spawn).not.toHaveBeenCalled();
  const worker = await (adapter as any).getOrCreateWorker("tarobot-fixture", null, null, "normal", f.root);
  const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.25 } };
  child.event(event);
  const first = await adapter.getAccountQuota({ refresh: true });
  expect(first.snapshot.pools[0].windows[0]).toMatchObject({ usedPercent: 25 });
  expect(child.methods).toEqual([]);
  env.CLAUDE_CODE_OAUTH_TOKEN = "other-synthetic-oauth";
  child.event(event);
  expect((await adapter.getAccountQuota({ refresh: true })).snapshot.pools).toEqual([]);
  expect(child.methods).toEqual([]);
  worker.retired = true; child.event(event);
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
  // The refusal is remembered for that process: it was asked once.
  expect(child.controls).toEqual(["get_usage"]);
});
const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const usageReply = () => ({ session: {}, subscription_type: "max", rate_limits_available: true, behaviors: {},
  rate_limits: { five_hour: { utilization: 12, resets_at: future(3) }, seven_day: { utilization: 61.5, resets_at: future(90) }, seven_day_opus: null } });
/** Holds the next control request's answer until the returned function sends it. */
function holdControls(child: Child) {
  let pending: string | undefined;
  child.stdin.write = ((line: string, callback?: (error?: Error | null) => void) => {
    const request = JSON.parse(line); child.controls.push(String(request.request?.subtype)); pending = request.request_id; callback?.(null); return true;
  }) as typeof child.stdin.write;
  return (response: unknown) => child.event({ type: "control_response", response: { subtype: "success", request_id: pending, response } });
}
async function claudeFixture() {
  const f = await fixture(), child = new Child(), spawn = vi.fn(() => child);
  // No credential file and no token in the environment: the login is wherever the CLI keeps it.
  const adapter = new ClaudeStreamAdapter("claude", { childEnv: { HOME: f.home }, spawnFn: spawn, workspacePath: f.root, idleSweepIntervalMs: 0 });
  disposals.push(() => adapter.destroy());
  const start = () => (adapter as any).getOrCreateWorker("tarobot-fixture", null, null, "normal", f.root);
  return { f, child, spawn, adapter, start };
}
describe("Claude quota from the Bot's own running engine", () => {
  it("starts no process for a reading", async () => {
    const { adapter, spawn } = await claudeFixture();
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "scope_unverifiable", capability: { mode: "passive" }, pools: [] });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("asks get_usage only on an explicit refresh, and the answer stays the Bot's reading after that process has ended", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply();
    const worker = await start();
    const idle = await adapter.getAccountQuota({ refresh: false });
    expect(idle.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" }, pools: [] });
    expect(child.controls).toEqual([]);
    const read = await adapter.getAccountQuota({ refresh: true, expectedRevision: idle.revision });
    expect(read.revision).toBe(idle.revision);
    expect(read.snapshot).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" } });
    expect(read.snapshot.pools[0].windows.map(window => [window.id, window.metric === "percent" && window.usedPercent])).toEqual([["five_hour", 12], ["seven_day", 61.5]]);
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0].windows).toHaveLength(2);
    expect(child.controls).toEqual(["get_usage"]); expect(child.methods).toEqual([]);
    // The process ends (an idle Bot keeps none): the reading is still the Bot's, under the same revision, and nothing is started or asked.
    worker.retired = true;
    const after = await adapter.getAccountQuota({ refresh: false });
    expect(after.revision).toBe(read.revision); expect(after.snapshot.observedAt).toBe(read.snapshot.observedAt);
    expect(after.snapshot.pools[0].windows).toHaveLength(2);
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot.observedAt).toBe(read.snapshot.observedAt);
    expect(child.controls).toEqual(["get_usage"]); expect(child.methods).toEqual([]);
  });
  it("answers the Gateway's refresh and asks the engine once per cooldown", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); await start();
    const run = gatewayEngineQuota({ botId: "bot", engine: "claude", read: options => adapter.getAccountQuota(options) });
    const listed = await run({ scopeId: "bot", refresh: false });
    expect(listed.value).toMatchObject({ state: "unknown", capability: { mode: "active" } });
    for (let index = 0; index < 3; index++) expect((await run({ scopeId: "bot", refresh: true, expectedRevision: listed.revision })).value).toMatchObject({ state: "ready", sharing: "unverified", botIds: ["bot"] });
    expect(child.controls).toEqual(["get_usage"]);
  });
  it("marks a kept reading stale after its lifetime instead of renewing it", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); await start();
    await adapter.getAccountQuota({ refresh: true });
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ state: "stale" });
    later.mockRestore();
  });
  it("does not keep an API-key answer and shows no quota for it", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null }; await start();
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", pools: [] });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "not_loaded", capability: { mode: "active" } });
  });
  it("keeps the earlier rules for a CLI that refuses get_usage and does not ask it again", async () => {
    const { adapter, child, start } = await claudeFixture(); child.refuse.add("get_usage"); await start();
    for (let index = 0; index < 2; index++) expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "scope_unverifiable", capability: { mode: "passive" }, pools: [] });
    expect(child.controls).toEqual(["get_usage"]);
  });
  it("reports a silent engine as a timeout and keeps an earlier reading as stale", async () => {
    const { adapter, child, start } = await claudeFixture(); await start();
    // A question stays out after its reader stopped waiting; here it is given up after 40 ms so the next read asks anew.
    (adapter as any).usageLateMs = 40;
    expect((await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 })).snapshot).toMatchObject({ state: "unavailable", reason: "timeout", capability: { mode: "active" }, pools: [] });
    await new Promise(resolve => setTimeout(resolve, 60));
    child.answers.get_usage = usageReply(); await adapter.getAccountQuota({ refresh: true });
    delete child.answers.get_usage;
    const stale = (await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 })).snapshot;
    expect(stale).toMatchObject({ state: "stale", reason: "timeout" }); expect(stale.pools[0].windows).toHaveLength(2);
  });
  it("keeps an answer that comes after the read stopped waiting, with one question out at a time", async () => {
    const { adapter, child, start } = await claudeFixture(); await start();
    // A slow CLI: the question is taken and answered by hand later.
    const asked: string[] = [], write = child.stdin.write;
    child.stdin.write = (line: string, callback?: (error?: Error | null) => void) => {
      const request = JSON.parse(line);
      if (request.type !== "control_request" || request.request?.subtype !== "get_usage") return write(line, callback);
      asked.push(request.request_id); callback?.(null); return true;
    };
    expect((await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 })).snapshot).toMatchObject({ state: "unavailable", reason: "timeout" });
    expect((await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 })).snapshot.state).toBe("unavailable");
    expect(asked).toHaveLength(1);
    child.event({ type: "control_response", response: { subtype: "success", request_id: asked[0], response: usageReply() } });
    await new Promise(resolve => setTimeout(resolve, 10));
    const kept = (await adapter.getAccountQuota({ refresh: false })).snapshot;
    expect(kept.state).toBe("ready"); expect(kept.pools[0].windows).toHaveLength(2);
    expect(asked).toHaveLength(1);
  });
  it("asks a process that is working on a turn when none is idle, and leaves its activity clock alone", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); const worker = await start();
    for (const [index, busy] of [{ pendingTurn: {} }, { continuationTurn: {} }, { nativeTurnOpen: true }, { taskNotificationTurnActive: true }].entries()) {
      Object.assign(worker, busy); worker.lastActivityAt = 1_000 + index;
      const read = (await adapter.getAccountQuota({ refresh: true })).snapshot;
      expect(read).toMatchObject({ state: "ready" }); expect(read.pools[0].windows).toHaveLength(2); expect(read.reason).toBeUndefined();
      expect(child.controls).toHaveLength(index + 1);
      // A process on a turn is in use: nothing is put back.
      expect(worker.lastActivityAt).toBeGreaterThanOrEqual(1_000 + index);
      Object.assign(worker, { pendingTurn: null, continuationTurn: undefined, nativeTurnOpen: false, taskNotificationTurnActive: false });
    }
    expect(child.controls).toEqual(["get_usage", "get_usage", "get_usage", "get_usage"]);
  });
  it("prefers an idle process to one on a turn", async () => {
    const { adapter, child, start, spawn } = await claudeFixture(); child.answers.get_usage = usageReply();
    const busy = await start(); Object.assign(busy, { pendingTurn: {} }); busy.lastActivityAt = 9_000;
    const other = new Child(); other.answers.get_usage = usageReply(); spawn.mockReturnValueOnce(other);
    const idle = await (adapter as any).getOrCreateWorker("tarobot-other", null, null, "normal", undefined); idle.lastActivityAt = 1_000;
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot.state).toBe("ready");
    expect(other.controls).toEqual(["get_usage"]); expect(child.controls).toEqual([]);
    Object.assign(busy, { pendingTurn: null });
  });
  it("does not count a question as use of the process", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); child.answers.get_context_usage = { totalTokens: 5, maxTokens: 10 }; const worker = await start();
    worker.lastActivityAt = 1_000;
    await adapter.getAccountQuota({ refresh: true }); await adapter.getContextUsage("tarobot-fixture");
    expect(child.controls).toEqual(["get_usage", "get_context_usage"]); expect(worker.lastActivityAt).toBe(1_000);
    delete child.answers.get_usage;
    await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 });
    expect(worker.lastActivityAt).toBe(1_000);
  });
  it("asks again after a failure that is not the CLI's own refusal of the request", async () => {
    const { adapter, child, start } = await claudeFixture(); await start();
    const fail = (error: string) => { child.stdin.write = ((line: string, callback?: (error?: Error | null) => void) => { const request = JSON.parse(line); child.controls.push(String(request.request?.subtype));
      queueMicrotask(() => child.event({ type: "control_response", response: { subtype: "error", request_id: request.request_id, error } })); callback?.(null); return true; }) as typeof child.stdin.write; };
    fail("usage could not be fetched");
    for (let index = 0; index < 2; index++) expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "native_error", capability: { mode: "active" }, pools: [] });
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull(); expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
    expect(child.controls).toEqual(["get_usage", "get_usage", "get_context_usage", "get_context_usage"]);
    fail("Unsupported control request subtype: get_usage");
    for (let index = 0; index < 2; index++) expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "scope_unverifiable", capability: { mode: "passive" } });
    expect(child.controls.filter(name => name === "get_usage")).toHaveLength(3);
  });
  it("drops this process's earlier reading when it later answers that it has no windows", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); await start();
    await adapter.getAccountQuota({ refresh: true });
    child.answers.get_usage = { rate_limits_available: false, rate_limits: null };
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unsupported", pools: [] });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "not_loaded", pools: [] });
  });
  it("counts a model's own allowance by the model the process stated at its start", async () => {
    const { adapter, child, start } = await claudeFixture(); const worker = await start();
    child.answers.get_usage = { ...usageReply(), rate_limits: { seven_day: { utilization: 31, resets_at: future(90) }, model_scoped: [{ display_name: "Fable", utilization: 64, resets_at: future(90) }] } };
    const pools = async () => (await adapter.getAccountQuota({ refresh: true })).snapshot.pools.map(pool => [pool.label, pool.models]);
    // Not stated yet: the model's pool keeps naming its model for the App to decide.
    expect(await pools()).toEqual([["Claude", undefined], ["Fable", ["Fable"]]]);
    child.event({ type: "system", subtype: "init", model: "claude-fable-5-2" }); worker.nativeTurnOpen = false;
    expect(await pools()).toEqual([["Claude", undefined], ["Fable", undefined]]);
    child.event({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }); worker.nativeTurnOpen = false;
    expect(await pools()).toEqual([["Claude", undefined]]);
  });
  it("rejects a malformed answer without values", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = { rate_limits_available: true, rate_limits: { five_hour: { utilization: "12" } } }; await start();
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "invalid_response", pools: [] });
  });
  it("returns no reading when the login changes while get_usage is out, and keeps none", async () => {
    const { f, adapter, child, start } = await claudeFixture();
    const credentials = path.join(f.home, ".claude", ".credentials.json");
    await mkdir(path.dirname(credentials), { recursive: true });
    await writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-a" } }));
    await start();
    const answer = holdControls(child);
    const listed = await adapter.getAccountQuota({ refresh: false });
    const read = adapter.getAccountQuota({ refresh: true, expectedRevision: listed.revision });
    await vi.waitFor(() => expect(child.controls).toEqual(["get_usage"]));
    await writeFile(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-b" } }));
    answer(usageReply());
    const result = await read;
    expect(result.revision).not.toBe(listed.revision);
    expect(result.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
  });
  it("keeps one revision and the Bot's reading while its processes come and go, also through a new process's first turn", async () => {
    const { adapter, child, start, spawn } = await claudeFixture(); child.answers.get_usage = usageReply();
    const before = await adapter.getAccountQuota({ refresh: false });          // no process yet
    const worker = await start();
    const listed = await adapter.getAccountQuota({ refresh: false });
    expect(listed.revision).toBe(before.revision);
    const read = await adapter.getAccountQuota({ refresh: true, expectedRevision: listed.revision });
    expect(read.revision).toBe(listed.revision); expect(read.snapshot.state).toBe("ready");
    worker.retired = true;
    expect((await adapter.getAccountQuota({ refresh: false })).revision).toBe(read.revision);
    // The next turn starts a new process, which is busy from the start and whose CLI does not answer yet.
    const second = new Child(); spawn.mockReturnValueOnce(second);
    const next = await (adapter as any).getOrCreateWorker("tarobot-other", null, null, "normal", undefined); Object.assign(next, { pendingTurn: {} });
    const during = await adapter.getAccountQuota({ refresh: false });
    expect(during.revision).toBe(read.revision); expect(during.snapshot.observedAt).toBe(read.snapshot.observedAt);
    expect(during.snapshot.pools[0].windows).toHaveLength(2);
    // Asked on its turn, it answers with the newer figures, and those replace the kept ones.
    second.answers.get_usage = { ...usageReply(), rate_limits: { five_hour: { utilization: 40, resets_at: future(3) }, seven_day: { utilization: 70, resets_at: future(90) }, seven_day_opus: null } };
    const newer = await adapter.getAccountQuota({ refresh: true });
    expect(newer.revision).toBe(read.revision);
    expect(newer.snapshot.pools[0].windows.map(window => window.metric === "percent" && window.usedPercent)).toEqual([40, 70]);
    expect(second.controls).toEqual(["get_usage"]);
    Object.assign(next, { pendingTurn: null });
  });
  it("drops the kept reading when the login state on disk changes or a process answers that the login has no windows", async () => {
    const { f, adapter, child, start, spawn } = await claudeFixture(); child.answers.get_usage = usageReply();
    const worker = await start(); await adapter.getAccountQuota({ refresh: true }); worker.retired = true;
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toHaveLength(1);
    // A process on an API key answers: nothing of the earlier login is shown any more.
    const keyed = new Child(); keyed.answers.get_usage = { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null }; spawn.mockReturnValueOnce(keyed);
    await (adapter as any).getOrCreateWorker("tarobot-other", null, null, "normal", undefined);
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unsupported", pools: [] });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
    // Another login written to disk: an earlier reading is not this login's.
    const again = await claudeFixture(); again.child.answers.get_usage = usageReply();
    const first = await again.start(); const shown = await again.adapter.getAccountQuota({ refresh: true }); first.retired = true;
    await mkdir(path.join(again.f.home, ".claude"), { recursive: true });
    await writeFile(path.join(again.f.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-b" } }));
    const changed = await again.adapter.getAccountQuota({ refresh: false });
    expect(changed.revision).not.toBe(shown.revision); expect(changed.snapshot.pools).toEqual([]);
    void f;
  });
  it("does not attribute a process started under another login to the current one", async () => {
    const { f, adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply();
    await start();
    await adapter.getAccountQuota({ refresh: true });
    await mkdir(path.join(f.home, ".claude"), { recursive: true });
    await writeFile(path.join(f.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-b" } }));
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot.pools).toEqual([]);
    expect(child.controls).toEqual(["get_usage"]);
  });
  it("answers no reading for another revision or a cancelled read, without asking", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_usage = usageReply(); await start();
    expect((await adapter.getAccountQuota({ refresh: true, expectedRevision: "other" })).snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
    expect((await adapter.getAccountQuota({ refresh: true, signal: AbortSignal.abort() })).snapshot).toMatchObject({ reason: "cancelled", pools: [] });
    expect(child.controls).toEqual([]);
  });
});
describe("Claude context usage of one conversation", () => {
  const context = { totalTokens: 17_669, maxTokens: 200_000, rawMaxTokens: 1_000_000, percentage: 9, autoCompactThreshold: 167_000, isAutoCompactEnabled: true, model: "private", categories: [] };
  it("is Claude's own accounting from the conversation's running process", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_context_usage = context; await start();
    expect(await adapter.getContextUsage("tarobot-fixture")).toEqual({ pressureTokens: 17_669, contextWindow: 200_000, autoCompactTokens: 167_000 });
    child.answers.get_context_usage = { ...context, isAutoCompactEnabled: false };
    expect(await adapter.getContextUsage("tarobot-fixture")).toEqual({ pressureTokens: 17_669, contextWindow: 200_000 });
    expect(child.controls).toEqual(["get_context_usage", "get_context_usage"]); expect(child.methods).toEqual([]);
  });
  it("is not asked during a turn: the last answer for the same session stands", async () => {
    const { adapter, child, start } = await claudeFixture(); child.answers.get_context_usage = context; const worker = await start();
    worker.pendingTurn = {};
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull(); expect(child.controls).toEqual([]);
    worker.pendingTurn = null;
    expect(await adapter.getContextUsage("tarobot-fixture")).toMatchObject({ pressureTokens: 17_669 });
    child.answers.get_context_usage = { ...context, totalTokens: 90_000 }; worker.nativeTurnOpen = true;
    expect(await adapter.getContextUsage("tarobot-fixture")).toMatchObject({ pressureTokens: 17_669 });
    // Another session on the same process (after /clear) has no answer of its own yet.
    worker.currentSessionId = "another-session";
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
    expect(child.controls).toEqual(["get_context_usage"]);
  });
  it("does not give a session the answer asked for the session before it", async () => {
    const { adapter, child, start } = await claudeFixture(); const worker = await start();
    worker.currentSessionId = "first-session";
    const answer = holdControls(child);
    const read = adapter.getContextUsage("tarobot-fixture");
    await vi.waitFor(() => expect(child.controls).toEqual(["get_context_usage"]));
    worker.currentSessionId = "second-session";
    answer(context);
    expect(await read).toBeNull();
    worker.nativeTurnOpen = true;
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
  });
  it("has no reading without a running process, and starts none", async () => {
    const { adapter, child, spawn, start } = await claudeFixture(); child.answers.get_context_usage = context;
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull(); expect(spawn).not.toHaveBeenCalled();
    const worker = await start();
    expect(await adapter.getContextUsage("tarobot-other")).toBeNull();
    worker.retired = true;
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
    expect(child.controls).toEqual([]);
  });
  it("has no reading for a malformed answer, and asks a refusing CLI once", async () => {
    const { adapter, child, start } = await claudeFixture(); await start();
    for (const answer of [{}, { totalTokens: "1", maxTokens: 10 }, { totalTokens: 1, maxTokens: 0 }, { totalTokens: -1, maxTokens: 10 }]) {
      child.answers.get_context_usage = answer;
      expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
    }
    child.controls.length = 0; child.refuse.add("get_context_usage");
    expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull(); expect(await adapter.getContextUsage("tarobot-fixture")).toBeNull();
    expect(child.controls).toEqual(["get_context_usage"]);
  });
});
it("does not treat opaque native Keychain or dynamic helpers as proof of a stable account", async () => {
  const f = await fixture();
  await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  const cache = new AdapterQuotaCache("codex", "codex", f.env, f.root);
  expect(cache.capture("live").verifiable).toBe(false);
  const claude = new AdapterQuotaCache("claude", "claude", { HOME: f.home }, f.root);
  expect(claude.capture("live").verifiable).toBe(false);
});
it("does not read an oversized credential file into an unbounded buffer", async () => {
  const f = await fixture();
  await writeFile(path.join(f.codexHome, "auth.json"), " ".repeat(1024 * 1024 + 1));
  const cache = new AdapterQuotaCache("codex", "codex", f.env, f.root);
  expect(cache.capture("live").verifiable).toBe(false);
});

it("joins both quota and history helpers on Process adapter destruction", async () => {
  const f = await fixture(), children: Child[] = [];
  const adapter = new ProcessCodexAdapter("codex", f.env, () => {
    const child = new Child(); child.hold.add("initialize"); child.closeDelayMs = 30; children.push(child); return child;
  }, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const quota = adapter.getAccountQuota({ refresh: true });
  const history = adapter.getHistoryState("thread-fixture");
  await vi.waitFor(() => expect(children).toHaveLength(2));
  expect(children.every(child => !child.closed)).toBe(true);
  await adapter.destroy();
  expect(children.every(child => child.closed)).toBe(true);
  expect((await quota).snapshot.reason).toBe("cancelled");
  expect(await history).toMatchObject({ blocked: "not_ready" });
  expect(children.flatMap(child => child.methods)).not.toContain("thread/fork");
  expect(adapter.hasPendingNativeWork()).toBe(false);
});

// #47-B: Codex's public account/read separates "not signed in" from "credential source cannot be verified".
// Synthetic identities only; nothing here reads a real login, Keychain item or browser state.
async function opaqueFixture(kind: "missing" | "keyring") {
  const f = await fixture();
  if (kind === "missing") await rm(path.join(f.codexHome, "auth.json"));
  else { await rm(path.join(f.codexHome, "auth.json")); await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n'); }
  const children: Child[] = [], accounts: unknown[][] = [];
  const limits: unknown[] = [];
  const spawn = vi.fn(() => { const child = new Child(); child.accounts = accounts.shift() ?? []; child.limits = limits.shift(); children.push(child); return child; });
  const adapter = new ProcessCodexAdapter("codex", f.env, spawn, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  return { adapter, spawn, children, accounts, limits };
}
const methodsOf = (child: Child) => child.methods.filter(method => !["initialize", "initialized"].includes(method));
it("an explicit refresh lets native Codex report that no account is signed in", async () => {
  const f = await opaqueFixture("missing");
  const cached = await f.adapter.getAccountQuota({ refresh: false });
  expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "scope_unverifiable", pools: [] }); expect(f.spawn).not.toHaveBeenCalled();
  f.accounts.push([{ account: null, requiresOpenaiAuth: true }]);
  const result = await f.adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
  expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "codex_usage" });
  expect(methodsOf(f.children[0]!)).toEqual(["account/read"]); expect(f.children[0]!.closed).toBe(true);
});
it("a keyring login is read once through native identity checks and never retained", async () => {
  const f = await opaqueFixture("keyring");
  const first = await f.adapter.getAccountQuota({ refresh: false });
  expect(first.snapshot.reason).toBe("scope_unverifiable");
  const result = await f.adapter.getAccountQuota({ refresh: true, expectedRevision: first.revision });
  expect(result.snapshot).toMatchObject({ state: "ready", authMode: "subscription" }); expect(result.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 25 });
  expect(result).not.toHaveProperty("proof");
  expect(methodsOf(f.children[0]!)).toEqual(["account/read", "account/rateLimits/read", "account/read"]);
  // Later cache reads cannot prove the keyring still holds that account.
  expect((await f.adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  expect(f.spawn).toHaveBeenCalledOnce();
});
it("a keyring account switch during the read is rejected without values", async () => {
  const f = await opaqueFixture("keyring");
  f.accounts.push([account, { ...account, account: { ...account.account, email: "second@example.invalid" }, userId: "second-user" }]);
  const result = await f.adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
});
it("a native API-key answer stays unsupported and never reads subscription limits", async () => {
  const f = await opaqueFixture("missing");
  f.accounts.push([{ account: { type: "apiKey" }, requiresOpenaiAuth: false }]);
  const result = await f.adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", pools: [] });
  expect(methodsOf(f.children[0]!)).toEqual(["account/read"]);
});
it("a live keyring worker answers one explicit Gateway refresh without being stopped or cached", async () => {
  const f = await fixture(), child = new Child();
  await rm(path.join(f.codexHome, "auth.json")); await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
  const adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read: options => adapter.getAccountQuota(options) });
  const listed = await run({ scopeId: "bot", refresh: false });
  expect(listed.value).toMatchObject({ reason: "scope_unverifiable", capability: { mode: "active" } }); expect(child.methods).not.toContain("account/read");
  const refreshed = await run({ scopeId: "bot", refresh: true, expectedRevision: listed.revision });
  expect(refreshed.value).toMatchObject({ state: "ready", sharing: "unverified" }); expect(child.killCount).toBe(0);
  expect((await run({ scopeId: "bot", refresh: false })).value).toMatchObject({ reason: "scope_unverifiable", pools: [] });
});
it("Claude's unverifiable passive source stays hidden even on an explicit refresh", async () => {
  const f = await fixture();
  const cache = new AdapterQuotaCache("claude", "claude", { HOME: f.home }, f.root);
  const scope = cache.capture("live");
  expect(scope.verifiable).toBe(false);
  expect(cache.response(scope, { refresh: true })?.snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
});
// Real-CLI acceptance, opt-in: TAROBIRD_QUOTA_REAL_CODEX=/path/to/codex. Empty isolated home, file credential
// store, no API key: no real login, Keychain item or network account is consulted, and no thread is created.
it.skipIf(!process.env.TAROBIRD_QUOTA_REAL_CODEX)("real Codex CLI reports no sign-in for an empty isolated home without starting a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-real-codex-")); roots.push(root);
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH };
  const adapter = new ProcessCodexAdapter(process.env.TAROBIRD_QUOTA_REAL_CODEX!, env, undefined, undefined, undefined, undefined, root);
  disposals.push(() => adapter.destroy());
  const cached = await adapter.getAccountQuota({ refresh: false });
  expect(cached.snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  const result = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision, timeoutMs: 7000 });
  expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "codex_usage" });
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.reason).toBe("scope_unverifiable");
  expect(adapter.hasPendingNativeWork()).toBe(false);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(codexHome)).not.toContain("sessions");
  expect(await readdir(codexHome)).not.toContain("auth.json");
}, 30_000);

// Codex 0.170.0 schema: GetAccountResponse.userId is "when available", ChatgptAccount.email may be null and
// GetAccountRateLimitsResponse.accountId is "when supplied by the backend". Upstream guarantees no identity, so a
// one-shot read of an opaque credential source must carry a stable user and billed account itself.
describe("one-shot opaque Codex reads require a distinguishable native account", () => {
  const limitsB = { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 60 } }, accountId: "workspace-B" };
  const chatgpt = (extra: Record<string, unknown> = {}, accountExtra: Record<string, unknown> = {}) => ({ requiresOpenaiAuth: true, account: { type: "chatgpt", ...accountExtra }, ...extra });
  const rejected = async (account: unknown, limits: unknown = limitsB) => {
    const f = await opaqueFixture("keyring");
    f.accounts.push([account, account]); f.limits.push(limits);
    const result = await f.adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ pools: [], constraints: [], availability: "unknown" });
    expect(result.snapshot.state).not.toBe("ready"); expect(result).not.toHaveProperty("proof");
    return result.snapshot.reason;
  };
  it("rejects the reported counterexample: type only, no user, no billed-account link", async () => {
    expect(await rejected(chatgpt())).toBe("scope_unverifiable");
  });
  it.each([
    ["plan only", chatgpt({}, { planType: "pro" })],
    ["email and plan without a user id", chatgpt({}, { email: "fixture@example.invalid", planType: "pro" })],
    ["empty user id", chatgpt({ userId: "" }, { planType: "pro" })],
    ["whitespace user id", chatgpt({ userId: "   " }, { planType: "pro" })],
    ["user id with inner space", chatgpt({ userId: "user one" }, { planType: "pro" })],
    ["over-long user id", chatgpt({ userId: "u".repeat(513) }, { planType: "pro" })],
  ])("rejects an unidentifiable account (%s)", async (_label, account) => {
    expect(await rejected(account)).toBe("scope_unverifiable");
  });
  it("rejects a native user id beyond the native identity bound as an invalid response", async () => {
    expect(await rejected(chatgpt({ userId: "u".repeat(4097) }))).toBe("invalid_response");
  });
  it.each([
    ["missing", { rateLimits: { primary: { usedPercent: 30 } } }],
    ["empty", { rateLimits: { primary: { usedPercent: 30 } }, accountId: "" }],
    ["over-long", { rateLimits: { primary: { usedPercent: 30 } }, accountId: "a".repeat(513) }],
  ])("rejects a user without a %s billed account id", async (_label, limits) => {
    expect(await rejected(chatgpt({ userId: "fixture-user" }, { planType: "pro" }), limits)).toBe("scope_unverifiable");
  });
  it("still shows a one-shot reading when the native user and billed account are both identified", async () => {
    const f = await opaqueFixture("keyring");
    const account = chatgpt({ userId: "fixture-user", ...routing("workspace-B") }, { planType: "pro", email: null });
    f.accounts.push([account, account]); f.limits.push(limitsB);
    const result = await f.adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "ready" }); expect(result.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 30 });
    expect((await f.adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  });
  it("keeps native not-signed-in and API-key answers without requiring an account id", async () => {
    const missing = await opaqueFixture("keyring"); missing.accounts.push([{ account: null, requiresOpenaiAuth: true }]);
    expect((await missing.adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "login_required", pools: [] });
    const key = await opaqueFixture("keyring"); key.accounts.push([{ account: { type: "apiKey" }, requiresOpenaiAuth: false }]);
    expect((await key.adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "mode_not_supported", authMode: "api_key", pools: [] });
  });
  it("keeps a file-verified login readable even when native identity fields are absent", async () => {
    const f = await fixture(), child = new Child();
    child.accounts = [chatgpt({}, { planType: "pro" }), chatgpt({}, { planType: "pro" })]; child.limits = limitsB;
    const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    const result = await adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "ready" });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 30 });
  });
});

// Recorded from real codex-cli 0.170.0 against a loopback backend answering 401 (FABLE quota-fable-lab).
const real401 = {
  account: { code: -32603, message: "workspace routing discovery unauthorized (401)" },
  limits: { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:60045/backend-api/wham/usage failed: 401 Unauthorized; content-type=application/json; body={\"detail\":\"synthetic unauthorized\"}" },
};
describe("native Codex login revocation is reported as login required", () => {
  const read = async (errors: Child["errors"], opaque = false) => {
    const f = await fixture(), child = new Child(); child.errors = errors;
    if (opaque) { await rm(path.join(f.codexHome, "auth.json")); await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n'); }
    const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    return (await adapter.getAccountQuota({ refresh: true })).snapshot;
  };
  it.each([false, true])("account/read 401 means sign in again (opaque=%s)", async opaque => {
    expect(await read({ "account/read": real401.account }, opaque)).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
  });
  it("rate-limit 401 after a readable account means sign in again", async () => {
    expect(await read({ "account/rateLimits/read": real401.limits })).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
  });
  it.each([
    ["other -32603 discovery failure", { "account/read": { code: -32603, message: "workspace routing discovery failed" } }],
    ["missing backend origin", { "account/read": { code: -32603, message: "workspace routing discovery missing backend origin" } }],
    ["rate limited", { "account/rateLimits/read": { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:1/backend-api/wham/usage failed: 429 Too Many Requests; body={}" } }],
    ["server error whose body mentions 401", { "account/rateLimits/read": { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:1/backend-api/wham/usage failed: 500 Internal Server Error; body={\"detail\":\"401 Unauthorized\"}" } }],
    ["offline transport text", { "account/read": { code: -32603, message: "error sending request: connection refused (401)" } }],
    ["same text with a different JSON-RPC code", { "account/read": { code: -32600, message: "workspace routing discovery unauthorized (401)" } }],
    ["unauthorized text with a suffix", { "account/read": { code: -32603, message: "workspace routing discovery unauthorized (401); retry later" } }],
  ])("does not report %s as login required", async (_label, errors) => {
    const snapshot = await read(errors);
    expect(snapshot.state).not.toBe("login_required"); expect(snapshot).toMatchObject({ pools: [] });
  });
});

// Q1: neither the stable nor the experimental 0.170.0 protocol ties account/rateLimits/read to
// workspaceRouting; its accountId is "when supplied by the backend". An opaque one-shot reading is shown
// only when the user, the workspace in both account/read replies and the usage reply's accountId agree.
// Shapes below are FABLE's real codex-cli 0.170.0 replies (synthetic login, loopback backend).
describe("one-shot opaque reads bind the usage snapshot to the current workspace", () => {
  const realAccount = { account: { type: "chatgpt", email: "synthetic@example.invalid", planType: "pro", workspaceName: "Synthetic Workspace" }, userId: "user-SYNTHETIC-1", requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: "acct-SYNTHETIC-1", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" } };
  const realLimits = (accountId: string | null) => ({ ordinaryUsageAllowed: accountId ? true : null, rateLimits: { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1795213966 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1795296766 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null }, rateLimitResetCredits: null, accountId, rateLimitUpsell: null });
  const run = async (before: unknown, after: unknown, limits: unknown, kind: "keyring" | "file" = "keyring") => {
    if (kind === "file") {
      const f = await fixture(), child = new Child(); child.accounts = [before, after]; child.limits = limits;
      const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
      disposals.push(() => adapter.destroy());
      return (await adapter.getAccountQuota({ refresh: true })).snapshot;
    }
    const f = await opaqueFixture(kind); f.accounts.push([before, after]); f.limits.push(limits);
    return (await f.adapter.getAccountQuota({ refresh: true })).snapshot;
  };
  it("shows the real reply when user, both workspaces and the usage account agree", async () => {
    const snapshot = await run(realAccount, realAccount, realLimits("acct-SYNTHETIC-1"));
    expect(snapshot).toMatchObject({ state: "ready" }); expect(snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 30 });
  });
  it("keeps unknown when the usage reply does not name its account, even though routing does", async () => {
    expect(await run(realAccount, realAccount, realLimits(null))).toMatchObject({ state: "unknown", reason: "scope_unverifiable", pools: [] });
  });
  it("keeps unknown when account/read gives no workspace to compare with the usage account", async () => {
    const { workspaceRouting: _omit, ...withoutRouting } = realAccount;
    expect(await run(withoutRouting, withoutRouting, realLimits("acct-SYNTHETIC-1"))).toMatchObject({ reason: "scope_unverifiable", pools: [] });
    expect(await run({ ...realAccount, workspaceRouting: null }, { ...realAccount, workspaceRouting: null }, realLimits("acct-SYNTHETIC-1"))).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  });
  it("keeps unknown for the real reply without a user id", async () => {
    const noUser = { ...realAccount, userId: null };
    expect(await run(noUser, noUser, realLimits("acct-SYNTHETIC-1"))).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  });
  it.each([
    ["workspace changes between the two account reads", { ...realAccount, workspaceRouting: { ...realAccount.workspaceRouting, chatgptAccountId: "acct-SYNTHETIC-2" } }, realLimits("acct-SYNTHETIC-1")],
    ["usage account differs from the routed workspace", realAccount, realLimits("acct-SYNTHETIC-2")],
  ])("rejects when the %s", async (_label, after, limits) => {
    expect(await run(realAccount, after, limits)).toMatchObject({ reason: "auth_changed", pools: [] });
  });
  it("keeps a file-verified login readable without usage account or routing", async () => {
    const { workspaceRouting: _omit, ...withoutRouting } = realAccount;
    expect(await run(withoutRouting, withoutRouting, realLimits(null), "file")).toMatchObject({ state: "ready" });
  });
});

// Recorded from real codex-cli 0.170.0 against a loopback backend answering 429 (quotafix-evidence/probes/codex-raw-errors.mjs).
const real429 = {
  json: { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:63831/backend-api/wham/usage failed: 429 Too Many Requests; content-type=application/json; body={\"detail\":\"synthetic rate limit\"}" },
  text: { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:63837/backend-api/wham/usage failed: 429 Too Many Requests; content-type=text/plain; body=Too Many Requests" },
  // A 429 on account discovery reaches account/read without its status: not identifiable.
  discovery: { code: -32603, message: "workspace routing discovery failed" },
  body500: { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:63849/backend-api/wham/usage failed: 500 Internal Server Error; content-type=application/json; body={\"detail\":\"upstream said 429 Too Many Requests\"}" },
};
describe("native Codex rate limiting on the quota read", () => {
  const adapterWith = async (child: Child) => {
    const f = await fixture(), adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy()); return adapter;
  };
  it.each(["json", "text"] as const)("a real usage 429 (%s body) is rate limited, not sign-in or a generic error", async kind => {
    const child = new Child(); child.errors = { "account/rateLimits/read": real429[kind] };
    expect((await (await adapterWith(child)).getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "unavailable", reason: "rate_limited", pools: [] });
  });
  it.each([
    ["429 swallowed by account discovery", { "account/read": real429.discovery }],
    ["500 whose body mentions 429", { "account/rateLimits/read": real429.body500 }],
    ["429 text on account/read", { "account/read": { code: -32603, message: real429.json.message } }],
    ["429 text with another JSON-RPC code", { "account/rateLimits/read": { code: -32600, message: real429.json.message } }],
    ["429 with a suffix instead of the field separator", { "account/rateLimits/read": { code: -32603, message: "failed to fetch codex rate limits: GET http://127.0.0.1:1/backend-api/wham/usage failed: 429 Too Many Requests later" } }],
  ])("does not guess rate limiting from %s", async (_label, errors) => {
    const child = new Child(); child.errors = errors;
    const snapshot = (await (await adapterWith(child)).getAccountQuota({ refresh: true })).snapshot;
    expect(snapshot.reason).not.toBe("rate_limited"); expect(snapshot.state).not.toBe("login_required");
  });
  it("recovers to a fresh reading once the native read succeeds again", async () => {
    // Each explicit read uses its own short-lived helper process.
    let errors: Child["errors"] = {};
    const f = await fixture(), adapter = new ProcessCodexAdapter("codex", f.env, () => { const child = new Child(); child.errors = errors; return child; }, undefined, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "ready" });
    errors = { "account/rateLimits/read": real429.json };
    const limited = (await adapter.getAccountQuota({ refresh: true })).snapshot;
    // The earlier reading is kept only as a marked, stale last reading with the limit as its reason.
    expect(limited).toMatchObject({ state: "stale", reason: "rate_limited" });
    errors = {};
    const recovered = (await adapter.getAccountQuota({ refresh: true })).snapshot;
    expect(recovered).toMatchObject({ state: "ready" }); expect(recovered.reason).toBeUndefined();
    expect(recovered.pools[0]?.windows[0]).toMatchObject({ usedPercent: 25 });
  });

  it("produces matching Hub-keyed account proofs across distinct Codex adapters on the same account without colliding revisions", async () => {
    const f = await fixture();
    const sharedHubKey = Buffer.alloc(32, 0x42);
    const otherHubKey = Buffer.alloc(32, 0x99);
    const adapterA = new ProcessCodexAdapter("codex", f.env, () => new Child(), undefined, undefined, undefined, f.root);
    const adapterB = new ProcessCodexAdapter("codex", f.env, () => new Child(), undefined, undefined, undefined, f.root);
    disposals.push(() => adapterA.destroy(), () => adapterB.destroy());

    const resA = await adapterA.getAccountQuota({ refresh: true, accountProofKey: sharedHubKey });
    const resB = await adapterB.getAccountQuota({ refresh: true, accountProofKey: sharedHubKey });
    expect(resA.revision).not.toBe(resB.revision);
    expect(resA.proof?.accountKey).toMatch(/^[0-9a-f]{64}$/);
    expect(resA.proof?.accountKey).toBe(resB.proof?.accountKey);
    expect(resA.proof?.scopeStamp).toBe(resA.revision);
    expect(resB.proof?.scopeStamp).toBe(resB.revision);

    // Cached reads retain the proof for the same Hub key, and strip it if the Hub key changes
    const cachedSame = await adapterA.getAccountQuota({ refresh: false, accountProofKey: sharedHubKey });
    expect(cachedSame.proof?.accountKey).toBe(resA.proof?.accountKey);
    const cachedRotated = await adapterA.getAccountQuota({ refresh: false, accountProofKey: otherHubKey });
    expect(cachedRotated.proof).toBeUndefined();
  });
});

describe("Windows Host Claude quota home resolution, invocation, and framing", () => {
  it("prefers USERPROFILE over HOME on win32 (e.g. Git for Windows / MSYS HOME) and supports case-insensitive keys", async () => {
    const f = await fixture();
    const msysHome = path.join(f.root, "msys-home");
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(msysHome, ".claude"), { recursive: true });
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-a" } }));

    const env = { HOME: msysHome, UserProfile: winProfile };
    const winCache = new AdapterQuotaCache("claude", "claude", env, f.root, undefined, "win32");
    const first = winCache.capture("usage");
    expect(first.authMode).toBe("subscription");
    expect(first.verifiable).toBe(true);

    // Changing credentials under USERPROFILE changes credentialRevision; changing MSYS HOME does not.
    await writeFile(path.join(msysHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-ignored" } }));
    expect(winCache.capture("usage").credentialRevision).toBe(first.credentialRevision);
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-b" } }));
    expect(winCache.capture("usage").credentialRevision).not.toBe(first.credentialRevision);

    // POSIX platforms continue preferring HOME over USERPROFILE.
    const emptyHome = path.join(f.root, "empty-home");
    await mkdir(emptyHome, { recursive: true });
    const linuxCache = new AdapterQuotaCache("claude", "claude", { HOME: emptyHome, USERPROFILE: winProfile }, f.root, undefined, "linux");
    expect(linuxCache.capture("usage").authMode).toBe("unknown");
    expect(linuxCache.capture("usage").verifiable).toBe(false);

    // Case-insensitive env keys work on win32 for CLAUDE_CONFIG_DIR and cloud flags.
    const customDir = path.join(f.root, "custom-claude");
    await mkdir(customDir, { recursive: true });
    const bedrockCache = new AdapterQuotaCache("claude", "claude", { UserProfile: winProfile, Claude_Config_Dir: customDir, claude_code_use_bedrock: "1" }, f.root, undefined, "win32");
    expect(bedrockCache.capture("usage")).toMatchObject({ authMode: "other", verifiable: true });
    expect(resolveClaudeConfigDir({ HOME: msysHome, UserProfile: winProfile }, "win32")).toBe(path.join(winProfile, ".claude"));
    expect(resolveClaudeConfigDir({ HOME: msysHome, UserProfile: winProfile, Claude_Config_Dir: customDir }, "win32")).toBe(customDir);
  });

  it("keeps win32 quota aligned with macOS: stream rate_limit_event frames do not flip revision or shadow get_usage", async () => {
    const f = await fixture();
    const msysHome = path.join(f.root, "msys-home");
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(msysHome, ".claude"), { recursive: true });
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-sub" } }));

    const child = new Child();
    child.answers.get_usage = usageReply();
    const adapter = new ClaudeStreamAdapter("claude", {
      childEnv: { HOME: msysHome, USERPROFILE: winProfile },
      spawnFn: () => child,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter.destroy());

    const worker = await (adapter as any).getOrCreateWorker("tarobot-win", null, null, "normal", f.root);
    const run = gatewayEngineQuota({ botId: "bot-win", engine: "claude", read: options => adapter.getAccountQuota(options) });
    const initial = await run({ scopeId: "bot-win", refresh: false });
    expect(initial.value).toMatchObject({ state: "unknown", reason: "not_loaded", authMode: "subscription", capability: { mode: "active" } });

    // A partial rate_limit_event (single window or status-only) arrives during a turn.
    // On Windows this must neither change the scope revision nor masquerade as a full ready reading.
    child.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.05 } });
    const afterEvent = await run({ scopeId: "bot-win", refresh: false });
    expect(afterEvent.revision).toBe(initial.revision);
    expect(afterEvent.value).toMatchObject({ state: "unknown", reason: "not_loaded" });
    expect(child.controls).toEqual([]);

    // Explicit refresh succeeds with expectedRevision (no auth_changed) and reads both windows from get_usage.
    const refreshed = await run({ scopeId: "bot-win", refresh: true, expectedRevision: initial.revision });
    expect(refreshed.revision).toBe(initial.revision);
    expect(refreshed.value).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" } });
    expect(refreshed.value.pools[0]?.windows.map(window => [window.id, window.metric === "percent" && window.usedPercent])).toEqual([["five_hour", 12], ["seven_day", 61.5]]);
    expect(child.controls).toEqual(["get_usage"]);

    // Retiring the worker keeps the reading under the same revision; changing USERPROFILE credentials drops it.
    worker.retired = true;
    expect((await adapter.getAccountQuota({ refresh: false })).revision).toBe(initial.revision);
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0]?.windows).toHaveLength(2);
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-other" } }));
    const switched = await adapter.getAccountQuota({ refresh: false });
    expect(switched.revision).not.toBe(initial.revision);
    expect(switched.snapshot.pools).toEqual([]);
  });

  it("still falls back to passive rate_limit_event on win32 when an older CLI refuses get_usage", async () => {
    const f = await fixture();
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-old-cli" } }));

    const child = new Child();
    child.refuse.add("get_usage");
    const adapter = new ClaudeStreamAdapter("claude", {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: () => child,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter.destroy());

    const worker = await (adapter as any).getOrCreateWorker("tarobot-win-old", null, null, "normal", f.root);
    const listed = await adapter.getAccountQuota({ refresh: false });
    child.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.25 } });
    // Before get_usage is asked, the worker stays active so the App asks get_usage first.
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ state: "unknown", reason: "not_loaded" });

    // Once the CLI refuses get_usage, the already-observed passive event is promoted and later events keep updating it.
    const promoted = await adapter.getAccountQuota({ refresh: true, expectedRevision: listed.revision });
    expect(promoted.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 25 });
    child.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 } });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 50 });

    // Retiring the worker clears the passive-only reading.
    worker.retired = true;
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
  });

  it("handles win32 command invocation, npm shim resolution, and slow/chunked CRLF UTF-8 get_usage responses", async () => {
    expect(buildClaudeCommandInvocation('"C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.cmd"', ["-p"], "win32")).toEqual({
      command: "C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.cmd",
      args: ["-p"],
      shell: false,
    });
    expect(buildClaudeCommandInvocation("C:\\Tools\\claude.ps1", ["-p"], "win32")).toEqual({
      command: "C:\\Tools\\claude.ps1",
      args: ["-p"],
      shell: false,
    });

    const f = await fixture();
    const npmBin = path.join(f.root, "npm-bin");
    const cliEntry = path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(cliEntry, "// fixture");
    const cmdShim = path.join(npmBin, "claude.cmd");
    await writeFile(cmdShim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    expect(executableCandidates("claude", { Path: "C:\\Users\\Example\\AppData\\Roaming\\npm", PATHEXT: ".EXE;.CMD" }, "win32")).toEqual([
      "C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.EXE",
      "C:\\Users\\Example\\AppData\\Roaming\\npm\\claude.CMD",
    ]);
    expect(npmShimEntrypoint(cmdShim)).toBe(cliEntry);
    if (process.platform === "win32") expect(resolveEngineExecutable("claude", { PATH: npmBin, PATHEXT: ".EXE;.CMD" }, "win32")?.toLowerCase()).toBe(cmdShim.toLowerCase());

    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-slow" } }));

    const child = new Child();
    let requestId: string | undefined;
    child.stdin.write = ((line: string, callback?: (error?: Error | null) => void) => {
      const request = JSON.parse(line);
      if (request.type === "control_request" && request.request?.subtype === "get_usage") {
        child.controls.push("get_usage");
        requestId = request.request_id;
        callback?.(null);
        return true;
      }
      return true;
    }) as typeof child.stdin.write;

    const adapter = new ClaudeStreamAdapter(cmdShim, {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: () => child,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter.destroy());
    await (adapter as any).getOrCreateWorker("tarobot-win-chunked", null, null, "normal", f.root);

    // Slow initial read times out at timeoutMs, while usageQuestion stays open for the late answer.
    expect((await adapter.getAccountQuota({ refresh: true, timeoutMs: 20 })).snapshot).toMatchObject({ state: "unavailable", reason: "timeout" });

    // Deliver the late answer split across multi-byte UTF-8 Buffer chunks with CRLF endings.
    const payload = Buffer.from(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          rate_limits_available: true,
          note: "Windows 额度",
          rate_limits: {
            five_hour: { utilization: 18, resets_at: future(4) },
            seven_day: { utilization: 42, resets_at: future(100) },
          },
        },
      },
    }) + "\r\n", "utf8");
    const splitPoint = payload.indexOf("额度") + 2;
    child.stdout.emit("data", payload.subarray(0, splitPoint));
    child.stdout.emit("data", payload.subarray(splitPoint));

    await vi.waitFor(async () => {
      const kept = (await adapter.getAccountQuota({ refresh: false })).snapshot;
      expect(kept.state).toBe("ready");
      expect(kept.pools[0]?.windows.map(window => [window.id, window.metric === "percent" && window.usedPercent])).toEqual([["five_hour", 18], ["seven_day", 42]]);
    });
    expect(child.controls).toEqual(["get_usage"]);
  });

  it("does not regress passive quota to an older worker's buffered snapshot when multiple workers refuse get_usage", async () => {
    const f = await fixture();
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-multi-refuse" } }));

    const child1 = new Child(); child1.refuse.add("get_usage");
    const child2 = new Child(); child2.refuse.add("get_usage");
    const spawn = vi.fn().mockReturnValueOnce(child1).mockReturnValueOnce(child2);
    const adapter = new ClaudeStreamAdapter("claude", {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: spawn,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter.destroy());

    const baseNow = Date.now();
    let fakeNow = baseNow;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);

    const w1 = await (adapter as any).getOrCreateWorker("tarobot-w1", null, null, "normal", f.root);
    const w2 = await (adapter as any).getOrCreateWorker("tarobot-w2", null, null, "normal", f.root);
    w1.lastActivityAt = baseNow + 10;
    w2.lastActivityAt = baseNow + 20;

    // W1 buffers an older reading; W2 buffers a newer reading, refuses get_usage, and later receives an even newer reading.
    fakeNow = baseNow + 100;
    child1.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.20 } });
    fakeNow = baseNow + 200;
    child2.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.50 } });

    const first = await adapter.getAccountQuota({ refresh: true });
    expect(child2.controls).toEqual(["get_usage"]);
    expect(child1.controls).toEqual([]);
    expect(first.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 50 });

    fakeNow = baseNow + 300;
    child2.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.80 } });
    const beforeW1 = await adapter.getAccountQuota({ refresh: false });
    expect(beforeW1.revision).toBe(first.revision);
    expect(beforeW1.snapshot.capability.mode).toBe("active");
    expect(beforeW1.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 80 });

    // Next refresh asks W1; W1 refuses get_usage, but its older 20% snapshot must NOT overwrite W2's 80% or flip revision.
    fakeNow = baseNow + 350;
    const afterW1 = await adapter.getAccountQuota({ refresh: true, expectedRevision: beforeW1.revision });
    expect(child1.controls).toEqual(["get_usage"]);
    expect(afterW1.revision).toBe(beforeW1.revision);
    expect(afterW1.snapshot.observedAt).toBe(beforeW1.snapshot.observedAt);
    expect(afterW1.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 80 });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ capability: { mode: "passive" } });

    // Same-millisecond tie-breaking: a newly observed event on W1 after W2 still promotes W1 when it is newer by arrival order.
    fakeNow = baseNow + 300;
    child1.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.90 } });
    const afterNewerW1 = await adapter.getAccountQuota({ refresh: false });
    expect(afterNewerW1.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 90 });
    nowSpy.mockRestore();
  });

  it("keeps active keptUsage authoritative over passive quotaSource across workers in both directions", async () => {
    const f = await fixture();
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-win-mixed-workers" } }));

    // Direction 1: W1 refuses get_usage first (passive quotaSource), then W2 answers get_usage (active keptUsage).
    const oldChild = new Child(); oldChild.refuse.add("get_usage");
    const newChild = new Child(); newChild.answers.get_usage = usageReply();
    const spawn1 = vi.fn().mockReturnValueOnce(oldChild).mockReturnValueOnce(newChild);
    const adapter1 = new ClaudeStreamAdapter("claude", {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: spawn1,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter1.destroy());

    const wOld = await (adapter1 as any).getOrCreateWorker("tarobot-old", null, null, "normal", f.root);
    oldChild.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.25 } });
    const passive = await adapter1.getAccountQuota({ refresh: true });
    expect(passive.snapshot.pools[0]?.windows).toHaveLength(1);

    await (adapter1 as any).getOrCreateWorker("tarobot-new", null, null, "normal", f.root);
    const active = await adapter1.getAccountQuota({ refresh: true, expectedRevision: passive.revision });
    expect(active.revision).not.toBe(passive.revision);
    expect(active.snapshot).toMatchObject({ state: "ready", capability: { mode: "active" } });
    expect(active.snapshot.pools[0]?.windows.map(window => [window.id, window.metric === "percent" && window.usedPercent])).toEqual([["five_hour", 12], ["seven_day", 61.5]]);

    // Subsequent passive frames on W1 and retiring W1 must NOT re-pin quotaSource or flip revision.
    oldChild.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.95 } });
    const afterOldEvent = await adapter1.getAccountQuota({ refresh: false });
    expect(afterOldEvent.revision).toBe(active.revision);
    expect(afterOldEvent.snapshot.pools[0]?.windows).toHaveLength(2);

    wOld.retired = true;
    const afterOldRetire = await adapter1.getAccountQuota({ refresh: false });
    expect(afterOldRetire.revision).toBe(active.revision);
    expect(afterOldRetire.snapshot.pools[0]?.windows).toHaveLength(2);

    // Direction 2: W1 populates active keptUsage first, then W2 refuses get_usage (both without and with a passive event).
    const activeChild = new Child(); activeChild.answers.get_usage = usageReply();
    const refusingNoEvent = new Child(); refusingNoEvent.refuse.add("get_usage");
    const refusingWithEvent = new Child(); refusingWithEvent.refuse.add("get_usage");
    const spawn2 = vi.fn()
      .mockReturnValueOnce(activeChild)
      .mockReturnValueOnce(refusingNoEvent)
      .mockReturnValueOnce(refusingWithEvent);
    const adapter2 = new ClaudeStreamAdapter("claude", {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: spawn2,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter2.destroy());

    const wActive = await (adapter2 as any).getOrCreateWorker("tarobot-a", null, null, "normal", f.root);
    const baseline = await adapter2.getAccountQuota({ refresh: true });
    expect(baseline.snapshot.pools[0]?.windows).toHaveLength(2);

    const wRefuseEmpty = await (adapter2 as any).getOrCreateWorker("tarobot-b", null, null, "normal", f.root);
    wActive.lastActivityAt = 1_000;
    wRefuseEmpty.lastActivityAt = 2_000;
    const afterEmptyRefuse = await adapter2.getAccountQuota({ refresh: true, expectedRevision: baseline.revision });
    expect(refusingNoEvent.controls).toEqual(["get_usage"]);
    expect(afterEmptyRefuse.revision).toBe(baseline.revision);
    expect(afterEmptyRefuse.snapshot).toMatchObject({ state: "ready", capability: { mode: "active" } });
    expect(afterEmptyRefuse.snapshot.reason).toBeUndefined();
    expect(afterEmptyRefuse.snapshot.pools[0]?.windows).toHaveLength(2);

    const wRefusePassive = await (adapter2 as any).getOrCreateWorker("tarobot-c", null, null, "normal", f.root);
    wRefusePassive.lastActivityAt = 3_000;
    refusingWithEvent.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.77 } });
    const afterPassiveRefuse = await adapter2.getAccountQuota({ refresh: true, expectedRevision: baseline.revision });
    expect(refusingWithEvent.controls).toEqual(["get_usage"]);
    expect(afterPassiveRefuse.revision).toBe(baseline.revision);
    expect(afterPassiveRefuse.snapshot).toMatchObject({ state: "ready", capability: { mode: "active" } });
    expect(afterPassiveRefuse.snapshot.pools[0]?.windows.map(window => [window.id, window.metric === "percent" && window.usedPercent])).toEqual([["five_hour", 12], ["seven_day", 61.5]]);

    // Direction 1b: an unsupported get_usage answer also clears any prior passive quotaSource.
    const oldChild3 = new Child(); oldChild3.refuse.add("get_usage");
    const unsupportedChild3 = new Child(); unsupportedChild3.answers.get_usage = { rate_limits_available: false, rate_limits: null };
    const spawn3 = vi.fn().mockReturnValueOnce(oldChild3).mockReturnValueOnce(unsupportedChild3);
    const adapter3 = new ClaudeStreamAdapter("claude", {
      childEnv: { USERPROFILE: winProfile },
      spawnFn: spawn3,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      platform: "win32",
    });
    disposals.push(() => adapter3.destroy());
    await (adapter3 as any).getOrCreateWorker("tarobot-u1", null, null, "normal", f.root);
    oldChild3.event({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.30 } });
    const priorPassive = await adapter3.getAccountQuota({ refresh: true });
    expect(priorPassive.snapshot.pools[0]?.windows).toHaveLength(1);
    await (adapter3 as any).getOrCreateWorker("tarobot-u2", null, null, "normal", f.root);
    const unsupported = await adapter3.getAccountQuota({ refresh: true, expectedRevision: priorPassive.revision });
    expect(unsupported.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", pools: [] });
    expect((await adapter3.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "not_loaded", pools: [] });
  });

  it("handles win32 case-insensitive env lookup and normalization for antigravity", async () => {
    const f = await fixture();
    const winProfile = path.join(f.root, "win-profile");
    await mkdir(winProfile, { recursive: true });

    const apiEnv: NodeJS.ProcessEnv = { UserProfile: winProfile, Gemini_Api_Key: "key-1" };
    const agyApi = new AdapterQuotaCache("antigravity", "agy", apiEnv, f.root, undefined, "win32");
    const scope1 = agyApi.capture("process");
    expect(scope1).toMatchObject({ authMode: "api_key", verifiable: true });
    expect(agyApi.response(scope1, { refresh: false })?.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key" });

    apiEnv.Gemini_Api_Key = "key-2";
    const scope2 = agyApi.capture("process");
    expect(scope2.credentialRevision).not.toBe(scope1.credentialRevision);

    const adcEnv: NodeJS.ProcessEnv = { UserProfile: winProfile, Google_Application_Credentials: path.join(f.root, "adc-a.json") };
    const agyAdc = new AdapterQuotaCache("antigravity", "agy", adcEnv, f.root, undefined, "win32");
    const adcScope1 = agyAdc.capture("process");
    expect(adcScope1).toMatchObject({ authMode: "adc", verifiable: true });
    expect(agyAdc.response(adcScope1, { refresh: false })?.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "adc" });
    adcEnv.Google_Application_Credentials = path.join(f.root, "adc-b.json");
    expect(agyAdc.capture("process").credentialRevision).not.toBe(adcScope1.credentialRevision);

    // POSIX remains case-sensitive for antigravity env vars.
    const linuxAgy = new AdapterQuotaCache("antigravity", "agy", { HOME: winProfile, Gemini_Api_Key: "key-1" }, f.root, undefined, "linux");
    const linuxScope = linuxAgy.capture("process");
    expect(linuxScope.authMode).toBe("unknown");
    expect(linuxAgy.response(linuxScope, { refresh: false })?.snapshot).toMatchObject({ state: "login_required", reason: "login_required" });
  });

  it("handles case-colliding Windows env keys consistently across AdapterQuotaCache and resolveClaudeConfigDir", async () => {
    const f = await fixture();
    const winProfile = path.join(f.root, "win-profile");
    const customDir = path.join(f.root, "custom-claude");
    await mkdir(path.join(winProfile, ".claude"), { recursive: true });
    await mkdir(customDir, { recursive: true });
    await writeFile(path.join(winProfile, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-default-dir" } }));

    // 1. Mutating either colliding case variant changes credentialRevision (neither entry is silently dropped).
    const dupEnv: NodeJS.ProcessEnv = { USERPROFILE: winProfile, ANTHROPIC_API_KEY: "key-a", Anthropic_Api_Key: "key-b" };
    const dupCache = new AdapterQuotaCache("claude", "claude", dupEnv, f.root, undefined, "win32");
    const rev1 = dupCache.capture("usage").credentialRevision;
    dupEnv.ANTHROPIC_API_KEY = "key-c";
    const rev2 = dupCache.capture("usage").credentialRevision;
    expect(rev2).not.toBe(rev1);
    dupEnv.Anthropic_Api_Key = "key-d";
    const rev3 = dupCache.capture("usage").credentialRevision;
    expect(rev3).not.toBe(rev2);

    // 2. Explicit canonical empty override ("") clears an inherited mixed-case key instead of falling back to it.
    const clearedKeyEnv: NodeJS.ProcessEnv = { USERPROFILE: winProfile, ANTHROPIC_API_KEY: "", Anthropic_Api_Key: "stale-key" };
    const clearedKeyCache = new AdapterQuotaCache("claude", "claude", clearedKeyEnv, f.root, undefined, "win32");
    expect(clearedKeyCache.capture("usage")).toMatchObject({ authMode: "subscription", verifiable: true });

    // 3. Explicit empty or whitespace CLAUDE_CONFIG_DIR overrides agree between AdapterQuotaCache and resolveClaudeConfigDir.
    for (const override of ["", "   "]) {
      const dirEnv: NodeJS.ProcessEnv = { USERPROFILE: winProfile, CLAUDE_CONFIG_DIR: override, Claude_Config_Dir: customDir };
      expect(resolveClaudeConfigDir(dirEnv, "win32")).toBe(path.join(winProfile, ".claude"));
      // customDir has no .credentials.json while winProfile/.claude does; verifiable subscription proves AdapterQuotaCache chose winProfile/.claude too.
      const dirCache = new AdapterQuotaCache("claude", "claude", dirEnv, f.root, undefined, "win32");
      expect(dirCache.capture("usage")).toMatchObject({ authMode: "subscription", verifiable: true });
    }
  });
});
