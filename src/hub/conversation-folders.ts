import { z } from 'zod';
import { conversationIdsSchema } from '../client-protocol/conversation-batch.js';
import { conversationFolderOrder, conversationFoldersSchema, emptyConversationFolders, folderChangeSchema, folderCreateSchema, folderMoveSchema, type ConversationFoldersState } from '../client-protocol/conversation-folders.js';
import type { HubDatabase } from './database.js';
import { HubError } from './store.js';

const atomicFolderChangeSchema = z.union([folderChangeSchema,
  folderCreateSchema.omit({ conversationId: true }).extend({ type: z.literal('create-many'), conversationIds: conversationIdsSchema }),
  folderMoveSchema.omit({ conversationId: true }).extend({ type: z.literal('move-many'), conversationIds: conversationIdsSchema }),
]);

/** Personal organization, scoped to a user on this Hub. It never changes Bot
 * membership, sessions, permissions or conversation content. Additive metadata
 * uses the existing transactional meta store and needs no destructive migration. */
export class ConversationFolders {
  constructor(private readonly db: HubDatabase) {}
  private async load(userId: string): Promise<{ state: ConversationFoldersState; unpinnedOrder?: (string | null)[] }> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`conversation-folders:${userId}`]);
    if (!row) return { state: emptyConversationFolders() };
    const stored = JSON.parse(row.value), state = conversationFoldersSchema.parse(stored);
    // Host-private restoration metadata shares the transaction and backup of the
    // public state. Older clients still receive the persisted pinned-first order.
    const ids = new Set<string | null>([null, ...state.folders.map(folder => folder.id)]);
    const saved: unknown = stored.unpinnedOrder;
    const unpinnedOrder = state.pinnedFolderIds?.length && Array.isArray(saved)
      && saved.length === ids.size && new Set(saved).size === ids.size
      && saved.every(id => (id === null || typeof id === 'string') && ids.has(id))
      ? saved as (string | null)[] : undefined;
    return { state, unpinnedOrder };
  }
  read(userId: string, validate?: () => Promise<unknown>): Promise<ConversationFoldersState> {
    return this.db.serial(async () => { await validate?.(); return (await this.load(userId)).state; });
  }
  async change(userId: string, value: unknown, validate?: () => Promise<unknown>): Promise<ConversationFoldersState> {
    return this.db.transaction(async () => { await validate?.(); return this.changeInTransaction(userId, folderChangeSchema.parse(value)); });
  }
  /** Caller owns the database queue/transaction. */
  async readInTransaction(userId: string): Promise<ConversationFoldersState> { return (await this.load(userId)).state; }
  /** Shared atomic primitive for individual edits and a receipted batch. */
  async changeInTransaction(userId: string, value: unknown): Promise<ConversationFoldersState> {
      const input = atomicFolderChangeSchema.parse(value);
      const isCreate = input.type === 'create' || input.type === 'create-many';
      const { state, unpinnedOrder: savedOrder } = await this.load(userId);
      if (input.revision !== state.revision) throw new HubError('folders_changed', 409);
      const beforeOrder = conversationFolderOrder(state), beforePins = new Set(state.pinnedFolderIds);
      // Legacy pins have no recoverable original position. Keep existing normal
      // folders in place and return those pins to the end of that section.
      let unpinnedOrder = savedOrder ?? [...beforeOrder.filter(id => !beforePins.has(id)), ...beforeOrder.filter(id => beforePins.has(id))];
      const pinChanged = input.type === 'pin' && (state.pinnedFolderIds?.includes(input.id) ?? false) !== input.pinned;
      const conversationIds = 'conversationIds' in input ? input.conversationIds : 'conversationId' in input && input.conversationId ? [input.conversationId] : [];
      for (const conversationId of conversationIds) {
        const chat = await this.db.get('SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id WHERE c.id=? AND c.archived=0 AND c.parent_id IS NULL AND m.member_type=\'user\' AND m.member_id=?', [conversationId, userId]);
        if (!chat) throw new HubError('conversation_not_available', 404);
      }
      if (isCreate || input.type === 'rename') {
        if (state.folders.some(f => f.name.normalize('NFKC').toLowerCase() === input.name.normalize('NFKC').toLowerCase() && (isCreate || f.id !== input.id))) throw new HubError('folder_name_exists', 409);
      }
      if (isCreate) {
        if (state.folders.some(f => f.id === input.id)) throw new HubError('folder_exists', 409);
        if (state.folders.length >= 64) throw new HubError('folder_limit', 409);
        state.folders.push({ id: input.id, name: input.name });
        // A pinned folder's hidden restoration slot must not move the visible
        // trailing Unfiled boundary that the editor uses for new folders.
        const trailingUnfiled = beforeOrder.filter(id => !beforePins.has(id)).at(-1) === null;
        unpinnedOrder.splice(trailingUnfiled ? unpinnedOrder.indexOf(null) : unpinnedOrder.length, 0, input.id);
      } else if (input.type === 'reorder') {
        const ids = new Set<string | null>([null, ...state.folders.map(folder => folder.id)]);
        if (input.folderIds.length !== ids.size || new Set(input.folderIds).size !== ids.size || input.folderIds.some(id => !ids.has(id))) throw new HubError('folder_order_invalid', 400);
        // Reordering visible ordinary folders changes their normal order; pinned
        // folders keep their original slots until unpinned. Pin order is separate.
        const ordinary = input.folderIds.filter(id => !beforePins.has(id));
        let next = 0;
        unpinnedOrder = unpinnedOrder.map(id => beforePins.has(id) ? id : ordinary[next++]!);
        const byId = new Map(state.folders.map(folder => [folder.id, folder]));
        state.folders = input.folderIds.filter((id): id is string => id !== null).map(id => byId.get(id)!);
        const unfiledIndex = input.folderIds.indexOf(null);
        if (unfiledIndex === state.folders.length) delete state.unfiledIndex;
        else state.unfiledIndex = unfiledIndex;
      } else if (input.type === 'pin') {
        if (input.id !== null && !state.folders.some(folder => folder.id === input.id)) throw new HubError('folder_not_found', 404);
        const pinned = state.pinnedFolderIds ?? [];
        state.pinnedFolderIds = input.pinned ? [...new Set([...pinned, input.id])] : pinned.filter(id => id !== input.id);
      } else if (input.type !== 'move' && input.type !== 'move-many') {
        const folder = state.folders.find(f => f.id === input.id);
        if (!folder) throw new HubError('folder_not_found', 404);
        if (input.type === 'rename') folder.name = input.name;
        else {
          if (state.unfiledIndex !== undefined && state.folders.indexOf(folder) < state.unfiledIndex) state.unfiledIndex--;
          state.folders = state.folders.filter(f => f.id !== input.id);
          unpinnedOrder = unpinnedOrder.filter(id => id !== input.id);
          state.assignments = state.assignments.filter(a => a.folderId !== input.id);
          if (state.pinnedFolderIds) state.pinnedFolderIds = state.pinnedFolderIds.filter(id => id !== input.id);
          if (state.unfiledIndex === state.folders.length) delete state.unfiledIndex;
        }
      }
      if (input.type === 'move' || input.type === 'move-many' || isCreate && conversationIds.length) {
        const folderId = input.type === 'move' || input.type === 'move-many' ? input.folderId : input.id;
        if (folderId && !state.folders.some(f => f.id === folderId)) throw new HubError('folder_not_found', 404);
        state.assignments = state.assignments.filter(a => !conversationIds.includes(a.conversationId));
        if (folderId) state.assignments.push(...conversationIds.map(conversationId => ({ conversationId, folderId })));
      }
      if (state.assignments.length > 2048) throw new HubError('folder_assignment_limit', 409);
      // Persist the same pinned-first order for older clients that do not know
      // the pin field. Old reorder requests may sort within, but not across it.
      let order = conversationFolderOrder(state);
      if (input.type === 'pin' && pinChanged && input.pinned) {
        order.splice(order.indexOf(input.id), 1);
        order.unshift(input.id);
      }
      const pins = new Set(state.pinnedFolderIds);
      order = [...order.filter(id => pins.has(id)), ...unpinnedOrder.filter(id => !pins.has(id))];
      const byId = new Map(state.folders.map(folder => [folder.id, folder]));
      state.folders = order.filter((id): id is string => id !== null).map(id => byId.get(id)!);
      const unfiledIndex = order.indexOf(null);
      if (unfiledIndex === state.folders.length) delete state.unfiledIndex;
      else state.unfiledIndex = unfiledIndex;
      if (!state.pinnedFolderIds?.length) delete state.pinnedFolderIds;
      state.revision++;
      await this.db.run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [`conversation-folders:${userId}`, JSON.stringify({ ...state, ...(pins.size ? { unpinnedOrder } : {}) })]);
      return state;
  }
}
