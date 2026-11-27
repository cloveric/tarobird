import { openDB, type DBSchema } from 'idb';
import { conversationFolderOrder, isFolderPinned, type ConversationFoldersState } from '../../src/client-protocol/conversation-folders.js';

export const CROSS_HOST_FOLDER_ORDER_KEY = 'tarobird-cross-host-folder-order-v1';
const REGISTRY_DATABASE = 'tarocub-hosts-v1';

interface RegistryMetaSchema extends DBSchema {
  hosts: { key: string; value: unknown };
  meta: { key: string; value: string };
  networkCandidates: { key: string; value: unknown };
}

export type CrossHostFolderRef = {
  hostKey: string;
  /** Non-empty custom folder ID on the owning host, or null for its system Unfiled section. */
  folderId: string | null;
};

/** Cross-host folder display order keyed by `[hostKey, folderId]`.
 * Mirrored across `localStorage` and IndexedDB (`tarocub-hosts-v1` `meta`) and
 * synced across the owner's devices via upgraded Hubs. */
export type StoredCrossHostFolderOrder = {
  version: 1;
  pinned: string[];
  ordinary: string[];
  updatedAt?: number;
};

export type CrossHostFolderSource = {
  hostId: string;
  hostKey: string;
  hostName: string;
  folders: ConversationFoldersState;
  online?: boolean;
  /** True only when this host supports folders and an authoritative folder snapshot has been received. */
  foldersAuthoritative?: boolean;
};

export type CrossHostFolderItem = {
  key: string;
  hostId: string;
  hostKey: string;
  hostName: string;
  folderId: string | null;
  /** Raw custom folder name; undefined for system Unfiled (localized at render time). */
  name?: string;
  pinned: boolean;
  hasCustomFolders: boolean;
};

export function folderHostIdentity(identity: { hubPublicKey?: string } | undefined, fallbackHostId = ''): string {
  return identity?.hubPublicKey || fallbackHostId;
}

export function crossHostFolderKey(ref: CrossHostFolderRef): string {
  return JSON.stringify([ref.hostKey, ref.folderId]);
}

export function parseCrossHostFolderKey(key: string): CrossHostFolderRef | undefined {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const [hostKey, folderId] = value;
    if (typeof hostKey !== 'string' || !hostKey) return undefined;
    if (folderId !== null && (typeof folderId !== 'string' || !folderId)) return undefined;
    return { hostKey, folderId };
  } catch {
    return undefined;
  }
}

export const emptyCrossHostFolderOrder = (): StoredCrossHostFolderOrder => ({
  version: 1,
  pinned: [],
  ordinary: [],
});

export function crossHostFolderOrderUpdatedAt(order: StoredCrossHostFolderOrder): number {
  return order.updatedAt ?? 0;
}

function uniqueValidKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>(), out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || seen.has(item) || !parseCrossHostFolderKey(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function parseStoredCrossHostFolderOrder(raw: unknown): StoredCrossHostFolderOrder {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCrossHostFolderOrder();
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return emptyCrossHostFolderOrder();
  const updatedAt = typeof value.updatedAt === 'number' && Number.isSafeInteger(value.updatedAt) && value.updatedAt > 0
    ? value.updatedAt
    : undefined;
  return {
    version: 1,
    pinned: uniqueValidKeys(value.pinned),
    ordinary: uniqueValidKeys(value.ordinary),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function collectLiveTiers(sources: readonly CrossHostFolderSource[]) {
  const pinned: CrossHostFolderItem[] = [];
  const ordinary: CrossHostFolderItem[] = [];
  const canonicalPinnedByHost = new Map<string, string[]>();
  const canonicalOrdinaryByHost = new Map<string, string[]>();
  const seenHosts = new Set<string>();
  const seenKeys = new Set<string>();

  for (const source of sources) {
    if (!source.hostKey || seenHosts.has(source.hostKey)) continue;
    seenHosts.add(source.hostKey);
    const names = new Map(source.folders.folders.map(folder => [folder.id, folder.name]));
    const hasCustomFolders = source.folders.folders.length > 0;
    const hostPinned: string[] = [];
    const hostOrdinary: string[] = [];
    for (const folderId of conversationFolderOrder(source.folders)) {
      if (folderId !== null && !names.has(folderId)) continue;
      const key = crossHostFolderKey({ hostKey: source.hostKey, folderId });
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const isPinned = isFolderPinned(source.folders, folderId);
      const item: CrossHostFolderItem = {
        key,
        hostId: source.hostId,
        hostKey: source.hostKey,
        hostName: source.hostName,
        folderId,
        name: folderId === null ? undefined : names.get(folderId),
        pinned: isPinned,
        hasCustomFolders,
      };
      if (isPinned) {
        pinned.push(item);
        hostPinned.push(key);
      } else {
        ordinary.push(item);
        hostOrdinary.push(key);
      }
    }
    canonicalPinnedByHost.set(source.hostKey, hostPinned);
    canonicalOrdinaryByHost.set(source.hostKey, hostOrdinary);
  }
  return { pinned, ordinary, canonicalPinnedByHost, canonicalOrdinaryByHost };
}

function resolveTier(
  liveItems: readonly CrossHostFolderItem[],
  savedKeys: readonly string[],
  canonicalByHost: ReadonlyMap<string, readonly string[]>,
): CrossHostFolderItem[] {
  const liveByKey = new Map(liveItems.map(item => [item.key, item]));
  const result: string[] = [];
  const placed = new Set<string>();

  for (const key of savedKeys) {
    if (!liveByKey.has(key) || placed.has(key)) continue;
    result.push(key);
    placed.add(key);
  }

  for (const item of liveItems) {
    if (placed.has(item.key)) continue;
    const hostOrder = canonicalByHost.get(item.hostKey) ?? [];
    const index = hostOrder.indexOf(item.key);
    let inserted = false;
    for (let i = index - 1; i >= 0; i--) {
      const prev = hostOrder[i]!;
      if (placed.has(prev)) {
        result.splice(result.indexOf(prev) + 1, 0, item.key);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      for (let i = index + 1; i < hostOrder.length; i++) {
        const next = hostOrder[i]!;
        if (placed.has(next)) {
          result.splice(result.indexOf(next), 0, item.key);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) result.push(item.key);
    placed.add(item.key);
  }

  return result.map(key => liveByKey.get(key)!);
}

/** Merge live per-host folder snapshots with the cross-host order.
 * Pinned folders across all hosts stay first; newly created folders land beside
 * their host's canonical neighbors; offline or hidden hosts are never dropped. */
export function resolveCrossHostFolderOrder(
  sources: readonly CrossHostFolderSource[],
  stored: StoredCrossHostFolderOrder,
): CrossHostFolderItem[] {
  const { pinned, ordinary, canonicalPinnedByHost, canonicalOrdinaryByHost } = collectLiveTiers(sources);
  return [
    ...resolveTier(pinned, stored.pinned, canonicalPinnedByHost),
    ...resolveTier(ordinary, stored.ordinary, canonicalOrdinaryByHost),
  ];
}

function insertMissingByReference(base: string[], reference: readonly string[]): string[] {
  const out = [...base];
  const present = new Set(out);
  for (let i = 0; i < reference.length; i++) {
    const key = reference[i]!;
    if (present.has(key)) continue;
    let inserted = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = reference[j]!;
      if (present.has(prev)) {
        out.splice(out.indexOf(prev) + 1, 0, key);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      for (let j = i + 1; j < reference.length; j++) {
        const next = reference[j]!;
        if (present.has(next)) {
          out.splice(out.indexOf(next), 0, key);
          inserted = true;
          break;
        }
      }
    }
    if (!inserted) out.push(key);
    present.add(key);
  }
  return out;
}

function makeOnlineDeletionFilter(sources: readonly CrossHostFolderSource[]): (key: string) => boolean {
  const onlineFolders = new Map<string, ReadonlySet<string>>();
  for (const source of sources) {
    if (source.online !== true || source.foldersAuthoritative !== true || !source.hostKey) continue;
    onlineFolders.set(source.hostKey, new Set(source.folders.folders.map(folder => folder.id)));
  }
  return (key: string) => {
    const ref = parseCrossHostFolderKey(key);
    if (!ref || ref.folderId === null) return false;
    const known = onlineFolders.get(ref.hostKey);
    // Only prune custom folders confirmed absent on an online host whose
    // folder snapshot is authoritatively loaded and supported. Offline,
    // filtered, connecting, legacy, or uncached hosts keep every saved entry.
    return known !== undefined && !known.has(ref.folderId);
  };
}

function mergeTierOrder(
  prevSaved: readonly string[],
  resolvedFullTier: readonly string[],
  nextSubsetOrder: readonly string[],
  isConfirmedDeleted: (key: string) => boolean,
): string[] {
  const cleaned = uniqueValidKeys(prevSaved).filter(key => !isConfirmedDeleted(key));
  const subset = uniqueValidKeys(nextSubsetOrder);
  const subsetSet = new Set(subset);
  // Anchor every key in resolvedFullTier (including hidden-by-filter or
  // previously unrecorded items) before permuting only the edited subset slots.
  const baseline = insertMissingByReference(cleaned, resolvedFullTier);
  const withSubset = insertMissingByReference(baseline, subset);
  let cursor = 0;
  return withSubset.map(key => subsetSet.has(key) ? subset[cursor++]! : key);
}

/** Commit a reordered subset (or full list) of live cross-host folder keys.
 * Entries from offline, hidden, or filtered hosts and pinned folders' saved
 * ordinary restoration slots stay anchored in place. */
export function commitCrossHostFolderOrder(
  stored: StoredCrossHostFolderOrder,
  sources: readonly CrossHostFolderSource[],
  nextOrderKeys: readonly string[],
  editedKeys?: readonly string[],
): StoredCrossHostFolderOrder {
  const resolved = resolveCrossHostFolderOrder(sources, stored);
  const resolvedPinned = resolved.filter(item => item.pinned).map(item => item.key);
  const resolvedOrdinary = resolved.filter(item => !item.pinned).map(item => item.key);
  const pinnedSet = new Set(resolvedPinned);
  const ordinarySet = new Set(resolvedOrdinary);
  const editedSet = editedKeys ? new Set(editedKeys) : undefined;

  const dedupNext = uniqueValidKeys(nextOrderKeys);
  const nextPinned = dedupNext.filter(key => pinnedSet.has(key) && (!editedSet || editedSet.has(key)));
  for (const key of resolvedPinned) {
    if ((!editedSet || editedSet.has(key)) && !nextPinned.includes(key)) nextPinned.push(key);
  }
  const nextOrdinary = dedupNext.filter(key => ordinarySet.has(key) && (!editedSet || editedSet.has(key)));
  for (const key of resolvedOrdinary) {
    if ((!editedSet || editedSet.has(key)) && !nextOrdinary.includes(key)) nextOrdinary.push(key);
  }

  const isDeleted = makeOnlineDeletionFilter(sources);
  return {
    version: 1,
    pinned: nextPinned.length
      ? mergeTierOrder(stored.pinned, resolvedPinned, nextPinned, isDeleted)
      : uniqueValidKeys(stored.pinned).filter(key => !isDeleted(key)),
    ordinary: nextOrdinary.length
      ? mergeTierOrder(stored.ordinary, resolvedOrdinary, nextOrdinary, isDeleted)
      : uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key)),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Move one folder up, down, or to the top within its own tier (pinned vs ordinary).
 * When `visibleKeys` is supplied (e.g. under search/filter), moves relative to
 * visible peers while keeping hidden folders anchored in their saved slots. */
export function moveCrossHostFolderOrder(
  stored: StoredCrossHostFolderOrder,
  sources: readonly CrossHostFolderSource[],
  targetKey: string,
  destination: 'up' | 'down' | 'top',
  visibleKeys?: readonly string[],
): StoredCrossHostFolderOrder {
  const resolved = resolveCrossHostFolderOrder(sources, stored);
  const visibleSet = visibleKeys ? new Set(visibleKeys) : undefined;
  const active = visibleSet ? resolved.filter(item => visibleSet.has(item.key)) : resolved;
  const index = active.findIndex(item => item.key === targetKey);
  if (index < 0) return stored;
  const item = active[index]!;
  const peers = active.filter(entry => entry.pinned === item.pinned);
  const first = active.indexOf(peers[0]!);
  const last = active.indexOf(peers.at(-1)!);
  const target = destination === 'top' ? first : destination === 'up' ? index - 1 : index + 1;
  if (target < first || target > last || target === index) return stored;
  const nextKeys = active.map(entry => entry.key);
  nextKeys.splice(target, 0, ...nextKeys.splice(index, 1));
  return commitCrossHostFolderOrder(stored, sources, nextKeys, active.map(entry => entry.key));
}

/** Update pinned/ordinary placement after a Hub confirms a folder pin or unpin.
 * Pinning remembers the folder's current cross-host ordinary slot so unpinning
 * restores it while keeping any other ordinary reorders intact. */
export function recordCrossHostFolderPin(
  stored: StoredCrossHostFolderOrder,
  sourcesBeforePin: readonly CrossHostFolderSource[],
  targetKey: string,
  pinned: boolean,
): StoredCrossHostFolderOrder {
  if (!parseCrossHostFolderKey(targetKey)) return stored;
  const isDeleted = makeOnlineDeletionFilter(sourcesBeforePin);
  if (pinned) {
    const resolvedBefore = resolveCrossHostFolderOrder(sourcesBeforePin, stored);
    const resolvedOrdinaryBefore = resolvedBefore.filter(item => !item.pinned).map(item => item.key);
    const ordinary = resolvedOrdinaryBefore.includes(targetKey)
      ? mergeTierOrder(stored.ordinary, resolvedOrdinaryBefore, resolvedOrdinaryBefore, isDeleted)
      : uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key));
    const nextPinned = [targetKey, ...uniqueValidKeys(stored.pinned).filter(key => key !== targetKey && !isDeleted(key))];
    return {
      version: 1,
      pinned: nextPinned,
      ordinary,
      ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
    };
  }
  return {
    version: 1,
    pinned: uniqueValidKeys(stored.pinned).filter(key => key !== targetKey && !isDeleted(key)),
    ordinary: uniqueValidKeys(stored.ordinary).filter(key => !isDeleted(key)),
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Propagate a single-host FolderManager/FolderActions reorder into an existing
 * cross-host order while keeping other hosts' slots anchored in place. */
export function reorderSingleHostCrossHostFolderOrder(
  stored: StoredCrossHostFolderOrder,
  hostKey: string,
  folders: ConversationFoldersState,
  folderIds: readonly (string | null)[],
): StoredCrossHostFolderOrder {
  if (!hostKey || (!stored.pinned.length && !stored.ordinary.length)) return stored;
  const source: CrossHostFolderSource = {
    hostId: hostKey,
    hostKey,
    hostName: '',
    folders,
    online: true,
    foldersAuthoritative: true,
  };
  const nextHostKeys = folderIds.map(folderId => crossHostFolderKey({ hostKey, folderId }));
  return commitCrossHostFolderOrder(stored, [source], nextHostKeys, nextHostKeys);
}

/** Remove a deleted custom folder key from saved cross-host order if present. */
export function pruneCrossHostFolderOrderFolder(
  stored: StoredCrossHostFolderOrder,
  hostKey: string,
  folderId: string,
): StoredCrossHostFolderOrder {
  if (!hostKey || !folderId) return stored;
  const target = crossHostFolderKey({ hostKey, folderId });
  const pinned = stored.pinned.filter(key => key !== target);
  const ordinary = stored.ordinary.filter(key => key !== target);
  if (pinned.length === stored.pinned.length && ordinary.length === stored.ordinary.length) return stored;
  return {
    version: 1,
    pinned,
    ordinary,
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Remove all saved entries belonging to a permanently removed host. */
export function pruneCrossHostFolderOrderHost(
  stored: StoredCrossHostFolderOrder,
  hostKey: string,
): StoredCrossHostFolderOrder {
  if (!hostKey) return stored;
  const keep = (key: string) => parseCrossHostFolderKey(key)?.hostKey !== hostKey;
  const pinned = stored.pinned.filter(keep);
  const ordinary = stored.ordinary.filter(keep);
  if (pinned.length === stored.pinned.length && ordinary.length === stored.ordinary.length) return stored;
  return {
    version: 1,
    pinned,
    ordinary,
    ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Filter resolved cross-host folder items down to the ones that should render
 * in the sidebar or mobile inbox, matching existing single-host rules:
 * - Hosts with custom folders show every folder when unfiltered, and only
 *   non-empty folders when filtered.
 * - Folder-free hosts only show their synthetic Unfiled section while they
 *   have at least one matching ordinary conversation row. */
export function visibleCrossHostFolders(
  items: readonly CrossHostFolderItem[],
  rowCountFor: (hostId: string, folderId: string | null) => number,
  filtered: boolean,
): CrossHostFolderItem[] {
  return items.filter(item => {
    const count = rowCountFor(item.hostId, item.folderId);
    if (!item.hasCustomFolders) return count > 0;
    return !filtered || count > 0;
  });
}

// --- Hybrid storage store (localStorage + IndexedDB tarocub-hosts-v1 meta + in-memory cache) ---

let cachedOrder: StoredCrossHostFolderOrder | undefined;
const listeners = new Set<() => void>();
let storageListenerAttached = false;
let localWriteEpoch = 0;
let idbHydration: Promise<StoredCrossHostFolderOrder> | undefined;
let idbWriteQueue: Promise<void> = Promise.resolve();
let serverTimeOffset = 0;
let lastWriteError: string | undefined;

export function setCrossHostServerTimeOffset(offset: number): void {
  if (Number.isFinite(offset)) serverTimeOffset = Math.round(offset);
}

export function nextCrossHostFolderUpdatedAt(prevUpdatedAt = 0): number {
  return Math.max(1, Math.round(Date.now() + serverTimeOffset), prevUpdatedAt + 1);
}

export function crossHostFolderOrderWriteError(): string | undefined {
  return lastWriteError;
}

function isCompletelyEmpty(order: StoredCrossHostFolderOrder): boolean {
  return !order.pinned.length && !order.ordinary.length && !(order.updatedAt && order.updatedAt > 0);
}

function sameStoredOrder(a: StoredCrossHostFolderOrder, b: StoredCrossHostFolderOrder): boolean {
  return (a.updatedAt ?? 0) === (b.updatedAt ?? 0)
    && a.pinned.length === b.pinned.length
    && a.ordinary.length === b.ordinary.length
    && a.pinned.every((v, i) => v === b.pinned[i])
    && a.ordinary.every((v, i) => v === b.ordinary[i]);
}

function readFromStorage(): StoredCrossHostFolderOrder {
  if (typeof localStorage === 'undefined') return emptyCrossHostFolderOrder();
  try {
    const raw = localStorage.getItem(CROSS_HOST_FOLDER_ORDER_KEY);
    if (!raw) return emptyCrossHostFolderOrder();
    return parseStoredCrossHostFolderOrder(JSON.parse(raw));
  } catch {
    return emptyCrossHostFolderOrder();
  }
}

function writeToLocalStorage(order: StoredCrossHostFolderOrder): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    if (isCompletelyEmpty(order)) {
      localStorage.removeItem(CROSS_HOST_FOLDER_ORDER_KEY);
    } else {
      localStorage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify(order));
    }
    return true;
  } catch {
    console.warn('cross_host_folder_order_local_storage_failed');
    return false;
  }
}

async function openOrderDb() {
  return openDB<RegistryMetaSchema>(REGISTRY_DATABASE, 2, {
    upgrade(db, version) {
      if (version < 1) {
        db.createObjectStore('hosts', { keyPath: 'id' });
        db.createObjectStore('meta');
      }
      if (version < 2) {
        db.createObjectStore('networkCandidates', { keyPath: 'id' });
      }
    },
  });
}

async function readFromIndexedDb(): Promise<StoredCrossHostFolderOrder | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  const db = await openOrderDb();
  try {
    const raw = await db.get('meta', CROSS_HOST_FOLDER_ORDER_KEY);
    if (typeof raw !== 'string') return undefined;
    return parseStoredCrossHostFolderOrder(JSON.parse(raw));
  } finally {
    db.close();
  }
}

async function writeToIndexedDb(order: StoredCrossHostFolderOrder): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openOrderDb();
  try {
    if (isCompletelyEmpty(order)) {
      await db.delete('meta', CROSS_HOST_FOLDER_ORDER_KEY);
    } else {
      await db.put('meta', JSON.stringify(order), CROSS_HOST_FOLDER_ORDER_KEY);
    }
  } finally {
    db.close();
  }
}

function enqueueIdbWrite(order: StoredCrossHostFolderOrder, localStorageOk: boolean): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    if (!localStorageOk && typeof localStorage !== 'undefined') {
      lastWriteError = 'cross_host_folder_order_persist_failed';
    } else {
      lastWriteError = undefined;
    }
    return Promise.resolve();
  }
  const work = idbWriteQueue.then(async () => {
    try {
      await writeToIndexedDb(order);
      if (lastWriteError !== undefined) {
        lastWriteError = undefined;
        for (const listener of listeners) listener();
      }
    } catch {
      console.warn('cross_host_folder_order_idb_failed');
      if (!localStorageOk) {
        lastWriteError = 'cross_host_folder_order_persist_failed';
        for (const listener of listeners) listener();
      }
    }
  });
  idbWriteQueue = work;
  return work;
}

export function readyCrossHostFolderOrder(): Promise<StoredCrossHostFolderOrder> {
  if (!cachedOrder) cachedOrder = readFromStorage();
  if (typeof indexedDB === 'undefined') return Promise.resolve(cachedOrder);
  if (idbHydration) return idbHydration;
  const startEpoch = localWriteEpoch;
  idbHydration = (async () => {
    try {
      const idbOrder = await readFromIndexedDb();
      if (localWriteEpoch !== startEpoch) {
        return cachedOrder ?? readFromStorage();
      }
      const current = cachedOrder ?? readFromStorage();
      if (idbOrder) {
        const idbTs = idbOrder.updatedAt ?? 0;
        const curTs = current.updatedAt ?? 0;
        const curEmpty = !current.pinned.length && !current.ordinary.length;
        const idbHasEntries = idbOrder.pinned.length > 0 || idbOrder.ordinary.length > 0;
        if (idbTs > curTs || (idbTs === curTs && curEmpty && idbHasEntries)) {
          cachedOrder = idbOrder;
          writeToLocalStorage(idbOrder);
          for (const listener of listeners) listener();
          return idbOrder;
        }
        if (!sameStoredOrder(current, idbOrder) && !isCompletelyEmpty(current)) {
          await enqueueIdbWrite(current, true);
        }
      } else if (!isCompletelyEmpty(current)) {
        await enqueueIdbWrite(current, true);
      }
      return current;
    } catch {
      return cachedOrder ?? readFromStorage();
    }
  })();
  return idbHydration;
}

function handleStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== CROSS_HOST_FOLDER_ORDER_KEY) return;
  cachedOrder = readFromStorage();
  localWriteEpoch++;
  for (const listener of listeners) listener();
}

function listenForStorageChanges(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  window.addEventListener('storage', handleStorageEvent);
  storageListenerAttached = true;
}

export function readCrossHostFolderOrder(): StoredCrossHostFolderOrder {
  listenForStorageChanges();
  if (typeof indexedDB !== 'undefined' && !idbHydration) {
    void readyCrossHostFolderOrder();
  }
  if (cachedOrder) return cachedOrder;
  cachedOrder = readFromStorage();
  return cachedOrder;
}

export function writeCrossHostFolderOrder(
  next: StoredCrossHostFolderOrder,
  options?: { updatedAt?: number; fromSync?: boolean },
): void {
  listenForStorageChanges();
  const prev = cachedOrder ?? readFromStorage();
  const sanitizedBase = parseStoredCrossHostFolderOrder(next);
  const updatedAt = options?.fromSync
    ? (sanitizedBase.updatedAt ?? 0)
    : (options?.updatedAt ?? nextCrossHostFolderUpdatedAt(prev.updatedAt ?? 0));
  const sanitized: StoredCrossHostFolderOrder = updatedAt > 0
    ? { version: 1, updatedAt, pinned: sanitizedBase.pinned, ordinary: sanitizedBase.ordinary }
    : { version: 1, pinned: sanitizedBase.pinned, ordinary: sanitizedBase.ordinary };
  cachedOrder = sanitized;
  localWriteEpoch++;
  const localOk = writeToLocalStorage(sanitized);
  void enqueueIdbWrite(sanitized, localOk);
  for (const listener of listeners) listener();
}

export function subscribeCrossHostFolderOrder(listener: () => void): () => void {
  listeners.add(listener);
  listenForStorageChanges();
  if (typeof indexedDB !== 'undefined' && !idbHydration) {
    void readyCrossHostFolderOrder();
  }
  // The cached store outlives its views, including host removal without a view.
  // Keep one document-lifetime listener so hidden views cannot miss remote
  // changes; reloading storage on remount would discard failed-write fallback.
  return () => { listeners.delete(listener); };
}

export function removeCrossHostFolderOrderHost(hostKey: string): void {
  const current = readCrossHostFolderOrder();
  const next = pruneCrossHostFolderOrderHost(current, hostKey);
  // Device-local unpairing ("从此设备移除") must not bump updatedAt or broadcast
  // a destructive global deletion to other devices still paired with this host.
  if (next !== current) writeCrossHostFolderOrder(next, { fromSync: true });
}

export function saveCrossHostFolderOrder(
  sources: readonly CrossHostFolderSource[],
  nextOrderKeys: readonly string[],
  editedKeys?: readonly string[],
): void {
  writeCrossHostFolderOrder(commitCrossHostFolderOrder(readCrossHostFolderOrder(), sources, nextOrderKeys, editedKeys));
}

export function applyCrossHostFolderMove(
  sources: readonly CrossHostFolderSource[],
  targetKey: string,
  destination: 'up' | 'down' | 'top',
  visibleKeys?: readonly string[],
): void {
  const current = readCrossHostFolderOrder();
  const next = moveCrossHostFolderOrder(current, sources, targetKey, destination, visibleKeys);
  if (next !== current) writeCrossHostFolderOrder(next);
}

export function applyCrossHostFolderPin(
  sourcesBeforePin: readonly CrossHostFolderSource[],
  targetKey: string,
  pinned: boolean,
): void {
  writeCrossHostFolderOrder(recordCrossHostFolderPin(readCrossHostFolderOrder(), sourcesBeforePin, targetKey, pinned));
}

export function applySingleHostFolderReorder(
  hostKey: string,
  folders: ConversationFoldersState,
  folderIds: readonly (string | null)[],
): void {
  const current = readCrossHostFolderOrder();
  const next = reorderSingleHostCrossHostFolderOrder(current, hostKey, folders, folderIds);
  if (next !== current) writeCrossHostFolderOrder(next);
}

export function pruneCrossHostDeletedFolder(hostKey: string, folderId: string): void {
  const current = readCrossHostFolderOrder();
  const next = pruneCrossHostFolderOrderFolder(current, hostKey, folderId);
  if (next !== current) writeCrossHostFolderOrder(next);
}

export async function flushCrossHostFolderOrderPersistence(): Promise<void> {
  await readyCrossHostFolderOrder();
  await idbWriteQueue;
}

export function resetCrossHostFolderOrderCache(): void {
  cachedOrder = undefined;
  idbHydration = undefined;
  localWriteEpoch = 0;
  serverTimeOffset = 0;
  lastWriteError = undefined;
  if (storageListenerAttached && typeof window !== 'undefined') {
    window.removeEventListener('storage', handleStorageEvent);
    storageListenerAttached = false;
  }
}
