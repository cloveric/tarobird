import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DesktopServices } from '../desktop-services.mjs';
import { prepareDesignQuit, cancelDesignQuit } from '../design-quit.mjs';

function fixture() {
  const window = new EventTarget();
  const contents = { isDestroyed: () => false, executeJavaScript: async code => vm.runInNewContext(code, { window, CustomEvent }) };
  return { window, contents };
}
test('native quit waits for every editor and cancellation releases the renderer', async () => {
  const f = fixture(); let done, cancelled = 0;
  f.window.addEventListener('tarobot:design-quit', event => {
    if (event.detail.cancel) cancelled++;
    else { event.detail.pending.push(Promise.resolve(true), new Promise(resolve => { done = resolve; })); }
  });
  let settled = false;
  const preparing = prepareDesignQuit(f.contents).then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  done(true); assert.equal(await preparing, true);
  cancelDesignQuit(f.contents); await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
});
test('failed editor, renderer failure and timeout never authorize quitting', async () => {
  const f = fixture(); f.window.addEventListener('tarobot:design-quit', event => event.detail.pending.push(Promise.resolve(false)));
  assert.equal(await prepareDesignQuit(f.contents), false);
  assert.equal(await prepareDesignQuit({ ...f.contents, executeJavaScript: async () => { throw Error('renderer gone'); } }), false);
  assert.equal(await prepareDesignQuit({ ...f.contents, executeJavaScript: () => new Promise(() => {}) }, { timeoutMs: 5 }), false);
});
test('no Design editor and an already destroyed renderer require no save', async () => {
  const f = fixture(); assert.equal(await prepareDesignQuit(f.contents), true);
  assert.equal(await prepareDesignQuit({ ...f.contents, isDestroyed: () => true, executeJavaScript: () => { throw Error('must not run'); } }), true);
});

test('desktop services preserve the pre-install permit through replacement and cancel failed preparation', async () => {
  const f=fixture();let flushes=0,cancelled=0,browserChecks=0;
  f.window.addEventListener('tarobot:design-quit',event=>{if(event.detail.cancel)cancelled++;else{flushes++;event.detail.pending.push(Promise.resolve(true));}});
  const service={window:{webContents:f.contents},browser:{prepareQuit:async()=>{browserChecks++;return true;},quitCancelled(){}},installPrepared:false,updater:{restartRequired:false}};
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service),true);assert.equal(flushes,1);
  service.installPrepared=true;service.updater.restartRequired=true;
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service),true);assert.equal(flushes,2,'each actual quit checks the current renderer; only its still-locked editors can reuse a saved permit');assert.equal(browserChecks,2,'browser pages still check current unsaved work');
  DesktopServices.prototype.quitCancelled.call(service);await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,1);
  service.installPrepared=false;service.browser.prepareQuit=async()=>false;
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service),false);assert.equal(flushes,2);
});

test('a replaced bundle with Host restart failure retains its saved install permit', () => {
  let cancelled=0;
  const service={installPrepared:true,updater:{restartRequired:true},quitCancelled(){cancelled++;}};
  DesktopServices.prototype.finishInstall.call(service,false);
  assert.equal(service.installPrepared,true);assert.equal(cancelled,0);
  service.updater.restartRequired=false;
  DesktopServices.prototype.finishInstall.call(service,false);
  assert.equal(service.installPrepared,false);assert.equal(cancelled,1);
  service.updater.restartRequired=true;
  DesktopServices.prototype.finishInstall.call(service,false);
  assert.equal(service.installPrepared,false,'a prior failure cannot manufacture a preflight permit');
});


test('a cancelled restart cannot authorize later unsaved work using the old installation permit', async () => {
  const f = fixture(); let saved = false, browserReady = false;
  f.window.addEventListener('tarobot:design-quit', event => {
    if (event.detail.cancel) saved = false;
    else event.detail.pending.push(Promise.resolve(saved));
  });
  const service = { window: { webContents: f.contents }, browser: { prepareQuit: async () => browserReady, quitCancelled() {} }, installPrepared: true, updater: { restartRequired: true } };
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service), false);
  DesktopServices.prototype.quitCancelled.call(service);
  await new Promise(resolve => setImmediate(resolve));
  browserReady = true;
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service), false, 'new or unlocked editor must save before restart');
  saved = true;
  assert.equal(await DesktopServices.prototype.prepareQuit.call(service), true);
});
