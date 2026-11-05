// Windows half of scripts/desktop-persisted-migration-audit.mjs. A development
// Electron package starts with the acceptance identity; its main process finds
// the persistent WebView2 profile, starts the packaged exporter (SourceGuard
// checks that this main `tarocub-client.exe` is the parent) and the renderer
// imports the export. Nothing here spawns the exporter.
import { _electron } from '@playwright/test';
import { cp, readFile, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { helperEnvironment } from '../helper-rpc.mjs';
import { MigrationStore } from '../migration.mjs';
import { assertImported, assertReloadKeepsQueue } from './migration-content.mjs';

/** Development-only main option (see the patch in the Phase 6 report). */
export const ACCEPTANCE_FLAG = '--tarobot-migration-acceptance';
// e2e/fixtures/desktop-migration-native.ts, as exported by the macOS persisted audit.
export const FIXTURE_RECORDS = 9;

export async function windowsElectronImport({ root, bundleId, receipt, source, exporter }) {
  const webview = path.join(process.env.LOCALAPPDATA ?? '', bundleId, 'EBWebView');
  if (!path.isAbsolute(webview) || !(await stat(webview).catch(() => undefined))?.isDirectory()) throw new Error(`persistent_webview2_profile_missing: ${webview}`);
  // A clone keeps the input package untouched; the exporter goes where production keeps it.
  const app = path.join(root, 'electron');
  await cp(source, app, { recursive: true, errorOnExist: true, force: false });
  const executable = path.join(app, 'tarocub-client.exe');
  if (!(await stat(executable).catch(() => undefined))?.isFile()) throw new Error('electron_package_executable_missing');
  await cp(exporter, path.join(app, 'resources', 'native', 'tarobot-migration-exporter.exe'));
  const markerFile = path.join(root, 'electron-profile', 'tarobot-desktop-profile-v1.json');
  const errors = [];
  let electron;
  try {
    electron = await _electron.launch({ executablePath: executable, args: [`--tarobot-development=${root}`, `${ACCEPTANCE_FLAG}=${bundleId}`],
      env: { ...helperEnvironment(), TAROBOT_MIGRATION_AUDIT_ROOT: root }, timeout: 60000 });
    const page = await electron.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    // The first WebView2 start of the exporter can take a while on a cold runner.
    const settled = await page.waitForFunction(() => !document.querySelector('.desktop-migration-gate') && !!document.querySelector('.host-workspace'), null, { timeout: 180000 }).then(() => true, () => false);
    const marker = await readFile(markerFile, 'utf8').then(JSON.parse, () => undefined);
    if (!settled || marker?.mode !== 'imported') {
      const gate = await page.locator('.desktop-migration-gate').textContent({ timeout: 2000 }).catch(() => '');
      if (marker?.mode === 'fresh' || /migration_reader_unavailable/.test(gate ?? '')) {
        throw new Error(`electron_main_acceptance_reader_hook_missing: main did not treat ${webview} as legacy data or start the exporter (needs ${ACCEPTANCE_FLAG}=<identity> in development main); profile ${JSON.stringify(marker)}`);
      }
      throw new Error(`electron_import_incomplete: ${gate || 'the migration gate did not finish'}; profile ${JSON.stringify(marker)}`);
    }
    // The audit exporter records its own identity when it finishes.
    const context = JSON.parse(await readFile(path.join(root, 'reader-context.json'), 'utf8'));
    assert.equal(context.configId, bundleId);
    const manifest = await new MigrationStore(path.join(root, 'native-state')).verify(marker.exportId);
    assert.equal(manifest.totals.records, FIXTURE_RECORDS);
    const committed = JSON.parse(await readFile(path.join(root, 'native-state', 'desktop-migration', 'receipts', `${marker.exportId}.json`), 'utf8'));
    assert.deepEqual({ exportId: committed.exportId, records: committed.records, target: committed.target }, { exportId: marker.exportId, records: FIXTURE_RECORDS, target: 'electron' });
    const installation = await readFile(path.join(root, 'native-state', 'tarobot-client-installation-v1'));
    const { after } = await assertImported(page, { receipt, state: root, exportId: marker.exportId, marker: installation });
    await page.screenshot({ path: path.join(root, 'imported.png') });
    await assertReloadKeepsQueue(page, receipt);
    assert.deepEqual(await readFile(path.join(root, 'native-state', 'tarobot-client-installation-v1')), installation);
    assert.deepEqual(errors, []);
    return { passed: true, platform: 'win32', bundleId, exportId: marker.exportId, records: manifest.totals.records, bytes: manifest.totals.bytes,
      source: 'real persistent WebView2 / audit exporter started by Electron main (SourceGuard on)', target: 'development Electron package / native migration gate',
      exporter: context, after, leftover: path.dirname(webview) };
  } finally {
    if (electron) await Promise.race([electron.close(), new Promise(resolve => { const timer = setTimeout(() => { electron.process().kill(); resolve(); }, 5000); timer.unref(); })]);
  }
}
