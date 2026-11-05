import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { NativeOwner, installNativeIPC } from '../native-owner.mjs';
import { APP_ORIGIN, APP_ENTRY, NATIVE_REQUEST } from '../contract.mjs';

function fixture(services) {
  const contents = new EventEmitter(); const sends = [], helpers = [];
  Object.assign(contents, { id: 3, mainFrame: { url: APP_ENTRY, origin: APP_ORIGIN }, isDestroyed: () => false, send: (...args) => sends.push(args) });
  const owner = new NativeOwner(contents, {}, { controller: true, services, helperFactory: (_config, hooks) => {
    let number = 0;
    const helper = { hooks, calls: [], closed: false, ready: async () => {}, close() { this.closed = true; hooks.onClosed(); },
      async call(command, args) {
        this.calls.push({ command, args });
        if (this.run) return this.run(command, args);
        if (command === 'net_document') return `doc-${helpers.length}`;
        if (command === 'net_allocate') return `slot-${++number}`;
        return null;
      } };
    helpers.push(helper); return helper;
  } });
  const event = { sender: contents, senderFrame: contents.mainFrame };
  contents.emit('did-navigate', {}, APP_ENTRY);
  return { owner, contents, event, helpers, sends, call: async (command, args = {}, subscription) => owner.request(event, { command, args, token: owner.bootstrap(event), ...(subscription ? { subscription } : {}) }) };
}

test('iframe/untrusted IPC is denied before spawning any helper', async () => {
  const f = fixture();
  await assert.rejects(f.owner.request({ ...f.event, senderFrame: { ...f.event.senderFrame } }, { command: 'device_create', args: {} }), /untrusted/);
  await assert.rejects(f.call('net_reset'), /invalid_native_request/);
  assert.equal(f.helpers.length, 0); f.owner.dispose();
});
test('native channel IDs are assigned by main and old-document events cannot cross reload', async () => {
  const f = fixture(); const document = await f.call('net_document');
  const id = await f.call('net_allocate', { kind: 'socket', document });
  await f.call('net_socket_open', { id, origin: 'https://hub' }, 1);
  const helper = f.helpers[0], channel = helper.calls.at(-1).args.channel;
  assert.equal(typeof channel, 'string'); assert.notEqual(channel, '1');
  helper.hooks.onEvent({ document, channel, payload: { kind: 'open' } });
  assert.equal(f.sends.length, 1);
  helper.hooks.onEvent({ document: 'wrong', channel, payload: { kind: 'open' } });
  assert.equal(f.sends.length, 1);
  f.contents.emit('did-start-navigation', {}, APP_ENTRY, false, true);
  assert.equal(helper.closed, true);
  helper.hooks.onEvent({ document, channel, payload: { kind: 'message', data: 'old' } });
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1][1].payload.kind, 'close');
  f.contents.emit('did-navigate', {}, APP_ENTRY);
  assert.notEqual(await f.call('net_document'), document); f.owner.dispose();
});
test('subframe/hash navigation does not retire a healthy main document', async () => {
  const f = fixture(); await f.call('net_document');
  f.contents.emit('did-start-navigation', {}, 'https://widget', false, false);
  f.contents.emit('did-start-navigation', {}, APP_ENTRY + '#x', true, true);
  assert.equal(f.helpers[0].closed, false); f.owner.dispose();
});
test('a pending request from before navigation cannot return data into its replacement', async () => {
  const f = fixture(); await f.call('net_document'); let settle;
  f.helpers[0].run = () => new Promise(resolve => { settle = resolve; });
  const pending = f.call('device_create'); const failure = assert.rejects(pending, /native_document_retired/);
  await new Promise(resolve => setImmediate(resolve));
  f.contents.emit('render-process-gone'); settle({ deviceId: 'old' }); await failure; f.owner.dispose();
});
test('navigation blocks the old frame until commit and rejects its token even if the frame object is reused', async () => {
  const f = fixture(); const token = f.owner.bootstrap(f.event);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.throws(() => f.owner.bootstrap(f.event), /not_committed/);
  await assert.rejects(f.owner.request(f.event, { command: 'device_create', args: {}, token }), /native_document_retired/);
  assert.equal(f.helpers.length, 0);
  f.contents.emit('did-navigate', {}, APP_ENTRY);
  assert.notEqual(f.owner.bootstrap(f.event), token);
  await assert.rejects(f.owner.request(f.event, { command: 'device_create', args: {}, token }), /native_document_retired/);
  assert.equal(f.helpers.length, 0); f.owner.dispose();
});
test('helper death informs open sockets once and prevents silent unpinned fallback/recreation', async () => {
  const f = fixture(); const document = await f.call('net_document');
  const id = await f.call('net_allocate', { kind: 'socket', document });
  await f.call('net_socket_open', { id, origin: 'https://hub' }, 9);
  f.helpers[0].hooks.onClosed();
  assert.equal(f.sends[0][1].payload.code, 1006);
  await assert.rejects(f.call('net_document'), /native_document_retired/);
  assert.equal(f.helpers.length, 1); f.owner.dispose();
});
test('duplicate subscriptions cannot steal another socket callback and cancel retires its channel', async () => {
  const f = fixture(); const document = await f.call('net_document');
  const id = await f.call('net_allocate', { kind: 'socket', document });
  await f.call('net_socket_open', { id, origin: 'https://hub' }, 3);
  const channel = f.helpers[0].calls.at(-1).args.channel;
  const second = await f.call('net_allocate', { kind: 'socket', document });
  await assert.rejects(f.call('net_socket_open', { id: second, origin: 'https://hub' }, 3), /invalid_native_subscription/);
  await f.call('net_cancel', { id });
  f.helpers[0].hooks.onEvent({ document, channel, payload: { kind: 'close' } });
  assert.equal(f.sends.length, 0); f.owner.dispose();
});
test('main IPC preserves native error codes and refuses unknown WebContents', async () => {
  const handlers = new Map(), ipc = { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) };
  const f = fixture(); const uninstall = installNativeIPC(ipc, new Map([[f.contents.id, f.owner]]));
  const invoke = handlers.get(NATIVE_REQUEST);
  assert.deepEqual(await invoke({ sender: { id: 4 } }, {}), { ok: false, error: 'untrusted_native_sender' });
  assert.deepEqual(await invoke(f.event, { command: 'helper_info', args: {} }), { ok: false, error: 'invalid_native_request' });
  uninstall(); assert.equal(handlers.size, 0); f.owner.dispose();
});
test('explicit recovery keeps the renderer nonce, retires old leases and starts exactly one replacement', async () => {
  const f = fixture(), token = f.owner.bootstrap(f.event);
  const document = await f.call('net_document');
  f.helpers[0].hooks.onClosed();
  await Promise.all([f.call('desktop_recover'), f.call('desktop_recover')]);
  assert.equal(f.owner.bootstrap(f.event), token);
  assert.equal(f.helpers.length, 2);
  const fresh = await f.call('net_document');
  assert.notEqual(fresh, document);
  await assert.rejects(f.call('net_allocate', { kind: 'http', document }), /native_document_retired/);
  assert.deepEqual(await f.call('desktop_native_state'), { failed: false });
  f.owner.dispose();
});
test('aborted navigation can recover its existing document but a committed replacement never reuses authority', async () => {
  const f = fixture(), token = f.owner.bootstrap(f.event);
  await f.call('net_document');
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.contents.emit('did-stop-loading');
  assert.equal(f.owner.bootstrap(f.event), token);
  assert.deepEqual(await f.call('desktop_native_state'), { failed: true });
  await f.call('desktop_recover'); await f.call('net_document');
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.contents.emit('did-navigate', {}, APP_ENTRY); f.contents.emit('did-stop-loading');
  assert.notEqual(f.owner.bootstrap(f.event), token);
  await assert.rejects(f.owner.request(f.event, { command: 'desktop_recover', args: {}, token }), /native_document_retired/);
  f.owner.dispose();
});


