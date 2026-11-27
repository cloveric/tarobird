import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationFoldersState } from '../src/client-protocol/conversation-folders.js';
import type { HubConnection } from '../client/src/connection.js';
import {
  CROSS_HOST_FOLDER_ORDER_KEY,
  applyCrossHostFolderMove,
  applyCrossHostFolderPin,
  applySingleHostFolderReorder,
  commitCrossHostFolderOrder,
  crossHostFolderKey,
  emptyCrossHostFolderOrder,
  flushCrossHostFolderOrderPersistence,
  folderHostIdentity,
  moveCrossHostFolderOrder,
  parseCrossHostFolderKey,
  parseStoredCrossHostFolderOrder,
  pruneCrossHostDeletedFolder,
  pruneCrossHostFolderOrderFolder,
  pruneCrossHostFolderOrderHost,
  readCrossHostFolderOrder,
  readyCrossHostFolderOrder,
  recordCrossHostFolderPin,
  removeCrossHostFolderOrderHost,
  reorderSingleHostCrossHostFolderOrder,
  resetCrossHostFolderOrderCache,
  resolveCrossHostFolderOrder,
  saveCrossHostFolderOrder,
  subscribeCrossHostFolderOrder,
  visibleCrossHostFolders,
  writeCrossHostFolderOrder,
  type CrossHostFolderSource,
} from '../client/src/cross-host-folder-order.js';
import { exportDesktopData, type ExportSink, type ExportSource } from '../client/src/desktop-migration-export.js';
import { importDesktopData, type ImportSource, type ImportTarget } from '../client/src/desktop-migration-import.js';
import { buildCrossHostFolderSources } from '../client/src/use-cross-host-folder-order.js';

function makeSource(
  hostId: string,
  hostKey: string,
  hostName: string,
  folders: Array<{ id: string; name: string }>,
  options: { unfiledIndex?: number; pinnedFolderIds?: (string | null)[]; online?: boolean; foldersAuthoritative?: boolean } = {},
): CrossHostFolderSource {
  const state: ConversationFoldersState = {
    revision: 1,
    folders,
    assignments: [],
    ...(options.unfiledIndex !== undefined ? { unfiledIndex: options.unfiledIndex } : {}),
    ...(options.pinnedFolderIds?.length ? { pinnedFolderIds: options.pinnedFolderIds } : {}),
  };
  const online = options.online ?? true;
  return {
    hostId,
    hostKey,
    hostName,
    folders: state,
    online,
    foldersAuthoritative: options.foldersAuthoritative ?? online,
  };
}

const k = (hostKey: string, folderId: string | null) => crossHostFolderKey({ hostKey, folderId });
const describeOrder = (sources: CrossHostFolderSource[], stored = emptyCrossHostFolderOrder()) =>
  resolveCrossHostFolderOrder(sources, stored).map(item => `${item.hostKey}/${item.folderId ?? 'unfiled'}`);

