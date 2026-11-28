import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaSnapshotSchema } from "../src/client-protocol/engine-quota.js";
import { isAntigravityQuotaSupportedVersion, parseAntigravityQuota, withAntigravityModelIds } from "../src/codex/account-quota.js";
import { quotaReadingExpired } from "../src/client-protocol/engine-quota.js";
import { poolCoversModel } from "../client/src/usage-readings.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { AntigravityAcpAdapter } from "../src/codex/antigravity-acp-adapter.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";

const now = Date.parse("2026-11-22T00:00:00Z");

const sampleUsagePayload = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-28T09:14:35Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "Private prose that should not leak into DTO",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.6286041140556335,
              reset_time: "2026-11-28T09:14:35Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9344972372055054,
              reset_time: "2026-11-22T04:00:04Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-28T23:42:11Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-22T04:42:11Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 0, reset_time: "2026-11-28T23:42:11Z" },
          ],
        },
      ],
    },
  },
};

/** The sample as `agy` would answer it now. The parser tests use a fixed clock; a read that passes the Gateway
 * is judged against the real one, where a reset time in the past ends the reading. */
function currentUsagePayload() {
  const payload = structuredClone(sampleUsagePayload);
  for (const group of payload.command.data.groups) for (const bucket of group.buckets) bucket.reset_time = new Date(Date.now() + (bucket.window === "5h" ? 3 : 100) * 3_600_000).toISOString();
  return payload;
}

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: () => true,
    end: () => undefined,
    on: () => undefined,
  };
  killed = false;
  closed = false;
  closeDelayMs = 5;
  kill() {
    this.killed = true;
    if (!this.closed) {
      setTimeout(() => {
        if (this.closed) return;
        this.closed = true;
        this.emit("close", null, "SIGTERM");
      }, this.closeDelayMs);
    }
  }
  finish(code: number | null, stdout = "", stderr = "") {
    queueMicrotask(() => {
      if (this.closed) return;
      if (stdout) this.stdout.emit("data", stdout);
      if (stderr) this.stderr.emit("data", stderr);
      this.closed = true;
      this.emit("close", code, null);
    });
  }
}

async function agyFixture(options: { withState?: boolean; extraEnv?: Record<string, string> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-quota-"));
  roots.push(root);
  const home = path.join(root, "home");
  const agyHome = path.join(home, ".gemini", "antigravity-cli");
  const cacheDir = path.join(agyHome, "cache");
  await mkdir(cacheDir, { recursive: true });
  if (options.withState !== false) {
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true }));
  }
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, ...options.extraEnv };
  return { root, home, agyHome, cacheDir, env };
}

