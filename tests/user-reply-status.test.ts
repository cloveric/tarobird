import { describe, expect, it } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import type { RunSummary } from "../src/client-protocol/run.js";
import { userReplyStatuses } from "../client/src/user-reply-status.js";

const online = new Set(["a", "b"]);
const user = (id = "prompt", extra: Partial<Message> = {}): Message => ({ id, conversationId: "chat", authorId: "owner", authorType: "user", blocks: [{ type: "text", text: id }], status: "complete", version: 1, createdAt: 1, ...extra });
const summary = (phase: RunSummary["phase"], extra: Partial<RunSummary> = {}): RunSummary => ({ version: 1, id: "run", revision: 1, phase, startedAt: 10, updatedAt: 20, count: 3, completed: 1, failed: 1, truncated: false, ...extra });
const reply = (phase: RunSummary["phase"], extra: Partial<Message> = {}, run: Partial<RunSummary> = {}): Message => ({ id: "reply", conversationId: "chat", authorId: "a", authorType: "bot", replyTo: "prompt", blocks: [{ type: "card", elements: [], extra: { nativeRun: summary(phase, run) } }], status: "complete", version: 1, createdAt: 10, ...extra });
const state = (messages: Message[], bots = online) => userReplyStatuses(messages, "chat", bots).get("prompt");

