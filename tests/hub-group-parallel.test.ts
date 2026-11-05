import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { HubServer } from '../src/hub/server.js';
import type { Conversation } from '../src/client-protocol/index.js';
import type { GroupDiscussionPolicy } from '../src/client-protocol/group-discussion.js';
let root: string, hub: HubServer, chat: Conversation;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'group-parallel-'));
  hub = await HubServer.start({ stateDir: root });
  for (const id of ['a', 'b', 'c']) await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, id, 'fixture']);
  chat = await hub.store.createConversation('owner', ['a', 'b'], 'Group', 'group', { type: 'group' });
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
async function mode(value: GroupDiscussionPolicy['mode']) {
  const current = await hub.store.groupSettings('owner', chat.id);
  return hub.store.updateGroup('owner', chat.id, { title: chat.title, expectedTitle: chat.title, botIds: chat.botIds, expectedBotIds: chat.botIds,
    policy: { ...current.policy, mode: value }, expectedRevision: current.revision });
}
const input = (id: string, extra: object = {}) => ({ conversationId: chat.id, clientMsgId: id, text: id, attachments: [], ...extra });
const recipients = (id: string) => hub.store.db.all<{ bot_id: string }>('SELECT bot_id FROM deliveries WHERE message_id=? ORDER BY bot_id', [id]).then(rows => rows.map(row => row.bot_id));

it('broadcasts normal human input, freezes recipients and lets explicit mentions override, including topics', async () => {
  await mode('parallel');
  const sent = await hub.store.sendMessage('owner', input('all'));
  expect(sent.message.mentions).toEqual(['a', 'b']); expect(await recipients(sent.message.id)).toEqual(['a', 'b']);
  const selected = await hub.store.sendMessage('owner', input('only-b', { mentions: ['b'] }));
  expect(await recipients(selected.message.id)).toEqual(['b']);
  const topic = await hub.store.createConversation('owner', [], 'Topic', 'topic', { parentId: chat.id });
  const child = await hub.store.sendMessage('owner', input('topic-input', { conversationId: topic.id }));
  expect(await recipients(child.message.id)).toEqual(['a', 'b']);
  await mode('mentions');
  expect(await hub.store.sendMessage('owner', input('all'))).toMatchObject({ duplicate: true, message: { id: sent.message.id, mentions: ['a', 'b'] } });
  expect(await recipients(sent.message.id)).toEqual(['a', 'b']);
  const note = await hub.store.sendMessage('owner', input('record-only'));
  expect(await recipients(note.message.id)).toEqual([]);
  const direct = await hub.store.createConversation('owner', ['a'], 'Direct', 'direct');
  expect(await recipients((await hub.store.sendMessage('owner', input('direct-input', { conversationId: direct.id }))).message.id)).toEqual(['a']);
});

it('never broadcasts Bot outputs or forwarded reference material and rejects unsafe recipient changes', async () => {
  await mode('parallel');
  const reply = await hub.store.publishBotMessage('a', { conversationId: chat.id, blocks: [{ type: 'text', text: '@b peer text' }] });
  expect(await recipients(reply.id)).toEqual([]);
  const forwarded = await hub.store.forwardMessage('owner', { v: 1, type: 'message.forward', conversationId: chat.id, sourceMessageId: reply.id, clientMsgId: 'forward' }, async () => {});
  expect(await recipients(forwarded.message.id)).toEqual([]);
  await expect(hub.store.sendMessage('owner', input('outside', { mentions: ['c'] }))).rejects.toThrow('mention_forbidden');
  await expect(hub.store.sendMessage('owner', input('old-client', { parallelCapable: false }))).rejects.toThrow('group_parallel_client_update_required');
  const named = await hub.store.sendMessage('owner', input('old-named', { parallelCapable: false, mentions: ['a'] }));
  expect(await recipients(named.message.id)).toEqual(['a']);
  await expect(hub.store.sendMessage('owner', input('revoked'), async () => { throw new Error('device_revoked'); })).rejects.toThrow('device_revoked');
  expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM messages WHERE client_msg_id IN ('outside','old-client','revoked')")).toEqual({ n: 0 });
});

it('supports one-member groups, retains per-Bot sessions and refuses to create a discussion run', async () => {
  chat = await hub.store.createConversation('owner', ['a'], 'Solo', 'solo', { type: 'group' });
  await mode('parallel');
  const settings = await hub.store.groupSettings('owner', chat.id);
  await expect(hub.groupDiscussions.start('owner', chat.id, { requestId: 'no-round', revision: settings.revision, text: 'topic' })).rejects.toThrow('group_discussion_mode_required');
  expect(await hub.store.db.get('SELECT COUNT(*) AS n FROM group_discussions')).toEqual({ n: 0 });
  expect(await recipients((await hub.store.sendMessage('owner', input('single'))).message.id)).toEqual(['a']);
  const before = (await hub.store.conversations('owner')).find(value => value.id === chat.id);
  await mode('mentions'); await mode('parallel');
  expect((await hub.store.conversations('owner')).find(value => value.id === chat.id)).toEqual(before);
});

it('requires ending an existing automatic discussion before enabling parallel replies', async () => {
  await mode('sequential');
  const settings = await hub.store.groupSettings('owner', chat.id);
  await hub.groupDiscussions.start('owner', chat.id, { requestId: 'active', revision: settings.revision, text: 'topic' });
  await expect(mode('parallel')).rejects.toThrow('group_parallel_discussion_active');
  expect((await hub.store.groupSettings('owner', chat.id)).policy.mode).toBe('sequential');
});

it('migrates schema 20 policy constraints without losing existing groups, messages or policy', async () => {
  await mode('independent');
  const note = await hub.store.sendMessage('owner', input('preserved-note'));
  const before = await hub.store.groupSettings('owner', chat.id);
  await hub.store.db.transaction(async () => {
    await hub.store.db.exec(`ALTER TABLE group_discussion_settings RENAME TO old_settings;
      CREATE TABLE group_discussion_settings (group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('mentions','sequential','independent')), order_json TEXT NOT NULL, max_rounds INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO group_discussion_settings SELECT * FROM old_settings; DROP TABLE old_settings;
      UPDATE meta SET value='20' WHERE key='schema_version';`);
  });
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect(await hub.store.groupSettings('owner', chat.id)).toEqual(before);
  expect((await hub.store.messageForUser('owner', note.message.id)).blocks).toEqual(note.message.blocks);
  expect(await hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: '25' });
  await mode('parallel');
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect((await hub.store.groupSettings('owner', chat.id)).policy.mode).toBe('parallel');
  expect(await recipients((await hub.store.sendMessage('owner', input('after-restart'))).message.id)).toEqual(['a', 'b']);
});
