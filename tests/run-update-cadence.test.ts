import { afterEach, expect, it, vi } from "vitest";
import { createCoreRunCardController } from "../src/core/message-handler.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import type { CoreChannelLike } from "../src/core/types.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(profile: "gateway" | "lark", delay = 0) {
  const frames: string[] = [];
  const starts: number[] = [];
  let inFlight = 0, peak = 0;
  const channel: CoreChannelLike = {
    profile, send: async () => ({ messageId: "fixture" }),
    stream: async () => { throw new Error("Unexpected stream"); },
    downloadResource: async () => Buffer.alloc(0),
    updateCard: vi.fn(async (_id, card) => {
      starts.push(performance.now());
      peak = Math.max(peak, ++inFlight);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      frames.push(JSON.stringify(card));
      inFlight--;
    }),
  };
  const controller = (await createCoreRunCardController({ channel, chatId: "fixture", conversationKey: "fixture", bridgeChatType: "private", locale: "en" }))!;
  return { controller, frames, starts, channel, peak: () => peak };
}

it.each(["assistant_text", "thinking"] as const)("publishes an idle native %s burst promptly while coalescing its chunks", async type => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    await f.controller.apply({ type, text: "first" });
    await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 5; i++) await f.controller.apply({ type, text: `chunk${i}`, delta: true });
    await vi.advanceTimersByTimeAsync(15);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(2);
    expect(f.frames[1]).toContain("chunk4");
    await f.controller.apply({ type, text: "tail", delta: true });
    await vi.advanceTimersByTimeAsync(99);
    expect(f.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(3);
    await f.controller.finish("done");
  });
});

it("limits native patch starts even when a queued patch starts after its timer", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway"), patch = vi.mocked(f.channel.updateCard!);
    const deliver = patch.getMockImplementation()!;
    patch.mockImplementationOnce(async (...args) => {
      await deliver(...args);
      await new Promise(resolve => setTimeout(resolve, 180));
    });
    await f.controller.apply({ type: "assistant_text", text: "first" });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.apply({ type: "assistant_text", text: " queued", delta: true });
    await vi.advanceTimersByTimeAsync(170);
    await f.controller.apply({ type: "assistant_text", text: " caught up", delta: true });
    await vi.advanceTimersByTimeAsync(15);
    expect(f.frames).toHaveLength(2);
    await f.controller.apply({ type: "assistant_text", text: " latest", delta: true });
    await vi.advanceTimersByTimeAsync(95);
    expect(f.frames).toHaveLength(3);
    expect(f.frames.at(-1)).toContain("latest");
    expect(f.starts).toEqual([0, 180, 280]);
    await f.controller.finish("done");
  });
});

it.each(["gateway", "lark"] as const)("keeps %s updates responsive without disabling coalescing", async profile => {
  vi.useFakeTimers();
  await withChannelProfile(profile, async () => {
    const f = await fixture(profile), interval = profile === "gateway" ? 100 : 400;
    await f.controller.apply({ type: "assistant_text", text: "first" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames).toHaveLength(1);
    for (let i = 0; i < 30; i++) await f.controller.apply({ type: "assistant_text", text: `delta${i}`, delta: true });
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(2);
    expect(f.frames[1]).toContain("delta29");
    await f.controller.finish("final answer");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.frames).toHaveLength(3);
    expect(f.frames.at(-1)).toContain("final answer");
  });
});

it("coalesces behind a slow receiver and sends the terminal frame without draining obsolete updates", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway", 1000);
    await f.controller.apply({ type: "assistant_text", text: "start" });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 9; i++) {
      await f.controller.apply({ type: "assistant_text", text: `delta${i}`, delta: true });
      await vi.advanceTimersByTimeAsync(100);
    }
    const finished = f.controller.finish("terminal answer");
    await vi.advanceTimersByTimeAsync(1100);
    await finished;
    expect(f.peak()).toBe(1);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("terminal answer");
    await f.controller.apply({ type: "assistant_text", text: "late event" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.frames).toHaveLength(2);
  });
});

it("flushes the latest delta after a slow patch even when no new event follows", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway", 600);
    await f.controller.apply({ type: "assistant_text", text: "start" });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.apply({ type: "assistant_text", text: "latest delta", delta: true });
    await vi.advanceTimersByTimeAsync(1200);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("latest delta");
    const finished = f.controller.finish("done");
    await vi.advanceTimersByTimeAsync(600);
    await finished;
    expect(f.peak()).toBe(1);
  });
});

it("retries the last native delta after a failed patch without another engine event", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    await f.controller.apply({ type: "assistant_text", text: "start" });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    await f.controller.apply({ type: "assistant_text", text: " tail", delta: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("tail");
    await f.controller.finish("start tail");
  });
});

