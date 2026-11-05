import path from 'node:path';
import { z } from 'zod';
import { DESKTOP_EVENT } from './contract.mjs';
import { DesktopFiles, FILE_COMMANDS } from './files.mjs';
import { DesktopNotifications, NOTIFICATION_COMMANDS } from './notifications.mjs';
import { MIGRATION_COMMANDS } from './migration-service.mjs';
import { captureScreenshot } from './screenshot.mjs';
import { DesktopUpdates, UPDATE_COMMANDS } from './updater.mjs';
import { BROWSER_COMMANDS, BROWSER_EVENT, WorkbenchBrowser } from './browser.mjs';
import { prepareDesignQuit, cancelDesignQuit } from './design-quit.mjs';

const empty = z.object({}).strict();
const point = z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict();
const enabled = z.object({ enabled: z.boolean() }).strict();
const menus = { Undo: 'undo', Redo: 'redo', Cut: 'cut', Copy: 'copy', Paste: 'paste', SelectAll: 'selectAll' };
const schemas = {
  desktop_window_read: empty, desktop_window_size: z.object({ width: z.number().finite().min(100).max(20000), height: z.number().finite().min(100).max(20000) }).strict(),
  desktop_window_side_minimum: z.object({ width: z.number().finite().min(100).max(20000).nullable() }).strict(),
  desktop_window_position: point, desktop_window_fullscreen: enabled, desktop_window_focus: empty,
  desktop_context_menu: z.object({ items: z.array(z.object({ item: z.enum([...Object.keys(menus), 'Separator']), text: z.string().max(80).optional() }).strict()).min(1).max(12), point }).strict(),
  desktop_open_url: z.object({ url: z.string().max(8192) }).strict(),
  desktop_launch_links: empty, desktop_autostart_get: empty, desktop_autostart_set: enabled,
  unread_count: z.object({ count: z.number().int().min(0).max(1000000) }).strict(), desktop_notification_settings: empty,
};

export function externalURL(raw) {
  const url = new URL(raw);
  if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_external_url');
  return url.href;
}

/** Main-owned OS operations. No renderer-selected executable, IPC channel,
 * filesystem root, arbitrary shell, or BrowserWindow object crosses the bridge. */
