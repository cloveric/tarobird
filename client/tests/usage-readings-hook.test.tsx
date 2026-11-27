import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaDirectory, QuotaScope, QuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "../src/connection.js";
import { HubHttpError } from "../src/http-error.js";
import {
  applyHostQuotaScope,
  readStoredQuota,
  resetQuotaStoreForTests,
} from "../src/quota-store.js";
import { groupQuotaScopesByAccount } from "../src/quota-ui.js";
import { useEngineQuota } from "../src/use-engine-quota.js";
import {
  resetUsageReadingsForTests,
  useUsageReadings,
} from "../src/use-usage-readings.js";
import {
  QUOTA_BACKGROUND_POLL_MS,
  QUOTA_SHOWN_FOR_MS,
  SAVED_QUOTA_KEY,
  type QuotaView,
} from "../src/usage-readings.js";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));

const BASE_NOW = Date.parse("2026-11-22T10:00:00Z");
const isoAt = (now: number, deltaMs = 0) => new Date(now + deltaMs).toISOString();

const makeWindow = (now: number, usedPercent: number, resetDeltaMs = 4 * 60 * 60_000): QuotaWindow => ({
  id: "primary",
  label: "Primary",
  metric: "percent",
  usedPercent,
  availability: "unknown",
  observedAt: isoAt(now),
  expiresAt: isoAt(now, 60_000),
  resetsAt: isoAt(now, resetDeltaMs),
  periodSeconds: 18_000,
});

const makeScope = (
  now: number,
  usedPercent: number,
  extra: Partial<QuotaScope> = {},
  resetDeltaMs = 4 * 60 * 60_000,
): QuotaScope => ({
  id: "alpha",
  revision: "rev_1",
  engine: "codex",
  label: "Coding Bot",
  botIds: ["alpha"],
  sharing: "unverified",
  authMode: "subscription",
  capability: { mode: "active" },
  state: "ready",
  availability: "allowed",
  observedAt: isoAt(now),
  constraints: [],
  pools: [
    {
      id: "p0",
      label: "Codex",
      sharing: "shared",
      availability: "allowed",
      windows: [makeWindow(now, usedPercent, resetDeltaMs)],
      balances: [],
      constraints: [],
    },
  ],
  ...extra,
});

type FakeConnection = HubConnection & {
  readEngineQuota: ReturnType<typeof vi.fn>;
  refreshEngineQuota: ReturnType<typeof vi.fn>;
  readEngineQuotas: ReturnType<typeof vi.fn>;
  readContextUsage: ReturnType<typeof vi.fn>;
};

function makeConnection(hostKey: string): FakeConnection {
  return {
    identity: { hubPublicKey: hostKey },
    isReadOnly: false,
    // The Settings page reads the Host clock offset when it decides which cards to read on opening.
    state: { serverTimeOffset: 0 },
    readEngineQuota: vi.fn(),
    refreshEngineQuota: vi.fn(),
    readEngineQuotas: vi.fn(),
    readContextUsage: vi.fn(),
  } as unknown as FakeConnection;
}

