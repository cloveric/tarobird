import { describe, expect, it, vi } from "vitest";
import { sendSteering, settleSteeringRequest } from "../client/src/steering-request.js";
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
describe("in-flight input delivery receipts", () => {
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
