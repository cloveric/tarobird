// Explicit signed Electron acceptance. No production credential is read and
// the installed App is used only for its designated signing requirement.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createPublicKey, verify, createHash } from 'node:crypto';
import { readFile, writeFile, realpath, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { _electron } from '@playwright/test';
import { extractFile } from '@electron/asar';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const [legacyApp, appInput, output, fixtureInput] = process.argv.slice(2);
if (process.platform !== 'darwin' || !legacyApp || !appInput || !output || !fixtureInput) throw new Error('explicit legacy App, signed development Electron App, isolated output and signed fixture required');
const root = await isolatedRoot(output), appBundle = await realpath(appInput), fixture = await realpath(fixtureInput);
for (const binary of [appBundle, fixture]) if (!binary.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('isolated_binary_required');
const metadata = JSON.parse(extractFile(path.join(appBundle, 'Contents/Resources/app.asar'), 'desktop.json').toString());
assert.equal(metadata.mode, 'development', 'never redirect a production package into test state');
const helper = path.join(appBundle, 'Contents/Resources/native/tarobot-desktop-core');
const binary = path.join(appBundle, 'Contents/MacOS/tarocub-client');
const legacyExecutable = path.join(legacyApp, 'Contents/MacOS/tarocub-client');
const requirement = file => execFileSync('/usr/bin/codesign', ['-d', '-r-', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
for (const file of [legacyApp, appBundle, helper, fixture]) execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'pipe' });
const oldRequirement = requirement(legacyApp);
assert.match(oldRequirement, /identifier "com\.tarobot\.client"/); assert.match(oldRequirement, /anchor apple generic/);
assert.equal(requirement(helper), oldRequirement, 'new credential reader must retain the legacy designated requirement');
assert.equal(requirement(fixture), oldRequirement, 'fixture creator must retain the legacy designated requirement');
const isolated = await mkdtemp(path.join(root, 'profile-'));
const profile = path.join(isolated, 'electron-profile'), state = path.join(isolated, 'native-state');
const service = `com.tarobot.client.device.dev-${createHash('sha256').update(profile).digest('hex').slice(0, 20)}`;
const id = `device_${randomUUID().replaceAll('-', '')}`, input = path.join(root, 'fixture-input.json');
await writeFile(input, JSON.stringify({ legacyExecutable, state }), { flag: 'wx', mode: 0o600 });
await writeFile(path.join(root, 'cleanup.json'), JSON.stringify({ fixture, service, id, input }), { flag: 'wx', mode: 0o600 });
let app, created, retired = false;
try {
  app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${isolated}`], env: helperEnvironment(), timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.tarobotDesktop?.engine === 'electron' && !document.querySelector('.desktop-migration-gate'), null, { timeout: 30000 });
  // Before React mounts, absence of the gate is not startup completion.
  await page.getByRole('heading', { name: '从这台电脑开始', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(JSON.parse(await readFile(path.join(profile, 'tarobot-desktop-profile-v1.json'), 'utf8')).mode, 'fresh');
  created = JSON.parse(execFileSync(fixture, ['create', service, id, input], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const call = (command, args) => page.evaluate(({ command, args }) => window.tarobotDesktop.invoke(command, args), { command, args });
  const signature = await call('device_sign', { keyRef: id, deviceId: id, nonce: 'legacy-acl', clientNonce: 'electron-reader' });
  const publicKey = createPublicKey({ key: Buffer.from(created.publicKey, 'base64'), type: 'spki', format: 'der' });
  assert(verify(null, Buffer.from(`tarocub/device/v1\0${id}\0legacy-acl\0electron-reader`), publicKey, Buffer.from(signature, 'base64')));
  await call('device_forget', { keyRef: id }); retired = true;
  await assert.rejects(call('device_sign', { keyRef: id, deviceId: id, nonce: 'retired', clientNonce: 'electron-reader' }), /device_key_unavailable/);
  const refused = spawn(helper, ['--state-dir', state, '--keyring-service', service, '--resources-dir', path.join(appBundle, 'Contents/Resources/host'), '--host-state-dir', path.join(isolated, 'app-state')], { env: helperEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const exitCode = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { refused.kill('SIGKILL'); reject(new Error('untrusted_helper_did_not_refuse')); }, 5000);
    refused.once('error', reject); refused.once('exit', code => { clearTimeout(timeout); resolve(code); }); });
  assert.equal(exitCode, 77);
  const productionServiceExit = await app.evaluate(async (_electron, { helper, state, resources, hostState }) => {
    const { spawn } = process.getBuiltinModule('node:child_process');
    const child = spawn(helper, ['--state-dir', state, '--keyring-service', 'com.tarobot.client.device', '--resources-dir', resources, '--host-state-dir', hostState], { stdio: ['pipe', 'pipe', 'pipe'] });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('acceptance_production_service_not_refused')); }, 5000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
  }, { helper, state, resources: path.join(appBundle, 'Contents/Resources/host'), hostState: path.join(isolated, 'app-state') });
  assert.equal(productionServiceExit, 77, 'development main cannot reach the production credential service');
  const receipt = { passed: true, legacyApp, appBundle, helper, helperSha256: createHash('sha256').update(await readFile(helper)).digest('hex'),
    designatedRequirement: oldRequirement, fixture: 'legacy creator API; actual signed Electron parent; isolated installation-bound credential',
    checks: ['strict signatures', 'legacy requirement retained', 'actual Electron parent accepted', 'unchanged old-creator Keychain access policy', 'Ed25519 proof verified', 'exact disposable credential retired', 'retired credential cannot sign', 'direct Node launch refused', 'signed development parent refused production service before Keychain access'],
    productionCredentialRead: false, installedAppChanged: false, hostStarted: false, timestamp: new Date().toISOString() };
  await writeFile(path.join(root, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify(receipt));
} finally {
  if (app) await Promise.race([app.close(), new Promise(resolve => { const timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 5000); timer.unref(); })]);
  if (!retired) {
    try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', id], { timeout: 15000, stdio: 'pipe' }); }
    catch (error) { if (created) throw error; }
  }
}
