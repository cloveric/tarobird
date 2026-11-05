import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineStreamEvent, ScopedEngineEvent } from "../src/codex/adapter.js";
import type { RunScope } from "../src/client-protocol/run.js";
import { createScopedRunPresentation, finishScopedRunPresentation } from "../src/core/scoped-run-presentation.js";
import { createCoreRunCardController } from "../src/core/message-handler.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { deliverBackgroundTaskResponse } from "../src/core/background-task-delivery.js";
import * as delivery from "../src/core/delivery.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CoreChannelLike, CoreSendOptions } from "../src/core/types.js";

const root: RunScope = { id: "review-a", kind: "background", label: "Verify the report" };
function scoped(event: ScopedEngineEvent, scope = root, extra: Partial<Extract<EngineStreamEvent, { type: "scoped" }>> = {}): Extract<EngineStreamEvent, { type: "scoped" }> {
  return { type: "scoped", scope, origin: "bound", event, ...extra };
}
function fixture() {
  const messages: Array<{ id: string; to: string; raw: any; options?: CoreSendOptions }> = [];
  const channel: CoreChannelLike = {
    profile: "gateway", stream: vi.fn(), downloadResource: vi.fn(),
    send: vi.fn(async (to, raw, options) => { const id = `message_${messages.length}`; messages.push({ id, to, raw: structuredClone(raw), options }); return { messageId: id }; }),
    updateCard: vi.fn(async (id, card) => { const message = messages.find(m => m.id === id)!; message.raw = { card: structuredClone(card) }; }),
  };
  const context = { channel, chatId: "chat-a", conversationKey: "lark:chat-a", replyTo: "request-a", locale: "en" as const };
  return { channel, messages, context, presenter: createScopedRunPresentation(context) };
}
const finish = (f: ReturnType<typeof fixture>, extra = {}) => finishScopedRunPresentation(f.context, { type: "task_notification", scopeId: root.id, origin: "bound", status: "completed", text: "Final verified report", ...extra });
afterEach(() => { vi.useRealTimers(); });