describe("per-prompt reply status", () => {
  it("leaves sent, queued, ordinary text/files and old unstructured replies unmarked", () => {
    expect(state([user()])).toBeUndefined();
    expect(state([user("prompt", { status: "error" }), reply("done")])).toBeUndefined();
    expect(state([user(), reply("done", { blocks: [{ type: "text", text: "任务完成" }] }), reply("done", { id: "file", blocks: [{ type: "file", attachmentId: "f", name: "file.txt", size: 1, mime: "text/plain" }] })])).toBeUndefined();
  });
  it.each([
    ["thinking", "replying"], ["working", "replying"], ["answering", "replying"], ["delivering", "replying"],
    ["done", "done"], ["error", "error"], ["partial", "partial"], ["stopped", "stopped"], ["interrupted", "interrupted"],
    ["waiting_approval", "waiting_approval"], ["waiting_answer", "waiting_answer"], ["stopping", "stopping"],
  ] as const)("maps confirmed phase %s to %s, not message delivery or failed-tool counts", (phase, expected) => {
    expect(state([user(), reply(phase)])).toEqual([{ botId: "a", messageId: "reply", state: expected }]);
  });
  it("uses message IDs despite interleaved prompts/replies and reordered input", () => {
    const messages = [user(), user("second"), user("third"), reply("working", { replyTo: "third" }), reply("done", { id: "old", replyTo: "second" })];
    for (const rows of [messages, [...messages].reverse()]) {
      const index = userReplyStatuses(rows, "chat", online);
      expect(index.has("prompt")).toBe(false);
      expect(index.get("third")?.[0].state).toBe("replying");
      expect(index.get("second")?.[0].state).toBe("done");
    }
  });
  it("ignores background/subagent, forged forwarded cards and absent/cross-conversation/deleted targets", () => {
    const card = (extra: Record<string, unknown>) => [{ type: "card" as const, elements: [], extra }];
    const ignored = [
      reply("done", { blocks: card({ scopedRun: summary("done") }) }),
      reply("error", { status: "error", blocks: card({ nativeRun: summary("error"), backgroundTask: { version: 1, origin: "bound" } }) }),
      reply("done", { forwardedFrom: { messageId: "elsewhere", conversationId: "other", conversationTitle: "other", authorName: "Bot", createdAt: 1 } }),
      reply("done", { conversationId: "other" }), reply("done", { replyTo: "missing" }), reply("done", { status: "deleted" }),
    ];
    expect(state([user(), ...ignored])).toBeUndefined();
    expect(state([user("prompt", { status: "deleted" }), reply("done")])).toBeUndefined();
  });
  it("keeps a forwarded user prompt eligible only for its own new replies", () => {
    const prompt = user("prompt", { blocks: reply("done").blocks, forwardedFrom: { messageId: "old", conversationId: "other", conversationTitle: "other", authorName: "Bot", createdAt: 1 } });
    expect(state([prompt])).toBeUndefined();
    expect(state([prompt, reply("working")])?.[0].state).toBe("replying");
  });
  it("does not treat a steering message as a separate run", () => {
    expect(state([user("prompt", { blocks: [{ type: "steering", botId: "a", targetId: "run", outcome: "accepted" }] }), reply("done")])).toBeUndefined();
  });
  it("marks durable delivery failure but never disconnect as a failed reply", () => {
    expect(state([user(), reply("working", { blocks: [{ type: "text", text: "worker failed" }], status: "error" })])?.[0].state).toBe("error");
    expect(state([user(), reply("working")], new Set())?.[0].state).toBe("unconfirmed");
    expect(state([user(), reply("done")], new Set())?.[0].state).toBe("done");
    expect(state([user(), reply("working", { status: "error" })])?.[0].state).toBe("interrupted");
  });
  it("keeps explicit host failure final even with skewed run timestamps", () => {
    const failed = reply("error", { id: "recovery", status: "error", createdAt: 2, blocks: [{ type: "text", text: "failure" }] });
    for (const rows of [[failed, reply("done")], [reply("done"), failed]]) expect(state([user(), ...rows])?.[0].state).toBe("error");
    expect(state([user(), reply("done", { status: "error" })])?.[0].state).toBe("error");
  });
  it("selects latest run attempt, not late updates from an older attempt", () => {
    const old = reply("done", { id: "old" }, { id: "old", updatedAt: 999, revision: 50 });
    const next = reply("working", { id: "new", createdAt: 30 }, { id: "new", startedAt: 30, updatedAt: 31 });
    expect(state([user(), next, old])?.[0]).toEqual({ botId: "a", messageId: "new", state: "replying" });
    const completed = reply("done", { id: "copy" }, { revision: 4 });
    expect(state([user(), completed, reply("working")])?.[0].state).toBe("done");
  });
  it("breaks equal run-start ties consistently across every input permutation", () => {
    const a = reply("working", { id: "copy_a", createdAt: 11 }, { id: "a", revision: 5 });
    const b = reply("done", { id: "copy_b", createdAt: 12 }, { id: "b" });
    const c = reply("error", { id: "copy_c", createdAt: 13 }, { id: "a", revision: 3 });
    for (const rows of [[a,b,c],[a,c,b],[b,a,c],[b,c,a],[c,a,b],[c,b,a]]) expect(state([user(), ...rows])?.[0]).toEqual({ botId: "a", messageId: "copy_b", state: "done" });
  });
  it.each(["waiting_approval", "waiting_answer", "stopping"] as const)("does not animate offline %s as active progress", phase => {
    expect(state([user(), reply(phase)], new Set())?.[0].state).toBe("unconfirmed");
  });
  it("tracks each Bot independently without inventing expected recipients from current membership", () => {
    expect(state([user(), reply("working"), reply("error", { id: "b_reply", authorId: "b" })])).toEqual([
      { botId: "a", messageId: "reply", state: "replying" }, { botId: "b", messageId: "b_reply", state: "error" },
    ]);
  });
  it("does not rewrite an old failed prompt when an explicit retry creates a new prompt", () => {
    const rows = [user(), reply("error"), user("retry"), reply("done", { id: "retried", replyTo: "retry" })];
    expect(state(rows)?.[0].state).toBe("error");
    expect(userReplyStatuses(rows, "chat", online).get("retry")?.[0].state).toBe("done");
  });
  it("ignores malformed run data without guessing from text", () => {
    expect(state([user(), reply("done", { blocks: [{ type: "card", elements: [], extra: { nativeRun: { phase: "done" } } }] })])).toBeUndefined();
  });
});
