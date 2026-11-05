import { describe, expect, it, vi } from "vitest";
import { runChangesCommand } from "../src/host-cli/changes.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runChangesSchema } from "../src/client-protocol/run-changes.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";

const list = { scope: "current_workspace", conversationId: "chat", botId: "bot", head: null, capturedAt: 1, state: "no_head", notes: ["no_head"], items: [], truncated: false };
function client(result: unknown = list, capabilities = ["workspace.diff.v1"]) {
  return { request: vi.fn().mockResolvedValue(result), ready: { serverCapabilities: capabilities } } as Parameters<typeof runChangesCommand>[0] & { request: ReturnType<typeof vi.fn> };
}
describe("headless changes use the same authenticated API", () => {
  it("lists recorded changes through the same message API and never falls back to workspace", async () => {
    const evidence = runChangesSchema.parse({ scope: "recorded_run", messageId: "msg", conversationId: "chat", botId: "bot", runId: "run", revision: "a".repeat(64), state: "not_recorded", partial: false, unavailable: 0, childEdits: 0, items: [], truncated: false });
    const controller = client(evidence, ["runs.changes.v1"]);
    expect(await runChangesCommand(controller, "list", "chat", { bot: "bot", message: "msg" })).toEqual(evidence);
    expect(controller.request).toHaveBeenCalledExactlyOnceWith("/api/messages/msg/changes?conversationId=chat&botId=bot");
    const old = client(); await expect(runChangesCommand(old, "list", "chat", { bot: "bot", message: "msg" })).rejects.toThrow("更新主机"); expect(old.request).not.toHaveBeenCalled();
    const bad = client(evidence, ["runs.changes.v1"]); await expect(runChangesCommand(bad, "show", "chat", { bot: "bot", message: "msg", operation: "bad" })).rejects.toThrow(); expect(bad.request).not.toHaveBeenCalled();
  });
  it("passes a literal star filename through the real local controller and Hub route", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "diff-cli-"));
    const hub = await HubServer.start({ stateDir: directory });
    const closeControl = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    let controller: LocalHostClient | undefined;
    try {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Fixture','fixture')");
      const conversation = await hub.store.createConversation("owner", ["bot"], "Literal paths", "literal-paths");
      const file = { path: "src/a*b..txt", status: "untracked" as const, staged: false, unstaged: true, generated: false, kind: "file" as const, protected: false, additions: 1, deletions: 0 };
      const { items: _items, ...scope } = list;
      const detail = { ...scope, scope: "current_workspace" as const, state: "no_head" as const, notes: ["no_head" as const], conversationId: conversation.id, file, binary: false, metadataOnly: false, reason: null, preview: false, additions: 1, deletions: 0, hunks: [] };
      const read = vi.spyOn(hub.workspaceDiff, "file").mockResolvedValue(detail);
      controller = await LocalHostClient.connect(directory, { enroll: true });
      expect(await runChangesCommand(controller, "show", conversation.id, { bot: "bot", path: file.path })).toEqual(detail);
      expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0]![1]).toBe(file.path);
      const record = createRunRecord();
      recordRunEvent(record, { type: "tool_use", toolName: "Edit", toolUseId: "edit" });
      recordRunEvent(record, { type: "tool_result", toolUseId: "edit", changes: [{ path: "/no-workspace/src/app.ts", diff: "@@ -1 +1 @@\n-old\n+saved" }] });
      await new RunJournal(hub.store).write("bot", { conversationId: conversation.id, messageId: "msg", runId: record.id, entries: record.entries });
      await hub.store.publishBotMessage("bot", { id: "msg", conversationId: conversation.id, status: "complete", blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(record, "done"))) } }] });
      const saved = runChangesSchema.parse(await runChangesCommand(controller, "list", conversation.id, { bot: "bot", message: "msg" }));
      const code = await runChangesCommand(controller, "show", conversation.id, { bot: "bot", message: "msg", path: saved.items[0]!.key, operation: `${record.entries[0]!.seq}-0` });
      expect(code).toMatchObject({ scope: "recorded_run", runId: record.id });
      expect(JSON.stringify(code)).toContain("saved"); expect(read).toHaveBeenCalledOnce();
    } finally { controller?.close(); await closeControl(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it("lists the explicit conversation and Bot without starting another host", async () => {
    const controller = client();
    expect(await runChangesCommand(controller, "list", "chat", { bot: "bot" })).toEqual(list);
    expect(controller.request).toHaveBeenCalledExactlyOnceWith("/api/conversations/chat/changes?botId=bot");
  });
  it("encodes literal Unicode and punctuation filenames for the existing controller", async () => {
    const file = { path: "src/中文 file..ts", status: "untracked", staged: false, unstaged: true, generated: false, kind: "file", protected: false, additions: 1, deletions: 0 };
    const detail = { ...list, file, binary: false, metadataOnly: false, reason: null, preview: false, additions: 1, deletions: 0, hunks: [] };
    delete (detail as Partial<typeof list>).items;
    const controller = client(detail);
    await runChangesCommand(controller, "show", "chat", { bot: "bot", path: file.path, preview: true });
    const route = controller.request.mock.calls[0]![0] as string;
    expect(route).not.toContain(".."); expect(new URL("http://localhost" + route).searchParams.get("path")).toBe(file.path);
    expect(route).toContain("preview=1");
  });
  it.each([
    ["list", "chat", { bot: "bot", path: "file" }], ["list", "chat", { bot: "bot", preview: true }],
    ["show", "chat", { bot: "bot" }], ["show", "chat", { bot: "bot", path: "../secret" }],
    ["list", undefined, { bot: "bot" }], ["list", "chat", {}], ["edit", "chat", { bot: "bot" }],
  ] as const)("rejects ambiguous or invalid %s arguments before requests", async (operation, conversation, options) => {
    const controller = client(); await expect(runChangesCommand(controller, operation, conversation, options)).rejects.toThrow(); expect(controller.request).not.toHaveBeenCalled();
  });
  it("shows an update requirement for an old host and does not automatically retry", async () => {
    const old = client(list, []); await expect(runChangesCommand(old, "list", "chat", { bot: "bot" })).rejects.toThrow("更新主机"); expect(old.request).not.toHaveBeenCalled();
    const failed = client(); failed.request.mockRejectedValue(new Error("connection_lost"));
    await expect(runChangesCommand(failed, "list", "chat", { bot: "bot" })).rejects.toThrow("connection_lost"); expect(failed.request).toHaveBeenCalledTimes(1);
  });
});
