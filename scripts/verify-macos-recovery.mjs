// Fault-injection laboratory for actual packaged Mac host runtimes.
// No real account, provider CLI, OS service, Keychain or installed App is changed.
// Usage: node verify-macos-recovery.mjs OLD_HOST NEW_HOST EMPTY_LAB_DIRECTORY
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, cp, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
assert.equal(process.platform, 'darwin');
assert.equal(process.argv.length, 5, 'three explicit paths required');
const [oldRoot, newRoot, requestedLab] = process.argv.slice(2).map(value => path.resolve(value));
assert.ok(oldRoot && newRoot && requestedLab, 'three explicit paths required');
const parent = await realpath(path.dirname(requestedLab));
assert.ok(parent.startsWith('/Volumes/'), 'laboratory must live on an external volume');
const lab = path.join(parent, path.basename(requestedLab));
await mkdir(lab); // Must be new: never reuse or remove somebody else's state.
await mkdir(path.join(lab, 'tmp'));
const load = (root, file) => import(pathToFileURL(path.join(root, 'dist/src', file)).href);
const { HubStore } = await load(newRoot, 'hub/store.js');
const { hubServiceCommand } = await load(newRoot, 'hub/service.js');
const { desktopControllerProofText } = await load(newRoot, 'hub/local-controller.js');
const env = { ...process.env, TMPDIR: path.join(lab, 'tmp') };
delete env.NODE_OPTIONS; delete env.NODE_PATH;
const reports = [], owned = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
function statePath(directory) { assert.ok(directory.startsWith(lab + path.sep)); return directory; }
async function command(runtime, action, directory, input) {
  statePath(directory);
  // Read-only package files; only explicit synthetic state is writable.
  try {
    const pending = exec(path.join(runtime, 'node'),
      [path.join(runtime, 'dist/src/index.js'), 'desktop-host', action, directory],
      { cwd: runtime, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    pending.child.stdin.end(input === undefined ? '' : JSON.stringify(input));
    const { stdout } = await pending;
    const value = JSON.parse(stdout);
    if (value.running) owned.set(directory, runtime);
    return value;
  } catch (error) {
    throw Object.assign(new Error('packaged_command_failed'), {
      exitCode: error.code, diagnostic: String(error.stderr || error.message).slice(0, 1200),
    });
  }
}
async function stop(directory) {
  statePath(directory);
  await hubServiceCommand('stop', directory, path.join(newRoot, 'dist/src/index.js'));
  assert.equal((await command(newRoot, 'status', directory)).running, false);
  owned.delete(directory);
}
async function record(name, work) {
  const started = Date.now();
  try {
    const detail = await work(); reports.push({ name, passed: true, elapsedMs: Date.now() - started, ...detail });
    console.log(JSON.stringify(reports.at(-1)));
  } catch (error) {
    reports.push({ name, passed: false, error: error.message, diagnostic: error.diagnostic }); throw error;
  } finally { await writeFile(path.join(lab, 'results.json'), JSON.stringify(reports, null, 2)); }
}
async function dbCheck(directory, check) {
  const store = await HubStore.open(directory);
  try { return await check(store); } finally { await store.db.close(); }
}
const profile = path.join(lab, 'retained-profile');
const keys = generateKeyPairSync('ed25519');
const device = { deviceId: 'device_mac_recovery_lab', name: 'Synthetic laboratory device', platform: 'macos', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
let originalKey, conversationId;
try {
  await record('empty profile does not create a host implicitly', async () => {
    for (const runtime of [oldRoot, newRoot]) for (const action of ['resume', 'status']) {
      const result = await command(runtime, action, profile);
      assert.equal(result.available, true); assert.equal(result.running, false);
    }
    assert.equal(await exists(profile), false);
    return { runtimeVersions: await Promise.all([oldRoot, newRoot].map(async root => JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version)) };
  });
  await record('old Mac runtime starts and enrolls a synthetic owner', async () => {
    const host = await command(oldRoot, 'start', profile, { hostName: 'Mac recovery laboratory' });
    assert.equal(host.running, true); originalKey = host.publicKey;
    assert.equal((await (await fetch(host.url + '/health')).json()).publicKey, originalKey);
    const { desktopControllerChallenge: challenge } = await command(oldRoot, 'pair-challenge', profile, device);
    await command(oldRoot, 'pair', profile, { ...device, nativeProof: { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), keys.privateKey).toString('base64') } });
    await stop(profile);
    await dbCheck(profile, async store => {
      assert.equal((await store.db.get('SELECT id FROM devices WHERE id=?', [device.deviceId])).id, device.deviceId);
      await store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['sandbox_bot', 'Synthetic offline bot', digest('synthetic-only')]);
      const conversation = await store.createConversation('owner', ['sandbox_bot'], 'Retained synthetic history', 'recovery_fixture_chat');
      conversationId = conversation.id;
      await store.publishBotMessage('sandbox_bot', { conversationId, blocks: [{ type: 'text', text: 'SYNTHETIC_HISTORY_MUST_SURVIVE' }] });
    });
    await writeFile(path.join(profile, 'synthetic-workspace.txt'), 'SYNTHETIC_FILE_MUST_SURVIVE');
    return { health: true, authenticatedLocalEnrollment: true, syntheticHistorySeeded: true };
  });
  await record('replacement runtime preserves identity, pairing, history and files', async () => {
    const host = await command(newRoot, 'resume', profile);
    assert.equal(host.running, true); assert.equal(host.publicKey, originalKey);
    assert.equal((await (await fetch(host.url + '/health')).json()).publicKey, originalKey);
    await stop(profile);
    await dbCheck(profile, async store => {
      assert.equal((await store.db.get('SELECT id FROM devices WHERE id=?', [device.deviceId])).id, device.deviceId);
      assert.ok(JSON.stringify(await store.snapshot('owner', conversationId)).includes('SYNTHETIC_HISTORY_MUST_SURVIVE'));
    });
    assert.equal(await readFile(path.join(profile, 'synthetic-workspace.txt'), 'utf8'), 'SYNTHETIC_FILE_MUST_SURVIVE');
    return { oldDataPreserved: true };
  });
  await record('dead process lock is recovered without resetting identity', async () => {
    const directory = path.join(lab, 'stale-owner'); await cp(profile, directory, { recursive: true });
    await writeFile(path.join(directory, 'instance.lock.json'), JSON.stringify({ pid: 2147483646, token: 'synthetic-dead-owner', acquiredAt: '2024-01-01T00:00:00Z' }));
    const host = await command(newRoot, 'resume', directory);
    assert.equal(host.running, true); assert.equal(host.publicKey, originalKey);
    await stop(directory);
    return { automaticRecovery: true };
  });
  for (const [name, file, corrupt] of [
    ['truncated configuration', 'config.json', '{"host":'],
    ['damaged database', 'hub.sqlite', 'NOT_A_SQLITE_DATABASE'],
  ]) {
    await record(name + ': retained data fails, quarantined data starts fresh', async () => {
      const directory = path.join(lab, file === 'config.json' ? 'bad-config' : 'bad-database');
      await cp(profile, directory, { recursive: true });
      await writeFile(path.join(directory, file), corrupt);
      const brokenHash = digest(await readFile(path.join(directory, file)));
      const failures = [];
      // Repeating with the same intact package represents reinstall with retained state.
      for (let attempt = 0; attempt < 2; attempt++) {
        let failure;
        try { await command(newRoot, 'resume', directory); }
        catch (error) { failure = { exitCode: error.exitCode, diagnostic: error.diagnostic }; }
        assert.ok(failure, 'corruption must not silently become a different identity'); failures.push(failure);
      }
      assert.equal(digest(await readFile(path.join(directory, file))), brokenHash);
      // Laboratory simulation of whole-profile isolation; NOT an existing Mac UI.
      const backup = directory + '-backup'; await rename(directory, backup);
      const clean = await command(newRoot, 'resume', directory);
      assert.equal(clean.running, false); assert.equal(await exists(directory), false);
      const host = await command(newRoot, 'start', directory);
      assert.equal(host.running, true); assert.notEqual(host.publicKey, originalKey);
      assert.equal((await (await fetch(host.url + '/health')).json()).publicKey, host.publicKey);
      const freshKeys = generateKeyPairSync('ed25519');
      const freshDevice = { ...device, deviceId: 'device_fresh_mac_lab', publicKey: freshKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
      const { desktopControllerChallenge: challenge } = await command(newRoot, 'pair-challenge', directory, freshDevice);
      await command(newRoot, 'pair', directory, { ...freshDevice, nativeProof: { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), freshKeys.privateKey).toString('base64') } });
      await stop(directory);
      await dbCheck(directory, async store => {
        assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM devices')).n, 1);
        assert.equal((await store.db.get('SELECT id FROM devices')).id, freshDevice.deviceId);
        assert.equal((await store.db.get('SELECT COUNT(*) AS n FROM conversations')).n, 0);
      });
      assert.equal(digest(await readFile(path.join(backup, file))), brokenHash);
      assert.equal(await readFile(path.join(backup, 'synthetic-workspace.txt'), 'utf8'), 'SYNTHETIC_FILE_MUST_SURVIVE');
      return { reproducedFailures: failures, simulatedFreshStateRecovered: true, freshDeviceEnrolled: true, backupPreserved: true };
    });
  }
} finally {
  for (const directory of owned.keys()) await stop(directory).catch(error => {
    process.exitCode = 1; console.error('owned laboratory process cleanup failed:', directory, error.message);
  });
  await writeFile(path.join(lab, 'results.json'), JSON.stringify(reports, null, 2));
}
