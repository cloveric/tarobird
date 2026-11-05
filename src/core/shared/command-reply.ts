import { chunkMarkdown } from "../../runtime/markdown-chunks.js";

export type CoreCommandChannel = "telegram" | "lark" | "gateway";

export function commandReplyChunks(context: { channel?: CoreCommandChannel }, text: string): string[] {
  // App and Feishu wrappers deliver through Core, which owns their transport
  // limits. Do not pre-split logical replies using Telegram's smaller limit.
  if (context.channel === "gateway" || context.channel === "lark") return [text];
  // Unspecified channel is the legacy Telegram command API contract.
  return chunkMarkdown(text, 4000);
}
