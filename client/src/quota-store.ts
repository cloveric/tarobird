import type { QuotaDirectory, QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import {
  forgetSavedQuotaHost,
  hasUnresetQuotaData,
  loadSavedQuota,
  nextHeldQuota,
  QUOTA_CLEARING_REASONS,
  savedQuotaAfter,
  saveQuota,
  SAVED_QUOTA_KEY,
  workerAnswered,
} from "./usage-readings.js";

export type StoredQuota = { scope: QuotaScope; fromCache: boolean };
export type ProjectedQuotaDirectory = {
  directory: QuotaDirectory;
  /** Scope IDs whose displayed reading currently comes from an unconfirmed pre-restart cache or offline fallback. */
  cachedScopeIds: ReadonlySet<string>;
};

/** Shared per-connection quota store so the in-conversation battery and the
 * Settings → Model quotas page always render the exact same reading, including
 * immediately after an App restart from device-local saved readings. */
type StoreEntry = {
  held: Map<string, StoredQuota>;
  saved: Map<string, QuotaScope>;
  /** Latest worker answers, including login invalidations with no reading. Never persisted. */
  answered: Map<string, QuotaScope>;
  hydrated: boolean;
  listeners: Set<() => void>;
};

let stores = new WeakMap<HubConnection, StoreEntry>();

const storage = {
  read: () => { try { return localStorage.getItem(SAVED_QUOTA_KEY); } catch { return null; } },
  write: (value: string) => { try { localStorage.setItem(SAVED_QUOTA_KEY, value); } catch { /* blocked storage */ } },
};

function entryFor(connection: HubConnection, now = Date.now()): StoreEntry {
  let entry = stores.get(connection);
  if (!entry) {
    entry = { held: new Map(), saved: new Map(), answered: new Map(), hydrated: false, listeners: new Set() };
    stores.set(connection, entry);
  }
  const host = connection.identity.hubPublicKey;
  if (!entry.hydrated && host) {
    entry.saved = loadSavedQuota(storage.read(), host, now);
    entry.hydrated = true;
  }
  return entry;
}

function persistEntry(connection: HubConnection, entry: StoreEntry, now: number): void {
  const host = connection.identity.hubPublicKey;
  if (!host) return;
  const merged = new Map<string, QuotaScope>(entry.saved);
  for (const [id, stored] of entry.held) merged.set(id, stored.scope);
  storage.write(saveQuota(storage.read(), host, merged, now));
}

function notify(entry: StoreEntry): void {
  for (const listener of entry.listeners) listener();
}

function reconcileScope(entry: StoreEntry, botId: string, scope: QuotaScope): StoredQuota | undefined {
  // A Hub no-answer cannot confirm or retire a login.
  if (workerAnswered(scope)) entry.answered.set(botId, scope);
  const prevHeld = entry.held.get(botId);
  const earlier = entry.saved.get(botId);
  const fate = earlier && !prevHeld ? savedQuotaAfter(earlier, scope) : "drop";
  if (fate !== "wait") entry.saved.delete(botId);
  const base: StoredQuota | undefined = prevHeld ?? (fate === "adopt" && earlier ? { scope: earlier, fromCache: true } : undefined);
  const nextScope = nextHeldQuota(base?.scope, scope);
  if (!nextScope) {
    entry.held.delete(botId);
    return undefined;
  }
  // A reading is only live-confirmed once a worker answers with an observedAt reading that is accepted.
  // Adopting a persisted reading on `not_loaded` keeps `fromCache: true` until an actual live reading arrives.
  const liveConfirmed = workerAnswered(scope) && !!scope.observedAt && nextScope === scope;
  const next: StoredQuota = {
    scope: nextScope,
    fromCache: liveConfirmed ? false : (base?.fromCache ?? false),
  };
  entry.held.set(botId, next);
  return next;
}

export function subscribeQuotaStore(connection: HubConnection, listener: () => void): () => void {
  const entry = entryFor(connection);
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}

/** Returns the best known reading for a Bot right now. A persisted reading from an
 * earlier run is returned immediately with `fromCache: true` so the battery shows
 * right away (marked old) before the Host answers. */
export function readStoredQuota(connection: HubConnection, botId: string, now = Date.now()): StoredQuota | undefined {
  const entry = entryFor(connection, now);
  const live = entry.held.get(botId);
  if (live) return live;
  const cached = entry.saved.get(botId);
  if (cached && hasUnresetQuotaData(cached, now)) return { scope: cached, fromCache: true };
  return undefined;
}

/** Returns all currently held or cached unreset scopes for this connection. */
export function readAllStoredQuotas(connection: HubConnection, now = Date.now()): Map<string, StoredQuota> {
  const entry = entryFor(connection, now);
  const out = new Map<string, StoredQuota>();
  for (const [id, scope] of entry.saved) {
    if (hasUnresetQuotaData(scope, now)) out.set(id, { scope, fromCache: true });
  }
  for (const [id, stored] of entry.held) {
    if (hasUnresetQuotaData(stored.scope, now)) out.set(id, stored);
  }
  return out;
}

/** Reconciles an incoming Host/worker scope reply with held + persisted readings, persists, and notifies once. */
export function applyHostQuotaScope(connection: HubConnection, botId: string, scope: QuotaScope, now = Date.now()): StoredQuota | undefined {
  const entry = entryFor(connection, now);
  const next = reconcileScope(entry, botId, scope);
  persistEntry(connection, entry, now);
  notify(entry);
  return next;
}

/** Evicts all in-memory and persisted quota readings for this connection's Host (e.g. on 401/403 revocation). */
export function clearStoredQuotaHost(connection: HubConnection): void {
  const existing = stores.get(connection);
  if (existing) {
    existing.held.clear();
    existing.saved.clear();
    existing.answered.clear();
    existing.hydrated = true;
  } else {
    stores.set(connection, { held: new Map(), saved: new Map(), answered: new Map(), hydrated: true, listeners: new Set() });
  }
  const host = connection.identity.hubPublicKey;
  if (host) forgetSavedQuotaHost(host);
  if (existing) notify(existing);
}

function projectQuotaScope(scope: QuotaScope, stored: StoredQuota | undefined, now: number): { scope: QuotaScope; fromCache: boolean } {
  if (!stored) return { scope, fromCache: false };

  // Hub no-answer fallback (offline, timeout, invalid_response, host_upgrade_required).
  if (!workerAnswered(scope)) {
    if (scope.observedAt || !hasUnresetQuotaData(stored.scope, now)) return { scope, fromCache: false };
    // Never overwrite "offline" or "host_upgrade_required" state so Refresh stays disabled for offline/old workers.
    const preserveState = scope.state === "offline" || scope.reason === "host_upgrade_required";
    return {
      scope: {
        ...scope,
        state: preserveState ? scope.state : "stale",
        availability: stored.scope.availability,
        observedAt: stored.scope.observedAt,
        pools: stored.scope.pools,
        constraints: stored.scope.constraints,
      },
      fromCache: true,
    };
  }

  // Worker answered for another login or with a clearing reason: never project a stored reading onto it.
  if (stored.scope.revision !== scope.revision || QUOTA_CLEARING_REASONS.has(scope.reason ?? "")) {
    return { scope, fromCache: false };
  }

  // Directory scope has no reading yet (e.g. not_loaded, no_passive_event, or transient refresh failure).
  if (!scope.observedAt) {
    if (!hasUnresetQuotaData(stored.scope, now)) return { scope, fromCache: false };
    const isEmptyPlaceholder = scope.reason === "not_loaded" || scope.reason === "no_passive_event";
    if (!stored.fromCache) {
      const newerThanAttempt = !scope.lastAttemptAt || (!!stored.scope.observedAt && Date.parse(stored.scope.observedAt) >= Date.parse(scope.lastAttemptAt));
      return {
        scope: {
          ...scope,
          state: isEmptyPlaceholder || newerThanAttempt ? stored.scope.state : "stale",
          reason: isEmptyPlaceholder || newerThanAttempt ? stored.scope.reason : scope.reason,
          availability: stored.scope.availability,
          observedAt: stored.scope.observedAt,
          lastAttemptAt: stored.scope.lastAttemptAt ?? scope.lastAttemptAt,
          nextRefreshAt: stored.scope.nextRefreshAt ?? scope.nextRefreshAt,
          pools: stored.scope.pools,
          constraints: stored.scope.constraints,
          help: stored.scope.help ?? scope.help,
        },
        fromCache: false,
      };
    }
    return {
      scope: {
        ...scope,
        state: "stale",
        reason: isEmptyPlaceholder ? undefined : scope.reason,
        availability: stored.scope.availability,
        observedAt: stored.scope.observedAt,
        pools: stored.scope.pools,
        constraints: stored.scope.constraints,
        help: stored.scope.help ?? scope.help,
      },
      fromCache: true,
    };
  }

  // Directory scope already has an observedAt reading: propagate strictly newer same-revision readings from the store.
  if (stored.scope.observedAt) {
    const scopeMs = Date.parse(scope.observedAt);
    const storedMs = Date.parse(stored.scope.observedAt);
    if (Number.isFinite(storedMs) && (!Number.isFinite(scopeMs) || storedMs > scopeMs)) {
      return {
        scope: {
          ...scope,
          state: stored.fromCache ? "stale" : stored.scope.state,
          reason: stored.scope.reason,
          availability: stored.scope.availability,
          observedAt: stored.scope.observedAt,
          lastAttemptAt: stored.scope.lastAttemptAt ?? scope.lastAttemptAt,
          nextRefreshAt: stored.scope.nextRefreshAt ?? scope.nextRefreshAt,
          pools: stored.scope.pools,
          constraints: stored.scope.constraints,
          help: stored.scope.help ?? scope.help,
        },
        fromCache: stored.fromCache,
      };
    }
    if (
      !stored.fromCache &&
      Number.isFinite(storedMs) &&
      storedMs === scopeMs &&
      stored.scope.nextRefreshAt &&
      (!scope.nextRefreshAt || Date.parse(stored.scope.nextRefreshAt) > Date.parse(scope.nextRefreshAt))
    ) {
      return {
        scope: { ...scope, nextRefreshAt: stored.scope.nextRefreshAt },
        fromCache: false,
      };
    }
  }

  return { scope, fromCache: false };
}

/** Pure, side-effect-free projection of the shared store onto a live Hub directory.
 * Never mutates store state, writes storage, or notifies listeners — safe to call during render or subscription callbacks. */
export function projectQuotaDirectory(connection: HubConnection, directory: QuotaDirectory, now = Date.now()): ProjectedQuotaDirectory {
  const entry = entryFor(connection, now);
  const cachedScopeIds = new Set<string>();
  const scopes = directory.scopes.map((scope) => {
    const stored = readStoredQuota(connection, scope.id, now);
    const answered = entry.answered.get(scope.id);
    // Settings can still hold a directory for a login retired by a conversation's worker.
    // Replace that snapshot even when its reading was cleared, but preserve Hub fallback state.
    const current = workerAnswered(scope) && answered && (!stored || answered.revision !== scope.revision) ? answered : scope;
    const projected = projectQuotaScope(current, stored, now);
    if (projected.fromCache) cachedScopeIds.add(scope.id);
    return projected.scope;
  });
  return { directory: { ...directory, scopes }, cachedScopeIds };
}

/** Ingests a live Hub directory reply into the shared store in one batch (persisting and notifying once)
 * and returns the projected view. */
export function ingestQuotaDirectory(connection: HubConnection, directory: QuotaDirectory, now = Date.now()): ProjectedQuotaDirectory {
  const entry = entryFor(connection, now);
  for (const scope of directory.scopes) reconcileScope(entry, scope.id, scope);
  persistEntry(connection, entry, now);
  notify(entry);
  return projectQuotaDirectory(connection, directory, now);
}

/** Builds a fallback cached directory from persisted readings while loading or offline. */
export function cachedQuotaDirectory(connection: HubConnection, now = Date.now()): QuotaDirectory | undefined {
  const all = readAllStoredQuotas(connection, now);
  if (!all.size) return undefined;
  return {
    generatedAt: new Date(now).toISOString(),
    scopes: [...all.values()].map(({ scope }) => ({ ...scope, state: "stale" as const })),
    truncated: false,
  };
}

/** Test-only helper to clear in-memory WeakMap entries between tests. */
export function resetQuotaStoreForTests(): void {
  stores = new WeakMap<HubConnection, StoreEntry>();
}
