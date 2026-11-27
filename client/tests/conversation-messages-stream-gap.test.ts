import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import { CONVERSATION_SYNC_CAPABILITY } from "../../src/client-protocol/snapshot.js";
import type { ClientCache, Identity } from "../src/storage.js";

const io = vi.hoisted(() => ({ socket: vi.fn(), http: vi.fn(), notify: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "nonce", signChallenge: async () => "signature", verifyHub: async () => {} }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: io.http, usesPinnedTransport: () => false }));
vi.mock("../src/native.js", () => ({ nativePlatform: () => "macos" }));
vi.mock("../src/notifications.js", () => ({ desktopNotification: io.notify }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));

import { HubConnection } from "../src/connection.js";
import { MIN_HISTORY_READ_GAP_MS, useConversationMessages } from "../src/conversation-messages.js";
import { beginSendTiming, clearSendTimingRecords, getSendTimingRecords, setSendTimingTestHook } from "../src/send-timing.js";

function setupDom() {
  const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", Object.assign(dom.document, { visibilityState: "hidden", hasFocus: () => false }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return dom.document.getElementById("root")!;
}

async function setupConnection(options: { withPeek?: boolean } = {}) {
  const ws = {
    readyState: 1,
    onopen: undefined as undefined | (() => void),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
    send: vi.fn(),
    close: vi.fn(),
  };
  io.socket.mockReturnValue(ws);
  const hubPublicKey = Buffer.from("302a300506032b6570032100" + "01".repeat(32), "hex").toString("base64");
  const identity: Identity = { deviceId: "device", name: "Fixture", publicKey: "device-key", hubPublicKey, routes: [] };
  const stored: Message[] = [];
  const invalidateMessages = vi.fn();
  const messagesRead = vi.fn(async () => stored.slice());
  const peekMessages = options.withPeek ? vi.fn(() => (stored.length ? stored : undefined)) : undefined;

  const cache = {
    operationRecord: async () => "",
    discardSnapshot: async () => {},
    syncResume: async () => ({ cursors: {}, syncLineages: {} }),
    selectedConversation: async () => "c1",
    saveConversations: vi.fn(async () => {}),
    saveProfiles: async () => {},
    outbox: vi.fn(async () => []),
    cursor: vi.fn(async () => 10),
    messages: messagesRead,
    ...(peekMessages ? { peekMessages } : {}),
    invalidateMessages,
    apply: vi.fn(async (event: { kind: string; payload: Message }) => {
      if (event.kind === "message.created" || event.kind === "message.updated") {
        const idx = stored.findIndex((m) => m.id === event.payload.id);
        if (idx >= 0) stored[idx] = event.payload;
        else stored.push(event.payload);
        return event.payload;
      }
      if (event.kind === "message.stream") {
        const prev = stored[stored.length - 1];
        if (prev) {
          const next = { ...prev, version: prev.version + 1, blocks: [{ type: "text" as const, text: "streamed" }] };
          stored[stored.length - 1] = next;
          return next;
        }
      }
      return undefined;
    }),
    claimNotification: vi.fn(async () => false),
  };

  const connection = new HubConnection(identity, cache as unknown as ClientCache);
  Reflect.set(connection, "selectRoute", async () => ({ route: { name: "Direct", url: "https://hub.example" }, latency: 1 }));
  Reflect.set(connection, "presence", () => {});
  Reflect.set(connection, "refreshNotificationPreferences", async () => {});
  const receive = async (frame: object) => {
    ws.onmessage!({ data: JSON.stringify({ v: 1, ...frame }) });
    await vi.advanceTimersByTimeAsync(0);
  };
  await Reflect.get(connection, "connect").call(connection);
  ws.onopen!();
  await vi.advanceTimersByTimeAsync(0);
  await receive({ type: "challenge", nonce: "server-nonce", signature: "server-signature", publicKey: hubPublicKey });
  await receive({
    type: "ready",
    serverCapabilities: [CONVERSATION_SYNC_CAPABILITY, "messages.delete.v1", "messages.clear.v1"],
    sessionToken: "token",
    expiresAt: Date.now() + 900_000,
    user: { id: "owner", name: "Owner", role: "owner" },
    bots: [],
    conversations: [{ id: "c1", type: "direct", title: "c1", ownerId: "owner", botIds: [], archived: false, createdAt: 1 }],
  });
  await receive({ type: "sync.conversation", conversationId: "c1" });
  await receive({ type: "sync.complete" });
  return { connection, cache, messagesRead, peekMessages, invalidateMessages, receive, stored };
}

