import { useSyncExternalStore } from "react";

const empty: ReadonlySet<string> = new Set();

function createConversationFolds(key: string) {
  let saved: Map<string, ReadonlySet<string>> | undefined;
  const listeners = new Set<() => void>();

  function read() {
    if (saved) return saved;
    saved = new Map();
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [scope, ids] of Object.entries(value)) {
          if (Array.isArray(ids) && ids.every(id => typeof id === "string")) saved.set(scope, new Set(ids));
        }
      }
    } catch { /* Unavailable or invalid storage starts expanded. */ }
    return saved;
  }
  const notify = () => { for (const listener of listeners) listener(); };
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  /** Local presentation only. Caller scopes by paired host and device identity
   * (the same owner boundary as drafts), so list remounts keep folds while another pairing cannot inherit them. */
  return function useConversationFolds(scope: string | undefined) {
    const collapsed = useSyncExternalStore(subscribe, () => scope ? read().get(scope) ?? empty : empty);
    const set = (id: string, folded: boolean) => {
      if (!scope) return;
      const all = read(), next = new Set(all.get(scope));
      if (next.has(id) === folded) return;
      if (folded) next.add(id); else next.delete(id);
      saved = new Map(all);
      if (next.size) saved.set(scope, next); else saved.delete(scope);
      try { localStorage.setItem(key, JSON.stringify(Object.fromEntries([...saved].map(([owner, ids]) => [owner, [...ids]])))); }
      catch { /* Keep the choice in memory for this session. */ }
      notify();
    };
    return { collapsed, set, ready: !!scope };
  };
}

// Independent namespaces preserve existing Bot preferences and avoid ID collisions.
export const useBotConversationFolds = createConversationFolds("tarobot-collapsed-bots-v1");
export const useGroupTopicFolds = createConversationFolds("tarobot-collapsed-group-topics-v1");
