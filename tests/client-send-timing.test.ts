import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, Message } from "../src/client-protocol/index.js";
import type { GroupDiscussionView } from "../src/client-protocol/group-discussion.js";
import type { HubConnection } from "../client/src/connection.js";
import type { GroupComposerIntent } from "../client/src/group-composer-intent.js";
import { sendGroupComposerMessage, type GroupReplyMode } from "../client/src/group-composer-send.js";
import { sendSteering } from "../client/src/steering-request.js";
import {
  beginSendTiming,
  clearSendTimingRecords,
  getSendTimingRecords,
  hasActiveSendTiming,
  hasPendingBubbleTiming,
  hasPendingComposerTiming,
  isSendTimingEnabled,
  markSendTimingBubbleVisible,
  markSendTimingByClientMsgId,
  markSendTimingComposerCleared,
  markSendTimingHistoryRead,
  markSendTimingOutboxReload,
  markSendTimingSideVisible,
  SEND_TIMING_STORAGE_KEY,
  setSendTimingTestHook,
  type SendTimingDebugApi,
} from "../client/src/send-timing.js";

function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  return store;
}

function makeMessage(overrides: Partial<Message> & Pick<Message, "id" | "conversationId">): Message {
  return {
    authorId: "owner",
    authorType: "user",
    status: "complete",
    version: 1,
    createdAt: Date.now(),
    blocks: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

function makeDiscussionView(options: {
  conversationId: string;
  mode?: "sequential" | "independent";
  revision?: string;
  runId?: string;
  topicMessageId?: string;
  latestNote?: { messageId: string; text: string };
  topic?: string;
}): GroupDiscussionView {
  const mode = options.mode ?? "sequential";
  const revision = options.revision ?? "rev_1";
  return {
    settings: {
      group: {
        id: options.conversationId,
        type: "group",
        title: "Design Review",
        ownerId: "owner",
        botIds: ["bot_a", "bot_b"],
        archived: false,
        createdAt: 1,
      },
      policy: {
        mode,
        botOrder: ["bot_a", "bot_b"],
        maxRounds: 3,
      },
      revision,
    },
    run: {
      id: options.runId ?? "run_1",
      conversationId: options.conversationId,
      revision: "r1",
      mode,
      topic: options.topic ?? "topic",
      status: "running",
      phase: "opinion",
      round: 1,
      maxRounds: 3,
      participants: [
        { botId: "bot_a", name: "Alpha" },
        { botId: "bot_b", name: "Beta" },
      ],
      steps: [],
      createdAt: 1,
      ...(options.topicMessageId ? { topicMessageId: options.topicMessageId } : {}),
      ...(options.latestNote ? { latestNote: options.latestNote } : {}),
    },
  };
}

afterEach(() => {
  setSendTimingTestHook(false);
  clearSendTimingRecords();
  delete (globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming;
  vi.unstubAllGlobals();
});

describe("opt-in send timing probe", () => {
  it("is disabled by default and performs no recording when off", () => {
    installStorage();
    expect(isSendTimingEnabled()).toBe(false);
    const trace = beginSendTiming({
      conversationId: "c_1",
      kind: "direct",
      engine: "claude",
      messageLength: 12,
      historyCount: 5,
      matchText: "hello world",
    });
    expect(trace).toBeUndefined();
    expect(hasActiveSendTiming()).toBe(false);
    expect(hasPendingBubbleTiming("c_1", "main")).toBe(false);
    expect(hasPendingComposerTiming("c_1", "main")).toBe(false);
    expect(getSendTimingRecords()).toHaveLength(0);
    expect((globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming).toBeUndefined();

    const frame: ClientFrame = { v: 1, type: "message.send", conversationId: "c_1", clientMsgId: "cli_1", text: "hello", attachments: [] };
    markSendTimingByClientMsgId(frame, "enqueueDoneAt");
    markSendTimingOutboxReload("c_1", [{ id: "cli_1" }]);
    markSendTimingHistoryRead("c_1", [], 100, 0, 5);
    markSendTimingBubbleVisible("c_1", [], () => true);
    markSendTimingComposerCleared("c_1", "main");
    expect(getSendTimingRecords()).toHaveLength(0);
  });

  it("records full queued send lifecycle when localStorage flag is set", () => {
    installStorage({ [SEND_TIMING_STORAGE_KEY]: "1" });
    expect(isSendTimingEnabled()).toBe(true);

    const trace = beginSendTiming({
      conversationId: "c_queue",
      kind: "direct",
      engine: "codex",
      messageLength: 18,
      historyCount: 300,
      matchText: "check latency",
    });
    expect(trace).toBeDefined();
    expect((globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming?.records).toHaveLength(1);

    trace!.mark("workbenchDoneAt");
    trace!.mark("steeringStateDoneAt");
    trace!.setRoute("queue");
    trace!.setClientMsgId("cli_q1");

    const frame: ClientFrame = { v: 1, type: "message.send", conversationId: "c_queue", clientMsgId: "cli_q1", text: "check latency", attachments: [] };
    markSendTimingByClientMsgId(frame, "historySettledDoneAt");
    markSendTimingByClientMsgId(frame, "enqueueDoneAt");
    markSendTimingOutboxReload("c_queue", [{ id: "cli_q1" }]);
    markSendTimingByClientMsgId(frame, "outboxFlushSentAt");

    const msg = makeMessage({
      id: "msg_q1",
      conversationId: "c_queue",
      clientMsgId: "cli_q1",
      blocks: [{ type: "text", text: "check latency" }],
    });
    const readEnd = performance.now();
    markSendTimingHistoryRead("c_queue", [msg], readEnd, 42, 7.5);
    expect(hasPendingBubbleTiming("c_queue", "main")).toBe(true);
    markSendTimingBubbleVisible("c_queue", [msg], id => id === "msg_q1");
    // Fast bubbleVisibleAt must NOT prune before expectComposerClear() / skipComposerClear().
    expect(hasActiveSendTiming()).toBe(true);
    expect(hasPendingComposerTiming("c_queue", "main")).toBe(false);

    trace!.expectComposerClear();
    expect(hasPendingComposerTiming("c_queue", "main")).toBe(true);
    markSendTimingComposerCleared("c_queue", "main");

    expect(hasActiveSendTiming()).toBe(false);
    const rec = (globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming?.latest();
    expect(rec).toBeDefined();
    expect(rec!.engine).toBe("codex");
    expect(rec!.route).toBe("queue");
    expect(rec!.messageLength).toBe(18);
    expect(rec!.historyCount).toBe(300);
    expect(rec!.workbenchDoneAt).toBeGreaterThanOrEqual(rec!.enterAt);
    expect(rec!.steeringStateDoneAt).toBeGreaterThanOrEqual(rec!.workbenchDoneAt!);
    expect(rec!.historySettledDoneAt).toBeGreaterThanOrEqual(rec!.steeringStateDoneAt!);
    expect(rec!.enqueueDoneAt).toBeGreaterThanOrEqual(rec!.historySettledDoneAt!);
    expect(rec!.outboxReloadDoneAt).toBeGreaterThanOrEqual(rec!.enqueueDoneAt!);
    expect(rec!.outboxFlushSentAt).toBeGreaterThanOrEqual(rec!.outboxReloadDoneAt!);
    expect(rec!.historyReadDoneAt).toBe(readEnd);
    expect(rec!.historyReadGapWaitMs).toBe(42);
    expect(rec!.historyReadCostMs).toBe(7.5);
    expect(rec!.bubbleVisibleAt).toBeGreaterThanOrEqual(rec!.enterAt);
    expect(rec!.composerClearedAt).toBeGreaterThanOrEqual(rec!.bubbleVisibleAt!);
    expect("matchText" in (rec as unknown as Record<string, unknown>)).toBe(false);
  });

  it("clears rejected steering receipt IDs and visibility timestamps on fallback to queue", async () => {
    setSendTimingTestHook(true);

    const trace = beginSendTiming({
      conversationId: "c_fallback",
      kind: "direct",
      engine: "claude",
      messageLength: 12,
      matchText: "steer fallback",
    })!;

    let postedRequestId = "";
    const http = vi.fn(async (_route: string, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return { supported: true, targetId: "turn_1", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } };
      }
      const body = JSON.parse(String(init.body)) as { requestId: string; targetId: string; text: string };
      postedRequestId = body.requestId;
      const rejectedReceipt = makeMessage({
        id: "msg_steer_rej",
        conversationId: "c_fallback",
        clientMsgId: body.requestId,
        blocks: [
          { type: "text", text: body.text },
          { type: "steering", botId: "bot_1", targetId: body.targetId, outcome: "rejected", reason: "idle", mode: "message" },
        ],
      });
      // Simulate rejected steering receipt arriving via WS before POST resolves.
      markSendTimingHistoryRead("c_fallback", [rejectedReceipt], performance.now(), 10, 2);
      markSendTimingBubbleVisible("c_fallback", [rejectedReceipt], id => id === "msg_steer_rej");
      return rejectedReceipt;
    });
    const records = new Map<string, string>();
    const cache = {
      operationRecord: async (key: string) => records.get(key) ?? "",
      updateOperationIfMatches: async (key: string, prev: string, next: string) => {
        if ((records.get(key) ?? "") !== prev) return false;
        records.set(key, next);
        return true;
      },
      clearOperationIfMatches: async (key: string, prev: string) => {
        if (records.get(key) === prev) records.delete(key);
      },
    };
    const connection = { http, cache } as unknown as HubConnection;

    const receipt = await sendSteering(connection, "c_fallback", "bot_1", "steer fallback", () => true, true, false, undefined, undefined, trace);
    expect(receipt?.id).toBe("msg_steer_rej");
    expect(postedRequestId).not.toBe("");

    // Also verify steering-request.ts itself does not stamp rejected receipt.id when WS did not arrive first.
    const traceNoWs = beginSendTiming({ conversationId: "c_fallback_2", kind: "direct", engine: "claude", messageLength: 4 })!;
    const httpNoWs = vi.fn(async (_route: string, init?: RequestInit) => {
      if (init?.method !== "POST") return { supported: true, targetId: "turn_2", sendBehavior: "steer" };
      const body = JSON.parse(String(init.body)) as { requestId: string; targetId: string; text: string };
      return makeMessage({
        id: "msg_steer_rej_2",
        conversationId: "c_fallback_2",
        clientMsgId: body.requestId,
        blocks: [{ type: "text", text: body.text }, { type: "steering", botId: "bot_1", targetId: body.targetId, outcome: "rejected", reason: "idle" }],
      });
    });
    await sendSteering({ http: httpNoWs } as unknown as HubConnection, "c_fallback_2", "bot_1", "test", () => true, true, false, undefined, undefined, traceNoWs);
    expect(getSendTimingRecords()[1]!.messageId).toBeUndefined();
    traceNoWs.fail("done");

    // Simulate App.tsx steer() returning "queue" after SteeringNotDeliveredError.
    trace.resetForFallback();
    const afterReset = getSendTimingRecords()[0]!;
    expect(afterReset.steeringPreflightDoneAt).toBeDefined();
    expect(afterReset.route).toBeUndefined();
    expect(afterReset.clientMsgId).toBeUndefined();
    expect(afterReset.messageId).toBeUndefined();
    expect(afterReset.historyReadDoneAt).toBeUndefined();
    expect(afterReset.historyReadGapWaitMs).toBeUndefined();
    expect(afterReset.historyReadCostMs).toBeUndefined();
    expect(afterReset.bubbleVisibleAt).toBeUndefined();

    // Now fallback sends via durable queue.
    trace.setRoute("queue");
    trace.setClientMsgId("client_q_1");
    const frame: ClientFrame = { v: 1, type: "message.send", conversationId: "c_fallback", clientMsgId: "client_q_1", text: "steer fallback", attachments: [] };
    markSendTimingByClientMsgId(frame, "enqueueDoneAt");
    const queuedMsg = makeMessage({
      id: "msg_queued_1",
      conversationId: "c_fallback",
      clientMsgId: "client_q_1",
      blocks: [{ type: "text", text: "steer fallback" }],
    });
    const rejectedAgain = makeMessage({
      id: "msg_steer_rej",
      conversationId: "c_fallback",
      clientMsgId: postedRequestId,
      blocks: [{ type: "text", text: "steer fallback" }],
    });
    const readEnd = performance.now();
    markSendTimingHistoryRead("c_fallback", [rejectedAgain, queuedMsg], readEnd, 0, 1.5);
    markSendTimingBubbleVisible("c_fallback", [rejectedAgain, queuedMsg], id => id === "msg_queued_1");
    trace.expectComposerClear();
    markSendTimingComposerCleared("c_fallback", "main");

    expect(afterReset.route).toBe("queue");
    expect(afterReset.clientMsgId).toBe("client_q_1");
    expect(afterReset.messageId).toBe("msg_queued_1");
    expect(afterReset.enqueueDoneAt).toBeDefined();
    expect(afterReset.historyReadDoneAt).toBe(readEnd);
    expect(afterReset.bubbleVisibleAt).toBeDefined();
    expect(afterReset.composerClearedAt).toBeDefined();
    expect(hasActiveSendTiming()).toBe(false);
  });

  it("isolates main and side composers and ignores premature draft clears before arming", () => {
    setSendTimingTestHook(true);

    const mainTrace = beginSendTiming({
      conversationId: "c_shared",
      kind: "direct",
      engine: "codex",
      messageLength: 10,
      matchText: "main draft",
    })!;

    // While pending (not armed), neither main nor side composer clears should fire.
    expect(hasPendingComposerTiming("c_shared", "main")).toBe(false);
    expect(hasPendingComposerTiming("c_shared", "side")).toBe(false);
    markSendTimingComposerCleared("c_shared", "main");
    markSendTimingComposerCleared("c_shared", "side");
    expect(getSendTimingRecords()[0]!.composerClearedAt).toBeUndefined();

    // Start a side trace on the SAME parent conversationId.
    const sideTrace = beginSendTiming({
      conversationId: "c_shared",
      kind: "side",
      engine: "side",
      route: "side",
      messageLength: 8,
      matchText: "side ask",
    })!;
    sideTrace.setClientMsgId("side_req_1");

    // Arm side composer clear; main composer clear must NOT affect side, and side clear must NOT affect main.
    sideTrace.expectComposerClear();
    expect(hasPendingComposerTiming("c_shared", "side")).toBe(true);
    expect(hasPendingComposerTiming("c_shared", "main")).toBe(false);
    markSendTimingComposerCleared("c_shared", "main");
    expect(getSendTimingRecords()[1]!.composerClearedAt).toBeUndefined();

    // Arm main composer clear, then clear side composer only -> only side gets composerClearedAt.
    mainTrace.expectComposerClear();
    expect(hasPendingComposerTiming("c_shared", "main")).toBe(true);
    markSendTimingComposerCleared("c_shared", "side");
    expect(getSendTimingRecords()[1]!.composerClearedAt).toBeDefined();
    expect(getSendTimingRecords()[0]!.composerClearedAt).toBeUndefined();

    // Clear main composer -> main gets composerClearedAt.
    markSendTimingComposerCleared("c_shared", "main");
    expect(getSendTimingRecords()[0]!.composerClearedAt).toBeDefined();

    // Complete bubbles on their respective surfaces.
    expect(hasPendingBubbleTiming("c_shared", "main")).toBe(true);
    expect(hasPendingBubbleTiming("c_shared", "side")).toBe(true);
    markSendTimingSideVisible("c_shared", "side ask", "side_req_1");
    expect(hasPendingBubbleTiming("c_shared", "side")).toBe(false);
    expect(hasPendingBubbleTiming("c_shared", "main")).toBe(true);

    mainTrace.setClientMsgId("cli_main_1");
    const mainMsg = makeMessage({ id: "msg_main_1", conversationId: "c_shared", clientMsgId: "cli_main_1" });
    markSendTimingBubbleVisible("c_shared", [mainMsg], id => id === "msg_main_1");
    expect(hasActiveSendTiming()).toBe(false);
  });

  it("tracks group discussion routes, normalized text, attachments, baseline exclusion, and clock skew via sendGroupComposerMessage", async () => {
    setSendTimingTestHook(true);
    const makeConnection = (httpImpl: (route: string, init?: RequestInit) => Promise<unknown>) => {
      const drafts = new Map<string, string>();
      const send = vi.fn(async (frame: ClientFrame) => {
        markSendTimingByClientMsgId(frame, "enqueueDoneAt");
      });
      const http = vi.fn(httpImpl);
      return {
        connection: {
          state: { status: "online", groupReplyGuardAvailable: true, groupDiscussionRecoveryAvailable: true, groupDiscussionComposerAvailable: true },
          cache: {
            draft: vi.fn(async (key: string) => drafts.get(key)),
            saveDraft: vi.fn(async (key: string, value: string) => { drafts.set(key, value); }),
            clearDraftIfMatches: vi.fn(async (key: string, expected: string) => { if (drafts.get(key) === expected) drafts.delete(key); }),
          },
          send,
          http,
        } as unknown as HubConnection,
        send,
        http,
      };
    };

    // (1) Single-bot mention in discussion mode routes through durable queue, not discussion_start.
    const singleBotConn = makeConnection(async () => { throw new Error("unexpected_http"); });
    const singleBotTrace = beginSendTiming({ conversationId: "g_1", kind: "group", engine: "group", messageLength: 4, matchText: "ping", existingMessages: [] })!;
    const singleBotFrame = { v: 1 as const, type: "message.send" as const, conversationId: "g_1", clientMsgId: "client_single_1", text: "ping", attachments: [], mentions: ["bot_a"] };
    const discussionMode: GroupReplyMode = { conversationId: "g_1", mode: "sequential", revision: "rev_1", botOrder: ["bot_a", "bot_b"] };
    const finishSingle = await sendGroupComposerMessage(singleBotConn.connection, singleBotFrame, discussionMode, new AbortController().signal, undefined, undefined, undefined, undefined, singleBotTrace);
    expect(finishSingle).toBeUndefined();
    expect(singleBotConn.send).toHaveBeenCalledTimes(1);
    const singleRec = getSendTimingRecords().at(-1)!;
    expect(singleRec.route).toBe("queue");
    expect(singleRec.clientMsgId).toBe("client_single_1");
    expect(singleRec.enqueueDoneAt).toBeDefined();
    singleBotTrace.fail("done");

    // (2) Paused discussion with discussionAction === "new" routes as discussion_start,
    //     normalizes padded text, matches WS gdtopic_ with attachments before POST resolves, and binds topicMessageId.
    let wsTopicArrived = false;
    const startConn = makeConnection(async () => {
      const wsTopic = makeMessage({
        id: "msg_topic_new",
        conversationId: "g_2",
        clientMsgId: "gdtopic_run2",
        createdAt: Date.now() - 60_000, // Client clock 60s ahead of Hub
        blocks: [{ type: "text", text: "trimmed topic" }, { type: "file", attachmentId: "att_1", name: "spec.pdf", size: 12, mime: "application/pdf" }],
      });
      markSendTimingHistoryRead("g_2", [wsTopic], performance.now(), 0, 2);
      markSendTimingBubbleVisible("g_2", [wsTopic], id => id === "msg_topic_new");
      wsTopicArrived = true;
      return makeDiscussionView({ conversationId: "g_2", runId: "run_2", topicMessageId: "msg_topic_new", topic: "trimmed topic" });
    });
    const pausedMode: GroupReplyMode = {
      conversationId: "g_2",
      mode: "sequential",
      revision: "rev_1",
      botOrder: ["bot_a", "bot_b"],
      activeRun: { id: "run_old", conversationId: "g_2", status: "paused", revision: "r1" },
    };
    const newTopicIntent: GroupComposerIntent = { id: "intent_1", empty: false, discussionAction: "new" };
    const startTrace = beginSendTiming({ conversationId: "g_2", kind: "group", engine: "group", messageLength: 17, matchText: "  trimmed topic  ", existingMessages: [] })!;
    const startFrame = { v: 1 as const, type: "message.send" as const, conversationId: "g_2", clientMsgId: "unused_client_id", text: "  trimmed topic  ", attachments: ["att_1"] };
    await sendGroupComposerMessage(startConn.connection, startFrame, pausedMode, new AbortController().signal, undefined, undefined, newTopicIntent, undefined, startTrace);
    expect(wsTopicArrived).toBe(true);
    startTrace.expectComposerClear();
    markSendTimingComposerCleared("g_2", "main");
    const startRec = getSendTimingRecords().at(-1)!;
    expect(startRec.route).toBe("discussion_start");
    expect(startRec.messageId).toBe("msg_topic_new");
    expect(startRec.clientMsgId).toBe("gdtopic_run2");
    expect(startRec.outboxFlushSentAt).toBeDefined();
    expect(startRec.historyReadDoneAt).toBeDefined();
    expect(startRec.bubbleVisibleAt).toBeDefined();

    // (3) Attachment-only discussion start matches localized fallback caption + file block and binds topicMessageId.
    const attStartConn = makeConnection(async (_route, init) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      const topicMsg = makeMessage({
        id: "msg_topic_att",
        conversationId: "g_att",
        clientMsgId: "gdtopic_att",
        blocks: [{ type: "text", text: body.text }, { type: "file", attachmentId: "att_2", name: "chart.png", size: 42, mime: "image/png" }],
      });
      markSendTimingHistoryRead("g_att", [topicMsg], performance.now(), 0, 1);
      markSendTimingBubbleVisible("g_att", [topicMsg], id => id === "msg_topic_att");
      return makeDiscussionView({ conversationId: "g_att", runId: "run_att", topicMessageId: "msg_topic_att", topic: body.text });
    });
    const attStartTrace = beginSendTiming({ conversationId: "g_att", kind: "group", engine: "group", messageLength: 0, matchText: "", existingMessages: [] })!;
    const attStartFrame = { v: 1 as const, type: "message.send" as const, conversationId: "g_att", clientMsgId: "unused_att", text: "", attachments: ["att_2"] };
    await sendGroupComposerMessage(attStartConn.connection, attStartFrame, { conversationId: "g_att", mode: "sequential", revision: "rev_1", botOrder: ["bot_a", "bot_b"] }, new AbortController().signal, undefined, undefined, undefined, undefined, attStartTrace);
    const attStartRec = getSendTimingRecords().at(-1)!;
    expect(attStartRec.route).toBe("discussion_start");
    expect(attStartRec.messageId).toBe("msg_topic_att");
    expect(attStartRec.clientMsgId).toBe("gdtopic_att");
    expect(attStartRec.bubbleVisibleAt).toBeDefined();

    // (4) Discussion note excludes existing older note with identical text, tolerates clock skew, and binds latestNote.messageId.
    const existingNote = makeMessage({
      id: "msg_note_old",
      conversationId: "g_note",
      clientMsgId: "gdnote_old",
      createdAt: Date.now() - 500,
      blocks: [{ type: "text", text: "same note" }],
    });
    const noteTrace = beginSendTiming({
      conversationId: "g_note",
      kind: "group",
      engine: "group",
      messageLength: 9,
      matchText: "same note",
      existingMessages: [existingNote],
    })!;
    // Pre-POST streaming update arrives with an additional older note also having the same text.
    const prePostNote = makeMessage({
      id: "msg_note_prepost",
      conversationId: "g_note",
      clientMsgId: "gdnote_prepost",
      createdAt: Date.now(),
      blocks: [{ type: "text", text: "same note" }],
    });
    markSendTimingHistoryRead("g_note", [existingNote, prePostNote], performance.now(), 0, 1);
    expect(getSendTimingRecords().at(-1)!.historyReadDoneAt).toBeUndefined();

    const noteConn = makeConnection(async () => {
      // While POST is in flight, history read containing existing older notes must NOT false-match.
      markSendTimingHistoryRead("g_note", [existingNote, prePostNote], performance.now(), 0, 1);
      expect(getSendTimingRecords().at(-1)!.historyReadDoneAt).toBeUndefined();
      return makeDiscussionView({
        conversationId: "g_note",
        runId: "run_note",
        latestNote: { messageId: "msg_note_new", text: "same note" },
      });
    });
    const runningMode: GroupReplyMode = {
      conversationId: "g_note",
      mode: "sequential",
      revision: "rev_1",
      botOrder: ["bot_a", "bot_b"],
      activeRun: { id: "run_note", conversationId: "g_note", status: "running", revision: "r1" },
    };
    const noteFrame = { v: 1 as const, type: "message.send" as const, conversationId: "g_note", clientMsgId: "unused_note_id", text: "same note", attachments: [] };
    await sendGroupComposerMessage(noteConn.connection, noteFrame, runningMode, new AbortController().signal, undefined, undefined, undefined, undefined, noteTrace);

    const newNoteMsg = makeMessage({
      id: "msg_note_new",
      conversationId: "g_note",
      clientMsgId: "gdnote_new",
      createdAt: Date.now() - 120_000, // Client clock 2 minutes ahead of Hub
      blocks: [{ type: "text", text: "same note" }],
    });
    markSendTimingHistoryRead("g_note", [existingNote, prePostNote, newNoteMsg], performance.now(), 0, 2);
    markSendTimingBubbleVisible("g_note", [existingNote, prePostNote, newNoteMsg], id => id === "msg_note_new");
    noteTrace.expectComposerClear();
    markSendTimingComposerCleared("g_note", "main");
    const noteRec = getSendTimingRecords().at(-1)!;
    expect(noteRec.route).toBe("discussion_note");
    expect(noteRec.messageId).toBe("msg_note_new");
    expect(noteRec.clientMsgId).toBe("gdnote_new");
    expect(noteRec.historyReadDoneAt).toBeDefined();
    expect(noteRec.bubbleVisibleAt).toBeDefined();

    // (5) Attachment-only discussion note matches via attachment block and binds latestNote.messageId.
    const attNoteTrace = beginSendTiming({
      conversationId: "g_note_att",
      kind: "group",
      engine: "group",
      messageLength: 0,
      matchText: "",
      existingMessages: [],
    })!;
    const attNoteConn = makeConnection(async () => {
      const wsAttNote = makeMessage({
        id: "msg_note_att_1",
        conversationId: "g_note_att",
        clientMsgId: "gdnote_att_1",
        blocks: [{ type: "file", attachmentId: "att_3", name: "notes.txt", size: 8, mime: "text/plain" }],
      });
      markSendTimingHistoryRead("g_note_att", [wsAttNote], performance.now(), 0, 1);
      markSendTimingBubbleVisible("g_note_att", [wsAttNote], id => id === "msg_note_att_1");
      return makeDiscussionView({
        conversationId: "g_note_att",
        runId: "run_note_att",
        latestNote: { messageId: "msg_note_att_1", text: "" },
      });
    });
    const attNoteMode: GroupReplyMode = {
      conversationId: "g_note_att",
      mode: "sequential",
      revision: "rev_1",
      botOrder: ["bot_a", "bot_b"],
      activeRun: { id: "run_note_att", conversationId: "g_note_att", status: "running", revision: "r1" },
    };
    const attNoteFrame = { v: 1 as const, type: "message.send" as const, conversationId: "g_note_att", clientMsgId: "unused_att_note", text: "", attachments: ["att_3"] };
    await sendGroupComposerMessage(attNoteConn.connection, attNoteFrame, attNoteMode, new AbortController().signal, undefined, undefined, undefined, undefined, attNoteTrace);
    const attNoteRec = getSendTimingRecords().at(-1)!;
    expect(attNoteRec.route).toBe("discussion_note");
    expect(attNoteRec.messageId).toBe("msg_note_att_1");
    expect(attNoteRec.clientMsgId).toBe("gdnote_att_1");
    expect(attNoteRec.bubbleVisibleAt).toBeDefined();
    expect(hasActiveSendTiming()).toBe(false);
  });

  it("tracks side attachment-only sends, ignores retried duplicate exchanges, and handles edited side drafts", () => {
    setSendTimingTestHook(true);

    // Attachment-only side send (text === "", messageLength === 0)
    const attSide = beginSendTiming({
      conversationId: "c_side",
      kind: "side",
      engine: "side",
      route: "side",
      messageLength: 0,
      matchText: "",
    })!;
    attSide.setClientMsgId("side_att_1");
    attSide.mark("outboxFlushSentAt");
    attSide.skipComposerClear();
    markSendTimingSideVisible("c_side", "", "side_att_1");
    expect(hasActiveSendTiming()).toBe(false);
    expect(getSendTimingRecords()[0]!.bubbleVisibleAt).toBeDefined();
    expect(getSendTimingRecords()[0]!.composerClearedAt).toBeUndefined();

    // Retried/repeated question: previous exchange ex_1 must NOT false-match either before or after setClientMsgId("ex_2").
    const retrySide = beginSendTiming({
      conversationId: "c_side",
      kind: "side",
      engine: "side",
      route: "side",
      messageLength: 10,
      matchText: "same query",
    })!;
    // Poll arrives during upload (before setClientMsgId): must NOT match ex_1.
    markSendTimingSideVisible("c_side", "same query", "ex_1");
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeUndefined();

    retrySide.setClientMsgId("ex_2");
    // Poll arrives during POST: must NOT match ex_1.
    markSendTimingSideVisible("c_side", "same query", "ex_1");
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeUndefined();

    // New exchange ex_2 renders; user edited draft during POST so skipComposerClear() is called.
    retrySide.skipComposerClear();
    markSendTimingSideVisible("c_side", "same query", "ex_2");
    expect(hasActiveSendTiming()).toBe(false);
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeDefined();
    expect(getSendTimingRecords()[1]!.composerClearedAt).toBeUndefined();
  });

  it("keeps bubble trace pending until follow-up virtualizer render mounts the row and retires failed traces", () => {
    setSendTimingTestHook(true);
    const failed = beginSendTiming({ conversationId: "c_virt", kind: "direct", engine: "pi", messageLength: 4 })!;
    failed.fail(new Error("offline"));
    failed.fail("conversation_changed");
    expect(hasActiveSendTiming()).toBe(false);
    // The first failure wins, and an error is recorded by class name only.
    expect(getSendTimingRecords()[0]!.error).toBe("Error");

    const virt = beginSendTiming({ conversationId: "c_virt", kind: "direct", engine: "codex", messageLength: 6 })!;
    virt.setRoute("queue");
    virt.setClientMsgId("cli_virt_1");
    const msg = makeMessage({ id: "msg_virt_1", conversationId: "c_virt", clientMsgId: "cli_virt_1" });

    // Initial render while scrolled up: row is not mounted in virtualizer DOM yet.
    markSendTimingBubbleVisible("c_virt", [msg], () => false);
    expect(hasPendingBubbleTiming("c_virt", "main")).toBe(true);
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeUndefined();

    // Composer clears while row is still off-screen.
    virt.expectComposerClear();
    markSendTimingComposerCleared("c_virt", "main");
    expect(getSendTimingRecords()[1]!.composerClearedAt).toBeDefined();
    expect(hasPendingBubbleTiming("c_virt", "main")).toBe(true);

    // Follow-up virtualizer scroll render mounts the row.
    markSendTimingBubbleVisible("c_virt", [msg], id => id === "msg_virt_1");
    expect(hasPendingBubbleTiming("c_virt", "main")).toBe(false);
    expect(hasActiveSendTiming()).toBe(false);
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeDefined();
  });

  it("keeps a fixed code for a failed send and never the text of its error", () => {
    setSendTimingTestHook(true);
    const typedMention = "秘密项目代号";
    const typedFileName = "private-salary-review-2026.pdf";
    const fail = (reason: unknown) => {
      const trace = beginSendTiming({ conversationId: "c_fail", kind: "group", engine: "group", messageLength: 24, matchText: `@${typedMention} hello` })!;
      trace.fail(reason);
      return getSendTimingRecords().at(-1)!.error;
    };

    // The two error texts that quote the user: an unresolved @name of a group
    // draft, and the name of an attachment over the size limit.
    expect(fail(new Error(`无法识别提及：@${typedMention}。请从 @ 候选中选择具体的 Bot。`))).toBe("Error");
    expect(fail(new Error(`${typedFileName} 超过单个附件上限 20 MiB，请选择较小文件或调整 Hub 设置。`))).toBe("Error");
    // The same text given as a plain string is not a listed code either.
    expect(fail(`${typedFileName} 超过单个附件上限 20 MiB，请选择较小文件或调整 Hub 设置。`)).toBe("failed");
    expect(fail(typedMention)).toBe("failed");
    expect(fail("toString")).toBe("failed");

    // An error keeps its class name; a name that is not a plain identifier does not pass.
    class SteeringNotDeliveredError extends Error { override name = "SteeringNotDeliveredError"; }
    expect(fail(new SteeringNotDeliveredError(`@${typedMention}`))).toBe("SteeringNotDeliveredError");
    expect(fail(new DOMException(typedFileName, "AbortError"))).toBe("AbortError");
    expect(fail(Object.assign(new Error("x"), { name: `@${typedMention} ${typedFileName}` }))).toBe("Error");

    // Codes chosen at a call site, and the Host's side-conversation codes, are kept as given.
    for (const code of ["aborted", "conversation_changed", "local_command", "stale_generation", "file_rejected", "busy", "attachment_too_large"]) {
      expect(fail(code)).toBe(code);
    }
    expect(fail(undefined)).toBe("aborted");
    expect(fail({ message: typedMention })).toBe("aborted");

    // Nothing reachable from the window object carries the typed text.
    const api = (globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming!;
    const exposed = JSON.stringify({ records: api.records, latest: api.latest() });
    expect(api.records).toHaveLength(17);
    expect(exposed).not.toContain(typedMention);
    expect(exposed).not.toContain(typedFileName);
    expect(exposed).not.toContain("超过单个附件上限");
  });
});
