import { describe, expect, it } from "vitest";
import type { QuotaScope } from "../../src/client-protocol/engine-quota.js";
import { ENGINE_QUOTA_UI, engineQuotaPageVisible, startingSettingsSection } from "../src/engine-quota-feature.js";
import { autoRefreshQueue, drainBoundedQueue, evaluateLatePoll, MAX_CONCURRENT_QUOTA_REFRESH, shouldAutoRefreshScope } from "../src/use-engine-quota.js";

const BASE_NOW = Date.parse("2026-11-26T10:00:00Z");
const iso = (deltaMs: number) => new Date(BASE_NOW + deltaMs).toISOString();

function makeScope(patch: Partial<QuotaScope> = {}): QuotaScope {
  return {
    id: "writer",
    revision: "writer_rev_1",
    engine: "claude",
    label: "Writing Bot",
    botIds: ["writer"],
    sharing: "unverified",
    authMode: "subscription",
    capability: { mode: "active" },
    state: "unknown",
    reason: "not_loaded",
    availability: "unknown",
    pools: [],
    constraints: [],
    ...patch,
  };
}

describe("model quota settings", () => {
  it("is part of an ordinary build, for the owner only", () => {
    expect(import.meta.env.VITE_TAROBIRD_ENGINE_QUOTA_UI).toBeUndefined();
    expect(ENGINE_QUOTA_UI).toBe(true);
    expect(engineQuotaPageVisible("owner")).toBe(true);
    expect(engineQuotaPageVisible("member")).toBe(false);
    expect(engineQuotaPageVisible(undefined)).toBe(false);
    expect(startingSettingsSection("quota")).toBe("quota");
  });

  it("a build without it sends a request for the quota category to the default one", () => {
    expect(engineQuotaPageVisible("owner", false)).toBe(false);
    expect(startingSettingsSection("quota", false)).toBe("general");
    expect(startingSettingsSection("devices", false)).toBe("devices");
    expect(startingSettingsSection("general", false)).toBe("general");
  });
});

