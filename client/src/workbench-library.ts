import type { DesignDocument } from "./workbench-design.js";
import type { HubConnection } from "./connection.js";
import { noteRecoveryKey, rememberNoteRecovery } from "./workbench-note-recovery.js";

/** App-only management of this device's workbench content across
 * conversations. Never reachable from Bot workbench commands or the Host CLI:
 * the data exists only in this App's IndexedDB. Kept free of runtime storage
 * imports so the lazily loaded workbench controller does not open a cache. */
export type WorkbenchItemKind = "whiteboard" | "markdown" | "design";
export type WorkbenchOwner = { host: string; user: string };
export type StoredWorkbenchItem = { scope: string; conversationId: string; id: string; kind: WorkbenchItemKind; title?: string; designFormat?: DesignDocument["format"]; state: "open" | "closed" | "orphan" | "missing"; layoutRevision?: number; layoutInvalid?: true };
export type StoredWorkbenchDeletion = { kind: WorkbenchItemKind; id: string; status: "deleted" | "already_deleted" | "kind_mismatch" };
export const isWorkbenchItemKind = (value: unknown): value is WorkbenchItemKind => value === "whiteboard" || value === "markdown" || value === "design";
/** The conversation of a canonical `[host,user,conversation]` scope that
 * belongs to `owner`; anything else (another Host/user, malformed) is not. */
export function ownedWorkbenchConversation(scope: unknown, owner: WorkbenchOwner): string | undefined {
  if (typeof scope !== "string" || scope.length > 4096) return;
  let value: unknown; try { value = JSON.parse(scope); } catch { return; }
  if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === "string" && part.length > 0)
    || value[0] !== owner.host || value[1] !== owner.user || JSON.stringify(value) !== scope) return;
  return value[2] as string;
}

export type WorkbenchLibraryKind = WorkbenchItemKind;
export type WorkbenchLibraryState = StoredWorkbenchItem["state"];
export type WorkbenchLibraryEntry = StoredWorkbenchItem;
export type WorkbenchLibraryListing = { entries: WorkbenchLibraryEntry[]; truncated: boolean; skipped: number };
export type WorkbenchLibraryTarget = { scope: string; conversationId: string; id: string; kind: WorkbenchLibraryKind; title?: string };
export type WorkbenchLibraryDeleteStatus = "deleted" | "already_deleted" | "busy" | "kind_mismatch" | "scope_unavailable" | "reset_in_progress" | "failed";
export type WorkbenchLibraryDeleteResult = { scope: string; id: string; kind: WorkbenchLibraryKind; status: WorkbenchLibraryDeleteStatus; error?: string };
/** `key`, when given, must be the listing key of this connection's cache. */
export type WorkbenchLibraryDeleteInput = Pick<WorkbenchLibraryEntry, "scope" | "id" | "kind"> & { key?: string };

export const WORKBENCH_LIBRARY_SCOPES = 1000;
export const WORKBENCH_LIBRARY_ENTRIES = 5000;
export const WORKBENCH_LIBRARY_BATCH = 200;
/** The cross-window lock an editor holds before it can write: whiteboard and
 * Markdown editors exclusively, design editors shared. Library deletion takes
 * it exclusively without waiting. */
export const workbenchEditorLock = (kind: WorkbenchLibraryKind, scope: string, id: string) => `tarobot-${kind}:${scope}:${id}`;
export const workbenchLibraryKey = (databaseName: string, scope: string, kind: WorkbenchLibraryKind, id: string) => JSON.stringify([databaseName, scope, kind, id]);
/** The design editor lock of each controller-owned session, for the frame that renders it. */
export const designEditorLocks = new WeakMap<object, string>();

const errorCode = (error: unknown) => error instanceof Error ? error.message.slice(0, 256) : "workbench_library_failed";
const ownerOf = (connection: HubConnection): WorkbenchOwner | undefined => {
  const host = connection.identity.hubPublicKey, user = connection.state.user?.id;
  return host && user ? { host, user } : undefined;
};
/** Never waits: an editor holding the item makes it busy, not queued. */
function tryLock(name: string): Promise<(() => void) | undefined> {
  return new Promise((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, lock => lock ? new Promise<void>(release => resolve(release)) : resolve(undefined)).catch(reject);
  });
}

/** Metadata only; listing grants nothing, deletion re-checks every item. */
export async function listWorkbenchLibrary(connection: HubConnection, options: { maxScopes?: number; maxEntries?: number } = {}): Promise<WorkbenchLibraryListing> {
  if (connection.isClosed || connection.cache.isClosed) throw new Error("local_cache_closed");
  const owner = ownerOf(connection); if (!owner) throw new Error("workbench_scope_unavailable");
  const { items, truncated, skipped } = await connection.cache.listWorkbenchItems(owner, {
    scopes: Math.min(options.maxScopes ?? WORKBENCH_LIBRARY_SCOPES, WORKBENCH_LIBRARY_SCOPES),
    entries: Math.min(options.maxEntries ?? WORKBENCH_LIBRARY_ENTRIES, WORKBENCH_LIBRARY_ENTRIES),
  });
  // A listing read for a previous user is never shown for the next one.
  if (connection.state.user?.id !== owner.user) throw new Error("workbench_scope_unavailable");
  return { entries: items, truncated, skipped };
}

