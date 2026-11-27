import { describe, expect, it } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import {
  buildMessageRailItems,
  clampPreviewCenter,
  findActiveRailItemId,
  isRailAnchorMessage,
  isRailDense,
  normalizeWheelDeltaY,
  railTickBudget,
  resolveRailScrollAnchor,
  sampleMessageRailItems,
} from "../client/src/message-rail.js";

function msg(overrides: Partial<Message> & { id: string; authorType: Message["authorType"] }): Message {
  return {
    conversationId: "conv_1",
    authorId: overrides.authorType === "user" ? "owner" : "bot_1",
    blocks: [{ type: "text", text: "Hello" }],
    status: "complete",
    version: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("message-rail pure helpers", () => {
  it("builds one rail item per non-deleted user turn with reply previews and excludes internal discussion inputs", () => {
    const messages: Message[] = [
      msg({ id: "u1", authorType: "user", blocks: [{ type: "text", text: "First question\nwith newline" }], createdAt: 1000 }),
      msg({ id: "b1", authorType: "bot", authorId: "bot_a", replyTo: "u1", blocks: [{ type: "text", text: "First reply summary" }], createdAt: 2000 }),
      msg({ id: "u_del", authorType: "user", status: "deleted", blocks: [{ type: "text", text: "Withdrawn" }], createdAt: 3000 }),
      msg({ id: "u_sched", authorType: "user", groupDiscussion: { runId: "r1", role: "input", mode: "sequential", botId: "bot_a" }, blocks: [{ type: "text", text: "Internal turn" }], createdAt: 3500 }),
      msg({ id: "u2", authorType: "user", blocks: [{ type: "image", attachmentId: "att1", title: "diagram.png" }], createdAt: 4000 }),
      msg({ id: "b2", authorType: "bot", authorId: "bot_b", blocks: [{ type: "text", text: "Second reply" }], createdAt: 5000 }),
      msg({
        id: "u3",
        authorType: "user",
        botSource: { hostId: "h1", hostName: "macmini", botId: "b_peer", botName: "Helper", requestId: "req_1", hops: 1 },
        blocks: [{ type: "text", text: "Delegated task" }],
        createdAt: 6000,
      }),
    ];

    expect(isRailAnchorMessage(messages[2]!)).toBe(false);
    expect(isRailAnchorMessage(messages[3]!)).toBe(false);

    const items = buildMessageRailItems(messages, {
      isGroup: true,
      botName: (id) => id === "bot_a" ? "Architect" : id === "bot_b" ? "Reviewer" : id,
    });

    expect(items).toEqual([
      {
        id: "u1",
        index: 0,
        turnNumber: 1,
        prompt: "First question with newline",
        replyPreview: "First reply summary",
        replyAuthor: "Architect",
        createdAt: 1000,
      },
      {
        id: "u2",
        index: 4,
        turnNumber: 2,
        prompt: "diagram.png",
        replyPreview: "Second reply",
        replyAuthor: "Reviewer",
        createdAt: 4000,
      },
      {
        id: "u3",
        index: 6,
        turnNumber: 3,
        prompt: "Delegated task",
        sourceLabel: "macmini · Helper",
        createdAt: 6000,
      },
    ]);
  });

  it("samples long histories evenly while always preserving first, last, and active items", () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      id: `u_${i + 1}`,
      index: i * 2,
      turnNumber: i + 1,
      prompt: `Prompt ${i + 1}`,
      createdAt: 1000 + i * 1000,
    }));

    const sampled = sampleMessageRailItems(items, "u_37", 40);
    expect(sampled.length).toBe(40);
    expect(sampled[0]!.id).toBe("u_1");
    expect(sampled[sampled.length - 1]!.id).toBe("u_120");
    expect(sampled.some((item) => item.id === "u_37")).toBe(true);

    // Strictly ascending indices with no duplicates.
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]!.turnNumber).toBeGreaterThan(sampled[i - 1]!.turnNumber);
    }
  });

  it("tracks active rail item accurately as anchor index moves through replies and tail", () => {
    const items = [
      { id: "u1", index: 0, turnNumber: 1, prompt: "One", createdAt: 1000 },
      { id: "u2", index: 3, turnNumber: 2, prompt: "Two", createdAt: 2000 },
      { id: "u3", index: 6, turnNumber: 3, prompt: "Three", createdAt: 3000 },
    ];

    expect(findActiveRailItemId(items, 0, false)).toBe("u1");
    expect(findActiveRailItemId(items, 2, false)).toBe("u1"); // still inside turn 1's replies
    expect(findActiveRailItemId(items, 3, false)).toBe("u2");
    expect(findActiveRailItemId(items, 5, false)).toBe("u2");
    expect(findActiveRailItemId(items, 0, true)).toBe("u3"); // scrolled to bottom
    expect(findActiveRailItemId([], 0, false)).toBeUndefined();
  });

  it("matches explicit replyTo bot replies without leaking them into follow-up turns", () => {
    const messages: Message[] = [
      msg({ id: "u1", authorType: "user", blocks: [{ type: "text", text: "First prompt" }], createdAt: 1000 }),
      msg({ id: "u2", authorType: "user", blocks: [{ type: "text", text: "Second prompt" }], createdAt: 1000 }),
      msg({ id: "b1", authorType: "bot", authorId: "bot_a", replyTo: "u1", blocks: [{ type: "text", text: "Late reply to first" }], createdAt: 1000 }),
    ];
    const items = buildMessageRailItems(messages, { isGroup: true, botName: () => "Architect" });
    expect(items[0]?.replyPreview).toBe("Late reply to first");
    expect(items[0]?.replyAuthor).toBe("Architect");
    expect(items[1]?.replyPreview).toBeUndefined();
    expect(items[1]?.replyAuthor).toBeUndefined();

    // A second explicit reply to u1 is also skipped, while a subsequent unaddressed bot reply matches u2.
    const withFollowUp = buildMessageRailItems([
      ...messages,
      msg({ id: "b2", authorType: "bot", authorId: "bot_b", replyTo: "u1", blocks: [{ type: "text", text: "Another reply to first" }], createdAt: 2000 }),
      msg({ id: "b3", authorType: "bot", authorId: "bot_b", blocks: [{ type: "text", text: "Unaddressed reply for second" }], createdAt: 3000 }),
    ], { isGroup: true, botName: (id) => id === "bot_a" ? "Architect" : "Reviewer" });
    expect(withFollowUp[0]?.replyPreview).toBe("Late reply to first");
    expect(withFollowUp[1]?.replyPreview).toBe("Unaddressed reply for second");
    expect(withFollowUp[1]?.replyAuthor).toBe("Reviewer");
  });

  it("summarizes image titles, file/audio names, and untitled attachment fallbacks", () => {
    const messages: Message[] = [
      msg({ id: "u1", authorType: "user", blocks: [{ type: "image", attachmentId: "att1", title: "architecture.png" }], createdAt: 1000 }),
      msg({ id: "u2", authorType: "user", blocks: [{ type: "image", attachmentId: "att2" }], createdAt: 2000 }),
      msg({ id: "u3", authorType: "user", blocks: [{ type: "file", attachmentId: "att3", name: "spec.pdf", size: 128, mime: "application/pdf" }], createdAt: 3000 }),
      msg({ id: "u4", authorType: "user", blocks: [{ type: "audio", attachmentId: "att4", name: "voice-note.m4a" }], createdAt: 4000 }),
    ];
    const items = buildMessageRailItems(messages, { attachmentFallback: "附件消息" });
    expect(items.map((item) => item.prompt)).toEqual([
      "architecture.png",
      "附件消息",
      "spec.pdf",
      "voice-note.m4a",
    ]);
  });

  it("computes viewport-safe tick budgets, density, sampling bounds, and preview clamping", () => {
    expect(railTickBudget(712)).toBe(44);
    expect(railTickBudget(240)).toBe(23);
    expect(railTickBudget(40)).toBe(0);

    // 23 ticks in 240px height would overflow normal spacing -> forces dense mode.
    expect(isRailDense(23, 240)).toBe(true);
    expect(isRailDense(10, 712)).toBe(false);
    expect(isRailDense(24, 712)).toBe(true);

    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `u_${i + 1}`,
      index: i * 2,
      turnNumber: i + 1,
      prompt: `Prompt ${i + 1}`,
      createdAt: 1000 + i * 1000,
    }));
    expect(sampleMessageRailItems(many, "u_5", 2).map((item) => item.id)).toEqual(["u_1", "u_10"]);
    expect(sampleMessageRailItems(many, "u_5", 1).map((item) => item.id)).toEqual(["u_5"]);
    expect(sampleMessageRailItems(many, "u_5", 0)).toEqual([]);

    // 125px tall preview (half 62.5px) inside 332px rail stays fully within [4, 328].
    expect(clampPreviewCenter(12, 332, 62.5)).toBe(66.5);
    expect(clampPreviewCenter(320, 332, 62.5)).toBe(265.5);
    expect(clampPreviewCenter(166, 332, 62.5)).toBe(166);
    // Preview taller than rail centers cleanly.
    expect(clampPreviewCenter(10, 100, 62.5)).toBe(50);
  });

  it("normalizes wheel deltas across pixel, line, and page modes", () => {
    expect(normalizeWheelDeltaY(-120, 0, 21, 712)).toBe(-120);
    expect(normalizeWheelDeltaY(-3, 1, 21, 712)).toBe(-63);
    expect(normalizeWheelDeltaY(1, 2, 21, 712)).toBe(712);
    expect(normalizeWheelDeltaY(0, 1, 21, 712)).toBe(0);
  });

  it("resolves rail scroll anchor accurately at top, bottom, short chats, and with header origin", () => {
    const virtualItems = Array.from({ length: 60 }, (_, index) => ({ index, start: index * 130 }));

    // Top of long chat with short early turns always selects index 0 (Turn 1).
    expect(resolveRailScrollAnchor({
      scrollTop: 0,
      scrollHeight: 7960,
      clientHeight: 712,
      shift: 0,
      origin: 20,
      messageCount: 60,
      virtualItems: virtualItems.slice(0, 12),
    })).toEqual({ index: 0, atBottom: false });

    // Bottom of long chat selects last index and atBottom=true.
    expect(resolveRailScrollAnchor({
      scrollTop: 7248,
      scrollHeight: 7960,
      clientHeight: 712,
      shift: 0,
      origin: 20,
      messageCount: 60,
      virtualItems: virtualItems.slice(48),
    })).toEqual({ index: 59, atBottom: true });

    // Non-scrollable short chat reports atBottom=true.
    expect(resolveRailScrollAnchor({
      scrollTop: 0,
      scrollHeight: 712,
      clientHeight: 712,
      shift: 0,
      origin: 20,
      messageCount: 6,
      virtualItems: virtualItems.slice(0, 6),
    })).toEqual({ index: 5, atBottom: true });

    // Large origin offset (e.g. ConversationHistoryOrigin banner) is subtracted from probe.
    expect(resolveRailScrollAnchor({
      scrollTop: 100,
      scrollHeight: 7960,
      clientHeight: 712,
      shift: 0,
      origin: 140,
      messageCount: 60,
      virtualItems: virtualItems.slice(0, 12),
    })).toEqual({ index: 0, atBottom: false });

    // Mid-thread probe matches centered alignment.
    expect(resolveRailScrollAnchor({
      scrollTop: 3500,
      scrollHeight: 7960,
      clientHeight: 712,
      shift: 0,
      origin: 20,
      messageCount: 60,
      virtualItems: virtualItems.slice(24, 36),
    })).toEqual({ index: 29, atBottom: false });
  });
});
