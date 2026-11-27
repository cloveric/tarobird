import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import {
  applyHostQuotaScope,
  clearStoredQuotaHost,
  readStoredQuota,
  subscribeQuotaStore,
  type StoredQuota,
} from "./quota-store.js";
import {
  contextView,
  hasUnresetQuotaData,
  mayAskEngine,
  QUOTA_MAX_STALE_MS,
  QUOTA_SHOWN_FOR_MS,
  quotaRetryDelayMs,
  quotaView,
  quotaViewEndsAt,
  quotaViewNextChangeAt,
  workerAnswered,
  type QuotaAttempt,
} from "./usage-readings.js";

/** The engine is asked for quota again once the shown reading is this old; opening the details asks after a minute. */
const QUOTA_READ_AGAIN_MS = 5 * 60_000, QUOTA_DETAILS_READ_AGAIN_MS = 60_000, QUOTA_RENEW_BEFORE_MS = 20_000;
/** Minute tick so stale age labels ("old · 12 min ago") stay accurate while a conversation stays open. */
const QUOTA_AGE_TICK_MS = 60_000;
/** When the engine was last asked per Host and Bot, so a failing read is not repeated at every opened conversation. */
let attempts = new WeakMap<HubConnection, Map<string, QuotaAttempt>>();
/** Consecutive failed/unproductive renewal attempts per Host and Bot, used for background retry backoff. */
let failureCounts = new WeakMap<HubConnection, Map<string, { failures: number; signIn: boolean }>>();
/** Connections whose owner quota authorization was denied (HTTP 401/403) during the current session. */
let deniedConnections = new WeakSet<HubConnection>();

const isFreshHeld = (entry: StoredQuota | undefined, at: number): boolean =>
  !!entry && !entry.fromCache && !!entry.scope.observedAt &&
  (entry.scope.state === "ready" || entry.scope.state === "stale") &&
  hasUnresetQuotaData(entry.scope, at) &&
  (at - Date.parse(entry.scope.observedAt)) < QUOTA_SHOWN_FOR_MS;

/** Context left in one conversation and quota left for its Bot.
 * A known quota reading stays visible (marked old) past its fresh period until a window resets
 * or a newer reading arrives, and retries in the background with exponential backoff. */
