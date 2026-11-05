import { createHash } from 'node:crypto';
import { conversationBatchSchema, conversationBatchReceiptSchema, type ConversationBatchResult } from '../client-protocol/conversation-batch.js';
import { ConversationFolders } from './conversation-folders.js';
import { HubError, type HubStore } from './store.js';

/** One host, one transaction. Receipts survive restart and never replay writes
 * over a later restore or another device's move. No task/session is stopped. */
export class ConversationBatchOperations {
  constructor(private readonly store: HubStore) {}
  async apply(userId: string, value: unknown, validate?: () => Promise<unknown>): Promise<ConversationBatchResult> {
    const input = conversationBatchSchema.parse(value);
    const ids = [...input.conversationIds].sort();
    const hash = createHash('sha256').update(JSON.stringify({ ...input, conversationIds: ids })).digest('hex');
    return this.store.db.transaction(async () => {
      await validate?.();
      // Recheck authority even for an old receipt, including every redundant ID.
      for (const id of ids) await this.store.requireMember(userId, id);
      const conversations = await Promise.all(ids.map(id => this.store.conversationInTransaction(id)));
      const folders = new ConversationFolders(this.store.db);
      const previous = await this.store.db.get<{ payload_hash: string; receipt_json: string }>(
        'SELECT payload_hash,receipt_json FROM conversation_batch_requests WHERE user_id=? AND request_id=?', [userId, input.requestId]);
      if (previous) {
        if (previous.payload_hash !== hash) throw new HubError('conversation_batch_request_conflict', 409);
        return { receipt: conversationBatchReceiptSchema.parse(JSON.parse(previous.receipt_json)), replayed: true,
          conversations, ...(input.action === 'move' ? { folders: await folders.readInTransaction(userId) } : {}) };
      }
      // Membership is always checked above, including covered topics. Only
      // effective archive targets need ownership/availability checks.
      const effective = input.action === 'restore' ? conversations : conversations.filter(chat => !chat.parentId || !ids.includes(chat.parentId));
      for (const chat of input.action === 'archive' ? effective : conversations) {
        if ((input.action !== 'restore' && chat.archived) || chat.parentId && (await this.store.conversationInTransaction(chat.parentId)).archived && !(input.action === 'restore' && ids.includes(chat.parentId))) throw new HubError('conversation_not_available', 409);
        if (input.action !== 'move' && chat.ownerId !== userId) throw new HubError('conversation_owner_required', 403);
        if (input.action === 'move' && chat.parentId) throw new HubError('conversation_batch_topic_move', 409);
      }
      // A selected group covers its topics without separately archiving them.
      // Restoring that group therefore restores the same visible topics as before.
      let folderId: string | null | undefined;
      let folderState;
      if (input.action === 'archive' || input.action === 'restore') {
        for (const chat of effective) await this.store.updateConversationInTransaction(userId, chat.id, { archived: input.action === 'archive' });
      } else {
        folderId = 'folderId' in input.target ? input.target.folderId : input.target.newFolder.id;
        folderState = await folders.changeInTransaction(userId, 'folderId' in input.target
          ? { type: 'move-many', conversationIds: ids, folderId, revision: input.revision }
          : { type: 'create-many', conversationIds: ids, ...input.target.newFolder, revision: input.revision });
      }
      const receipt = conversationBatchReceiptSchema.parse({ requestId: input.requestId, action: input.action,
        conversationIds: effective.map(chat => chat.id), completedAt: Date.now(), ...(folderId !== undefined ? { folderId } : {}) });
      await this.store.db.run('INSERT INTO conversation_batch_requests(user_id,request_id,payload_hash,receipt_json) VALUES(?,?,?,?)',
        [userId, input.requestId, hash, JSON.stringify(receipt)]);
      return { receipt, replayed: false, conversations: await Promise.all(ids.map(id => this.store.conversationInTransaction(id))),
        ...(folderState ? { folders: folderState } : {}) };
    });
  }
}
