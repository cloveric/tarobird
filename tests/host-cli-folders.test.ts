import { it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runFoldersCommand } from '../src/host-cli/folders.js';
import { runHostCli } from '../src/host-cli/cli.js';
import { initializeHost } from '../src/host-cli/setup.js';
import { LocalHostClient } from '../src/host-cli/client.js';
import { startHubControl } from '../src/hub/service.js';
import { HubServer } from '../src/hub/server.js';
import { ConversationFolders } from '../src/hub/conversation-folders.js';
import { FOLDER_PIN_CAPABILITY } from '../src/client-protocol/conversation-folders.js';
import { removeTempRoot } from './helpers/temp-files.js';

it('rejects ambiguous folder targets, missing revisions and unsupported hosts without requests', async () => {
  const request = vi.fn(), client = { request, ready: { serverCapabilities: [FOLDER_PIN_CAPABILITY] } } as any;
  for (const [action, id, flags] of [
    ['pin', 'work', { enabled: 'on' }], ['pin', 'work', { enabled: 'on', revision: '' }],
    ['pin', 'work', { unfiled: true, enabled: 'on', revision: '1' }], ['pin', undefined, { enabled: 'on', revision: '1' }],
    ['pin', '../work', { enabled: 'on', revision: '1' }], ['pin', 'work', { enabled: 'yes', revision: '1' }],
    ['list', 'work', {}], ['list', undefined, { enabled: 'on' }],
  ] as const) await expect(runFoldersCommand(client, action, id, flags)).rejects.toThrow();
  client.ready.serverCapabilities = [];
  await expect(runFoldersCommand(client, 'pin', 'work', { enabled: 'on', revision: '1' })).rejects.toThrow('更新主机');
  expect(request).not.toHaveBeenCalled();
});

it('pins and unpins through the actual CLI, authenticated Hub API and revision contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'folders-cli-')); await initializeHost(root, 'Folder fixture');
  const hub = await HubServer.start({ stateDir: root });
  let control: (() => Promise<void>) | undefined, client: LocalHostClient | undefined;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const folders = new ConversationFolders(hub.store.db);
    await folders.change('owner', { type: 'create', id: 'work', name: 'Work', revision: 0 });
    control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    client = await LocalHostClient.connect(root, { enroll: true });
    const cli = (args: string[]) => runHostCli(['folders', ...args, '--state-dir', root, '--json']);
    await cli(['list']); expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ revision: 1, order: ['work', null] });
    await cli(['pin', 'work', '--enabled', 'on', '--revision', '1']);
    expect((await folders.read('owner')).pinnedFolderIds).toEqual(['work']);
    await expect(cli(['pin', 'work', '--enabled', 'off', '--revision', '1'])).rejects.toThrow('folders_changed');
    await cli(['pin', '--unfiled', '--enabled', 'on', '--revision', '2']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).order).toEqual([null, 'work']);
    await cli(['pin', 'work', '--enabled', 'off', '--revision', '3']);
    expect((await folders.read('owner')).pinnedFolderIds).toEqual([null]);
    await cli(['pin', '--unfiled', '--enabled', 'off', '--revision', '4']);
    expect((await folders.read('owner')).pinnedFolderIds).toBeUndefined();
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).order).toEqual(['work', null]);
    await folders.change('owner', { type: 'create', id: 'life', name: 'Life', revision: 5 });
    await cli(['pin', 'life', '--enabled', 'on', '--revision', '6']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).order).toEqual(['life', 'work', null]);
    await cli(['pin', 'life', '--enabled', 'off', '--revision', '7']);
    await cli(['list']);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ revision: 8, order: ['work', 'life', null] });
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).not.toHaveProperty('unpinnedOrder');
  } finally { log.mockRestore(); client?.close(); await control?.(); await hub.close(); await removeTempRoot(root); }
});
