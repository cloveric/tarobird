import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineApprovalScopes } from "../src/codex/adapter.js";
import { requestCoreApproval, handleCoreApprovalTextCommand, handleCoreCardAction } from "../src/core/card-actions.js";
import { renderCoreApprovalCard } from "../src/core/card-renderer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreChannelLike } from "../src/core/types.js";

const controllers: AbortController[] = [];
afterEach(() => { controllers.splice(0).forEach((c) => c.abort()); });
function setup(approvalScopes: EngineApprovalScopes) {
  const channel = { send: vi.fn<CoreChannelLike["send"]>(async () => ({ messageId: "card" })), stream: vi.fn(), downloadResource: vi.fn() } satisfies CoreChannelLike;
  const runtime = createCoreServiceRuntime(), controller = new AbortController(); controllers.push(controller);
  const result = requestCoreApproval({ channel, runtime, chatId: "chat", conversationKey: "lark:chat", abortSignal: controller.signal,
    request: { engine: "codex", toolName: "fixture", toolInput: {}, approvalScopes } });
  const requestId = [...runtime.pendingApprovals.keys()][0]!;
  return { channel, runtime, result, requestId };
}

describe("native approval scope presentation", () => {
  it("keeps markup-bearing permission paths visible as literal data", () => {
    const toolInput = { path: "/tmp/<hidden>/**bold**/````file" };
    const card = renderCoreApprovalCard({ requestId: "r", toolName: "permissions", toolInput });
    const content = (card.body as { elements: { content?: string }[] }).elements[0]!.content!;
    expect(content).toContain("`````json\n" + JSON.stringify(toolInput, null, 2) + "\n`````");
  });
  it.each(["zh", "en"] as const)("distinguishes actual lifetimes and omits unsupported buttons in %s", (locale) => {
    const render = (approvalScopes: EngineApprovalScopes) => JSON.stringify(renderCoreApprovalCard({ requestId: "r", toolName: "fixture", approvalScopes, locale }));
    const session = render({ once: "once", session: "session" });
    expect(session).toContain(locale === "zh" ? "本会话允许" : "Allow for this session");
    expect(session).not.toContain(locale === "zh" ? "本轮允许" : "Allow for this turn");
    const turn = render({ once: "turn" });
    expect(turn).toContain(locale === "zh" ? "本轮允许" : "Allow for this turn");
    expect(turn).not.toContain("allow_session"); expect(turn).not.toContain(locale === "zh" ? "允许一次" : "Allow once");
    const persistent = render({ session: "always" });
    expect(persistent).not.toContain("allow_once");
    expect(persistent).toContain(locale === "zh" ? "不限于当前轮次" : "not limited to this turn");
  });
  it.each(["text", "card"])("rejects an unsupported scope from %s and keeps the genuine request answerable", async (transport) => {
    const h = setup({ once: "turn" });
    if (transport === "text") {
      expect(await handleCoreApprovalTextCommand({ ...h, chatId: "chat", messageId: "reply", conversationKey: "lark:chat", bridgeChatType: "private", text: `/approve-session ${h.requestId}` })).toMatchObject({ outcome: "noop", reason: "unsupported-scope" });
    } else {
      await handleCoreCardAction({ ...h, event: { chatId: "chat", messageId: "card", operator: { openId: "owner" }, action: { value: { cctb_lark: "approval", requestId: h.requestId, decision: "allow_session" } } } });
    }
    expect(h.runtime.pendingApprovals.has(h.requestId)).toBe(true);
    await handleCoreApprovalTextCommand({ ...h, chatId: "chat", messageId: "reply", conversationKey: "lark:chat", bridgeChatType: "private", text: `/approve ${h.requestId}` });
    await expect(h.result).resolves.toEqual({ behavior: "allow", scope: "once" });
    expect(h.channel.send).toHaveBeenCalledWith("chat", { text: "已允许本轮。" }, { replyTo: "reply" });
  });
  it("keeps session authorization accurate after a card decision", async () => {
    const h = setup({ once: "once", session: "session" });
    await handleCoreCardAction({ ...h, event: { chatId: "chat", messageId: "card", operator: { openId: "owner" }, action: { value: { cctb_lark: "approval", requestId: h.requestId, decision: "allow_session" } } } });
    await expect(h.result).resolves.toEqual({ behavior: "allow", scope: "session" });
    expect(h.channel.send).toHaveBeenCalledWith("chat", { text: "已允许本会话。" }, { replyTo: "card" });
  });
});
