import * as electron from 'electron';
import { BrowserWindow, net, session } from 'electron';
import { DesktopServices } from './desktop-services.mjs';
import { assetHandler } from './assets.mjs';
import { secureContents, secureSession, secureWebPreferences } from './security.mjs';
import { NativeOwner } from './native-owner.mjs';
import { installRendererRecovery } from './renderer-recovery.mjs';
import { APP_ENTRY } from './contract.mjs';

/** Main-owned constructor; none of these paths/options come from renderer IPC.
 * Production launch remains gated until data migration and desktop capabilities
 * pass acceptance. This constructor is exercised by the isolated native suite. */
export async function createDesktopWindow({ assets, preload, nativeConfig, partition, owners, visible = true, addon, screenService, launchLinks, badgeChanged, migration, autostart, updater, restart, reveal, quitting, production = false }) {
  const desktopSession = session.fromPartition(partition);
  secureSession(desktopSession, { owns: contents => owners.has(contents.id), systemPreferences: electron.systemPreferences });
  if (await desktopSession.protocol.isProtocolHandled('tarobot')) desktopSession.protocol.unhandle('tarobot');
  if (await desktopSession.protocol.isProtocolHandled('tarobot-widget')) desktopSession.protocol.unhandle('tarobot-widget');
  desktopSession.protocol.handle('tarobot', assetHandler(assets, url => net.fetch(url)));
  desktopSession.protocol.handle('tarobot-widget', assetHandler(assets, url => net.fetch(url), { widget: true }));
  const title = 'TaroBird';
  // Electron's y is the top of the 14px controls, not the legacy Tauri anchor.
  // Centre them at y=28, alongside the 56px sidebar brand row.
  const window = new BrowserWindow({ title, width: 1200, height: 820, minWidth: 600, minHeight: 480,
    // Keep Windows' native caption controls; reveal the menu only with Alt.
    autoHideMenuBar: process.platform === 'win32',
    show: false, backgroundColor: '#f6f6f6', ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 21 } } : {}),
    webPreferences: { ...secureWebPreferences(preload, desktopSession), devTools: !production, backgroundThrottling: false } });
  secureContents(window.webContents);
  window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle(title); });
  const services = new DesktopServices(window, electron, { addon, screenService, launchLinks, badgeChanged, migration, autostart, updater, restart, reveal, devTools: !production });
  const owner = new NativeOwner(window.webContents, nativeConfig, { controller: true, services, beforeNativeStart: reason => {
    // Focus/online recovery sends Host commands automatically. Refuse those
    // without turning a passive status check into an unsolicited App restart.
    updater?.guardRuntime(reason === 'host-command' ? undefined : restart);
  } });
  installRendererRecovery(window, { app: electron.app, dialog: electron.dialog, entry: APP_ENTRY, quitting,
    updating: () => updater?.installing === true, recoveryRequired: () => updater?.recoveryRequired === true, restartRequired: () => updater?.restartRequired === true, restart });
  const id = window.webContents.id; owners.set(id, owner);
  window.webContents.on('destroyed', () => owners.delete(id));
  try {
    await window.loadURL(APP_ENTRY);
    if (visible) window.show();
    return window;
  } catch (error) { owner.dispose(); window.destroy(); throw error; }
}
