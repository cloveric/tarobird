import os from "node:os";
// Real released packages, disposable host only. Does not install an OS service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [previous, candidate] = process.argv.slice(2).map(value => path.resolve(value));
if (!previous || !candidate) throw new Error('Usage: verify-host-package-upgrade.mjs OLD_PACKAGE NEW_PACKAGE');
const load = (root, name) => import(pathToFileURL(path.join(root, 'dist/src', name)).href);
const oldSetup = await load(previous, 'host-cli/setup.js');
const oldDesktop = await load(previous, 'hub/desktop.js');
const { LocalHostClient: OldClient } = await load(previous, 'host-cli/client.js');
const { HostNetwork: OldNetwork } = await load(previous, 'host-cli/network-cli.js');
const update = await load(candidate, 'host-cli/update.js');
const { desktopHost } = await load(candidate, 'hub/desktop.js');
const { LocalHostClient } = await load(candidate, 'host-cli/client.js');
const { HostNetwork } = await load(candidate, 'host-cli/network-cli.js');
// macOS's per-user TMPDIR leaves too little room for the staged runtime's
// Unix control socket; keep this disposable fixture under the short temp path.
const root = await mkdtemp(path.join(process.env.TAROBOT_ACCEPTANCE_TMPDIR || (process.platform === 'darwin' ? '/tmp' : os.tmpdir()), 'tbu-')), state = path.join(root, 'host');
const oldEntry = path.join(previous, 'dist/src/index.js');
let entry = oldEntry, client;
const preservedTables = ['messages', 'message_attachments', 'attachments', 'reads', 'message_deletions', 'deliveries', 'message_activity', 'message_hide_events'];
async function preservedData(store) {
  return Object.fromEntries(await Promise.all(preservedTables.map(async table => {
    const rows = await store.db.all(`SELECT * FROM ${table} ORDER BY 1,2`);
    // The pre-workbench release legitimately has no receipt column. Its
    // additive migration must yield null; every existing column stays exact.
    if (table === 'messages') for (const row of rows) if (!Object.hasOwn(row, 'workbench_receipt_json')) row.workbench_receipt_json = null;
    // Schema 25 adds per-message pause. Existing rows must migrate to the
    // unpaused default; retain and compare any pre-existing value exactly.
    if (table === 'deliveries') for (const row of rows) if (!Object.hasOwn(row, 'queue_paused')) row.queue_paused = 0;
    return [table, rows];
  })));
}
async function snapshotMessages(store, conversationId, after = 0, expectedMode) {
  const messages = [];
  let began = false;
  for await (const frame of store.snapshotFrames('owner', conversationId, after, { incremental: true })) {
    if (frame.type === 'snapshot.begin') { began = true; if (expectedMode) { assert.equal(frame.mode, expectedMode); assert.equal(frame.after, after); } }
    if (frame.type === 'snapshot.message') messages.push(frame.message);
  }
  assert.equal(began, true);
  return messages.sort((a, b) => a.id.localeCompare(b.id));
}
try {
  await oldSetup.initializeHost(state, 'Package upgrade fixture');
  await oldDesktop.desktopHost('start', state, oldEntry);
  client = await OldClient.connect(state, { enroll: true });
  const network = (await new OldNetwork(client).command({ operation: 'create', name: 'Retained network' })).view;
  client.close(); client = undefined;
  await oldDesktop.desktopHost('stop', state, oldEntry);
  // Seed through the released package, not candidate schema fixtures. All of
  // this lives in the disposable host; the Bots are unmanaged and never run.
  const { HubStore: OldStore } = await load(previous, 'hub/store.js');
  const { HubAttachments: OldAttachments } = await load(previous, 'hub/attachments.js');
  const oldStore = await OldStore.open(state);
  let conversation, input, userMessage, beforeData, beforeMessages, previousSchema, previousHead, attachmentId;
  const attachmentBytes = Buffer.from('Preserved upgrade attachment / 升级附件\n');
  try {
    for (const id of ['upgrade-a', 'upgrade-b']) await oldStore.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', [id, id, 'isolated-upgrade-fixture']);
    conversation = await oldStore.createConversation('owner', ['upgrade-a', 'upgrade-b'], 'Retained group history', 'upgrade-group');
    const attachments = new OldAttachments(oldStore, state); await attachments.initialize();
    const upload = await attachments.create('owner', { conversationId: conversation.id, name: 'retained.txt', mime: 'text/plain', size: attachmentBytes.length, sha256: createHash('sha256').update(attachmentBytes).digest('hex') });
    attachmentId = upload.id;
    await attachments.putChunk('owner', upload.id, 0, attachmentBytes); await attachments.complete('owner', upload.id);
    input = { conversationId: conversation.id, clientMsgId: 'upgrade-idempotent-input', text: 'Keep this question and its attachment', attachments: [upload.id], mentions: ['upgrade-a'] };
    userMessage = (await oldStore.sendMessage('owner', input)).message;
    let reply = await oldStore.publishBotMessage('upgrade-a', { conversationId: conversation.id, blocks: [{ type: 'text', text: 'starting' }], status: 'streaming' });
    for (let i = 0; i < 160; i++) reply = await oldStore.publishBotMessage('upgrade-a', { conversationId: conversation.id, id: reply.id, blocks: [{ type: 'text', text: `Revision ${i}: final content survives` }], status: i === 159 ? 'complete' : 'streaming' });
    const hidden = await oldStore.publishBotMessage('upgrade-b', { conversationId: conversation.id, blocks: [{ type: 'text', text: 'Personally hidden, not physically deleted' }], status: 'complete' });
    await oldStore.deleteMessages('owner', conversation.id, { messageIds: [hidden.id] });
    await oldStore.markRead('owner', conversation.id, (await oldStore.syncHead('owner', conversation.id)).seq);
    previousHead = (await oldStore.syncHead('owner', conversation.id)).seq;
    previousSchema = (await oldStore.db.get("SELECT value FROM meta WHERE key='schema_version'")).value;
    beforeData = await preservedData(oldStore);
    beforeMessages = await snapshotMessages(oldStore, conversation.id);
  } finally { await oldStore.db.close(); }
  await mkdir(path.join(state, 'bots/fixture/workspace'), { recursive: true });
  await writeFile(path.join(state, 'bots/fixture/workspace/notes.txt'), 'Retained workspace');
  const identity = await readFile(path.join(state, 'identity.json'), 'utf8');
  const controller = await readFile(path.join(state, 'cli/identity.json'), 'utf8');
  const revision = await update.stageHostUpdate(state, candidate);
  await update.activateHostUpdate(state, revision.id, { currentEntrypoint: oldEntry });
  entry = revision.entrypoint;
  const status = await desktopHost('start', state, entry);
  assert.equal(status.hostName, 'Package upgrade fixture');
  client = await LocalHostClient.connect(state);
  const afterNetwork = await new HostNetwork(client).view();
  assert.equal(afterNetwork.membership.manifest.id, network.membership.manifest.id);
  assert.equal(afterNetwork.host.publicKey, network.host.publicKey);
  assert.equal(await readFile(path.join(state, 'identity.json'), 'utf8'), identity);
  assert.equal(await readFile(path.join(state, 'cli/identity.json'), 'utf8'), controller);
  assert.equal(await readFile(path.join(state, 'bots/fixture/workspace/notes.txt'), 'utf8'), 'Retained workspace');
  client.close(); client = undefined;
  await desktopHost('stop', state, entry);
  const { HubStore } = await load(candidate, 'hub/store.js');
  const { HubAttachments } = await load(candidate, 'hub/attachments.js');
  const { EventHistoryRetention } = await load(candidate, 'hub/event-history.js');
  const store = await HubStore.open(state);
  let schema, reclaimed;
  try {
    schema = (await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).value;
    assert.equal(Number(schema), JSON.parse(await readFile(path.join(candidate, 'package.json'))).tarobotHostUpdate.maxHubSchema);
    assert.deepEqual(await preservedData(store), beforeData);
    assert.deepEqual(await snapshotMessages(store, conversation.id), beforeMessages);
    reclaimed = await new EventHistoryRetention(store, { retentionDays: 7, maxBytes: 1024 * 1024, maxRows: 128 }).run(Date.now(), 10_000);
    assert.ok(reclaimed.removed > 0, 'released journal must be reclaimable after migration');
    assert.deepEqual(await preservedData(store), beforeData);
    assert.deepEqual(await snapshotMessages(store, conversation.id), beforeMessages);
    // This offline device already has sequence 1 (the user's message). A
    // merge snapshot correctly omits unchanged content at/before its cursor.
    const offline = new Map([[userMessage.id, userMessage]]);
    const merge = await snapshotMessages(store, conversation.id, 1, 'merge');
    assert.equal(merge.some(message => message.id === userMessage.id), false);
    for (const message of merge) offline.set(message.id, message);
    assert.deepEqual([...offline.values()].sort((a, b) => a.id.localeCompare(b.id)), beforeMessages);
    assert.equal((await store.syncHead('owner', conversation.id)).seq, previousHead);
    await assert.rejects(store.sync('owner', conversation.id, 1), { code: 'sync_snapshot_required' });
    assert.deepEqual((await store.sync('owner', conversation.id, previousHead)).events, []);
    const duplicate = await store.sendMessage('owner', input);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.message.id, userMessage.id);
    const downloaded = await new HubAttachments(store, state).download({ userId: 'owner' }, attachmentId);
    assert.deepEqual(await readFile(downloaded.path), attachmentBytes);
    assert.deepEqual(await store.db.get('PRAGMA quick_check'), { quick_check: 'ok' });
  } finally { await store.db.close(); }
  if (Number(previousSchema) < Number(schema)) {
    const file = path.join(state, 'hub.sqlite'), bytes = await readFile(file);
    await assert.rejects(OldStore.open(state), /unsupported_hub_schema_version/);
    assert.deepEqual(await readFile(file), bytes, 'old Host must reject without modifying the migrated database');
  }
  console.log(JSON.stringify({ previousVersion: JSON.parse(await readFile(path.join(previous, 'package.json'))).version, version: revision.version, previousSchema: Number(previousSchema), schema: Number(schema), identityRetained: true, controllerRetained: true, networkRetained: true, workspaceRetained: true, upgradedHostStarted: true, messagesRetained: true, attachmentBytesRetained: true, readsAndHiddenStateRetained: true, idempotencyRetained: true, offlineSnapshotRecoveryVerified: true, historyUpdatesReclaimed: reclaimed.removed, nativeServiceInstall: false }));
} finally {
  client?.close();
  await desktopHost('stop', state, entry).catch(() => undefined);
  // Both the disposable state and its sibling host.runtime are inside root.
  await rm(root, { recursive: true, force: true });
}
