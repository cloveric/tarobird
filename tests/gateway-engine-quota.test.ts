import { expect, it, vi } from "vitest";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { ENGINE_QUOTA_HUB_REFRESH_MS, ENGINE_QUOTA_REFRESH_MS, quotaReadingExpired } from "../src/client-protocol/engine-quota.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import type { EngineQuotaReadOptions, EngineQuotaReadResult } from "../src/codex/adapter.js";

const snapshot = () => ({ ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, pools: [{
  id: "pool", label: "Codex", sharing: "shared" as const, availability: "unknown" as const, balances: [], constraints: [],
  windows: [{ id: "short", label: "5 hours", metric: "percent" as const, usedPercent: 25, availability: "unknown" as const,
    observedAt: new Date(1000).toISOString(), expiresAt: new Date(61_000).toISOString(), resetsAt: new Date(50_000).toISOString() }],
}] });

it("reads cached native quotas without refreshing and omits private account proof", async () => {
  const read = vi.fn(async (_options: EngineQuotaReadOptions) => ({ revision: "one", snapshot: snapshot(), proof: { engine: "codex" as const, scopeStamp: "private", accountKey: "private" } }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const result = await run({ scopeId: "bot", refresh: false });
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0]?.[0]).toMatchObject({ refresh: false });
  expect(result.value).toMatchObject({ botIds: ["bot"], sharing: "unverified", revision: "one" });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("gives an explicit refresh the shared time limit and a plain read a short one", async () => {
  const read = vi.fn(async () => ({ revision: "one", snapshot: snapshot() }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "antigravity", read, now: () => 2000 });
  await run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  expect(ENGINE_QUOTA_REFRESH_MS).toBe(15_000);
  // A reader may take up to 2 s past the limit to stop its process; the Hub waits beyond that.
  expect(ENGINE_QUOTA_HUB_REFRESH_MS).toBeGreaterThan(ENGINE_QUOTA_REFRESH_MS + 2_000);
  expect(read.mock.calls.map(call => (call as unknown as [{ refresh: boolean; timeoutMs: number }])[0]).map(options => [options.refresh, options.timeoutMs]))
    .toEqual([[false, 1_500], [true, ENGINE_QUOTA_REFRESH_MS]]);
});

it("coalesces explicit refresh and does not repeat it within the cooldown", async () => {
  let resolve!: (value: EngineQuotaReadResult) => void;
  const read = vi.fn((options: { refresh: boolean }) => options.refresh
    ? new Promise<EngineQuotaReadResult>(done => { resolve = done; }) : Promise.resolve({ revision: "one", snapshot: snapshot() }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const first = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const second = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  resolve({ revision: "one", snapshot: snapshot() });
  const results = await Promise.all([first, second]);
  expect(results).toEqual([results[0], results[0]]);
  await run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  expect(read.mock.calls.filter(([options]) => options.refresh)).toHaveLength(1);
});

it("does not refresh or retain a previous account value after revision changed", async () => {
  const read = vi.fn(async () => ({ revision: "new", snapshot: snapshot() }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const result = await run({ scopeId: "bot", expectedRevision: "old", refresh: true });
  expect(result.value).toMatchObject({ revision: "new", reason: "auth_changed", pools: [] });
  expect(read).toHaveBeenCalledOnce();
});

it("does not attach an old in-flight refresh to a new account", async () => {
  let revision = "one", resolve!: (value: EngineQuotaReadResult) => void;
  const read = vi.fn((options: { refresh: boolean }) => options.refresh
    ? new Promise<EngineQuotaReadResult>(done => { resolve = done; }) : Promise.resolve({ revision, snapshot: unavailableQuota("codex", "not_loaded") }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const first = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  revision = "two";
  const second = await run({ scopeId: "bot", expectedRevision: "two", refresh: true });
  expect(second.value).toMatchObject({ revision: "two", pools: [] });
  resolve({ revision: "two", snapshot: unavailableQuota("codex", "auth_changed") }); await first;
});

it("gives no refresh cooldown to a login that changed during the refresh", async () => {
  let revision = "one";
  const read = vi.fn(async (options: { refresh: boolean }) => {
    if (!options.refresh) return { revision, snapshot: unavailableQuota("codex", "not_loaded") };
    revision = "two"; return { revision, snapshot: unavailableQuota("codex", "auth_changed") };
  });
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const changed = await run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  // The page says "check and refresh again"; the new login may be read at once.
  expect(changed.value).toMatchObject({ revision: "two", reason: "auth_changed" }); expect(changed.value.nextRefreshAt).toBeUndefined();
  await run({ scopeId: "bot", expectedRevision: "two", refresh: true });
  expect(read.mock.calls.filter(([options]) => options.refresh)).toHaveLength(2);
});

it.each([50_000, 70_000])("marks elapsed reset or TTL stale without inventing a refill (%s)", async now => {
  const result = await gatewayEngineQuota({ botId: "bot", engine: "codex", read: async () => ({ revision: "one", snapshot: snapshot() }), now: () => now })({ scopeId: "bot", refresh: false });
  expect(result.value.state).toBe("stale");
  expect(result.value.pools[0]?.windows[0]).toMatchObject({ usedPercent: 25 });
});

it("keeps unsupported and passive engines read only", async () => {
  const missing = await gatewayEngineQuota({ botId: "bot", engine: "pi" })({ scopeId: "bot", refresh: false });
  expect(missing.value).toMatchObject({ state: "unsupported", pools: [] });
  const read = vi.fn(async (_options: EngineQuotaReadOptions) => ({ revision: "one", snapshot: unavailableQuota("claude", "no_passive_event") }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "claude", read });
  await run({ scopeId: "bot", refresh: true, expectedRevision: "one" });
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0]).toMatchObject({ refresh: false });
});

it("rejects cross-Bot and unversioned refresh requests before reading", async () => {
  const read = vi.fn(); const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read });
  await expect(run({ scopeId: "other", refresh: false })).rejects.toThrow();
  await expect(run({ scopeId: "bot", refresh: true })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

// #47-D: constraint resets and the snapshot TTL use the same expiry rule as the App.
const constrained = (place: "snapshot" | "pool", resetsAt?: number) => {
  const value = { ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, availability: "blocked" as const, observedAt: new Date(1000).toISOString(), pools: [] as ReturnType<typeof snapshot>["pools"] };
  const constraint = { code: "ordinary_usage_blocked" as const, availability: "blocked" as const, ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString() } : {}) };
  if (place === "snapshot") return { ...value, constraints: [constraint] };
  return { ...value, pools: [{ id: "pool", label: "Codex", sharing: "shared" as const, availability: "blocked" as const, windows: [], balances: [], constraints: [constraint] }] };
};
const readAt = (value: ReturnType<typeof constrained>, now: number) => gatewayEngineQuota({ botId: "bot", engine: "codex", read: async () => ({ revision: "one", snapshot: value }), now: () => now })({ scopeId: "bot", refresh: false });

it.each(["snapshot", "pool"] as const)("marks a %s constraint stale once its reset time passes, keeping the last restriction", async place => {
  const result = await readAt(constrained(place, 11_000), 31_000);
  expect(result.value.state).toBe("stale");
  expect(result.value.availability).toBe("blocked");
  expect([...result.value.constraints, ...result.value.pools.flatMap(pool => pool.constraints)]).toEqual([expect.objectContaining({ code: "ordinary_usage_blocked" })]);
});

it("marks a constraint-only reading stale when its own TTL elapses", async () => {
  expect((await readAt(constrained("snapshot"), 61_000)).value.state).toBe("stale");
});

it("keeps a constraint reading current before its reset and TTL", async () => {
  expect((await readAt(constrained("snapshot", 40_000), 31_000)).value.state).toBe("ready");
  expect((await readAt(constrained("pool"), 60_999)).value.state).toBe("ready");
});

it("shares one expiry predicate between Gateway and App", () => {
  const value = constrained("pool", 11_000);
  expect(quotaReadingExpired(value, 10_999)).toBe(false);
  expect(quotaReadingExpired(value, 11_000)).toBe(true);
  expect(quotaReadingExpired({ ...value, pools: [] }, 60_999)).toBe(false);
  expect(quotaReadingExpired({ ...value, pools: [] }, 61_000)).toBe(true);
  expect(quotaReadingExpired(snapshot(), 49_999)).toBe(false);
  expect(quotaReadingExpired(snapshot(), 50_000)).toBe(true);
});

it("exposes Hub-keyed account proof only via private accountProof RPC and never in quota.get", async () => {
  let key: Uint8Array | undefined = Buffer.alloc(32, 9);
  const accountKey = "a".repeat(64);
  const read = vi.fn(async (opts: { accountProofKey?: Uint8Array }) => ({
    revision: "rev_1",
    snapshot: snapshot(),
    ...(opts.accountProofKey ? { proof: { engine: "codex" as const, scopeStamp: "rev_1", accountKey } } : {}),
  }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, getAccountProofKey: () => key, now: () => 2000 });
  const reply = await run({ scopeId: "bot", refresh: false });
  expect(JSON.stringify(reply)).not.toContain(accountKey);
  expect(run.accountProof({ scopeId: "bot", expectedRevision: "rev_1" })).toEqual({
    scopeId: "bot",
    revision: "rev_1",
    accountKey,
  });
  expect(read).toHaveBeenCalledOnce();
  // Mismatched revision or rotated Hub proof key fails closed
  expect(run.accountProof({ scopeId: "bot", expectedRevision: "other_rev" })).toEqual({
    scopeId: "bot",
    revision: "other_rev",
  });
  key = Buffer.alloc(32, 3);
  expect(run.accountProof({ scopeId: "bot", expectedRevision: "rev_1" })).toEqual({
    scopeId: "bot",
    revision: "rev_1",
  });
});
