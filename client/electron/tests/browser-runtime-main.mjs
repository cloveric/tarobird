// Isolated workbench-browser acceptance entry, launched only by
// browser.smoke.mjs. Uses the real App window, preload, NativeOwner,
// DesktopServices and (in lifecycle mode) the real quit lifecycle. The native
// helper is a test stub below .noindex; no Host, keychain or installed App.
import * as electron from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMES } from '../assets.mjs';
import { developmentPaths, isolatedRoot } from '../isolation.mjs';
import { createDesktopWindow } from '../window.mjs';
import { installNativeIPC } from '../native-owner.mjs';
import { installDesktopLifecycle } from '../lifecycle.mjs';

const { app, protocol, ipcMain, dialog } = electron;
protocol.registerSchemesAsPrivileged(SCHEMES);
app.enableSandbox();
const configFlag = process.argv.find(value => value.startsWith('--tarobot-browser-acceptance='));
if (!configFlag) throw new Error('isolated_acceptance_config_required');
const configFile = configFlag.slice('--tarobot-browser-acceptance='.length);
const root = await isolatedRoot(path.dirname(configFile));
if (await realpath(configFile) !== path.join(root, path.basename(configFile))) throw new Error('acceptance_config_redirected');
const config = JSON.parse(await readFile(configFile, 'utf8'));
// Test sites resolve to the local fixture server but keep public host names,
// so loopback protection is exercised exactly as for a remote site. Permission
// APIs need a secure context; the fixture origins are marked secure for this run.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1');
if (config.secureOrigins?.length) app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', config.secureOrigins.join(','));
const paths = await developmentPaths(path.join(root, 'state'));
app.setName('TaroBot Browser Acceptance');
app.setPath('userData', paths.profile); app.setPath('sessionData', paths.cache);
// Native dialogs cannot be clicked by the harness. Record each one and answer
// from a queue the driver fills (default: the safe first button).
const dialogs = { calls: [], answers: [] };
const answer = (kind, args) => {
  const options = args.find(value => value && typeof value === 'object' && 'message' in value) ?? {};
  dialogs.calls.push({ kind, type: options.type, message: options.message, detail: options.detail, buttons: options.buttons });
  return dialogs.answers.length ? dialogs.answers.shift() : 0;
};
dialog.showMessageBox = async (...args) => ({ response: answer('async', args), checkboxChecked: false });
dialog.showMessageBoxSync = (...args) => answer('sync', args);
// Save dialogs (page screenshots/PDFs): record and answer from a queue of
// paths the driver chose below .noindex (default: cancelled).
const saves = { calls: [], answers: [] };
dialog.showSaveDialog = async (...args) => {
  const options = args.find(value => value && typeof value === 'object' && 'defaultPath' in value) ?? {};
  saves.calls.push({ title: options.title, defaultPath: options.defaultPath, filters: options.filters, properties: options.properties });
  return saves.answers.length ? saves.answers.shift() : { canceled: true, filePath: '' };
};
const owners = new Map(); installNativeIPC(ipcMain, owners);
globalThis.__acceptance = { owners, paths, dialogs, saves };
const helper = config.helper ? await realpath(config.helper) : path.join(root, 'no-helper');
if (!helper.split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('isolated_helper_required');
const create = options => createDesktopWindow({ ...options, assets: config.assets, preload: config.preload,
  nativeConfig: { ...paths, executable: helper, keyringService: 'com.tarobot.client.device.browser-acceptance' },
  partition: 'persist:desktop-v1', owners, visible: true, production: false });
if (config.lifecycle) {
  // Same wiring as main.mjs: pages answer beforeunload before windows close.
  const lifecycle = installDesktopLifecycle(electron, { createWindow: create,
    prepareQuit: async () => { for (const owner of owners.values()) if (await owner.services?.prepareQuit?.() === false) return false; return true; },
    quitCancelled: () => { for (const owner of owners.values()) owner.services?.quitCancelled?.(); } });
  void app.whenReady().then(async () => { const { window } = await lifecycle.start(); globalThis.__acceptance.window = window; })
    .catch(error => { console.error('Browser acceptance startup failed:', error.message); app.exit(1); });
  app.on('will-quit', () => { for (const owner of owners.values()) owner.dispose(); });
} else {
  void app.whenReady().then(async () => {
    const window = await create({ reveal: async () => { window.show(); window.focus(); } });
    globalThis.__acceptance.window = window;
  }).catch(error => { console.error('Browser acceptance startup failed:', error.message); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { for (const owner of owners.values()) owner.dispose(); });
}