function installMemoryStorage() {
  const map = new Map<string, string>();
  const storage = {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  resetCrossHostFolderOrderCache();
  return { map, storage };
}

afterEach(() => {
  resetCrossHostFolderOrderCache();
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cross-host folder order keying and parsing', () => {
  it('distinguishes identical folder names and bare folder IDs across hosts and handles Unfiled (null)', () => {
    const aWork = k('hubKeyA', 'work');
    const bWork = k('hubKeyB', 'work');
    const aUnfiled = k('hubKeyA', null);
    const bUnfiled = k('hubKeyB', null);

    expect(new Set([aWork, bWork, aUnfiled, bUnfiled]).size).toBe(4);
    expect(parseCrossHostFolderKey(aWork)).toEqual({ hostKey: 'hubKeyA', folderId: 'work' });
    expect(parseCrossHostFolderKey(bUnfiled)).toEqual({ hostKey: 'hubKeyB', folderId: null });
    expect(parseCrossHostFolderKey('not-json')).toBeUndefined();
    expect(parseCrossHostFolderKey(JSON.stringify(['', 'work']))).toBeUndefined();
    expect(parseCrossHostFolderKey(JSON.stringify(['hubKeyA', '']))).toBeUndefined();
    expect(folderHostIdentity({ hubPublicKey: 'pk_1' }, 'fallback')).toBe('pk_1');
    expect(folderHostIdentity({}, 'fallback')).toBe('fallback');
  });

  it('sanitizes malformed or duplicate persisted order safely', () => {
    expect(parseStoredCrossHostFolderOrder(null)).toEqual(emptyCrossHostFolderOrder());
    expect(parseStoredCrossHostFolderOrder({ version: 2, pinned: [], ordinary: [] })).toEqual(emptyCrossHostFolderOrder());
    const parsed = parseStoredCrossHostFolderOrder({
      version: 1,
      pinned: [k('A', 'f1'), k('A', 'f1'), 'bad', 123, k('B', null)],
      ordinary: [k('B', 'f1'), k('B', 'f1'), JSON.stringify(['A', '']), k('A', 'f2')],
    });
    expect(parsed).toEqual({
      version: 1,
      pinned: [k('A', 'f1'), k('B', null)],
      ordinary: [k('B', 'f1'), k('A', 'f2')],
    });
  });
});

describe('cross-host folder order resolution and merging', () => {
  it('defaults to host-then-Hub canonical order and supports full interleaving across hosts', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'f1', name: 'Folder 1' }, { id: 'f2', name: 'Folder 2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'f3', name: 'Folder 3' }]);
    const sources = [hostA, hostB];

    expect(describeOrder(sources)).toEqual([
      'keyA/f1', 'keyA/f2', 'keyA/unfiled', 'keyB/f3', 'keyB/unfiled',
    ]);

    // Move Host B / Folder 3 to the very top.
    const movedTop = moveCrossHostFolderOrder(emptyCrossHostFolderOrder(), sources, k('keyB', 'f3'), 'top');
    expect(describeOrder(sources, movedTop)).toEqual([
      'keyB/f3', 'keyA/f1', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Interleave: Host A / f1 -> Host B / f3 -> Host A / f2.
    const interleaved = moveCrossHostFolderOrder(movedTop, sources, k('keyB', 'f3'), 'down');
    expect(describeOrder(sources, interleaved)).toEqual([
      'keyA/f1', 'keyB/f3', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled',
    ]);
  });

  it('preserves saved order across host renames, folder renames, and same-ID/same-name folders', () => {
    const initial = [
      makeSource('a', 'keyA', 'Studio 1', [{ id: 'work', name: '工作' }]),
      makeSource('b', 'keyB', 'Studio 2', [{ id: 'work', name: '工作' }]),
    ];
    const saved = moveCrossHostFolderOrder(emptyCrossHostFolderOrder(), initial, k('keyB', 'work'), 'top');
    expect(describeOrder(initial, saved)).toEqual(['keyB/work', 'keyA/work', 'keyA/unfiled', 'keyB/unfiled']);

    // Rename both hosts and both folders (same IDs/keys remain authoritative).
    const renamed = [
      makeSource('a', 'keyA', 'Main Mac', [{ id: 'work', name: '核心工作' }]),
      makeSource('b', 'keyB', 'Remote Box', [{ id: 'work', name: '核心工作' }]),
    ];
    const resolved = resolveCrossHostFolderOrder(renamed, saved);
    expect(resolved.map(item => `${item.hostName}:${item.name ?? 'Unfiled'}`)).toEqual([
      'Remote Box:核心工作',
      'Main Mac:核心工作',
      'Main Mac:Unfiled',
      'Remote Box:Unfiled',
    ]);
  });

  it('keeps offline or filtered hosts anchored and never treats temporary absence as deletion', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'f1', name: 'A1' }, { id: 'f2', name: 'A2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'f3', name: 'B3' }]);
    const hostC = makeSource('c', 'keyC', 'Host Gamma', [{ id: 'f4', name: 'C4' }]);
    const all = [hostA, hostB, hostC];

    // Custom interleaved order: A1 -> B3 -> A2 -> C4 -> unfiled...
    const custom = commitCrossHostFolderOrder(emptyCrossHostFolderOrder(), all, [
      k('keyA', 'f1'), k('keyB', 'f3'), k('keyA', 'f2'), k('keyC', 'f4'),
      k('keyA', null), k('keyB', null), k('keyC', null),
    ]);
    expect(describeOrder(all, custom)).toEqual([
      'keyA/f1', 'keyB/f3', 'keyA/f2', 'keyC/f4', 'keyA/unfiled', 'keyB/unfiled', 'keyC/unfiled',
    ]);

    // Host B temporarily hidden/filtered out -> resolution skips B cleanly without dropping it.
    const withoutB = [hostA, hostC];
    expect(describeOrder(withoutB, custom)).toEqual([
      'keyA/f1', 'keyA/f2', 'keyC/f4', 'keyA/unfiled', 'keyC/unfiled',
    ]);

    // Reorder A2 and C4 while Host B is temporarily absent; B3 and B/unfiled stay anchored!
    const reorderedWhileBHidden = moveCrossHostFolderOrder(custom, withoutB, k('keyC', 'f4'), 'up');
    expect(describeOrder(withoutB, reorderedWhileBHidden)).toEqual([
      'keyA/f1', 'keyC/f4', 'keyA/f2', 'keyA/unfiled', 'keyC/unfiled',
    ]);

    // Host B reconnects / filter clears -> B3 returns in its preserved slot between A1 and C4!
    expect(describeOrder(all, reorderedWhileBHidden)).toEqual([
      'keyA/f1', 'keyB/f3', 'keyC/f4', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled', 'keyC/unfiled',
    ]);

    // Offline host whose cached folder list is momentarily empty must not have its folders pruned on save.
    const offlineB = makeSource('b', 'keyB', 'Host Beta', [], { online: false });
    const savedWhileBOffline = moveCrossHostFolderOrder(custom, [hostA, offlineB, hostC], k('keyC', 'f4'), 'up');
    expect(savedWhileBOffline.ordinary).toContain(k('keyB', 'f3'));
    expect(describeOrder(all, savedWhileBOffline)).toEqual([
      'keyA/f1', 'keyB/f3', 'keyC/f4', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled', 'keyC/unfiled',
    ]);
  });

  it('never prunes saved entries for an online host whose folder snapshot is missing or unsupported', () => {
    const fakeHost = (
      id: string,
      hubPublicKey: string,
      name: string,
      state: { status: 'online' | 'offline' | 'connecting'; foldersAvailable?: boolean; conversationFolders?: ConversationFoldersState },
    ) => ({
      id,
      name,
      connection: { identity: { hubPublicKey }, state } as unknown as HubConnection,
    });

    const loadedA: ConversationFoldersState = { revision: 1, folders: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }], assignments: [] };
    const loadedB: ConversationFoldersState = { revision: 1, folders: [{ id: 'b1', name: 'B1' }], assignments: [] };
    const loadedC: ConversationFoldersState = { revision: 1, folders: [{ id: 'c1', name: 'C1' }], assignments: [] };

    const fullSources = buildCrossHostFolderSources([
      fakeHost('a', 'keyA', 'Host Alpha', { status: 'online', foldersAvailable: true, conversationFolders: loadedA }),
      fakeHost('b', 'keyB', 'Host Beta', { status: 'online', foldersAvailable: true, conversationFolders: loadedB }),
      fakeHost('c', 'keyC', 'Host Gamma', { status: 'online', foldersAvailable: true, conversationFolders: loadedC }),
    ]);
    expect(fullSources.every(s => s.foldersAuthoritative === true)).toBe(true);

    // Save custom interleaved order with B1 placed between A1 and A2, and B1 also tested in pinned tier.
    const custom = commitCrossHostFolderOrder(emptyCrossHostFolderOrder(), fullSources, [
      k('keyA', 'a1'), k('keyB', 'b1'), k('keyA', 'a2'), k('keyC', 'c1'),
      k('keyA', null), k('keyB', null), k('keyC', null),
    ]);

    // Case 1: Host B just came online with cleared cache (conversationFolders === undefined, foldersAvailable: true).
    const uncachedBSources = buildCrossHostFolderSources([
      fakeHost('a', 'keyA', 'Host Alpha', { status: 'online', foldersAvailable: true, conversationFolders: loadedA }),
      fakeHost('b', 'keyB', 'Host Beta', { status: 'online', foldersAvailable: true, conversationFolders: undefined }),
      fakeHost('c', 'keyC', 'Host Gamma', { status: 'online', foldersAvailable: true, conversationFolders: loadedC }),
    ]);
    expect(uncachedBSources[1]!.foldersAuthoritative).toBe(false);
    const afterReorderUncached = moveCrossHostFolderOrder(custom, uncachedBSources, k('keyC', 'c1'), 'up');
    expect(afterReorderUncached.ordinary).toContain(k('keyB', 'b1'));
    expect(describeOrder(fullSources, afterReorderUncached)).toEqual([
      'keyA/a1', 'keyB/b1', 'keyC/c1', 'keyA/a2', 'keyA/unfiled', 'keyB/unfiled', 'keyC/unfiled',
    ]);

    // Case 2: Legacy Host B online without folder support (foldersAvailable: false, ready omitted conversationFolders).
    const legacyBSources = buildCrossHostFolderSources([
      fakeHost('a', 'keyA', 'Host Alpha', { status: 'online', foldersAvailable: true, conversationFolders: loadedA }),
      fakeHost('b', 'keyB', 'Host Beta', { status: 'online', foldersAvailable: false, conversationFolders: undefined }),
      fakeHost('c', 'keyC', 'Host Gamma', { status: 'online', foldersAvailable: true, conversationFolders: loadedC }),
    ]);
    expect(legacyBSources[1]!.foldersAuthoritative).toBe(false);
    const afterReorderLegacy = moveCrossHostFolderOrder(custom, legacyBSources, k('keyC', 'c1'), 'up');
    expect(afterReorderLegacy.ordinary).toContain(k('keyB', 'b1'));

    // Case 3: Host B online AND authoritative with empty folders -> confirmed deletion IS pruned.
    const confirmedEmptyBSources = buildCrossHostFolderSources([
      fakeHost('a', 'keyA', 'Host Alpha', { status: 'online', foldersAvailable: true, conversationFolders: loadedA }),
      fakeHost('b', 'keyB', 'Host Beta', { status: 'online', foldersAvailable: true, conversationFolders: { revision: 2, folders: [], assignments: [] } }),
      fakeHost('c', 'keyC', 'Host Gamma', { status: 'online', foldersAvailable: true, conversationFolders: loadedC }),
    ]);
    expect(confirmedEmptyBSources[1]!.foldersAuthoritative).toBe(true);
    const afterConfirmedDelete = moveCrossHostFolderOrder(custom, confirmedEmptyBSources, k('keyC', 'c1'), 'up');
    expect(afterConfirmedDelete.ordinary).not.toContain(k('keyB', 'b1'));
  });

  it('merges newly created folders, deleted folders, and newly added/removed hosts without resetting user order', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'f1', name: 'A1' }, { id: 'f2', name: 'A2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'f3', name: 'B3' }]);
    const saved = commitCrossHostFolderOrder(emptyCrossHostFolderOrder(), [hostA, hostB], [
      k('keyB', 'f3'), k('keyA', 'f1'), k('keyA', 'f2'), k('keyA', null), k('keyB', null),
    ]);

    // Add new folder A3 on Host A (canonical Host A order: f1, f2, f3_new, unfiled).
    const hostAWithNew = makeSource('a', 'keyA', 'Host Alpha', [
      { id: 'f1', name: 'A1' }, { id: 'f2', name: 'A2' }, { id: 'f_new', name: 'A3' },
    ]);
    expect(describeOrder([hostAWithNew, hostB], saved)).toEqual([
      'keyB/f3', 'keyA/f1', 'keyA/f2', 'keyA/f_new', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Previously folder-free Host C gets its first custom folder -> placed before Host C's Unfiled.
    const hostCEmpty = makeSource('c', 'keyC', 'Host Gamma', []);
    const withC = commitCrossHostFolderOrder(saved, [hostA, hostB, hostCEmpty], [
      k('keyB', 'f3'), k('keyC', null), k('keyA', 'f1'), k('keyA', 'f2'), k('keyA', null), k('keyB', null),
    ]);
    const hostCFirst = makeSource('c', 'keyC', 'Host Gamma', [{ id: 'c1', name: 'C1' }]);
    expect(describeOrder([hostA, hostB, hostCFirst], withC)).toEqual([
      'keyB/f3', 'keyC/c1', 'keyC/unfiled', 'keyA/f1', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Delete A2 on Host A -> omitted cleanly, remaining order intact, no duplicates.
    const hostADeleted = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'f1', name: 'A1' }]);
    expect(describeOrder([hostADeleted, hostB], saved)).toEqual([
      'keyB/f3', 'keyA/f1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Permanently remove Host C -> prunes Host C keys while preserving Host A & B order.
    const pruned = pruneCrossHostFolderOrderHost(withC, 'keyC');
    expect(pruned.ordinary.some(key => parseCrossHostFolderKey(key)?.hostKey === 'keyC')).toBe(false);
    expect(describeOrder([hostA, hostB], pruned)).toEqual([
      'keyB/f3', 'keyA/f1', 'keyA/f2', 'keyA/unfiled', 'keyB/unfiled',
    ]);
  });

  it('keeps pinned folders across hosts in their own top tier and restores ordinary rank on unpin', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }]);
    const baseSources = [hostA, hostB];

    // Interleave ordinary: A1 -> B1 -> A2 -> A/unfiled -> B/unfiled.
    let saved = commitCrossHostFolderOrder(emptyCrossHostFolderOrder(), baseSources, [
      k('keyA', 'a1'), k('keyB', 'b1'), k('keyA', 'a2'), k('keyA', null), k('keyB', null),
    ]);

    // Pin B1 on Host B -> B1 moves to top pinned tier; ordinary order remembers B1's slot.
    saved = recordCrossHostFolderPin(saved, baseSources, k('keyB', 'b1'), true);
    const hostBPinned = makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }], { pinnedFolderIds: ['b1'] });
    expect(describeOrder([hostA, hostBPinned], saved)).toEqual([
      'keyB/b1', 'keyA/a1', 'keyA/a2', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Pin A2 on Host A -> newly pinned A2 prepends ahead of B1 in pinned tier.
    saved = recordCrossHostFolderPin(saved, [hostA, hostBPinned], k('keyA', 'a2'), true);
    const hostAPinned = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }], { pinnedFolderIds: ['a2'] });
    expect(describeOrder([hostAPinned, hostBPinned], saved)).toEqual([
      'keyA/a2', 'keyB/b1', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Reorder within pinned tier: move B1 above A2.
    saved = moveCrossHostFolderOrder(saved, [hostAPinned, hostBPinned], k('keyB', 'b1'), 'up');
    expect(describeOrder([hostAPinned, hostBPinned], saved)).toEqual([
      'keyB/b1', 'keyA/a2', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Moving an ordinary folder "up" or "top" cannot cross into the pinned tier.
    const blocked = moveCrossHostFolderOrder(saved, [hostAPinned, hostBPinned], k('keyA', 'a1'), 'up');
    expect(describeOrder([hostAPinned, hostBPinned], blocked)).toEqual([
      'keyB/b1', 'keyA/a2', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    // Swap ordinary folders while B1 is pinned: move A/unfiled above A1.
    saved = moveCrossHostFolderOrder(saved, [hostAPinned, hostBPinned], k('keyA', null), 'up');
    expect(describeOrder([hostAPinned, hostBPinned], saved)).toEqual([
      'keyB/b1', 'keyA/a2', 'keyA/unfiled', 'keyA/a1', 'keyB/unfiled',
    ]);

    // Unpin B1 -> restores B1 to its ordinary rank (between A/unfiled and A1) without losing the ordinary swap!
    saved = recordCrossHostFolderPin(saved, [hostAPinned, hostBPinned], k('keyB', 'b1'), false);
    expect(describeOrder([hostAPinned, hostB], saved)).toEqual([
      'keyA/a2', 'keyA/unfiled', 'keyB/b1', 'keyA/a1', 'keyB/unfiled',
    ]);
  });

  it('reorders within a filtered visible subset without losing hidden folders', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }]);
    const sources = [hostA, hostB];
    const visible = [k('keyA', 'a1'), k('keyB', 'b1')]; // A2 and both Unfiled hidden by search

    const moved = moveCrossHostFolderOrder(emptyCrossHostFolderOrder(), sources, k('keyB', 'b1'), 'up', visible);
    expect(describeOrder(sources, moved)).toEqual([
      'keyB/b1', 'keyA/a2', 'keyA/unfiled', 'keyA/a1', 'keyB/unfiled',
    ]);
  });

  it('filters visible folders consistently for foldered and folder-free hosts', () => {
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', []); // folder-free
    const items = resolveCrossHostFolderOrder([hostA, hostB], emptyCrossHostFolderOrder());
    const counts = (hostId: string, folderId: string | null) =>
      hostId === 'a' && folderId === 'a1' ? 0 : hostId === 'b' && folderId === null ? 0 : 1;

    // Unfiltered: foldered host keeps empty custom folder, folder-free host hides empty synthetic Unfiled.
    expect(visibleCrossHostFolders(items, counts, false).map(i => `${i.hostId}/${i.folderId ?? 'unfiled'}`))
      .toEqual(['a/a1', 'a/unfiled']);
    // Filtered: hides every folder with zero matching rows.
    expect(visibleCrossHostFolders(items, counts, true).map(i => `${i.hostId}/${i.folderId ?? 'unfiled'}`))
      .toEqual(['a/unfiled']);
  });
});

