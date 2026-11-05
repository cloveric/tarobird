import { useEffect, useMemo, useRef, useState } from "react";
import type { HubConnection } from "./connection.js";
import type { DiffReviewDraft, DiffReviewNote, DiffReviewScope } from "./diff-review-draft.js";

type Entry = {
  draft: DiffReviewDraft; revision?: string; ready: boolean; error: string;
  pending: number; edits: number; epoch: number; refresh: boolean;
  enabled: boolean; loading?: Promise<void>; refreshTimer?: ReturnType<typeof setTimeout>; tail: Promise<void>;
};

/** Every mutation reserves one serial slot before awaiting. A delayed send/read
 * may update receipt metadata, but may never replace a newer visible edit. */
export function useDiffReview(connection: HubConnection, scope: DiffReviewScope, enabled: boolean) {
  const [, render] = useState(0), mounted = useRef(false);
  const entry = useMemo<Entry>(() => ({ draft: { notes: [] }, ready: false, error: "", pending: 0,
    edits: 0, epoch: 0, refresh: false, enabled, tail: Promise.resolve() }),
  [connection, scope.conversationId, scope.botId, connection.identity.deviceId, connection.identity.hubPublicKey, connection.identity.publicKey]);
  const active = useRef(entry); active.current = entry;
  const notify = () => { if (mounted.current && active.current === entry) render(value => value + 1); };
  const adopt = (value: DiffReviewDraft, edits = entry.edits) => {
    entry.revision = value.revision;
    entry.draft = entry.edits === edits ? value : { ...value, notes: entry.draft.notes, references: entry.draft.references };
    notify();
  };
  const load = (): void => {
    if (!entry.refresh || entry.refreshTimer || entry.loading || entry.pending || entry.error || !entry.enabled) return;
    entry.refresh = false;
    const epoch = entry.epoch, edits = entry.edits;
    entry.loading = connection.cache.diffReviewDraft(scope, connection.identity).then(value => {
      if (epoch !== entry.epoch || edits !== entry.edits || entry.pending || entry.error) { entry.refresh = true; return; }
      adopt(value); entry.ready = true;
    }).catch(() => {
      if (epoch === entry.epoch && !entry.pending) entry.error = "read";
      else entry.refresh = true;
    }).finally(() => {
      entry.loading = undefined; notify();
      // An ACK/refresh received while a read or mutation was pending must be
      // replayed after it settles, even when the connection then stays quiet.
      load();
    });
  };
  // Passive review notifications coalesce a follow-up read. Only a
  // local mutation invalidates the current read: otherwise a busy connection
  // can keep every successful IndexedDB response stale forever.
  const refresh = () => {
    entry.refresh = true;
    // A fixed window, not a reset-on-every-event debounce: sustained updates
    // must still make progress, with at most one read per notification window.
    entry.refreshTimer ??= setTimeout(() => { entry.refreshTimer = undefined; load(); }, 150);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    // A responsive layout change may disable the viewer while its last edit
    // still needs saving. Keep that guard for the entry's mounted lifetime.
    const protect = (event: BeforeUnloadEvent) => { if (entry.pending || entry.error === "save") { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [entry]);
  useEffect(() => {
    entry.enabled = enabled;
    if (!enabled) return;
    entry.refresh = true; load();
    const unsubscribe = connection.cache.subscribeDiffReviews(scope, refresh);
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      entry.enabled = false; unsubscribe(); clearTimeout(entry.refreshTimer); entry.refreshTimer = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [entry, enabled]);
  const reserve = <T,>(operation: () => Promise<T>): Promise<T> => {
    entry.pending++; entry.epoch++; entry.refresh = true; notify();
    const task = entry.tail.then(operation).finally(() => {
      entry.pending--; notify(); load();
    });
    entry.tail = task.then(() => undefined, () => undefined);
    return task;
  };
  const change = (notes: DiffReviewNote[], references = entry.draft.references) => {
    if (!entry.ready || entry.error) return;
    const edits = ++entry.edits;
    entry.draft = { ...entry.draft, notes, references };
    void reserve(async () => {
      if (entry.error) return;
      try { adopt(await connection.cache.saveDiffReviewDraft(scope, connection.identity, notes, entry.revision, references), edits); }
      catch { entry.error = "save"; }
    });
  };
  const flush = async () => {
    // New typing during a wait extends the close guard to that last edit.
    for (;;) { const tail = entry.tail; await tail; if (tail === entry.tail) break; }
    if (entry.error) throw new Error(entry.error);
  };
  const action = <T extends DiffReviewDraft | { draft: DiffReviewDraft },>(operation: () => Promise<T>) => {
    const edits = entry.edits;
    return reserve(async () => {
      if (entry.error) throw new Error(entry.error);
      const result = await operation();
      adopt("draft" in result ? result.draft : result, edits);
      return result;
    });
  };
  return { draft: entry.draft, ready: entry.ready, saving: entry.pending > 0, error: entry.error, change, flush,
    send: () => action(() => connection.queueDiffReview(scope, entry.revision)),
    retry: () => {
      const id = entry.draft.pending?.clientMsgId;
      return id ? action(() => connection.retryDiffReview(scope, id)) : Promise.resolve();
    },
    abandon: () => {
      const id = entry.draft.pending?.clientMsgId;
      return id ? action(() => connection.abandonDiffReview(scope, id)) : Promise.resolve();
    },
    reload: () => { void entry.tail.then(() => { entry.error = ""; refresh(); notify(); }); },
  };
}
