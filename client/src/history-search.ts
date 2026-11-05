import { useCallback, useEffect, useRef, useState } from "react";
import { searchPageSchema, type SearchHit } from "../../src/client-protocol/search.js";
import type { HubConnection } from "./connection.js";
import { t } from "./i18n.js";
import { observeMessageDeletions } from "./observe-message-deletions.js";

type SearchView = { items: SearchHit[]; params: string; page: number; starts: (string | null)[]; nextCursor: string | null };

/** Keep the applied query separate from edited filter fields. A next-page
 * request must never mix the previous cursor with a newly typed keyword. */
export function useHistorySearch(connection: HubConnection) {
  const [view, setView] = useState<SearchView>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null), generation = useRef(0);
  const cancel = useCallback(() => { generation.current++; controller.current?.abort(); controller.current = null; }, []);
  const close = useCallback(() => { cancel(); setView(undefined); setBusy(false); setError(""); }, [cancel]);
  useEffect(() => cancel, [cancel]);
  const load = (params: string, page: number, starts: (string | null)[]) => {
    cancel(); const current = generation.current, request = new AbortController(); controller.current = request;
    const query = new URLSearchParams(params), cursor = starts[page];
    if (cursor) query.set("cursor", cursor);
    setBusy(true); setError("");
    void connection.http<unknown>(`/api/search/page?${query}`, { signal: request.signal }).then((result) => {
      if (current !== generation.current || request.signal.aborted) return;
      const parsed = searchPageSchema.parse(result);
      // Never display host-wide results under a conversation-only heading, even
      // when connected to a host that silently ignores an unsupported filter.
      const conversationId = query.get("conversationId");
      if (conversationId && parsed.items.some((item) => item.conversationId !== conversationId)) throw new Error("search_scope_unsupported");
      setView({ items: parsed.items, nextCursor: parsed.nextCursor, params, page, starts });
    }).catch((cause: unknown) => {
      if (current !== generation.current || request.signal.aborted) return;
      setError(query.has("conversationId") && cause instanceof Error && ["not_found", "invalid_request", "search_scope_unsupported"].includes(cause.message)
        ? t("主机尚不支持当前对话搜索，请更新 TaroBird 主机后重试。")
        : cause instanceof Error && cause.message === "not_found" ? t("主机尚不支持分页搜索，请更新 TaroBird Hub 后重试。") : t("搜索失败，请重试。"));
    }).finally(() => { if (current === generation.current) { setBusy(false); controller.current = null; } });
  };
  const start = (params: string, validationError = "") => {
    cancel(); setView({ items: [], nextCursor: null, params, page: 0, starts: [null] }); setBusy(false); setError(validationError);
    if (!validationError) load(params, 0, [null]);
  };
  useEffect(() => {
    if (!view) return;
    return observeMessageDeletions(connection, hidden => {
      if (view.items.some(item => hidden.has(item.id))) setView(current => current === view ? { ...view, items: view.items.filter(item => !hidden.has(item.id)) } : current);
    });
  }, [connection, view]);
  const turnPage = (direction: -1 | 1) => {
    if (!view || busy) return;
    if (direction === -1 && view.page > 0) load(view.params, view.page - 1, view.starts);
    if (direction === 1 && view.nextCursor) load(view.params, view.page + 1, [...view.starts.slice(0, view.page + 1), view.nextCursor]);
  };
  return { appliedQuery: new URLSearchParams(view?.params).get("q") ?? "", params: view?.params, results: view?.items, page: view?.page ?? 0, hasNext: !!view?.nextCursor, busy, error, close, start, turnPage };
}
