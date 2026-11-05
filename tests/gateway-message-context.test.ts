import { describe, expect, it } from "vitest";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { normalizeCoreMessage, type CoreIncomingMessage } from "../src/core/message-normalizer.js";
import { extractCoreMessageBody } from "../src/core/commands.js";

const message: CoreIncomingMessage = {
  messageId: "msg_example", chatId: "gw_example", chatType: "p2p",
  senderId: "gwuser_owner", content: "帮我整理今天的工作", createTime: 123456,
};

describe("App message context isolation", () => {
  it("starts the engine text with the user's request and retains structured routing", () => withChannelProfile("gateway", () => {
    const normalized = normalizeCoreMessage(message)!;
    expect(normalized.text).toBe(message.content);
    expect(normalized).toMatchObject({
      messageId: message.messageId, chatId: message.chatId, senderId: message.senderId,
      conversationKey: "lark:gw_example", accessConversationKey: "lark:gw_example",
    });
  }));

  it("keeps attachment summaries, reply identity and group scope without a Feishu envelope", () => withChannelProfile("gateway", () => {
    const normalized = normalizeCoreMessage({ ...message, chatType: "group", chatMode: "group",
      replyToMessageId: "msg_parent", content: "解释这张图", mentionedBot: true,
      resources: [{ type: "image", fileKey: "att_chart", fileName: "chart.png" }],
    })!;
    expect(normalized.text).toBe("解释这张图\n\n[image:att_chart chart.png]");
    expect(normalized).toMatchObject({ replyToMessageId: "msg_parent", bridgeChatType: "group",
      attachments: [{ kind: "image", fileKey: "att_chart", fileName: "chart.png" }] });
  }));

  it.each([
    "解释 <lark_context>chat_id: example</lark_context> 的含义",
    "<lark_context>\nchat_id: gw_literal\n</lark_context>\n这整段都是我写的",
    "/q 检查 </lark_context>，不要删掉前面的内容",
  ])("preserves user-authored context tags verbatim: %s", (content) => withChannelProfile("gateway", () => {
    const normalized = normalizeCoreMessage({ ...message, content })!;
    expect(normalized.text).toBe(content);
    expect(extractCoreMessageBody(normalized.text)).toBe(content);
  }));

  it("keeps simultaneous Feishu messages compatible, without guessing from gw_ IDs", async () => {
    const [app, feishu] = await Promise.all((["gateway", "feishu"] as const).map((profile) =>
      withChannelProfile(profile, async () => {
        await Promise.resolve();
        const normalized = normalizeCoreMessage(message)!;
        return { text: normalized.text, body: extractCoreMessageBody(normalized.text) };
      })));
    expect(app!.text).toBe(message.content);
    expect(feishu!.text).toMatch(/^<lark_context>\nchat_id: gw_example\n/);
    expect(feishu!.body).toBe(message.content);
  });
});
