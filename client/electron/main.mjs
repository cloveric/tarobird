import * as electron from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SCHEMES } from './assets.mjs';
import { developmentPaths } from './isolation.mjs';
import { productionPaths, preparePaths } from './startup-paths.mjs';
import { DesktopMigration, legacyDesktopPresent } from './migration-service.mjs';
import { DesktopAutostart } from './autostart.mjs';
import { installDesktopLifecycle } from './lifecycle.mjs';
import { installNativeIPC } from './native-owner.mjs';
import { createDesktopWindow } from './window.mjs';
import { UpdaterProcess } from './updater.mjs';
import { LegacyReader } from './legacy-reader.mjs';
import { developmentMigration } from './migration-acceptance.mjs';
import { helperEnvironment } from './helper-rpc.mjs';
import { validProductionLaunch } from './startup-arguments.mjs';
import { ScreenService } from './screen-service.mjs';
import { ScreenCaptureHost, desktopSource } from './screen-capture-host.mjs';
import { desktopScreenTicket } from './screen-host-control.mjs';
import { ScreenIndicator } from './screen-indicator.mjs';

const { app, protocol, ipcMain, dialog } = electron;
app.setName('TaroBird');
app.enableSandbox();
protocol.registerSchemesAsPrivileged(SCHEMES);
async function failStartup(error) {
  const code = error instanceof Error ? error.message.slice(0, 512) : 'desktop_start_failed';
  console.error('TaroBird desktop startup:', code);
  await app.whenReady();
  await dialog.showMessageBox({ type: 'error', title: 'TaroBird', message: '桌面启动未完成 / Desktop startup failed', detail: code });
  app.exit(1);
}
async function boot() {
const application = app.getAppPath();
const metadata = JSON.parse(readFileSync(path.join(application, 'desktop.json'), 'utf8'));
if (metadata.format !== 1 || !['development', 'production'].includes(metadata.mode)) throw new Error('invalid_desktop_package');
const production = metadata.mode === 'production';
if (production && !validProductionLaunch(process.argv, app.isPackaged)) {
  // Do not route this through failStartup: whenReady could start CDP first.
  console.error('TaroBird desktop startup: invalid_production_launch'); app.exit(64); return;
}
const addon = createRequire(import.meta.url)(path.join(process.resourcesPath, 'native', 'tarobot-desktop-native.node'));
// The native notification delegate must exist before AppKit finishes launching.
// Never initialize Electron.Notification: it would replace this delegate.
addon.initializeNotifications();
const installerExit = addon.notificationInstallerCommand();
if (installerExit !== undefined && installerExit !== null) app.exit(installerExit);
else {
  const owners = new Map();
  let paths, migration, updater, reader, screenService, screenIndicator, autostart;
  const helper = path.join(process.resourcesPath, 'native', process.platform === 'win32' ? 'tarobot-desktop-core.exe' : 'tarobot-desktop-core');
  const lifecycle = installDesktopLifecycle(electron, { addon, production, updating: () => updater?.installing === true || [...owners.values()].some(owner => owner.services?.updates?.preparing),
    prepareQuit: async () => { for (const owner of owners.values()) if (await owner.services?.prepareQuit?.() === false) return false; await screenService?.prepareQuit(); return true; },
    stopSharing: () => screenService?.stop(undefined, 'screen_service_stopped'),
    quitCancelled: () => { for (const owner of owners.values()) owner.services?.quitCancelled?.(); },
    icon: path.join(application, process.platform === 'darwin' ? 'tray-macos.png' : 'icon.png'),
    createWindow: options => createDesktopWindow({ ...options,
      assets: path.join(application, 'dist'), preload: path.join(application, 'preload.cjs'),
      nativeConfig: { ...paths, executable: helper,
        keyringService: production ? 'com.tarobot.client.device' : `com.tarobot.client.device.dev-${createHash('sha256').update(paths.profile).digest('hex').slice(0, 20)}` },
      partition: 'persist:desktop-v1', owners, addon, screenService, migration, updater, production, quitting: () => lifecycle.quitting,
      restart: () => lifecycle.restart(), autostart: (autostart ??= new DesktopAutostart(app, { production, addon })),
    }),
  });
  const prepare = async () => {
    if (production) {
      if (!app.isPackaged || process.argv.some(arg => arg.startsWith('--tarobot-development') || arg.startsWith('--tarobot-migration-acceptance'))) throw new Error('invalid_production_launch');
      paths = productionPaths({ platform: process.platform, appData: app.getPath('appData'), localAppData: process.env.LOCALAPPDATA, resources: process.resourcesPath });
    } else {
      const flags = process.argv.filter(arg => arg.startsWith('--tarobot-development='));
      if (flags.length !== 1) throw new Error('isolated_development_profile_required');
      paths = await developmentPaths(flags[0].slice('--tarobot-development='.length));
      paths.resourcesDir = path.join(process.resourcesPath, 'host');
    }
    const acceptance = await developmentMigration({ production, root: paths.root });
    if (acceptance) paths.legacyWebviewDirs = acceptance.legacyWebviewDirs;
    const required = await legacyDesktopPresent(paths.stateDir, paths.legacyWebviewDirs);
    await preparePaths(paths);
    app.setName(production ? 'TaroBird' : 'TaroBird Electron Acceptance');
    app.setPath('userData', paths.profile); app.setPath('sessionData', paths.cache);
    app.setAppUserModelId(production ? 'com.tarobot.client' : 'com.tarobot.electron.acceptance');
    if (!app.requestSingleInstanceLock()) { app.quit(); return false; }
    reader = production || acceptance ? new LegacyReader(process.platform === 'darwin'
      ? path.join(path.dirname(process.execPath), 'tarobot-migration-exporter')
      : path.join(process.resourcesPath, 'native', 'tarobot-migration-exporter.exe'), acceptance
        ? { environment: () => ({ ...helperEnvironment(), TAROBOT_MIGRATION_AUDIT_ROOT: acceptance.auditRoot }) } : {}) : undefined;
    migration = new DesktopMigration({ ...paths, legacyRequired: required, reader });
    updater = new UpdaterProcess(production ? {
      executable: path.join(process.resourcesPath, 'native', process.platform === 'win32' ? 'tarobot-desktop-updater.exe' : 'tarobot-desktop-updater'),
      configFile: path.join(process.resourcesPath, 'native', 'update-config.json'), appVersion: app.getVersion(),
      appBundle: process.platform === 'darwin' ? path.resolve(process.resourcesPath, '../..') : path.dirname(process.execPath),
      resourcesDir: paths.resourcesDir, hostStateDir: paths.hostStateDir, workDir: path.join(paths.stateDir, 'updates.noindex'),
    } : undefined);
    // App-level remote screen target (#99): independent of the chat window and
    // its document; it captures nothing until the Host starts a session.
    // The ticket resolves the canonical Host directory below hostStateDir the
    // same way the native core does (`<id>/host`, or an existing legacy Host).
    screenService = new ScreenService({ electron, addon, stateDir: paths.stateDir, log: code => console.warn('TaroBird screen:', code),
      hostControl: { ticket: desktopId => desktopScreenTicket(paths.hostStateDir, desktopId) },
      captureHost: hooks => new ScreenCaptureHost({ electron, root: path.join(application, 'screen-capture'), preload: path.join(application, 'screen-capture-preload.cjs'),
        resolveSource: display => desktopSource(electron.desktopCapturer, display), ...hooks }),
      onSharing: items => { lifecycle.setSharing(items); (screenIndicator ??= new ScreenIndicator({ electron, root: path.join(application, 'screen-capture') })).update(items); },
      isUpdating: () => updater?.installing === true });
    installNativeIPC(ipcMain, owners);
    return true;
  };
  // Do not await app.whenReady() at ESM module scope: Electron waits for this
  // entry module to finish evaluating before delivering ready.
  let prepared = false;
  try { prepared = await prepare(); } catch (error) { void failStartup(error); }
  // screenService.start() never rejects: its failure stays visible in
  // screen_service_status and screen_service_retry starts it again.
  if (prepared) void app.whenReady().then(() => {
    autostart ??= new DesktopAutostart(app, { production, addon });
    void autostart.repairLegacy().catch(() => console.warn('TaroBird desktop: autostart_repair_failed'));
    return lifecycle.start();
  }).then(() => screenService.start()).catch(error => {
    // Cmd+Q while the first document loads cancels navigation. It is a normal
    // quit, not a startup failure that should open a new blocking dialog.
    if (!lifecycle.quitting) void failStartup(error);
  });
  // Quit can be cancelled by unsaved work. Retire only after windows close.
  app.on('will-quit', () => { screenService?.dispose(); screenIndicator?.close(); for (const owner of owners.values()) owner.dispose(); updater?.shutdown(); reader?.shutdown(); });
}

}
try { await boot(); } catch (error) { void failStartup(error); }
