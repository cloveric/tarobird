import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import type { Message } from "../../src/client-protocol/index.js";
import type { LinkPreviewStyle } from "../../src/client-protocol/links.js";
import type { ClientCache, ConversationDraft, Identity } from "./storage.js";
import type { WorkbenchDraft } from "./workbench-draft.js";

type Draft = ConversationDraft;
type Entry = { draft: Draft; revision?: string; ready: boolean; loading?: Promise<void>; tail: Promise<void>; pending: number; error?: string; edits: ((draft: Draft) => Draft)[]; replayBase?: Draft };
const empty = (): Draft => ({ files: [], previewStyle: "card" });

/** The cache belongs to one pairing. Delayed setters keep their conversation;
 * IDB compares revisions, so another window's edits cannot be silently erased. */
export function useConversationDrafts(conversationId: string, cache: ClientCache, identity: Identity) {
  const entries = useRef(new Map<string, Entry>());
  const activeConversation = useRef(conversationId); activeConversation.current = conversationId;
  const [, render] = useState(0), mounted = useRef(true);
  const notify = useCallback(() => { if (mounted.current) render(value => value + 1); }, []);
  const entry = (id: string): Entry => {
    let value = entries.current.get(id);
    if (!value) { value = { draft: empty(), ready: false, tail: Promise.resolve(), pending: 0, edits: [] }; entries.current.set(id, value); }
    return value;
  };
  const persist = (id: string, value: Entry) => {
    const snapshot = value.draft;
    value.pending++; notify();
    value.tail = value.tail.then(async () => {
      // A failed write retains the visible draft. Subsequent edits can retry,
      // but CAS never adopts a foreign revision merely to force a write.
      try { value.revision = await cache.saveConversationDraft(id, snapshot, identity, value.revision); value.error = undefined; }
      catch (error) { value.error = error instanceof Error ? error.message : "draft_save_failed"; }
      finally { value.pending--; notify(); }
    });
  };
  const load = (id: string, value: Entry) => {
    if (!id || value.ready || value.loading) return;
    // A failed read may already have visible queued edits. Retrying must replay
    // them on the pre-edit baseline, not append them to themselves a second time.
    const baseline = value.replayBase ?? value.draft, revision = value.revision;
    value.replayBase = baseline;
    value.loading = cache.conversationDraft(id, identity).then(saved => {
      // An unchanged revision retains File/reference identity for in-flight
      // receipt comparisons. Edits made during this read replay exactly once.
      value.revision = saved.revision; value.draft = value.edits.reduce((draft, edit) => edit(draft), saved.revision === revision ? baseline : saved.draft);
      value.replayBase = undefined;
      value.ready = true; value.error = undefined;
      if (value.edits.length) { value.edits = []; persist(id, value); }
    }).catch(error => { value.error = error instanceof Error ? error.message : "draft_read_failed"; })
      .finally(() => { value.loading = undefined; notify(); });
  };
  useLayoutEffect(() => {
    mounted.current = true;
    const protect = (event: BeforeUnloadEvent) => {
      if ([...entries.current.values()].some(value => value.pending || value.edits.length || value.error)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protect);
    return () => { mounted.current = false; window.removeEventListener("beforeunload", protect); };
  }, []);
  useLayoutEffect(() => {
    const refresh = () => {
      const value = entry(conversationId);
      // Never replace an unsaved edit, a queued write, or a failed save with a
      // different window's state. Explicit retry keeps CAS conflict protection.
      if (value.pending || value.edits.length || value.error || value.loading) return;
      value.ready = false;
      load(conversationId, value); notify();
    };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [conversationId, cache]);
  const updateDraft = (edit: (draft: Draft) => Draft) => {
    if (!conversationId) return;
    const value = entry(conversationId), next = edit(value.draft);
    if (next === value.draft) return;
    if (!value.ready) value.replayBase ??= value.draft;
    value.draft = next;
    if (value.ready) persist(conversationId, value); else { value.edits.push(edit); load(conversationId, value); }
    notify();
  };
  const update = <K extends keyof Draft>(key: K, action: SetStateAction<Draft[K]>) => updateDraft(draft => {
    const value = typeof action === "function" ? (action as (value: Draft[K]) => Draft[K])(draft[key]) : action;
    return value === draft[key] ? draft : { ...draft, [key]: value };
  });
  const value = entry(conversationId), snapshot = value.draft;
  return {
    ...snapshot, ready: !conversationId || value.ready, saving: !!value.pending, error: value.error,
    pendingAny: [...entries.current.values()].some(item => !!item.pending || !!item.edits.length && !item.error),
    failedAny: [...entries.current.values()].some(item => !!item.error),
    hasContent: !!(snapshot.files.length || snapshot.reply || snapshot.previewChoice !== undefined || snapshot.recipients?.length),
    retry: () => { if (value.pending) return; if (value.ready) persist(conversationId, value); else load(conversationId, value); },
    flush: async () => { await value.tail; if (value.error) throw new Error(value.error); return value.revision; },
    // Called using the render's snapshot. A receipt may only clear unchanged
    // fields, preserving an edit made while the upload/send was in flight.
    clearSent: (clearPreview: boolean) => updateDraft(current => {
      const files = current.files === snapshot.files && current.files.length ? [] : current.files;
      const reply = current.reply === snapshot.reply ? undefined : current.reply;
      const resetPreview = clearPreview && current.previewChoice === snapshot.previewChoice && current.previewStyle === snapshot.previewStyle;
      const previewChoice = resetPreview ? undefined : current.previewChoice;
      const previewStyle = resetPreview ? "card" as const : current.previewStyle;
      const workbench = current.workbench === snapshot.workbench && current.files === snapshot.files ? undefined : current.workbench;
      if (files === current.files && reply === current.reply && previewChoice === current.previewChoice && previewStyle === current.previewStyle && workbench === current.workbench) return current;
      return { ...current, files, reply, previewChoice, previewStyle, workbench };
    }),
    // Read the current Entry, not a render snapshot: two editor callbacks may
    // run before React paints the first change. Never open a stale chat's draft.
    getWorkbenchDraft: () => {
      const current = entries.current.get(conversationId);
      if (!conversationId || activeConversation.current !== conversationId || !current?.ready) throw new Error("draft_not_ready");
      return current.draft.workbench;
    },
    setFiles: (action: SetStateAction<File[]>) => update("files", action),
    addWorkbenchAnnotation: (files:File[],workbench:WorkbenchDraft) => updateDraft(draft=>{
      if (draft.files.length+files.length>32) throw new Error("draft_capacity_exceeded");
      return {...draft,files:[...draft.files,...files],workbench};
    }),
    clearWorkbench: () => update("workbench",undefined),
    setReply: (action: SetStateAction<Message | undefined>) => update("reply", action),
    setPreviewChoice: (action: SetStateAction<string | null | undefined>) => update("previewChoice", action),
    setPreviewStyle: (action: SetStateAction<LinkPreviewStyle>) => update("previewStyle", action),
    setRecipients: (action: string[]) => update("recipients", action),
  };
}
