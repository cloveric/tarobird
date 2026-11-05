import { describe, expect, it, vi } from "vitest";
import { runSteeringCommand, steeringReceiptHint, steeringCommandFailure, steeringCommandNotice } from "../src/host-cli/steering.js";
import { runTasksCommand } from "../src/host-cli/tasks.js";

describe("headless native task controls", () => {
  it("lists live native tasks through the same conversation API", async () => {
    const request = vi.fn(async () => ({ supported: true, tasks: [] }));
    await runTasksCommand({ request }, "list", "chat", { bot: "bot" });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/tasks?botId=bot");
  });
  it("stops exactly one handle and returns its native receipt", async () => {
    const request = vi.fn(async () => ({ outcome: "accepted" })), receipts: string[] = [];
    expect(await runTasksCommand({ request }, "stop", "chat", { bot: "bot", task: "opaque_task", "request-id": "operation" }, id => receipts.push(id))).toEqual({ outcome: "accepted" });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/tasks", "POST", { botId: "bot", taskId: "opaque_task", requestId: "operation" });
    expect(receipts).toEqual(["operation"]);
  });
  it("forced recovery requires explicit confirmation and exact fence token", async () => {
    const request = vi.fn(async () => ({ outcome: "accepted" }));
    await expect(runTasksCommand({ request }, "recover", "chat", { bot: "bot", token: "fence" })).rejects.toThrow("--yes");
    expect(request).not.toHaveBeenCalled();
    await runTasksCommand({ request }, "recover", "chat", { bot: "bot", token: "fence", yes: true, "request-id": "recover" });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/tasks/recover", "POST", { botId: "bot", token: "fence", requestId: "recover" });
  });
  it("prints a recovery ID before a request and never retries ambiguous control", async () => {
    const request = vi.fn().mockRejectedValue(new Error("connection_lost")), receipts: string[] = [];
    await expect(runTasksCommand({ request }, "stop", "chat", { bot: "bot", task: "opaque_task" }, id => receipts.push(id))).rejects.toThrow("connection_lost");
    expect(receipts).toHaveLength(1); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([["list", { bot: "bot", task: "task" }], ["stop", { bot: "bot" }], ["all", { bot: "bot" }]])("rejects ambiguous %s options without network writes", async (operation, options) => {
    const request = vi.fn(); await expect(runTasksCommand({ request }, operation as string, "chat", options as { bot: string })).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
});

describe("headless exact-turn input", () => {
  it("explains an accepted no-op without changing the receipt, failing, or retrying", async () => {
    const request = vi.fn(async () => ({ outcome: "accepted", result: "nothing_waiting" }));
    const result = await runSteeringCommand({ request }, "send-now", "chat", { message: "original-input", "request-id": "control-id" });
    expect(result).toEqual({ outcome: "accepted", result: "nothing_waiting" });
    expect(steeringCommandFailure("send-now", result)).toBeUndefined();
    expect(steeringCommandNotice("send-now", result)).toContain("本次未改变任务");
    expect(steeringCommandNotice("send-now", result)).toContain("不代表模型已收到");
    expect(steeringCommandNotice("status", result)).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["send-now", "cancel"])("%s preserves the native control receipt and reports refusal or uncertainty without retry", async command => {
    for (const outcome of ["accepted", "rejected", "unknown"] as const) {
      const request = vi.fn(async () => ({ outcome }));
      const result = await runSteeringCommand({ request }, command, "chat", { message: "original-input", "request-id": "control-id" });
      expect(result).toEqual({ outcome });
      expect(Boolean(steeringCommandFailure(command, result))).toBe(outcome !== "accepted");
      if (outcome === "unknown") expect(steeringCommandFailure(command, result)).toContain("同一 --message");
      expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/inputs/original-input", "POST", { requestId: "control-id", action: command });
    }
  });
  it("names every subcommand and gives send-now/cancel their own recovery hint", async () => {
    const request = vi.fn();
    await expect(runSteeringCommand({ request }, "withdraw", "chat", { bot: "bot" })).rejects.toThrow(/send-now\|cancel CONVERSATION --message ID/);
    expect(request).not.toHaveBeenCalled();
    for (const command of ["send-now", "cancel"]) {
      const hint = steeringReceiptHint(command, "op");
      expect(hint).toContain("op"); expect(hint).toContain("--message"); expect(hint).not.toContain("原内容");
    }
    expect(steeringReceiptHint("send", "op")).toContain("原目标和原内容");
  });
  it("reads the same active target without creating a turn", async () => {
    const request = vi.fn(async () => ({ supported: true, targetId: "active", sendBehavior: "steer" }));
    expect(await runSteeringCommand({ request }, "status", "chat", { bot: "bot" })).toMatchObject({ targetId: "active" });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/steer?botId=bot&review=1");
  });
  it("reports a background-review target with the App's capability and no send-now", async () => {
    const request = vi.fn(async () => ({ supported: true, targetId: "review", targetKind: "background-review", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } }));
    expect(await runSteeringCommand({ request }, "status", "chat", { bot: "bot" })).toEqual({ supported: true, targetId: "review", targetKind: "background-review", sendBehavior: "steer", nativeInput: { sendNow: false, cancel: true, modelReceipt: true } });
  });
  it("prints its recovery ID before uncertain delivery without fetching another target", async () => {
    const receipts: string[] = [];
    const request = vi.fn(async () => { expect(receipts).toEqual(["receipt"]); throw new Error("lost"); });
    await expect(runSteeringCommand({ request }, "send", "chat", { bot: "bot", target: "exact", text: "Continue with this detail", "request-id": "receipt" }, id => receipts.push(id))).rejects.toThrow("lost");
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/steer", "POST", { botId: "bot", targetId: "exact", text: "Continue with this detail", requestId: "receipt" });
  });
  it("rejects missing targets and ignored status options before network access", async () => {
    const request = vi.fn();
    await expect(runSteeringCommand({ request }, "send", "chat", { bot: "bot", text: "hello" })).rejects.toThrow();
    await expect(runSteeringCommand({ request }, "status", "chat", { bot: "bot", text: "hello" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