describe("stream-gap bypass and fail-closed connection invalidation", () => {
  let root: Root | undefined;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    io.notify.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root?.unmount(); });
      root = undefined;
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("bypasses MIN_HISTORY_READ_GAP_MS on user-send arrival even when uncached, while keeping stream throttle", async () => {
    const container = setupDom();
    const { connection, messagesRead, receive } = await setupConnection({ withPeek: false });
    let latestMessages: Message[] = [];

    function Harness() {
      const state = useConversationMessages(connection, "c1", true, true);
      latestMessages = state.messages;
      return null;
    }

    await act(async () => {
      root = createRoot(container);
      root.render(createElement(Harness));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messagesRead).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    // Bot starts streaming (non-urgent): initial message.created publishes immediately.
    await act(async () => {
      await receive({
        type: "event", conversationId: "c1", seq: 1, kind: "message.created", at: 100,
        payload: { id: "bot_1", conversationId: "c1", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "hi" }], status: "streaming", version: 1, createdAt: 100 },
      });
    });
    expect(messagesRead).toHaveBeenCalledTimes(2);

    // Another bot update right away (non-urgent) MUST wait MIN_HISTORY_READ_GAP_MS (80ms).
    const urgentBefore = connection.conversationImmediateRevision("c1");
    await act(async () => {
      await receive({
        type: "event", conversationId: "c1", seq: 2, kind: "message.updated", at: 110,
        payload: { id: "bot_1", conversationId: "c1", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "hi2" }], status: "complete", version: 2, createdAt: 100 },
      });
    });
    expect(connection.conversationImmediateRevision("c1")).toBe(urgentBefore);
    // At +10ms (< 80ms gap), the non-urgent read is still sleeping!
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(messagesRead).toHaveBeenCalledTimes(2);

    // User sends a message while the stream-gap sleep is active -> urgent revision wakes it IMMEDIATELY!
    await act(async () => {
      await receive({
        type: "event", conversationId: "c1", seq: 3, kind: "message.created", at: 120,
        payload: { id: "user_1", conversationId: "c1", authorId: "owner", authorType: "user", clientMsgId: "cm_1", blocks: [{ type: "text", text: "urgent user msg" }], status: "complete", version: 1, createdAt: 120 },
      });
    });
    expect(connection.conversationImmediateRevision("c1")).toBeGreaterThan(urgentBefore);
    expect(messagesRead).toHaveBeenCalledTimes(3);
    expect(latestMessages.some((m) => m.id === "user_1")).toBe(true);
    expect(MIN_HISTORY_READ_GAP_MS).toBe(80);
  });

  it("skips MIN_HISTORY_READ_GAP_MS when authoritative peekMessages cache is warm", async () => {
    const container = setupDom();
    const { connection, messagesRead, receive } = await setupConnection({ withPeek: true });

    function Harness() {
      useConversationMessages(connection, "c1", true, true);
      return null;
    }

    await act(async () => {
      root = createRoot(container);
      root.render(createElement(Harness));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(messagesRead).toHaveBeenCalledTimes(1);

    await act(async () => {
      await receive({
        type: "event", conversationId: "c1", seq: 1, kind: "message.created", at: 100,
        payload: { id: "bot_1", conversationId: "c1", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "chunk 1" }], status: "streaming", version: 1, createdAt: 100 },
      });
    });
    expect(messagesRead).toHaveBeenCalledTimes(2);

    // Immediately receive another bot update within <10ms: because peekMessages is warm,
    // it does NOT wait 80ms!
    await act(async () => {
      await receive({
        type: "event", conversationId: "c1", seq: 2, kind: "message.updated", at: 105,
        payload: { id: "bot_1", conversationId: "c1", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: "chunk 2" }], status: "complete", version: 2, createdAt: 100 },
      });
    });
    expect(messagesRead).toHaveBeenCalledTimes(3);
  });

  it("invalidates message cache on refreshConversation, refreshCache, deleteMessages, clearMessagesBatch, and confirmHistoryClear", async () => {
    const { connection, invalidateMessages } = await setupConnection({ withPeek: true });

    connection.refreshConversation("c1");
    expect(invalidateMessages).toHaveBeenLastCalledWith("c1");

    connection.refreshCache();
    expect(invalidateMessages).toHaveBeenLastCalledWith(undefined);

    io.http.mockResolvedValueOnce(new Response(JSON.stringify({ deletedIds: ["m1"] }), { status: 200 }));
    await connection.deleteMessages("c1", ["m1"]);
    expect(invalidateMessages).toHaveBeenLastCalledWith("c1");

    io.http.mockResolvedValueOnce(new Response(JSON.stringify({ throughId: "m2", clearedIds: ["m2"], remaining: 0, seq: 10 }), { status: 200 }));
    await connection.clearMessagesBatch("c1", "m2");
    expect(invalidateMessages).toHaveBeenLastCalledWith("c1");

    await connection.confirmHistoryClear("c1", 10);
    expect(invalidateMessages).toHaveBeenLastCalledWith("c1");
  });
});

