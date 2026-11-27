import { expect, it, vi } from "vitest";
import { historyCommandFailure, runHistoryCommand } from "../src/host-cli/history.js";
import { HOST_CLI_HELP } from "../src/host-cli/cli.js";
const operation = { requestId: "request", operationId: "operation", state: "unknown", sourceRevision: "revision", reason: "uncertain" };
it("uses the shared owner API and keeps unknown status a GET", async () => {
  const request = vi.fn(async () => operation), client = { request, supports: () => true };
  expect(await runHistoryCommand(client as any, "fork", "chat", { bot: "bot", revision: "revision", requestId: "request" })).toEqual(operation);
  expect(request.mock.calls[0]).toEqual(["/api/conversations/chat/history/operations?sideReason=1", "POST", { botId: "bot", requestId: "request", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } }]);
  await runHistoryCommand(client as any, "status", "chat", { bot: "bot", requestId: "request" });
  expect(request.mock.calls[1]).toEqual(["/api/conversations/chat/history/operations/request?botId=bot&sideReason=1"]);
  await runHistoryCommand(client as any, "reconcile", "chat", { bot: "bot", action: "fork", revision: "revision", requestId: "request" });
  expect(request.mock.calls[2]).toEqual(["/api/conversations/chat/history/operations/request/reconcile?sideReason=1", "POST", { botId: "bot", requestId: "request", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } }]);
  expect(HOST_CLI_HELP).toContain("history status");
});
it("rejects missing explicit operation identity and old Hosts before sending", async () => {
  const request = vi.fn(), client = { request, supports: () => true };
  await expect(runHistoryCommand(client as any, "rewind", "chat", { bot: "bot", anchor: "anchor" })).rejects.toThrow("--request-id");
  await expect(runHistoryCommand({ ...client, supports: () => false } as any, "snapshot", "chat", { bot: "bot" })).rejects.toThrow("更新主机");
  expect(request).not.toHaveBeenCalled();
});
it("gives rejected and unconfirmed changes a failure message, so the CLI exits non-zero like steer send", () => {
  const result = (state: string, reason?: string) => ({ requestId: "request", operationId: "operation", sourceRevision: "revision", state, ...(reason ? { reason } : {}) }) as any;
  for (const command of ["fork", "rewind", "reconcile"]) {
    expect(historyCommandFailure(command, result("applied"))).toBeUndefined();
    expect(historyCommandFailure(command, result("rejected", "source_changed"))).toContain("未执行");
    expect(historyCommandFailure(command, result("rejected", "source_changed"))).toContain("source_changed");
    expect(historyCommandFailure(command, result("unknown", "uncertain"))).toContain("不要换编号");
    expect(historyCommandFailure(command, result("pending"))).toContain("不要换编号");
  }
  // Reads only report: their result is the answer, not a failed change.
  for (const command of ["status", "snapshot", "anchors"]) expect(historyCommandFailure(command, result("rejected", "busy"))).toBeUndefined();
  expect(HOST_CLI_HELP).toMatch(/history[^\n]*\n[^\n]*退出码/);
});