it("bounds autonomous retries, backs off incoming updates and recovers the full native card", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway"), patch = vi.mocked(f.channel.updateCard!);
    const deliver = patch.getMockImplementation()!;
    patch.mockRejectedValue(new Error("unavailable"));
    await f.controller.apply({ type: "tool_use", toolName: "Read", toolUseId: "read", toolInput: { path: "/report.txt" } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(patch).toHaveBeenCalledTimes(4); // First attempt + three automatic retries.
    patch.mockImplementation(deliver);
    await f.controller.apply({ type: "assistant_text", text: "Recovered" });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames.at(-1)).toContain("/report.txt");
    expect(f.frames.at(-1)).toContain("Recovered");
    await f.controller.finish("Recovered");
  });
});

it("does not let frequent engine events bypass native failure backoff", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    vi.mocked(f.channel.updateCard!).mockRejectedValue(new Error("unavailable"));
    for (let i = 0; i < 20; i++) {
      await f.controller.apply({ type: "assistant_text", text: `${i} `, delta: true });
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(f.channel.updateCard).toHaveBeenCalledTimes(3); // 0, 250, 750 ms.
    vi.mocked(f.channel.updateCard!).mockResolvedValue(undefined);
    await f.controller.finish("terminal");
    const calls = vi.mocked(f.channel.updateCard!).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.channel.updateCard).toHaveBeenCalledTimes(calls);
  });
});

it("keeps native retry deadlines stable across a wall-clock correction", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    await f.controller.apply({ type: "assistant_text", text: "last delta" });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 24 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toContain("last delta");
    await f.controller.finish("done");
  });
});

it("waits only the remaining backoff when a retry timer fires slightly early", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const now = performance.now.bind(performance); let early = false;
    vi.spyOn(performance, "now").mockImplementation(() => now() - (early ? 0.5 : 0));
    const f = await fixture("gateway");
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    await f.controller.apply({ type: "assistant_text", text: "last delta" });
    await vi.advanceTimersByTimeAsync(0);
    early = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(f.frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(f.frames).toHaveLength(1);
    await f.controller.finish("done");
  });
});

it("waits only the remaining native cadence when a timer fires slightly early", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const now = performance.now.bind(performance); let early = false;
    vi.spyOn(performance, "now").mockImplementation(() => now() - (early ? 0.5 : 0));
    const f = await fixture("gateway");
    await f.controller.apply({ type: "assistant_text", text: "first" });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.apply({ type: "assistant_text", text: " tail", delta: true });
    early = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("tail");
    await f.controller.finish("done");
  });
});

it("retries a full native final card after a transient failure during beginDelivery", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    await f.controller.apply({ type: "tool_use", toolName: "Read", toolUseId: "read", toolInput: { path: "/report.txt" } });
    await f.controller.apply({ type: "tool_result", toolUseId: "read", output: "Full process evidence" });
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    const answer = "The complete answer. ".repeat(1000) + "FINAL_TAIL";
    await f.controller.beginDelivery(answer);
    const delivering = JSON.parse(f.frames.at(-1)!);
    expect(delivering.appRun.summary.phase).toBe("delivering");
    expect(JSON.stringify(delivering.body)).toContain(answer);
    expect(delivering.body.elements.some((element: any) => element.tag === "collapsible_panel")).toBe(false);
    await f.controller.finish(answer);
    const final = JSON.parse(f.frames.at(-1)!);
    expect(final.appRun.summary.phase).toBe("done");
    expect(final.body.elements.some((element: any) => element.tag === "collapsible_panel")).toBe(true);
  });
});

it("keeps the complete native answer when the terminal full patch falls back to compact", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway"), answer = "完整答案".repeat(5000) + "FINAL_TAIL";
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    expect(await f.controller.finish(answer)).toMatchObject({ shown: true });
    expect(JSON.stringify(JSON.parse(f.frames.at(-1)!).body)).toContain(answer);
  });
});

it.each(["finish", "interrupt", "idleTimeout", "fail"] as const)("cancels native retry timers on %s", async operation => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    vi.mocked(f.channel.updateCard!).mockRejectedValueOnce(new Error("temporary failure"));
    await f.controller.apply({ type: "assistant_text", text: "start" });
    await vi.advanceTimersByTimeAsync(0);
    if (operation === "finish") await f.controller.finish("done");
    else if (operation === "interrupt") await f.controller.interrupt();
    else if (operation === "idleTimeout") await f.controller.idleTimeout(5);
    else await f.controller.fail("failed");
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.frames).toHaveLength(1);
  });
});

