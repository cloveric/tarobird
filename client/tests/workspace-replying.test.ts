import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import type { PromptQueueSnapshot } from "../../src/client-protocol/prompt-queue.js";
import {
  buildReplyingEntries,
  createWorkspaceQueueReader,
  previewWorkspaceMessage,
  scopePromptQueue,
  type PromptQueueItem,
} from "../src/workspace-replying.js";

const userMsg = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId: "conv_1",
  authorId: "owner",
  authorType: "user",
  blocks: text ? [{ type: "text", text }] : [],
  status: "complete",
  version: 1,
  createdAt: 1,
  ...extra,
});

const botStreaming = (id: string, botId: string, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId: "conv_1",
  authorId: botId,
  authorType: "bot",
  blocks: [{ type: "text", text: "Working..." }],
  status: "streaming",
  version: 1,
  createdAt: 10,
  ...extra,
});

const queueItem = (message: Message, state: "queued" | "dispatched"): PromptQueueItem => ({
  message,
  state,
  canEdit: state === "queued",
  canCancel: state === "queued",
  canMove: state === "queued",
});

const snapshot = (conversationId: string, botId: string, items: PromptQueueItem[]): PromptQueueSnapshot => ({
  supported: true,
  revision: `rev_${conversationId}_${botId}_${items.length}`,
  botId,
  conversationId,
  items,
  capabilities: { reorder: true, edit: true, cancel: true, pause: true },
});

const botNames: Record<string, string> = { bot_arch: "Architect", bot_rev: "Reviewer" };
const resolveBotName = (id: string) => botNames[id] ?? id;

afterEach(() => {
  vi.useRealTimers();
});

