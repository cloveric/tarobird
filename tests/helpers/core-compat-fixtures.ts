import AdmZip from "adm-zip";
import { expect, vi, type Mock } from "vitest";

import type { CoreChannelLike, CoreStreamControllerLike } from "../../src/core/types.js";

/**
 * Fixtures for exercising the shared core under its default compatibility
 * channel profile (`channelProfile()` is "feishu" when no Gateway context is
 * active). The Lark-shaped identifiers (`oc_*`, `ou_*`, `lark:*` keys) are the
 * persisted compatibility data the core still reads and writes; they do not
 * load or require the retired Feishu adapter. Platform behavior the adapter
 * used to attach from its SDK client is provided here as explicit core ports
 * (`uploadImage`, `downloadMessageResource`, `fetchCardContent`, `managedCards`).
 */
export function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf8"));
  }
  return zip.toBuffer();
}

export function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  chatMode: "p2p" | "group" | "topic";
  chatName: string;
  senderId: string;
  senderName: string;
  content: string;
  rawContentType: string;
  threadId: string;
  mentionedBot: boolean;
  resources: Array<{ type: string; fileKey: string; fileName?: string }>;
  replyToMessageId: string;
  mentions: unknown[];
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    ...(overrides.chatMode ? { chatMode: overrides.chatMode } : {}),
    ...(overrides.chatName ? { chatName: overrides.chatName } : {}),
    senderId: overrides.senderId ?? "ou_user",
    ...(overrides.senderName ? { senderName: overrides.senderName } : {}),
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    ...(overrides.replyToMessageId ? { replyToMessageId: overrides.replyToMessageId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: overrides.rawContentType ?? "text",
    resources: overrides.resources ?? [],
    mentions: overrides.mentions ?? [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

type ChannelMock<K extends keyof CoreChannelLike> = Mock<Extract<NonNullable<CoreChannelLike[K]>, (...args: never[]) => unknown>>;
type ManagedCards = NonNullable<CoreChannelLike["managedCards"]>;
export type FakeLarkChannel = ReturnType<typeof baseFakeChannel> & {
  fetchMessage?: ChannelMock<"fetchMessage">;
  fetchCardContent?: ChannelMock<"fetchCardContent">;
  downloadMessageResource?: ChannelMock<"downloadMessageResource">;
  managedCards?: { [K in keyof ManagedCards]: Mock<ManagedCards[K]> };
  addReaction?: ChannelMock<"addReaction">;
  removeReaction?: ChannelMock<"removeReaction">;
  removeReactionByEmoji?: ChannelMock<"removeReactionByEmoji">;
  getChatMode?: ChannelMock<"getChatMode">;
  getChatTopicForm?: ChannelMock<"getChatTopicForm">;
};

/**
 * The run card is the canonical reply in the compatibility profile: the final
 * answer is rendered into the card (delivered via channel.send({card}) +
 * channel.updateCard) rather than a separate markdown message. When the card
 * cannot be created the core falls back to a markdown send. This helper asserts
 * the answer was delivered through whichever path applied.
 */
export function expectLarkFinalAnswer(channel: FakeLarkChannel, text: string): void {
  const calls = (fn: ReturnType<typeof vi.fn> | undefined): unknown[][] =>
    (fn?.mock?.calls as unknown[][] | undefined) ?? [];
  const terminalCards = [...calls(channel.updateCard).map(call => call[2] ?? call[1]),
    ...calls(channel.send).map(call => (call[1] as { card?: unknown } | undefined)?.card)]
    .filter(card => { const value = card as { config?: { streaming_mode?: boolean; summary?: { content?: string } } } | undefined;
      return value?.config?.streaming_mode === false || /已完成|Completed|已中断|Interrupted|失败|Failed/.test(value?.config?.summary?.content ?? ""); });
  const inCard = terminalCards.some(card => JSON.stringify(card).includes(text));
  const markdown = calls(channel.send).map(call => (call[1] as { markdown?: unknown } | undefined)?.markdown).filter(value => typeof value === "string");
  const inMarkdown = typeof markdown.at(-1) === "string" && (markdown.at(-1) as string).includes(text);
  expect(inCard || inMarkdown).toBe(true);
}

export function fakeChannel(overrides: Partial<FakeLarkChannel> = {}): FakeLarkChannel {
  return {
    ...baseFakeChannel(),
    ...overrides,
  };
}

function baseFakeChannel() {
  return {
    send: vi.fn<CoreChannelLike["send"]>(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: CoreStreamControllerLike) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn<NonNullable<CoreChannelLike["updateCard"]>>(async () => undefined),
    recallMessage: vi.fn<NonNullable<CoreChannelLike["recallMessage"]>>(async () => undefined),
    downloadResource: vi.fn<CoreChannelLike["downloadResource"]>(async () => Buffer.from("")),
    // Explicit image-upload port: core never discovers an SDK client. Captioned-image
    // cards use it to obtain an image key; tests may replace it with a failing port.
    uploadImage: vi.fn(async (_body: Buffer): Promise<string | undefined> => "img_key_fake"),
  };
}

/** The image-upload port mock the captioned-card path calls (see baseFakeChannel). */
export function imageCreateMock(channel: FakeLarkChannel): ReturnType<typeof vi.fn> {
  return channel.uploadImage;
}
