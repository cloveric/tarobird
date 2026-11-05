import { useSyncExternalStore } from "react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { ClientCache, DraftPreview } from "./storage.js";
import { t } from "./i18n.js";
import "./draft-preview.css";

type Previews = Record<string, DraftPreview>;
type PreviewSource = Pick<ClientCache, "draftPreviews" | "subscribeDrafts">;

/** Equal projections keep the previous snapshot, so subscribers do not render. */
export function samePreviews(a: Previews, b: Previews): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(key => { const left = a[key]!, right = b[key]; return !!right && left.text === right.text && left.files === right.files && left.reply === right.reply; });
}

/** One observer per host cache, shared by all visible/hidden list rows. This
 * is a derived view of saved drafts, not another draft persistence mechanism.
 * Draft changes arriving during a read coalesce into one trailing read. */
export function createDraftPreviewStore(cache: PreviewSource) {
  let snapshot: Previews = {}, stop: (() => void) | undefined, running = false, dirty = false, generation = 0;
  const listeners = new Set<() => void>();
  const refresh = () => {
    dirty = true;
    if (running) return;
    running = true;
    const current = generation;
    void (async () => {
      try {
        while (dirty && current === generation && listeners.size) {
          dirty = false;
          const value = await cache.draftPreviews().catch(() => undefined);
          if (!value || current !== generation || !listeners.size || samePreviews(snapshot, value)) continue;
          snapshot = value; for (const notify of listeners) notify();
        }
      } finally { running = false; if (dirty && current !== generation && listeners.size) refresh(); }
    })();
  };
  const visible = () => { if (document.visibilityState === "visible") refresh(); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      if (listeners.size === 1) {
        stop = cache.subscribeDrafts(refresh);
        window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
        refresh();
      }
      return () => {
        listeners.delete(notify);
        if (!listeners.size) {
          generation++; dirty = false; stop?.(); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible);
        }
      };
    },
  };
}
const stores = new WeakMap<PreviewSource, ReturnType<typeof createDraftPreviewStore>>();
function storeFor(cache: PreviewSource) {
  let store = stores.get(cache);
  if (!store) { store = createDraftPreviewStore(cache); stores.set(cache, store); }
  return store;
}
export function useDraftPreviews(cache: ClientCache): Previews {
  const store = storeFor(cache);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Row-level subscription: re-renders only when this row's preview text changes,
 * not whenever any conversation's draft is saved. */
export function useDraftPreviewText(cache: ClientCache, conversation: Conversation, conversations: Conversation[], includeTopics = false): string | undefined {
  const store = storeFor(cache);
  return useSyncExternalStore(store.subscribe, () => listDraftPreview(conversation, conversations, store.getSnapshot(), includeTopics));
}

export function listDraftPreview(conversation: Conversation, conversations: Conversation[], drafts: Previews, includeTopics = false): string | undefined {
  const source = drafts[conversation.id] ? conversation : includeTopics
    ? conversations.find(topic => topic.parentId === conversation.id && !topic.archived && drafts[topic.id]) : undefined;
  if (!source) return;
  const draft = drafts[source.id]!;
  const content = draft.text || (draft.files ? t("{0} 个附件", draft.files) : t("引用回复"));
  return source.id === conversation.id ? content : t("{0}：{1}", source.title, content);
}

export function DraftPreviewText({ text }: { text: string }) {
  return <span className="conversation-draft-preview"><span className="conversation-draft-label">{t("草稿：")}</span><span>{text}</span></span>;
}
