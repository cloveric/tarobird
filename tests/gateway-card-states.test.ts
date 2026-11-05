import { afterEach, expect, it, vi } from "vitest";
import { requestCoreApproval, handleCoreCardAction } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import type { CoreChannelLike } from "../src/core/types.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { blocksText } from "../src/client-protocol/index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deliverCoreResponse } from "../src/core/delivery.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const runtime = createCoreServiceRuntime(), abort = new AbortController(); const cards = new Map<string, unknown>();
  let serial = 0;
  const channel: CoreChannelLike = {
    profile: "gateway", send: async (_to, input) => { const id = `card_${++serial}`; if (typeof input === "object" && input && "card" in input) cards.set(id, input.card); return { messageId: id }; },
    stream: async () => { throw new Error("unexpected_stream"); }, updateCard: async (id, card) => { cards.set(id, card); }, recallMessage: async (id) => { cards.delete(id); }, downloadResource: async () => Buffer.alloc(0),
  };
  const request = (toolName = "AskUserQuestion") => withChannelProfile("gateway", () => requestCoreApproval({ channel, runtime, chatId: "fixture", abortSignal: abort.signal,
    request: { engine: "claude", toolName, toolInput: toolName === "AskUserQuestion" ? { questions: [{ header: "功能", question: "选择功能", multiSelect: true, required: true, minSelections: 2, maxSelections: 2, options: [{ label: "搜索" }, { label: "导出" }] }] } : { command: "echo fixture" } } }));
  const action = (value: unknown, form?: unknown) => withChannelProfile("gateway", () => handleCoreCardAction({ channel, runtime, event: { messageId: [...cards.keys()].at(-1)!, chatId: "fixture", action: { value, ...(form ? { form_value: form } : {}) } } }));
  const gold = (name: string, raw: unknown) => expect(translateCard(JSON.parse(JSON.stringify(raw).replaceAll([...runtime.pendingApprovals.keys()][0] ?? "not-an-id", "request_fixture")))).toMatchSnapshot(name);
  return { runtime, abort, cards, channel, request, action, gold };
}

it.each(["AskUserQuestion", "Bash"])("captures %s timeout and interrupted private constructors through their native lifecycle", async (tool) => {
  vi.useFakeTimers();
  for (const reason of ["timeout", "interrupted"] as const) {
    const f = fixture(); const pending = f.request(tool); await vi.waitFor(() => expect([...f.runtime.pendingApprovals.values()][0]?.managedCard?.native).toBe(true));
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(29 * 60 * 1000 + 1); else f.abort.abort();
    await pending; await vi.waitFor(() => expect(blocksText([translateCard(f.cards.get("card_1"))])).toMatch(/超时|取消/));
    f.gold(`${tool}_${reason}`, f.cards.get("card_1"));
  }
});

it("captures the fresh retry form, retired form and submitted summary without CardKit", async () => {
  const f = fixture(); const pending = f.request();
  try {
    await vi.waitFor(() => expect([...f.runtime.pendingApprovals.values()][0]?.managedCard).toBeDefined()); const id = [...f.runtime.pendingApprovals.keys()][0]!;
    const value = { cctb_lark: "ask_user_question", action: "form_submit", requestId: id };
    await f.action(value, { q0: ["0"] });
    await vi.waitFor(() => expect(blocksText([translateCard(f.cards.get("card_1"))])).toContain("新表单"));
    f.gold("question_retry_sent", f.cards.get("card_1")); f.gold("question_retry_form", f.cards.get("card_2"));
    await f.action(value, { q0: ["0", "1"] }); expect(await pending).toMatchObject({ behavior: "allow" });
    await vi.waitFor(() => expect(blocksText([translateCard(f.cards.get("card_2"))])).toContain("已提交")); f.gold("question_submitted", f.cards.get("card_2"));
  } finally { f.abort.abort(); await pending; }
});

it("closes a replacement form whose native send receipt arrives after cancellation", async () => {
  const f = fixture(); const pending = f.request(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await vi.waitFor(() => expect([...f.runtime.pendingApprovals.values()][0]?.managedCard).toBeDefined()); const id = [...f.runtime.pendingApprovals.keys()][0]!;
    const send = f.channel.send; f.channel.send = async (...args) => { const receipt = await send(...args); await gate; return receipt; };
    const retry = f.action({ cctb_lark: "ask_user_question", action: "form_submit", requestId: id }, { q0: [] });
    await vi.waitFor(() => expect(f.cards.size).toBe(2)); f.abort.abort(); await pending; release(); await retry;
    for (const card of f.cards.values()) expect(blocksText([translateCard(card)])).toContain("选择已取消");
  } finally { release(); f.abort.abort(); await pending; }
});

it.each(["allow_once", "allow_session", "deny"])("captures the resolved approval constructor for %s", async (decision) => {
  const f = fixture(); const pending = f.request("Bash");
  try {
    await vi.waitFor(() => expect([...f.runtime.pendingApprovals.values()][0]?.managedCard).toBeDefined()); const id = [...f.runtime.pendingApprovals.keys()][0]!;
    expect(await f.action({ cctb_lark: "approval", decision, requestId: id })).toBe(true); await pending;
    await vi.waitFor(() => expect(blocksText([translateCard(f.cards.get("card_1"))])).toMatch(/已允许|已拒绝/));
    const normalized = JSON.parse(JSON.stringify(f.cards.get("card_1")).replaceAll(id, "request_fixture")); f.gold(`approval_${decision}`, normalized);
  } finally { f.abort.abort(); await pending; }
});

it.each(["choice", "continue_archive"])("captures the private %s acknowledgement constructor through the shared dispatcher", async (kind) => {
  const f = fixture(); const root = await mkdtemp(path.join(os.tmpdir(), "card-terminal-")); const engine = vi.fn(async () => ({ text: "Fixture complete" }));
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", workspacePath: root }));
    if (kind === "choice") await withChannelProfile("gateway", () => deliverCoreResponse({ channel: f.channel, runtime: f.runtime, stateDir: root, chatId: "fixture", conversationKey: "lark:fixture", bridgeChatType: "private", bridgeChatId: 42, text: '[tool:{"name":"lark.choice","payload":{"title":"选择","options":[{"label":"继续","value":"continue"}]}}]' }));
    expect(await withChannelProfile("gateway", () => handleCoreCardAction({ channel: f.channel, runtime: f.runtime, stateDir: root, bridge: { handleAuthorizedMessage: engine }, event: { messageId: kind === "choice" ? "card_1" : "original_archive", chatId: "fixture", operator: { openId: "fixture_user" }, action: { value: { cctb_lark: kind, conversationKey: "lark:fixture", bridgeChatType: "private", ...(kind === "choice" ? { label: "继续", value: "continue" } : { uploadId: "upload_missing" }) } } } }))).toBe(true);
    // The callback acknowledges before its queued turn finishes. Drain that
    // turn rather than racing the generic one-second waitFor deadline.
    await f.runtime.chatQueue.enqueue("lark:fixture", async () => undefined);
    await vi.waitFor(() => expect(blocksText([translateCard(f.cards.get("card_1"))])).toContain(kind === "choice" ? "已收到选择" : "已收到继续请求"));
    f.gold(`${kind}_submitted`, f.cards.get("card_1"));
    if (kind === "choice") expect(engine).toHaveBeenCalledTimes(1); else expect(engine).not.toHaveBeenCalled();
  } finally {
    f.abort.abort();
    await f.runtime.chatQueue.enqueue("lark:fixture", async () => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
