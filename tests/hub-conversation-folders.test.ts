import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubDatabase } from '../src/hub/database.js';
import { HubStore } from '../src/hub/store.js';
import { ConversationFolders } from '../src/hub/conversation-folders.js';
import { conversationFolderOrder, conversationFoldersSchema } from '../src/client-protocol/conversation-folders.js';

describe('conversation folders', () => {
  let root: string, db: HubDatabase, store: HubStore, folders: ConversationFolders, chat: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'hub-folders-')); db = await HubDatabase.open(root); store = new HubStore(db); folders = new ConversationFolders(db);
    await db.run("INSERT INTO users VALUES('owner','Owner','owner'),('other','Other','member')");
    await db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    chat = (await store.createConversation('owner', ['bot'], 'Chat', 'create')).id;
  });
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  it.each([true, false])('inserts before visible trailing Unfiled despite a hidden pinned restoration slot (legacy=%s)', async legacy => {
    if (legacy) await db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['conversation-folders:owner', JSON.stringify({ revision: 4, folders: [{ id: 'life', name: 'Life' }, { id: 'work', name: 'Work' }], assignments: [], pinnedFolderIds: ['life'] })]);
    else {
      await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
      await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 1 });
      await folders.change('owner', { type: 'reorder', folderIds: ['work', null, 'life'], revision: 2 });
      await folders.change('owner', { type: 'pin', id: 'life', pinned: true, revision: 3 });
    }
    expect(conversationFolderOrder(await folders.read('owner'))).toEqual(['life', 'work', null]);
    const created = await folders.change('owner', { type: 'create', id: 'new', name: 'New', revision: 4 });
    expect(conversationFolderOrder(created)).toEqual(['life', 'work', 'new', null]);
    const unpinned = await folders.change('owner', { type: 'pin', id: 'life', pinned: false, revision: 5 });
    expect(conversationFolderOrder(unpinned)).toEqual(['work', 'new', null, 'life']);
  });
  it('creates and moves atomically, persists after reopen, and deleting only unassigns chats', async () => {
    const result = await folders.change('owner', { type: 'create', id: 'work', name: ' 工作 ', conversationId: chat, revision: 0 });
    expect(result.folders).toEqual([{ id: 'work', name: '工作' }]); expect(result.assignments).toEqual([{ conversationId: chat, folderId: 'work' }]);
    await db.close(); db = await HubDatabase.open(root); store = new HubStore(db); folders = new ConversationFolders(db);
    expect(await folders.read('owner')).toEqual(result);
    const deleted = await folders.change('owner', { type: 'delete', id: 'work', revision: 1 });
    expect(deleted).toEqual({ revision: 2, folders: [], assignments: [] });
    expect((await store.conversations('owner')).find(c => c.id === chat)?.archived).toBe(false);
  });
  it('rejects stale writes, duplicate names, blank names, unknown folders and inaccessible chats', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    await expect(folders.change('owner', { type: 'rename', id: 'work', name: 'New', revision: 0 })).rejects.toThrow('folders_changed');
    await expect(folders.change('owner', { type: 'create', id: 'other', name: ' work ', revision: 1 })).rejects.toThrow('folder_name_exists');
    await expect(folders.change('owner', { type: 'rename', id: 'work', name: '  ', revision: 1 })).rejects.toThrow();
    await expect(folders.change('owner', { type: 'move', conversationId: chat, folderId: 'missing', revision: 1 })).rejects.toThrow('folder_not_found');
    await expect(folders.change('other', { type: 'create', id: 'other', name: 'Private', conversationId: chat, revision: 0 })).rejects.toThrow('conversation_not_available');
    expect((await folders.read('other')).folders).toEqual([]);
    expect((await folders.read('owner')).revision).toBe(1);
  });
  it('isolates users, supports groups but keeps topics with their parent, and rejects revoked writes', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    await folders.change('other', { type: 'create', id: 'work', name: 'Other work', revision: 0 });
    const group = await store.createConversation('owner', ['bot'], 'Group', 'group', { type: 'group' });
    const topic = await store.createConversation('owner', [], 'Topic', 'topic', { parentId: group.id });
    await folders.change('owner', { type: 'move', conversationId: group.id, folderId: 'work', revision: 1 });
    await expect(folders.change('owner', { type: 'move', conversationId: topic.id, folderId: 'work', revision: 2 })).rejects.toThrow('conversation_not_available');
    await expect(folders.change('owner', { type: 'delete', id: 'work', revision: 2 }, async () => { throw new Error('device_revoked'); })).rejects.toThrow('device_revoked');
    expect((await folders.read('other')).assignments).toEqual([]);
    await store.updateConversation('owner', chat, { archived: true });
    await expect(folders.change('owner', { type: 'move', conversationId: chat, folderId: 'work', revision: 2 })).rejects.toThrow('conversation_not_available');
    expect((await folders.read('owner')).folders[0]?.name).toBe('Work');
  });
  it('serializes simultaneous device edits so no newer move or rename is overwritten', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    const results = await Promise.allSettled([
      folders.change('owner', { type: 'move', conversationId: chat, folderId: 'work', revision: 1 }),
      folders.change('owner', { type: 'rename', id: 'work', name: 'New', revision: 1 }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await folders.read('owner')).revision).toBe(2);
  });
  it('reorders custom folders and Unfiled, persists order and keeps memberships intact', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', conversationId: chat, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 1 });
    const sorted = await folders.change('owner', { type: 'reorder', folderIds: ['life', null, 'work'], revision: 2 });
    expect(sorted).toMatchObject({ revision: 3, folders: [{ id: 'life' }, { id: 'work' }], unfiledIndex: 1, assignments: [{ conversationId: chat, folderId: 'work' }] });
    await db.close(); db = await HubDatabase.open(root); store = new HubStore(db); folders = new ConversationFolders(db);
    expect(await folders.read('owner')).toEqual(sorted);
    await folders.change('owner', { type: 'create', id: 'new', name: 'New', revision: 3 });
    expect((await folders.read('owner')).unfiledIndex).toBe(1);
    await folders.change('owner', { type: 'delete', id: 'life', revision: 4 });
    expect((await folders.read('owner')).unfiledIndex).toBe(0);
    await folders.change('owner', { type: 'reorder', folderIds: ['new', 'work', null], revision: 5 });
    const result = await folders.change('owner', { type: 'create', id: 'last', name: 'Last', revision: 6 });
    expect(result.unfiledIndex).toBeUndefined(); // Legacy/default order keeps Unfiled last as folders grow.
    expect(result.folders.map(f => f.id)).toEqual(['new', 'work', 'last']);
    expect(result.assignments).toEqual(sorted.assignments);
    expect((await folders.read('other')).folders).toEqual([]);
  });
  it('requires a complete unique order, the current revision and a still-authorized device', async () => {
    const before = await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    for (const folderIds of [[], ['work'], [null], ['work', 'work', null], [null, null], ['unknown', null]]) {
      await expect(folders.change('owner', { type: 'reorder', folderIds, revision: 1 })).rejects.toThrow();
      expect(await folders.read('owner')).toEqual(before);
    }
    await expect(folders.change('owner', { type: 'reorder', folderIds: [null, 'work'], revision: 0 })).rejects.toThrow('folders_changed');
    await expect(folders.change('owner', { type: 'reorder', folderIds: [null, 'work'], revision: 1 }, async () => { throw new Error('device_revoked'); })).rejects.toThrow('device_revoked');
    const results = await Promise.allSettled([
      folders.change('owner', { type: 'rename', id: 'work', name: 'Renamed', revision: 1 }),
      folders.change('owner', { type: 'reorder', folderIds: [null, 'work'], revision: 1 }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await folders.read('owner')).revision).toBe(2);
  });
  it('pins folders and Unfiled durably, constrains legacy order writes and preserves assignments', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', conversationId: chat, revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 1 });
    const pinned = await folders.change('owner', { type: 'pin', id: 'life', pinned: true, revision: 2 });
    expect(conversationFolderOrder(pinned)).toEqual(['life', 'work', null]);
    expect(pinned.folders.map(f => f.id)).toEqual(['life', 'work']); // old clients see pinned first too
    expect(conversationFoldersSchema.parse(pinned).pinnedFolderIds).toEqual(['life']);
    await db.close(); db = await HubDatabase.open(root); store = new HubStore(db); folders = new ConversationFolders(db);
    expect(await folders.read('owner')).toEqual(pinned);
    const reordered = await folders.change('owner', { type: 'reorder', folderIds: [null, 'work', 'life'], revision: 3 });
    expect(conversationFolderOrder(reordered)).toEqual(['life', null, 'work']);
    await folders.change('owner', { type: 'pin', id: null, pinned: true, revision: 4 });
    const multi = await folders.change('owner', { type: 'reorder', folderIds: ['work', 'life', null], revision: 5 });
    expect(conversationFolderOrder(multi)).toEqual(['life', null, 'work']);
    const repeated = await folders.change('owner', { type: 'pin', id: null, pinned: true, revision: 6 });
    expect(conversationFolderOrder(repeated)).toEqual(['life', null, 'work']);
    const added = await folders.change('owner', { type: 'create', id: 'new', name: 'New', revision: 7 });
    expect(conversationFolderOrder(added)).toEqual(['life', null, 'work', 'new']);
    const unpinned = await folders.change('owner', { type: 'pin', id: 'life', pinned: false, revision: 8 });
    expect(conversationFolderOrder(unpinned)).toEqual([null, 'life', 'work', 'new']);
    expect(unpinned.assignments).toEqual(pinned.assignments);
    await folders.change('owner', { type: 'pin', id: 'work', pinned: true, revision: 9 });
    const deleted = await folders.change('owner', { type: 'delete', id: 'work', revision: 10 });
    expect(deleted.pinnedFolderIds).toEqual([null]);
    expect(deleted.assignments).toEqual([]);
    const clear = await folders.change('owner', { type: 'pin', id: null, pinned: false, revision: 11 });
    expect(clear.pinnedFolderIds).toBeUndefined();
    expect((await folders.read('other')).folders).toEqual([]);
  });
  it('restores the ordinary position when the last pin is removed instead of leaving it first', async () => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 1 });
    await folders.change('owner', { type: 'create', id: 'reading', name: 'Reading', revision: 2 });
    const pinned = await folders.change('owner', { type: 'pin', id: 'reading', pinned: true, revision: 3 });
    expect(conversationFolderOrder(pinned)).toEqual(['reading', 'work', 'life', null]);
    expect(pinned).not.toHaveProperty('unpinnedOrder');
    await db.close(); db = await HubDatabase.open(root); folders = new ConversationFolders(db);
    expect(await folders.read('owner')).toEqual(pinned);
    const unpinned = await folders.change('owner', { type: 'pin', id: 'reading', pinned: false, revision: 4 });
    expect(conversationFolderOrder(unpinned)).toEqual(['work', 'life', 'reading', null]);
    expect(unpinned.pinnedFolderIds).toBeUndefined();
    const repeated = await folders.change('owner', { type: 'pin', id: 'reading', pinned: false, revision: 5 });
    expect(conversationFolderOrder(repeated)).toEqual(conversationFolderOrder(unpinned));
  });
  it.each([['life', null], [null, 'life']])('restores multiple pins regardless of removal order %j', async (first, second) => {
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 1 });
    await folders.change('owner', { type: 'create', id: 'reading', name: 'Reading', revision: 2 });
    await folders.change('owner', { type: 'reorder', folderIds: ['work', null, 'life', 'reading'], revision: 3 });
    await folders.change('owner', { type: 'pin', id: 'life', pinned: true, revision: 4 });
    await folders.change('owner', { type: 'pin', id: null, pinned: true, revision: 5 });
    // Pin order and ordinary order can change independently while pinned slots survive.
    await folders.change('owner', { type: 'reorder', folderIds: ['life', null, 'reading', 'work'], revision: 6 });
    await folders.change('owner', { type: 'rename', id: 'life', name: 'Home', revision: 7 });
    await folders.change('owner', { type: 'create', id: 'new', name: 'New', revision: 8 });
    await folders.change('owner', { type: 'delete', id: 'work', revision: 9 });
    const partial = await folders.change('owner', { type: 'pin', id: first, pinned: false, revision: 10 });
    expect(conversationFolderOrder(partial)[0]).toBe(second);
    const restored = await folders.change('owner', { type: 'pin', id: second, pinned: false, revision: 11 });
    expect(conversationFolderOrder(restored)).toEqual(['reading', null, 'life', 'new']);
    expect(restored.pinnedFolderIds).toBeUndefined();
    expect(restored.folders.find(folder => folder.id === 'life')?.name).toBe('Home');
  });
  it.each([undefined, ['life', null, 'missing'], ['life', 'life', null]].map(unpinnedOrder => ({ unpinnedOrder })))('unpins legacy or invalid restoration metadata without losing ordinary folders (%j)', async ({ unpinnedOrder }) => {
    await db.run('INSERT INTO meta(key,value) VALUES(?,?)', ['conversation-folders:owner', JSON.stringify({
      revision: 9, folders: [{ id: 'life', name: 'Life' }, { id: 'work', name: 'Work' }],
      assignments: [{ conversationId: chat, folderId: 'work' }], pinnedFolderIds: ['life'], unpinnedOrder,
    })]);
    const unpinned = await folders.change('owner', { type: 'pin', id: 'life', pinned: false, revision: 9 });
    expect(conversationFolderOrder(unpinned)).toEqual(['work', null, 'life']);
    expect(unpinned.assignments).toEqual([{ conversationId: chat, folderId: 'work' }]);
    expect(unpinned).not.toHaveProperty('unpinnedOrder');
    expect(unpinned.pinnedFolderIds).toBeUndefined();
  });
  it('rejects invalid, stale and revoked pins without overwriting another device', async () => {
    const before = await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    await expect(folders.change('owner', { type: 'pin', id: 'missing', pinned: true, revision: 1 })).rejects.toThrow('folder_not_found');
    await expect(folders.change('owner', { type: 'pin', id: 'work', pinned: 'true', revision: 1 })).rejects.toThrow();
    await expect(folders.change('owner', { type: 'pin', id: 'work', pinned: true, revision: 0 })).rejects.toThrow('folders_changed');
    await expect(folders.change('owner', { type: 'pin', id: 'work', pinned: true, revision: 1 }, async () => { throw new Error('device_revoked'); })).rejects.toThrow('device_revoked');
    await expect(folders.change('other', { type: 'pin', id: 'work', pinned: true, revision: 0 })).rejects.toThrow('folder_not_found');
    expect(await folders.read('owner')).toEqual(before);
    const result = await Promise.allSettled([
      folders.change('owner', { type: 'pin', id: 'work', pinned: true, revision: 1 }),
      folders.change('owner', { type: 'delete', id: 'work', revision: 1 }),
    ]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await folders.read('owner')).revision).toBe(2);
  });
});