describe("send timing probe around the history read gap", () => {
  let root: Root | undefined;
  const botMessage = (seq: number, version: number, extra: Partial<Message> = {}) => ({
    type: "event", conversationId: "c1", seq, kind: version === 1 ? "message.created" : "message.updated", at: 100 + seq,
    payload: { id: "bot_1", conversationId: "c1", authorId: "bot", authorType: "bot", blocks: [{ type: "text", text: `chunk ${version}` }], status: "streaming", version, createdAt: 100, ...extra },
  });
  const userMessage = (seq: number) => ({
    type: "event", conversationId: "c1", seq, kind: "message.created", at: 100 + seq,
    payload: { id: "user_1", conversationId: "c1", authorId: "owner", authorType: "user", clientMsgId: "cm_1", blocks: [{ type: "text", text: "sent while streaming" }], status: "complete", version: 1, createdAt: 120 },
  });
  async function mount(withPeek: boolean) {
    const container = setupDom();
    const setup = await setupConnection({ withPeek });
    function Harness() {
      useConversationMessages(setup.connection, "c1", true, true);
      return null;
    }
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(Harness));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The first read is far enough back that the next one starts without a wait.
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_HISTORY_READ_GAP_MS + 20); });
    await act(async () => { await setup.receive(botMessage(1, 1)); });
    expect(setup.messagesRead).toHaveBeenCalledTimes(2);
    setSendTimingTestHook(true);
    return setup;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    io.notify.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root?.unmount(); });
      root = undefined;
    }
    setSendTimingTestHook(false);
    clearSendTimingRecords();
    delete (globalThis as { __tarobirdSendTiming?: unknown }).__tarobirdSendTiming;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records the time spent in a wait that a user send ends early, not the planned gap", async () => {
    const { messagesRead, receive } = await mount(false);
    beginSendTiming({ conversationId: "c1", kind: "direct", messageLength: 20, clientMsgId: "cm_1" });
    // A Bot update right after a read plans the full gap before the next one.
    await act(async () => { await receive(botMessage(2, 2)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(messagesRead).toHaveBeenCalledTimes(2);
    // The user's own message ends that wait after 10 ms of the planned 80 ms.
    await act(async () => { await receive(userMessage(3)); });
    expect(messagesRead).toHaveBeenCalledTimes(3);
    const record = getSendTimingRecords().at(-1)!;
    expect(record.historyReadDoneAt).toBeDefined();
    expect(record.historyReadGapWaitMs).toBe(10);
  });

  it("records zero when the in-memory copy lets the read skip the wait", async () => {
    const { messagesRead, receive } = await mount(true);
    beginSendTiming({ conversationId: "c1", kind: "direct", messageLength: 20, clientMsgId: "cm_1" });
    await act(async () => { await receive(botMessage(2, 2)); });
    await act(async () => { await receive(userMessage(3)); });
    expect(messagesRead).toHaveBeenCalledTimes(4);
    const record = getSendTimingRecords().at(-1)!;
    expect(record.historyReadDoneAt).toBeDefined();
    expect(record.historyReadGapWaitMs).toBe(0);
  });

  it("records a wait that runs its course in full", async () => {
    const { messagesRead, receive } = await mount(false);
    beginSendTiming({ conversationId: "c1", kind: "direct", messageLength: 20, clientMsgId: "cm_1" });
    // Only a non-urgent event can sit out the whole gap, so the traced message
    // is given to a Bot update here; a user-authored event would end the wait.
    await act(async () => { await receive(botMessage(2, 2, { clientMsgId: "cm_1" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(MIN_HISTORY_READ_GAP_MS - 1); });
    expect(messagesRead).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(messagesRead).toHaveBeenCalledTimes(3);
    expect(getSendTimingRecords().at(-1)!.historyReadGapWaitMs).toBe(MIN_HISTORY_READ_GAP_MS);
  });
});
