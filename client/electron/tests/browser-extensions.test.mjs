import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { BrowserExtensions, EXTENSIONS_COMMAND, compatibility, extensionId, prepareStaged, storeExtensionId } from '../browser-extensions.mjs';
import { ARCHIVE_LIMITS, checkNames, packagePath, stageFolder, stageZip, zipEntries } from '../extension-archive.mjs';
import { verifyCrx3 } from '../crx3.mjs';
import { BROWSER_ACTIONS, USER_ONLY, parseBrowserAction } from '../browser-contract.mjs';
import { COMPAT_PROBE, installRequestFilter, partitionFor } from '../browser-policy.mjs';
import { BROWSER_COMMANDS, WorkbenchBrowser } from '../browser.mjs';
import { DESKTOP_COMMANDS } from '../contract.mjs';
import { PERSONAL_BROWSER_SCOPE } from '../../shared/personal-browser.mjs';

const conversation = { host: 'host-key', user: 'user-1', conversation: 'conv-1' };
const temp = () => mkdtemp(path.join(tmpdir(), 'tarobot-extensions-'));
const manifest = (fields = {}) => JSON.stringify({ manifest_version: 3, name: 'Sample', version: '1.0.0', content_scripts: [{ matches: ['<all_urls>'], js: ['cs.js'] }], ...fields });

// Protobuf writer for test CRX3 headers (length-delimited fields only).
const varint = value => { const out = []; while (value > 127) { out.push((value & 127) | 128); value = Math.floor(value / 128); } out.push(value); return Buffer.from(out); };
const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
function crx(archive, { signer, developer = signer, tamper = false, version = 3 } = {}) {
  const developerKey = developer.publicKey.export({ type: 'spki', format: 'der' }), signerKey = signer.publicKey.export({ type: 'spki', format: 'der' });
  const signed = field(1, createHash('sha256').update(developerKey).digest().subarray(0, 16));
  const length = Buffer.alloc(4); length.writeUInt32LE(signed.length);
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), length, signed, archive]), signer.privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, signerKey), field(2, signature)])), field(10000, signed)]);
  const prefix = Buffer.alloc(12); prefix.write('Cr24', 0, 'latin1'); prefix.writeUInt32LE(version, 4); prefix.writeUInt32LE(header.length, 8);
  const body = Buffer.from(archive); if (tamper) body[body.length - 30] ^= 1;
  return Buffer.concat([prefix, header, body]);
}
const rsa = () => generateKeyPairSync('rsa', { modulusLength: 2048 });

test('CRX3: developer key gives the publisher ID; tampering, CRX2, foreign signers and a missing store proof are refused', () => {
  const archive = Buffer.from(zipSync({ 'manifest.json': strToU8(manifest()), 'cs.js': strToU8('1') }));
  const key = rsa(), parsed = verifyCrx3(crx(archive, { signer: key }));
  assert.equal(parsed.id, extensionId(key.publicKey.export({ type: 'spki', format: 'der' })));
  assert.deepEqual(Buffer.from(parsed.archive), archive); assert.equal(parsed.publisherVerified, false);
  assert.throws(() => verifyCrx3(crx(archive, { signer: key, tamper: true })), /extension_invalid_signature/);
  assert.throws(() => verifyCrx3(crx(archive, { signer: key, version: 2 })), /extension_invalid_signature/);
  assert.throws(() => verifyCrx3(crx(archive, { signer: rsa(), developer: key })), /extension_invalid_signature/);
  assert.throws(() => verifyCrx3(crx(archive, { signer: key }), { requirePublisher: true }), /extension_invalid_signature/);
  assert.throws(() => verifyCrx3(crx(archive, { signer: key }), { expectedId: 'a'.repeat(32) }), /extension_id_mismatch/);
});

test('package names cannot leave, alias or shadow each other', () => {
  assert.deepEqual(packagePath('js/cs.js'), ['js', 'cs.js']);
  for (const bad of ['../evil.js', '/abs.js', 'a/../../b', 'a\\b.js', 'C:/x.js', 'a//b', './a', 'a\0b', 'trailing.', 'space ', 'con', 'NUL.txt', 'lpt1/x', 'a|b'])
    assert.throws(() => packagePath(bad), /package_path_invalid/, bad);
  assert.throws(() => checkNames(['manifest.json', 'MANIFEST.json']), /package_path_collision/);
  assert.throws(() => checkNames(['caf\u00e9.js', 'cafe\u0301.js']), /package_path_collision/, 'NFC alias');
  assert.throws(() => checkNames(['a', 'a/b']), /package_path_collision/, 'file and directory');
  assert.throws(() => checkNames(['A/x', 'a']), /package_path_collision/);
  checkNames(['a/b', 'a/c', 'b']);
});

