import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CoreGoalRunController } from "../src/core/bus.js";
import { createCoreRunCardController, handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreStreamControllerLike } from "../src/core/types.js";
import { managedCardPort, messageResourcePort } from "./helpers/core-compat-channel.js";

describe("core audit 3 fixes", () => {
  // ── Fix 2: /goal pursuits are never steered into ───────────────────────────

  it("never steers an ordinary message into a live /goal pursuit — it runs as its own turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-goal-steer-"));
    const runtime = createCoreServiceRuntime();
    // A pursuit holds the conversation's activeRuns slot for its whole life.
    runtime.activeRuns.set("lark:oc_chat", {
      abortController: new CoreGoalRunController(),
      goalWatch: true,
      startedAt: Date.now(),
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal_steer", content: "顺便帮我看下天气" }),
      });

      // Injecting this into the pursuit would derail the objective and the user
      // would only ever see an OK reaction.
      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(channel.addReaction).not.toHaveBeenCalledWith("om_goal_steer", "OK");
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("steers into the turn ATTACHED to a pursuit, aged by that turn's own startedAt", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-goal-attached-"));
    const runtime = createCoreServiceRuntime();
    const goalController = new CoreGoalRunController();
    // The pursuit itself started 10 minutes ago — far outside the 30s steer
    // window. Using ITS startedAt (the old behaviour) killed steering for the
    // whole conversation for the pursuit's entire life.
    runtime.activeRuns.set("lark:oc_chat", {
      abortController: goalController,
      goalWatch: true,
      startedAt: Date.now() - 600_000,
    });
    // …but the turn the engine is actually running right now is 3s old.
    goalController.attachConcurrentTurn({
      abortController: new AbortController(),
      startedAt: Date.now() - 3_000,
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal_attached", content: "再补一句" }),
      });

      expect(bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not steer into an attached turn that is itself past the steer window", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-goal-attached-old-"));
    const runtime = createCoreServiceRuntime();
    const goalController = new CoreGoalRunController();
    // Pursuit "fresh", attached turn old: the window must follow the ATTACHED turn.
    runtime.activeRuns.set("lark:oc_chat", {
      abortController: goalController,
      goalWatch: true,
      startedAt: Date.now(),
    });
    goalController.attachConcurrentTurn({
      abortController: new AbortController(),
      startedAt: Date.now() - 120_000,
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      steerActiveTurn: vi.fn(async () => true),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal_attached_old", content: "换个方向" }),
      });

      expect(bridge.steerActiveTurn).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // ── Fix 3: a merged burst carries ONE <lark_context> envelope ──────────────

  it("merges a 3-image burst + caption into ONE envelope with no #N headers over metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-merge-"));
    const channel = imageChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; files: string[] }) => ({ text: "ok" })),
    };
    const runtime = createCoreServiceRuntime();
    const send = (overrides: Parameters<typeof fakeLarkMessage>[0]) =>
      handleCoreMessage({ channel, bridge, runtime, stateDir, message: fakeLarkMessage(overrides) });

    try {
      await Promise.all([
        send({ messageId: "om_i1", content: "", rawContentType: "image", resources: [{ type: "image", fileKey: "k1" }] }),
        send({ messageId: "om_i2", content: "", rawContentType: "image", resources: [{ type: "image", fileKey: "k2" }] }),
        send({ messageId: "om_i3", content: "", rawContentType: "image", resources: [{ type: "image", fileKey: "k3" }] }),
        send({ messageId: "om_cap", content: "这三张图有什么区别", rawContentType: "text" }),
      ]);

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const merged = bridge.handleAuthorizedMessage.mock.calls[0]![0]!.text;
      // Exactly ONE envelope. Merging the RAW normalized texts produced three,
      // each with a different message_id, and extractLarkMessageBody (which
      // slices at the FIRST </lark_context>) then handed the crew/archive
      // matchers a body made of the other members' metadata.
      expect(merged.match(/<lark_context>/g) ?? []).toHaveLength(1);
      expect(merged.match(/<\/lark_context>/g) ?? []).toHaveLength(1);
      // Only ONE member carries real text, so nothing gets numbered.
      expect(merged).not.toContain("#1");
      expect(merged).not.toContain("#2");
      expect(merged).not.toContain("#3");
      // The caption survives, and so does every image reference — exactly once.
      expect(merged).toContain("这三张图有什么区别");
      for (const key of ["k1", "k2", "k3"]) {
        expect(merged.match(new RegExp(`\\[image:${key}\\]`, "g")) ?? []).toHaveLength(1);
      }
      // The envelope kept is the NEWEST member's — the id the merged turn owns.
      expect(merged).toContain("message_id: om_cap");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("still numbers a burst when two members carry real text", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-merge-two-"));
    const channel = imageChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: { text: string; files: string[] }) => ({ text: "ok" })),
    };
    const runtime = createCoreServiceRuntime();
    const send = (overrides: Parameters<typeof fakeLarkMessage>[0]) =>
      handleCoreMessage({ channel, bridge, runtime, stateDir, message: fakeLarkMessage(overrides) });

    try {
      await Promise.all([
        send({ messageId: "om_t1", content: "看这张图", rawContentType: "image", resources: [{ type: "image", fileKey: "k1" }] }),
        send({ messageId: "om_t2", content: "顺便算下尺寸", rawContentType: "text" }),
      ]);

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const merged = bridge.handleAuthorizedMessage.mock.calls[0]![0]!.text;
      expect(merged.match(/<lark_context>/g) ?? []).toHaveLength(1);
      expect(merged).toContain("#1\n看这张图");
      expect(merged).toContain("#2\n顺便算下尺寸");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  // ── Fix 4: a pending burst is visible to /stop and keeps FIFO for /q ────────

  it("/stop cancels a pending attachment burst instead of reporting 'nothing running'", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-stop-burst-"));
    const channel = imageChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
    };
    // A long burst window so the /stop lands well inside it, deterministically.
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3_000 } });

    try {
      const burst = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_burst", content: "", rawContentType: "image", resources: [{ type: "image", fileKey: "k1" }] }),
      });
      await vi.waitFor(() => {
        expect(runtime.pendingBatches.size).toBe(1);
      });

      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop", content: "/stop" }),
      });

      // The parked burst is dropped, its waiter resolved (no hang) and it never runs.
      expect(runtime.pendingBatches.size).toBe(0);
      await expect(burst).resolves.toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      // …and /stop says so instead of "当前没有正在运行的任务。".
      const texts = (channel.send.mock.calls as unknown[][])
        .map((call) => (call[1] as { text?: string }).text)
        .filter((text): text is string => typeof text === "string");
      expect(texts.some((text) => text.includes("待发送消息"))).toBe(true);
      expect(texts.some((text) => text.includes("当前没有正在运行的任务"))).toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("/q flushes a pending attachment burst first so send order (FIFO) holds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-q-fifo-"));
    const channel = imageChannel();
    const turnTexts: string[] = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        turnTexts.push(input.text);
        return { text: "ok" };
      }),
    };
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3_000 } });

    try {
      const burst = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fifo_img", content: "先看这张图", rawContentType: "image", resources: [{ type: "image", fileKey: "k1" }] }),
      });
      await vi.waitFor(() => {
        expect(runtime.pendingBatches.size).toBe(1);
      });

      // /q never joins a burst; before the fix it queued AHEAD of the images the
      // user had already sent.
      const queued = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fifo_q", content: "/q 然后回答这个问题" }),
      });

      await Promise.all([burst, queued]);
      expect(turnTexts).toHaveLength(2);
      expect(turnTexts[0]).toContain("先看这张图");
      expect(turnTexts[1]).toContain("然后回答这个问题");
      expect(turnTexts[1]).not.toContain("先看这张图");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps a flushed burst queue card bound to the burst task instead of /q", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-q-card-owner-"));
    const channel = imageChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
    };
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3_000 } });
    let releaseBlocker!: () => void;

    try {
      const blocker = runtime.chatQueue.enqueue("lark:oc_chat", async () => {
        await new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
      });
      await vi.waitFor(() => expect(releaseBlocker).toBeTypeOf("function"));

      const originalEnqueue = runtime.chatQueue.enqueue.bind(runtime.chatQueue);
      vi.spyOn(runtime.chatQueue, "enqueue").mockImplementation((chatId, job, options = {}) => {
        return originalEnqueue(chatId, job, { ...options, waitNotifyAfterMs: 0 });
      });

      const burst = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_wait_img",
          content: "先看图",
          rawContentType: "image",
          resources: [{ type: "image", fileKey: "k1" }],
        }),
      });
      await vi.waitFor(() => expect(runtime.pendingBatches.size).toBe(1));

      const queued = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_wait_q", content: "/q 再回答" }),
      });

      await vi.waitFor(() => {
        const cards = channel.send.mock.calls.map((call) => JSON.stringify(call[1]));
        expect(cards.some((card) => card.includes('"taskId":"om_wait_img"'))).toBe(true);
        expect(cards.some((card) => card.includes('"taskId":"om_wait_q"'))).toBe(true);
      });

      releaseBlocker();
      await Promise.all([blocker, burst, queued]);
    } finally {
      releaseBlocker?.();
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("a quoted reply flushes a pending attachment burst first so send order (FIFO) holds", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-a3-quote-fifo-"));
    const channel = imageChannel({
      fetchMessage: vi.fn(async () => ({
        messageId: "om_quoted",
        messageType: "text",
        content: JSON.stringify({ text: "被引用的内容" }),
      })),
    });
    const turnTexts: string[] = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        turnTexts.push(input.text);
        return { text: "ok" };
      }),
    };
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 3_000 } });

    try {
      const burst = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_q_img", content: "先看这张图", rawContentType: "image", resources: [{ type: "image", fileKey: "k1" }] }),
      });
      await vi.waitFor(() => {
        expect(runtime.pendingBatches.size).toBe(1);
      });

      const quoted = handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_q_reply", content: "这段什么意思", replyToMessageId: "om_quoted" }),
      });

      await Promise.all([burst, quoted]);
      expect(turnTexts).toHaveLength(2);
      expect(turnTexts[0]).toContain("先看这张图");
      expect(turnTexts[1]).toContain("这段什么意思");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 20_000);

  // ── Fix 5: no card patch lands after the card was finalized ────────────────

  it("stops updating the run card once it is finalized (no late throttled patch)", async () => {
    const cards = managedCardPort({ cardId: "card_terminal" });
    const cardUpdate = cards.update;
    const elementContent = cards.updateElement;
    const channel = {
      send: vi.fn(async () => ({ messageId: "sent_1" })),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      managedCards: cards.port,
    };

    const controller = await createCoreRunCardController({
      channel: channel as never,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_run",
      locale: "zh",
    });
    expect(controller).toBeTruthy();

    // Stream enough to arm the element-stream / full-update machinery.
    await controller!.apply({ type: "assistant_text", text: "第一段" });
    await controller!.apply({ type: "assistant_text", text: "第二段" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await controller!.apply({ type: "assistant_text", text: "第三段" });

    await controller!.finish("最终答案");
    const callsAfterFinish = cardUpdate.mock.calls.length + elementContent.mock.calls.length;

    // Late engine events (and the ticks they used to schedule) must not revive
    // the card: the old code armed a fresh 400ms full-card timer that
    // cancelScheduledUpdate could no longer reach, so a stale "running" patch
    // landed after the finished one.
    await controller!.apply({ type: "assistant_text", text: "迟到的增量" });
    await controller!.apply({ type: "tool_use", toolName: "Read", toolInput: {}, toolUseId: "tu_late" });
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(cardUpdate.mock.calls.length + elementContent.mock.calls.length).toBe(callsAfterFinish);
    // The last thing the card ever showed is the finished answer.
    expect(JSON.stringify(cardUpdate.mock.calls[cardUpdate.mock.calls.length - 1])).toContain("最终答案");
    expect(JSON.stringify(cardUpdate.mock.calls)).not.toContain("迟到的增量");
  }, 20_000);
});

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  content: string;
  rawContentType: string;
  replyToMessageId: string;
  resources: Array<{ type: string; fileKey: string; fileName?: string }>;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: overrides.senderId ?? "ou_user",
    ...(overrides.replyToMessageId ? { replyToMessageId: overrides.replyToMessageId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: overrides.rawContentType ?? "text",
    resources: overrides.resources ?? [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
}

function fakeChannel(overrides: Record<string, unknown> = {}) {
  return {
    send: vi.fn(async (_to: string, _payload: unknown, _options?: unknown) => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: { initial: object; producer: (controller: CoreStreamControllerLike) => Promise<void> };
    }) => {
      await input.card.producer({ messageId: "stream_1", current: input.card.initial, update: async () => undefined });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async (_messageId: string, _card?: unknown) => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
    addReaction: vi.fn(async (_messageId: string, _emojiType: string) => "reaction-1"),
    uploadImage: vi.fn(async (_body: Buffer) => "img_key_fake"),
    ...overrides,
  };
}

/** A channel whose explicit resource port serves image downloads (burst tests). */
function imageChannel(overrides: Record<string, unknown> = {}) {
  return fakeChannel({
    downloadMessageResource: messageResourcePort("img-bytes"),
    ...overrides,
  });
}