describe("shouldAutoRefreshScope", () => {
  it("refreshes active empty, stale, or expired cards and respects cooldown using server-adjusted clock", () => {
    expect(shouldAutoRefreshScope(makeScope(), BASE_NOW)).toBe(true);
    expect(shouldAutoRefreshScope(makeScope({ state: "stale", reason: undefined, observedAt: iso(-10_000) }), BASE_NOW)).toBe(true);
    // Fresh reading is skipped, but a clock shifted forward past the 60 s TTL triggers refresh.
    const fresh = makeScope({ state: "ready", reason: undefined, observedAt: iso(-10_000) });
    expect(shouldAutoRefreshScope(fresh, BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(fresh, BASE_NOW + 55_000)).toBe(true);
    // Cooldown honors server-adjusted time.
    const cooling = makeScope({ nextRefreshAt: iso(30_000) });
    expect(shouldAutoRefreshScope(cooling, BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(cooling, BASE_NOW + 30_000)).toBe(true);
  });

  it("never auto-refreshes passive, unsupported, offline, login_required, or upgrade-required cards", () => {
    expect(shouldAutoRefreshScope(makeScope({ capability: { mode: "passive" } }), BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(makeScope({ capability: { mode: "unsupported" }, state: "unsupported" }), BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(makeScope({ state: "offline", reason: "offline" }), BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(makeScope({ state: "login_required", reason: "login_required" }), BASE_NOW)).toBe(false);
    expect(shouldAutoRefreshScope(makeScope({ state: "unavailable", reason: "host_upgrade_required" }), BASE_NOW)).toBe(false);
  });
});

describe("autoRefreshQueue", () => {
  it("starts one read per card: Bots confirmed on one account are read once, through the reading their card shows", () => {
    const shared = { engine: "codex" as const, sharing: "verified" as const, botIds: ["coder", "reviewer"], reason: undefined };
    const scopes = [
      makeScope({ ...shared, id: "coder", revision: "coder_rev", state: "stale", observedAt: iso(-3_600_000) }),
      makeScope({ ...shared, id: "reviewer", revision: "reviewer_rev", state: "stale", observedAt: iso(-1_800_000) }),
      makeScope({ id: "writer" }),
      makeScope({ id: "fresh", revision: "fresh_rev", state: "ready", reason: undefined, observedAt: iso(-10_000) }),
      makeScope({ id: "research", revision: "research_rev", engine: "kimi", capability: { mode: "unsupported" }, state: "unsupported", reason: "not_adapted" }),
    ];
    expect(autoRefreshQueue(scopes, BASE_NOW).map(item => [item.scope.id, item.group])).toEqual([
      ["reviewer", ["coder", "reviewer"]],
      ["writer", ["writer"]],
    ]);
    // A shared card whose newest reading is still fresh is not read again for its older member.
    const settled = [scopes[0]!, makeScope({ ...shared, id: "reviewer", revision: "reviewer_rev", state: "ready", observedAt: iso(-10_000) })];
    expect(autoRefreshQueue(settled, BASE_NOW)).toEqual([]);
    // The page takes the queue two at a time.
    expect(MAX_CONCURRENT_QUOTA_REFRESH).toBe(2);
  });
});

describe("evaluateLatePoll", () => {
  const timedOutScope = makeScope({ state: "unavailable", reason: "timeout" });

  it("keeps waiting on real ClaudeStreamAdapter not_loaded cache reads and unchanged prior readings", () => {
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "unknown", reason: "not_loaded" }))).toBe("wait");
    expect(evaluateLatePoll(timedOutScope, iso(-30_000), makeScope({ state: "stale", reason: undefined, observedAt: iso(-30_000) }))).toBe("wait");
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "unavailable", reason: "timeout" }))).toBe("wait");
    // Transient Hub cache-read timeout does not overwrite the real scope revision.
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ revision: "timeout", state: "unavailable", reason: "timeout" }))).toBe("wait");
  });

  it("updates when a newer ready/stale reading arrives, revision changes, or capability degrades", () => {
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "ready", reason: undefined, observedAt: iso(2_500) }))).toBe("update");
    expect(evaluateLatePoll(timedOutScope, iso(-30_000), makeScope({ state: "stale", reason: undefined, observedAt: iso(2_500) }))).toBe("update");
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ revision: "writer_rev_2", reason: "auth_changed" }))).toBe("update");
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ capability: { mode: "passive" }, reason: "no_passive_event" }))).toBe("update");
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "unsupported", reason: "mode_not_supported" }))).toBe("update");
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "login_required", reason: "login_required" }))).toBe("update");
  });

  it("stops waiting on non-timeout errors without overwriting the card", () => {
    expect(evaluateLatePoll(timedOutScope, undefined, makeScope({ state: "unavailable", reason: "native_error" }))).toBe("stop");
  });
});

describe("drainBoundedQueue", () => {
  it("drains more than MAX_CONCURRENT_QUOTA_REFRESH items without dropping tail items or exceeding concurrency", async () => {
    const items = Array.from({ length: MAX_CONCURRENT_QUOTA_REFRESH + 4 }, (_, index) => `bot-${index + 1}`);
    const completed: string[] = [];
    let active = 0;
    let maxActive = 0;

    await drainBoundedQueue(items, MAX_CONCURRENT_QUOTA_REFRESH, async item => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      completed.push(item);
      active--;
    });

    expect(maxActive).toBe(MAX_CONCURRENT_QUOTA_REFRESH);
    expect(completed).toHaveLength(items.length);
    expect(new Set(completed)).toEqual(new Set(items));
  });

  it("stops dispatching queued items once shouldContinue returns false", async () => {
    const items = ["a", "b", "c", "d", "e"];
    const started: string[] = [];
    let keepGoing = true;

    await drainBoundedQueue(
      items,
      2,
      async item => {
        started.push(item);
        await new Promise(resolve => setTimeout(resolve, 5));
        if (item === "a") keepGoing = false;
      },
      () => keepGoing,
    );

    expect(started).toEqual(["a", "b"]);
  });
});