test('ZIP: validated before inflating; wrapped folder, links, encryption and limits', async () => {
  const root = await temp();
  try {
    const wrapped = zipSync({ 'sample-1.0/manifest.json': strToU8(manifest()), 'sample-1.0/cs.js': strToU8('1'), 'other/readme.txt': strToU8('x') });
    await stageZip(wrapped, path.join(root, 'a'));
    assert.equal(await readFile(path.join(root, 'a', 'cs.js'), 'utf8'), '1');
    await assert.rejects(stat(path.join(root, 'a', 'other')), /ENOENT/);
    assert.throws(() => zipEntries(zipSync({ 'manifest.json': strToU8('{}'), '../evil.js': strToU8('x') })), /package_path_invalid/);
    assert.throws(() => zipEntries(zipSync({ 'manifest.json': strToU8('{}'), 'MANIFEST.json': strToU8('{}') })), /package_path_collision/);
    // Mark an entry as a symbolic link (external attributes, high word = S_IFLNK).
    const linked = Buffer.from(zipSync({ 'manifest.json': strToU8('{}'), 'link': strToU8('/etc/hosts') }));
    const central = linked.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    linked.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    assert.throws(() => zipEntries(linked), /package_symlink/);
    const encrypted = Buffer.from(zipSync({ 'manifest.json': strToU8('{}') }));
    encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    assert.throws(() => zipEntries(encrypted), /package_encrypted/);
    // A declared size above the per-file limit is refused before inflation.
    const big = Buffer.from(zipSync({ 'manifest.json': strToU8('{}') }));
    big.writeUInt32LE(ARCHIVE_LIMITS.fileBytes + 1, big.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
    assert.throws(() => zipEntries(big), /package_too_large/);
    // A size lie is caught by the bounded inflate / CRC check.
    const liar = Buffer.from(zipSync({ 'manifest.json': strToU8(manifest()), 'cs.js': strToU8('x'.repeat(5000)) }, { level: 9 }));
    const entry = liar.lastIndexOf(Buffer.from('cs.js')) - 46; liar.writeUInt32LE(10, entry + 24);
    await assert.rejects(stageZip(liar, path.join(root, 'b')), /package_format_unsupported/);
    assert.equal(ARCHIVE_LIMITS.packageBytes >= 71682084 && ARCHIVE_LIMITS.bytes >= 312130616 && ARCHIVE_LIMITS.fileBytes >= 18241681, true, 'real AdBlock 6.51 fits');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('folders: links are refused; the staged copy carries a normalized manifest key', async () => {
  const root = await temp();
  try {
    const folder = path.join(root, 'folder');
    await mkdir(folder); await writeFile(path.join(folder, 'manifest.json'), manifest()); await writeFile(path.join(folder, 'cs.js'), '1');
    await symlink('/etc/hosts', path.join(folder, 'link.js'));
    await assert.rejects(stageFolder(folder, path.join(root, 's1')), /package_symlink/);
    await unlink(path.join(folder, 'link.js'));
    await mkdir(path.join(root, 'outside')); await symlink(path.join(root, 'outside'), path.join(folder, 'dir'));
    await assert.rejects(stageFolder(folder, path.join(root, 's2')), /package_symlink/);
    await unlink(path.join(folder, 'dir'));
    await stageFolder(folder, path.join(root, 's3'));
    const prepared = await prepareStaged(path.join(root, 's3'));
    const written = JSON.parse(await readFile(path.join(root, 's3', 'manifest.json'), 'utf8'));
    assert.equal(prepared.id, extensionId(Buffer.from(written.key, 'base64')));
    // Comments, an existing key and localized names.
    await writeFile(path.join(root, 's3', 'manifest.json'), `// note\n${manifest({ key: written.key, name: '__MSG_appName__', default_locale: 'en' }).slice(0, -1)}, /* x */}`);
    await mkdir(path.join(root, 's3', '_locales', 'en'), { recursive: true }); await writeFile(path.join(root, 's3', '_locales', 'en', 'messages.json'), '{"appName":{"message":"Localized"}}');
    const again = await prepareStaged(path.join(root, 's3'));
    assert.equal(again.id, prepared.id); assert.equal(again.name, 'Localized');
    await writeFile(path.join(root, 's3', 'manifest.json'), manifest({ version: 'one' }));
    await assert.rejects(prepareStaged(path.join(root, 's3')), /manifest_invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility report is honest about declared features', () => {
  const report = compatibility({ manifest_version: 3, name: 'Blocker', version: '1', background: { service_worker: 'sw.js' },
    permissions: ['storage', 'scripting', 'declarativeNetRequestWithHostAccess', 'contextMenus', 'tabs', 'alarms', 'unlimitedStorage', 'idle', 'webNavigation', 'notifications'], host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['http://*/*', 'https://*/*'], js: ['cs.js'] }], declarative_net_request: { rule_resources: [] }, action: { default_popup: 'p.html' }, options_ui: { page: 'o.html' } });
  const status = Object.fromEntries(report.features.map(item => [item.code, item.status]));
  assert.equal(report.verdict, 'limited'); assert.equal(report.hostAccess, 'all');
  assert.equal(status.content_scripts, 'supported'); assert.equal(status.network_rules, 'not_enforced');
  for (const code of ['toolbar', 'notifications']) assert.equal(status[code], 'unavailable', code);
  // Opened from Extensions in its own window (extension-options.mjs).
  assert.equal(status.options_page, 'supported');
  // Provided by TaroBird's bridge (extension-bridge.mjs) or Electron itself.
  for (const code of ['contextMenus', 'webNavigation', 'idle', 'tabs', 'alarms']) assert.equal(status[code], 'supported', code);
  assert.equal(compatibility({ manifest_version: 3, name: 'Styles', version: '1', content_scripts: [{ matches: ['https://example.com/*'], css: ['a.css'] }] }).verdict, 'works');
  assert.throws(() => compatibility({ manifest_version: 3, name: 'Popup', version: '1', action: { default_popup: 'p.html' } }), /extension_has_nothing_to_run/);
  assert.throws(() => compatibility({ manifest_version: 1, name: 'x', version: '1' }), /manifest_version_unsupported/);
});

test('store addresses resolve only to Chrome Web Store detail pages', () => {
  const id = 'gighmmpiobklfepjocnamgkkbiglidom';
  assert.equal(storeExtensionId(id), id);
  assert.equal(storeExtensionId(`https://chromewebstore.google.com/detail/adblock/${id}?hl=en`), id);
  assert.equal(storeExtensionId(`https://chrome.google.com/webstore/detail/adblock/${id}`), id);
  for (const bad of [`http://chromewebstore.google.com/detail/x/${id}`, `https://evil.example/detail/x/${id}`, `https://chromewebstore.google.com/search/${id}`, 'adblock', `https://u:p@chromewebstore.google.com/detail/x/${id}`])
    assert.throws(() => storeExtensionId(bad), /store_address_invalid/, bad);
});

test('extension management is a trusted desktop command, not a Bot-reachable browser action', () => {
  assert.ok(DESKTOP_COMMANDS.includes(EXTENSIONS_COMMAND)); assert.ok(BROWSER_COMMANDS.includes(EXTENSIONS_COMMAND));
  // (`reload` is the existing page reload; extension reload exists only in this command.)
  for (const action of ['install', 'remove', 'set', 'compat', 'compat_set']) { assert.ok(!BROWSER_ACTIONS.includes(action), action); assert.ok(!USER_ONLY.has(action), action); }
  assert.throws(() => parseBrowserAction({ action: 'install', scope: conversation, source: 'user' }), /invalid_browser_args/);
});

// Fake Electron: sessions record loads and the request listener; the policy
// extension "starts" by sending its ready request through that listener.
function fakeElectron({ chosen, policyStarts = true, hang, control = { policyStarts, policyLoads: 0 } } = {}) {
  const sessions = new Map(), defaultSession = makeSession('default'), dialogs = [];
  function makeSession(name) {
    const loaded = new Map(), session = { name, loaded, cleared: [], listener: undefined, filtered: false, handled: new Set(),
      registerPreloadScript(options) { session.preload = options; }, serviceWorkers: { on() {}, getWorkerFromVersionID() {} },
      webRequest: { onBeforeRequest(filter, listener) { session.listener = filter === null ? undefined : listener; session.filtered = filter !== null; } },
      protocol: { handle(scheme) { session.handled.add(scheme); }, unhandle(scheme) { session.handled.delete(scheme); } },
      extensions: {
        async loadExtension(directory) {
          const data = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), id = extensionId(Buffer.from(data.key, 'base64'));
          if (hang?.(data)) return new Promise(() => {});
          if (data.name === 'TaroBird page policy') control.policyLoads++;
          if (data.name === 'TaroBird page policy' && control.policyStarts) {
            const url = /fetch\("([^"]+)"\)/.exec(await readFile(path.join(directory, 'policy.js'), 'utf8'))[1];
            setTimeout(() => session.listener?.({ url, resourceType: 'other' }, () => {}), 5);
          }
          loaded.set(id, data.version); return { id };
        },
        removeExtension(id) { loaded.delete(id); },
        getExtension(id) { return loaded.has(id) ? { id, manifest: {} } : undefined; },
      }, async clearStorageData(options) { session.cleared.push(options); } };
    return session;
  }
  return { dialogs, sessions, control, session: { defaultSession, fromPartition: name => { if (!sessions.has(name)) sessions.set(name, makeSession(name)); return sessions.get(name); } },
    dialog: { showOpenDialog: async (_window, options) => { dialogs.push(options); const value = await chosen(); return value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] }; },
      showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 1 }; } } };
}
const limits = { extensions: 50, loadMs: 300, policyMs: 300, downloadMs: 1000 };
// Explicit stand-in for WorkbenchBrowser.drainForCompat where no page is open:
// the manager itself fails closed without a drain (see the test below).
const passDrain = async () => ({ ok: true, commit: fn => { fn(); return true; }, release() {} });
async function setup(root, options = {}) {
  const folder = path.join(root, 'src'), store = path.join(root, 'profile.noindex', 'workbench-browser-extensions');
  await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'manifest.json'), manifest({ permissions: ['storage', 'declarativeNetRequest'] })); await writeFile(path.join(folder, 'cs.js'), '1');
  const state = { pick: folder };
  const electron = fakeElectron({ chosen: () => state.pick, ...options }), changes = [];
  const manager = new BrowserExtensions(store, electron, { changed: () => changes.push(1), limits, drain: options.drain ?? passDrain });
  const personal = electron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)), page = electron.session.fromPartition(partitionFor(conversation));
  // The production filter on fake sessions: the compatibility handshake runs through it.
  installRequestFilter(personal); installRequestFilter(page);
  await manager.attach(personal, PERSONAL_BROWSER_SCOPE); await manager.attach(page, conversation);
  return { folder, store, state, electron, manager, personal, page, changes };
}

