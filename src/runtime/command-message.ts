/** Numeric command/attachment contract used by Bridge and file workflows.
 * CoreCommandMessage in core/shared/command-message.ts describes the richer
 * channel command envelope; neither module performs transport decoding. */
export interface CommandAttachment {
  fileId: string;
  fileName?: string;
  fileSize?: number;
  kind: "audio" | "document" | "photo" | "video" | "voice";
}

export interface CommandMessage {
  chatId: number;
  userId: number;
  chatType: string;
  messageThreadId?: number;
  conversationKey?: string;
  text: string;
  callbackQueryId?: string;
  replyContext?: {
    messageId: number;
    text: string;
    photoFileId?: string;
    documentFileId?: string;
    documentFileName?: string;
    audioAttachment?: CommandAttachment;
  };
  attachments: CommandAttachment[];
}
