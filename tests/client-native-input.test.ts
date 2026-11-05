import { describe, expect, it, vi } from "vitest";
import { SteeringNotDeliveredError, sendSteering, clearNativeInputDraft, hasNativeInputDraft, settleSteeringRequest, retireEditedNativeInputDraft } from "../client/src/steering-request.js";
import { controlNativeInput } from "../client/src/native-input-request.js";
import type { HubConnection } from "../client/src/connection.js";

function fixture() {
  const saved = new Map<string, string>(), bodies: any[] = [];
  const cache = { operationRecord: async (key: string) => saved.get(key) ?? "", saveDraft: async (key: string, text: string) => { saved.set(key, text); },
    updateOperationIfMatches: async (key: string, old: string, next: string) => { if ((saved.get(key) ?? "") !== old) return false; saved.set(key, next); return true; },
    clearOperationIfMatches: async (key: string, text: string) => { if (saved.get(key) === text) saved.delete(key); } };
  let lose = true;
  const http = vi.fn(async (route: string, init?: RequestInit) => {
    if (init?.method !== "POST") return { supported: true, targetId: "turn", sendBehavior: "steer", nativeInput: { sendNow: true, cancel: true, modelReceipt: true } };
    const body = JSON.parse(String(init.body)); bodies.push(body);
    if (lose) throw new Error("HTTP acknowledgement lost");
    if (route.includes("/inputs/")) return { outcome: "accepted", result: "cancelled" };
    return { id: "message", clientMsgId: body.requestId, conversationId: "chat", authorId: "owner", authorType: "user", blocks: [{ type: "text", text: body.text }, { type: "steering", mode: "message", botId: "bot", targetId: "turn", outcome: "accepted" }], status: "complete", version: 1, createdAt: 1 };
  });
  const reload = () => ({ cache, http }) as unknown as HubConnection;
  return { cache, bodies, saved, reload, restore: () => { lose = false; } };
}
describe("native input reconnect identity", () => {
  it("reuses the same input after HTTP loss and after admission-before-draft-clear reload", async () => {
    const f = fixture();
    await expect(sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true)).rejects.toThrow();
    expect(await hasNativeInputDraft(f.reload(), "chat", "bot", "Follow-up")).toBe(true);
    f.restore(); const accepted = await sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true);
    expect(f.bodies[1]).toEqual(f.bodies[0]);
    await sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true);
    expect(f.bodies[2]).toEqual(f.bodies[0]);
    await clearNativeInputDraft(f.reload(), "chat", "bot", accepted!.clientMsgId!);
    await sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true);
    expect(f.bodies[3].requestId).not.toBe(f.bodies[0].requestId);
    expect(f.bodies.every(body => body.mode === "message" && body.settled === undefined)).toBe(true);
  });
  it("keeps uncertain drafts protected but retires known admission after editing, including websocket recovery", async () => {
    const f = fixture(), connection = f.reload();
    await expect(sendSteering(connection, "chat", "bot", "Follow-up", () => true, true)).rejects.toThrow();
    await retireEditedNativeInputDraft(connection, "chat", "bot", "New draft");
    expect(await hasNativeInputDraft(connection, "chat", "bot", "Follow-up")).toBe(true);
    const body = f.bodies[0];
    const recovered: any = { clientMsgId: body.requestId, conversationId: "chat", blocks: [{ type: "steering", mode: "message", botId: "bot", outcome: "accepted" }] };
    settleSteeringRequest(connection, recovered, () => "New draft");
    await vi.waitFor(() => expect(f.saved.size).toBe(0));
    f.restore(); await sendSteering(connection, "chat", "bot", "Follow-up", () => true, true);
    expect(f.bodies[1].requestId).not.toBe(body.requestId);
    await retireEditedNativeInputDraft(connection, "chat", "bot", "");
    expect(f.saved.size).toBe(0);
  });
  it("a receipt shown in another window does not retire the originating retry identity", async () => {
    const f = fixture(), origin = f.reload(), otherWindow = f.reload();
    await expect(sendSteering(origin, "chat", "bot", "Follow-up", () => true, true)).rejects.toThrow();
    const body = f.bodies[0];
    settleSteeringRequest(otherWindow, { clientMsgId: body.requestId, conversationId: "chat", blocks: [{ type: "steering", mode: "message", botId: "bot", outcome: "accepted" }] } as any, () => "unrelated draft");
    await vi.waitFor(() => expect(JSON.parse([...f.saved.values()][0]!).settled).toBe(true));
    f.restore(); await sendSteering(origin, "chat", "bot", "Follow-up", () => true, true);
    expect(f.bodies[1]).toEqual(body);
  });
  it("permits durable fallback only for a fresh read-only preflight failure", async () => {
    const f = fixture(), connection = f.reload();
    connection.http = vi.fn(async () => { throw new Error("bot_timeout"); });
    const error = await sendSteering(connection, "chat", "bot", "Fresh", () => true, true).catch(error => error);
    expect(error).toBeInstanceOf(SteeringNotDeliveredError); expect(error.canQueue).toBe(true);
    expect(f.saved.size).toBe(0); expect(f.bodies).toHaveLength(0);
    await expect(sendSteering(connection, "chat", "bot", "Legacy", () => true)).rejects.toThrow("bot_timeout");
    f.saved.set("native-input:chat:bot", JSON.stringify({ botId: "bot", requestId: "old", targetId: "turn", text: "Uncertain", mode: "message" }));
    const uncertain = await sendSteering(connection, "chat", "bot", "Changed", () => true, true).catch(error => error);
    expect(uncertain).not.toBeInstanceOf(SteeringNotDeliveredError); expect(f.saved.size).toBe(1);
  });
  it("checks native send-now support before writing a fresh immediate input", async () => {
    const f = fixture(); f.restore(); const connection = f.reload();
    connection.http = vi.fn(async () => ({ supported: true, targetId: "turn", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } }));
    const error = await sendSteering(connection, "chat", "bot", "Immediate", () => true, true, true).catch(error => error);
    expect(error).toBeInstanceOf(SteeringNotDeliveredError); expect(error.reason).toBe("unsupported");
    expect(f.saved.size).toBe(0); expect(f.bodies).toHaveLength(0); expect(connection.http).toHaveBeenCalledTimes(1);
    // A genuinely idle CLI is a separate branch, before capability gating.
    connection.http = vi.fn(async () => ({ supported: true, reason: "idle", sendBehavior: "steer" }));
    const idle = await sendSteering(connection, "chat", "bot", "Initial", () => true, true, true).catch(error => error);
    expect(idle.reason).toBe("idle"); expect(f.saved.size).toBe(0);
    f.saved.set("native-input:chat:bot", JSON.stringify({ botId: "bot", requestId: "legacy", targetId: "turn", text: "Legacy" }));
    await expect(sendSteering(connection, "chat", "bot", "Legacy", () => true, true, true)).rejects.toBeInstanceOf(SteeringNotDeliveredError);
    expect(connection.http).toHaveBeenCalledTimes(1);
  });
  it("two windows cannot claim different IDs for the same pending draft", async () => {
    const f = fixture(); f.restore();
    const results = await Promise.allSettled([sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true), sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.bodies).toHaveLength(1);
  });
  it("retires a definitive rejection so later identical text can use a new native turn", async () => {
    const f = fixture(); f.restore(); const connection = f.reload(), http = connection.http;
    connection.http = async (...args) => {
      const value = await http(...args) as any;
      if (value.blocks) value.blocks[value.blocks.length - 1].outcome = "rejected";
      return value;
    };
    await sendSteering(connection, "chat", "bot", "Follow-up", () => true, true);
    expect(await hasNativeInputDraft(connection, "chat", "bot", "Follow-up")).toBe(false);
  });
  it("does not send when durable identity cannot be saved", async () => {
    const f = fixture(); f.cache.updateOperationIfMatches = async () => { throw new Error("disk full"); };
    await expect(sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true)).rejects.toThrow("disk full");
    expect(f.bodies).toHaveLength(0);
  });
  it("refuses malformed saved input/control identities before any request", async () => {
    const f = fixture();
    f.saved.set("native-input:chat:bot", JSON.stringify({ botId: "bot", requestId: 7, targetId: "turn", text: "Follow-up" }));
    await expect(sendSteering(f.reload(), "chat", "bot", "Follow-up", () => true, true)).rejects.toThrow();
    f.saved.set("native-control:chat:message:cancel", JSON.stringify("not/a/request"));
    await expect(controlNativeInput(f.reload(), "chat", "message", "cancel")).rejects.toThrow();
    expect(f.reload().http).not.toHaveBeenCalled();
  });
  it("starts a fresh manual control attempt after a confirmed rejection, but keeps unknown identities", async () => {
    const f = fixture(); f.restore(); const connection = f.reload(), http = connection.http;
    let first = true;
    connection.http = async (...args) => {
      const value = await http(...args);
      if (first) { first = false; return { outcome: "rejected", reason: "stale" }; }
      return value;
    };
    expect(await controlNativeInput(connection, "chat", "message", "cancel")).toEqual({ outcome: "rejected", reason: "stale" });
    expect(await controlNativeInput(connection, "chat", "message", "cancel")).toEqual({ outcome: "accepted", result: "cancelled" });
    expect(f.bodies[1].requestId).not.toBe(f.bodies[0].requestId);
  });
  it("persists each control identity across reconnect without resending text", async () => {
    const f = fixture();
    expect(await controlNativeInput(f.reload(), "chat", "message", "cancel")).toEqual({ outcome: "unknown", reason: "uncertain" });
    f.restore(); expect(await controlNativeInput(f.reload(), "chat", "message", "cancel")).toEqual({ outcome: "accepted", result: "cancelled" });
    expect(f.bodies[0]).toEqual(f.bodies[1]); expect(f.bodies[0]).not.toHaveProperty("text");
    await controlNativeInput(f.reload(), "chat", "message", "send-now");
    expect(f.bodies[2].requestId).not.toBe(f.bodies[0].requestId);
  });
});
