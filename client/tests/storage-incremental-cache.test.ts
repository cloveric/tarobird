import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubEvent, Message } from "../../src/client-protocol/index.js";

type StoreValue = any;

const mockEnv = vi.hoisted(() => {
  const databases = new Map<string, Map<string, Map<string, StoreValue>>>();
  const channels = new Map<string, Set<MockBroadcastChannel>>();
  const readCounts = { messagesAll: 0 };
  let deferBroadcasts = false;
  const queuedBroadcasts: Array<() => void> = [];
  const readGates: Array<{
    onStart: () => void;
    release: Promise<void>;
  }> = [];
  let clearDiskCacheImpl: () => Promise<void> = async () => {};

  class MockBroadcastChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    private closed = false;
    constructor(readonly name: string) {
      let set = channels.get(name);
      if (!set) channels.set(name, (set = new Set()));
      set.add(this);
    }
    postMessage(data: unknown): void {
      if (this.closed) return;
      const deliver = () => {
        for (const peer of channels.get(this.name) ?? []) {
          if (peer !== this && !peer.closed) peer.onmessage?.({ data });
        }
      };
      if (deferBroadcasts) {
        queuedBroadcasts.push(deliver);
      } else {
        deliver();
      }
    }
    close(): void {
      this.closed = true;
      channels.get(this.name)?.delete(this);
    }
  }

  function flushBroadcasts(): void {
    while (queuedBroadcasts.length) {
      queuedBroadcasts.shift()!();
    }
  }

  function pauseNextMessagesRead(): { started: Promise<void>; release: () => void } {
    let onStart!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { onStart = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    readGates.push({ onStart, release: releasePromise });
    return { started, release };
  }

  function ensureDb(name: string): Map<string, Map<string, StoreValue>> {
    let db = databases.get(name);
    if (!db) {
      db = new Map();
      for (const store of [
        "settings", "conversations", "messages", "activity", "cursors", "outbox",
        "syncState", "syncMessages", "conversationDrafts", "attachmentData",
        "attachmentMeta", "downloadMeta", "downloadChunks", "workbenchLayouts",
        "workbenchBoards", "workbenchMarkdown", "workbenchDesign",
        "workbenchDesignMeta", "workbenchDesignObjects",
      ]) db.set(store, new Map());
      databases.set(name, db);
    }
    return db;
  }

  function encodeKey(key: unknown): string {
    return typeof key === "string" ? key : JSON.stringify(key);
  }

  function cloneValue<T>(v: T): T {
    return v === undefined ? v : structuredClone(v);
  }

  function makeDbHandle(name: string) {
    const stores = ensureDb(name);
    const snapshotAll = () => {
      const copy = new Map<string, Map<string, StoreValue>>();
      for (const [k, m] of stores) copy.set(k, new Map([...m.entries()].map(([ek, ev]) => [ek, cloneValue(ev)])));
      return copy;
    };

    const makeCursor = (entries: Array<[string, any]>, deleteFn: (key: string) => void, updateFn: (key: string, val: any) => void) => {
      let idx = 0;
      const makeItem = (): any => {
        if (idx >= entries.length) return null;
        const [k, v] = entries[idx]!;
        return {
          key: k,
          primaryKey: k,
          value: cloneValue(v),
          delete: async () => { deleteFn(k); },
          update: async (next: any) => { updateFn(k, cloneValue(next)); },
          continue: async () => { idx++; return makeItem(); },
        };
      };
      return makeItem();
    };

    const makeStore = (working: Map<string, Map<string, StoreValue>>, storeName: string) => {
      const map = working.get(storeName)!;
      const keyPath = storeName === "messages" || storeName === "conversations" || storeName === "outbox" ? "id" : undefined;
      const makeIndex = (indexName: string) => ({
        getAll: async (query: any) => {
          if (storeName === "messages" && indexName === "conversation") {
            readCounts.messagesAll++;
            return [...map.values()]
              .filter((r) => r.conversationId === query)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map(cloneValue);
          }
          if (storeName === "messages" && indexName === "status") {
            return [...map.values()].filter((r) => r.status === query).map(cloneValue);
          }
          return [];
        },
        getAllKeys: async (query: any) => {
          if (storeName === "messages" && indexName === "status") {
            return [...map.values()].filter((r) => r.status === query).map((r) => r.id);
          }
          return [];
        },
        openCursor: async (query?: any) => {
          const entries = [...map.entries()].filter(([, v]) => {
            if (query === undefined) return true;
            if (storeName === "messages" && indexName === "conversation") return v.conversationId === query;
            if (storeName === "syncMessages" && indexName === "owner") return v.owner === query;
            if (storeName === "conversationDrafts" && indexName === "reply") return v.reply?.id === query;
            return false;
          });
          return makeCursor(entries, (k) => map.delete(k), (k, v) => map.set(k, v));
        },
      });
      return {
        get: async (key: any) => cloneValue(map.get(encodeKey(key))),
        put: async (value: any, key?: any) => {
          const k = key !== undefined ? encodeKey(key) : keyPath ? encodeKey(value[keyPath]) : encodeKey(value.id);
          map.set(k, cloneValue(value));
          return k;
        },
        add: async (value: any, key?: any) => {
          const k = key !== undefined ? encodeKey(key)
            : storeName === "syncMessages" ? encodeKey([value.owner, value.message.id])
            : keyPath ? encodeKey(value[keyPath]) : encodeKey(value.id);
          map.set(k, cloneValue(value));
          return k;
        },
        delete: async (key: any) => { map.delete(encodeKey(key)); },
        clear: async () => { map.clear(); },
        getAll: async () => [...map.values()].map(cloneValue),
        getAllKeys: async () => [...map.keys()],
        index: makeIndex,
        openCursor: async () => makeCursor([...map.entries()], (k) => map.delete(k), (k, v) => map.set(k, v)),
      };
    };

    return {
      objectStoreNames: [...stores.keys()],
      get: async (storeName: string, key: any) => cloneValue(stores.get(storeName)!.get(encodeKey(key))),
      getAll: async (storeName: string) => [...stores.get(storeName)!.values()].map(cloneValue),
      getAllFromIndex: async (storeName: string, indexName: string, query: any) =>
        makeStore(stores, storeName).index(indexName).getAll(query),
      getAllKeysFromIndex: async (storeName: string, indexName: string, query: any) =>
        makeStore(stores, storeName).index(indexName).getAllKeys(query),
      transaction: (names: string | string[], mode = "readonly") => {
        const list = Array.isArray(names) ? names : [names];
        // Readonly transactions snapshot the store state at transaction open so
        // gated reads reproduce real IndexedDB MVCC snapshot semantics.
        const working = snapshotAll();
        const gate = mode === "readonly" && list.includes("messages") && list.includes("cursors")
          ? readGates.shift()
          : undefined;
        let aborted = false;
        let committed = false;
        const done = new Promise<void>((resolve, reject) => {
          queueMicrotask(() => {
            const finish = () => {
              if (aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              if (mode === "readwrite" && !committed) {
                committed = true;
                for (const storeName of list) stores.set(storeName, working.get(storeName)!);
              }
              resolve();
            };
            if (gate) {
              gate.onStart();
              void gate.release.then(finish);
            } else {
              finish();
            }
          });
        });
        const storeObj = list.length === 1 ? makeStore(working, list[0]!) : undefined;
        return {
          objectStore: (n: string) => makeStore(working, n),
          store: storeObj,
          objectStoreNames: list,
          abort: () => { aborted = true; },
          done,
        };
      },
      close: () => {},
    };
  }

  return {
    databases,
    channels,
    readCounts,
    MockBroadcastChannel,
    makeDbHandle,
    flushBroadcasts,
    pauseNextMessagesRead,
    setDeferBroadcasts: (value: boolean) => { deferBroadcasts = value; },
    clearQueuedBroadcasts: () => { queuedBroadcasts.length = 0; },
    clearReadGates: () => { readGates.length = 0; },
    setClearDiskCacheImpl: (fn: () => Promise<void>) => { clearDiskCacheImpl = fn; },
    runClearDiskCache: () => clearDiskCacheImpl(),
  };
});

vi.mock("idb", () => ({
  openDB: async (name: string) => mockEnv.makeDbHandle(name),
}));

vi.mock("../src/attachment-disk-cache.js", () => ({
  clearAttachmentDiskCache: () => mockEnv.runClearDiskCache(),
}));

import { ClientCache } from "../src/storage.js";

function userMessage(id: string, conversationId: string, createdAt: number, text: string, version = 1): Message {
  return {
    id,
    conversationId,
    authorId: "owner",
    authorType: "user",
    blocks: [{ type: "text", text }],
    status: "complete",
    version,
    clientMsgId: `client_${id}`,
    createdAt,
  };
}

function botMessage(
  id: string,
  conversationId: string,
  createdAt: number,
  text: string,
  status: Message["status"] = "streaming",
  version = 1,
): Message {
  return {
    id,
    conversationId,
    authorId: "bot_1",
    authorType: "bot",
    blocks: [{ type: "text", text }],
    status,
    version,
    createdAt,
  };
}

function messagePayload(message: Message): HubEvent["payload"] {
  return message as unknown as HubEvent["payload"];
}

function messageEvent(
  conversationId: string,
  seq: number,
  kind: "message.created" | "message.updated",
  message: Message,
  at = message.createdAt,
): HubEvent {
  return {
    v: 1,
    type: "event",
    conversationId,
    seq,
    at,
    kind,
    payload: messagePayload(message),
  };
}

describe("ClientCache incremental history cache & fail-closed invalidations", () => {
  beforeEach(() => {
    mockEnv.databases.clear();
    mockEnv.channels.clear();
    mockEnv.readCounts.messagesAll = 0;
    mockEnv.setDeferBroadcasts(false);
    mockEnv.clearQueuedBroadcasts();
    mockEnv.clearReadGates();
    mockEnv.setClearDiskCacheImpl(async () => {});
    vi.stubGlobal("BroadcastChannel", mockEnv.MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs zero full IDB reads on steady-state creates/streams/updates/reads and matches fresh IDB reads identically", async () => {
    const dbName = "db-incremental-1";
    const cache = new ClientCache(dbName);
    const reader = new ClientCache(dbName);
    try {
      await cache.apply(messageEvent("c1", 1, "message.created", userMessage("m1", "c1", 100, "hello")));

      // Cold read: exactly 1 full IDB read populates ConversationMessageCache.
      expect(await cache.messages("c1")).toHaveLength(1);
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      // Bot starts streaming, receives deltas, completes, and user sends another message.
      await cache.apply(messageEvent("c1", 2, "message.created", botMessage("m2", "c1", 110, "hi", "streaming", 1)));
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 3, at: 120, kind: "message.stream",
        payload: { messageId: "m2", baseVersion: 1, version: 2, ops: [{ op: "appendText", block: 0, text: " there" }] },
      });
      await cache.apply(messageEvent("c1", 4, "message.updated", botMessage("m2", "c1", 110, "hi there!", "complete", 3), 130));
      // Non-message event advances cursor cleanly without invalidating cache.
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 5, at: 135, kind: "read",
        payload: { userId: "owner", seq: 4 },
      }, "owner");
      await cache.apply(messageEvent("c1", 6, "message.created", userMessage("m3", "c1", 140, "follow up")));
      // Out-of-order / tied createdAt + tombstone update
      await cache.apply(messageEvent("c1", 7, "message.created", userMessage("m2b", "c1", 140, "tie before m3")));
      await cache.apply(messageEvent("c1", 8, "message.updated", { ...userMessage("m1", "c1", 100, "hello", 2), status: "deleted" }, 150));

      const cachedResult = await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(1); // ZERO extra full IDB reads!
      expect(cache.peekMessages("c1")).toEqual(cachedResult);

      // Fresh uncached reader performs 1 IDB read; incremental memory must match it identically.
      const idbResult = await reader.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(2);
      expect(cachedResult).toEqual(idbResult);
      expect(cachedResult.map((m) => [m.id, m.status])).toEqual([
        ["m1", "deleted"],
        ["m2", "complete"],
        ["m2b", "complete"],
        ["m3", "complete"],
      ]);
    } finally {
      cache.close();
      reader.close();
    }
  });

  it("fails closed to a fresh IDB read on cross-tab BroadcastChannel, snapshot backfill, invalidateMessages, and reset", async () => {
    const dbName = "db-fail-closed";
    const cache = new ClientCache(dbName);
    const otherTab = new ClientCache(dbName);
    try {
      await cache.apply(messageEvent("c1", 1, "message.created", userMessage("m1", "c1", 100, "initial")));
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      // 1) Cross-tab / sibling mutation invalidates cache -> next read hits IDB.
      await otherTab.apply(messageEvent("c1", 2, "message.created", userMessage("m2", "c1", 200, "from-other-tab")));
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(mockEnv.readCounts.messagesAll).toBe(2);

      // 2) Simulated BroadcastChannel invalidation from a separate tab.
      const bc = new mockEnv.MockBroadcastChannel(`tarobot-messages:${dbName}`);
      bc.postMessage({ v: 1, conversationId: "c1" });
      bc.close();
      expect(cache.peekMessages("c1")).toBeUndefined();
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(3);

      // 3) acceptSnapshot backfill invalidates cache -> next read hits IDB.
      const conv = { id: "c1", type: "direct" as const, title: "Chat", ownerId: "owner", botIds: ["bot_1"], archived: false, createdAt: 1 };
      await cache.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap_1", conversation: conv, after: 2, seq: 10, readSeq: 10 });
      await cache.acceptSnapshot({
        v: 1, type: "snapshot.message", id: "snap_1", index: 0, contentSeq: 10, unreadSeq: 0,
        message: userMessage("m_snap", "c1", 300, "rebuilt"),
      });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap_1", count: 1 });
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m_snap"]);
      expect(mockEnv.readCounts.messagesAll).toBe(4);

      // 4) Explicit invalidateMessages (deleteMessages / history clear / rewind / outbox reconcile).
      cache.invalidateMessages("c1");
      expect(cache.peekMessages("c1")).toBeUndefined();
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(5);

      // 5) forgetIdentity / close fail closed.
      await cache.forgetIdentity();
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect(await cache.messages("c1")).toEqual([]);
      expect(mockEnv.readCounts.messagesAll).toBe(6);

      cache.close();
      expect(cache.peekMessages("c1")).toBeUndefined();
    } finally {
      cache.close();
      otherTab.close();
    }
  });

  it("does not corrupt cache when an apply() transaction fails or races an initial IDB load", async () => {
    const dbName = "db-abort-race";
    const cache = new ClientCache(dbName);
    try {
      await cache.apply(messageEvent("c1", 1, "message.created", userMessage("m1", "c1", 100, "first")));
      await cache.messages("c1");

      // Sync gap aborts transaction: cache must still have only m1.
      await expect(cache.apply(messageEvent("c1", 5, "message.created", userMessage("m_gap", "c1", 200, "skipped")))).rejects.toThrow("sync_gap");
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1"]);

      // Invalidate, start a slow IDB read, and mutate mid-read: stale read must not populate cache.
      cache.invalidateMessages("c1");
      const gate = mockEnv.pauseNextMessagesRead();
      const pendingRead = cache.messages("c1");
      await gate.started;
      // Immediately commit seq 2 before pendingRead resolves:
      await cache.apply(messageEvent("c1", 2, "message.created", userMessage("m2", "c1", 150, "second")));
      gate.release();
      await pendingRead;
      // Epoch changed mid-read, so cache was NOT populated with stale [m1]:
      // next read hits IDB and sees both [m1, m2].
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
    } finally {
      cache.close();
    }
  });

  it("keeps messageEpoch strictly monotonic so in-flight reads never leak forgotten/reset messages or regress on global invalidation", async () => {
    // 1) In-flight read racing forgetIdentity() after 1 event (and while clearAttachmentDiskCache() is still pending).
    const dbForget = "db-epoch-forget";
    const cacheForget = new ClientCache(dbForget);
    try {
      await cacheForget.apply(messageEvent("c1", 1, "message.created", userMessage("secret_1", "c1", 100, "top secret")));
      const readGate = mockEnv.pauseNextMessagesRead();
      let diskStarted!: () => void;
      let releaseDisk!: () => void;
      const diskClearStarted = new Promise<void>((resolve) => { diskStarted = resolve; });
      const diskClearDone = new Promise<void>((resolve) => { releaseDisk = resolve; });
      mockEnv.setClearDiskCacheImpl(async () => {
        diskStarted();
        await diskClearDone;
      });

      const inFlight = cacheForget.messages("c1");
      await readGate.started;

      const forgetPromise = cacheForget.forgetIdentity();
      await diskClearStarted;

      // Even before clearAttachmentDiskCache() finishes, IDB is wiped and global epoch has strictly advanced.
      readGate.release();
      await inFlight;
      expect(cacheForget.peekMessages("c1")).toBeUndefined();

      releaseDisk();
      await forgetPromise;
      expect(cacheForget.peekMessages("c1")).toBeUndefined();
      expect(await cacheForget.messages("c1")).toEqual([]);
    } finally {
      cacheForget.close();
    }

    // 2) In-flight read racing finishReset() after 1 per-conversation epoch bump.
    const dbReset = "db-epoch-reset";
    const starter = new ClientCache(dbReset);
    let finisher: ClientCache | undefined;
    try {
      await starter.apply(messageEvent("c1", 1, "message.created", userMessage("pre_reset_1", "c1", 100, "private")));
      await starter.beginReset();
      finisher = new ClientCache(dbReset);
      // Advance finisher's per-conversation epoch to 1 while globalMessageEpoch is still 0.
      finisher.invalidateMessages("c1");

      const readGate = mockEnv.pauseNextMessagesRead();
      const inFlight = finisher.messages("c1");
      await readGate.started;

      await finisher.finishReset();
      readGate.release();
      await inFlight;

      expect(finisher.peekMessages("c1")).toBeUndefined();
      expect(await finisher.messages("c1")).toEqual([]);
    } finally {
      starter.close();
      finisher?.close();
    }

    // 3) In-flight read racing apply(m2) + global invalidateMessages() must never regress epoch back to 1.
    const dbRollback = "db-epoch-rollback";
    const cacheRollback = new ClientCache(dbRollback);
    try {
      await cacheRollback.apply(messageEvent("c1", 1, "message.created", userMessage("m1", "c1", 100, "first")));
      const readGate = mockEnv.pauseNextMessagesRead();
      const inFlight = cacheRollback.messages("c1");
      await readGate.started;

      await cacheRollback.apply(messageEvent("c1", 2, "message.created", userMessage("m2", "c1", 200, "second")));
      cacheRollback.invalidateMessages(); // global invalidation must advance past 2, never regress to 1!

      readGate.release();
      await inFlight;

      expect(cacheRollback.peekMessages("c1")).toBeUndefined();
      expect((await cacheRollback.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
    } finally {
      cacheRollback.close();
    }
  });

  it("handles cross-tab IDB commits before async BroadcastChannel arrives without stale reads or corrupt partial snapshots", async () => {
    const dbName = "db-cross-tab-async";
    mockEnv.setDeferBroadcasts(true);
    const tabB = new ClientCache(dbName);
    try {
      await tabB.apply(messageEvent("c1", 1, "message.created", userMessage("m1", "c1", 100, "first")));
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m1"]);
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      // Simulate Tab A (separate process, bypassing siblingCaches) committing seq=2 (m2) to shared IDB
      // and queuing a BroadcastChannel invalidation that has NOT yet been delivered to Tab B.
      const stores = mockEnv.databases.get(dbName)!;
      const m2 = userMessage("m2", "c1", 200, "from-tab-a");
      stores.get("messages")!.set(m2.id, { ...m2, activitySeq: 2, activityAt: 200 });
      stores.get("cursors")!.set("c1", 2);
      const tabAChannel = new mockEnv.MockBroadcastChannel(`tarobot-messages:${dbName}`);
      tabAChannel.postMessage({ v: 1, conversationId: "c1" });
      tabAChannel.close();

      // Case A: Tab B receives duplicate seq=2 -> hits event.seq <= last before BC delivers.
      const dupResult = await tabB.apply(messageEvent("c1", 2, "message.created", m2));
      expect(dupResult).toBeUndefined();
      expect(tabB.peekMessages("c1")).toBeUndefined();
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(mockEnv.readCounts.messagesAll).toBe(2);

      // Case B: Tab A now commits seq=3 (m3) directly to IDB before BC delivers,
      // and Tab B next applies seq=4 (m4) (`event.seq === last + 1`).
      const m3 = userMessage("m3", "c1", 300, "missed-by-tab-b");
      stores.get("messages")!.set(m3.id, { ...m3, activitySeq: 3, activityAt: 300 });
      stores.get("cursors")!.set("c1", 3);
      const tabAChannel2 = new mockEnv.MockBroadcastChannel(`tarobot-messages:${dbName}`);
      tabAChannel2.postMessage({ v: 1, conversationId: "c1" });
      tabAChannel2.close();

      const m4 = userMessage("m4", "c1", 400, "applied-by-tab-b");
      await tabB.apply(messageEvent("c1", 4, "message.created", m4));
      // Must fail closed instead of synthesizing corrupt ["m1", "m2", "m4"]!
      expect(tabB.peekMessages("c1")).toBeUndefined();
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(mockEnv.readCounts.messagesAll).toBe(3);

      // Flush deferred cross-tab broadcasts and confirm subsequent reads stay consistent.
      mockEnv.flushBroadcasts();
      expect(tabB.peekMessages("c1")).toBeUndefined();
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    } finally {
      tabB.close();
    }
  });

  it("invalidates stale pre-snapshot history on acceptSnapshot() cross-tab early return before async BroadcastChannel arrives", async () => {
    const dbName = "db-cross-tab-snapshot-early";
    mockEnv.setDeferBroadcasts(true);
    const tabB = new ClientCache(dbName);
    try {
      const mOld = userMessage("m_old", "c1", 100, "pre-snapshot");
      await tabB.apply(messageEvent("c1", 1, "message.created", mOld));
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m_old"]);
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      const conv = { id: "c1", type: "direct" as const, title: "Snap", ownerId: "owner", botIds: ["bot_1"], archived: false, createdAt: 1 };
      const lineage = "11111111-1111-4111-8111-111111111111";
      const mSnap = userMessage("m_snap", "c1", 200, "snapshot-replacement");
      await tabB.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap_cross", conversation: conv, after: 1, seq: 10, readSeq: 0, lineage });
      await tabB.acceptSnapshot({ v: 1, type: "snapshot.message", id: "snap_cross", index: 0, contentSeq: 10, unreadSeq: 0, message: mSnap });

      // Before Tab B processes snapshot.end, Tab A commits the exact same snapshot directly to IDB
      // with BroadcastChannel delivery still pending.
      const stores = mockEnv.databases.get(dbName)!;
      stores.get("messages")!.delete(mOld.id);
      stores.get("messages")!.set(mSnap.id, { ...mSnap, activitySeq: 10, activityAt: 200 });
      stores.get("cursors")!.set("c1", 10);
      stores.get("settings")!.set("syncLineage:c1", lineage);
      const tabAChannel = new mockEnv.MockBroadcastChannel(`tarobot-messages:${dbName}`);
      tabAChannel.postMessage({ v: 1, conversationId: "c1" });
      tabAChannel.close();

      // Tab B takes the early-return branch (`lineage === state.lineage && cursor >= state.seq`).
      expect(await tabB.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap_cross", count: 1 })).toBe(true);
      // Immediately (BEFORE async BroadcastChannel delivers), Tab B's cache must be invalidated!
      expect(tabB.peekMessages("c1")).toBeUndefined();
      expect((await tabB.messages("c1")).map((m) => m.id)).toEqual(["m_snap"]);
      expect(mockEnv.readCounts.messagesAll).toBe(2);

      mockEnv.flushBroadcasts();
    } finally {
      tabB.close();
    }
  });

  it("prevents an older concurrent cold read from downgrading a newer cursor and fails closed across lineages", async () => {
    const dbName = "db-concurrent-cold-reads";
    const cache = new ClientCache(dbName);
    try {
      const m1 = userMessage("m1", "c1", 100, "first");
      await cache.apply(messageEvent("c1", 1, "message.created", m1));

      // Pause Read 1 at cursor=1 while IDB advances externally (simulating cross-tab commit without BC).
      const gate1 = mockEnv.pauseNextMessagesRead();
      const read1 = cache.messages("c1");
      await gate1.started;

      const stores = mockEnv.databases.get(dbName)!;
      const m2 = userMessage("m2", "c1", 200, "second");
      stores.get("messages")!.set(m2.id, { ...m2, activitySeq: 2, activityAt: 200 });
      stores.get("cursors")!.set("c1", 2);

      // Read 2 completes first with cursor=2 and populates cache.
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);

      // Now stale Read 1 (cursor=1) finishes; it must NOT downgrade the cached cursor=2 entry.
      gate1.release();
      await read1;
      expect(cache.peekMessages("c1")?.map((m) => m.id)).toEqual(["m1", "m2"]);

      // Now test differing lineages racing under the same local epoch: must fail closed.
      cache.invalidateMessages("c1");
      const gateLin1 = mockEnv.pauseNextMessagesRead();
      const readLin1 = cache.messages("c1");
      await gateLin1.started;

      const mLin2 = userMessage("m_lin2", "c1", 300, "new-lineage");
      stores.get("messages")!.clear();
      stores.get("messages")!.set(mLin2.id, { ...mLin2, activitySeq: 1, activityAt: 300 });
      stores.get("cursors")!.set("c1", 1);
      stores.get("settings")!.set("syncLineage:c1", "22222222-2222-4222-8222-222222222222");

      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m_lin2"]);
      gateLin1.release();
      await readLin1;

      // Differing lineage detected -> failed closed (cache invalidated), next read gets authoritative m_lin2.
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m_lin2"]);
    } finally {
      cache.close();
    }
  });
});
