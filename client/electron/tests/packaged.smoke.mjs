import { _electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const [binary, output, stateRoot] = process.argv.slice(2);
if (!binary || !output || !stateRoot) throw new Error('explicit package, lab and short isolated state root required');
const root = await isolatedRoot(output);
// macOS control sockets have a 104-byte pathname limit. Artifact/report paths
// can be descriptive; the real isolated Host state must obey the OS limit.
const profiles = await isolatedRoot(stateRoot);
if (Buffer.byteLength(path.join(profiles, 'fresh-XXXXXX/app-state/host/control.sock')) > 100) throw new Error('test_host_path_too_long');
if (!binary.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('isolated_package_required');
const checks = [];
for (const scenario of ['fresh', 'legacy']) {
  const state = await mkdtemp(path.join(profiles, `${scenario}-`));
  if (scenario === 'legacy') { await mkdir(path.join(state, 'native-state')); await writeFile(path.join(state, 'native-state/tarobot-client-installation-v1'), randomBytes(32)); }
  let app;
  try {
    app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${state}`], env: helperEnvironment(), timeout: 30000 });
    app.process().stderr.on('data', bytes => process.stderr.write(bytes));
    console.log('launched', scenario);
    const page = await app.firstWindow({ timeout: 15000 }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    if (scenario === 'fresh') {
      await page.waitForFunction(() => !document.querySelector('.desktop-migration-gate'), null, { timeout: 30000 });
      await page.getByRole('heading', { name: '从这台电脑开始', exact: true }).waitFor({ timeout: 30000 });
      assert.equal(await page.evaluate(() => window.tarobotDesktop?.engine), 'electron');
      const marker = JSON.parse(await readFile(path.join(state, 'electron-profile/tarobot-desktop-profile-v1.json'), 'utf8'));
      assert.equal(marker.mode, 'fresh');
      checks.push('packaged full App passed fresh-profile gate');
      await page.getByLabel('主机名称', { exact: true }).fill('Electron isolated acceptance');
      await page.getByRole('button', { name: '将这台电脑设为主机', exact: true }).click();
      await page.waitForFunction(() => !!document.querySelector('.host-workspace'), null, { timeout: 45000 });
      const status = await page.evaluate(() => window.tarobotDesktop.invoke('desktop_host', { action: 'status' }));
      assert.equal(status.running, true); assert.ok(status.publicKey);
      checks.push('bundled independent Host starts and native local pairing opens the workspace');
      await page.screenshot({ path: path.join(root, 'fresh-desktop.png') });
      await writeFile(path.join(root, 'fresh-ui.txt'), await page.locator('body').innerText());
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
      assert.equal(page.isClosed(), false); checks.push('close hides the live main window without dropping its document');
      await app.evaluate(({ app }) => app.emit('activate'));
      await page.waitForFunction(() => document.visibilityState === 'visible');
      checks.push('Dock activation restores the same window');
    } else {
      await page.getByText('桌面数据迁移尚未完成，原有数据已保留。', { exact: true }).waitFor();
      await page.getByText('migration_reader_unavailable', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(root, 'legacy-protection.png') });
      const result = await page.evaluate(() => window.tarobotDesktop.invoke('device_create').then(() => 'unexpected-success', error => error.message));
      assert.match(result, /migration_not_complete/);
      checks.push('existing Tauri installation cannot create a new identity without data import');
    }
    if (scenario === 'fresh') {
      const ids = await page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('tarocub-hosts-v1'); request.onerror = () => reject(request.error);
        request.onsuccess = () => { const db = request.result, rows = db.transaction('hosts').objectStore('hosts').getAll();
          rows.onsuccess = () => { db.close(); resolve(rows.result.map(row => row.keyRef).filter(Boolean)); }; rows.onerror = () => reject(rows.error); };
      }));
      await page.evaluate(() => window.tarobotDesktop.invoke('desktop_host', { action: 'stop' }));
      for (const keyRef of ids) await page.evaluate(keyRef => window.tarobotDesktop.invoke('device_forget', { keyRef }), keyRef);
      checks.push('isolated Host stops and only its temporary device keys are retired');
    }
    assert.deepEqual(errors, []); checks.push(`${scenario} full App has no unhandled renderer exceptions`);
  } catch (error) {
    if (app) { const page = app.windows()[0]; if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: path.join(root, `${scenario}-failure.png`) }).catch(() => {}); } }
    throw error;
  } finally { if (app) {
    // A failing assertion must not leave the isolated service behind. This
    // native bridge was launched with this test's explicit state root only.
    if (scenario === 'fresh') await app.windows()[0]?.evaluate(() => window.tarobotDesktop.invoke('desktop_host', { action: 'stop' })).catch(() => {});
    await Promise.race([app.close(), new Promise(resolve => { const timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 5000); timer.unref(); })]);
  } }
}
await writeFile(path.join(root, 'verification.json'), JSON.stringify({ passed: true, binary, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
