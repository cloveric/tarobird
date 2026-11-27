import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ENGINE_QUOTA_HUB_REFRESH_MS, quotaReadingExpired, type QuotaDirectory, type QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { groupQuotaScopesByAccount } from "./quota-ui.js";
import {
  applyHostQuotaScope,
  cachedQuotaDirectory,
  clearStoredQuotaHost,
  ingestQuotaDirectory,
  projectQuotaDirectory,
  subscribeQuotaStore,
} from "./quota-store.js";

/** How many native reads this page runs at once, the automatic ones on opening and manual refreshes together.
 * Two, as in 1.6.0: a read can start a helper process on the Host, which sets no limit of its own. The queue
 * below still reads every card without a click; it only takes them two at a time. */
export const MAX_CONCURRENT_QUOTA_REFRESH = 2;
const LATE_POLL_INTERVAL_MS = 2_500;
const LATE_POLL_MAX_MS = 90_000;
const LATE_POLL_REQUEST_MS = 10_000;

type View = { connection: HubConnection; userId?: string; directory?: QuotaDirectory; loading: boolean; busy: string[]; waitingLate: string[]; errors: Record<string, string>; error?: string; notice?: string };
type Request = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
type LatePoll = { timer?: ReturnType<typeof setTimeout>; request?: Request };
const EMPTY_CACHED: ReadonlySet<string> = new Set();
// Longer than the Hub waits for a refresh, so the page shows the Hub's answer (the engine's own "timeout" included).
const request = (timeoutMs = ENGINE_QUOTA_HUB_REFRESH_MS + 2_000): Request => {
  const controller = new AbortController();
  return { controller, timer: setTimeout(() => controller.abort(), timeoutMs) };
};
const finish = (value: Request) => clearTimeout(value.timer);
const cancel = (value: Request) => { finish(value); value.controller.abort(); };

const canonicalGroup = (item: Pick<QuotaScope, "sharing" | "botIds">) =>
  item.sharing === "verified" ? `verified:${[...new Set(item.botIds)].sort().join(",")}` : "unverified";

function propagateSharedSnapshot(sibling: QuotaScope, refreshed: QuotaScope): QuotaScope {
  return {
    id: sibling.id,
    revision: sibling.revision,
    engine: sibling.engine,
    label: sibling.label,
    botIds: sibling.botIds,
    sharing: sibling.sharing,
    capability: sibling.capability,
    authMode: refreshed.authMode,
    state: refreshed.state,
    availability: refreshed.availability,
    pools: refreshed.pools,
    constraints: refreshed.constraints,
    ...(refreshed.reason !== undefined ? { reason: refreshed.reason } : {}),
    ...(refreshed.observedAt !== undefined ? { observedAt: refreshed.observedAt } : {}),
    ...(refreshed.lastAttemptAt !== undefined ? { lastAttemptAt: refreshed.lastAttemptAt } : {}),
    ...(refreshed.nextRefreshAt !== undefined ? { nextRefreshAt: refreshed.nextRefreshAt } : {}),
    ...(refreshed.help !== undefined ? { help: refreshed.help } : {}),
  };
}

export function shouldAutoRefreshScope(scope: QuotaScope, now: number): boolean {
  if (scope.capability.mode !== "active") return false;
  if (scope.state === "offline" || scope.state === "unsupported" || scope.state === "login_required") return false;
  if (scope.reason === "host_upgrade_required") return false;
  if (scope.nextRefreshAt && Date.parse(scope.nextRefreshAt) > now) return false;
  return !scope.observedAt || scope.state === "unknown" || scope.state === "stale" || quotaReadingExpired(scope, now);
}

/** Decide what one cache-only poll in `watchLateAnswer` means for a slow Claude refresh.
 * Real `ClaudeStreamAdapter` leaves `get_usage` in flight after its initial 7 s timeout
 * and returns `"not_loaded"` (no prior reading) or the prior reading (same `observedAt`,
 * `reason: undefined`) on `refresh: false` until the late answer lands. */
export function evaluateLatePoll(
  scope: Pick<QuotaScope, "revision">,
  previousObservedAt: string | undefined,
  latest: QuotaScope,
): "update" | "wait" | "stop" {
  // Transient Hub cache-read timeout fallback: keep waiting without overwriting the real scope revision.
  if (latest.revision === "timeout" && latest.reason === "timeout") return "wait";
  if (latest.revision !== scope.revision) return "update";
  const newer = Boolean(
    latest.observedAt
    && latest.observedAt !== previousObservedAt
    && (latest.state === "ready" || latest.state === "stale"),
  );
  if (newer) return "update";
  if (latest.capability.mode !== "active" || latest.state === "offline" || latest.state === "unsupported" || latest.state === "login_required") {
    return "update";
  }
  if (latest.reason === undefined || latest.reason === "timeout" || latest.reason === "not_loaded") {
    return "wait";
  }
  return "stop";
}

