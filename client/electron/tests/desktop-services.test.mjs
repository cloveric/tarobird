import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopServices, externalURL } from '../desktop-services.mjs';
import { validateViewRequest } from '../contract.mjs';

test('Windows unread counts use a taskbar overlay and remove it when read; other platforms keep native badges', async () => {
  const window = new EventEmitter(), calls = [], badgeCounts = [], tips = [];
  const image = { addRepresentation() {} };
  const atlas = { isEmpty: () => false, getSize: () => ({ width: 640, height: 640 }), crop: () => ({ resize: () => ({ toPNG: () => Buffer.from('fixture') }) }) };
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} }, setOverlayIcon: (...args) => calls.push(args) });
  const electron = { app: { setBadgeCount: n => badgeCounts.push(n), getLocale: () => 'zh-CN' }, nativeImage: { createFromPath: () => atlas, createEmpty: () => image } };
  const service = new DesktopServices(window, electron, { platform: 'win32', badgeChanged: n => tips.push(n) });
  try {
    await service.request('unread_count', { count: 1 }, () => true);
    assert.equal(calls.length, 1); assert.equal(calls[0][0], image); assert.match(calls[0][1], /1/);
    await service.request('unread_count', { count: 120 }, () => true);
    assert.match(calls[1][1], /120/);
    await service.request('unread_count', { count: 0 }, () => true);
    assert.equal(calls[2][0], null); assert.deepEqual(badgeCounts, []); assert.deepEqual(tips, [1, 120, 0]);
    await assert.rejects(service.request('unread_count', { count: -1 }, () => true), /invalid_desktop_args/);
    await assert.rejects(service.request('unread_count', { count: 2 }, () => false), /native_document_retired/);
    assert.equal(calls.length, 3);
    for (const platform of ['darwin', 'linux']) {
      service.platform = platform;
      await service.request('unread_count', { count: 7 }, () => true);
    }
    assert.deepEqual(badgeCounts, [7, 7]); assert.equal(calls.length, 3);
  } finally { service.dispose(); }
});

test('screen management IPC preserves status and permission receipts, and retry cannot request a grant', async () => {
  const window = new EventEmitter(), calls = [];
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} } });
  const status = { supported: true, phase: 'retrying', registered: false, retryAt: 1234, error: 'screen_host_unavailable',
    permissions: { capture: 'denied', accessibility: false, inputMonitoring: false }, desktop: null, sessions: [] };
  const screenService = { status: () => status, retry: async () => { calls.push('retry'); return status; },
    permission: async kind => { calls.push(kind); return { ...status, requested: true, opened: true }; } };
  const service = new DesktopServices(window, {}, { screenService });
  try {
    assert.deepEqual(await service.request('screen_service_status', {}, () => true), status);
    assert.deepEqual(calls, []);
    assert.doesNotThrow(() => validateViewRequest({ command: 'screen_service_retry', args: {} }, { controller: true }));
    assert.throws(() => validateViewRequest({ command: 'screen_service_retry', args: {} }), /native_controller_required/);
    await assert.rejects(service.request('screen_service_retry', { kind: 'capture' }, () => true));
    await assert.rejects(service.request('screen_service_retry', {}, () => false), /native_document_retired/);
    assert.deepEqual(calls, []);
    assert.deepEqual(await service.request('screen_service_retry', {}, () => true), status);
    assert.deepEqual(calls, ['retry']);
    for (const kind of ['capture', 'accessibility', 'input-monitoring']) {
      assert.deepEqual(await service.request('screen_service_permission', { kind }, () => true), { ...status, requested: true, opened: true });
    }
    await assert.rejects(service.request('screen_service_permission', { kind: 'all' }, () => true));
    service.migration = { ready: false, retire() {} };
    await assert.rejects(service.request('screen_service_retry', {}, () => true), /migration_not_complete/);
    assert.deepEqual(calls, ['retry', 'capture', 'accessibility', 'input-monitoring']);
    service.migration = undefined; service.screenService = undefined;
    await assert.rejects(service.request('screen_service_retry', {}, () => true), /screen_service_unavailable/);
  } finally { service.dispose(); }
});

