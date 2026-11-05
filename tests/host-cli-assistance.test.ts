import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as endpoint from "../src/host-cli/bot-messages.js";
import { HostCliError } from "../src/host-cli/client.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { runTicketsCommand } from "../src/host-cli/tickets.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { requestTicketAssistanceSchema } from "../src/client-protocol/dispatch-assistance.js";

let root: string;
const post = vi.fn(async (..._args: unknown[]) => ({ assistId: "assist_fixture", state: "requested", remaining: 0, next: "end_turn" }));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "assist-cli-"));
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", "worker");
  vi.stubEnv("TAROBOT_MESSAGE_ID", undefined);
  post.mockClear();
  vi.spyOn(endpoint, "instanceEndpoint").mockResolvedValue({ post });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("parses a helper task through the real CLI entry without inventing a parent or new identity", async () => {
  await initializeHost(root, "CLI fixture");
  const file = path.join(root, "helper.txt"); await writeFile(file, "Check the cancellation race.\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runHostCli(["tickets", "assist", "--engine", "claude", "--model", "claude-opus-5-5", "--effort", "medium", "--text-file", file, "--note", "Independent review", "--request-id", "same-request", "--context-message", "msg_current", "--state-dir", root, "--json"]);
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/instance/tickets", {
    operation: "assist", contextMessage: "msg_current", data: { requestId: "same-request", engine: "claude", model: "claude-opus-5-5", effort: "medium", text: "Check the cancellation race.", note: "Independent review" },
  });
  expect(log.mock.calls.flat().join(" ")).toContain('"state": "requested"');
});

it("refuses an unscoped helper request and owner-mode helper invocation before network access", async () => {
  await expect(runTicketsCommand(root, "assist", undefined, { engine: "codex", text: "Review", note: "Need a review" }, () => {})).rejects.toThrow("dispatch_context_not_active");
  expect(endpoint.instanceEndpoint).not.toHaveBeenCalled();
  vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", undefined); vi.stubEnv("TAROBOT_INSTANCE", undefined);
  await expect(runTicketsCommand(root, "assist", undefined, { engine: "codex", text: "Review", note: "Need a review" }, () => {})).rejects.toThrow("Worker");
  expect(post).not.toHaveBeenCalled();
});

it("keeps an uncertain request unchanged and never retries with a fresh ID", async () => {
  const failure = new HostCliError("cli_request_timeout"); post.mockRejectedValueOnce(failure);
  const receipt = vi.fn();
  await expect(runTicketsCommand(root, "assist", undefined, { engine: "deepseek", text: "Check", note: "Review", "request-id": "keep-id", "context-message": "msg_current" }, receipt)).rejects.toBe(failure);
  expect(post).toHaveBeenCalledTimes(1); expect(receipt).toHaveBeenCalledExactlyOnceWith("keep-id");
});

it("uses scoped status and dispatcher audit operations, without a worker-supplied parent", async () => {
  await runTicketsCommand(root, "assist-status", undefined, { "context-message": "msg_current" }, () => {});
  expect(post).toHaveBeenLastCalledWith("/api/instance/tickets", { operation: "assist-status", contextMessage: "msg_current", data: {} });
  await runTicketsCommand(root, "assists", "ticket_1", {}, () => {});
  expect(post).toHaveBeenLastCalledWith("/api/instance/tickets", { operation: "assists", data: { ticketId: "ticket_1" } });
  await expect(runTicketsCommand(root, "assist", "foreign_ticket", { engine: "codex", text: "Task", note: "Reason", "context-message": "msg_current" }, () => {})).rejects.toThrow("主机自动绑定");
  expect(post).toHaveBeenCalledTimes(2);
});

it("carries an explicit zero allowance and rejects invalid allowances before sending", async () => {
  const base = { engine: "codex", "context-message": "msg_current", "request-id": "dispatch_1" };
  await initializeHost(root, "CLI dispatch fixture");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await runHostCli(["tickets", "dispatch", "ticket_1", "--engine", "codex", "--assist", "0", "--context-message", "msg_current", "--request-id", "dispatch_1", "--state-dir", root, "--json"]);
  expect(post).toHaveBeenLastCalledWith("/api/instance/tickets", { operation: "dispatch", contextMessage: "msg_current", data: { ticketId: "ticket_1", requestId: "dispatch_1", engine: "codex", assist: 0 } });
  for (const assist of ["-1", "3", "0.5", "NaN"]) await expect(runTicketsCommand(root, "dispatch", "ticket_1", { ...base, assist }, () => {})).rejects.toThrow();
  expect(post).toHaveBeenCalledTimes(1);
});

it("bounds helper payloads and rejects all caller-selected parent or permission fields", () => {
  const data = { requestId: "request", engine: "codex", text: "Task", note: "Reason" };
  for (const extra of [{ ticketId: "other" }, { parentAttemptId: "other" }, { force: true }, { assist: 2 }, { workspace: "/private" }, { text: "x".repeat(12001) }, { note: "x".repeat(601) }, { model: "--option" }]) {
    expect(requestTicketAssistanceSchema.safeParse({ ...data, ...extra }).success).toBe(false);
  }
});
