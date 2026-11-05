import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { NATIVE_BOOTSTRAP, NATIVE_REQUEST, NATIVE_EVENT } from '../contract.mjs';

const bundled = await build({ entryPoints: [fileURLToPath(new URL('../preload.mjs', import.meta.url))], write: false,
  bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] });
function preload(invoke) {
  const events = new Map(), dom = new Map(); let api;
  const context = vm.createContext({ URL, location: { href: 'tarobot://app/index.html' }, process: { isMainFrame: true, platform: 'darwin' },
    setTimeout: fn => setTimeout(fn, 1), addEventListener: (name, fn) => dom.set(name, fn),
    require: name => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'tarobotDesktop'); api = value; } },
        ipcRenderer: { on: (name, fn) => events.set(name, fn), invoke: async (...args) => clone(await invoke(...args)) } };
    },
  });
  const clone = value => value === undefined ? undefined : vm.runInContext(`(${JSON.stringify(value)})`, context);
  vm.runInContext(bundled.outputFiles[0].text, context);
  return { api, clone, hide: () => dom.get('pagehide')(), emit: value => events.get(NATIVE_EVENT)({ sender: 'must-not-leak' }, clone(value)) };
}
test('preload retries a not-yet-committed bootstrap with a bound and keeps its token out of the public API', async () => {
  let bootstraps = 0, requests = 0;
  const f = preload(async (channel, request) => {
    if (channel === NATIVE_BOOTSTRAP) { if (++bootstraps === 1) throw new Error('native_document_not_committed'); return 'private-token'; }
    assert.equal(channel, NATIVE_REQUEST); assert.equal(request.token, 'private-token'); requests++; return { ok: true, result: 'doc' };
  });
  assert.equal(await f.api.invoke('net_document'), 'doc'); assert.equal(bootstraps, 2); assert.equal(requests, 1);
  assert.equal(f.api.token, undefined); await assert.rejects(f.api.invoke('helper_info'), /unknown_native_command/);
});
test('failed bootstrap is not cached forever, while retry attempts per call are bounded', async () => {
  let unavailable = true, bootstraps = 0;
  const f = preload(async channel => {
    if (channel === NATIVE_BOOTSTRAP) { bootstraps++; if (unavailable) throw new Error('native_document_not_committed'); return 'token'; }
    return { ok: true, result: 'doc' };
  });
  await assert.rejects(f.api.invoke('net_document'), /not_committed/); assert.equal(bootstraps, 5);
  unavailable = false; assert.equal(await f.api.invoke('net_document'), 'doc'); assert.equal(bootstraps, 6);
});
test('pagehide during bootstrap cannot issue the pending native command or renew authority', async () => {
  let release, requests = 0;
  const f = preload(async channel => {
    if (channel === NATIVE_BOOTSTRAP) return new Promise(resolve => { release = resolve; });
    requests++; return { ok: true, result: null };
  });
  const pending = assert.rejects(f.api.invoke('device_create'), /native_document_retired/);
  f.hide(); release('old-token'); await pending;
  await assert.rejects(f.api.invoke('net_document'), /native_document_retired/); assert.equal(requests, 0);
});
test('socket callbacks receive payload only and stop after close or cancellation', async () => {
  const requests = [], received = [];
  const f = preload(async (channel, request) => {
    if (channel === NATIVE_BOOTSTRAP) return 'token';
    requests.push(request); return { ok: true, result: null };
  });
  await f.api.openSocket(f.clone({ id: 'one', origin: 'https://test' }), payload => received.push(JSON.parse(JSON.stringify(payload))));
  const subscription = requests.at(-1).subscription;
  f.emit({ subscription, payload: { kind: 'open' } }); f.emit({ subscription, payload: { kind: 'close' } });
  f.emit({ subscription, payload: { kind: 'message', data: 'late' } });
  assert.deepEqual(received, [{ kind: 'open' }, { kind: 'close' }]);
  await f.api.openSocket(f.clone({ id: 'two', origin: 'https://test' }), payload => received.push(payload));
  const second = requests.at(-1).subscription;
  await f.api.invoke('net_cancel', f.clone({ id: 'two' })); f.emit({ subscription: second, payload: { kind: 'open' } });
  assert.equal(received.length, 2);
});