test('external navigation rejects file, script, custom protocols and embedded credentials', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'tarobot://app/index.html', 'https://user:password@example.org']) assert.throws(() => externalURL(url));
  assert.equal(externalURL('https://example.org/path'), 'https://example.org/path');
});
test('window geometry translates content size and position consistently on a scaled left display', async () => {
  const window = new EventEmitter(), calls = [];
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} },
    getBounds: () => ({ x: -1400, y: 20, width: 900, height: 700 }), getContentBounds: () => ({ width: 880, height: 660 }),
    isMaximized: () => false, isFullScreen: () => false, isFocused: () => true, isResizable: () => true, isVisible: () => true, isMinimized: () => false,
    setContentSize: (...value) => calls.push(['size', ...value]), setPosition: (...value) => calls.push(['position', ...value]) });
  const service = new DesktopServices(window, { screen: { getDisplayMatching: () => ({ scaleFactor: 2, workArea: { x: -1600, y: 0, width: 1600, height: 1000 } }) } });
  const frame = await service.request('desktop_window_read', {}, () => true);
  assert.equal(frame.width, 1760); assert.equal(frame.x, -2800); assert.equal(frame.work.x, -3200);
  assert.equal(frame.visible, true); assert.equal(frame.minimized, false);
  await service.request('desktop_window_size', { width: 2200, height: 1320 }, () => true);
  await service.request('desktop_window_position', { x: -3000, y: 40 }, () => true);
  assert.deepEqual(calls, [['size', 1100, 660], ['position', -1500, 20]]);
  await assert.rejects(service.request('desktop_window_size', { width: NaN, height: 1000 }, () => true), /invalid_desktop_args/);
  await assert.rejects(service.request('desktop_window_position', { x: 0, y: 0 }, () => false), /native_document_retired/);
  service.dispose(); assert.equal(window.listenerCount('focus'), 0);
});
test('native show, hide and minimize events report visibility separately from geometry', () => {
  const window = new EventEmitter(), events = []; let visible = false, minimized = false;
  Object.assign(window, { isDestroyed: () => false, isVisible: () => visible, isMinimized: () => minimized,
    webContents: { send(_channel, event) { events.push(event); } } });
  const service = new DesktopServices(window, {});
  try {
    window.emit('hide'); visible = true; window.emit('show'); minimized = true; window.emit('minimize');
    minimized = false; window.emit('restore'); window.emit('move');
    assert.deepEqual(events.filter(event => event.name === 'window-state').map(event => event.payload), [
      { visible: false, minimized: false }, { visible: true, minimized: false },
      { visible: true, minimized: true }, { visible: true, minimized: false }, null,
    ]);
  } finally { service.dispose(); }
  assert.equal(window.listenerCount('hide'), 0);
});
test('macOS fullscreen state distinguishes a requested transition from its completed native event',async()=>{
  const window=new EventEmitter();let fullscreen=false;
  Object.assign(window,{isDestroyed:()=>false,webContents:{send(){}},
    getBounds:()=>({x:0,y:0,width:1100,height:760}),getContentBounds:()=>({width:1100,height:760}),
    isMaximized:()=>false,isFullScreen:()=>fullscreen,isFocused:()=>true,isResizable:()=>true,isVisible:()=>true,isMinimized:()=>false});
  const service=new DesktopServices(window,{screen:{getDisplayMatching:()=>({scaleFactor:1,workArea:{x:0,y:0,width:2560,height:1440}})}},{platform:'darwin'});
  const read=()=>service.request('desktop_window_read',{},()=>true);
  try{
    assert.equal((await read()).fullscreenTransitioning,false);
    fullscreen=true;assert.equal((await read()).fullscreenTransitioning,true);
    window.emit('enter-full-screen');assert.equal((await read()).fullscreenTransitioning,false);
    fullscreen=false;assert.equal((await read()).fullscreenTransitioning,true);
    window.emit('leave-full-screen');assert.equal((await read()).fullscreenTransitioning,false);
    service.platform='win32';fullscreen=true;assert.equal((await read()).fullscreenTransitioning,false);
  }finally{service.dispose();}
  assert.equal(window.listenerCount('enter-full-screen'),0);assert.equal(window.listenerCount('leave-full-screen'),0);
});
test('an unfinished migration blocks replacement and restart even if invoked without UI', async () => {
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, webContents: { send() {} } });
  const service = new DesktopServices(window, {}, { migration: { ready: false, retire() {} } });
  for (const command of ['github_update_install', 'restart_client']) await assert.rejects(service.request(command, {}, () => true), /migration_not_complete/);
  service.dispose();
});

test('side width minimum is scaled, monitor bounded, and restored on close or document retirement',async()=>{
  const window=new EventEmitter();let minimum=[600,480];const calls=[];
  Object.assign(window,{isDestroyed:()=>false,webContents:{send(){}},getMinimumSize:()=>[...minimum],setMinimumSize:(...size)=>{minimum=size;calls.push(size);},
    getBounds:()=>({x:-1400,y:20,width:900,height:700}),getContentBounds:()=>({width:880,height:660})});
  const service=new DesktopServices(window,{screen:{getDisplayMatching:()=>({scaleFactor:2,workArea:{x:-1600,y:0,width:1600,height:1000}})}});
  assert.doesNotThrow(()=>validateViewRequest({command:'desktop_window_side_minimum',args:{width:2400}},{controller:true}));
  assert.throws(()=>validateViewRequest({command:'desktop_window_side_minimum',args:{width:2400}}),/native_controller_required/);
  await service.request('desktop_window_side_minimum',{width:2400},()=>true);assert.deepEqual(minimum,[1220,480]);
  await service.request('desktop_window_side_minimum',{width:10000},()=>true);assert.deepEqual(minimum,[1600,480]);
  await assert.rejects(service.request('desktop_window_side_minimum',{width:NaN},()=>true),/invalid_desktop_args/);
  await assert.rejects(service.request('desktop_window_side_minimum',{width:2400},()=>false),/native_document_retired/);
  await service.request('desktop_window_side_minimum',{width:null},()=>true);assert.deepEqual(minimum,[600,480]);
  await service.request('desktop_window_side_minimum',{width:2400},()=>true);service.retire();assert.deepEqual(minimum,[600,480]);
  service.dispose();assert.equal(calls.length,5);
});
