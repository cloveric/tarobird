import { noIndexDirectory } from './macos-artifact-paths.mjs';
// Real Tauri archive/signature + bundled-Hub lifecycle acceptance on a copy.
// The source App is the updater-enabled bootstrap build, not an old DMG-only
// release. This proves installation/recovery, not GitHub OAuth or production UI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const exec = promisify(execFile);
assert.equal(process.platform, 'darwin');
assert.equal(process.argv.length, 7, 'APP ARCHIVE PUBLIC_KEY AUDIT_BINARY EMPTY_EXTERNAL_LAB required');
const [source, archive, publicKeyFile, audit, requested] = process.argv.slice(2).map(file => path.resolve(file));
const parent = await realpath(path.dirname(requested));
assert.ok(parent.startsWith('/Volumes/'), 'external laboratory required');
const lab = noIndexDirectory(path.join(parent, path.basename(requested)));
console.log('Disposable updater lab:', lab);
await mkdir(lab); await mkdir(path.join(lab, 'tmp'));
await writeFile(path.join(lab, 'disposable-updater-lab'), 'Synthetic data only\n');
const app = path.join(lab, 'TaroBot.app');
await exec('/usr/bin/ditto', [source, app]);
const host = path.join(app, 'Contents/Resources/host'), entrypoint = path.join(host, 'dist/src/index.js'), state = path.join(lab, 'state');
const env = { ...process.env, TMPDIR: path.join(lab, 'tmp') };
delete env.NODE_OPTIONS; delete env.NODE_PATH;
const load = file => import(pathToFileURL(path.join(host, 'dist/src', file)).href);
const { HubStore } = await load('hub/store.js');
const { desktopControllerProofText } = await load('hub/local-controller.js');
const { hubServiceCommand } = await load('hub/service.js');
async function command(action, input) {
  const pending = exec(path.join(host, 'node'), [entrypoint, 'desktop-host', action, state], { cwd: host, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  pending.child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  return JSON.parse((await pending).stdout);
}
const keys = generateKeyPairSync('ed25519');
const device = { deviceId: 'updater_fixture_device', name: 'Updater fixture', platform: 'macos', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
const publicKey = (await readFile(publicKeyFile, 'utf8')).trim(), signature = (await readFile(archive + '.sig', 'utf8')).trim();
// Read App metadata through the platform parser rather than assuming plist XML.
const appVersion = (await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')])).stdout.trim();
const server = createServer((req, res) => {
  if (req.url === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: appVersion, platforms: { 'darwin-aarch64': { url: `http://127.0.0.1:${server.address().port}/${tampered ? 'bad' : 'archive'}`, signature } } }));
  } else if (req.url === '/bad') res.end('deliberately modified archive');
  else if (req.url === '/archive') createReadStream(archive).pipe(res);
  else { res.statusCode = 404; res.end(); }
});
let tampered = true, running = false;
const results = [];
try {
  const initial = await command('start', { hostName: 'Isolated Mac updater' }); running = true;
  const challenge = (await command('pair-challenge', device)).desktopControllerChallenge;
  await command('pair', { ...device, nativeProof: { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), keys.privateKey).toString('base64') } });
  await hubServiceCommand('stop', state, entrypoint); running = false;
  const store = await HubStore.open(state);
  let conversation;
  try {
    await store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['updater_fixture_bot', 'Offline fixture', createHash('sha256').update('fixture').digest('hex')]);
    conversation = await store.createConversation('owner', ['updater_fixture_bot'], 'Retained update history', 'updater_fixture_chat');
    await store.publishBotMessage('updater_fixture_bot', { conversationId: conversation.id, blocks: [{ type: 'text', text: 'UPDATER_HISTORY_PRESERVED' }] });
  } finally { await store.db.close(); }
  await writeFile(path.join(state, 'fixture-file.txt'), 'UPDATER_FILE_PRESERVED');
  const before = await command('resume'); running = true;
  const inode = (await stat(app)).ino;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  for (const rejectSignature of [true, false]) {
    tampered = rejectSignature;
    await writeFile(path.join(lab, 'audit.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/manifest.json`, publicKey, rejectSignature }));
    await exec(audit, [lab], { env, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const receipt = JSON.parse(await readFile(path.join(lab, 'native-receipt.json'), 'utf8'));
    assert.equal(receipt.passed, true); results.push(receipt);
    if (rejectSignature) { assert.equal((await command('status')).pid, before.pid); assert.equal((await stat(app)).ino, inode); }
  }
  const after = await command('status');
  assert.equal(after.running, true); assert.notEqual(after.pid, before.pid);
  assert.equal(after.publicKey, initial.publicKey); assert.notEqual((await stat(app)).ino, inode);
  const receipt = JSON.parse(await readFile(path.join(lab, 'desktop-update-receipt.json'), 'utf8'));
  assert.equal(receipt.restartedHost, true); assert.equal(receipt.identityPreserved, true); assert.equal(receipt.historyPreserved, true);
  await hubServiceCommand('stop', state, entrypoint); running = false;
  const retained = await HubStore.open(state);
  try {
    assert.equal((await retained.db.get('SELECT id FROM devices WHERE id=?', [device.deviceId])).id, device.deviceId);
    assert.ok(JSON.stringify(await retained.snapshot('owner', conversation.id)).includes('UPDATER_HISTORY_PRESERVED'));
  } finally { await retained.db.close(); }
  assert.equal(await readFile(path.join(state, 'fixture-file.txt'), 'utf8'), 'UPDATER_FILE_PRESERVED');
  results.push({ passed: true, identity: true, pairing: true, chat: true, file: true, replacedBundle: true, hostVersion: after.version, appVersion, boundary: 'Native installer and synthetic bundled-host lifecycle; no production replacement or GitHub OAuth grant' });
  await writeFile(path.join(lab, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (running) await hubServiceCommand('stop', state, entrypoint).catch(() => undefined);
}
