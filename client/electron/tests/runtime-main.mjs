// Only invoked by the native acceptance runner, never a production entrypoint.
import { app, protocol, ipcMain } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SCHEMES } from '../assets.mjs';
import { developmentPaths, isolatedRoot } from '../isolation.mjs';
import { createDesktopWindow } from '../window.mjs';
import { installNativeIPC } from '../native-owner.mjs';

protocol.registerSchemesAsPrivileged(SCHEMES);
app.enableSandbox();
const configFlag = process.argv.find(value => value.startsWith('--tarobot-acceptance='));
if (!configFlag) throw new Error('isolated_acceptance_config_required');
const configFile = configFlag.slice('--tarobot-acceptance='.length);
const root = await isolatedRoot(path.dirname(configFile));
if (await realpath(configFile) !== path.join(root, path.basename(configFile))) throw new Error('acceptance_config_redirected');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const paths = await developmentPaths(path.join(root, 'state'));
const helper = await realpath(config.helper);
if (!helper.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('isolated_helper_required');
let addon;
if (config.addon) {
  const file = await realpath(config.addon);
  if (!file.split(path.sep).some(part => part.endsWith('.noindex')) || !file.endsWith('.node')) throw new Error('isolated_addon_required');
  addon = createRequire(import.meta.url)(file);
}
app.setName('TaroBot Electron Acceptance');
app.setPath('userData', paths.profile); app.setPath('sessionData', paths.cache);
app.setAppUserModelId('com.tarobot.electron.acceptance');
const owners = new Map(); installNativeIPC(ipcMain, owners);
// Electron waits for the ESM entrypoint before emitting ready. Await only the
// pre-ready path setup above; awaiting whenReady at module scope deadlocks it.
void app.whenReady().then(() => createDesktopWindow({ assets: config.assets, preload: config.preload,
  nativeConfig: { ...paths, executable: helper, keyringService: `com.tarobot.client.device.test-${randomUUID()}` },
  partition: `acceptance-${randomUUID()}`, owners, visible: false, addon })).catch(error => {
  console.error('Isolated Electron acceptance startup failed:', error.message); app.exit(1);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const owner of owners.values()) owner.dispose(); });
