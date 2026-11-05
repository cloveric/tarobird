import { expect, it, vi } from 'vitest';
import { runConversationsCommand } from '../src/host-cli/conversations.js';
import { CONVERSATION_BATCH_CAPABILITY, CONVERSATION_RESTORE_CAPABILITY } from '../src/client-protocol/conversation-batch.js';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runHostCli } from '../src/host-cli/cli.js';
import { initializeHost } from '../src/host-cli/setup.js';
import { HostCliError, LocalHostClient } from '../src/host-cli/client.js';
import { startHubControl } from '../src/hub/service.js';
import { HubServer } from '../src/hub/server.js';
import { ConversationFolders } from '../src/hub/conversation-folders.js';
import { removeTempRoot } from './helpers/temp-files.js';

it('rejects dangerous/ambiguous CLI arguments without issuing a request', async () => {
  const client = { request: vi.fn(), ready: { serverCapabilities: [CONVERSATION_BATCH_CAPABILITY] } } as any;
  for (const [action, flags] of [
    ['archive', { ids: 'a' }], ['archive', { ids: 'a,a', yes: true }], ['archive', { ids: 'a', yes: true, folder: 'x' }],
    ['move', { ids: 'a', folder: 'x' }], ['move', { ids: 'a', folder: 'x', unfiled: true, revision: '0' }],
    ['move', { ids: 'a', unfiled: true, revision: 'Infinity' }], ['local', { ids: 'a' }],
    ['move', { ids: 'a', newFolder: ' ', revision: '0' }],
  ] as const) await expect(runConversationsCommand(client, action, flags)).rejects.toThrow();
  client.ready.serverCapabilities = [];
  await expect(runConversationsCommand(client, 'archive', { ids: 'a', yes: true })).rejects.toThrow('更新主机');
  client.ready.serverCapabilities = [CONVERSATION_BATCH_CAPABILITY];
  await expect(runConversationsCommand(client, 'restore', { ids: 'a', yes: true })).rejects.toThrow('更新主机');
  client.ready.serverCapabilities.push(CONVERSATION_RESTORE_CAPABILITY);
  await expect(runConversationsCommand(client, 'restore', { ids: 'a' })).rejects.toThrow('--yes');
  expect(client.request).not.toHaveBeenCalled();
});
it('announces a stable request and gives new-folder retries the same target ID', async () => {
  const inputs: any[] = [], announce = vi.fn();
  const client = { ready: { serverCapabilities: [CONVERSATION_BATCH_CAPABILITY] }, request: vi.fn(async (_route, _method, body) => {
    inputs.push(body);
    return { receipt: { requestId: body.requestId, action: body.action, conversationIds: body.conversationIds, completedAt: 1 }, replayed: inputs.length > 1, conversations: [] };
  }) } as any;
  for (let i = 0; i < 2; i++) await runConversationsCommand(client, 'move', { ids: 'a,b', newFolder: 'Work', revision: '0', requestId: 'same' }, announce);
  expect(inputs[0]).toEqual(inputs[1]); expect(announce).toHaveBeenCalledWith('same');
  expect(client.request).toHaveBeenCalledWith('/api/conversations/batch', 'POST', expect.objectContaining({ action: 'move', conversationIds: ['a', 'b'] }));
});

it('lists, moves, archives and safely retries through the real CLI and authenticated Host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversations-cli-')); await initializeHost(root, 'Batch fixture');
  const hub = await HubServer.start({ stateDir: root });
  let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const a = await hub.store.createConversation('owner', ['bot'], 'A', 'a');
    const b = await hub.store.createConversation('owner', ['bot'], 'B', 'b');
    const ids = `${a.id},${b.id}`;
    const folders = new ConversationFolders(hub.store.db);
    control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    client = await LocalHostClient.connect(root, { enroll: true });
    const cli = (args: string[]) => runHostCli(['conversations', ...args, '--state-dir', root, '--json']);
    await cli(['local']); expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toHaveLength(2);
    await expect(cli(['archive', '--ids', ids, '--ids', a.id, '--yes'])).rejects.toThrow();
    await cli(['move', '--ids', ids, '--new-folder', 'Work', '--revision', '0', '--request-id', 'move']);
    expect((await folders.read('owner')).assignments).toHaveLength(2);
    await cli(['move', '--ids', ids, '--new-folder', 'Work', '--revision', '0', '--request-id', 'move']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).replayed).toBe(true);
    await cli(['move', '--ids', ids, '--unfiled', '--revision', '1', '--request-id', 'unfiled']);
    expect((await folders.read('owner')).assignments).toEqual([]);
    await cli(['archive', '--ids', ids, '--yes', '--request-id', 'archive']);
    await hub.store.updateConversation('owner', a.id, { archived: false });
    await cli(['archive', '--ids', ids, '--yes', '--request-id', 'archive']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).replayed).toBe(true);
    expect((await hub.store.conversationInTransaction(a.id)).archived).toBe(false);
    expect((await hub.store.conversationInTransaction(b.id)).archived).toBe(true);
    await cli(['restore', '--ids', ids, '--yes', '--request-id', 'restore']);
    expect((await hub.store.conversationInTransaction(b.id)).archived).toBe(false);
    await hub.store.updateConversation('owner', b.id, { archived: true });
    await cli(['restore', '--ids', ids, '--yes', '--request-id', 'restore']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).replayed).toBe(true);
    expect((await hub.store.conversationInTransaction(b.id)).archived).toBe(true);
  } finally { log.mockRestore(); err.mockRestore(); client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
});

it('adds actionable CLI explanations while retaining the Host error code and status', async () => {
  const error = new HostCliError('folders_changed', 409);
  const client = { ready: { serverCapabilities: [CONVERSATION_BATCH_CAPABILITY] }, request: vi.fn().mockRejectedValue(error) } as any;
  await expect(runConversationsCommand(client, 'move', { ids: 'a', unfiled: true, revision: '0' })).rejects.toMatchObject({ code: 'folders_changed', status: 409, message: expect.stringContaining('folders list') });
  expect(client.request).toHaveBeenCalledTimes(1);
});
