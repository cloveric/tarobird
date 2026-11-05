import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubDatabase } from '../src/hub/database.js';
import { HubStore } from '../src/hub/store.js';
import { ConversationBatchOperations } from '../src/hub/conversation-batch.js';
import { ConversationFolders } from '../src/hub/conversation-folders.js';
import { conversationBatchSchema } from '../src/client-protocol/conversation-batch.js';

describe('atomic conversation organization', () => {
  let root: string, db: HubDatabase, store: HubStore, batch: ConversationBatchOperations, folders: ConversationFolders, a: string, b: string, group: string, topic: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'conversation-batch-'));
    db = await HubDatabase.open(root); store = new HubStore(db); batch = new ConversationBatchOperations(store); folders = new ConversationFolders(db);
    await db.run("INSERT INTO users VALUES('owner','Owner','owner'),('other','Other','member')");
    await db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    a = (await store.createConversation('owner', ['bot'], 'A', 'a')).id;
    b = (await store.createConversation('owner', ['bot'], 'B', 'b')).id;
    group = (await store.createConversation('owner', ['bot'], 'Group', 'g', { type: 'group' })).id;
    topic = (await store.createConversation('owner', ['bot'], 'Topic', 't', { type: 'group', parentId: group })).id;
  });
  afterEach(async () => { await db.close(); await rm(root, { recursive: true, force: true }); });
  const archive = (ids: string[], requestId = 'request') => ({ action: 'archive', requestId, conversationIds: ids });
  it('archives exactly the selected rows, preserving sessions, pending work and history', async () => {
    await store.updateConversation('owner', a, { sessionId: 'session' });
    const binding = (await store.conversationInTransaction(a)).bindingId;
    await db.run("INSERT INTO messages(id,conversation_id,author_type,author_id,blocks_json,status,version,created_at) VALUES('msg',?,'bot','bot','[]','streaming',1,1)", [a]);
    const result = await batch.apply('owner', archive([a, b]));
    expect(result.receipt.conversationIds).toEqual([a, b].sort());
    expect(await store.conversationInTransaction(a)).toMatchObject({ archived: true, sessionId: 'session', bindingId: binding });
    expect(await store.conversationInTransaction(group)).toMatchObject({ archived: false });
    expect(await db.get('SELECT status FROM messages WHERE id=?', ['msg'])).toEqual({ status: 'streaming' });
  });
  it('normalizes selected root plus topic without leaving the topic archived after restore', async () => {
    const result = await batch.apply('owner', archive([group, topic]));
    expect(result.receipt.conversationIds).toEqual([group]);
    expect((await store.conversationInTransaction(topic)).archived).toBe(false);
    await store.updateConversation('owner', group, { archived: false });
    expect((await store.conversationInTransaction(topic)).archived).toBe(false);
  });
  it('archives a topic alone without changing its parent or siblings', async () => {
    await batch.apply('owner', archive([topic]));
    expect((await store.conversationInTransaction(topic)).archived).toBe(true);
    expect((await store.conversationInTransaction(group)).archived).toBe(false);
  });
  it('a covered topic need not be owned or available, but must still belong to the user', async () => {
    await db.run("UPDATE conversations SET owner_id='other',archived=1 WHERE id=?", [topic]);
    const result = await batch.apply('owner', archive([group, topic]));
    expect(result.receipt.conversationIds).toEqual([group]);
    await store.updateConversation('owner', group, { archived: false });
    expect((await store.conversationInTransaction(topic)).archived).toBe(true);
    await db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user' AND member_id='owner'", [topic]);
    await expect(batch.apply('owner', archive([group, topic], 'another'))).rejects.toThrow('conversation_forbidden');
    expect((await store.conversationInTransaction(group)).archived).toBe(false);
  });
  it('restores a group without reviving separately archived topics; explicit topics and receipts remain scoped', async () => {
    await store.updateConversation('owner', topic, { archived: true });
    await batch.apply('owner', archive([group]));
    await expect(batch.apply('owner', { action: 'restore', requestId: 'topic-only', conversationIds: [topic] })).rejects.toThrow('conversation_not_available');
    await batch.apply('owner', { action: 'restore', requestId: 'restore-group', conversationIds: [group] });
    expect((await store.conversationInTransaction(topic)).archived).toBe(true);
    await batch.apply('owner', archive([group], 'archive-again'));
    const restored = await batch.apply('owner', { action: 'restore', requestId: 'restore-both', conversationIds: [topic, group] });
    expect(restored.receipt.conversationIds).toEqual([topic, group].sort());
    expect(restored.conversations.every(chat => !chat.archived)).toBe(true);
  });
  it('rolls back mixed-authority restores and refuses restoring deleted Bots', async () => {
    await batch.apply('owner', archive([a, b]));
    await db.run("UPDATE conversations SET owner_id='other' WHERE id=?", [b]);
    await expect(batch.apply('owner', { action: 'restore', requestId: 'restore', conversationIds: [a, b] })).rejects.toThrow('conversation_owner_required');
    expect((await store.conversationInTransaction(a)).archived).toBe(true);
    await db.run("UPDATE bots SET deleted_at=1 WHERE id='bot'");
    await expect(batch.apply('owner', { action: 'restore', requestId: 'deleted', conversationIds: [a] })).rejects.toThrow('bot_deleted');
    expect((await store.conversationInTransaction(a)).archived).toBe(true);
  });
  it('legacy folder edits cannot bypass the receipted batch endpoint', async () => {
    await expect(folders.change('owner', { type: 'create-many', id: 'work', name: 'Work', conversationIds: [a, b], revision: 0 })).rejects.toThrow();
    expect((await folders.read('owner')).folders).toEqual([]);
  });
  it('rejects a mixed-authority batch atomically and writes no receipt', async () => {
    await db.run("UPDATE conversations SET owner_id='other' WHERE id=?", [b]);
    await expect(batch.apply('owner', archive([a, b]))).rejects.toThrow('conversation_owner_required');
    expect((await store.conversationInTransaction(a)).archived).toBe(false);
    expect(await db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 0 });
  });
  it('validates queued authority before any write and never leaks a receipt to a different user', async () => {
    await expect(batch.apply('owner', archive([a]), async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
    expect((await store.conversationInTransaction(a)).archived).toBe(false);
    await batch.apply('owner', archive([a]));
    await expect(batch.apply('other', archive([a]))).rejects.toThrow();
  });
  it('lost-receipt replay after restart never archives a later restored conversation', async () => {
    const input = archive([a, b]); await batch.apply('owner', input);
    await store.updateConversation('owner', a, { archived: false });
    await db.close(); db = await HubDatabase.open(root); store = new HubStore(db); batch = new ConversationBatchOperations(store);
    const replay = await batch.apply('owner', { ...input, conversationIds: [b, a] });
    expect(replay.replayed).toBe(true);
    expect(replay.conversations.find(chat => chat.id === a)?.archived).toBe(false);
    expect((await store.conversationInTransaction(a)).archived).toBe(false);
    await expect(batch.apply('owner', archive([group]))).rejects.toThrow('conversation_batch_request_conflict');
  });
  it('concurrent repeated requests return one durable receipt', async () => {
    const results = await Promise.all([batch.apply('owner', archive([a])), batch.apply('owner', archive([a]))]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(await db.get('SELECT COUNT(*) AS n FROM conversation_batch_requests')).toEqual({ n: 1 });
  });
  it('moves and creates one folder in the same transaction and single revision', async () => {
    const result = await batch.apply('owner', { action: 'move', requestId: 'move', conversationIds: [a, b], revision: 0, target: { newFolder: { id: 'work', name: ' Work ' } } });
    expect(result.folders).toMatchObject({ revision: 1, folders: [{ id: 'work', name: 'Work' }] });
    expect(result.folders?.assignments).toHaveLength(2);
    expect((await store.conversationInTransaction(a)).archived).toBe(false);
    await batch.apply('owner', { action: 'move', requestId: 'unfiled', conversationIds: [a, b], revision: 1, target: { folderId: null } });
    expect((await folders.read('owner')).assignments).toEqual([]);
  });
  it('replays an old move receipt without overwriting later folder assignments', async () => {
    const input = { action: 'move', requestId: 'move', conversationIds: [a, b], revision: 0, target: { newFolder: { id: 'work', name: 'Work' } } };
    await batch.apply('owner', input);
    await folders.change('owner', { type: 'move', revision: 1, conversationId: a, folderId: null });
    const replay = await batch.apply('owner', input);
    expect(replay.replayed).toBe(true);
    expect(replay.folders?.revision).toBe(2);
    expect(replay.folders?.assignments).toEqual([{ conversationId: b, folderId: 'work' }]);
  });
  it('revision conflict, unavailable rows and topics roll back every selected move and folder creation', async () => {
    const input = { action: 'move', requestId: 'move', conversationIds: [a, b], revision: 2, target: { newFolder: { id: 'work', name: 'Work' } } };
    await expect(batch.apply('owner', input)).rejects.toThrow('folders_changed');
    await expect(batch.apply('owner', { ...input, revision: 0, conversationIds: [a, topic] })).rejects.toThrow('conversation_batch_topic_move');
    await store.updateConversation('owner', b, { archived: true });
    await expect(batch.apply('owner', { ...input, revision: 0 })).rejects.toThrow('conversation_not_available');
    expect(await folders.read('owner')).toEqual({ revision: 0, folders: [], assignments: [] });
  });
  it.each([[], ['a', 'a'], ['../a'], Array.from({ length: 101 }, (_, i) => `c${i}`)])('rejects malformed or oversized selection %j', ids => {
    expect(conversationBatchSchema.safeParse(archive(ids)).success).toBe(false);
  });
});