describe('App-local persistence store', () => {
  function storageWindow() {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    return (key: string | null = CROSS_HOST_FOLDER_ORDER_KEY) => {
      const event = new Event('storage');
      Object.defineProperty(event, 'key', { value: key });
      target.dispatchEvent(event);
    };
  }

  it('keeps a remote reorder made while the combined view is unmounted before the next local move', () => {
    const { storage } = installMemoryStorage();
    const remoteChanged = storageWindow();
    const sources = [
      makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }]),
      makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }]),
    ];
    const unmount = subscribeCrossHostFolderOrder(() => {});
    readCrossHostFolderOrder();
    unmount();

    const remote = moveCrossHostFolderOrder(emptyCrossHostFolderOrder(), sources, k('keyB', 'b1'), 'top');
    storage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify(remote));
    remoteChanged();
    const remount = subscribeCrossHostFolderOrder(() => {});
    try {
      expect(describeOrder(sources, readCrossHostFolderOrder())[0]).toBe('keyB/b1');
      applyCrossHostFolderMove(sources, k('keyA', 'a2'), 'up');
      expect(describeOrder(sources, readCrossHostFolderOrder())).toEqual([
        'keyB/b1', 'keyA/a2', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
      ]);
      expect(JSON.parse(storage.getItem(CROSS_HOST_FOLDER_ORDER_KEY)!)).toEqual(readCrossHostFolderOrder());
    } finally { remount(); }
  });

  it('preserves another window\'s order when removing a host with no mounted subscribers', () => {
    const { storage } = installMemoryStorage();
    const remoteChanged = storageWindow();
    writeCrossHostFolderOrder({ version: 1, pinned: [], ordinary: [k('A', 'a1'), k('A', 'a2'), k('B', 'b1')] });
    const unmount = subscribeCrossHostFolderOrder(() => {});
    unmount();
    storage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify({
      version: 1, pinned: [], ordinary: [k('B', 'b1'), k('A', 'a2'), k('A', 'a1')],
    }));
    remoteChanged();
    removeCrossHostFolderOrderHost('B');
    expect(readCrossHostFolderOrder().ordinary).toEqual([k('A', 'a2'), k('A', 'a1')]);
    expect(JSON.parse(storage.getItem(CROSS_HOST_FOLDER_ORDER_KEY)!).ordinary).toEqual([k('A', 'a2'), k('A', 'a1')]);
  });

  it('observes relevant storage changes and clear, ignoring unrelated keys', () => {
    const { storage } = installMemoryStorage();
    const remoteChanged = storageWindow();
    const listener = vi.fn();
    const unmount = subscribeCrossHostFolderOrder(listener);
    try {
      readCrossHostFolderOrder();
      const remote = { version: 1, pinned: [], ordinary: [k('A', 'a1')] };
      storage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify(remote));
      remoteChanged('unrelated-preference');
      expect(listener).not.toHaveBeenCalled();
      remoteChanged();
      expect(readCrossHostFolderOrder()).toEqual(remote);
      expect(listener).toHaveBeenCalledTimes(1);
      storage.clear();
      remoteChanged(null);
      expect(readCrossHostFolderOrder()).toEqual(emptyCrossHostFolderOrder());
      expect(listener).toHaveBeenCalledTimes(2);
    } finally { unmount(); }
  });

  it('retains the in-memory choice across unmount/remount when storage rejects writes', () => {
    const { storage } = installMemoryStorage();
    storageWindow();
    storage.setItem = () => { throw new Error('quota_exceeded'); };
    const unmount = subscribeCrossHostFolderOrder(() => {});
    const choice = { version: 1 as const, pinned: [], ordinary: [k('A', 'a2'), k('A', 'a1')] };
    writeCrossHostFolderOrder(choice);
    unmount();
    const remount = subscribeCrossHostFolderOrder(() => {});
    try { expect(readCrossHostFolderOrder()).toMatchObject(choice); }
    finally { remount(); }
  });

  it('persists, reloads, applies moves/pins, and cleans up removed hosts via localStorage', () => {
    const { map } = installMemoryStorage();
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }]);
    const sources = [hostA, hostB];

    applyCrossHostFolderMove(sources, k('keyB', 'b1'), 'top');
    expect(map.has(CROSS_HOST_FOLDER_ORDER_KEY)).toBe(true);

    // Simulate full App reload by resetting in-memory cache.
    resetCrossHostFolderOrderCache();
    expect(describeOrder(sources, readCrossHostFolderOrder())).toEqual([
      'keyB/b1', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    applyCrossHostFolderPin(sources, k('keyA', 'a1'), true);
    resetCrossHostFolderOrderCache();
    expect(readCrossHostFolderOrder().pinned).toEqual([k('keyA', 'a1')]);

    saveCrossHostFolderOrder(sources, [k('keyA', 'a1'), k('keyB', 'b1'), k('keyB', null), k('keyA', null)]);
    removeCrossHostFolderOrderHost('keyB');
    resetCrossHostFolderOrderCache();
    expect(readCrossHostFolderOrder().ordinary).not.toContain(k('keyB', 'b1'));
    expect(readCrossHostFolderOrder().ordinary).toContain(k('keyA', null));

    writeCrossHostFolderOrder(emptyCrossHostFolderOrder(), { fromSync: true });
    expect(map.has(CROSS_HOST_FOLDER_ORDER_KEY)).toBe(false);
  });

  it('propagates single-host FolderManager reorders and folder deletions into combined cross-host order', () => {
    installMemoryStorage();
    const hostA = makeSource('a', 'keyA', 'Host Alpha', [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }]);
    const hostB = makeSource('b', 'keyB', 'Host Beta', [{ id: 'b1', name: 'B1' }]);
    const sources = [hostA, hostB];

    // Interleaved cross-host order: A1 -> B1 -> A2 -> A/unfiled -> B/unfiled.
    saveCrossHostFolderOrder(sources, [
      k('keyA', 'a1'), k('keyB', 'b1'), k('keyA', 'a2'), k('keyA', null), k('keyB', null),
    ]);

    // Single-host FolderManager reorders Host A to [a2, a1, null]. Host B stays anchored in slot 1!
    const nextHostA: ConversationFoldersState = {
      revision: 2,
      folders: [{ id: 'a2', name: 'A2' }, { id: 'a1', name: 'A1' }],
      assignments: [],
    };
    const pureReordered = reorderSingleHostCrossHostFolderOrder(readCrossHostFolderOrder(), 'keyA', nextHostA, ['a2', 'a1', null]);
    expect(describeOrder([{ ...hostA, folders: nextHostA }, hostB], pureReordered)).toEqual([
      'keyA/a2', 'keyB/b1', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    applySingleHostFolderReorder('keyA', nextHostA, ['a2', 'a1', null]);
    expect(describeOrder([{ ...hostA, folders: nextHostA }, hostB], readCrossHostFolderOrder())).toEqual([
      'keyA/a2', 'keyB/b1', 'keyA/a1', 'keyA/unfiled', 'keyB/unfiled',
    ]);

    const purePruned = pruneCrossHostFolderOrderFolder(readCrossHostFolderOrder(), 'keyA', 'a1');
    expect(purePruned.ordinary).not.toContain(k('keyA', 'a1'));
    pruneCrossHostDeletedFolder('keyA', 'a1');
    expect(readCrossHostFolderOrder().ordinary).not.toContain(k('keyA', 'a1'));
  });

  it('includes tarobird-cross-host-folder-order-v1 in desktop migration export and import', async () => {
    const orderPayload = JSON.stringify({
      version: 1,
      updatedAt: 12345,
      pinned: [k('hubA', 'f1')],
      ordinary: [k('hubB', 'f2'), k('hubA', null)],
    });
    const parts: string[] = [];
    const hostIdA = `hub_${'a'.repeat(64)}`;
    const registryHosts = [{ id: hostIdA, name: 'Host A', publicKey: 'hubA', deviceId: 'dev1', databaseName: 'tarocub-v1', registrationId: 'r1', createdAt: 1, state: 'ready' }];
    const source: ExportSource = {
      async database(name) { return name === 'tarocub-hosts-v1' ? { version: 2 } : undefined; },
      async *records(name, store) {
        if (name === 'tarocub-hosts-v1' && store === 'hosts') yield { key: hostIdA, value: registryHosts[0] };
      },
      *localStorage() {
        yield [CROSS_HOST_FOLDER_ORDER_KEY, orderPayload];
        yield ['unrelated-key', 'skip-me'];
      },
    };
    let committedMeta: any;
    const sink: ExportSink = {
      async begin() { return '00000000-0000-0000-0000-000000000001'; },
      async part(_index, text) { parts.push(text); },
      async blob() { return '0'.repeat(64); },
      async commit(meta) { committedMeta = meta; return { exportId: '00000000-0000-0000-0000-000000000001', records: 2, bytes: parts.join('').length }; },
      async abort() {},
    };
    const exported = await exportDesktopData(source, sink, { appVersion: '1.6.0' });
    expect(exported.state).toBe('exported');
    const joined = parts.join('');
    expect(joined).toContain(CROSS_HOST_FOLDER_ORDER_KEY);
    expect(joined).not.toContain('unrelated-key');

    const importedLocal: [string, string][] = [];
    const importTarget: ImportTarget = {
      async state() { return { hosts: 0, candidates: 0, registryVersion: 2 }; },
      async inspect() { return { exists: false, records: 0 }; },
      async databases() { return []; },
      async prepare() { return 1; },
      async claim() {},
      async put() {},
      async commitRegistry() {},
      async setLocalStorage(entries) { importedLocal.push(...entries); },
      async finishLocalStorage() {},
    };
    const importSource: ImportSource = {
      manifest: {
        format: 'tarobot-desktop-migration',
        version: 1,
        exportId: '00000000-0000-0000-0000-000000000001',
        createdAt: 1,
        installation: 'test',
        source: { app: 'tauri', appVersion: '1.6.0' },
        databases: committedMeta.databases.map((d: any) => ({ ...d, stores: d.name === 'tarocub-hosts-v1' ? { hosts: 1 } : {} })),
        localStorage: 1,
        parts: [{ file: '000000.jsonl', bytes: joined.length, sha256: 'a'.repeat(64), records: 2 }],
        blobs: [],
        totals: { records: 2, blobs: 0 },
        skipped: [],
        requiresRepair: [],
      } as any,
      part: async () => joined,
      blob: async () => new Uint8Array(),
    };
    const imported = await importDesktopData(importSource, importTarget);
    expect(imported.state).toBe('imported');
    expect(importedLocal).toEqual([[CROSS_HOST_FOLDER_ORDER_KEY, orderPayload]]);
  });
});