describe("useUsageReadings and useEngineQuota hook regression tests (#137)", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  let mem: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
    mem = new Map();
    resetQuotaStoreForTests();
    resetUsageReadingsForTests();
    const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("HTMLElement", dom.HTMLElement);
    vi.stubGlobal("Node", dom.Node);
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => { mem.set(key, value); },
      removeItem: (key: string) => { mem.delete(key); },
    });
    container = dom.document.getElementById("root") as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = undefined;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-arms stale redraw timer every minute and auto-hides the battery right at window reset (Bug 3)", async () => {
    const conn = makeConnection("host-bug3");
    // Persisted reading observed 30m ago whose single window resets in 3m30s.
    const observedMs = BASE_NOW - QUOTA_SHOWN_FOR_MS;
    const resetMs = BASE_NOW + 3 * 60_000 + 30_000;
    const savedScope = makeScope(observedMs, 35, {}, resetMs - observedMs);
    applyHostQuotaScope(conn, "alpha", savedScope, BASE_NOW);
    resetQuotaStoreForTests();
    const conn2 = makeConnection("host-bug3");

    let latest: QuotaView | undefined;
    let renders = 0;
    function Harness() {
      const reading = useUsageReadings(conn2, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: false, // Offline so only the redraw/reset timers operate
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      renders++;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness)); });
    expect(latest).toMatchObject({ left: 65, stale: true, fromCache: true });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(30);

    // Advance 1 minute -> age updates to 31m
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(31);

    // Advance a SECOND minute -> previously froze permanently at 31m; must advance to 32m!
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(32);

    // Advance a THIRD minute -> 33m, still before reset (3m30s)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(33);
    expect(latest).toBeDefined();

    // Advance past 3m30s window reset (+100ms) -> battery auto-hides without any unrelated re-render!
    const rendersBeforeReset = renders;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_200); });
    expect(renders).toBeGreaterThan(rendersBeforeReset);
    expect(latest).toBeUndefined();
  });

  it("keeps polling when deps stay unchanged, pauses offline, and resets backoff on reconnect (Bug 4 & Bug 5)", async () => {
    const conn = makeConnection("host-bug5");
    // Gateway marks cached reading state="stale" after 60s while keeping the same observedAt.
    let currentScope = makeScope(BASE_NOW - 90_000, 20, { state: "stale" });
    conn.readEngineQuota.mockImplementation(async () => currentScope);
    conn.refreshEngineQuota.mockImplementation(async () => {
      // Simulate failing refresh after initial fresh period or when triggered
      throw new Error("network_error");
    });

    let latest: QuotaView | undefined;
    function Harness({ online }: { online: boolean }) {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: online,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness, { online: true })); });
    // Even though Gateway returned state="stale" (90s old), UI keeps it fresh (< 30m)!
    expect(latest).toMatchObject({ left: 80, stale: false });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);

    // Advance 5m + 100ms: poll #2 runs; refreshEngineQuota throws -> failCount=1 (60s backoff).
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(2);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);

    // Advance 60s + 100ms: retry #1 runs (failCount=2, 2m backoff) even though observedAt/stale did not change!
    await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(2);

    // Go offline: polling pauses completely; no retries fire over 20 minutes.
    await act(async () => { root!.render(createElement(Harness, { online: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(2);

    // Reconnect online: backoff resets and a fresh read + refresh runs immediately!
    conn.refreshEngineQuota.mockImplementation(async () => {
      currentScope = makeScope(Date.now(), 15, { state: "ready" });
      return currentScope;
    });
    await act(async () => { root!.render(createElement(Harness, { online: true })); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(4);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(3);
    expect(latest).toMatchObject({ left: 85, stale: false });

    // Even if subsequent healthy polls keep returning the exact same observedAt (unchanged deps),
    // polling continues at every 5-minute interval and never silently dies!
    const unchanged = currentScope;
    conn.readEngineQuota.mockImplementation(async () => unchanged);
    conn.refreshEngineQuota.mockImplementation(async () => unchanged);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(6);
  });

  it("renews 20s before window reset, triggers an immediate post-reset read if reset arrives, and re-arms across connection switches (Bug 5)", async () => {
    const conn1 = makeConnection("host-reset-1");
    const conn2 = makeConnection("host-reset-2");
    const firstResetMs = 45_000;
    const preReset = makeScope(BASE_NOW, 30, {}, firstResetMs);
    let afterReset = false;
    conn1.readEngineQuota.mockImplementation(async () => (afterReset ? makeScope(Date.now(), 5, {}, 4 * 60 * 60_000) : preReset));
    conn1.refreshEngineQuota.mockImplementation(async () => (afterReset ? makeScope(Date.now(), 5, {}, 4 * 60 * 60_000) : preReset));
    conn2.readEngineQuota.mockResolvedValue(makeScope(BASE_NOW, 40, {}, 4 * 60 * 60_000));
    conn2.refreshEngineQuota.mockResolvedValue(makeScope(BASE_NOW, 40, {}, 4 * 60 * 60_000));

    let latest: QuotaView | undefined;
    function Harness({ conn }: { conn: HubConnection }) {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: true,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness, { conn: conn1 })); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ left: 70, stale: false });

    // 25s later (20s before 45s reset): pre-reset renewal fires automatically!
    await act(async () => { await vi.advanceTimersByTimeAsync(25_100); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(2);

    // Suppose the engine only reports the refilled window once resetsAt actually passes (at 45s):
    afterReset = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(latest).toMatchObject({ left: 95, stale: false });

    // Switching connection with the same botId re-arms cleanly on conn2 without leaking conn1's timer.
    await act(async () => { root!.render(createElement(Harness, { conn: conn2 })); });
    expect(conn2.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ left: 60, stale: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn2.readEngineQuota).toHaveBeenCalledTimes(2);
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(3);
  });

  it("evicts cached quota and stops all polling on HTTP 403 revocation in useUsageReadings (Bug 9)", async () => {
    const conn = makeConnection("host-bug9");
    applyHostQuotaScope(conn, "alpha", makeScope(BASE_NOW - 60_000, 25), BASE_NOW);
    expect(mem.get(SAVED_QUOTA_KEY)).toContain("alpha");

    conn.readEngineQuota.mockRejectedValue(new HubHttpError(403, "forbidden"));

    let latest: QuotaView | undefined;
    function Harness() {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: true,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness)); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toBeUndefined();
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("alpha");

    // Advance 30 minutes: zero further background polls after 403 revocation!
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);
  });

  it("shows cached readings on cold offline start and never loops or resurrects auth_changed in useEngineQuota (Bugs 1, 2, 8, 9)", async () => {
    const conn = makeConnection("host-settings-1");
    const initial = makeScope(BASE_NOW - 5 * 60_000, 40);
    const second = makeScope(BASE_NOW - 5 * 60_000, 55, { id: "beta", botIds: ["beta"], label: "Review Bot" });
    applyHostQuotaScope(conn, "alpha", initial, BASE_NOW);
    applyHostQuotaScope(conn, "beta", second, BASE_NOW);
    resetQuotaStoreForTests();

    const conn2 = makeConnection("host-settings-1");
    let liveDir: QuotaDirectory = { generatedAt: isoAt(BASE_NOW), scopes: [initial, second], truncated: false };
    conn2.readEngineQuotas.mockImplementation(async () => liveDir);
    // Opening the page reads each card whose reading is past the Host's 60 s freshness without a click (#75, #96).
    // The Host answers with the reading it has and a cooldown, as a Gateway does.
    conn2.refreshEngineQuota.mockImplementation(async (scope: Pick<QuotaScope, "id">) => ({
      ...liveDir.scopes.find(item => item.id === scope.id)!,
      observedAt: isoAt(BASE_NOW),
      nextRefreshAt: isoAt(BASE_NOW, 60_000),
    }));

    let hookResult: ReturnType<typeof useEngineQuota> | undefined;
    let renderCount = 0;
    function Harness({ online, supported }: { online: boolean; supported: boolean }) {
      renderCount++;
      const value = useEngineQuota(conn2, {
        userId: "owner",
        owner: true,
        online,
        supported,
        unsupported: false,
        active: true,
      });
      useEffect(() => { hookResult = value; });
      hookResult = value;
      return null;
    }

    // Cold offline start (online=false, supported=false, unsupported=false): cached scopes appear immediately with zero HTTP calls.
    await act(async () => { root!.render(createElement(Harness, { online: false, supported: false })); });
    expect(conn2.readEngineQuotas).not.toHaveBeenCalled();
    expect(hookResult?.directory?.scopes).toHaveLength(2);
    expect(hookResult?.cachedScopeIds.has("alpha")).toBe(true);

    // Come online: loads live directory with 2 scopes without any infinite loop!
    const rendersBeforeOnline = renderCount;
    await act(async () => { root!.render(createElement(Harness, { online: true, supported: true })); });
    expect(conn2.readEngineQuotas).toHaveBeenCalledTimes(1);
    // Both five-minute-old cards are read once each, automatically, and that is all: the list is not read
    // again and no card is read twice.
    expect(conn2.refreshEngineQuota.mock.calls.map(args => (args[0] as QuotaScope).id).sort()).toEqual(["alpha", "beta"]);
    expect(renderCount - rendersBeforeOnline).toBeLessThan(10);
    expect(hookResult?.busy).toEqual([]);
    expect(hookResult?.directory?.scopes).toHaveLength(2);
    expect(hookResult?.cachedScopeIds.size).toBe(0);

    // Background conversation refreshes alpha with a newer reading -> Settings updates in place!
    const fresher = makeScope(BASE_NOW + 10_000, 12);
    await act(async () => { applyHostQuotaScope(conn2, "alpha", fresher, BASE_NOW + 10_000); });
    const alphaCard = hookResult?.directory?.scopes.find(s => s.id === "alpha");
    expect(alphaCard?.observedAt).toBe(fresher.observedAt);
    expect(alphaCard?.pools[0]?.windows[0]).toMatchObject({ usedPercent: 12 });

    // Refresh returns auth_changed -> old reading is cleared and never resurrected!
    const authChanged: QuotaScope = {
      ...makeScope(BASE_NOW, 0, { revision: "rev_2", observedAt: undefined, state: "unknown", pools: [], constraints: [] }),
      reason: "auth_changed",
    };
    conn2.refreshEngineQuota.mockResolvedValueOnce(authChanged);
    await act(async () => { await hookResult!.refresh(alphaCard!); });
    const afterAuth = hookResult?.directory?.scopes.find(s => s.id === "alpha");
    expect(afterAuth).toMatchObject({ reason: "auth_changed", observedAt: undefined });
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("\"alpha\"");

    // 403 on refresh evicts the entire host from store + localStorage!
    conn2.refreshEngineQuota.mockRejectedValueOnce(new HubHttpError(403, "forbidden"));
    const betaCard = hookResult?.directory?.scopes.find(s => s.id === "beta")!;
    await act(async () => { await hookResult!.refresh(betaCard); });
    expect(hookResult?.error).toBe("permission");
    expect(hookResult?.directory).toBeUndefined();
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("beta");
  });

  // What the Settings page learns must reach the conversation battery, which reads the shared store only.
  function settingsHarness(conn: FakeConnection) {
    const result: { value?: ReturnType<typeof useEngineQuota> } = {};
    function Harness() {
      result.value = useEngineQuota(conn, { userId: "owner", owner: true, online: true, supported: true, unsupported: false, active: true });
      return null;
    }
    return { result, element: createElement(Harness) };
  }

  it.each(["auth_changed", "login_required", "mode_not_supported", "not_adapted", "scope_unverifiable"] as const)(
    "retires the Settings reading when a conversation reports %s, then shows the new login", async reason => {
      const conn = makeConnection("host-settings-retired");
      const initial = makeScope(BASE_NOW, 40);
      conn.readEngineQuotas.mockResolvedValue({ generatedAt: isoAt(BASE_NOW), scopes: [initial], truncated: false });
      const { result, element } = settingsHarness(conn);
      await act(async () => { root!.render(element); });
      expect(result.value?.directory?.scopes[0]?.observedAt).toBe(initial.observedAt);

      // The conversation's worker invalidates this login without a new observedAt.
      // Settings keeps its original directory and only re-renders through the store subscriber.
      const retired = { ...initial, reason, observedAt: undefined, pools: [], state: "unknown" as const };
      await act(async () => { applyHostQuotaScope(conn, "alpha", retired, BASE_NOW); });
      expect(readStoredQuota(conn, "alpha", BASE_NOW)).toBeUndefined();
      expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain('"alpha"');
      expect(result.value?.directory?.scopes[0]).toEqual(retired);
      expect(result.value?.cachedScopeIds.size).toBe(0);
      // The same login retired: a store notification must not issue a directory/native refresh or feed itself back.
      expect(conn.readEngineQuotas).toHaveBeenCalledTimes(1);

      // Another login: the list is read once more, and the Host now lists that login.
      const current = makeScope(BASE_NOW + 10_000, 12, { revision: "new_login" });
      conn.readEngineQuotas.mockResolvedValue({ generatedAt: isoAt(BASE_NOW + 10_000), scopes: [current], truncated: false });
      await act(async () => { applyHostQuotaScope(conn, "alpha", current, BASE_NOW + 10_000); });
      expect(result.value?.directory?.scopes[0]).toEqual(current);
      expect(result.value?.cachedScopeIds.size).toBe(0);
      expect(conn.readEngineQuotas).toHaveBeenCalledTimes(2);
      expect(conn.refreshEngineQuota).not.toHaveBeenCalled();
    },
  );

  it("Refresh still reaches the Host for a card showing a conversation's new login while the list holds the old one", async () => {
    const conn = makeConnection("host-settings-new-login-refresh");
    const initial = makeScope(BASE_NOW, 40);
    conn.readEngineQuotas.mockResolvedValueOnce({ generatedAt: isoAt(BASE_NOW), scopes: [initial], truncated: false });
    const { result, element } = settingsHarness(conn);
    await act(async () => { root!.render(element); });

    // The list is read again for the new login, but that read fails: the page keeps the old list.
    conn.readEngineQuotas.mockRejectedValueOnce(new Error("network"));
    const moved = { ...initial, revision: "rev_2", reason: "auth_changed", observedAt: undefined, pools: [], state: "unknown" as const };
    await act(async () => { applyHostQuotaScope(conn, "alpha", moved, BASE_NOW); });
    const shown = result.value!.directory!.scopes[0]!;
    expect(shown.revision).toBe("rev_2");

    const fresh = makeScope(BASE_NOW + 1_000, 5, { revision: "rev_2" });
    conn.refreshEngineQuota.mockResolvedValueOnce(fresh);
    await act(async () => { await result.value!.refresh(shown, [shown.id]); });
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);
    expect(conn.refreshEngineQuota.mock.calls[0]?.[0]).toMatchObject({ id: "alpha", revision: "rev_2" });
    expect(result.value?.directory?.scopes[0]).toMatchObject({ revision: "rev_2", observedAt: fresh.observedAt });
  });

  it("reads the list once per reported login and does not repeat it while the Host still lists the old one", async () => {
    const conn = makeConnection("host-settings-new-login-once");
    const initial = makeScope(BASE_NOW, 40);
    conn.readEngineQuotas.mockResolvedValue({ generatedAt: isoAt(BASE_NOW), scopes: [initial], truncated: false });
    const { result, element } = settingsHarness(conn);
    await act(async () => { root!.render(element); });
    const moved = makeScope(BASE_NOW + 1_000, 5, { revision: "rev_2" });
    await act(async () => { applyHostQuotaScope(conn, "alpha", moved, BASE_NOW + 1_000); });
    expect(conn.readEngineQuotas).toHaveBeenCalledTimes(2);
    // The same report arrives again: no further read, and nothing feeds back on later renders.
    await act(async () => { applyHostQuotaScope(conn, "alpha", moved, BASE_NOW + 2_000); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(result.value?.directory?.scopes[0]?.revision).toBe("rev_2");
    expect(conn.readEngineQuotas).toHaveBeenCalledTimes(2);
    expect(conn.refreshEngineQuota).not.toHaveBeenCalled();
  });

  it("shows each Bot in one card after one of two Bots sharing a login changes login in a conversation", async () => {
    const conn = makeConnection("host-settings-shared-split");
    const shared = { sharing: "verified" as const, botIds: ["alpha", "beta"] };
    const alpha = makeScope(BASE_NOW, 40, shared);
    const beta = makeScope(BASE_NOW, 40, { ...shared, id: "beta", label: "Beta Bot" });
    conn.readEngineQuotas.mockResolvedValueOnce({ generatedAt: isoAt(BASE_NOW), scopes: [alpha, beta], truncated: false });
    const { result, element } = settingsHarness(conn);
    await act(async () => { root!.render(element); });

    const moved = makeScope(BASE_NOW + 1_000, 5, { revision: "rev_2", sharing: "unverified", botIds: ["alpha"] });
    const betaAlone = { ...beta, sharing: "unverified" as const, botIds: ["beta"] };
    conn.readEngineQuotas.mockResolvedValueOnce({ generatedAt: isoAt(BASE_NOW + 1_000), scopes: [moved, betaAlone], truncated: false });
    await act(async () => { applyHostQuotaScope(conn, "alpha", moved, BASE_NOW + 1_000); });
    expect(conn.readEngineQuotas).toHaveBeenCalledTimes(2);
    const cards = groupQuotaScopesByAccount(result.value!.directory!.scopes, { now: BASE_NOW + 1_000 });
    for (const id of ["alpha", "beta"]) expect(cards.filter(card => card.bots.some(bot => bot.id === id))).toHaveLength(1);
    expect(cards.find(card => card.bots.some(bot => bot.id === "alpha"))?.primary.revision).toBe("rev_2");
  });

  it("reads a card shared by two Bots once, and the reading reaches the other Bot through the shared store (#77 with #137)", async () => {
    const conn = makeConnection("host-settings-shared");
    const shared = { sharing: "verified" as const, botIds: ["alpha", "beta"] };
    const alpha = makeScope(BASE_NOW - 5 * 60_000, 40, { ...shared });
    const beta = makeScope(BASE_NOW - 5 * 60_000, 40, { ...shared, id: "beta", revision: "rev_beta", label: "Review Bot" });
    conn.readEngineQuotas.mockResolvedValue({ generatedAt: isoAt(BASE_NOW), scopes: [alpha, beta], truncated: false });
    const fresh = makeScope(BASE_NOW, 12, { ...shared, nextRefreshAt: isoAt(BASE_NOW, 60_000) });
    conn.refreshEngineQuota.mockResolvedValue(fresh);
    const { result, element } = settingsHarness(conn);

    await act(async () => { root!.render(element); });

    // One native read for the card, not one per Bot.
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);
    expect((conn.refreshEngineQuota.mock.calls[0]![0] as QuotaScope).id).toBe("alpha");
    // The page shows the new reading on both members, each under its own identity.
    expect(result.value?.directory?.scopes.map(scope => [scope.id, scope.revision, scope.observedAt, scope.pools[0]?.windows[0]])).toEqual([
      ["alpha", "rev_1", fresh.observedAt, expect.objectContaining({ usedPercent: 12 })],
      ["beta", "rev_beta", fresh.observedAt, expect.objectContaining({ usedPercent: 12 })],
    ]);
    // The other Bot's conversation reads the store: it holds the copied reading, live and under that Bot's own login.
    const held = readStoredQuota(conn, "beta", BASE_NOW);
    expect(held).toMatchObject({ fromCache: false, scope: { id: "beta", revision: "rev_beta", label: "Review Bot", observedAt: fresh.observedAt } });
    expect(held?.scope.pools[0]?.windows[0]).toMatchObject({ usedPercent: 12 });
    expect(mem.get(SAVED_QUOTA_KEY)).toContain(`"beta"`);
  });

  it("puts a slow Claude read's late answer into the shared store as well as on the card (#96 with #137)", async () => {
    const conn = makeConnection("host-settings-late");
    const empty: QuotaScope = { ...makeScope(BASE_NOW, 0, { id: "writer", botIds: ["writer"], engine: "claude", label: "Writing Bot", revision: "writer_rev", observedAt: undefined, state: "unknown", pools: [] }), reason: "no_passive_event" };
    conn.readEngineQuotas.mockResolvedValue({ generatedAt: isoAt(BASE_NOW), scopes: [empty], truncated: false });
    // The read times out on the Host, which keeps asking Claude Code and saves the answer when it comes.
    conn.refreshEngineQuota.mockResolvedValue({ ...empty, state: "unavailable", reason: "timeout", lastAttemptAt: isoAt(BASE_NOW) });
    conn.readEngineQuota.mockResolvedValue({ ...empty, reason: "not_loaded" });
    const { result, element } = settingsHarness(conn);

    await act(async () => { root!.render(element); });
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);
    expect(result.value?.waitingLate).toEqual(["writer"]);
    expect(readStoredQuota(conn, "writer", BASE_NOW)).toBeUndefined();

    // Nothing yet at the first look; then the answer is there.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    expect(result.value?.waitingLate).toEqual(["writer"]);
    const late = makeScope(BASE_NOW + 4_000, 31, { id: "writer", botIds: ["writer"], engine: "claude", label: "Writing Bot", revision: "writer_rev" });
    conn.readEngineQuota.mockResolvedValue(late);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });

    expect(result.value?.waitingLate).toEqual([]);
    expect(result.value?.directory?.scopes[0]).toMatchObject({ id: "writer", state: "ready", observedAt: late.observedAt });
    expect(readStoredQuota(conn, "writer", Date.now())).toMatchObject({ fromCache: false, scope: { id: "writer", revision: "writer_rev", observedAt: late.observedAt } });
    // Still one native read: the late answer came from the Host's cache.
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);
  });
});
