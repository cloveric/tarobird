import type { CoreChannelLike } from "./types.js";
export interface LarkCliStatus {
  available: boolean;
  version?: string;
  error?: string;
}


export interface LarkChatCreateInput {
  name: string;
  mode: "group" | "topic";
  operatorOpenId?: string;
  /** The current bridge instance's app id. Needed when the bot must be invited. */
  botAppId?: string;
  // The instance's own Lark channel. The bot path creates the chat through this
  // channel's SDK client (the instance's app) instead of lark-cli, because lark-cli
  // authenticates as its own separate app — so a sender open_id captured by THIS
  // instance's app would be rejected as "open_id cross app" by lark-cli's app. Creating
  // via the instance SDK keeps the acting app and the open_id in the same namespace.
  channel?: CoreChannelLike;
}

export interface LarkChatCreateResult {
  chatId: string;
  name?: string;
  shareLink?: string;
}


export interface LarkDocumentCreateInput {
  title?: string;
  content: string;
  docFormat?: "xml" | "markdown";
  as?: "user" | "bot";
  parentToken?: string;
  parentPosition?: string;
}

export interface LarkDocumentCreateResult {
  title?: string;
  url?: string;
  documentId?: string;
  warning?: string;
}


export type LarkCommentFileType = "doc" | "docx" | "sheet" | "file" | "slides" | "bitable";

export interface LarkCommentReplyContext {
  replyId?: string;
  userId?: string;
  text: string;
  docsLinks: string[];
}

export interface LarkCommentContext {
  quote?: string;
  replies: LarkCommentReplyContext[];
}

export interface LarkCommentClientLike {
  getCommentContext(input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
  }): Promise<LarkCommentContext>;
  createReply(input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
    text: string;
  }): Promise<void>;
  createTopLevelComment?(input: {
    fileToken: string;
    fileType: LarkCommentFileType;
    commentId: string;
    text: string;
  }): Promise<void>;
  addReaction?(input: LarkCommentReactionInput): Promise<void>;
  removeReaction?(input: LarkCommentReactionInput): Promise<void>;
}

export interface LarkCommentReactionInput {
  fileToken: string;
  fileType: LarkCommentFileType;
  commentId: string;
  replyId: string;
  reactionType: "Typing";
}
