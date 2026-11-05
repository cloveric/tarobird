import path from "node:path";
import { z } from "zod";
import { blocksText, type Message } from "../client-protocol/index.js";
import { GoogleDocs, type GoogleDocumentLink } from "../gdocs/client.js";
import { withFileMutex } from "../state/file-mutex.js";
import { HubError, HubStore, type TransactionGuard } from "./store.js";

const receiptSchema = z.object({ status: z.enum(["creating", "writing", "complete"]), documentId: z.string().optional() });
/** Google create has no idempotency key. Persist its ID before writing content;
 * if creation itself had an unknown outcome, do not silently create a second doc. */
export async function exportGoogleDocument(store: HubStore, directory: string, userId: string, message: Message, docs: GoogleDocs, validate?: TransactionGuard): Promise<GoogleDocumentLink> {
  return withFileMutex(path.join(directory, `gdocs-${message.id}-${message.version}`), async () => {
    const key = `gdocs:${userId}:${message.id}:${message.version}`;
    const authorize = async () => { await validate?.(); await store.requireOwner(userId); await store.requireMember(userId, message.conversationId); };
    const saved = await store.db.serial(async () => { await authorize(); return store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]); });
    const receipt = saved ? receiptSchema.parse(JSON.parse(saved.value)) : undefined;
    if (receipt?.status === "complete" && receipt.documentId) return { documentId: receipt.documentId, url: `https://docs.google.com/document/d/${receipt.documentId}/edit` };
    if (receipt?.status === "creating") throw new HubError("google_export_outcome_unknown_check_google_docs", 409);
    await docs.authorization.token();
    const save = (status: z.infer<typeof receiptSchema>) => store.db.serial(() => store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [key, JSON.stringify(status)]));
    let result: GoogleDocumentLink;
    const text = blocksText(message.blocks);
    // Admit the external operation after OAuth and file-lock waits. Once
    // admitted, retain IDs and completion receipts even if its actor is revoked;
    // abandoning that bookkeeping could create duplicate external documents.
    await store.db.transaction(async () => {
      await authorize();
      await store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [key, JSON.stringify(receipt?.documentId ? { status: "writing", documentId: receipt.documentId } : { status: "creating" })]);
    });
    if (receipt?.documentId) result = await docs.update(receipt.documentId, text);
    else {
      result = await docs.create(`TaroBird · ${new Date(message.createdAt).toISOString().slice(0, 10)}`, text, async (documentId) => { await save({ status: "writing", documentId }); });
    }
    await save({ status: "complete", documentId: result.documentId });
    await store.audit("gdocs.exported", userId, { messageId: message.id, documentId: result.documentId }); return result;
  });
}
