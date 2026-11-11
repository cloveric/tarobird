import { describe, expect, it, vi } from "vitest";
import { sendSteering, settleSteeringRequest, hasSteeringDraft, clearSteeringDraft, retireEditedSteeringDraft, recoverSteeringDraft } from "../client/src/steering-request.js";
import { codexSupplementTarget } from "../client/src/use-codex-send-choice.js";
import type { HubConnection } from "../client/src/connection.js";
import type { Message } from "../src/client-protocol/index.js";

function fixture() {
  const posts: Array<{ botId: string; requestId: string; targetId: string; text: string }> = [];
  let lost = true, targetId = "turn";
  const http = vi.fn(async (_route: string, init?: RequestInit) => {
    if (init?.method !== "POST") return { supported: true, targetId, sendBehavior: "steer" };
    const body = JSON.parse(String(init.body)); posts.push(body);
    if (lost) throw new Error("response lost");
    return { id: "message", conversationId: "chat", clientMsgId: body.requestId, authorType: "user", authorId: "owner", blocks: [{ type: "text", text: body.text }, { type: "steering", botId: "bot", targetId: body.targetId, outcome: "accepted" }], status: "complete", createdAt: 1, version: 1 };
  });
  return { connection: { http } as unknown as HubConnection, posts, http, nextTurn: () => { targetId = "next_turn"; }, restore: () => { lost = false; } };
}
function persistedFixture() {
  const f = fixture(), records = new Map<string, string>();
  const cache = {
    operationRecord: async (key: string) => records.get(key) ?? "",
    updateOperationIfMatches: async (key: string, previous: string, next: string) => { if ((records.get(key) ?? "") !== previous) return false; records.set(key, next); return true; },
    clearOperationIfMatches: async (key: string, previous: string) => { if (records.get(key) === previous) records.delete(key); },
  };
  return { ...f, records, cache, reload: () => ({ http: f.http, cache }) as unknown as HubConnection };
}
describe("in-flight input delivery receipts", () => {
  it("Codex defaults to queue, retains an explicit choice on unknown status, and expires it for idle or a new task", () => {
    expect(codexSupplementTarget(undefined, { targetId: "turn" })).toBeUndefined();
    expect(codexSupplementTarget("turn", {})).toBe("turn");
    expect(codexSupplementTarget("turn", { targetId: "turn" })).toBe("turn");
    expect(codexSupplementTarget("turn", { targetId: "next" })).toBeUndefined();
    expect(codexSupplementTarget("turn", { idle: true })).toBeUndefined();
  });
  it("a selected task cannot be replaced by a newer target during explicit preflight", async () => {
    const f = fixture(); f.nextTurn(); f.restore();
    await expect(sendSteering(f.connection, "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toMatchObject({ reason: "stale" });
    expect(f.posts).toEqual([]);
  });
  it("persists an explicit request across reload instead of issuing a second instruction", async () => {
    const f = persistedFixture();
    await expect(sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow();
    f.nextTurn(); f.restore(); await expect(sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "next_turn")).rejects.toThrow("已补充到之前的任务");
    expect(f.posts[1]).toEqual(f.posts[0]);
    // Acceptance alone cannot unlock a still-present draft for ordinary queue delivery.
    expect(await hasSteeringDraft(f.reload(), "chat", "bot", "补充")).toBe(true);
    await sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn");
    expect(f.posts[2]).toEqual(f.posts[0]);
    await clearSteeringDraft(f.reload(), "chat", "bot", "unrelated");
    expect(await hasSteeringDraft(f.reload(), "chat", "bot", "补充")).toBe(true);
    await clearSteeringDraft(f.reload(), "chat", "bot", f.posts[0]!.requestId);
    expect(await hasSteeringDraft(f.reload(), "chat", "bot", "补充")).toBe(false);
  });
  it("does not retire uncertain input on edits or another window's unrelated draft", async () => {
    const f = persistedFixture(), origin = f.reload();
    await expect(sendSteering(origin, "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow();
    await retireEditedSteeringDraft(origin, "chat", "bot", "new");
    expect(await hasSteeringDraft(origin, "chat", "bot", "补充")).toBe(true);
    settleSteeringRequest(f.reload(), { conversationId: "chat", clientMsgId: f.posts[0]!.requestId, blocks: [{ type: "steering", botId: "bot", outcome: "accepted" }] } as Message, () => "unrelated");
    await vi.waitFor(() => expect(JSON.parse([...f.records.values()][0]!).settled).toBe(true));
    expect(await hasSteeringDraft(origin, "chat", "bot", "补充")).toBe(true);
    await retireEditedSteeringDraft(origin, "chat", "bot", "new");
    expect(await hasSteeringDraft(origin, "chat", "bot", "补充")).toBe(false);
  });
  it("a rejected explicit receipt releases its draft without touching native-input records", async () => {
    const f = persistedFixture(), origin = f.reload();
    f.records.set("native-input:chat:bot", "native-record");
    await expect(sendSteering(origin, "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow();
    settleSteeringRequest(origin, { conversationId: "chat", clientMsgId: f.posts[0]!.requestId, blocks: [{ type: "steering", botId: "bot", outcome: "rejected" }] } as Message);
    await vi.waitFor(async () => expect(await hasSteeringDraft(origin, "chat", "bot", "补充")).toBe(false));
    expect(f.records.get("native-input:chat:bot")).toBe("native-record");
  });
  it("two windows cannot create different explicit delivery IDs for the same draft", async () => {
    const f = persistedFixture(); f.restore();
    const results = await Promise.allSettled([sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn"), sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
  });
  it("does not POST when durable storage fails or navigation occurs while reloading an attempt", async () => {
    const f = persistedFixture();
    const save = f.cache.updateOperationIfMatches;
    f.cache.updateOperationIfMatches = async () => { throw new Error("disk full"); };
    await expect(sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow("disk full");
    expect(f.posts).toHaveLength(0);
    f.cache.updateOperationIfMatches = save;
    await expect(sendSteering(f.reload(), "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow();
    expect(await sendSteering(f.reload(), "chat", "bot", "补充", () => false)).toBeUndefined();
    expect(f.posts).toHaveLength(1);
  });
  it("queue recovery never injects into a live target, but can check the same old ID after the task changes", async () => {
    const f = persistedFixture(), connection = f.reload();
    await expect(sendSteering(connection, "chat", "bot", "补充", () => true, false, false, undefined, "turn")).rejects.toThrow();
    expect(await recoverSteeringDraft(connection, "chat", "bot", "补充", () => true)).toBe("pending");
    expect(f.posts).toHaveLength(1);
    f.nextTurn(); f.restore();
    expect(await recoverSteeringDraft(connection, "chat", "bot", "补充", () => true)).toBe("accepted");
    expect(f.posts[1]).toEqual(f.posts[0]);
    expect(await hasSteeringDraft(connection, "chat", "bot", "补充")).toBe(true);
  });
  it("a never-delivered old request can be rejected and unlocked after authoritative idle status", async () => {
    const f = persistedFixture(), connection = f.reload();
    f.records.set("steering-input:chat:bot", JSON.stringify({ botId: "bot", requestId: "lost-before-hub", targetId: "turn", text: "补充" }));
    f.restore();
    connection.http = async (route, init) => {
      if (init?.method !== "POST") return { supported: true, reason: "idle" };
      const receipt = await f.http(route, init);
      return { ...receipt, blocks: [{ type: "steering", botId: "bot", targetId: "turn", outcome: "rejected", reason: "stale" }] };
    };
    expect(await recoverSteeringDraft(connection, "chat", "bot", "补充", () => true)).toBe("rejected");
    expect(f.posts).toEqual([expect.objectContaining({ requestId: "lost-before-hub", targetId: "turn" })]);
    expect(await hasSteeringDraft(connection, "chat", "bot", "补充")).toBe(false);
  });
  it("unknown status and navigation never unlock or retry an uncertain draft for queue delivery", async () => {
    const f = persistedFixture(), connection = f.reload();
    f.records.set("steering-input:chat:bot", JSON.stringify({ botId: "bot", requestId: "old", targetId: "turn", text: "补充" }));
    connection.http = async () => ({ supported: false, reason: "not_ready" });
    expect(await recoverSteeringDraft(connection, "chat", "bot", "补充", () => true)).toBe("pending");
    connection.http = async () => ({ supported: true, targetId: "next" });
    expect(await recoverSteeringDraft(connection, "chat", "bot", "补充", () => false)).toBe("pending");
    expect(f.posts).toEqual([]); expect(await hasSteeringDraft(connection, "chat", "bot", "补充")).toBe(true);
  });
  it("unbound explicit steering keeps the existing non-persistent lifecycle for other engines and groups", async () => {
    const f = persistedFixture(); f.restore();
    await sendSteering(f.reload(), "chat", "bot", "group supplement", () => true);
    expect(f.posts).toHaveLength(1); expect(f.records.size).toBe(0);
  });
  it("rechecks uncertain input with the original target/request ID, without a new status lookup", async () => {
    const f = fixture(); await expect(sendSteering(f.connection, "chat", "bot", "补充", () => true)).rejects.toThrow();
    f.restore(); const result = await sendSteering(f.connection, "chat", "bot", "补充", () => true);
    expect(result?.clientMsgId).toBe(f.posts[0]?.requestId); expect(f.posts[1]).toEqual(f.posts[0]);
    expect(f.http.mock.calls.filter(call => call[1]?.method !== "POST")).toHaveLength(1);
  });
  it("an uncertain old instruction cannot permanently lock input to a new target", async () => {
    const f = fixture(); await expect(sendSteering(f.connection, "chat", "bot", "旧补充", () => true)).rejects.toThrow();
    f.nextTurn(); f.restore(); await sendSteering(f.connection, "chat", "bot", "新的任务补充", () => true);
    expect(f.posts).toHaveLength(2); expect(f.posts[0]!.targetId).toBe("turn"); expect(f.posts[1]!.targetId).toBe("next_turn");
    expect(f.posts[1]!.requestId).not.toBe(f.posts[0]!.requestId);
  });
  it("navigation during capability lookup prevents delivery", async () => {
    const f = fixture(); expect(await sendSteering(f.connection, "chat", "bot", "补充", () => false)).toBeUndefined(); expect(f.posts).toEqual([]);
  });
  it("a changed draft cannot reuse an unresolved request; checking the receipt releases it", async () => {
    const f = fixture(); await expect(sendSteering(f.connection, "chat", "bot", "补充", () => true)).rejects.toThrow();
    await expect(sendSteering(f.connection, "chat", "bot", "另一个要求", () => true)).rejects.toThrow(); expect(f.posts).toHaveLength(1);
    settleSteeringRequest(f.connection, { conversationId: "chat", clientMsgId: f.posts[0]!.requestId, blocks: [{ type: "steering", botId: "bot", targetId: "turn", outcome: "accepted" }] } as Message);
    f.restore(); await sendSteering(f.connection, "chat", "bot", "另一个要求", () => true);
    expect(f.posts).toHaveLength(2); expect(f.posts[1]!.requestId).not.toBe(f.posts[0]!.requestId);
  });
  it("an older CLI queues ordinary input without creating a failed steering transcript", async () => {
    const http = vi.fn(async () => ({ supported: true, targetId: "old_turn" }));
    const connection = { http } as unknown as HubConnection;
    await expect(sendSteering(connection, "chat", "bot", "ordinary", () => true, true)).rejects.toMatchObject({ reason: "unsupported" });
    expect(http).toHaveBeenCalledTimes(1);
  });
  function reviewFixture(status: Record<string, unknown> = { supported: true, targetId: "review_1", targetKind: "background-review", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } }) {
    const records = new Map<string, string>(), posts: Array<Record<string, unknown>> = [];
    const cache = {
      operationRecord: async (key: string) => records.get(key) ?? "",
      updateOperationIfMatches: async (key: string, expected: string, next: string) => { if ((records.get(key) ?? "") !== expected) return false; records.set(key, next); return true; },
      clearOperationIfMatches: async (key: string, expected: string) => { if (records.get(key) === expected) records.delete(key); return true; },
    };
    const http = vi.fn(async (_route: string, init?: RequestInit) => {
      if (init?.method !== "POST") return status;
      const body = JSON.parse(String(init.body)); posts.push(body);
      return { id: "message", conversationId: "chat", clientMsgId: body.requestId, authorType: "user", authorId: "owner", blocks: [{ type: "text", text: body.text }, { type: "steering", botId: "bot", targetId: body.targetId, outcome: "accepted", mode: "message" }], status: "complete", createdAt: 1, version: 1 };
    });
    return { connection: { http, cache } as unknown as HubConnection, http, posts };
  }
  it("asks for a background-review target only for ordinary input and sends it as native input", async () => {
    const f = reviewFixture();
    await sendSteering(f.connection, "chat", "bot", "补充 B", () => true, true);
    expect(f.http.mock.calls[0]![0]).toBe("/api/conversations/chat/steer?botId=bot&review=1");
    expect(f.posts).toEqual([expect.objectContaining({ targetId: "review_1", text: "补充 B", mode: "message" })]);
  });
  it("never sends-now or explicitly steers into a background review", async () => {
    const f = reviewFixture();
    await expect(sendSteering(f.connection, "chat", "bot", "立即", () => true, true, true)).rejects.toMatchObject({ reason: "unsupported" });
    await expect(sendSteering(f.connection, "chat", "bot", "引导", () => true)).rejects.toMatchObject({ reason: "idle" });
    expect(f.http.mock.calls.map(call => call[0])).toEqual(["/api/conversations/chat/steer?botId=bot&review=1", "/api/conversations/chat/steer?botId=bot"]);
    expect(f.posts).toEqual([]);
  });

});