export class DesktopServices {
  constructor(window, electron, { platform = process.platform, launchLinks = () => [], addon, badgeChanged = () => {}, migration, autostart, updater, restart, reveal, devTools = false, screenService } = {}) {
    this.window = window; this.electron = electron; this.platform = platform; this.launchLinks = launchLinks;
    this.files = new DesktopFiles(window, electron, { platform, ...(addon ? { mark: file => addon.markSavedFile(file) } : {}) });
    this.addon = addon; this.screenService = screenService; this.screenEpoch = 0;
    this.badgeChanged = badgeChanged; this.migration = migration; this.autostart = autostart;
    this.updater = updater; this.installPrepared = false;
    this.updates = updater && new DesktopUpdates(window, updater, {
      beforeInstall: async () => {
        if (!await prepareDesignQuit(this.window.webContents)) throw new Error('design_not_saved');
        this.installPrepared = true; this.screenService?.stop(); this.retireScreen();
      },
      afterInstall: installed => this.finishInstall(installed),
      version: electron.app.getVersion(), quit: () => electron.app.quit(), relaunch: () => { if (!restart) throw new Error('restart_unavailable'); restart(); },
    });
    this.notifications = new DesktopNotifications(window, addon, (name, payload) => this.emit(name, payload));
    // Workbench web partitions: registry of partition→Host for Host removal, and
    // Chromium's Partitions directory to confirm a partition exists before clearing.
    const appPath = name => { try { return electron.app.getPath(name); } catch { return undefined; } }, userData = appPath('userData'), sessionData = appPath('sessionData');
    this.browser = new WorkbenchBrowser(window, electron, { emit: payload => this.emit(BROWSER_EVENT, payload), reveal, addon, platform, devTools,
      ...(userData ? { registry: path.join(userData, 'workbench-browser-partitions.json') } : {}), ...(sessionData ? { partitionRoot: path.join(sessionData, 'Partitions') } : {}) });
    this.cleanups = []; this.menu = undefined;
    this.scale = 1;
    // On macOS isFullScreen changes before the Space animation completes.
    // HTML viewers must not issue the opposite transition during that gap.
    this.settledFullscreen = window.isFullScreen?.() ?? false;
    this.watch('enter-full-screen', () => { this.settledFullscreen = true; });
    this.watch('leave-full-screen', () => { this.settledFullscreen = false; });
    for (const name of ['resize', 'move', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize']) this.watch(name, () => this.emit('window-state', null));
    for (const name of ['show', 'hide', 'minimize', 'restore']) this.watch(name, () => this.emit('window-state', { visible: this.window.isVisible(), minimized: this.window.isMinimized() }));
    this.watch('blur', () => this.screenViewers?.releaseAll());
    for (const name of ['hide', 'minimize']) this.watch(name, () => this.screenViewers?.windowVisibility(false));
    for (const name of ['show', 'restore']) this.watch(name, () => this.screenViewers?.windowVisibility(this.window.isVisible() && !this.window.isMinimized()));
    this.watch('focus', () => this.emit('focus', null));
  }
  watch(name, fn) { this.window.on(name, fn); this.cleanups.push(() => this.window.removeListener(name, fn)); }
  emit(name, payload) { if (!this.window.isDestroyed()) this.window.webContents.send(DESKTOP_EVENT, { name, payload }); }
  async request(command, input, active) {
    if (!active()) throw new Error('native_document_retired');
    if (UPDATE_COMMANDS.includes(command)) {
      if (this.migration && !this.migration.ready && ['github_update_install', 'restart_client'].includes(command)) throw new Error('migration_not_complete');
      if (!this.updates) throw new Error('github_update_configuration');
      return this.updates.request(command, input, active);
    }
    if (MIGRATION_COMMANDS.includes(command)) {
      if (!this.migration) throw new Error('migration_service_unavailable');
      return this.migration.request(command, input, active);
    }
    if (FILE_COMMANDS.includes(command)) return this.files.request(command, input, active);
    if (NOTIFICATION_COMMANDS.includes(command)) return this.notifications.request(command, input);
    if (command === 'capture_screenshot') return captureScreenshot(this.window, this.addon, input, active, this.platform);
    if (BROWSER_COMMANDS.includes(command)) {
      // Workbench pages and their scoped sessions start only after the existing
      // migration gate, so no new store is written before imported data exists.
      if (this.migration && !this.migration.ready) throw new Error('migration_not_complete');
      return this.browser.request(command, input, active);
    }
    if (command.startsWith('screen_')) {
      if (this.migration && !this.migration.ready) throw new Error('migration_not_complete');
      if (command === 'screen_service_status') { empty.parse(input); return this.screenService?.status() ?? { supported: false }; }
      if (command === 'screen_service_retry') { empty.parse(input); if (!this.screenService) throw new Error('screen_service_unavailable'); return this.screenService.retry(); }
      if (command === 'screen_service_permission') { const { kind } = z.object({ kind: z.enum(['capture', 'accessibility', 'input-monitoring']) }).strict().parse(input); if (!this.screenService) throw new Error('screen_service_unavailable'); return this.screenService.permission(kind); }
      if (command === 'screen_service_stop') { const { sessionId } = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict().parse(input); if (!this.screenService) throw new Error('screen_service_unavailable'); return this.screenService.stop(sessionId); }
      if (command === 'screen_viewer_open') {
        const epoch = this.screenEpoch;
        const { ScreenViewers } = await import('./screen-viewer.mjs');
        if (!active() || epoch !== this.screenEpoch) throw new Error('native_document_retired');
        this.screenViewers ??= new ScreenViewers(this.window, this.electron);
        return this.screenViewers.open(input, () => active() && epoch === this.screenEpoch);
      }
      if (command === 'screen_viewer_close') { const { sessionId } = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict().parse(input); this.screenViewers?.close(sessionId); return null; }
      if (command === 'screen_viewer_visibility') { const { sessionId, visible } = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), visible: z.boolean() }).strict().parse(input); this.screenViewers?.visibility(sessionId, visible); return null; }
    }
    const schema = schemas[command];
    if (!schema) throw new Error('unknown_desktop_command');
    const checked = schema.safeParse(input);
    if (!checked.success) throw new Error('invalid_desktop_args');
    const args = checked.data, w = this.window, { screen, app, shell, Menu } = this.electron;
    switch (command) {
      case 'desktop_window_read': {
        const bounds = w.getBounds(), inner = w.getContentBounds(), display = screen.getDisplayMatching(bounds);
        const scale = display.scaleFactor; this.scale = scale;
        const work = display.workArea;
        return { x: bounds.x * scale, y: bounds.y * scale, width: inner.width * scale, height: inner.height * scale,
          outerWidth: bounds.width * scale, outerHeight: bounds.height * scale, scale,
          maximized: w.isMaximized(), fullscreen: w.isFullScreen(), focused: w.isFocused(), resizable: w.isResizable(), visible: w.isVisible(), minimized: w.isMinimized(),
          fullscreenTransitioning: this.platform === 'darwin' && w.isFullScreen() !== this.settledFullscreen,
          work: { x: work.x * scale, y: work.y * scale, width: work.width * scale, height: work.height * scale } };
      }
      case 'desktop_window_side_minimum': {
        if (args.width === null) { this.restoreSideMinimum(); return null; }
        const bounds = w.getBounds(), content = w.getContentBounds(), display = screen.getDisplayMatching(bounds);
        this.sideMinimum ??= w.getMinimumSize();
        const width = Math.min(display.workArea.width, Math.max(this.sideMinimum[0], Math.round(args.width / display.scaleFactor) + bounds.width - content.width));
        w.setMinimumSize(width, this.sideMinimum[1]); return null;
      }
      case 'desktop_window_size': w.setContentSize(Math.round(args.width / this.scale), Math.round(args.height / this.scale)); return null;
      case 'desktop_window_position': w.setPosition(Math.round(args.x / this.scale), Math.round(args.y / this.scale)); return null;
      case 'desktop_window_fullscreen': w.setFullScreen(args.enabled); return null;
      case 'desktop_window_focus': if (w.isFocused()) w.webContents.focus(); return null;
      case 'desktop_context_menu': {
        this.menu?.closePopup(w);
        const menu = Menu.buildFromTemplate(args.items.map(item => item.item === 'Separator' ? { type: 'separator' } : { role: menus[item.item], ...(item.text ? { label: item.text } : {}) }));
        this.menu = menu;
        try { await new Promise(resolve => menu.popup({ window: w, x: Math.round(args.point.x), y: Math.round(args.point.y), callback: resolve })); }
        finally { if (this.menu === menu) this.menu = undefined; }
        return null;
      }
      case 'desktop_open_url': {
        const url = externalURL(args.url);
        try { await shell.openExternal(url); }
        catch {
          if (active() && !w.isDestroyed()) await this.electron.dialog.showMessageBox(w, { type: 'error', title: 'TaroBird',
            message: app.getLocale().startsWith('en') ? 'Could not open this link in your browser. Copy the link and try again.' : '无法在浏览器中打开链接，请复制链接后重试。' });
          throw new Error('external_open_failed');
        }
        return null;
      }
      case 'desktop_launch_links': return this.launchLinks();
      case 'desktop_autostart_get': return this.autostart ? this.autostart.get() : false;
      case 'desktop_autostart_set':
        if (!this.autostart) throw new Error('autostart_requires_installed_app');
        await this.autostart.set(args.enabled); return null;
      case 'unread_count': app.setBadgeCount(args.count); this.badgeChanged(args.count); return null;
      case 'desktop_notification_settings':
        if (this.platform === 'darwin') {
          if (await shell.openPath('/System/Applications/System Settings.app')) throw new Error('notification_settings_unavailable');
        } else if (this.platform === 'win32') await shell.openExternal('ms-settings:notifications');
        else throw new Error('notification_settings_unavailable');
        return null;
      default: throw new Error('unknown_desktop_command');
    }
  }
  restoreSideMinimum() {
    if (!this.sideMinimum) return;
    if (!this.window.isDestroyed()) this.window.setMinimumSize(...this.sideMinimum);
    this.sideMinimum = undefined;
  }
  retireScreen() { this.screenEpoch++; this.screenViewers?.retire(); }
  retire() { this.restoreSideMinimum(); this.retireScreen(); this.menu?.closePopup(this.window); this.menu = undefined; this.files.retire(); this.notifications.retire(); this.migration?.retire(); this.browser.retire(); }
  dispose() { this.retire(); this.browser.dispose(); this.notifications.dispose(); for (const stop of this.cleanups.splice(0)) stop(); }
  finishInstall(installed) {
    // A verified replacement can still report Host restart failure. Retain the
    // preflight in that case: the old bundle must not be used for another save.
    this.installPrepared = this.installPrepared && Boolean(installed || this.updater?.restartRequired || this.updater?.handoff);
    if (!this.installPrepared) this.quitCancelled();
  }
  async prepareQuit() {
    // Check the current renderer on every quit. Only individual editors that
    // remain saved and locked can reuse their pre-install preparation.
    if (!await this.browser.prepareQuit()) return false;
    return await prepareDesignQuit(this.window.webContents);
  }
  quitCancelled() { this.browser.quitCancelled(); cancelDesignQuit(this.window.webContents); }
}