test('cancelled navigation preserves notification context and a pending save while closing sockets', async () => {
  let retired = 0, settle;
  const f = fixture({ retire() { retired++; }, dispose() {}, request: () => new Promise(resolve => { settle = resolve; }) });
  const initial = retired, doc = await f.call('net_document');
  const id = await f.call('net_allocate', { kind: 'socket', document: doc });
  await f.call('net_socket_open', { id, origin: 'https://hub' }, 1);
  const save = f.call('desktop_save_begin', { name: 'a.txt', size: 1 });
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(retired, initial);
  assert.equal(f.sends.filter(([, value]) => value.payload?.kind === 'close').length, 1);
  f.contents.emit('did-stop-loading'); settle('saved');
  assert.equal(await save, 'saved');
  await f.call('desktop_recover');
  assert.equal(retired, initial);
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  f.contents.emit('did-navigate', {}, APP_ENTRY);
  assert.equal(retired, initial + 1); f.owner.dispose();
});


test('bundle recovery fence also blocks Host commands through an already running helper', async () => {
  const f = fixture(); await f.call('net_document');
  let fenced = false;
  f.owner.beforeNativeStart = reason => { assert.equal(reason, 'host-command'); if (fenced) throw new Error('github_update_recovery'); };
  await f.call('desktop_host', { action: 'status' });
  const before = f.helpers[0].calls.length; fenced = true;
  await assert.rejects(f.call('desktop_host', { action: 'resume' }), /github_update_recovery/);
  assert.equal(f.helpers[0].calls.length, before);
  assert.equal(f.helpers.length, 1);
  // An existing connection need not be disconnected by the Host-control fence.
  await f.call('net_allocate', { kind: 'socket', document: 'doc-1' });
  f.owner.dispose();
});

test('cancelled navigation still retires remote viewing while preserving pending local service work', async () => {
  let screens = 0, services = 0;
  const f = fixture({ retireScreen() { screens++; }, retire() { services++; }, dispose() {}, request: async () => null });
  const before = services;
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(screens, 1); assert.equal(services, before);
  f.contents.emit('did-stop-loading');
  assert.equal(screens, 1, 'restoring the document nonce cannot restore a screen session');
  f.owner.dispose();
});
test('native helper failure retires the screen channel before explicit recovery', async () => {
  let screens = 0;
  const f = fixture({ retireScreen() { screens++; }, retire() {}, dispose() {}, request: async () => null });
  await f.call('net_document'); f.helpers[0].hooks.onClosed();
  assert.equal(screens, 1);
  f.helpers[0].hooks.onClosed(); assert.equal(screens, 1);
  await f.call('desktop_recover');
  assert.ok(screens >= 1); assert.equal(f.helpers.length, 2); f.owner.dispose();
});
