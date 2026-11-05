import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SHARE_DRAFT_RETENTION_MS, type ClientCache, type Identity } from "./storage.js";
import type { ShareDraft } from "./share-controller.js";

/** One mounted review owns one native item and one pairing. Queued writes keep
 * that owner; CAS and removal tombstones fence old views and delayed receipts. */
export function useShareDraft(id: string, originalText: string, cache: ClientCache, identity: Identity, createdAt: number) {
  const [draft, setDraft] = useState<ShareDraft>({ text: originalText, recipient: "", mentions: [] });
  const [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [retired, setRetired] = useState(false);
  const live = useRef(true), revision = useRef<string | undefined>(undefined), tail = useRef(Promise.resolve());
  // Every delayed write keeps the original native item's expiry. Deleting an
  // expired tombstone cannot allow an old editor to recreate its payload.
  const expiry = useRef(Math.min(Date.now(), createdAt) + SHARE_DRAFT_RETENTION_MS);
  const current = useRef(draft), pending = useRef(0), failure = useRef(""), edits = useRef(0), loading = useRef(false);
  const report = (value: string) => { failure.current = value; if (live.current) setError(value); };
  const load = async () => {
    if (loading.current) return;
    loading.current = true; setReady(false); const baseline = edits.current;
    try {
      const saved = await cache.shareDraft(id, identity);
      if (!live.current || baseline !== edits.current) return;
      revision.current = saved.revision; current.current = saved.draft ?? { text: originalText, recipient: "", mentions: [] };
      setDraft(current.current); setRetired(saved.retired); setReady(true); report("");
    } catch (error) { if (baseline === edits.current) report(error instanceof Error ? error.message : "draft_read_failed"); }
    finally { loading.current = false; }
  };
  useLayoutEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, []);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (pending.current || failure.current) { event.preventDefault(); event.returnValue = ""; } };
    const refresh = () => { if (document.visibilityState === "visible" && !pending.current && !failure.current) void load(); };
    window.addEventListener("beforeunload", protect); window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("beforeunload", protect); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  const persist = (value: ShareDraft) => {
    pending.current++; setSaving(true);
    tail.current = tail.current.then(async () => {
      try { revision.current = await cache.saveShareDraft(id, value, identity, revision.current, expiry.current); report(""); }
      catch (error) { report(error instanceof Error ? error.message : "draft_save_failed"); }
      finally { if (--pending.current === 0 && live.current) setSaving(false); }
    });
  };
  return {
    draft, ready, saving, error, retired,
    change: (value: ShareDraft) => { if (!ready || retired) return; edits.current++; current.current = value; setDraft(value); persist(value); },
    flush: async () => {
      await tail.current;
      if (failure.current) throw new Error(failure.current);
      // Sending an unchanged old editor still needs a CAS check. Merely waiting
      // for its own writes would allow another window's newer draft to be pinned
      // and silently sent as the stale text.
      try { revision.current = await cache.saveShareDraft(id, current.current, identity, revision.current, expiry.current); }
      catch (error) { report(error instanceof Error ? error.message : "draft_save_failed"); throw error; }
    },
    retry: () => { if (pending.current) return; if (ready) persist(current.current); else void load(); },
    retire: async () => { edits.current++; await cache.retireShareDraft(id, identity); if (live.current) { setRetired(true); report(""); } },
  };
}
