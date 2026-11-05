import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { handleCoreCardAction } from "../src/core/card-actions.js";
import { renderCoreApprovalCard } from "../src/core/card-renderer.js";
import { deliverCoreResponse } from "../src/core/delivery.js";
import {
  classifyCoreTurnTermination,
  createCoreRunCardController,
  handleCoreMessage,
} from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreStreamControllerLike } from "../src/core/types.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

describe("core audit fixes", () => {
  it("renders Codex file citations without exposing local paths or uploading the source", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-codex-citation-"));
    const channel = fakeChannel();
    const citation = ':codex-file-citation{path="/Users/example/.cctb/bot/workspace/report.xlsx" purpose="source" artifact_kind="workbook" sheet="PE_Comps" range="A4:F25"}';

    try {
      await deliverCoreResponse({
        channel,
        runtime: createCoreServiceRuntime(),
        chatId: "oc_chat",
        text: `依据：${citation}`,
        stateDir,
      });

      const delivered = JSON.stringify(channel.send.mock.calls);
      expect(delivered).toContain("来源");
      expect(delivered).toContain("report.xlsx");
      expect(delivered).toContain("PE_Comps!A4:F25");
      expect(delivered).not.toContain(":codex-file-citation");
      expect(delivered).not.toContain("/Users/example");
      expect(delivered).not.toContain('"file"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 1: one rejected delivery tag must not suppress the whole answer text.
  it("still delivers the answer text alongside the rejection notice when a send-file tag is rejected", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-rejected-tag-"));
    const channel = fakeChannel();

    try {
      await deliverCoreResponse({
        channel,
        runtime: createCoreServiceRuntime(),
        chatId: "oc_chat",
        text: "这是答案正文。\n[send-file:/definitely/not/a/real/file.txt]",
        stateDir,
      });

      const payloads = channel.send.mock.calls.map((call) => call[1] as Record<string, unknown>);
      // The rejection notice is still sent…
      expect(payloads.some((payload) => JSON.stringify(payload).includes("文件未发送"))).toBe(true);
      // …and the cleaned answer text is delivered in addition, not suppressed.
      expect(payloads.some((payload) =>
        typeof payload.markdown === "string" && payload.markdown.includes("这是答案正文"))).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces a transient markdown chunk failure without blindly duplicating it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-markdown-retry-"));
    const sentMarkdown: string[] = [];
    const sentText: string[] = [];
    let sendCalls = 0;
    const channel = fakeChannel({
      send: vi.fn(async (_to: string, input: unknown) => {
        const payload = input as { markdown?: string; text?: string };
        sendCalls++;
        if (sendCalls === 2) {
          throw new Error("temporary send failure");
        }
        if (typeof payload.markdown === "string") {
          sentMarkdown.push(payload.markdown);
        }
        if (typeof payload.text === "string") {
          sentText.push(payload.text);
        }
        return { messageId: `sent_${sendCalls}` };
      }),
    });
    const chunks = [
      "A".repeat(3400),
      "B".repeat(3400),
      "C".repeat(3400),
    ];
    const text = chunks.join("\n\n");

    try {
      await deliverCoreResponse({
        channel,
        runtime: createCoreServiceRuntime(),
        chatId: "oc_chat",
        text,
        stateDir,
      });

      expect(channel.send).toHaveBeenCalledTimes(4);
      expect(sentMarkdown.join("")).toContain(chunks[0]);
      expect(sentMarkdown.join("")).toContain("C".repeat(1000));
      expect(sentMarkdown.join("")).not.toContain(chunks[1]);
      expect(sentText.join("\n")).toContain("部分内容未送达");
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "engine.event.delivery_failed",
        outcome: "error",
        metadata: expect.objectContaining({ failedChunks: 1 }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 3: card-choice runs claim activeRuns guarded, like /goal watchers.
  it("card choice attaches to a pursued /goal instead of killing it", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-choice-goal-"));
    const runtime = createCoreServiceRuntime();
    const channel = fakeChannel();
    const goal = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        // The pursuit must survive a card-triggered turn — same rule as ordinary
        // messages and crons (the turn attaches; it does not steal the slot).
        expect(goal.signal.aborted).toBe(false);
        return { text: "choice done" };
      }),
    };

    try {
      await handleCoreCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          messageId: "om_choice_goal",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "Option A",
              value: "A",
            },
          },
        },
      });

      await vi.waitFor(() => expect(runtime.chatQueue.isBusy("lark:oc_chat")).toBe(false));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(goal.signal.aborted).toBe(false);
      // The goal still owns the slot after the card turn released its claim.
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(goal);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("card choice aborts a previous NON-goal holder and releases only its own claim", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-choice-claim-"));
    const runtime = createCoreServiceRuntime();
    const channel = fakeChannel();
    const previous = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: previous, hasRunCard: true });
    const replacement = new AbortController();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        // The previous non-goal holder was aborted before this turn claimed the
        // slot — never silently orphaned.
        expect(previous.signal.aborted).toBe(true);
        // Simulate a newer run replacing the slot while this turn is running.
        runtime.activeRuns.set("lark:oc_chat", { abortController: replacement });
        return { text: "choice done" };
      }),
    };

    try {
      await handleCoreCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          messageId: "om_choice_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "Option A",
              value: "A",
            },
          },
        },
      });

      await vi.waitFor(() => expect(runtime.chatQueue.isBusy("lark:oc_chat")).toBe(false));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(previous.signal.aborted).toBe(true);
      // The finally block must NOT clobber the newer claim.
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(replacement);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 4c: a stale queue-card stop tap must not abort the active run.
  it("treats a stale queue-card stop tap as a no-op instead of aborting the active run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-stale-stop-"));
    const runtime = createCoreServiceRuntime();
    const channel = fakeChannel();
    const active = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: active });

    try {
      await handleCoreCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          messageId: "om_stale_queue_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
              taskId: "om_no_longer_queued",
            },
          },
        },
      });

      expect(active.signal.aborted).toBe(false);
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "该任务已不在队列中。" },
        expect.objectContaining({ replyTo: "om_stale_queue_card" }),
      );

      // A stop without a taskId (run-card stop button) still aborts the run.
      await handleCoreCardAction({
        channel,
        runtime,
        stateDir,
        event: {
          messageId: "om_run_card",
          chatId: "oc_chat",
          operator: { openId: "ou_user" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
            },
          },
        },
      });
      expect(active.signal.aborted).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 4a: failed inline queue-card take-over recalls the orphan card.
  it("recalls the orphan inline queue card when the run-card take-over patch fails", async () => {
    const channel = fakeChannel({
      updateCard: vi.fn(async (messageId: string) => {
        if (messageId === "om_stale_wait_card") {
          throw new Error("patch rejected");
        }
      }),
    });

    const controller = await createCoreRunCardController({
      channel,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      replyTo: "om_msg",
      locale: "zh",
      existingCard: { messageId: "om_stale_wait_card" },
    });

    expect(channel.recallMessage).toHaveBeenCalledWith("om_stale_wait_card");
    // A fresh card replaced the orphan, so the controller is still live.
    expect(controller).toBeDefined();
  });

  // Finding 4b: a failed in-place queue-card refresh recalls the old card before
  // a fresh one replaces it.
  it("recalls the stale queue wait card when the in-place refresh fails and a fresh card is sent", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-queue-wait-"));
    const runtime = createCoreServiceRuntime();
    runtime.queueCards.set("om_waited", { messageId: "om_old_wait_card" });
    runtime.chatQueue = {
      enqueue: async (
        _key: string,
        task: () => Promise<boolean>,
        options?: { onWait?: (event: { waitedMs: number; reason: string }) => void | Promise<void> },
      ) => {
        await options?.onWait?.({ waitedMs: 12_000, reason: "queue-busy" });
        return await task();
      },
      cancel: () => false,
      clearPending: () => undefined,
    } as unknown as typeof runtime.chatQueue;
    const channel = fakeChannel({
      updateCard: vi.fn(async (messageId: string) => {
        if (messageId === "om_old_wait_card") {
          throw new Error("patch rejected");
        }
      }),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_waited", content: "hello" }),
      });

      expect(channel.recallMessage).toHaveBeenCalledWith("om_old_wait_card");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 5: a failed batched merged turn must produce ONE error reply, not N.
  it("rejects only one waiter when a batched merged turn fails", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-batch-error-"));
    const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs: 150 } });
    const channel = fakeChannel();
    let accessChecks = 0;
    const bridge = {
      // Throws OUTSIDE the per-turn engine try/catch so the failure propagates to
      // the batch flush — previously rejecting every waiter (N error replies).
      checkAccess: vi.fn(async () => {
        accessChecks++;
        if (accessChecks <= 2) {
          return { kind: "allow" as const };
        }
        throw new Error("boom-access");
      }),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
    };

    try {
      const settled = await Promise.allSettled([
        handleCoreMessage({
          channel,
          bridge,
          runtime,
          stateDir,
          message: fakeLarkMessage({ messageId: "om_batch_1", content: "first" }),
        }),
        handleCoreMessage({
          channel,
          bridge,
          runtime,
          stateDir,
          message: fakeLarkMessage({ messageId: "om_batch_2", content: "second" }),
        }),
      ]);

      // Each input is admitted before batching; the merged turn performs one
      // execution-time recheck and rejects only its newest waiter on failure.
      expect(bridge.checkAccess).toHaveBeenCalledTimes(3);
      const rejected = settled.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect((rejected[0]!.reason as Error).message).toContain("boom-access");
      const fulfilled = settled.filter((entry): entry is PromiseFulfilledResult<boolean> => entry.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value).toBe(true);
      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toContainEqual(expect.objectContaining({
        type: "command.handled",
        outcome: "error",
        detail: "batch-merged",
        metadata: expect.objectContaining({
          larkMessageId: "om_batch_1",
          mergedInto: "om_batch_2",
        }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // Finding 6: approval card header/summary localized like the button labels.
  it("localizes the approval card header and summary", () => {
    const zh = JSON.stringify(renderCoreApprovalCard({ requestId: "req_1", toolName: "Bash" }));
    expect(zh).toContain("请求审批");
    expect(zh).toContain("请求审批：Bash");
    expect(zh).not.toContain("Approval requested");

    const en = JSON.stringify(renderCoreApprovalCard({ requestId: "req_1", toolName: "Bash", locale: "en" }));
    expect(en).toContain("**Approval requested**");
    expect(en).toContain("Approval requested: Bash");
  });

  // Finding 7: engine-internal "aborted" errors are real failures unless the
  // caller's abort signal actually fired.
  it("classifies a bare 'aborted' error as interruption only when the signal fired", () => {
    expect(classifyCoreTurnTermination(new Error("Codex turn aborted"), undefined))
      .toEqual({ kind: "error" });
    expect(classifyCoreTurnTermination(new Error("turn pool wait aborted"), undefined))
      .toEqual({ kind: "error" });

    const aborted = new AbortController();
    aborted.abort();
    expect(classifyCoreTurnTermination(new Error("Codex turn aborted"), aborted.signal))
      .toEqual({ kind: "interrupted" });

    // Explicit user-stop messages stay message-based (the reaction layer has no signal).
    expect(classifyCoreTurnTermination(new Error("Task was stopped by user"), undefined))
      .toEqual({ kind: "interrupted" });
    expect(classifyCoreTurnTermination(new Error("the task was stopped"), undefined))
      .toEqual({ kind: "interrupted" });
    expect(classifyCoreTurnTermination(new Error("turn inactive after 5 minutes"), undefined))
      .toEqual({ kind: "idle_timeout", minutes: 5 });
  });

  // Finding 8: /help describes /stop accurately (current task only).
  it("describes /stop as stopping only the current task in /help", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-audit-help-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleCoreMessage({
        channel,
        bridge,
        runtime: createCoreServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_help", content: "/help" }),
      });

      const markdowns = channel.send.mock.calls
        .map((call) => (call[1] as { markdown?: string }).markdown)
        .filter((markdown): markdown is string => typeof markdown === "string");
      const help = markdowns.find((markdown) => markdown.includes("/stop"));
      expect(help).toBeDefined();
      expect(help).toContain("停当前任务");
      expect(help).toContain("排队任务在各自排队卡片上取消");
      expect(help).not.toContain("停当前/排队任务");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  content: string;
  threadId: string;
  mentionedBot: boolean;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: "ou_user",
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

type FakeLarkChannel = ReturnType<typeof baseFakeChannel>;

function fakeChannel(overrides: Partial<FakeLarkChannel> = {}): FakeLarkChannel {
  return {
    ...baseFakeChannel(),
    ...overrides,
  };
}

function baseFakeChannel() {
  return {
    send: vi.fn(async (_to: string, _payload: unknown, _options?: unknown) => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: CoreStreamControllerLike) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async (_messageId: string, _card?: unknown) => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
  };
}