it("does not rearm a native retry when an in-flight patch fails after terminal delivery starts", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway"), patch = vi.mocked(f.channel.updateCard!);
    patch.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 300)); throw new Error("late failure"); });
    await f.controller.apply({ type: "assistant_text", text: "start" });
    await vi.advanceTimersByTimeAsync(0);
    const done = f.controller.finish("done");
    await vi.advanceTimersByTimeAsync(300); await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toContain("done");
  });
});

it("preserves native Stop while a retry is pending and waits for explicit stop confirmation", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const abort = new AbortController(), cards: any[] = [];
    const channel: CoreChannelLike = {
      profile: "gateway", send: async () => ({ messageId: "fixture" }), stream: vi.fn(), downloadResource: vi.fn(),
      updateCard: vi.fn(async (_id, card) => { cards.push(card); }),
    };
    const controller = (await createCoreRunCardController({ channel, chatId: "fixture", conversationKey: "fixture", bridgeChatType: "private", locale: "en", abortSignal: abort.signal }))!;
    vi.mocked(channel.updateCard!).mockRejectedValueOnce(new Error("failure"));
    await controller.apply({ type: "tool_use", toolName: "Read", toolUseId: "read" });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(250);
    expect(cards.at(-1).appRun.summary.phase).toBe("stopping");
    await controller.interrupt();
    expect(cards.at(-1).appRun.summary.phase).toBe("stopped");
    const count = cards.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cards).toHaveLength(count);
  });
});

it("avoids resending an unchanged native frame after a queued slow patch caught up", async () => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway", 150);
    await f.controller.apply({ type: "assistant_text", text: "first" });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.apply({ type: "assistant_text", text: " second", delta: true });
    await vi.advanceTimersByTimeAsync(125);
    await f.controller.apply({ type: "assistant_text", text: " latest", delta: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("latest");
    const done = f.controller.finish("done");
    await vi.advanceTimersByTimeAsync(150); await done;
  });
});

it.each([
  { name: "64 KiB ASCII", text: "x".repeat(64 * 1024) },
  { name: "192 kB Chinese", text: "完整正文".repeat(16000) },
])("keeps $name native answers on the short-answer cadence without delaying confirmation or truncating output", async ({ text }) => {
  vi.useFakeTimers();
  await withChannelProfile("gateway", async () => {
    const f = await fixture("gateway");
    await f.controller.apply({ type: "assistant_text", text });
    await vi.advanceTimersByTimeAsync(0);
    await f.controller.apply({ type: "assistant_text", text: "末尾增量", delta: true });
    await vi.advanceTimersByTimeAsync(99);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(2);
    expect(f.frames.at(-1)).toContain("末尾增量");
    await f.controller.apply({ type: "assistant_text", text: "更多", delta: true });
    await vi.advanceTimersByTimeAsync(50);
    f.controller.setPhase("waiting_answer");
    await vi.advanceTimersByTimeAsync(25);
    f.controller.setPhase("waiting_answer"); // Repeated urgency cannot postpone the first deadline.
    await vi.advanceTimersByTimeAsync(24);
    expect(f.frames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(3);
    expect(JSON.parse(f.frames.at(-1)!).appRun.summary.phase).toBe("waiting_answer");
    await f.controller.finish(text + "末尾增量更多");
    expect(f.frames.at(-1)).toContain(text + "末尾增量更多");
    const count = f.frames.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.frames).toHaveLength(count);
  });
});

it.each([true, false])("uses only full native patches while keeping legacy managed element streaming (native=%s)", async native => {
  vi.useFakeTimers();
  const profile = native ? "gateway" : "lark";
  await withChannelProfile(profile, async () => {
    const update = vi.fn(async () => true), updateElement = vi.fn(async () => true);
    const channel: CoreChannelLike = {
      profile, send: async () => ({ messageId: "fixture" }), stream: vi.fn(), downloadResource: vi.fn(), updateCard: vi.fn(),
      managedCards: { send: async () => ({ messageId: "fixture", cardId: "card", sequence: 0, native }), update, updateElement },
    };
    const controller = (await createCoreRunCardController({ channel, chatId: "fixture", conversationKey: "fixture", bridgeChatType: "private", locale: "en" }))!;
    await controller.apply({ type: "assistant_text", text: "First sentence. " });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 10; i++) {
      await controller.apply({ type: "assistant_text", text: `Sentence ${i}. `, delta: true });
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(updateElement).toHaveBeenCalledTimes(native ? 0 : 10);
    expect(update).toHaveBeenCalledTimes(native ? 11 : 1);
    await controller.finish("finished");
  });
});
