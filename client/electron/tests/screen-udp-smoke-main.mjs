// Isolated Electron target for screen-udp.smoke.mjs. Only a synthetic window
// is available for capture; the input addon records calls without posting them.
import * as electron from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { SCHEMES } from '../assets.mjs';
import { ScreenCaptureHost } from '../screen-capture-host.mjs';
import { ScreenService } from '../screen-service.mjs';
import { screenServiceTicket } from '../screen-host-control.mjs';

const { app, BrowserWindow, protocol } = electron;
const dir = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.setPath('userData', path.join(dir, 'profile.noindex'));
app.dock?.hide();

app.whenReady().then(async () => {
  const synthetic = new BrowserWindow({ show: false, width: 640, height: 360, frame: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await synthetic.loadURL(`data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0"><canvas width="640" height="360"></canvas><script>
  const canvas=document.querySelector('canvas'), ctx=canvas.getContext('2d');
  let n=0;
  setInterval(()=>{
    ctx.fillStyle='#294968';ctx.fillRect(0,0,640,360);
    ctx.fillStyle='#fcffef';ctx.fillRect(40+n%450,70,120,80);
    ctx.font='24px sans-serif';ctx.fillText('Synthetic screen '+n++,32,200);
  },45);
  </script>`)}`);

  let monitor = false, cursor = { x: 0, y: 0 };
  const native = {
    screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001', audit: 1 }),
    screenDisplayUuid: () => 'fixture-display', screenCursor: () => cursor,
    screenCaptureAccess: () => true,
    screenMonitorStart: () => { monitor = true; },
    screenMonitorPoll: () => ({ alive: monitor, failed: false, foreign: 0, interrupted: 0 }),
    screenMonitorStop: () => { monitor = false; },
    screenReleaseAll: () => 0, screenReleaseStale: () => 0,
    screenMouse: (_kind, _button, x, y) => { cursor = { x, y }; writeFileSync(path.join(dir, 'synthetic-input'), 'received\n'); },
  };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 640, height: 360 }, scaleFactor: 1, rotation: 0, label: 'Synthetic' }],
  });
  const platform = {
    screen, powerMonitor: new EventEmitter(), systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true },
  };
  const service = new ScreenService({
    electron: platform, addon: native, stateDir: path.join(dir, 'service'), platform: 'darwin',
    hostControl: { ticket: id => screenServiceTicket(process.argv[2], id) },
    captureHost: hooks => new ScreenCaptureHost({
      ...hooks, electron, root: path.join(dir, 'screen-capture'), preload: path.join(dir, 'capture-preload.cjs'),
      resolveSource: async () => synthetic.webContents.mainFrame,
    }),
    log: code => console.error(code),
  });
  await service.start();
  app.on('will-quit', () => service.dispose());
  process.on('SIGTERM', () => app.quit());
}).catch(error => { console.error(error); app.exit(1); });