describe("buildReplyingEntries", () => {
  it("unwraps group discussion scheduler inputs to the user's topic message instead of hardcoded Chinese directives", () => {
    const topic = userMsg("topic_1", "Compare rollout strategies for the EU region", {
      groupDiscussion: { runId: "gd_1", role: "topic", mode: "sequential" },
    });
    const input = userMsg("input_1", "【轮流讨论 · 第 1/2 轮 · 1/2】请 Architect 发言。", {
      replyTo: topic.id,
      groupDiscussion: { runId: "gd_1", role: "input", mode: "sequential", turnId: "gdt_1", botId: "bot_arch", round: 1, maxRounds: 2, position: 0, participants: 2, attempt: 1, blind: false },
    });
    const reply = botStreaming("reply_1", "bot_arch", { replyTo: input.id });

    expect(buildReplyingEntries({
      messages: [topic, input, reply],
      conversationId: "conv_1",
      online: true,
      directBotId: undefined,
      dispatchedItems: [],
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([
      { key: "reply:bot_arch:reply_1", botId: "bot_arch", botName: "Architect", text: "Compare rollout strategies for the EU region", startedAt: 10 },
    ]);
  });

  it("falls back to empty text (localized Replying + Bot name) when a group discussion topic was deleted", () => {
    const deletedTopic = userMsg("topic_1", "", { status: "deleted" });
    const input = userMsg("input_1", "【独立评议 · 独立作答 · 1/2】请 Architect 发言。", {
      replyTo: deletedTopic.id,
      groupDiscussion: { runId: "gd_1", role: "input", mode: "independent", turnId: "gdt_1", botId: "bot_arch", round: 1, maxRounds: 2, position: 0, participants: 2, attempt: 1, blind: true },
    });
    const reply = botStreaming("reply_1", "bot_arch", { replyTo: input.id });

    expect(buildReplyingEntries({
      messages: [deletedTopic, input, reply],
      conversationId: "conv_1",
      online: true,
      directBotId: undefined,
      dispatchedItems: [],
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([
      { key: "reply:bot_arch:reply_1", botId: "bot_arch", botName: "Architect", text: "", startedAt: 10 },
    ]);
    expect(previewWorkspaceMessage(input, "Attachment")).toBe("");
  });

  it("clears all replying entries including dispatchedItems when offline", () => {
    const m1 = userMsg("m1", "First prompt");
    const reply = botStreaming("r1", "bot_arch", { replyTo: m1.id });
    const dispatched = [queueItem(m1, "dispatched")];

    expect(buildReplyingEntries({
      messages: [m1, reply],
      conversationId: "conv_1",
      online: false,
      directBotId: "bot_arch",
      dispatchedItems: dispatched,
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([]);

    // Also cleared when only a dispatched item existed with no streaming message yet.
    expect(buildReplyingEntries({
      messages: [m1],
      conversationId: "conv_1",
      online: false,
      directBotId: "bot_arch",
      dispatchedItems: dispatched,
      streamingBots: [],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([]);
  });

  it("never misattributes a deleted or empty replyTo source to an unrelated dispatchedItems[0] message", () => {
    const m2 = userMsg("m2", "Unrelated second message");
    const replyToDeletedM1 = botStreaming("r1", "bot_arch", { replyTo: "m1_deleted" });

    expect(buildReplyingEntries({
      messages: [m2, replyToDeletedM1],
      conversationId: "conv_1",
      online: true,
      directBotId: "bot_arch",
      dispatchedItems: [queueItem(m2, "dispatched")],
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([
      { key: "reply:bot_arch:r1", botId: "bot_arch", botName: "Architect", text: "", startedAt: 10 },
    ]);

    // When replyTo matches a dispatched item not yet in messages, it resolves that exact item.
    const m1 = userMsg("m1", "Exact matching dispatched prompt");
    expect(buildReplyingEntries({
      messages: [m2, botStreaming("r2", "bot_arch", { replyTo: m1.id })],
      conversationId: "conv_1",
      online: true,
      directBotId: "bot_arch",
      dispatchedItems: [queueItem(m2, "dispatched"), queueItem(m1, "dispatched")],
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([
      { key: "reply:bot_arch:r2", botId: "bot_arch", botName: "Architect", text: "Exact matching dispatched prompt", startedAt: 10 },
    ]);

    // When replyTo is absent, falling back to dispatchedItems[0] is still allowed.
    expect(buildReplyingEntries({
      messages: [m2, botStreaming("r3", "bot_arch")],
      conversationId: "conv_1",
      online: true,
      directBotId: "bot_arch",
      dispatchedItems: [queueItem(m2, "dispatched")],
      streamingBots: ["Architect"],
      resolveBotName,
      attachmentLabel: "Attachment",
    })).toEqual([
      { key: "reply:bot_arch:r3", botId: "bot_arch", botName: "Architect", text: "Unrelated second message", startedAt: 10 },
    ]);
  });
});

describe("scopePromptQueue", () => {
  it("drops snapshots from another conversation, bot, host, or when switching into a group chat", () => {
    const snapA = snapshot("conv_a", "bot_arch", [queueItem(userMsg("m1", "In A", { conversationId: "conv_a" }), "queued")]);
    const state = { scope: "host_1:conv_a:bot_arch", snapshot: snapA };

    expect(scopePromptQueue(state, "host_1:conv_a:bot_arch", "conv_a", "bot_arch")).toBe(snapA);
    expect(scopePromptQueue(state, "host_1:conv_b:bot_rev", "conv_b", "bot_rev")).toBeUndefined();
    expect(scopePromptQueue(state, "host_2:conv_a:bot_arch", "conv_a", "bot_arch")).toBeUndefined();
    expect(scopePromptQueue(state, "", "group_1", undefined)).toBeUndefined();
    expect(scopePromptQueue({ scope: "host_1:conv_b:bot_rev", snapshot: snapA }, "host_1:conv_b:bot_rev", "conv_b", "bot_rev")).toBeUndefined();
  });
});

describe("createWorkspaceQueueReader", () => {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it("serializes slow polls (single in-flight), avoids duplicate fetch on setPolling toggle, and coalesces bursts", async () => {
    vi.useFakeTimers();
    const pending: ((value: string) => void)[] = [];
    const seen: string[] = [];
    const fetch = vi.fn(() => new Promise<string>(resolve => { pending.push(resolve); }));
    const reader = createWorkspaceQueueReader({ fetch, onSnapshot: value => seen.push(value), pollMs: 2000, timeoutMs: 10_000 });

    reader.trigger();
    expect(fetch).toHaveBeenCalledTimes(1);

    // Enabling polling while a read is active or right after does NOT fire an immediate duplicate fetch.
    reader.setPolling(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Resolve first read -> next poll runs 2s later, not immediately.
    pending.shift()!("snap-1");
    await flush();
    expect(seen).toEqual(["snap-1"]);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Multiple trigger() calls while read #2 is in flight coalesce into a single follow-up after #2 finishes.
    reader.trigger();
    reader.trigger();
    expect(fetch).toHaveBeenCalledTimes(2);
    pending.shift()!("snap-2");
    await flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending.shift()!("snap-3");
    await flush();
    expect(seen).toEqual(["snap-1", "snap-2", "snap-3"]);

    // Toggling polling off and on never fires an immediate extra fetch.
    reader.setPolling(false);
    reader.setPolling(true);
    expect(fetch).toHaveBeenCalledTimes(3);

    reader.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts hung requests after timeout, ignores late stale resolutions, and backs off polling", async () => {
    vi.useFakeTimers();
    const pending: ((value: string) => void)[] = [];
    const signals: AbortSignal[] = [];
    const seen: string[] = [];
    const fetch = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<string>(resolve => { pending.push(resolve); });
    });
    const reader = createWorkspaceQueueReader({ fetch, onSnapshot: value => seen.push(value), pollMs: 2000, maxPollMs: 16_000, timeoutMs: 10_000 });

    reader.trigger();
    reader.setPolling(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Hung request times out at 10s, triggering backoff to 4s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    // Resolve fresh request #2, then resolve stale timed-out request #1 late: stale value must be dropped.
    pending[1]!("fresh-2");
    await flush();
    pending[0]!("stale-1");
    await flush();
    expect(seen).toEqual(["fresh-2"]);

    // Dispose drops any subsequent late resolution too.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    reader.dispose();
    expect(signals[2]?.aborted).toBe(true);
    pending[2]!("after-dispose");
    await flush();
    expect(seen).toEqual(["fresh-2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips polling while hidden and resumes immediately on visibility change", async () => {
    vi.useFakeTimers();
    let visible = false;
    const seen: string[] = [];
    let n = 0;
    const fetch = vi.fn(async () => `snap-${++n}`);
    const reader = createWorkspaceQueueReader({
      fetch,
      onSnapshot: value => seen.push(value),
      pollMs: 2000,
      isVisible: () => visible,
    });

    reader.setPolling(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(0);

    visible = true;
    reader.onVisibilityChange();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["snap-1"]);

    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(["snap-1", "snap-2"]);

    reader.dispose();
  });
});