export function useUsageReadings(connection: HubConnection, input: {
  conversationId?: string; botId?: string; model: string;
  /** This user may see the Bot's quota (including device-cached readings before WS ready). */ quota: boolean;
  /** The Host is online and confirmed to serve engine quotas; network reads/polls are allowed. */ quotaLive?: boolean;
  /** The Host serves context usage and this view shows it. */ context: boolean;
  /** The conversation's newest finished Bot message, once its messages are loaded. A change means a reply has just ended. */ turn: string | undefined;
}) {
  const { conversationId, botId, model, quota, context, turn } = input;
  const quotaLive = input.quotaLive ?? quota;
  const [, redraw] = useState(0);
  // Separate from `redraw` so minute age-label ticks never cancel/reset a multi-minute backoff timer.
  const [pollSeq, setPollSeq] = useState(0);
  const [deniedFlag, setDeniedFlag] = useState(() => deniedConnections.has(connection));
  const [usage, setUsage] = useState<{ key: string; value: ContextUsage }>();
  const key = `${conversationId ?? ""}:${botId ?? ""}`;
  const live = useRef({ connection, key }); live.current = { connection, key };

  const quotaDenied = deniedConnections.has(connection);
  void deniedFlag;
  const canShowQuota = quota && !quotaDenied;
  const canPoll = canShowQuota && quotaLive;
  const canPollRef = useRef(canPoll); canPollRef.current = canPoll;

  useEffect(() => {
    setDeniedFlag(deniedConnections.has(connection));
  }, [connection]);

  // Pause while offline; on reconnect (or initial WS ready), reset backoff and re-enable polling immediately.
  const prevLive = useRef<{ connection: HubConnection; quotaLive: boolean }>({ connection, quotaLive });
  useEffect(() => {
    const prev = prevLive.current;
    prevLive.current = { connection, quotaLive };
    if (prev.connection === connection && !prev.quotaLive && quotaLive) {
      deniedConnections.delete(connection);
      setDeniedFlag(false);
      failureCounts.get(connection)?.clear();
      const asked = attempts.get(connection);
      if (asked) {
        for (const [id, item] of asked) if (!item.signIn) asked.delete(id);
      }
      setPollSeq(count => count + 1);
    }
  }, [connection, quotaLive]);

  // Subscribe to shared quota store so refreshes from Settings → Model quotas or other views update here immediately.
  useEffect(() => {
    if (!canShowQuota || !botId) return;
    return subscribeQuotaStore(connection, () => {
      const now = Date.now();
      if (isFreshHeld(readStoredQuota(connection, botId, now), now)) {
        failureCounts.get(connection)?.delete(botId);
      }
      redraw(count => count + 1);
    });
  }, [connection, canShowQuota, botId]);

  // One read at a time per conversation; a request that arrives meanwhile runs once afterwards.
  const reading = useRef<{ key: string; again?: number }>(undefined);
  const read = useCallback(async (olderThan: number) => {
    if (!botId) return;
    const current = () => live.current.connection === connection && live.current.key === key;
    if (reading.current?.key === key) { reading.current.again = Math.min(reading.current.again ?? Infinity, olderThan); return; }
    const mine = reading.current = { key } as { key: string; again?: number };
    const readings: Promise<void>[] = [];
    // A context read that fails has no answer: the ring goes rather than keep an old number.
    if (context && conversationId) readings.push(connection.readContextUsage(conversationId, botId).then(value => { if (current()) setUsage({ key, value }); }, () => { if (current()) setUsage(undefined); }));
    if (canPoll) readings.push((async () => {
      const asked = attempts.get(connection) ?? new Map<string, QuotaAttempt>(); attempts.set(connection, asked);
      const fails = failureCounts.get(connection) ?? new Map<string, { failures: number; signIn: boolean }>(); failureCounts.set(connection, fails);
      const recordFailure = (signIn = false) => {
        const prev = fails.get(botId);
        fails.set(botId, { failures: (prev?.failures ?? 0) + 1, signIn });
      };
      const recordSuccess = () => { fails.set(botId, { failures: 0, signIn: false }); };
      try {
        const before = readStoredQuota(connection, botId, Date.now());
        let scope = await connection.readEngineQuota(botId);
        let held = applyHostQuotaScope(connection, botId, scope, Date.now());
        const nowAfterRead = Date.now();
        const isFreshNow = isFreshHeld(held, nowAfterRead);
        if (mayAskEngine(scope, held?.scope, asked.get(botId), nowAfterRead, olderThan)) {
          asked.set(botId, { revision: scope.revision, at: nowAfterRead, signIn: false });
          scope = await connection.refreshEngineQuota(scope);
          const nowAfterRefresh = Date.now();
          held = applyHostQuotaScope(connection, botId, scope, nowAfterRefresh);
          if (scope.state === "login_required") {
            asked.set(botId, { revision: scope.revision, at: nowAfterRefresh, signIn: true });
            recordFailure(true);
          } else if (isFreshHeld(held, nowAfterRefresh) && !!scope.observedAt && (!before?.scope.observedAt || Date.parse(scope.observedAt) >= Date.parse(before.scope.observedAt))) {
            recordSuccess();
          } else {
            recordFailure(false);
          }
        } else if (!workerAnswered(scope)) {
          recordFailure(false);
        } else if (scope.state === "login_required") {
          asked.set(botId, { revision: scope.revision, at: nowAfterRead, signIn: true });
          recordFailure(true);
        } else if (isFreshNow) {
          recordSuccess();
        } else if (scope.capability.mode !== "unsupported") {
          // Passive engines waiting for usage events or active engines still waiting out a cooldown / unconfirmed cache:
          // keep retrying with exponential backoff rather than stalling permanently.
          recordFailure(false);
        } else {
          recordSuccess();
        }
      } catch (error) {
        if (error instanceof HubHttpError && (error.status === 401 || error.status === 403)) {
          clearStoredQuotaHost(connection);
          fails.delete(botId);
          asked.delete(botId);
          deniedConnections.add(connection);
          if (current()) setDeniedFlag(true);
          return;
        }
        recordFailure(false);
      } finally {
        if (current()) {
          redraw(count => count + 1);
          setPollSeq(count => count + 1);
        }
      }
    })());
    await Promise.allSettled(readings);
    if (reading.current === mine) reading.current = undefined;
    // The request that waited runs with the view's current settings, not the ones this read started with.
    if (mine.again !== undefined && current()) void latest.current(mine.again);
  }, [connection, conversationId, botId, key, canPoll, context]);

  const latest = useRef(read); latest.current = read;
  const prevReadTrigger = useRef<{ connection: HubConnection; key: string; context: boolean; canPoll: boolean }>(undefined);
  useEffect(() => {
    const prev = prevReadTrigger.current;
    prevReadTrigger.current = { connection, key, context, canPoll };
    const onlyStoppedQuota = !!prev && prev.connection === connection && prev.key === key && prev.context === context && prev.canPoll && !canPoll;
    if (!onlyStoppedQuota && (canPoll || (context && conversationId))) void read(QUOTA_READ_AGAIN_MS);
  }, [connection, conversationId, key, context, canPoll, read]);

  const seen = useRef<{ key: string; turn: string | undefined }>(undefined);
  useEffect(() => {
    const previous = seen.current; seen.current = { key, turn };
    if (previous?.key === key && previous.turn !== undefined && turn !== undefined && previous.turn !== turn) void read(QUOTA_READ_AGAIN_MS);
  }, [key, turn, read]);

  const now = Date.now();
  const stored = canShowQuota && botId ? readStoredQuota(connection, botId, now) : undefined;
  const quotaReading = stored ? quotaView(stored.scope, model, now, { fromCache: stored.fromCache }) : undefined;

  // Keep trying in the background with exponential backoff while online and this conversation stays open.
  const failState = botId ? failureCounts.get(connection)?.get(botId) : undefined;
  const failCount = failState?.failures ?? 0;
  const signInBackoff = failState?.signIn ?? false;
  useEffect(() => {
    if (!canPoll || !botId) return;
    const delay = quotaRetryDelayMs(failCount, signInBackoff);
    const retryOlderThan = failCount > 0 ? Math.min(QUOTA_READ_AGAIN_MS, delay) : QUOTA_READ_AGAIN_MS;
    // +50ms margin ensures timer jitter never makes mayAskEngine reject a scheduled retry by a few milliseconds.
    const timer = setTimeout(() => { void latest.current(retryOlderThan); }, delay + 50);
    return () => clearTimeout(timer);
  }, [connection, botId, canPoll, pollSeq, failCount, signInBackoff]);

  const endsAt = quotaReading ? quotaViewEndsAt(quotaReading) : undefined;
  const nextChangeAt = quotaReading ? quotaViewNextChangeAt(quotaReading) : undefined;
  const isStale = quotaReading?.stale === true;
  const hasWindowReset = !!quotaReading && endsAt !== undefined && endsAt < Date.parse(quotaReading.observedAt) + QUOTA_MAX_STALE_MS;

  // Take one more reading shortly before the shown reading ends (e.g., before a window resets).
  useEffect(() => {
    if (!canPoll || !botId || endsAt === undefined) return;
    const left = endsAt - Date.now();
    if (left <= QUOTA_RENEW_BEFORE_MS) return;
    const renew = setTimeout(() => { void latest.current(QUOTA_READ_AGAIN_MS); }, left - QUOTA_RENEW_BEFORE_MS);
    return () => clearTimeout(renew);
  }, [connection, botId, canPoll, endsAt]);

  // Redraw at fresh→stale boundary or window reset (triggering an immediate post-reset read if online),
  // and tick every minute while stale so relative age labels never freeze.
  useEffect(() => {
    if (nextChangeAt === undefined) return;
    const wait = Math.max(0, nextChangeAt - Date.now()) + 50;
    const changeTimer = setTimeout(() => {
      redraw(count => count + 1);
      if (canPollRef.current && hasWindowReset && endsAt !== undefined && nextChangeAt === endsAt) {
        void latest.current(0);
      }
    }, wait);
    const ageTimer = isStale ? setInterval(() => redraw(count => count + 1), QUOTA_AGE_TICK_MS) : undefined;
    return () => { clearTimeout(changeTimer); if (ageTimer !== undefined) clearInterval(ageTimer); };
  }, [nextChangeAt, isStale, endsAt, hasWindowReset]);

  return {
    context: context && usage?.key === key ? contextView(usage.value) : undefined,
    quota: quotaReading,
    /** The details were opened: take a newer reading if the shown one is over a minute old. */
    readForDetails: useCallback(() => { if (canPollRef.current) void read(QUOTA_DETAILS_READ_AGAIN_MS); }, [read]),
  };
}

/** Test-only helper to clear module-level quota polling state between tests. */
export function resetUsageReadingsForTests(): void {
  attempts = new WeakMap<HubConnection, Map<string, QuotaAttempt>>();
  failureCounts = new WeakMap<HubConnection, Map<string, { failures: number; signIn: boolean }>>();
  deniedConnections = new WeakSet<HubConnection>();
}
