import { CAPTURE_ORIGIN } from './screen-capture-contract.mjs';
import { captureAsset } from './screen-capture-host.mjs';

const WIDTH = 330, HEIGHT = 26;
/** Persistent "being shared" badge on every display that is being viewed or
 * controlled. Never takes focus or mouse input (inactive, click-through panel)
 * and is deliberately capturable: its once-per-second clock is a controlled
 * redraw that is expected (not guaranteed) to keep a static capture producing frames. */
export class ScreenIndicator {
  #windows = new Map(); #session; #since = new Map();
  constructor({ electron, root, partition = 'screen-indicator-v1' }) { Object.assign(this, { electron, root, partition }); }
  #ses() {
    if (this.#session) return this.#session;
    const ses = this.electron.session.fromPartition(this.partition);
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${CAPTURE_ORIGIN}/indicator.`) }));
    ses.protocol.handle('tarobot-screen', captureAsset(this.root));
    ses.setPermissionRequestHandler((_c, _p, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    return (this.#session = ses);
  }
  /** `items`: [{ deviceName, displayId(nativeId), controlling }] from the service. */
  update(items) {
    const byDisplay = new Map();
    for (const item of items) { const list = byDisplay.get(item.nativeId) ?? []; list.push(item); byDisplay.set(item.nativeId, list); }
    for (const [id, window] of this.#windows) if (!byDisplay.has(id)) { if (!window.isDestroyed()) window.destroy(); this.#windows.delete(id); this.#since.delete(id); }
    const displays = this.electron.screen.getAllDisplays();
    const english = this.electron.app.getLocale().startsWith('en');
    for (const [id, list] of byDisplay) {
      const display = displays.find(d => String(d.id) === id);
      if (!display) continue;
      if (!this.#since.has(id)) this.#since.set(id, Date.now());
      const area = display.workArea, x = Math.round(area.x + area.width - WIDTH - 12), y = Math.round(area.y + 6);
      let window = this.#windows.get(id);
      if (!window || window.isDestroyed()) {
        window = new this.electron.BrowserWindow({ x, y, width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true, resizable: false, movable: false,
          minimizable: false, maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, type: 'panel',
          webPreferences: { session: this.#ses(), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, backgroundThrottling: false } });
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, 'status');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.once('ready-to-show', () => { if (!window.isDestroyed()) window.showInactive(); });
        this.#windows.set(id, window);
      } else window.setBounds({ x, y, width: WIDTH, height: HEIGHT });
      const hash = new URLSearchParams({ lang: english ? 'en' : 'zh', since: String(this.#since.get(id)),
        names: list.map(item => String(item.deviceName || '').slice(0, 64)).join('\n'), control: list.some(item => item.controlling) ? '1' : '0' });
      void window.loadURL(`${CAPTURE_ORIGIN}/indicator.html#${hash}`).catch(() => {});
    }
  }
  close() { for (const window of this.#windows.values()) if (!window.isDestroyed()) window.destroy(); this.#windows.clear(); this.#since.clear(); }
}
