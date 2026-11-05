/** Explicit, injected reply ports. This module contains no token, HTTP client,
 * platform discovery or network fallback. Numeric receipt fields preserve the
 * existing shared command/tool contract. */
export interface ReplyReceipt { message_id: number; text?: string }
export interface ReplyOptions {
  inlineKeyboard?: Array<Array<{ text: string; callbackData: string }>> | null;
  parseMode?: "MarkdownV2" | "HTML" | "Markdown";
  disableNotification?: boolean;
  messageThreadId?: number;
}
export type ReplyFileOptions = Pick<ReplyOptions, "disableNotification" | "messageThreadId"> & { signal?: AbortSignal };
export interface ReplyChannel {
  sendMessage(chatId: number, text: string, options?: ReplyOptions): Promise<ReplyReceipt>;
  sendDocument(chatId: number, filename: string, contents: string | Uint8Array, options?: ReplyFileOptions): Promise<ReplyReceipt>;
  sendPhoto(chatId: number, filename: string, contents: Uint8Array, caption?: string, options?: ReplyFileOptions): Promise<ReplyReceipt>;
  sendVoice(chatId: number, filename: string, contents: Uint8Array, options?: ReplyFileOptions): Promise<ReplyReceipt>;
}
