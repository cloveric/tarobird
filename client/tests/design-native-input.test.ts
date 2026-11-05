import { describe, expect, it, vi } from "vitest";
import { sendSteering } from "../src/steering-request.js";
import type { HubConnection } from "../src/connection.js";
import type { WorkbenchContext } from "../../src/client-protocol/workbench.js";

function fixture() {
  const records = new Map<string, string>(), posts: any[] = [];
  let fail = false;
  const cache = {
    operationRecord: async (key: string) => records.get(key) ?? "",
    updateOperationIfMatches: async (key: string, before: string, next: string) => { if ((records.get(key) ?? "") !== before) return false; records.set(key, next); return true; },
    clearOperationIfMatches: async (key: string, before: string) => { if (records.get(key) === before) records.delete(key); return true; },
  };
  const http = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method !== "POST") return { supported: true, targetId: "turn", sendBehavior: "steer", nativeInput: { sendNow: true, cancel: true, modelReceipt: true } };
    const body = JSON.parse(String(options.body)); posts.push(body);
    if (fail) throw new Error("Lost ACK");
    return { id: "message", conversationId: "chat", clientMsgId: body.requestId, authorType: "user", authorId: "owner", blocks: [{ type: "text", text: body.text },
      { type: "steering", botId: "bot", targetId: body.targetId, outcome: "accepted", mode: "message" }], status: "complete", createdAt: 1, version: 1 };
  });
  return { connection: { http, cache } as unknown as HubConnection, cache, http, posts, fail: (value: boolean) => { fail = value; } };
}
const context = (windowId: string): WorkbenchContext => ({ target: { deviceId: "device", windowId }, openTarget: { deviceId: "device", windowId } });

describe("Design opener metadata on native input", () => {
  it("keeps native message mode and carries the exact originating opener", async () => {
    const f = fixture();
    await sendSteering(f.connection, "chat", "bot", "请用 Design 做这个", () => true, true, false, context("source"));
    expect(f.posts).toEqual([expect.objectContaining({ mode: "message", text: "请用 Design 做这个", workbench: context("source") })]);
    expect(f.http).toHaveBeenCalledTimes(2);
  });
  it("a reload/retry retains the frozen source even when a different window is now available", async () => {
    const f = fixture(); f.fail(true);
    await expect(sendSteering(f.connection, "chat", "bot", "用 Design", () => true, true, false, context("old"))).rejects.toThrow();
    f.fail(false);
    const reloaded = { http: f.http, cache: f.cache } as unknown as HubConnection;
    await sendSteering(reloaded, "chat", "bot", "用 Design", () => true, true, false, context("new"));
    expect(f.posts[1]).toEqual(f.posts[0]);
    expect(f.posts[1].workbench.openTarget.windowId).toBe("old");
    expect(f.http.mock.calls.filter(([, options]) => options?.method !== "POST")).toHaveLength(1);
  });
  it("ordinary messages without opener metadata keep the existing request shape", async () => {
    const f = fixture(); await sendSteering(f.connection, "chat", "bot", "普通聊天", () => true, true);
    expect(f.posts[0].mode).toBe("message"); expect(f.posts[0]).not.toHaveProperty("workbench");
  });
});