/** Per-item results in input order (at most WORKBENCH_LIBRARY_BATCH). One
 * conversation is the atomic unit and conversations are independent. Items
 * whose editor holds its lock in any window are busy and left untouched. */
export async function deleteWorkbenchLibraryEntries(connection: HubConnection, entries: readonly WorkbenchLibraryDeleteInput[]): Promise<WorkbenchLibraryDeleteResult[]> {
  if (!Array.isArray(entries)) throw new Error("workbench_library_invalid_input");
  if (entries.length > WORKBENCH_LIBRARY_BATCH) throw new Error("workbench_library_batch_limit");
  if (entries.some(entry => !entry || typeof entry.scope !== "string" || !isWorkbenchItemKind(entry.kind) || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) || entry.key !== undefined && typeof entry.key !== "string"))
    throw new Error("workbench_library_invalid_input");
  const keyOf = (scope: string, kind: WorkbenchLibraryKind, id: string) => workbenchLibraryKey(connection.cache.databaseName, scope, kind, id);
  // An entry listed from another Host's cache is never applied to this one.
  const foreign = (entry: WorkbenchLibraryDeleteInput) => entry.key !== undefined && entry.key !== keyOf(entry.scope, entry.kind, entry.id);
  const outcome = new Map<string, WorkbenchLibraryDeleteResult>(), groups = new Map<string, Array<{ kind: WorkbenchLibraryKind; id: string }>>();
  const settle = (scope: string, list: ReadonlyArray<{ kind: WorkbenchLibraryKind; id: string }>, status: WorkbenchLibraryDeleteStatus, error?: string) => {
    for (const { kind, id } of list) outcome.set(keyOf(scope, kind, id), { scope, kind, id, status, ...(error ? { error } : {}) });
  };
  for (const entry of entries) {
    if (foreign(entry)) continue;
    const { scope, kind, id } = entry, group = groups.get(scope) ?? [];
    groups.set(scope, group); if (!group.some(item => item.kind === kind && item.id === id)) group.push({ kind, id });
  }
  for (const [scope, group] of groups) {
    const owner = ownerOf(connection);
    if (!owner || connection.isClosed || connection.isReadOnly || connection.cache.isClosed || !ownedWorkbenchConversation(scope, owner)) { settle(scope, group, "scope_unavailable", "workbench_scope_unavailable"); continue; }
    // Without Web Locks no editor can prove it is not writing: fail closed.
    if (typeof navigator === "undefined" || !navigator.locks) { settle(scope, group, "busy", "workbench_locks_unavailable"); continue; }
    const releases: Array<() => void> = [], ready: Array<{ kind: WorkbenchLibraryKind; id: string }> = [];
    try {
      const lockName = (item: { kind: WorkbenchLibraryKind; id: string }) => workbenchEditorLock(item.kind, scope, item.id);
      for (const item of [...group].sort((a, b) => lockName(a) < lockName(b) ? -1 : lockName(a) > lockName(b) ? 1 : 0)) {
        const release = await tryLock(lockName(item));
        if (!release) { settle(scope, [item], "busy", "workbench_item_busy"); continue; }
        releases.push(release); ready.push(item);
      }
      if (!ready.length) continue;
      if (connection.isClosed || connection.isReadOnly || connection.state.user?.id !== owner.user) { settle(scope, ready, "scope_unavailable", "workbench_scope_unavailable"); continue; }
      try {
        for (const result of await connection.cache.deleteWorkbenchItems(owner, scope, ready)) {
          settle(scope, [result], result.status);
          if (result.kind === "markdown" && (result.status === "deleted" || result.status === "already_deleted")) rememberNoteRecovery(noteRecoveryKey(connection.identity.deviceId, scope, result.id), undefined);
        }
      } catch (error) {
        const code = errorCode(error);
        settle(scope, ready, code === "local_reset_in_progress" ? "reset_in_progress" : code === "local_cache_closed" || code === "workbench_scope_unavailable" ? "scope_unavailable" : "failed", code);
      }
    } catch (error) {
      settle(scope, group.filter(({ kind, id }) => !outcome.has(keyOf(scope, kind, id))), "failed", errorCode(error));
    } finally { releases.forEach(release => release()); }
  }
  return entries.map(entry => {
    const { scope, kind, id } = entry, result = foreign(entry) ? undefined : outcome.get(keyOf(scope, kind, id));
    return { ...(result ?? { scope, kind, id, status: "scope_unavailable" as const, error: "workbench_scope_unavailable" }) };
  });
}
