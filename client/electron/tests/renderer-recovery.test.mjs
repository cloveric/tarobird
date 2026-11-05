import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRendererRecovery } from '../renderer-recovery.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const events = [], queue = [];
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, loadURL: async url => events.push(['load', url]) });
  const app = { getLocale: () => 'en', quit: () => events.push(['quit']) };
  const dialog = { showMessageBox: async () => { events.push(['dialog']); return { response: 1 }; } };
  const dispose = installRendererRecovery(window, { app, dialog, entry: 'tarobot://app/index.html',
    defer: fn => { queue.push(fn); return fn; }, cancel: fn => queue.splice(queue.indexOf(fn), 1), ...overrides });
  return { contents, window, events, queue, dispose };
}
test('crashes recover automatically with a bounded retry budget and a native exit action', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) { f.contents.emit('render-process-gone'); await tick(); }
  assert.equal(f.events.filter(e => e[0] === 'load').length, 3);
  assert.deepEqual(f.events.slice(-2), [['dialog'], ['quit']]); f.dispose();
});
test('recovery does not load during a bundle replacement, and restarts after it', async () => {
  let updating = true, replaced = false, restarted = 0;
  const f = fixture({ updating: () => updating, restartRequired: () => replaced, restart: () => restarted++ });
  f.contents.emit('render-process-gone'); assert.equal(f.queue.length, 1); assert.deepEqual(f.events, []);
  updating = false; replaced = true; f.queue.shift()(); await tick();
  assert.equal(restarted, 1); assert.deepEqual(f.events, []); f.dispose();
});
test('quitting and destroyed windows never revive themselves', async () => {
  const f = fixture({ quitting: () => true }); f.contents.emit('render-process-gone'); await tick(); assert.deepEqual(f.events, []);
  const other = fixture(); other.contents.emit('destroyed'); other.contents.emit('render-process-gone'); await tick(); assert.deepEqual(other.events, []);
});
test('failed reloads are retried without stacking simultaneous loads or dialogs', async () => {
  const f = fixture(); let release;
  f.window.loadURL = () => new Promise((resolve, reject) => { release = reject; });
  f.contents.emit('render-process-gone'); f.contents.emit('render-process-gone');
  assert.equal(f.queue.length, 0); release(new Error('load failed')); await tick();
  assert.equal(f.queue.length, 1); f.dispose(); assert.equal(f.queue.length, 0);
});


test('a hung renderer offers a choice, and a recovered renderer is never killed by a late answer', async () => {
  let answer; const dialog = { showMessageBox: () => new Promise(resolve => { answer = resolve; }) };
  const f = fixture({ dialog }); let crashes = 0; f.contents.forcefullyCrashRenderer = () => crashes++;
  f.window.emit('unresponsive'); f.window.emit('responsive'); answer({ response: 1 }); await tick();
  assert.equal(crashes, 0);
  f.window.emit('unresponsive'); answer({ response: 0 }); await tick(); assert.equal(crashes, 0);
  f.window.emit('unresponsive'); answer({ response: 1 }); await tick(); assert.equal(crashes, 1); f.dispose();
});


test('unconfirmed bundle recovery never reloads or relaunches the renderer', async () => {
  const f = fixture({ recoveryRequired: () => true, restart: () => assert.fail('must not restart') });
  f.contents.emit('render-process-gone'); await tick();
  assert.equal(f.events.filter(e => e[0] === 'load').length, 0);
  assert.deepEqual(f.events, [['dialog']]);
  f.dispose();
});
