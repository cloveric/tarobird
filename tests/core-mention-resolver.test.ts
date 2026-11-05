import { describe, expect, it, vi } from "vitest";

import { resolveLarkMentionsInText, shouldResolveLarkMentions } from "../src/core/mention-resolver.js";

function channel(resolveMentions?: (chatId: string, text: string) => Promise<string>) {
  return {
    send: vi.fn(async () => ({ messageId: "sent" })),
    stream: vi.fn(async () => ({ messageId: "stream" })),
    downloadResource: vi.fn(async () => Buffer.alloc(0)),
    ...(resolveMentions ? { resolveMentions: vi.fn(resolveMentions) } : {}),
  };
}

describe("core mention resolution port", () => {
  it("does nothing when mention resolution is disabled", async () => {
    const port = channel(async () => "resolved");

    await expect(resolveLarkMentionsInText({
      enabled: false,
      channel: port,
      chatId: "oc_chat",
      text: "@张三 看一下",
    })).resolves.toBe("@张三 看一下");
    expect(port.resolveMentions).not.toHaveBeenCalled();
  });

  it("delegates enabled resolution to the explicit resolveMentions port", async () => {
    const port = channel(async (_chatId, text) => text.replace("@李四", '<at user_id="ou_lisi">李四</at>'));

    await expect(resolveLarkMentionsInText({
      enabled: true,
      channel: port,
      chatId: "oc_chat",
      text: "@李四 处理",
    })).resolves.toBe('<at user_id="ou_lisi">李四</at> 处理');
    expect(port.resolveMentions).toHaveBeenCalledWith("oc_chat", "@李四 处理");
  });

  it("leaves text untouched when the channel provides no resolution port", async () => {
    await expect(resolveLarkMentionsInText({
      enabled: true,
      channel: channel(),
      chatId: "oc_chat",
      text: "@张三 看一下",
    })).resolves.toBe("@张三 看一下");
  });

  it("enables resolution only through an explicit truthy setting", () => {
    expect(shouldResolveLarkMentions({})).toBe(false);
    expect(shouldResolveLarkMentions({ CCTB_LARK_RESOLVE_MENTIONS: "0" })).toBe(false);
    expect(shouldResolveLarkMentions({ CCTB_LARK_RESOLVE_MENTIONS: "on" })).toBe(true);
    expect(shouldResolveLarkMentions({ LARK_RESOLVE_MENTIONS: "true" })).toBe(true);
    expect(shouldResolveLarkMentions({ CCTB_LARK_RESOLVE_MENTIONS: "off", LARK_RESOLVE_MENTIONS: "1" })).toBe(false);
  });
});