describe("scoped run ownership and publication", () => {
  it("serializes concurrent first publication and final reuse without duplicate cards or stop actions", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = f.channel.send;
    f.channel.send = vi.fn(async (to, raw, options) => { await gate; return send(to, raw, options); });
    const started = f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "same", toolInput: { file_path: "report.md" } }));
    const text = f.presenter.apply(scoped({ type: "assistant_text", text: "Verification ", delta: true }));
    const result = f.presenter.apply(scoped({ type: "tool_result", toolUseId: "same", output: "Verified", exitCode: 0 }));
    const ended = f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
    const final = finish(f);
    await vi.waitFor(() => expect(f.channel.send).toHaveBeenCalledTimes(1));
    release(); await Promise.all([started, text, result, ended]); expect(await final).toBe(true);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.options?.replyTo).toBe("request-a");
    expect(f.messages[0]!.raw.card.appRun).toMatchObject({ background: true, summary: { phase: "done" } });
    expect(f.messages[0]!.raw.card.appScopedTask).toEqual({ version: 1, label: root.label, kind: "background" });
    expect(f.messages[0]!.raw.card.appRun.entries).toContainEqual(expect.objectContaining({ scope: root, callId: "same", status: "done", output: "Verified" }));
    expect(JSON.stringify(f.messages)).toContain("Final verified report");
    expect(JSON.stringify(f.messages)).not.toContain('"cctb_lark":"stop"');
    const before = JSON.stringify(f.messages);
    await f.presenter.apply(scoped({ type: "assistant_text", text: "STALE" }));
    expect(JSON.stringify(f.messages)).toBe(before);
  });

  it("coalesces progress for 100ms, preserves spaces, and flushes terminal evidence", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.presenter.apply(scoped({ type: "scope_status", status: "running" }));
    await f.presenter.apply(scoped({ type: "assistant_text", text: "First ", delta: true }));
    await f.presenter.apply(scoped({ type: "assistant_text", text: "sentence.", delta: true }));
    await vi.advanceTimersByTimeAsync(99); expect(f.channel.updateCard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(f.channel.updateCard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.messages[0]!.raw)).toContain("First sentence.");
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("delivering");
    expect(f.messages[0]!.raw.card.appRun.summary.endedAt).toBeUndefined();
    await finish(f); expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("done");
    const count = vi.mocked(f.channel.updateCard!).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); expect(f.channel.updateCard).toHaveBeenCalledTimes(count);
  });

  it("seals final capture before a slow first publication completes", async () => {
    vi.useFakeTimers(); const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), send = f.channel.send;
    f.channel.send = vi.fn(async (to, raw, options) => { await gate; return send(to, raw, options); });
    const started = f.presenter.apply(scoped({ type: "assistant_text", text: "Initial progress" }));
    const final = finish(f);
    await f.presenter.apply(scoped({ type: "assistant_text", text: "STALE PENDING DELTA", delta: true }));
    release(); await started; expect(await final).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.messages).toHaveLength(1); expect(JSON.stringify(f.messages)).toContain("Final verified report");
    expect(JSON.stringify(f.messages)).not.toContain("STALE PENDING DELTA");
    expect(f.channel.updateCard).toHaveBeenCalledTimes(1);
  });

  it("keeps foreground child evidence out of the answer and seeds a late detached process from that original callback", async () => {
    const f = fixture(), child: RunScope = { id: "child-a", kind: "subagent", parentCallId: "agent-a" };
    await withChannelProfile("gateway", async () => {
      const foreground = await createCoreRunCardController({ ...f.context, bridgeChatType: "private" });
      expect(foreground).toBeDefined();
      await foreground!.apply({ type: "assistant_text", text: "Parent answer" });
      await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "child-read" }, child), { foreground });
      await f.presenter.apply(scoped({ type: "thinking", text: "Public child thought" }, child), { foreground });
      await foreground!.finish("Parent answer");
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0]!.raw.card.appRun.entries).toContainEqual(expect.objectContaining({ scope: child, text: "Public child thought" }));
      const mainCard = JSON.stringify(f.messages[0]!.raw);
      await f.presenter.apply(scoped({ type: "tool_result", toolUseId: "child-read", output: "Late child receipt" }, child), { foreground });
      await f.presenter.apply(scoped({ type: "scope_status", status: "done" }, child), { foreground });
      expect(f.messages).toHaveLength(2);
      expect(JSON.stringify(f.messages[0]!.raw)).toBe(mainCard);
      expect(f.messages[1]!.raw.card.appRun.entries).toContainEqual(expect.objectContaining({ scope: child, text: "Public child thought" }));
      expect(f.messages[1]!.raw.card.appRun.entries).toContainEqual(expect.objectContaining({ scope: child, output: "Late child receipt" }));
      expect(f.messages[1]!.raw.card.appRun.summary.phase).toBe("done");
      expect(JSON.stringify(f.messages[1]!.raw.card)).toContain("Subagent execution has finished");
    });
  });

  it("does not let another callback or conversation adopt an existing scope", async () => {
    const f = fixture(); await f.presenter.apply(scoped({ type: "assistant_text", text: "Owner A" }));
    const other = createScopedRunPresentation({ ...f.context, replyTo: "request-b" });
    await other.apply(scoped({ type: "assistant_text", text: "WRONG OWNER" }));
    expect(await finishScopedRunPresentation({ ...f.context, replyTo: "request-b" }, { type: "task_notification", scopeId: root.id, origin: "bound", text: "WRONG FINAL" })).toBe(false);
    const anotherChat = createScopedRunPresentation({ ...f.context, chatId: "chat-b", conversationKey: "lark:chat-b", replyTo: "request-b" });
    await anotherChat.apply(scoped({ type: "assistant_text", text: "Separate conversation" }));
    await anotherChat.apply(scoped({ type: "scope_status", status: "stopped" }));
    await finish(f);
    expect(f.messages).toHaveLength(2); expect(JSON.stringify(f.messages)).not.toContain("WRONG");
    expect(f.messages[0]!.to).toBe("chat-a"); expect(f.messages[1]!.to).toBe("chat-b");
  });

  it("keeps unattributed scopes unquoted and quietly closes suppressed or merged results", async () => {
    const f = fixture(); await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }, root, { origin: "unattributed" }));
    expect(f.messages[0]!.options?.replyTo).toBeUndefined();
    expect(await finishScopedRunPresentation({ ...f.context, replyTo: undefined }, { type: "task_notification", scopeId: root.id, origin: "unattributed", suppressUserDelivery: true, text: "HIDDEN ENGINE SUMMARY" })).toBe(true);
    expect(f.messages).toHaveLength(1); expect(JSON.stringify(f.messages)).not.toContain("HIDDEN ENGINE SUMMARY");
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("partial");
  });

  it("does not report final delivery success when the card update fails or artifacts are unconfirmed", async () => {
    const f = fixture(); await f.presenter.apply(scoped({ type: "assistant_text", text: "Working" }));
    f.channel.updateCard = vi.fn().mockRejectedValue(new Error("publication failed"));
    expect(await finish(f)).toBe(false);
    const g = fixture(); await g.presenter.apply(scoped({ type: "assistant_text", text: "Working" }));
    expect(await finishScopedRunPresentation(g.context, { type: "task_notification", scopeId: root.id, origin: "bound", text: "Generated report", status: "completed" }, false)).toBe(true);
    expect(g.messages[0]!.raw.card.appRun.summary.phase).toBe("partial");
    expect(g.messages[0]!.raw.card.appBackgroundTask.delivery).toBe("unconfirmed");
  });

  it("settles a successfully completed empty review without publishing hidden text or creating an absent report", async () => {
    const f = fixture();
    expect(await finish(f, { suppressUserDelivery: true, reason: "no_result" })).toBe(false);
    expect(f.messages).toHaveLength(0);
    await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
    expect(await finish(f, { suppressUserDelivery: true, reason: "no_result", text: "HIDDEN" })).toBe(true);
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("done");
    expect(JSON.stringify(f.messages)).toContain("No separate reply was generated");
    expect(JSON.stringify(f.messages)).not.toContain("HIDDEN");
  });

  it("keeps nested scope phases and counts separate and preserves cancelled final status", async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "root_tool" }));
    const child: RunScope = { id: "nested_child", kind: "subagent", parentId: root.id };
    await f.presenter.apply(scoped({ type: "permission_request", toolName: "AskUserQuestion", toolUseId: "child_question" }, child, { rootScope: root }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }, child, { rootScope: root }));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.messages[0]!.raw.card.appRun.summary).toMatchObject({ phase: "working", count: 1, current: { name: "Read" } });
    await finish(f, { status: "cancelled" });
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("stopped");
  });

  it("waits for a subagent's terminal status after result text and preserves its failure", async () => {
    const f = fixture(), child: RunScope = { id: "failed_child", kind: "subagent" };
    await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }, child));
    await f.presenter.apply(scoped({ type: "result", text: "The child could not finish" }, child));
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("delivering");
    await f.presenter.apply(scoped({ type: "scope_status", status: "error" }, child));
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("error");
    expect(JSON.stringify(f.messages[0]!.raw)).not.toContain("Subagent execution has finished");
  });

  it.each([
    [undefined, undefined, "partial"], ["running", undefined, "partial"], ["unrecognized", undefined, "partial"],
    ["completed", undefined, "done"], ["done", undefined, "done"], ["success", undefined, "done"],
    ["failed", undefined, "error"], ["killed", undefined, "stopped"], ["cancelled", undefined, "stopped"],
    [undefined, "engine_exit", "stopped"], ["completed", "engine_exit", "stopped"],
  ] as const)("only claims a confirmed terminal status (%s, %s)", async (status, reason, phase) => {
    const f = fixture(); await f.presenter.apply(scoped({ type: "scope_status", status: "running" }));
    expect(await finish(f, { status, reason })).toBe(true);
    expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe(phase);
    if (phase !== "done") expect(JSON.stringify(f.messages[0]!.raw.card)).not.toContain("Background task completed");
  });

  it("keeps 32 live roots, degrades new cards, and still forwards unretained foreground evidence", async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: `r${i}` }, i === 0 ? root : { ...root, id: `live_${i}` }));
    await f.presenter.apply(scoped({ type: "assistant_text", text: "Too many independent cards" }, { ...root, id: "overflow" }));
    expect(f.messages).toHaveLength(32);
    expect(f.messages.every(m => m.raw.card.appRun.summary.phase === "working")).toBe(true);
    const foreground = { apply: vi.fn(async (_event: EngineStreamEvent) => {}) }, child: RunScope = { id: "unretained_child", kind: "subagent" };
    for (const event of [{ type: "tool_use", toolName: "Read", toolUseId: "child_read" }, { type: "tool_result", toolUseId: "child_read", output: "Child receipt" }, { type: "scope_status", status: "done" }] as const) {
      await f.presenter.apply(scoped(event, child), { foreground });
    }
    expect(foreground.apply).toHaveBeenCalledTimes(3);
    await f.presenter.apply(scoped({ type: "tool_result", toolUseId: "r0", output: "Original root stayed live" }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "running" }, { ...root, id: "still_overflow" }));
    expect(f.messages).toHaveLength(32); // delivering still owns its slot
    await finish(f);
    expect(f.messages[0]!.raw.card.appRun.entries).toContainEqual(expect.objectContaining({ callId: "r0", status: "done", output: "Original root stayed live" }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "running" }, { ...root, id: "after_completion" }));
    expect(f.messages).toHaveLength(33); // only completed roots are reclaimable
  });

  it("reclaims attached terminal seeds immediately and labels standalone foreground children accurately", async () => {
    const f = fixture(), foreground = { apply: vi.fn(async (_event: EngineStreamEvent) => {}) };
    for (let i = 0; i < 40; i++) {
      const child: RunScope = { id: `attached_${i}`, kind: "subagent" };
      await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }, child), { foreground });
      await f.presenter.apply(scoped({ type: "scope_status", status: "done" }, child), { foreground });
    }
    expect(foreground.apply).toHaveBeenCalledTimes(80); expect(f.messages).toHaveLength(0);
    const child: RunScope = { id: "standalone_foreground", kind: "subagent" };
    await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }, child));
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }, child));
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]!.raw.card.appBackgroundTask).toBeUndefined();
    expect(JSON.stringify(f.messages[0]!.raw.card)).toContain("Subagent process");
    expect(JSON.stringify(f.messages[0]!.raw.card)).not.toContain("Background task");
    expect(f.messages[0]!.raw.card.appRun.background).toBe(true); // remains read-only
  });

  it("closes an existing delivering card when report delivery throws without creating another card", async () => {
    const f = fixture(), temp = await mkdtemp(path.join(os.tmpdir(), "scoped-failed-report-"));
    await f.presenter.apply(scoped({ type: "scope_status", status: "running" }));
    await f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
    const failedDelivery = vi.spyOn(delivery, "deliverCoreResponse").mockRejectedValueOnce(new Error("delivery unavailable"));
    try {
      await expect(deliverBackgroundTaskResponse({ ...f.context, runtime: createCoreServiceRuntime(), stateDir: temp, text: "Final report" },
        { type: "task_notification", scopeId: root.id, origin: "bound", status: "completed", text: "Final report" }, "en")).rejects.toThrow("delivery unavailable");
      expect(f.messages).toHaveLength(1);
      expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("partial");
      expect(JSON.stringify(f.messages[0]!.raw.card)).toContain("could not be fully delivered");
    } finally { failedDelivery.mockRestore(); await rm(temp, { recursive: true, force: true }); }
  });

  it("marks a collected result done without claiming an empty report or re-executing its content", async () => {
    const f = fixture(); await f.presenter.apply(scoped({ type: "scope_status", status: "running" }));
    const actions = vi.spyOn(delivery, "deliverCoreResponse").mockImplementation(async () => { throw new Error("suppressed actions must not execute"); });
    try {
      await deliverBackgroundTaskResponse({ ...f.context, runtime: createCoreServiceRuntime(), stateDir: "/unused", text: "HIDDEN COLLECTED CONTENT" },
        { type: "task_notification", scopeId: root.id, origin: "bound", status: "completed", suppressUserDelivery: true, text: "HIDDEN COLLECTED CONTENT" }, "en");
      expect(actions).not.toHaveBeenCalled();
      expect(f.messages[0]!.raw.card.appRun.summary.phase).toBe("done");
      expect(JSON.stringify(f.messages[0]!.raw.card)).toContain("collected into the main turn");
      expect(JSON.stringify(f.messages[0]!.raw.card)).not.toContain("HIDDEN COLLECTED CONTENT");
    } finally { actions.mockRestore(); }
  });

  it("keeps unsupported Hubs silent during progress and sends the final report through the existing fallback", async () => {
    const f = fixture(), temp = await mkdtemp(path.join(os.tmpdir(), "scoped-legacy-hub-"));
    Object.assign(f.channel, { supportsScopedRunPresentation: () => false });
    try {
      await f.presenter.apply(scoped({ type: "tool_use", toolName: "Read", toolUseId: "r" }));
      await f.presenter.apply(scoped({ type: "scope_status", status: "done" }));
      expect(f.messages).toHaveLength(0);
      await withChannelProfile("gateway", () => deliverBackgroundTaskResponse({ ...f.context, runtime: createCoreServiceRuntime(), stateDir: temp, text: "Final legacy report" },
        { type: "task_notification", scopeId: root.id, origin: "bound", status: "completed", text: "Final legacy report" }, "en"));
      expect(f.messages).toHaveLength(1); expect(f.messages[0]!.raw.card.appRun).toBeUndefined();
      expect(JSON.stringify(f.messages[0]!.raw.card)).toContain("Final legacy report");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("falls back to one final report after an update failure without delivering its attachment twice", async () => {
    const f = fixture(), temp = await mkdtemp(path.join(os.tmpdir(), "scoped-report-delivery-"));
    try {
      const artifact = path.join(temp, "report.txt"); await writeFile(artifact, "verified artifact");
      await f.presenter.apply(scoped({ type: "assistant_text", text: "Checking report" }));
      f.channel.updateCard = vi.fn().mockRejectedValue(new Error("cannot patch"));
      const text = `Final report with attachment\n[send-file:${artifact}]`;
      await withChannelProfile("gateway", () => deliverBackgroundTaskResponse({ ...f.context,
        runtime: createCoreServiceRuntime(), stateDir: temp, workspaceOverride: temp, requestOutputDir: temp, text,
      }, { type: "task_notification", scopeId: root.id, origin: "bound", status: "completed", text }, "en"));
      expect(f.messages.filter(m => m.raw.file)).toHaveLength(1);
      expect(f.messages.filter(m => JSON.stringify(m.raw.card ?? {}).includes("Final report with attachment"))).toHaveLength(1);
      expect(f.messages).toHaveLength(3);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("marks a legacy background report when its attachment cannot be delivered", async () => {
    const f = fixture(), temp = await mkdtemp(path.join(os.tmpdir(), "background-static-delivery-"));
    const send = f.channel.send;
    f.channel.send = async (to, raw, options) => { if (raw.file) throw new Error("upload unavailable"); return send(to, raw, options); };
    try {
      const artifact = path.join(temp, "report.txt"); await writeFile(artifact, "artifact");
      const text = `Final legacy report\n[send-file:${artifact}]`;
      await withChannelProfile("gateway", () => deliverBackgroundTaskResponse({ ...f.context, runtime: createCoreServiceRuntime(), stateDir: temp, workspaceOverride: temp, requestOutputDir: temp, text },
        { type: "task_notification", origin: "bound", status: "completed", text }, "en"));
      const card = f.messages.find(message => message.raw.card?.appBackgroundTask)?.raw.card;
      expect(card?.appBackgroundTask).toMatchObject({ status: "done", delivery: "unconfirmed" });
      expect(card.appRun).toBeUndefined();
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
