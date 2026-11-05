/** Transport-neutral input to shared text commands. Numeric IDs are the
 * existing engine/audit identities, not a requirement to connect to Telegram. */
export interface CoreCommandMessage {
  chatId: number;
  userId: number;
  chatType: string;
  messageThreadId?: number;
  conversationKey?: string;
  text: string;
  attachments: readonly unknown[];
}

/** Shared commands only send text; each adapter owns its native receipt. */
export interface CoreCommandReplyApi {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}