test('install, scope, update, disable, remove and reset across page sessions', async () => {
  const root = await temp();
  try {
    const { folder, store, state, electron, manager, personal, page, changes } = await setup(root);
    const stranger = { extensions: { loadExtension: async () => { throw new Error('must not load'); } } };
    await manager.attach(stranger, conversation); // a session that is not main’s own for that partition: refused, nothing loads
    const installed = await manager.request({ action: 'install', source: 'folder' }, { english: true });
    assert.equal(installed.status, 'ok'); const id = installed.extension.id;
    const review = electron.dialogs.find(item => item.message)?.detail;
    assert.match(review, /network blocking does not take effect/); assert.match(review, /Bots cannot install or manage/); assert.match(review, /Not signed/);
    assert.equal(installed.extension.scope, 'personal'); assert.equal(installed.extension.signature, 'none'); assert.equal(installed.extension.loaded, 1);
    assert.ok(personal.loaded.has(id)); assert.ok(!page.loaded.has(id), 'conversation pages need an explicit opt-in');
    assert.equal(personal.preload?.type, 'service-worker', 'the API bridge is registered before the first load');
    assert.equal(installed.extension.origin, undefined, 'location hash is not shown');
    const answers = [0]; electron.dialog.showMessageBox = async (_w, options) => { electron.dialogs.push(options); return { response: answers.length ? answers.shift() : 1 }; };
    assert.equal((await manager.request({ action: 'set', id, scope: 'all' })).status, 'cancelled'); assert.ok(!page.loaded.has(id));
    assert.equal((await manager.request({ action: 'set', id, scope: 'all' })).extension.loaded, 2); assert.ok(page.loaded.has(id));
    // Reinstalling the same unsigned folder is an update of the same ID.
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.1.0' }));
    const updated = await manager.request({ action: 'install', source: 'folder' });
    assert.equal(updated.extension.id, id); assert.equal(updated.extension.version, '1.1.0'); assert.equal(updated.extension.scope, 'all');
    assert.equal(personal.loaded.get(id), '1.1.0'); assert.equal(page.loaded.get(id), '1.1.0');
    // A new run reads the registry and attaches lazily.
    const restarted = new BrowserExtensions(store, electron, { limits }), other = { ...conversation, conversation: 'conv-2' }, fresh = electron.session.fromPartition(partitionFor(other));
    installRequestFilter(fresh); await restarted.attach(fresh, other); assert.equal(fresh.loaded.get(id), '1.1.0');
    await manager.request({ action: 'set', id, scope: 'personal' }); assert.ok(personal.loaded.has(id) && !page.loaded.has(id), 'scope downgrade unloads');
    await manager.request({ action: 'set', id, enabled: false }); assert.ok(!personal.loaded.has(id));
    await manager.request({ action: 'set', id, enabled: true }); assert.ok(personal.loaded.has(id));
    state.pick = undefined; assert.equal((await manager.request({ action: 'install', source: 'file' })).status, 'cancelled');
    assert.equal((await manager.request({ action: 'remove', id })).status, 'ok'); assert.ok(!personal.loaded.has(id));
    assert.ok(personal.cleared.some(item => item.origin === `chrome-extension://${id}`));
    await assert.rejects(stat(path.join(store, 'packages', id)), /ENOENT/);
    state.pick = folder; await manager.request({ action: 'install', source: 'folder' });
    await manager.clear(); assert.equal(personal.loaded.size, 0); assert.deepEqual((await manager.request({ action: 'list' })).extensions, []);
    assert.ok(changes.length >= 5);
    assert.throws(() => manager.request({ action: 'install', source: 'url', url: 'https://chromewebstore.google.com/' }), /invalid_extension_args/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed registry commit rolls the update back to the previous files', async () => {
  const root = await temp();
  try {
    const { folder, store, electron, manager, personal } = await setup(root);
    const first = await manager.request({ action: 'install', source: 'folder' }), id = first.extension.id, file = path.join(store, 'packages', id, 'cs.js');
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '2.0.0' })); await writeFile(path.join(folder, 'cs.js'), '2');
    electron.dialog.showMessageBox = async () => { await unlink(path.join(store, 'registry.json')); await mkdir(path.join(store, 'registry.json')); return { response: 1 }; };
    const result = await manager.request({ action: 'install', source: 'folder' });
    assert.equal(result.status, 'failed'); assert.equal(await readFile(file, 'utf8'), '1');
    assert.equal(personal.loaded.get(id), '1.0.0', 'the previous version is loaded again');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reset voids an install whose picker or confirmation was still open', async () => {
  const root = await temp();
  try {
    const { state, folder, electron, manager } = await setup(root);
    let release; electron.dialog.showOpenDialog = () => new Promise(resolve => { release = resolve; });
    const pending = manager.request({ action: 'install', source: 'folder' });
    await new Promise(resolve => setTimeout(resolve, 5)); await manager.clear(); release({ canceled: false, filePaths: [folder] });
    assert.equal((await pending).status, 'cancelled');
    assert.deepEqual((await manager.request({ action: 'list' })).extensions, []);
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [state.pick] });
    let confirm; electron.dialog.showMessageBox = () => new Promise(resolve => { confirm = resolve; });
    const second = manager.request({ action: 'install', source: 'folder' });
    while (!confirm) await new Promise(resolve => setTimeout(resolve, 5));
    await manager.clear(); confirm({ response: 1 });
    assert.equal((await second).status, 'cancelled'); assert.deepEqual((await manager.request({ action: 'list' })).extensions, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a load that never settles is bounded and undone, and the queue moves on', async () => {
  const root = await temp();
  try {
    const { manager, personal } = await setup(root, { hang: data => data.name === 'Sample' });
    const started = Date.now(), result = await manager.request({ action: 'install', source: 'folder' });
    assert.equal(result.status, 'ok'); assert.equal(result.extension.error, 'extension_load_timeout'); assert.ok(!personal.loaded.has(result.extension.id));
    assert.ok(Date.now() - started < 3000);
    assert.equal((await manager.request({ action: 'list' })).status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility mode: per scope, filter removed only after the policy reports ready, restored on off, reset and failure', async () => {
  const root = await temp();
  try {
    const { electron, manager, personal, page, store } = await setup(root);
    const installed = await manager.request({ action: 'install', source: 'folder' }), id = installed.extension.id;
    assert.deepEqual(await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: false, active: false });
    const prepared = [];
    electron.dialogs.length = 0;
    const on = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true, english: true }, { prepare: scope => prepared.push(scope.host) });
    assert.deepEqual(on, { status: 'ok', enabled: true, active: true }); assert.deepEqual(prepared, [PERSONAL_BROWSER_SCOPE.host]);
    assert.match(electron.dialogs.at(-1).detail, /connect to services on this computer and your local network/);
    assert.equal(personal.filtered, false); assert.ok(personal.handled.has('tarobot-unload-probe'));
    assert.equal(page.filtered, true, 'another scope keeps its filter'); assert.ok(manager.compatible(personal) && !manager.compatible(page));
    assert.ok(personal.loaded.has(id), 'user extensions keep running');
    assert.ok(COMPAT_PROBE.startsWith('tarobot-unload-probe:'));
    // A restart re-enables it from the registry (filter first, removed after ready).
    const restartedElectron = fakeElectron({ chosen: () => undefined }), restarted = new BrowserExtensions(store, restartedElectron, { limits, drain: passDrain });
    const again = restartedElectron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)); installRequestFilter(again);
    await restarted.attach(again, PERSONAL_BROWSER_SCOPE); assert.equal(again.filtered, false); assert.ok(restarted.compatible(again));
    // Off: filter back first, extensions restarted (reloaded under the filter), probe scheme released.
    const off = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: false });
    assert.deepEqual(off, { status: 'ok', enabled: false, active: false });
    assert.equal(personal.filtered, true); assert.ok(!personal.handled.has('tarobot-unload-probe')); assert.ok(personal.loaded.has(id));
    electron.dialog.showMessageBox = async () => ({ response: 0 });
    assert.equal((await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).status, 'cancelled');
    assert.equal(personal.filtered, true);
    electron.dialog.showMessageBox = async () => ({ response: 1 });
    await manager.request({ action: 'compat_set', scope: conversation, enabled: true });
    assert.equal(page.filtered, false);
    await manager.forget([partitionFor(conversation)]); assert.equal(page.filtered, true);
    assert.equal((await manager.request({ action: 'compat', scope: conversation })).enabled, false, 'Host removal forgets it');
    await manager.request({ action: 'compat_set', scope: conversation, enabled: true }); await manager.clear();
    assert.equal(page.filtered, true); assert.equal((await manager.request({ action: 'compat', scope: conversation })).enabled, false, 'full reset clears it');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility mode stays off (filter kept) when the policy never reports ready', async () => {
  const root = await temp();
  try {
    const { manager, personal } = await setup(root, { policyStarts: false });
    const result = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.deepEqual(result, { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    assert.equal(personal.filtered, true); assert.ok(!manager.compatible(personal)); assert.equal(personal.loaded.size, 0, 'the policy extension was unloaded');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Stand-in for WorkbenchBrowser.drainForCompat: records what the manager asked and when.
function drainSpy(decide = () => ({ ok: true })) {
  const calls = [];
  const drain = async (session, options) => {
    const call = { filteredAtDrain: session.filtered, options, released: 0 }; calls.push(call);
    const outcome = decide(call);
    if (!outcome.ok) return { ok: false, reason: outcome.reason, release() {} };
    return { ok: true, release() { call.released++; }, commit: fn => {
      call.filteredBeforeCommit = session.filtered;
      if (outcome.left) return false;
      fn(); call.filteredAfterCommit = session.filtered; return true;
    } };
  };
  return { drain, calls };
}
const policyIdOf = async store => extensionId(Buffer.from(await readFile(path.join(store, 'policy-key'), 'utf8'), 'base64'));

test('compatibility mode removes the filter only in the step that confirms the scope\'s pages are closed', async () => {
  const root = await temp();
  try {
    const spy = drainSpy(), { manager, personal } = await setup(root, { drain: spy.drain });
    const on = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true, english: true });
    assert.deepEqual(on, { status: 'ok', enabled: true, active: true });
    assert.equal(spy.calls.length, 1);
    assert.deepEqual([spy.calls[0].filteredAtDrain, spy.calls[0].filteredBeforeCommit, spy.calls[0].filteredAfterCommit, spy.calls[0].released], [true, true, false, 1]);
    assert.equal(spy.calls[0].options.interactive, true, 'the person is deciding: pages with input are listed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('declining the page reload saves nothing and keeps the filter; a later retry can still turn it on', async () => {
  const root = await temp();
  try {
    let answer = { ok: false, reason: 'cancelled' };
    const spy = drainSpy(() => answer), { electron, manager, personal, store } = await setup(root, { drain: spy.drain });
    assert.deepEqual(await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }), { status: 'cancelled' });
    assert.deepEqual(await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: false, active: false });
    assert.equal(personal.filtered, true); assert.ok(!personal.loaded.has(await policyIdOf(store)), 'the policy extension was unloaded again');
    assert.match(electron.dialogs.at(-1).detail, /已打开的网页会重新加载；可能有未保存内容的网页会先列出/);
    answer = { ok: true };
    assert.deepEqual(await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }), { status: 'ok', enabled: true, active: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an automatic switch fails closed while pages are in use, and when a page is still left at the switch', async () => {
  const root = await temp();
  try {
    const first = await setup(root);
    await first.manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    // A new run with the saved choice, where a page holds input (no prompt in automatic mode).
    const busy = drainSpy(call => call.options.interactive ? { ok: true } : { ok: false, reason: 'pages_busy' });
    const nextElectron = fakeElectron({ chosen: () => undefined }), next = new BrowserExtensions(first.store, nextElectron, { limits, drain: busy.drain });
    const again = nextElectron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)); installRequestFilter(again);
    await next.attach(again, PERSONAL_BROWSER_SCOPE); await next.attach(again, PERSONAL_BROWSER_SCOPE);
    assert.equal(again.filtered, true); assert.equal(nextElectron.control.policyLoads, 1, 'no automatic retry');
    assert.deepEqual(await next.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    assert.equal(busy.calls[0].options.interactive, false);
    assert.equal((await next.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).active, true, 'the person can retry');
    // A page found at the switch itself: the filter stays.
    const left = drainSpy(() => ({ ok: true, left: true })), third = fakeElectron({ chosen: () => undefined }), manager3 = new BrowserExtensions(first.store, third, { limits, drain: left.drain });
    const s3 = third.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)); installRequestFilter(s3);
    await manager3.attach(s3, PERSONAL_BROWSER_SCOPE);
    assert.equal(s3.filtered, true); assert.equal(left.calls[0].released, 1); assert.ok(!manager3.compatible(s3));
    assert.ok(!s3.handled.has('tarobot-unload-probe'), 'nothing half on');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('clearing website data keeps an intact policy as it is and fails closed without it', async () => {
  const root = await temp();
  try {
    const { electron, manager, personal, store } = await setup(root);
    await manager.request({ action: 'install', source: 'folder' });
    await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    const loads = electron.control.policyLoads;
    await manager.refreshCompat(PERSONAL_BROWSER_SCOPE);
    assert.equal(personal.filtered, false, 'no filter round trip under live pages'); assert.equal(electron.control.policyLoads, loads, 'not re-armed');
    personal.extensions.removeExtension(await policyIdOf(store));
    await manager.refreshCompat(PERSONAL_BROWSER_SCOPE);
    assert.equal(personal.filtered, true);
    assert.deepEqual(await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    await manager.attach(personal, PERSONAL_BROWSER_SCOPE); assert.equal(electron.control.policyLoads, loads, 'only the person retries');
    assert.equal(personal.loaded.size, 1, 'the person\'s extension runs again under the filter');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a policy load that settles after its timeout is unloaded and turns nothing on', async () => {
  const root = await temp();
  try {
    const { manager, personal, store } = await setup(root);
    const original = personal.extensions.loadExtension; let release;
    personal.extensions.loadExtension = directory => directory.endsWith(`${path.sep}policy`) ? new Promise(resolve => { release = () => resolve(original(directory)); }) : original(directory);
    assert.equal((await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).error, 'compatibility_unavailable');
    release(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(!personal.loaded.has(await policyIdOf(store))); assert.equal(personal.filtered, true); assert.ok(!manager.compatible(personal));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WorkbenchBrowser.drainForCompat holds one switch per session and commits only with no page left', async () => {
  const session = { name: 'gate-test' }, other = { name: 'other' };
  const first = await WorkbenchBrowser.drainForCompat(session, { interactive: false });
  assert.equal(first.ok, true);
  const second = await WorkbenchBrowser.drainForCompat(session);
  assert.deepEqual([second.ok, second.reason], [false, 'busy'], 'one switch at a time per session');
  assert.equal((await WorkbenchBrowser.drainForCompat(other)).ok, true, 'other sessions are independent');
  let ran = false; assert.equal(first.commit(() => { ran = true; }), true); assert.ok(ran);
  first.release();
  const again = await WorkbenchBrowser.drainForCompat(session); assert.equal(again.ok, true, 'released'); again.release();
});

test('without a page drain, compatibility mode cannot turn on (fails closed)', async () => {
  const root = await temp();
  try {
    const store = path.join(root, 'store'), electron = fakeElectron({ chosen: () => undefined }), manager = new BrowserExtensions(store, electron, { limits });
    const personal = electron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)); installRequestFilter(personal);
    await manager.attach(personal, PERSONAL_BROWSER_SCOPE);
    assert.deepEqual(await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }), { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    assert.equal(personal.filtered, true); assert.equal(personal.loaded.size, 0, 'the policy extension was unloaded');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reset or Host removal while pages are being asked about voids the switch: no late permission', async () => {
  const root = await temp();
  try {
    let answer; const waiting = [];
    const slow = async (session, options) => { await new Promise(resolve => { waiting.push(resolve); }); return answer(session, options); };
    const ok = () => ({ ok: true, commit: fn => { fn(); return true; }, release() {} });
    const { manager, personal, page, store } = await setup(root, { drain: slow });
    const until = async () => { while (!waiting.length) await new Promise(resolve => setTimeout(resolve, 5)); return waiting.shift(); };
    // Full reset during the person's decision (interactive).
    answer = ok;
    let pending = manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    let resume = await until(); const cleared = manager.clear(); resume();
    assert.deepEqual(await pending, { status: 'cancelled', error: 'extensions_reset' }); await cleared;
    assert.equal(personal.filtered, true); assert.ok(!manager.compatible(personal)); assert.ok(!personal.loaded.has(await policyIdOf(store)));
    assert.equal((await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE })).enabled, false);
    // Host removal of a conversation scope during its decision.
    pending = manager.request({ action: 'compat_set', scope: conversation, enabled: true });
    resume = await until(); const forgotten = manager.forget([partitionFor(conversation)]); resume();
    assert.deepEqual(await pending, { status: 'cancelled', error: 'extensions_reset' }); await forgotten;
    assert.equal(page.filtered, true); assert.ok(!manager.compatible(page)); assert.equal((await manager.request({ action: 'compat', scope: conversation })).enabled, false);
    // Automatic switch (saved choice, new attach) interrupted by a Host removal.
    await manager.attach(page, conversation);
    answer = ok; pending = manager.request({ action: 'compat_set', scope: conversation, enabled: true });
    (await until())(); assert.equal((await pending).active, true);
    const next = fakeElectron({ chosen: () => undefined }), restarted = new BrowserExtensions(store, next, { limits, drain: slow });
    const later = next.session.fromPartition(partitionFor(conversation)); installRequestFilter(later);
    const attaching = restarted.attach(later, conversation);
    resume = await until(); const removed = restarted.forget([partitionFor(conversation)]); resume();
    await attaching; await removed;
    assert.equal(later.filtered, true); assert.ok(!restarted.compatible(later));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a compatibility choice that cannot be saved leaves the default protection in place, either way', async () => {
  const root = await temp();
  try {
    const { electron, manager, personal, store } = await setup(root);
    await manager.request({ action: 'install', source: 'folder' });
    const registry = path.join(store, 'registry.json'), saved = await readFile(registry, 'utf8');
    // Turning it on: activated, then the write fails → rolled back.
    await rm(registry); await mkdir(registry);
    await assert.rejects(manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }), /extension_write_failed/);
    assert.deepEqual(await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: false, active: false, error: 'compatibility_unavailable' });
    assert.equal(personal.filtered, true); assert.ok(!personal.loaded.has(await policyIdOf(store))); assert.ok(!personal.handled.has('tarobot-unload-probe'));
    assert.equal(personal.loaded.size, 1, 'the person\'s extension runs again under the filter');
    const loads = electron.control.policyLoads; await manager.attach(personal, PERSONAL_BROWSER_SCOPE);
    assert.equal(electron.control.policyLoads, loads, 'no automatic retry after the failed write');
    // With the file writable again it turns on; turning it off with a failing write also ends in the filter.
    await rm(registry, { recursive: true }); await writeFile(registry, saved);
    assert.equal((await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).active, true);
    await rm(registry); await mkdir(registry);
    await assert.rejects(manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: false }), /extension_write_failed/);
    assert.equal(personal.filtered, true); assert.ok(!manager.compatible(personal));
    await manager.attach(personal, PERSONAL_BROWSER_SCOPE); assert.ok(!manager.compatible(personal), 'the stale saved choice does not turn it back on');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Host removal unloads conversation-page extensions there; later syncs and late loads do not bring them back', async () => {
  const root = await temp();
  try {
    const { manager, personal, page } = await setup(root);
    const id = (await manager.request({ action: 'install', source: 'folder' })).extension.id;
    await manager.request({ action: 'set', id, scope: 'all' }); assert.ok(page.loaded.has(id));
    await manager.forget([partitionFor(conversation)]);
    assert.ok(!page.loaded.has(id), 'unloaded from the removed Host session');
    // Any later sync (toggle, reload, install) reaches only sessions still in use.
    await manager.request({ action: 'set', id, enabled: false }); await manager.request({ action: 'set', id, enabled: true });
    await manager.request({ action: 'reload', id });
    assert.ok(!page.loaded.has(id), 'not revived by toggles or reload'); assert.ok(personal.loaded.has(id));
    assert.equal((await manager.request({ action: 'list' })).extensions[0].loaded, 1, 'the removed Host session is not counted');
    // The same scope used again (a new attach after the removal) is ordinary use.
    await manager.attach(page, conversation); assert.ok(page.loaded.has(id));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a load still in flight when its Host is removed is undone when it settles', async () => {
  const root = await temp();
  try {
    const { manager, page } = await setup(root);
    const id = (await manager.request({ action: 'install', source: 'folder' })).extension.id;
    const original = page.extensions.loadExtension; let release;
    page.extensions.loadExtension = directory => new Promise(resolve => { release = () => resolve(original(directory)); });
    const result = await manager.request({ action: 'set', id, scope: 'all' });
    assert.equal(result.extension.error, 'extension_load_timeout');
    await manager.forget([partitionFor(conversation)]);
    page.extensions.loadExtension = original; release();
    for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await manager.request({ action: 'list' }); }
    assert.ok(!page.loaded.has(id), 'the late load is removed, and the follow-up sync does not reload it');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a compatibility policy that fails stays off (filter kept) without automatic retries until the person retries', async () => {
  const root = await temp();
  try {
    const { electron, manager, personal, store } = await setup(root, { policyStarts: false });
    await manager.request({ action: 'install', source: 'folder' });
    const failed = await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.deepEqual(failed, { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    const attempts = electron.control.policyLoads;
    // Page wakes, lists, toggles and reloads neither retry nor wait for the policy.
    const started = Date.now();
    await manager.ready(personal, PERSONAL_BROWSER_SCOPE); await manager.attach(personal, PERSONAL_BROWSER_SCOPE);
    const id = (await manager.request({ action: 'list' })).extensions[0].id;
    await manager.request({ action: 'set', id, enabled: false }); await manager.request({ action: 'set', id, enabled: true }); await manager.request({ action: 'reload', id });
    assert.equal(electron.control.policyLoads, attempts, 'no automatic retry');
    assert.ok(Date.now() - started < limits.policyMs, 'nothing waits for a policy that already failed');
    assert.equal(personal.filtered, true, 'fails closed: the request filter stays');
    assert.deepEqual(await manager.request({ action: 'compat', scope: PERSONAL_BROWSER_SCOPE }), { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    // A new run tries once again from the saved choice (filter first, removed after ready).
    const nextElectron = fakeElectron({ chosen: () => undefined }), next = new BrowserExtensions(store, nextElectron, { limits, drain: passDrain });
    const again = nextElectron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE)); installRequestFilter(again);
    await next.attach(again, PERSONAL_BROWSER_SCOPE); await next.attach(again, PERSONAL_BROWSER_SCOPE);
    assert.equal(nextElectron.control.policyLoads, 1); assert.ok(next.compatible(again)); assert.equal(again.filtered, false);
    // An explicit retry makes exactly one new attempt.
    assert.equal((await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).error, 'compatibility_unavailable');
    assert.equal(electron.control.policyLoads, attempts + 1);
    electron.control.policyStarts = true;
    assert.deepEqual(await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }), { status: 'ok', enabled: true, active: true });
    assert.equal(personal.filtered, false);
    // Turning it off after a failure also clears the stale error.
    electron.control.policyStarts = false;
    await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: false });
    await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    assert.deepEqual(await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: false }), { status: 'ok', enabled: false, active: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the update review states where the extension runs and whether it stays off, without removing its scope', async () => {
  const root = await temp();
  try {
    const { folder, electron, manager } = await setup(root);
    const review = () => electron.dialogs.filter(item => item.message).at(-1)?.detail ?? '';
    const id = (await manager.request({ action: 'install', source: 'folder', english: true })).extension.id;
    assert.match(review(), /runs in the personal browser on this device\./); assert.doesNotMatch(review(), /conversation webpages/);
    await manager.request({ action: 'set', id, scope: 'all' });
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.1.0' }));
    const updated = await manager.request({ action: 'install', source: 'folder', english: true });
    assert.equal(updated.extension.scope, 'all');
    assert.match(review(), /personal browser and in conversation webpages/); assert.match(review(), /Bots read and operate those pages/);
    assert.doesNotMatch(review(), /runs in the personal browser on this device\./);
    await manager.request({ action: 'set', id, enabled: false });
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.2.0' }));
    await manager.request({ action: 'install', source: 'folder' });
    assert.match(review(), /对话网页/); assert.match(review(), /保持停用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('replacing a verified package with an unsigned one under the same ID needs its own confirmation; cancelling keeps package, scope and data', async () => {
  const root = await temp();
  try {
    const { state, electron, manager, personal, page, store } = await setup(root);
    const answers = []; electron.dialog.showMessageBox = async (_window, options) => { electron.dialogs.push(options); return { response: answers.length ? answers.shift() : 1 }; };
    const boxes = () => electron.dialogs.filter(item => item.message);
    const signer = rsa(), key = signer.publicKey.export({ type: 'spki', format: 'der' });
    state.pick = path.join(root, 'signed.crx');
    await writeFile(state.pick, crx(Buffer.from(zipSync({ 'manifest.json': strToU8(manifest({ name: 'Signed' })), 'cs.js': strToU8('1') })), { signer }));
    const id = (await manager.request({ action: 'install', source: 'file', english: true })).extension.id;
    await manager.request({ action: 'set', id, scope: 'all' }); assert.equal(page.loaded.get(id), '1.0.0');
    // Anyone can copy the public key out of the published package.
    state.pick = path.join(root, 'forged'); await mkdir(state.pick);
    await writeFile(path.join(state.pick, 'manifest.json'), manifest({ name: 'Signed', version: '2.0.0', key: key.toString('base64') })); await writeFile(path.join(state.pick, 'cs.js'), '2');
    const kept = async () => {
      const entry = (await manager.request({ action: 'list' })).extensions.find(item => item.id === id);
      assert.deepEqual([entry.signature, entry.scope, entry.version], ['developer', 'all', '1.0.0']);
      assert.equal(await readFile(path.join(store, 'packages', id, 'cs.js'), 'utf8'), '1');
      assert.equal(page.loaded.get(id), '1.0.0'); assert.equal(personal.loaded.get(id), '1.0.0');
    };
    // Rejected at the dedicated confirmation: nothing changes.
    let before = boxes().length; answers.push(1, 0);
    assert.equal((await manager.request({ action: 'install', source: 'folder', english: true })).status, 'cancelled');
    const [review, replace] = boxes().slice(before);
    assert.equal(review.message, 'Update “Signed” 2.0.0?'); assert.match(review.detail, /replaces a version whose developer signature was verified/);
    assert.equal(replace.message, 'Replace the verified “Signed” with an unsigned package?');
    assert.deepEqual([replace.buttons[1], replace.defaultId, replace.cancelId], ['Replace', 0, 0]);
    for (const line of [/developer signature will no longer be verified/, /keeps this extension’s ID and saved data/, /keeps running in conversation webpages/, /Bots read and operate those pages/, /Cancel keeps the current version, its signature, data and where it runs/])
      assert.match(replace.detail, line);
    await kept();
    // Rejected at the review: the replacement question is never asked.
    before = boxes().length; answers.push(0);
    assert.equal((await manager.request({ action: 'install', source: 'folder', english: true })).status, 'cancelled');
    assert.equal(boxes().length - before, 1); await kept();
    // Accepted twice: replaced, keeping its scope and data (no new grant, nothing cleared).
    before = boxes().length; answers.push(1, 1);
    const replaced = await manager.request({ action: 'install', source: 'folder', english: true });
    assert.equal(boxes().length - before, 2);
    assert.deepEqual([replaced.status, replaced.extension.id, replaced.extension.signature, replaced.extension.scope, replaced.extension.version], ['ok', id, 'none', 'all', '2.0.0']);
    assert.equal(await readFile(path.join(store, 'packages', id, 'cs.js'), 'utf8'), '2');
    assert.equal(page.loaded.get(id), '2.0.0'); assert.equal(personal.loaded.get(id), '2.0.0');
    assert.ok(![...personal.cleared, ...page.cleared].some(item => item?.origin === `chrome-extension://${id}`), 'its data is inherited, as stated');
    // An unsigned update of the unsigned version is an ordinary single review.
    await writeFile(path.join(state.pick, 'manifest.json'), manifest({ name: 'Signed', version: '2.1.0', key: key.toString('base64') }));
    before = boxes().length; await manager.request({ action: 'install', source: 'folder' });
    assert.equal(boxes().length - before, 1); assert.match(boxes().at(-1).detail, /对话网页/);
    // Chinese wording of the dedicated confirmation (personal-only, turned off).
    await manager.request({ action: 'set', id, scope: 'personal' }); await manager.request({ action: 'set', id, enabled: false });
    state.pick = path.join(root, 'signed.crx'); await manager.request({ action: 'install', source: 'file' }); // back to the signed package (an upgrade: one review)
    state.pick = path.join(root, 'forged'); before = boxes().length; answers.push(1, 0);
    assert.equal((await manager.request({ action: 'install', source: 'folder' })).status, 'cancelled');
    const zh = boxes().slice(before)[1];
    assert.equal(zh.message, '用未签名安装包替换已验证的“Signed”吗？');
    for (const line of [/不再有已验证的开发者签名/, /沿用此扩展的 ID 和已保存数据/, /只在个人浏览器中运行/, /保持停用/, /取消将保留当前版本、签名、数据和运行范围/]) assert.match(zh.detail, line);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an install review only authorizes the state it showed: changes, other installs and removals meanwhile cancel it', async () => {
  const root = await temp();
  try {
    const { folder, electron, manager, store } = await setup(root);
    // Holds the next Add/Update review open until released; other dialogs answer at once.
    let hold;
    electron.dialog.showMessageBox = async (_window, options) => {
      electron.dialogs.push(options);
      if (hold && /^(Add|Update) /.test(options.message)) { const current = hold; hold = undefined; current.shown(options); await current.gate; }
      return { response: 1 };
    };
    const reviewing = () => { let shown, release; const opened = new Promise(resolve => { shown = resolve; }), gate = new Promise(resolve => { release = resolve; }); hold = { shown, gate }; return { opened, release }; };
    const entry = async () => (await manager.request({ action: 'list' })).extensions[0];
    const id = (await manager.request({ action: 'install', source: 'folder', english: true })).extension.id;
    // 1 scope widened in another window while a personal-only update is reviewed.
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.1.0' }));
    let review = reviewing(), pending = manager.request({ action: 'install', source: 'folder', english: true });
    assert.match((await review.opened).detail, /runs in the personal browser on this device\./);
    await manager.request({ action: 'set', id, scope: 'all' }); review.release();
    assert.deepEqual(await pending, { status: 'cancelled', error: 'extension_changed' });
    assert.deepEqual([(await entry()).version, (await entry()).scope], ['1.0.0', 'all']);
    // 2 turned off meanwhile.
    review = reviewing(); pending = manager.request({ action: 'install', source: 'folder', english: true });
    await review.opened; await manager.request({ action: 'set', id, enabled: false }); review.release();
    assert.equal((await pending).error, 'extension_changed'); assert.equal((await entry()).version, '1.0.0');
    // 3 another install of the same ID committed first: the older review cannot replace it.
    review = reviewing(); pending = manager.request({ action: 'install', source: 'folder', english: true });
    await review.opened;
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '1.2.0' }));
    assert.equal((await manager.request({ action: 'install', source: 'folder', english: true })).extension.version, '1.2.0');
    review.release();
    assert.equal((await pending).error, 'extension_changed'); assert.equal((await entry()).version, '1.2.0');
    // 4 removed meanwhile: not revived.
    review = reviewing(); pending = manager.request({ action: 'install', source: 'folder', english: true });
    await review.opened; await manager.request({ action: 'remove', id }); review.release();
    assert.deepEqual(await pending, { status: 'cancelled', error: 'extension_not_found' });
    assert.deepEqual((await manager.request({ action: 'list' })).extensions, []);
    await assert.rejects(stat(path.join(store, 'packages', id)), /ENOENT/);
    // 5 two first-time installs of the same ID (a manifest key fixes it): the later-confirmed one is cancelled.
    await writeFile(path.join(folder, 'manifest.json'), manifest({ version: '2.0.0', key: rsa().publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));
    review = reviewing(); pending = manager.request({ action: 'install', source: 'folder', english: true });
    await review.opened;
    assert.equal((await manager.request({ action: 'install', source: 'folder', english: true })).status, 'ok');
    review.release();
    assert.equal((await pending).error, 'extension_changed');
    assert.equal((await manager.request({ action: 'list' })).extensions.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('context-menu items of a deleted install do not return when the same ID is installed again', async () => {
  const { EventEmitter } = await import('node:events');
  const root = await temp();
  try {
    const { folder, manager, personal } = await setup(root);
    personal.serviceWorkers = Object.assign(new EventEmitter(), { workers: new Map(), getWorkerFromVersionID: id => personal.serviceWorkers.workers.get(id), startWorkerForScope: async () => undefined });
    personal.extensions.getExtension = id => personal.loaded.has(id) ? { manifest: { name: 'Menus', permissions: ['contextMenus'] } } : undefined;
    const key = rsa().publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await writeFile(path.join(folder, 'manifest.json'), manifest({ name: 'Menus', permissions: ['contextMenus'], key }));
    const id = (await manager.request({ action: 'install', source: 'folder' })).extension.id;
    const ipc = new EventEmitter(); ipc.handle = (channel, fn) => { ipc.handlers = { ...(ipc.handlers ?? {}), [channel]: fn }; };
    personal.serviceWorkers.workers.set(1, { scope: `chrome-extension://${id}/`, ipc, send() {} });
    personal.serviceWorkers.emit('running-status-changed', { versionId: 1 });
    await ipc.handlers['tarobot-extension:call']({}, 'contextMenus.create', [{ id: 'm1', title: 'Old item' }]);
    const labels = () => manager.menuItems(personal, { pageURL: 'https://site.test/' }, { id: 1 }).filter(item => item.label).map(item => item.label);
    assert.deepEqual(labels(), ['Old item']);
    await manager.clear(); assert.deepEqual(labels(), []);
    await manager.request({ action: 'install', source: 'folder' });
    assert.deepEqual(labels(), [], 'the commit unloads the ID everywhere first, which forgets its bridge state');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable registry loads nothing and is kept', async () => {
  const root = await temp();
  try {
    const store = path.join(root, 'workbench-browser-extensions'); await mkdir(store); await writeFile(path.join(store, 'registry.json'), '{"version":1,"extensions":[{"id":"bad"}]}');
    const electron = fakeElectron({ chosen: () => undefined }), manager = new BrowserExtensions(store, electron, { limits }), personal = electron.session.fromPartition(partitionFor(PERSONAL_BROWSER_SCOPE));
    await manager.attach(personal, PERSONAL_BROWSER_SCOPE); assert.equal(personal.loaded.size, 0);
    await assert.rejects(manager.request({ action: 'list' }), /extensions_unreadable/);
    assert.match(await readFile(path.join(store, 'registry.json'), 'utf8'), /"bad"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('WorkbenchBrowser routes the command with a session preparer and clears extensions on full local reset only', async () => {
  const calls = [], session = { getUserAgent: () => 'Mozilla/5.0 Chrome/1 Electron/1 Safari/1', setUserAgent() {}, setPermissionCheckHandler() {}, setPermissionRequestHandler() {},
    setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} }, clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {}, clearHostResolverCache: async () => {} };
  const extensions = { attach: (_session, scope) => { calls.push(['attach', scope.host]); return Promise.resolve(); }, ready: async () => {}, compatible: () => false,
    request: async (input, context) => { calls.push(['request', input.action, !!context.window]); context.prepare(PERSONAL_BROWSER_SCOPE); return { status: 'ok', extensions: [] }; },
    clear: async () => { calls.push(['clear']); }, forget: async names => { calls.push(['forget', names.length]); }, refreshCompat: async () => {} };
  const window = { on() {}, isVisible: () => true, isMinimized: () => false, isDestroyed: () => false, contentView: { addChildView() {} } };
  const electron = { app: { getLocale: () => 'en-US' }, session: { fromPartition: () => session } };
  const browser = new WorkbenchBrowser(window, electron, { extensions });
  assert.deepEqual(await browser.request(EXTENSIONS_COMMAND, { action: 'list' }, () => true), { status: 'ok', extensions: [] });
  assert.deepEqual(calls.slice(0, 2), [['request', 'list', true], ['attach', PERSONAL_BROWSER_SCOPE.host]]);
  await browser.request('workbench_browser_reset', { host: PERSONAL_BROWSER_SCOPE.host, scopes: [PERSONAL_BROWSER_SCOPE] }, () => true);
  assert.ok(calls.some(call => call[0] === 'clear')); assert.ok(calls.some(call => call[0] === 'forget'));
  calls.length = 0;
  await browser.request('workbench_browser_reset', { host: 'other-host', scopes: [{ ...conversation, host: 'other-host' }] }, () => true);
  assert.ok(!calls.some(call => call[0] === 'clear'), 'a Host removal keeps installed extensions'); assert.ok(calls.some(call => call[0] === 'forget'));
  const plain = new WorkbenchBrowser(window, electron, {});
  await assert.rejects(plain.request(EXTENSIONS_COMMAND, { action: 'list' }, () => true), /extensions_unavailable/);
});

// DS2-01: an earlier timed-out policy load must not undo a later activation, and
// the filter may go only while the policy extension is actually loaded.
test('a timed-out policy load that settles during a retry cannot remove the retry\'s policy', async () => {
  const root = await temp();
  try {
    let draining, finishDrain;
    const drain = async () => { draining?.(); await new Promise(resolve => { finishDrain = resolve; }); return passDrain(); };
    const { manager, personal, store } = await setup(root, { drain });
    const original = personal.extensions.loadExtension; let releaseFirst, first = true;
    personal.extensions.loadExtension = directory => {
      if (first && directory.endsWith(`${path.sep}policy`)) { first = false; return new Promise(resolve => { releaseFirst = () => resolve(original(directory)); }); }
      return original(directory);
    };
    assert.equal((await manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true })).error, 'compatibility_unavailable');
    assert.equal(personal.filtered, true);
    const reached = new Promise(resolve => { draining = resolve; });
    const retry = manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true });
    await reached;
    const policy = await policyIdOf(store);
    assert.ok(personal.loaded.has(policy), 'the retry loaded the policy');
    // The first native load finally settles while the retry is closing pages.
    releaseFirst(); await new Promise(resolve => setTimeout(resolve, 30));
    finishDrain();
    assert.deepEqual(await retry, { status: 'ok', enabled: true, active: true });
    assert.ok(personal.loaded.has(policy), 'the active policy stays loaded'); assert.equal(personal.filtered, false);
    assert.ok(manager.compatible(personal));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compatibility mode keeps the filter when its policy is gone at the switch', async () => {
  const root = await temp();
  try {
    let session, store;
    // Anything that unloads the policy after it reported ready, before the switch.
    const drain = async () => { session.extensions.removeExtension(await policyIdOf(store)); return passDrain(); };
    const context = await setup(root, { drain }); session = context.personal; store = context.store;
    assert.deepEqual(await context.manager.request({ action: 'compat_set', scope: PERSONAL_BROWSER_SCOPE, enabled: true }),
      { status: 'ok', enabled: true, active: false, error: 'compatibility_unavailable' });
    assert.equal(session.filtered, true, 'fails closed: the request filter stays'); assert.ok(!context.manager.compatible(session));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// DS2-02: a native load still pending keeps one load in flight and stays visible.
test('reloading while the native load is still pending reports the timeout and never starts a second load', async () => {
  const root = await temp();
  try {
    const { manager, personal } = await setup(root);
    const original = personal.extensions.loadExtension; let release, starts = 0;
    personal.extensions.loadExtension = directory => {
      if (!directory.includes(`${path.sep}packages${path.sep}`)) return original(directory);
      starts++; return new Promise(resolve => { release = () => resolve(original(directory)); });
    };
    const installed = await manager.request({ action: 'install', source: 'folder' }), id = installed.extension.id;
    assert.equal(installed.extension.error, 'extension_load_timeout');
    const reloaded = await manager.request({ action: 'reload', id });
    assert.equal(reloaded.extension.error, 'extension_load_timeout', 'still loading: never reported as a clean reload');
    assert.equal((await manager.request({ action: 'list' })).extensions[0].error, 'extension_load_timeout');
    assert.equal(starts, 1, 'no concurrent load of the same extension');
    release(); for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await manager.request({ action: 'list' }); }
    assert.ok(personal.loaded.has(id)); assert.equal((await manager.request({ action: 'list' })).extensions[0].error, undefined);
    assert.equal(starts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Host session attached again while its load is pending shows the timeout and loads once after it settles', async () => {
  const root = await temp();
  try {
    const { manager, page } = await setup(root);
    const id = (await manager.request({ action: 'install', source: 'folder' })).extension.id;
    const original = page.extensions.loadExtension; let release, starts = 0;
    page.extensions.loadExtension = directory => { starts++; return starts === 1 ? new Promise(resolve => { release = () => resolve(original(directory)); }) : original(directory); };
    assert.equal((await manager.request({ action: 'set', id, scope: 'all' })).extension.error, 'extension_load_timeout');
    await manager.forget([partitionFor(conversation)]); await manager.attach(page, conversation);
    assert.equal((await manager.request({ action: 'list' })).extensions[0].error, 'extension_load_timeout', 'the pending load stays visible');
    assert.equal(starts, 1, 'no second load while the first is in flight');
    release(); for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await manager.request({ action: 'list' }); }
    assert.ok(page.loaded.has(id), 'loaded once into the session in use'); assert.equal(starts, 2);
    assert.equal((await manager.request({ action: 'list' })).extensions[0].error, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
