import { ATTACHMENT_ADMIN_DELETE_PATH, ATTACHMENT_ADMIN_LIST_PATH, ATTACHMENT_ADMIN_SUMMARY_PATH, attachmentAdminDeleteResultSchema, attachmentAdminListSchema, attachmentAdminSortSchema, attachmentAdminSummarySchema } from "../client-protocol/attachment-admin.js";
import { LocalHostClient } from "./client.js";

export type AttachmentOptions = { conversation?: string; ids?: string; sort?: string; offset?: string; yes?: boolean };

/** `tarobot attachments …`: the owner-only Hub API behind File Center › 附件管理.
 * `list` without --conversation is the per-conversation summary. */
export async function runAttachmentsCommand(directory: string, sub: string | undefined, options: AttachmentOptions): Promise<unknown> {
  if (sub !== "list" && sub !== "delete") throw new Error("请使用 attachments list|delete。");
  const ids = options.ids?.split(",").map(id => id.trim()).filter(Boolean);
  if (sub === "delete") {
    if (!!ids?.length === (options.conversation !== undefined)) throw new Error("请用 --ids ID,ID 或 --conversation ID 二选一。");
    if (!options.yes) throw new Error("删除后无法恢复，只删除主机上的这份；已下载到各设备的副本不受影响。确认请加 --yes。");
  } else if (ids || options.yes) throw new Error("attachments list 只读，不接受 --ids/--yes。");
  const client = await LocalHostClient.connect(directory);
  try {
    if (sub === "list") {
      if (options.conversation === undefined) return attachmentAdminSummarySchema.parse(await client.request(ATTACHMENT_ADMIN_SUMMARY_PATH));
      const query = new URLSearchParams({ conversationId: options.conversation, sort: attachmentAdminSortSchema.parse(options.sort ?? "size"), offset: options.offset ?? "0" });
      return attachmentAdminListSchema.parse(await client.request(`${ATTACHMENT_ADMIN_LIST_PATH}?${query}`));
    }
    return attachmentAdminDeleteResultSchema.parse(await client.request(ATTACHMENT_ADMIN_DELETE_PATH, "POST", ids?.length ? { ids } : { conversationId: options.conversation }));
  } finally { client.close(); }
}
