import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installDesktopLifecycle } from '../lifecycle.mjs';

function fixture(options = {}) {
  const app = new EventEmitter(), window = new EventEmitter(), events = [];
  Object.assign(app, { isReady: () => true, getLocale: () => 'en', quit: () => events.push(['quit-request']), relaunch: () => events.push(['relaunch']), setAsDefaultProtocolClient: () => { throw new Error('development must not register schemes'); } });
  Object.assign(window, { webContents: Object.assign(new EventEmitter(), { send: (...value) => events.push(['send', ...value]) }),
    isDestroyed: () => false, isMinimized: () => false, show: () => events.push(['show']), focus: () => events.push(['focus']), hide: () => events.push(['hide']) });
  let created = 0, initialized = false;
  const lifecycle = installDesktopLifecycle({ app, Menu: { buildFromTemplate: value => value, setApplicationMenu: value => events.push(['menu', value]) }, globalShortcut: { unregisterAll() {
    if (!app.isReady()) throw new Error('globalShortcut cannot be used before the app is ready');
    events.push(['shortcuts-cleared']);
  } }, dialog: { showMessageBoxSync: () => 0, showMessageBox: async () => events.push(['update-blocked']) } },
    { ...options, addon: { initializeNotifications: () => { initialized = true; }, notificationActivationArgs: () => assert.equal(initialized, true) },
      createWindow: async options => { created++; window.options = options; return window; } });
  return { app, window, events, lifecycle, created: () => created, initialized: () => initialized };
}
test('early quit before ready does not call Electron shortcut APIs or open a window', () => {
  const f = fixture(); f.app.isReady = () => false;
  assert.doesNotThrow(() => f.app.emit('will-quit'));
  assert.equal(f.events.some(event => event[0] === 'shortcuts-cleared'), false);
  assert.equal(f.created(), 0);
});

test('a rejected second instance can finish async quit preparation before ready', async () => {
  let preparations = 0, failure;
  const f = fixture({ prepareQuit: async () => { preparations++; return true; } });
  f.app.isReady = () => false;
  f.app.quit = () => {
    let prevented = false;
    f.app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (!prevented) {
      try { f.app.emit('will-quit'); } catch (error) { failure = error; }
    }
  };
  // main.mjs calls app.quit() when requestSingleInstanceLock() returns false.
  f.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failure, undefined);
  assert.equal(preparations, 1);
  assert.equal(f.lifecycle.quitting, true);
  assert.equal(f.created(), 0);
  assert.equal(f.events.some(event => event[0] === 'shortcuts-cleared'), false);
});

test('ready exit still clears global shortcuts after normal startup', async () => {
  const f = fixture(); await f.lifecycle.start();
  f.app.emit('before-quit'); f.app.emit('will-quit');
  assert.equal(f.events.filter(event => event[0] === 'shortcuts-cleared').length, 1);
  assert.equal(f.lifecycle.quitting, true);
});

for (const locale of ['zh-CN', 'en-US']) test(`Windows menus keep native editing and window actions with consistent ${locale} labels`, async () => {
  const f = fixture({ platform: 'win32' }); f.app.getLocale = () => locale;
  await f.lifecycle.start();
  const menu = f.events.find(event => event[0] === 'menu')[1];
  assert.deepEqual(menu.map(item => item.label), locale === 'zh-CN' ? ['文件', '编辑', '视图', '窗口'] : ['File', 'Edit', 'View', 'Window']);
  const actions = menu.flatMap(item => item.submenu).filter(item => item.type !== 'separator');
  assert.equal(actions.some(item => ['zoom', 'front', 'hide'].includes(item.role)), false, 'macOS-only roles must not become dead Windows actions');
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll', 'close', 'togglefullscreen', 'minimize']) {
    const item = actions.find(item => item.role === role);
    assert.ok(item, `${role} remains a native action with its keyboard shortcut`);
    assert.ok(item.label);
    assert.equal(/[\u4e00-\u9fff]/u.test(item.label), locale === 'zh-CN');
    assert.equal(item.click, undefined, 'native roles must not be replaced with custom renderer actions');
  }
});

