import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBalanceDecimal, parseDeepSeekAccountBalance } from "../src/codex/deepseek-account-quota.js";
import { DeepSeekHarnessAdapter } from "../src/codex/deepseek-harness-adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import {
  classifyAntigravityProcessLine,
  decodeAntigravityLocalStatus,
  decodeAntigravityLocalSummary,
  parseLsofListeningPorts,
  parseNetstatListeningPorts,
  postLoopbackConnect,
  probeAntigravityLocalServerQuota,
} from "../src/codex/antigravity-local-server.js";
import { AntigravityAcpAdapter, type AgyAcpChildProcess } from "../src/codex/antigravity-acp-adapter.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import type { DeepSeekHarnessProtocolHandlers } from "../src/codex/deepseek-harness-protocol.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function createFakeAcpChild(pid: number): AgyAcpChildProcess {
  const child = new EventEmitter() as EventEmitter & AgyAcpChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  let buffer = "";
  const emitJson = (payload: unknown) => {
    queueMicrotask(() => stdout.emit("data", `${JSON.stringify(payload)}\n`));
  };
  child.pid = pid;
  child.stdout = stdout as unknown as AgyAcpChildProcess["stdout"];
  child.stderr = stderr as unknown as AgyAcpChildProcess["stderr"];
  child.stdin = {
    write(chunk: string, cb?: (error?: Error | null) => void) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        if (!raw.trim()) continue;
        const msg = JSON.parse(raw) as { id?: number; method?: string };
        if (msg.method === "initialize") {
          emitJson({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } } });
        } else if (msg.method === "session/new") {
          emitJson({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agy-session-1", configOptions: [] } });
        } else if (msg.method === "session/prompt") {
          emitJson({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "agy-session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
          });
          emitJson({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
        } else if (msg.method === "session/close") {
          emitJson({ jsonrpc: "2.0", id: msg.id, result: {} });
        }
      }
      cb?.(null);
      return true;
    },
    end(cb?: () => void) {
      cb?.();
      queueMicrotask(() => child.emit("close", 0, null));
    },
    on: () => undefined,
  };
  return child;
}

function createFakeProcessChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: {
      write: (chunk: string, cb?: (error?: Error | null) => void) => boolean;
      end: () => void;
      on: () => void;
    };
    kill: () => void;
  };
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const emitLine = (obj: unknown) => queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify(obj)}\n`));
  child.stdin = {
    write(_chunk: string, cb?: (error?: Error | null) => void) {
      cb?.(null);
      emitLine({ event: "init", conversation_id: "11111111-1111-4111-8111-111111111111" });
      emitLine({ event: "step_update", conversation_id: "11111111-1111-4111-8111-111111111111", step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "hi" });
      emitLine({ event: "result", conversation_id: "11111111-1111-4111-8111-111111111111", result: { conversation_id: "11111111-1111-4111-8111-111111111111", status: "SUCCESS", response: "hi" } });
      return true;
    },
    end() {
      queueMicrotask(() => child.emit("close", 0, null));
    },
    on: () => undefined,
  };
  child.kill = () => { queueMicrotask(() => child.emit("close", 0, "SIGTERM")); };
  return child;
}

describe("DeepSeek Harness wallet balance quota (#78)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("normalizes decimal and scientific balance strings, preserves tiny/large values, and rejects non-decimals", () => {
    expect(normalizeBalanceDecimal("0E-16")).toBe("0.00");
    expect(normalizeBalanceDecimal("5.0000000000000000")).toBe("5.00");
    expect(normalizeBalanceDecimal("12.5")).toBe("12.50");
    expect(normalizeBalanceDecimal("0.00001")).toBe("0.00001");
    expect(normalizeBalanceDecimal("1e-8")).toBe("0.00000001");
    expect(normalizeBalanceDecimal("1e21")).toBe("1000000000000000000000.00");
    expect(normalizeBalanceDecimal("0x10")).toBeNull();
    expect(normalizeBalanceDecimal("0b101")).toBeNull();
    expect(normalizeBalanceDecimal("0o17")).toBeNull();
    expect(normalizeBalanceDecimal("NaN")).toBeNull();
    expect(normalizeBalanceDecimal("Infinity")).toBeNull();
    expect(normalizeBalanceDecimal("-1")).toBeNull();
    expect(normalizeBalanceDecimal("1e-100")).toBeNull();
    expect(normalizeBalanceDecimal("1e100")).toBeNull();

    const snap = parseDeepSeekAccountBalance({
      status: "ready",
      value: [{ currency: "CNY", balance: "88.5000" }, { currency: "USD", balance: "10" }],
      bonusWallets: [{ currency: "CNY", balance: "5.25" }],
    }, { now });
    expect(snap).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" }, help: "deepseek_balance" });
    expect(snap.pools[0]?.balances).toEqual([
      expect.objectContaining({ id: "recharge_cny", kind: "currency", amount: "88.50", unit: "CNY" }),
      expect.objectContaining({ id: "recharge_usd", kind: "currency", amount: "10.00", unit: "USD" }),
      expect.objectContaining({ id: "bonus_cny", kind: "currency", amount: "5.25", unit: "CNY" }),
    ]);

    expect(parseDeepSeekAccountBalance(null, { now, hasApiKey: false })).toMatchObject({ state: "login_required", reason: "login_required" });
    expect(parseDeepSeekAccountBalance(null, { now, hasApiKey: true })).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key" });
    expect(parseDeepSeekAccountBalance({ status: "failed" }, { now })).toMatchObject({ state: "unavailable", reason: "native_error" });
  });

  it("fails closed with invalid_response when any wallet entry is malformed instead of dropping rows", () => {
    expect(() => parseDeepSeekAccountBalance({
      status: "ready",
      value: [{ currency: "CNY", balance: "CORRUPT" }],
      bonusWallets: [{ currency: "CNY", balance: "0E-16" }],
    }, { now })).toThrow("invalid_response");

    expect(() => parseDeepSeekAccountBalance({
      status: "ready",
      value: [{ currency: "CNY", balance: "0x10" }],
    }, { now })).toThrow("invalid_response");

    expect(() => parseDeepSeekAccountBalance({
      status: "ready",
      value: [{ currency: "CNY", balance: "10" }, { currency: "CNY", balance: "20" }],
    }, { now })).toThrow("invalid_response");

    expect(() => parseDeepSeekAccountBalance({
      status: "ready",
      value: [],
      bonusWallets: "not-an-array",
    }, { now })).toThrow("invalid_response");
  });

  it("queries account.getBalance through the existing private DeepSeek Harness host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-balance-"));
    roots.push(root);
    const request = vi.fn(async (method: string) => {
      if (method === "account.getBalance") {
        return { status: "ready", value: [{ currency: "CNY", balance: "42.00" }], bonusWallets: [] };
      }
      return {};
    });
    const gateway = {
      connect: vi.fn(async () => {}),
      request,
      respond: vi.fn(async () => ({ accepted: true })),
      respondError: vi.fn(async () => ({ accepted: true })),
      close: vi.fn(async () => {}),
    };
    const adapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      sharedHome: path.join(root, "dsh-home"),
      childEnv: { HOME: root },
      gateway: gateway as never,
    });
    disposals.push(() => adapter.destroy());

    const cached = await adapter.getAccountQuota({ refresh: false });
    expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
    expect(request).not.toHaveBeenCalled();

    const refreshed = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
    expect(refreshed.snapshot.state).toBe("ready");
    expect(refreshed.snapshot.pools[0]?.balances[0]).toMatchObject({ id: "recharge_cny", amount: "42.00", unit: "CNY" });
    expect(request).toHaveBeenCalledWith("account.getBalance", expect.objectContaining({ client: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("recomputes quota revision on credential/reconnect changes and preserves stale balances on refresh failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-quota-rev-"));
    roots.push(root);
    const sharedHome = path.join(root, "dsh-home");
    await mkdir(sharedHome, { recursive: true });
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "account: first\n");

    let handlers: DeepSeekHarnessProtocolHandlers | undefined;
    let mode: "ready" | "failed" | "throw" = "ready";
    const gateway = {
      connect: vi.fn(async (h: DeepSeekHarnessProtocolHandlers) => { handlers = h; }),
      request: vi.fn(async (method: string) => {
        if (method !== "account.getBalance") return {};
        if (mode === "failed") return { status: "failed" };
        if (mode === "throw") throw new Error("rpc_boom");
        return { status: "ready", value: [{ currency: "CNY", balance: "42.00" }], bonusWallets: [] };
      }),
      respond: vi.fn(async () => ({ accepted: true })),
      respondError: vi.fn(async () => ({ accepted: true })),
      close: vi.fn(async () => {}),
    };
    const adapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      sharedHome,
      childEnv: { HOME: root },
      gateway: gateway as never,
    });
    disposals.push(() => adapter.destroy());

    const first = await adapter.getAccountQuota({ refresh: true });
    expect(first.snapshot.state).toBe("ready");
    expect(first.snapshot.pools[0]?.balances[0]?.amount).toBe("42.00");

    // Failed outcome preserves prior ready balance as stale in both reply and cache.
    mode = "failed";
    const failedRefresh = await adapter.getAccountQuota({ refresh: true, expectedRevision: first.revision });
    expect(failedRefresh.snapshot).toMatchObject({ state: "stale", reason: "native_error" });
    expect(failedRefresh.snapshot.pools[0]?.balances[0]?.amount).toBe("42.00");
    const afterFailed = await adapter.getAccountQuota({ refresh: false });
    expect(afterFailed.snapshot).toMatchObject({ state: "stale", reason: "native_error" });
    expect(afterFailed.snapshot.pools[0]?.balances[0]?.amount).toBe("42.00");

    // Recover ready, then throw an error: stale state must persist across subsequent cache reads.
    mode = "ready";
    expect((await adapter.getAccountQuota({ refresh: true, expectedRevision: first.revision })).snapshot.state).toBe("ready");
    mode = "throw";
    const thrownRefresh = await adapter.getAccountQuota({ refresh: true, expectedRevision: first.revision });
    expect(thrownRefresh.snapshot).toMatchObject({ state: "stale", reason: "native_error" });
    expect(thrownRefresh.snapshot.pools[0]?.balances[0]?.amount).toBe("42.00");
    const afterThrown = await adapter.getAccountQuota({ refresh: false });
    expect(afterThrown.snapshot).toMatchObject({ state: "stale", reason: "native_error" });

    // Credentials change invalidates cache and changes revision.
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "account: second\n");
    const afterAuthSwitch = await adapter.getAccountQuota({ refresh: false, expectedRevision: first.revision });
    expect(afterAuthSwitch.revision).not.toBe(first.revision);
    expect(afterAuthSwitch.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });

    // Host disconnect invalidates cache and advances revision too.
    mode = "ready";
    const fresh = await adapter.getAccountQuota({ refresh: true, expectedRevision: afterAuthSwitch.revision });
    expect(fresh.snapshot.state).toBe("ready");
    await handlers?.onDisconnect?.(new Error("host crashed"));
    const afterDisconnect = await adapter.getAccountQuota({ refresh: false, expectedRevision: fresh.revision });
    expect(afterDisconnect.revision).not.toBe(fresh.revision);
    expect(afterDisconnect.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
  });

  it("does not permanently brick gatewayEngineQuota Refresh when DEEPSEEK_API_KEY is set and balance starts null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-apikey-refresh-"));
    roots.push(root);
    let signedIn = false;
    let clock = 100_000;
    const gateway = {
      connect: vi.fn(async () => {}),
      request: vi.fn(async (method: string) => {
        if (method !== "account.getBalance") return {};
        return signedIn ? { status: "ready", value: [{ currency: "CNY", balance: "99.00" }], bonusWallets: [] } : null;
      }),
      respond: vi.fn(async () => ({ accepted: true })),
      respondError: vi.fn(async () => ({ accepted: true })),
      close: vi.fn(async () => {}),
    };
    const adapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      sharedHome: path.join(root, "dsh-home"),
      childEnv: { HOME: root, DEEPSEEK_API_KEY: "synthetic-api-key" },
      gateway: gateway as never,
    });
    disposals.push(() => adapter.destroy());

    const run = gatewayEngineQuota({
      botId: "bot-dsh",
      engine: "deepseek",
      read: opts => adapter.getAccountQuota(opts),
      now: () => clock,
    });

    const initial = await run({ scopeId: "bot-dsh", refresh: false });
    expect(initial.value.capability.mode).toBe("active");

    const unsupported = await run({ scopeId: "bot-dsh", refresh: true, expectedRevision: initial.revision });
    expect(unsupported.value).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key" });

    // User signs into DeepSeek Platform; subsequent cache read keeps capability.mode active so Refresh works.
    signedIn = true;
    const cachedAfter = await run({ scopeId: "bot-dsh", refresh: false });
    expect(cachedAfter.value.capability.mode).toBe("active");

    clock += 65_000;
    const recovered = await run({ scopeId: "bot-dsh", refresh: true, expectedRevision: cachedAfter.revision });
    expect(recovered.value.state).toBe("ready");
    expect(recovered.value.pools[0]?.balances[0]).toMatchObject({ id: "recharge_cny", amount: "99.00", unit: "CNY" });
  });

  it("enforces timeoutMs and AbortSignal during connect/request, distinguishes timeout from cancel, and avoids destroy() races", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-quota-timeout-"));
    roots.push(root);

    // 1. Hanging connect respects timeoutMs and AbortSignal.timeout.
    const hangingConnectAdapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      sharedHome: path.join(root, "dsh-home"),
      childEnv: { HOME: root },
      gateway: {
        connect: () => new Promise<void>(() => {}),
        request: vi.fn(async () => null),
        respond: vi.fn(async () => ({ accepted: true })),
        respondError: vi.fn(async () => ({ accepted: true })),
        close: vi.fn(async () => {}),
      } as never,
    });
    disposals.push(() => hangingConnectAdapter.destroy());

    const began = performance.now();
    const timedOutConnect = await hangingConnectAdapter.getAccountQuota({ refresh: true, timeoutMs: 40 });
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(timedOutConnect.snapshot).toMatchObject({ state: "unavailable", reason: "timeout", pools: [] });

    // 2. Timeout after a ready reading preserves balance as stale; manual abort returns cancelled; destroy() never caches ready.
    let resolveBalance: ((value: unknown) => void) | undefined;
    let firstCall = true;
    const raceAdapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      sharedHome: path.join(root, "dsh-home"),
      childEnv: { HOME: root },
      gateway: {
        connect: vi.fn(async () => {}),
        request: vi.fn((method: string) => {
          if (method !== "account.getBalance") return Promise.resolve({});
          if (firstCall) {
            firstCall = false;
            return Promise.resolve({ status: "ready", value: [{ currency: "CNY", balance: "55.00" }], bonusWallets: [] });
          }
          return new Promise(resolve => { resolveBalance = resolve; });
        }),
        respond: vi.fn(async () => ({ accepted: true })),
        respondError: vi.fn(async () => ({ accepted: true })),
        close: vi.fn(async () => { resolveBalance?.({ status: "ready", value: [{ currency: "CNY", balance: "77.00" }], bonusWallets: [] }); }),
      } as never,
    });
    disposals.push(() => raceAdapter.destroy());

    const ready = await raceAdapter.getAccountQuota({ refresh: true });
    expect(ready.snapshot.state).toBe("ready");

    // AbortSignal.timeout preserves cached balance as stale with reason: "timeout".
    const signalTimeout = await raceAdapter.getAccountQuota({ refresh: true, signal: AbortSignal.timeout(30) });
    expect(signalTimeout.snapshot).toMatchObject({ state: "stale", reason: "timeout" });
    expect(signalTimeout.snapshot.pools[0]?.balances[0]?.amount).toBe("55.00");

    // Manual caller abort returns cancelled.
    const manualAbort = new AbortController();
    const pendingAbort = raceAdapter.getAccountQuota({ refresh: true, signal: manualAbort.signal });
    await vi.waitFor(() => expect(resolveBalance).toBeTypeOf("function"));
    manualAbort.abort();
    expect((await pendingAbort).snapshot).toMatchObject({ reason: "cancelled" });

    // destroy() racing with an in-flight balance reply returns cancelled and never caches ready.
    resolveBalance = undefined;
    const pendingDestroy = raceAdapter.getAccountQuota({ refresh: true });
    await vi.waitFor(() => expect(resolveBalance).toBeTypeOf("function"));
    await raceAdapter.destroy();
    const afterDestroy = await pendingDestroy;
    expect(afterDestroy.snapshot).toMatchObject({ state: "unavailable", reason: "cancelled", pools: [] });
  });
});

describe("Pi provider quota status (#78)", () => {
  it("reports mode_not_supported explicitly instead of not_adapted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-quota-"));
    roots.push(root);
    const adapter = new PiRpcAdapter({
      launch: { command: "pi", args: [] },
      workspacePath: root,
      stateDir: root,
      childEnv: { HOME: root },
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const res = await adapter.getAccountQuota({ refresh: false });
    expect(res.snapshot).toMatchObject({
      state: "unsupported",
      reason: "mode_not_supported",
      capability: { mode: "unsupported", reason: "mode_not_supported" },
      pools: [],
    });
  });
});

describe("Antigravity local language server quota without spawning agy (#78)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("classifies POSIX and Windows processes strictly by executable, rejects unrelated args, and parses listening ports cleanly", () => {
    expect(classifyAntigravityProcessLine("6441 agy acp --dangerously-skip-permissions")).toEqual({ pid: "6441", cli: true, csrf: undefined, extPort: undefined });
    expect(classifyAntigravityProcessLine("6441 \"C:\\Tools\\antigravity\\agy.exe\" acp")).toEqual({ pid: "6441", cli: true, csrf: undefined, extPort: undefined });
    expect(classifyAntigravityProcessLine("6441 C:\\Tools\\bin\\agy.exe acp")).toEqual({ pid: "6441", cli: true, csrf: undefined, extPort: undefined });
    expect(classifyAntigravityProcessLine("6442 C:\\Tools\\bin\\agy.cmd acp")).toEqual({ pid: "6442", cli: true, csrf: undefined, extPort: undefined });
    expect(classifyAntigravityProcessLine("9100 /Applications/Antigravity.app/language_server_macos_arm --app_data_dir antigravity --csrf_token tok123 --extension_server_port 51234"))
      .toEqual({ pid: "9100", cli: false, csrf: "tok123", extPort: 51234 });
    expect(classifyAntigravityProcessLine("9100 C:\\AppData\\Local\\Antigravity\\language_server_windows_x64.exe --csrf_token tok123 --extension_server_port 51234"))
      .toEqual({ pid: "9100", cli: false, csrf: "tok123", extPort: 51234 });
    expect(classifyAntigravityProcessLine("9100 \"C:\\Program Files\\Antigravity\\language_server_windows_x64.exe\" --csrf_token \"tok123\" --extension_server_port \"51234\""))
      .toEqual({ pid: "9100", cli: false, csrf: "tok123", extPort: 51234 });
    expect(classifyAntigravityProcessLine("9101 /Applications/Antigravity-IDE/language_server_macos_arm --app_data_dir antigravity --csrf_token tok123")).toBeNull();
    // Unrelated processes mentioning antigravity-cli or agy in arguments must never match.
    expect(classifyAntigravityProcessLine("12345 grep -rn antigravity-cli /tmp")).toBeNull();
    expect(classifyAntigravityProcessLine("12346 node /home/alice/.gemini/antigravity-cli/mcp/server.js")).toBeNull();
    expect(classifyAntigravityProcessLine("12347 grep -rn language_server_macos_arm /Applications/Antigravity.app --csrf_token tok123")).toBeNull();

    expect(parseLsofListeningPorts([
      "agy 6441 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:63643 (LISTEN)",
      "agy 6441 user 13u IPv4 0x2 0t0 TCP [::1]:63645 (LISTEN)",
      "agy 6441 user 14u IPv4 0x3 0t0 TCP 198.51.100.5:51111->203.0.113.10:443 (ESTABLISHED)",
      "agy 6441 user 15u IPv4 0x4 0t0 TCP 198.51.100.5:63646 (LISTEN)",
    ].join("\n"))).toEqual([63643, 63645]);

    expect(parseNetstatListeningPorts([
      "  TCP    127.0.0.1:54321        0.0.0.0:0              LISTENING       9100",
      "  TCP    [::1]:54322            [::]:0                 LISTENING       9100",
      "  TCP    0.0.0.0:54323          0.0.0.0:0              ABHOREN         9100",
      "  TCP    198.51.100.5:51111     203.0.113.10:443       ESTABLISHED     9100",
      "  TCP    127.0.0.1:51112        127.0.0.1:54321        CLOSE_WAIT      9100",
      "  TCP    198.51.100.5:54324     0.0.0.0:0              LISTENING       9100",
    ].join("\r\n"), "9100")).toEqual([54321, 54322, 54323]);

    const summary = decodeAntigravityLocalSummary({
      response: {
        groups: [{
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash",
          buckets: [
            { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", remainingFraction: 0.82, resetTime: "2026-11-30T22:28:38Z" },
            { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remainingFraction: 0.35, resetTime: "2026-11-24T13:28:38Z" },
          ],
        }],
      },
    }, now);
    expect(summary?.state).toBe("ready");
    expect(summary?.pools[0]).toMatchObject({ label: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 3.8 Flash"] });
    expect(summary?.pools[0]?.windows.map(w => [w.id, w.label, w.metric === "percent" ? w.usedPercent : null])).toEqual([
      ["gemini-weekly", "7 days", 18],
      ["gemini-5h", "5 hours", 65],
    ]);

    const status = decodeAntigravityLocalStatus({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [{ label: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-25T08:00:00Z" } }],
        },
      },
    }, now);
    expect(status?.pools[0]?.label).toBe("Gemini 2.5 Pro");
    expect(status?.pools[0]?.windows[0]).toMatchObject({ metric: "percent", usedPercent: 40 });
  });

  it("never enumerates system-wide processes when no verified Bot-owned preferredPids exist", async () => {
    const execFile = vi.fn(async () => ({ stdout: "6441 agy acp\n" }));
    const request = vi.fn(async () => null);
    const miss = await probeAntigravityLocalServerQuota({
      preferredPids: [],
      deps: { platform: "darwin", execFile, request },
    });
    expect(miss).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("probes verified live workers in both ACP and Process adapters and stops probing them after an account switch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-local-quota-"));
    roots.push(root);
    const cacheDir = path.join(root, ".gemini", "antigravity-cli", "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true }));

    const probedPids: string[] = [];
    const summaryPayload = () => JSON.stringify({
      response: {
        groups: [{
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon",
          buckets: [{ bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remainingFraction: 0.75, resetTime: new Date(Date.now() + 3_600_000).toISOString() }],
        }],
      },
    });

    // 1. AntigravityAcpAdapter: probes its own live worker PID with matching spawn credentials.
    const acpQuotaSpawn = vi.fn(() => { throw new Error("must_not_spawn_agy_while_matching_worker_alive"); });
    const acpAdapter = new AntigravityAcpAdapter("agy", {
      workspacePath: root,
      childEnv: { HOME: root, PATH: process.env.PATH },
      spawnFn: () => createFakeAcpChild(6441),
      quotaSpawnFn: acpQuotaSpawn,
      killProcessTreeFn: () => undefined,
      localQuotaProbe: {
        platform: "darwin",
        execFile: async (file, args) => {
          if (file === "lsof") {
            const pid = args[args.length - 1]!;
            probedPids.push(pid);
            return { stdout: `agy ${pid} user 13u IPv4 0x2 0t0 TCP 127.0.0.1:63645 (LISTEN)\n` };
          }
          return { stdout: "" };
        },
        request: async (port, tls, pathName) => {
          if (port === 63645 && !tls && pathName.endsWith("RetrieveUserQuotaSummary")) {
            return { status: 200, text: summaryPayload() };
          }
          return null;
        },
      },
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => acpAdapter.destroy());

    await acpAdapter.sendUserMessage("tarobot-1", { text: "hello", files: [] });
    const acpRes = await acpAdapter.getAccountQuota({ refresh: true });
    expect(acpQuotaSpawn).not.toHaveBeenCalled();
    expect(probedPids).toEqual(["6441"]);
    expect(acpRes.snapshot.state).toBe("ready");
    expect(acpRes.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "gemini-5h", usedPercent: 25 });

    // Switching credentials excludes the stale worker PID from local probing.
    probedPids.length = 0;
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true, consumerOnboardingComplete: true }));
    const afterSwitch = await acpAdapter.getAccountQuota({ refresh: true });
    expect(probedPids).toEqual([]);
    expect(acpQuotaSpawn).toHaveBeenCalledWith("agy", ["--version"], expect.any(Object));
    expect(afterSwitch.snapshot.reason).toBe("native_unverified");

    // 2. ProcessAntigravityAdapter: also tracks quotaCredentialAtSpawn and probes its own live worker PID.
    const processProbedPids: string[] = [];
    const processSpawn = vi.fn((_cmd: string, args: string[]) => {
      if (args.includes("--version") || args.includes("/usage")) {
        throw new Error("must_not_spawn_quota_cli");
      }
      return createFakeProcessChild(7552);
    });
    const processAdapter = new ProcessAntigravityAdapter(
      "agy",
      { HOME: root, PATH: process.env.PATH },
      processSpawn as never,
      undefined,
      undefined,
      root,
      undefined,
      undefined,
      0,
      0,
      {
        platform: "darwin",
        execFile: async (file, args) => {
          if (file === "lsof") {
            const pid = args[args.length - 1]!;
            processProbedPids.push(pid);
            return { stdout: `agy ${pid} user 13u IPv4 0x2 0t0 TCP 127.0.0.1:63646 (LISTEN)\n` };
          }
          return { stdout: "" };
        },
        request: async (port, tls, pathName) => {
          if (port === 63646 && !tls && pathName.endsWith("RetrieveUserQuotaSummary")) {
            return { status: 200, text: summaryPayload() };
          }
          return null;
        },
      },
    );
    disposals.push(() => processAdapter.destroy());

    await processAdapter.sendUserMessage("tarobot-2", { text: "hello", files: [] });
    const procRes = await processAdapter.getAccountQuota({ refresh: true });
    expect(processProbedPids).toEqual(["7552"]);
    expect(procRes.snapshot.state).toBe("ready");
    expect(procRes.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "gemini-5h", usedPercent: 25 });

    // Switching credentials excludes stale process worker PID too.
    processProbedPids.length = 0;
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true, enterpriseOnboardingComplete: true }));
    const procAfterSwitch = await processAdapter.getAccountQuota({ refresh: true });
    expect(processProbedPids).toEqual([]);
    expect(processSpawn).toHaveBeenCalledWith("agy", ["--version"], expect.any(Object));
    expect(procAfterSwitch.snapshot.reason).toBe("native_unverified");
  });

  it("settles promptly on mid-response TCP reset and honors AbortSignal without bricking subsequent refreshes", async () => {
    const server = net.createServer(socket => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial", () => {
          socket.resetAndDestroy();
        });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    disposals.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;

    const start = performance.now();
    const res = await postLoopbackConnect(port, false, "/test", "{}");
    expect(res).toBeNull();
    expect(performance.now() - start).toBeLessThan(1_000);

    // Oversized response (> 256 KB) destroys the connection and resolves null.
    const hugeServer = net.createServer(socket => {
      socket.once("data", () => {
        const body = "x".repeat(300 * 1024);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      });
    });
    await new Promise<void>(resolve => hugeServer.listen(0, "127.0.0.1", resolve));
    disposals.push(() => new Promise<void>(resolve => hugeServer.close(() => resolve())));
    const hugePort = (hugeServer.address() as net.AddressInfo).port;
    expect(await postLoopbackConnect(hugePort, false, "/test", "{}")).toBeNull();

    // AbortSignal cancellation stops probing between SUMMARY_PATH and STATUS_PATH.
    const controller = new AbortController();
    const requestedPaths: string[] = [];
    const aborted = await probeAntigravityLocalServerQuota({
      preferredPids: [6441],
      signal: controller.signal,
      deps: {
        platform: "darwin",
        execFile: async () => ({ stdout: `agy 6441 user 13u IPv4 0x2 0t0 TCP 127.0.0.1:${port} (LISTEN)\n` }),
        request: async (_port, _tls, pathName, _body, _csrf, signal) => {
          requestedPaths.push(pathName);
          expect(signal).toBe(controller.signal);
          controller.abort();
          return null;
        },
      },
    });
    expect(aborted).toBeNull();
    expect(requestedPaths).toHaveLength(1);

    // Mid-response TCP reset inside adapter.getAccountQuota never bricks subsequent refreshes or destroy().
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-reset-"));
    roots.push(root);
    const cacheDir = path.join(root, ".gemini", "antigravity-cli", "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true }));

    let probePort = port;
    const quotaSpawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: { end: () => void; on: () => void };
        kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => undefined, on: () => undefined };
      child.kill = () => undefined;
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      });
      return child;
    });
    const adapter = new AntigravityAcpAdapter("agy", {
      workspacePath: root,
      childEnv: { HOME: root, PATH: process.env.PATH },
      spawnFn: () => createFakeAcpChild(6441),
      quotaSpawnFn: quotaSpawnFn as never,
      killProcessTreeFn: () => undefined,
      localQuotaProbe: {
        platform: "darwin",
        execFile: async () => ({ stdout: `agy 6441 user 13u IPv4 0x2 0t0 TCP 127.0.0.1:${probePort} (LISTEN)\n` }),
      },
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    await adapter.sendUserMessage("tarobot-reset", { text: "hello", files: [] });
    const firstStart = performance.now();
    const first = await adapter.getAccountQuota({ refresh: true, timeoutMs: 2_000 });
    expect(performance.now() - firstStart).toBeLessThan(1_500);
    // Local probe settled cleanly as null and fell back to quotaSpawnFn (returning cli_unavailable, NOT hanging).
    expect(first.snapshot.reason).toBe("cli_unavailable");
    // Subsequent refresh is not wedged by an orphaned owned entry.
    const second = await adapter.getAccountQuota({ refresh: true, timeoutMs: 2_000 });
    expect(second.snapshot.reason).toBe("cli_unavailable");
    expect(quotaSpawnFn).toHaveBeenCalledTimes(2);
    void probePort;
  });
});