describe("Antigravity quota version check and parser", () => {
  it("accepts CLI versions >= 1.1.11 and rejects older or malformed versions", () => {
    for (const ok of ["1.1.11", "1.1.12\n", "1.2.0", "1.5.14", "2.0.0", "v1.5.14", "1.5.14-beta.1"]) {
      expect(isAntigravityQuotaSupportedVersion(ok)).toBe(true);
    }
    for (const bad of ["1.1.10", "1.1.0", "1.0.99", "0.9.9", "", "unknown", "1.1"]) {
      expect(isAntigravityQuotaSupportedVersion(bad)).toBe(false);
    }
  });

  it("parses valid /usage JSON with num_turns === 0 into pools and windows", () => {
    const snapshot = parseAntigravityQuota(sampleUsagePayload, now);
    expect(quotaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      authMode: "subscription",
      capability: { mode: "active" },
      state: "ready",
      availability: "unknown",
      help: "antigravity_usage",
    });
    expect(snapshot.pools).toHaveLength(3);
    // Each group says which models it covers: listed in its description, or the group is the model itself.
    expect(snapshot.pools.map(pool => [pool.label, pool.sharing, pool.models])).toEqual([
      ["Gemini Models", "model", ["Gemini 4 Neon", "Gemini 3.8 Flash"]],
      ["Claude and GPT models", "model", ["Claude and GPT models"]],
      ["Gemini 4 Argon", "model", ["Gemini 4 Argon"]],
    ]);
    expect(snapshot.pools[0]!.windows[0]).toMatchObject({
      id: "gemini-weekly",
      label: "7 days",
      metric: "percent",
      usedPercent: 37.14,
      periodSeconds: 604800,
      resetsAt: "2026-11-28T09:14:35.000Z",
    });
    expect(snapshot.pools[0]!.windows[1]).toMatchObject({
      id: "gemini-5h",
      label: "5 hours",
      metric: "percent",
      usedPercent: 6.55,
      periodSeconds: 18000,
      resetsAt: "2026-11-22T04:00:04.000Z",
    });
    expect(snapshot.pools[1]!.windows[0]).toMatchObject({ usedPercent: 0 });
    expect(snapshot.pools[2]!.windows[0]).toMatchObject({ usedPercent: 100 });
    expect(JSON.stringify(snapshot)).not.toContain("Private prose");
  });

  it.each([1, 2, -1, undefined, null, "0", 0.5])("rejects num_turns = %s", numTurns => {
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, num_turns: numTurns }, now)).toThrow("invalid_response");
  });

  it.each([-0.01, 1.01, NaN, Infinity, "0.5"])("rejects malformed remaining_fraction = %s", value => {
    const bad = structuredClone(sampleUsagePayload);
    (bad.command.data.groups[0]!.buckets[0] as Record<string, unknown>).remaining_fraction = value;
    expect(() => parseAntigravityQuota(bad, now)).toThrow("invalid_response");
  });

  it("keeps missing or null remaining_fraction as metric unknown instead of 0 or 100", () => {
    const sparse = structuredClone(sampleUsagePayload);
    sparse.command.data.groups = [{ name: "Gemini Models", buckets: [{ id: "gemini-5h", name: "Five Hour", window: "5h", remaining_fraction: null as any, reset_time: "2026-11-22T04:00:04Z" }] }];
    const snapshot = parseAntigravityQuota(sparse, now);
    expect(snapshot.pools[0]!.windows[0]).toMatchObject({ id: "gemini-5h", metric: "unknown" });
    expect(snapshot.pools[0]!.windows[0]).not.toHaveProperty("usedPercent");
  });

  it("keeps only a stated model list of a group's description, never its other prose", () => {
    const group = (description: unknown) => {
      const payload = structuredClone(sampleUsagePayload);
      payload.command.data.groups = [{ name: "Gemini 4 Argon", ...(description === undefined ? {} : { description: description as string }), buckets: [] }];
      return parseAntigravityQuota(payload, now).pools[0]!.models;
    };
    // The real 1.5.14 sentence for its separately metered model.
    expect(group("For paid Pro plans, Argon quota is separate. Higher Argon quota is available on Ultra plans.")).toEqual(["Gemini 4 Argon"]);
    expect(group("Models within this group: Claude Opus 5.5, Claude Sonnet 5.5 ,  GPT-OSS 120B")).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"]);
    expect(group("Models within this group: Orchestrator (Neon)")).toEqual(["Orchestrator (Neon)"]);
    // Anything that is not that one sentence states no list; it never fails the reading.
    for (const loose of [undefined, null, "", 7, ["Models within this group: A"], "Models within this group:", "Models within this group: , ,", "Models within this group: a\u0007b", "First line.\nModels within this group: A",
      "Models within this group: A\nmore prose", `Models within this group: ${"x".repeat(121)}`, `Models within this group: ${Array.from({ length: 33 }, (_, index) => `m${index}`).join(", ")}`])
      expect(group(loose)).toEqual(["Gemini 4 Argon"]);
  });

  it("rejects non-SUCCESS status or wrong command name", () => {
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, status: "ERROR" }, now)).toThrow("invalid_response");
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, command: { name: "other", data: { groups: [] } } }, now)).toThrow("invalid_response");
  });
});