test('close hides one persistent window; cold links survive until renderer asks for them', async () => {
  const f = fixture(); assert.equal(f.initialized(), true);
  f.app.emit('open-url', { preventDefault() {} }, 'tarocub://conversation/c1');
  await f.lifecycle.start(); await Promise.all([f.lifecycle.show(), f.lifecycle.show()]);
  assert.equal(f.created(), 1);
  assert.deepEqual(f.window.options.launchLinks(), ['tarocub://conversation/c1']);
  let prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(f.events.at(-1), ['hide']);
});
test('cancelled restart never schedules a later surprise relaunch', async () => {
  const f = fixture(); await f.lifecycle.start(); f.lifecycle.restart(); f.app.emit('before-quit');
  assert.equal(f.events.some(e => e[0] === 'relaunch'), false);
  f.window.webContents.emit('will-prevent-unload', { preventDefault() { throw new Error('dirty document must survive'); } });
  f.app.emit('will-quit'); assert.equal(f.events.some(e => e[0] === 'relaunch'), false);
});
test('active update blocks exit with an explanation and clears pending restart', async () => {
  const f = fixture({ updating: () => true }); await f.lifecycle.start(); f.lifecycle.restart();
  let prevented = false; f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.ok(f.events.some(e => e[0] === 'update-blocked'));
  f.app.emit('will-quit'); assert.equal(f.events.some(e => e[0] === 'relaunch'), false);
});
test('accepted restart relaunches only when the original process really quits', async () => {
  const f = fixture(); await f.lifecycle.start(); f.lifecycle.restart(); f.app.emit('before-quit');
  assert.equal(f.events.some(e => e[0] === 'relaunch'), false);
  f.app.emit('will-quit'); assert.equal(f.events.filter(e => e[0] === 'relaunch').length, 1);
});
test('cancelling unsaved-work quit restores close-to-tray behavior', async () => {
  const f = fixture(); await f.lifecycle.start(); f.app.emit('before-quit');
  f.window.webContents.emit('will-prevent-unload', { preventDefault() { throw new Error('must retain dirty document'); } });
  let prevented = false; f.window.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});
test('workbench pages answer beforeunload before any window closes; a kept page cancels quit and restart', async () => {
  let answer = false, cancelled = 0;
  const f = fixture({ prepareQuit: async () => answer, quitCancelled: () => { cancelled++; } });
  await f.lifecycle.start(); assert.equal(typeof f.window.options.reveal, 'function');
  f.lifecycle.restart();
  let prevented = false; f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); await new Promise(resolve => setImmediate(resolve));
  const requests = () => f.events.filter(e => e[0] === 'quit-request').length;
  assert.equal(cancelled, 1); assert.equal(requests(), 1, 'only the restart request itself');
  let hidden = false; f.window.emit('close', { preventDefault() { hidden = true; } });
  assert.equal(hidden, true, 'a cancelled quit keeps close-to-tray');
  f.app.emit('will-quit'); assert.equal(f.events.some(e => e[0] === 'relaunch'), false, 'cancelled restart never relaunches later');
  answer = true; prevented = false;
  f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests(), 2, 'quit resumes after pages agreed');
  prevented = false; f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'prepared pages are not asked twice');
  let closing = false; f.window.emit('close', { preventDefault() { closing = true; } });
  assert.equal(closing, false);
  f.window.webContents.emit('will-prevent-unload', { preventDefault() { throw new Error('dirty App document must survive'); } });
  assert.equal(cancelled, 2, 'App unsaved-work cancellation also resumes workbench pages');
});

test('a rejected quit preparation never authorizes exit or a deferred restart', async () => {
  let cancelled = 0;
  const f = fixture({ prepareQuit: async () => { throw Error('save failed'); }, quitCancelled: () => { cancelled++; } });
  await f.lifecycle.start(); f.lifecycle.restart();
  f.app.emit('before-quit', { preventDefault() {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(f.events.filter(e => e[0] === 'quit-request').length, 1);
  f.app.emit('will-quit'); assert.equal(f.events.some(e => e[0] === 'relaunch'), false);
});