/** Drain `items` with at most `concurrency` workers in flight, stopping before
 * starting new items once `shouldContinue()` turns false. */
export async function drainBoundedQueue<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const workers = Math.min(Math.max(1, concurrency), items.length);
  if (workers <= 0) return;
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      if (!shouldContinue()) return;
      const item = items[nextIndex++]!;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** One automatic read per card that lacks fresh data. A card is what the page shows: Bots confirmed to share an
 * account are one card, read once through the reading the card displays, exactly as its Refresh button does. */
export function autoRefreshQueue(scopes: readonly QuotaScope[], now: number): { scope: QuotaScope; group: string[] }[] {
  return groupQuotaScopesByAccount(scopes, { now })
    .filter(card => shouldAutoRefreshScope(card.primary, now))
    .map(card => ({ scope: card.primary, group: card.scopes.map(item => item.id) }));
}

/** Quota values live only in the currently authorized settings view. Opening
 * the page shows saved readings immediately (marked old), reads live state and automatically starts one
 * read for each readable card that lacks fresh data (respecting cooldowns and never sending model turns).
 * Every reading the page receives goes into the shared store, so the in-conversation battery shows the same
 * one; what the page shows is a pure projection of that store onto the Host's list. */
export function useEngineQuota(connection: HubConnection, options: {
  userId?: string;
  owner: boolean;
  online: boolean;
  supported: boolean;
  unsupported?: boolean;
  active: boolean;
}) {
  const { userId, owner, online, supported, unsupported = false, active } = options;
  const pageVisible = () => document.visibilityState !== "hidden" && document.documentElement.dataset.mobileLocked !== "true";
  const [shown, setShown] = useState(pageVisible), [appActive, setAppActive] = useState(() => !Capacitor.isNativePlatform());
  const visible = shown && appActive;
  useEffect(() => {
    const update = () => setShown(pageVisible());
    const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mobile-locked"] });
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false, events = 0, remove: (() => void) | undefined;
    void import("@capacitor/app").then(async ({ App }) => {
      const listener = await App.addListener("appStateChange", ({ isActive }) => { events++; if (!disposed) setAppActive(isActive); });
      if (disposed) { await listener.remove(); return; }
      remove = () => { void listener.remove(); };
      const before = events, state = await App.getState(); if (!disposed && before === events) setAppActive(state.isActive);
    }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, []);
  const [view, setView] = useState<View>(() => ({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {} }));
  const [, setStoreVersion] = useState(0);
  const viewRef = useRef(view); viewRef.current = view;
  const version = useRef(0), directoryRequest = useRef<Request>(undefined), scopes = useRef(new Map<string, Request>());
  const latePolls = useRef(new Map<string, LatePoll>());
  const canShow = owner && !unsupported && active && visible;
  const allowed = owner && online && supported && active && visible;
  const current = useRef({ connection, userId, allowed }); current.current = { connection, userId, allowed };
  const clearLatePoll = useCallback((id: string) => {
    const poll = latePolls.current.get(id);
    if (!poll) return;
    if (poll.timer) clearTimeout(poll.timer);
    if (poll.request) cancel(poll.request);
    latePolls.current.delete(id);
  }, []);
  const stop = useCallback(() => {
    version.current++; if (directoryRequest.current) cancel(directoryRequest.current); directoryRequest.current = undefined;
    for (const value of scopes.current.values()) cancel(value); scopes.current.clear();
    for (const poll of latePolls.current.values()) {
      if (poll.timer) clearTimeout(poll.timer);
      if (poll.request) cancel(poll.request);
    }
    latePolls.current.clear();
  }, []);

  const watchLateAnswer = useCallback((scope: QuotaScope, previousObservedAt: string | undefined, generation: number) => {
    clearLatePoll(scope.id);
    const deadline = Date.now() + LATE_POLL_MAX_MS;
    const poll: LatePoll = {};
    latePolls.current.set(scope.id, poll);
    setView(previous => previous.waitingLate.includes(scope.id) ? previous : { ...previous, waitingLate: [...previous.waitingLate, scope.id] });
    const tick = async () => {
      poll.timer = undefined;
      if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
      const operation = request(LATE_POLL_REQUEST_MS);
      poll.request = operation;
      try {
        const latest = await connection.readEngineQuota(scope.id, operation.controller.signal);
        poll.request = undefined;
        if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
        const outcome = evaluateLatePoll(scope, previousObservedAt, latest);
        if (outcome === "update") {
          clearLatePoll(scope.id);
          // The conversation battery reads the shared store: the late answer goes there as well as into this list.
          applyHostQuotaScope(connection, scope.id, latest, Date.now());
          setView(previous => ({
            ...previous,
            directory: previous.directory?.scopes.find(item => item.id === scope.id)?.revision === scope.revision
              ? { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? latest : item) }
              : previous.directory,
            waitingLate: previous.waitingLate.filter(id => id !== scope.id),
          }));
          return;
        }
        if (outcome === "stop" || Date.now() >= deadline) {
          clearLatePoll(scope.id);
          setView(previous => ({ ...previous, waitingLate: previous.waitingLate.filter(id => id !== scope.id) }));
          return;
        }
      } catch (error) {
        poll.request = undefined;
        if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
        if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
          clearStoredQuotaHost(connection);
          stop();
          setView({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {}, error: "permission" });
          return;
        }
        if (error instanceof HubHttpError && error.status === 404 || Date.now() >= deadline) {
          clearLatePoll(scope.id);
          setView(previous => ({ ...previous, waitingLate: previous.waitingLate.filter(id => id !== scope.id) }));
          return;
        }
      } finally {
        finish(operation);
        if (poll.request === operation) poll.request = undefined;
      }
      if (generation === version.current && current.current.allowed && latePolls.current.get(scope.id) === poll) {
        poll.timer = setTimeout(() => void tick(), LATE_POLL_INTERVAL_MS);
      }
    };
    poll.timer = setTimeout(() => void tick(), LATE_POLL_INTERVAL_MS);
  }, [connection, userId, clearLatePoll, stop]);

  const refreshRef = useRef<(scope: QuotaScope, groupScopeIds?: readonly string[]) => Promise<void>>(async () => undefined);

  const readDirectory = useCallback(async (notice?: string) => {
    if (!current.current.allowed) return;
    stop(); const generation = version.current, operation = request(); directoryRequest.current = operation;
    setView(previous => ({ connection, userId, directory: previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: true, busy: [], waitingLate: [], errors: {}, notice }));
    let loaded: QuotaDirectory | undefined;
    try {
      const directory = await connection.readEngineQuotas(operation.controller.signal);
      if (generation !== version.current || directoryRequest.current !== operation) return;
      loaded = directory;
      ingestQuotaDirectory(connection, directory, Date.now());
      const nextView: View = { connection, userId, directory, loading: false, busy: [], waitingLate: [], errors: {}, notice };
      viewRef.current = nextView;
      setView(nextView);
    } catch (error) {
      if (generation !== version.current || directoryRequest.current !== operation) return;
      const denied = error instanceof HubHttpError && [401, 403].includes(error.status);
      if (denied) clearStoredQuotaHost(connection);
      setView(previous => ({ ...previous, directory: denied ? undefined : previous.directory, loading: false, error: denied ? "permission" : error instanceof HubHttpError && error.status === 404 ? "upgrade" : "read" }));
    } finally { finish(operation); if (directoryRequest.current === operation) directoryRequest.current = undefined; }
    if (loaded && notice !== "changed" && generation === version.current && current.current.allowed) {
      const now = Date.now() + (connection.state.serverTimeOffset ?? 0);
      void drainBoundedQueue(
        autoRefreshQueue(loaded.scopes, now),
        MAX_CONCURRENT_QUOTA_REFRESH,
        item => refreshRef.current(item.scope, item.group),
        () => generation === version.current && current.current.allowed,
      );
    }
  }, [connection, userId, stop]);
  useEffect(() => {
    stop(); setView(previous => ({ connection, userId, directory: canShow && previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: false, busy: [], waitingLate: [], errors: {} }));
    if (allowed) void readDirectory();
    return stop;
  }, [connection, userId, canShow, online, allowed, stop, readDirectory]);

  // Keep Settings → Model quotas synchronized when an open conversation updates a Bot's quota in the background.
  // Only bumps a render counter so the pure projection below re-reads the shared store without mutating it.
  useEffect(() => {
    if (!canShow) return;
    return subscribeQuotaStore(connection, () => {
      setStoreVersion(count => count + 1);
    });
  }, [connection, canShow]);
  async function refresh(scope: QuotaScope, groupScopeIds?: readonly string[]) {
    const memberIds = groupScopeIds?.length ? [...new Set([scope.id, ...groupScopeIds])] : [scope.id];
    if (!current.current.allowed || directoryRequest.current || memberIds.some(id => scopes.current.has(id)) || scopes.current.size >= MAX_CONCURRENT_QUOTA_REFRESH) return;
    const before = viewRef.current;
    if (before.connection !== connection || before.userId !== userId || before.error === "permission" || before.directory?.scopes.find(value => value.id === scope.id)?.revision !== scope.revision) return;
    for (const id of memberIds) clearLatePoll(id);
    const generation = version.current, operation = request(); scopes.current.set(scope.id, operation);
    setView(previous => {
      const nextErrors = { ...previous.errors };
      for (const id of memberIds) nextErrors[id] = "";
      return { ...previous, busy: [...previous.busy, scope.id], waitingLate: previous.waitingLate.filter(id => !memberIds.includes(id)), errors: nextErrors, notice: undefined };
    });
    try {
      const value = await connection.refreshEngineQuota(scope, operation.controller.signal);
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      applyHostQuotaScope(connection, scope.id, value, Date.now());
      const wasMerged = memberIds.length > 1 || (scope.sharing === "verified" && scope.botIds.length > 1);
      const membershipChanged = canonicalGroup(scope) !== canonicalGroup(value);
      const nowMerged = value.sharing === "verified" && value.botIds.length > 1;
      if (wasMerged && value.reason === "auth_changed") {
        // Reload the directory so every sibling Bot re-verifies its auth revision and sharing.
        void readDirectory("changed");
        return;
      }
      if ((wasMerged && (value.state === "login_required" || membershipChanged)) || (!wasMerged && nowMerged)) {
        setView(previous => previous.directory?.scopes.find(item => item.id === scope.id)?.revision !== scope.revision ? previous
          : { ...previous, directory: { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? value : item) } });
        void readDirectory();
        return;
      }
      const peerIds = new Set(memberIds.filter(id => id !== scope.id));
      // A directory refresh or authorization change can retire this exact card.
      const held = viewRef.current.directory;
      if (held?.scopes.find(item => item.id === scope.id)?.revision === scope.revision) {
        // The other Bots of a shared card take the same reading. It goes through the shared store, so each of
        // their conversations shows it too, and into this list for the page.
        const copies = new Map<string, QuotaScope>();
        for (const item of held.scopes) {
          if (wasMerged && peerIds.has(item.id) && canonicalGroup(item) === canonicalGroup(value)) copies.set(item.id, propagateSharedSnapshot(item, value));
        }
        const now = Date.now();
        for (const [id, copy] of copies) applyHostQuotaScope(connection, id, copy, now);
        setView(previous => {
          if (previous.directory?.scopes.find(item => item.id === scope.id)?.revision !== scope.revision) return previous;
          return {
            ...previous,
            directory: {
              ...previous.directory,
              scopes: previous.directory.scopes.map(item => {
                if (item.id === scope.id) return value;
                const copy = copies.get(item.id);
                return copy && item.revision === copy.revision ? copy : item;
              }),
            },
          };
        });
      }
      // Slow Claude `get_usage` keeps running in the background and saves its late answer on the Host.
      // Watch the cache briefly instead of showing a timeout error right away.
      if (value.reason === "timeout" && value.engine === "claude" && value.revision === scope.revision) {
        watchLateAnswer(value, value.observedAt ?? scope.observedAt, generation);
      }
    } catch (error) {
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
        clearStoredQuotaHost(connection);
        stop(); setView({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {}, error: "permission" });
      } else if (error instanceof HubHttpError && [404, 409].includes(error.status)) {
        // Only re-read the directory. Never replay the retired native refresh.
        void readDirectory("changed");
      } else setView(previous => ({ ...previous, errors: { ...previous.errors, [scope.id]: "read" } }));
    } finally {
      finish(operation);
      if (scopes.current.get(scope.id) === operation) { scopes.current.delete(scope.id); setView(previous => ({ ...previous, busy: previous.busy.filter(id => id !== scope.id) })); }
    }
  }
  refreshRef.current = refresh;
  const same = view.connection === connection && view.userId === userId && canShow;
  let directory: QuotaDirectory | undefined;
  let cachedScopeIds: ReadonlySet<string> = EMPTY_CACHED;
  if (same && view.error !== "permission" && view.error !== "upgrade") {
    const now = Date.now();
    if (view.directory) {
      const projected = projectQuotaDirectory(connection, view.directory, now);
      directory = projected.directory;
      cachedScopeIds = projected.cachedScopeIds;
    } else {
      const cached = cachedQuotaDirectory(connection, now);
      if (cached) {
        directory = cached;
        cachedScopeIds = new Set(cached.scopes.map(scope => scope.id));
      }
    }
  }
  return { directory, cachedScopeIds, loading: same && view.loading, busy: same ? view.busy : [], waitingLate: same ? view.waitingLate : [], errors: same ? view.errors : {}, error: same ? view.error : undefined, notice: same ? view.notice : undefined, visible, readDirectory, refresh };
}