describe("ProcessAntigravityAdapter account quota", () => {
  it("never spawns on cached read, checks version then reads /usage on refresh, and caches result", async () => {
    const f = await agyFixture();
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify(currentUsagePayload()));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const run = gatewayEngineQuota({ botId: "bot-agy", engine: "antigravity", read: opts => adapter.getAccountQuota?.(opts) });
    const cached = await run({ scopeId: "bot-agy", refresh: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(cached.value).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" }, help: "antigravity_usage" });

    const refreshed = await run({ scopeId: "bot-agy", refresh: true, expectedRevision: cached.revision });
    expect(calls).toEqual([["--version"], ["-p", "/usage", "--output-format", "json"]]);
    expect(refreshed.value).toMatchObject({ state: "ready", authMode: "subscription", help: "antigravity_usage" });
    expect(refreshed.value.pools[0]?.windows[0]).toMatchObject({ id: "gemini-weekly", usedPercent: 37.14 });

    const again = await run({ scopeId: "bot-agy", refresh: false });
    expect(again.value.state).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("waits for an answer that takes nine seconds, and gives up on one that never comes", async () => {
    // Measured on the owner's machine on 2026-11-22: six reads in a row took 4.0 to 8.0 seconds.
    const f = await agyFixture();
    let answerAfterMs: number | undefined = 9_000;
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else if (answerAfterMs !== undefined) setTimeout(() => child.finish(0, JSON.stringify(currentUsagePayload())), answerAfterMs);
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root, undefined, undefined, 0, 0);
    disposals.push(() => adapter.destroy());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const slow = adapter.getAccountQuota({ refresh: true });
      await vi.advanceTimersByTimeAsync(9_100);
      expect((await slow).snapshot).toMatchObject({ state: "ready" });

      answerAfterMs = undefined;
      const silent = adapter.getAccountQuota({ refresh: true });
      await vi.advanceTimersByTimeAsync(20_000);
      // The earlier reading stays, marked as old, with the reason of the failed attempt.
      expect((await silent).snapshot).toMatchObject({ state: "stale", reason: "timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("refuses to call /usage when agy version is below 1.1.11 and keeps antigravity_usage hint", async () => {
    const f = await agyFixture();
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new MockChild();
      child.finish(0, "1.1.10\n");
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(calls).toEqual([["--version"]]);
    expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "native_unverified", pools: [], help: "antigravity_usage" });
  });

  it("rejects /usage responses with num_turns > 0 and keeps antigravity_usage hint", async () => {
    const f = await agyFixture();
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify({ ...sampleUsagePayload, num_turns: 1 }));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "unavailable", reason: "invalid_response", pools: [], help: "antigravity_usage" });
  });

  it("never spawns agy when local login state is missing (reports login_required without browser OAuth popup)", async () => {
    const f = await agyFixture({ withState: false });
    const spawn = vi.fn();
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const cached = await adapter.getAccountQuota!({ refresh: false });
    expect(cached.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    const refreshed = await adapter.getAccountQuota!({ refresh: true, expectedRevision: cached.revision });
    expect(refreshed.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills interactive login prompt immediately if an onboarded session expired and never leaks OAuth URL", async () => {
    const f = await agyFixture({ withState: true });
    const children: MockChild[] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      children.push(child);
      if (args.includes("--version")) {
        child.finish(0, "1.5.14\n");
      } else {
        queueMicrotask(() => {
          child.stderr.emit("data", "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=secret\nWaiting for authentication");
        });
      }
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(children[1]?.killed).toBe(true);
    expect(children[1]?.closed).toBe(true);
    expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    expect(JSON.stringify(result)).not.toMatch(/accounts\.google\.com|oauth2|secret/i);
    // Asking again can open the browser sign-in again: agy is left alone for half an hour, then asked once more.
    expect(spawn).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 3; index++) expect((await adapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({ state: "login_required", pools: [] });
    expect(spawn).toHaveBeenCalledTimes(2);
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    expect((await adapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({ state: "login_required" });
    later.mockRestore();
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it("still reports login_required when the sign-in prompt keeps writing after agy was stopped", async () => {
    const f = await agyFixture({ withState: true });
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else queueMicrotask(() => {
        child.stderr.emit("data", "Authentication required. Please visit the URL to log in:\n");
        // The rest of the prompt arrives after the stop has finished but before the pipe closes.
        setTimeout(() => child.stderr.emit("data", "Waiting for authentication\n"), 1);
      });
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    expect((await adapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({ state: "login_required", reason: "login_required" });
    expect((await adapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({ state: "login_required" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("ends a timed-out read within one 2 s stop allowance, so the Hub still gets its answer", async () => {
    const f = await agyFixture({ withState: true });
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      // A usage run that neither answers nor closes when it is told to stop.
      else child.kill = () => { child.killed = true; };
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    const began = performance.now();
    const result = await adapter.getAccountQuota!({ refresh: true, timeoutMs: 50 });
    expect(result.snapshot).toMatchObject({ reason: "timeout" });
    expect(performance.now() - began).toBeLessThan(50 + 2_000 + 400);
  }, 10_000);

  it("reports mode_not_supported for GEMINI_API_KEY without subscription state", async () => {
    const f = await agyFixture({ withState: false, extraEnv: { GEMINI_API_KEY: "synthetic-api-key" } });
    const spawn = vi.fn();
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", pools: [], help: "antigravity_usage" });
  });

  it("invalidates cache and rejects old revision when Antigravity auth state changes", async () => {
    const f = await agyFixture();
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify(currentUsagePayload()));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const first = await adapter.getAccountQuota!({ refresh: true });
    expect(first.snapshot.state).toBe("ready");
    await writeFile(path.join(f.cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true, consumerOnboardingComplete: true }));
    const next = await adapter.getAccountQuota!({ refresh: false, expectedRevision: first.revision });
    expect(next.revision).not.toBe(first.revision);
    expect(next.snapshot).toMatchObject({ reason: "auth_changed", pools: [], help: "antigravity_usage" });
  });

  it("reports cli_unavailable on ENOENT and cancels in-flight read cleanly on destroy", async () => {
    const f = await agyFixture();
    const enoentSpawn = vi.fn(() => {
      const child = new MockChild();
      queueMicrotask(() => {
        const err = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
        child.closed = true;
        child.emit("error", err);
      });
      return child;
    });
    const missingAdapter = new ProcessAntigravityAdapter("agy-missing", f.env, enoentSpawn as any, undefined, undefined, f.root);
    disposals.push(() => missingAdapter.destroy());
    expect((await missingAdapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({
      state: "unavailable",
      reason: "cli_unavailable",
      help: "antigravity_usage",
    });

    const slowChild = new MockChild();
    slowChild.closeDelayMs = 40;
    const slowAdapter = new ProcessAntigravityAdapter("agy", f.env, (() => slowChild) as any, undefined, undefined, f.root);
    const pending = slowAdapter.getAccountQuota!({ refresh: true });
    const stopped = slowAdapter.destroy();
    expect(slowChild.closed).toBe(false);
    await stopped;
    expect(slowChild.closed).toBe(true);
    expect((await pending).snapshot).toMatchObject({ reason: "cancelled", help: "antigravity_usage" });
  });
});

describe("Antigravity ACP runtime account quota", () => {
  function acp(f: Awaited<ReturnType<typeof agyFixture>>, quotaSpawnFn: unknown) {
    const acpSpawn = vi.fn(() => { throw new Error("the ACP server must not be started for a quota read"); });
    const adapter = new AntigravityAcpAdapter("agy", { childEnv: f.env, workspacePath: f.root, spawnFn: acpSpawn as any, quotaSpawnFn: quotaSpawnFn as any, idleSweepIntervalMs: 0 });
    disposals.push(() => adapter.destroy());
    return { adapter, acpSpawn };
  }
  it("reads quota with the same one-shot /usage read as the print runtime and starts no ACP server", async () => {
    const f = await agyFixture();
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n"); else child.finish(0, JSON.stringify(currentUsagePayload()));
      return child;
    });
    const { adapter, acpSpawn } = acp(f, spawn);
    const run = gatewayEngineQuota({ botId: "bot-agy", engine: "antigravity", read: opts => adapter.getAccountQuota(opts) });
    const cached = await run({ scopeId: "bot-agy", refresh: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(cached.value).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
    const refreshed = await run({ scopeId: "bot-agy", refresh: true, expectedRevision: cached.revision });
    expect(calls).toEqual([["--version"], ["-p", "/usage", "--output-format", "json"]]);
    expect(refreshed.value).toMatchObject({ state: "ready", authMode: "subscription" });
    expect(refreshed.value.pools.map(pool => pool.label)).toEqual(["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
    expect((await run({ scopeId: "bot-agy", refresh: false })).value.state).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(2); expect(acpSpawn).not.toHaveBeenCalled();
  });
  it("never starts agy without local login state, as in the print runtime", async () => {
    const f = await agyFixture({ withState: false });
    const spawn = vi.fn();
    const { adapter } = acp(f, spawn);
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("ends an unfinished read when the adapter is destroyed and answers nothing afterwards", async () => {
    const f = await agyFixture();
    const slow = new MockChild();
    const { adapter } = acp(f, () => slow);
    const reading = adapter.getAccountQuota({ refresh: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    await adapter.destroy();
    expect(slow.killed).toBe(true);
    expect((await reading).snapshot.pools).toEqual([]);
    expect((await adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "cancelled", pools: [] });
  });
});

describe("Windows quota visibility (#205)", () => {
  const now = Date.parse("2026-11-28T01:00:00Z");
  const usage = (groups: unknown[]) => ({ ...sampleUsagePayload, command: { name: "usage", data: { groups } } });

  it("an unused pool's epoch reset means no reset, so the reading is not born expired", () => {
    const snapshot = parseAntigravityQuota(usage([
      { name: "Claude and GPT models", buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" }] },
      { name: "Gemini Models", buckets: [{ id: "g-weekly", window: "weekly", remaining_fraction: 0.6, reset_time: "2026-12-01T00:00:00Z" }] },
    ]), now);
    expect(snapshot.pools[0]!.windows[0]).not.toHaveProperty("resetsAt");
    expect(snapshot.pools[1]!.windows[0]).toMatchObject({ resetsAt: "2026-12-01T00:00:00.000Z" });
    expect(quotaReadingExpired(snapshot, now + 1000)).toBe(false);
  });

  it("adds the agy model ids whose display name is a group's model, so the Bot's id matches", () => {
    const snapshot = parseAntigravityQuota(usage([
      { name: "Orchestrator", description: "Models within this group: Orchestrator (Neon), Orchestrator (Carbon)", buckets: [] },
      { name: "Gemini 4 Argon", buckets: [] },
    ]), now);
    const catalog = [
      { id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)" },
      { id: "gemini-pro-orchestrator", label: "Orchestrator (Carbon)" },
      { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
      { id: "gemini-4-neon", label: "Gemini 4 Neon" },
      { id: "no-label" },
    ];
    const enriched = withAntigravityModelIds(snapshot, catalog);
    expect(enriched.pools[0]!.models).toEqual(["Orchestrator (Neon)", "Orchestrator (Carbon)", "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator"]);
    expect(enriched.pools[1]!.models).toEqual(["Gemini 4 Argon", "gemini-4-argon-high"]);
    // The App's matcher now finds the Bot's own id; before, only the display name was there.
    expect(poolCoversModel(snapshot.pools[0]!.models!, "gemini-pro-orchestrator-neon")).toBe(false);
    expect(poolCoversModel(enriched.pools[0]!.models!, "gemini-pro-orchestrator-neon")).toBe(true);
    expect(poolCoversModel(enriched.pools[0]!.models!, "gemini-4-neon")).toBe(false);
    expect(withAntigravityModelIds(snapshot, [])).toBe(snapshot);
  });
});
