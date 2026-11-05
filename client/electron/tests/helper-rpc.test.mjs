import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeHelper, JsonLines, helperEnvironment, helperArguments } from '../helper-rpc.mjs';
import { MAX_PENDING } from '../contract.mjs';

const config = { executable: '/isolated/helper', stateDir: '/isolated/state', resourcesDir: '/isolated/resources', hostStateDir: '/isolated/com.tarobot.client', keyringService: 'com.tarobot.test' };
function fixture(options = {}) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; this.emit('close', null); } });
  const requests = [], events = [], closed = [];
  const input = new JsonLines(value => requests.push(value));
  child.stdin.on('data', data => input.push(data));
  const helper = new NativeHelper(config, { spawnProcess: (file, args, options) => {
    assert.equal(file, config.executable); assert.equal(options.shell, false); assert.deepEqual(args, helperArguments(config)); return child;
  }, onEvent: value => events.push(value), onClosed: reason => closed.push(reason), shutdownMs: 5, ...options });
  return { helper, child, requests, events, closed, reply(value) { child.stdout.write(JSON.stringify(value) + '\n'); } };
}

test('JSONL handles arbitrary UTF-8 boundaries and several responses in one read', () => {
  const values = [], decoder = new JsonLines(value => values.push(value));
  const bytes = Buffer.from('{"text":"中文🌿"}\n{"id":2}\n');
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.finish();
  assert.deepEqual(values, [{ text: '中文🌿' }, { id: 2 }]);
});
test('JSONL rejects an unterminated oversized line, invalid UTF-8, noise and truncated output', () => {
  assert.throws(() => new JsonLines(() => {}, 3).push(Buffer.from('xxxx')), /too_large/);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from([0xff, 10])), /invalid/);
  assert.throws(() => new JsonLines(() => {}).push(Buffer.from('debug log\n')), /invalid/);
  const decoder = new JsonLines(() => {}); decoder.push(Buffer.from('{"id":')); assert.throws(() => decoder.finish(), /truncated/);
});
test('process launch strips code injection variables without dropping ordinary inherited settings', () => {
  assert.deepEqual(helperEnvironment({ PATH: '/bin', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require bad', NODE_PATH: '/bad', ELECTRON_RUN_AS_NODE: '1', DYLD_INSERT_LIBRARIES: 'bad', LD_PRELOAD: 'bad', empty: undefined }), { PATH: '/bin', HTTPS_PROXY: 'http://proxy' });
  assert.throws(() => helperArguments({ ...config, executable: 'relative' }));
  assert.throws(() => helperArguments({ ...config, keyringService: 'bad/service' }));
});
test('concurrent replies are matched by generated IDs and native errors retain their exact code', async () => {
  const f = fixture();
  const a = f.helper.call('net_document'), b = f.helper.call('device_sign', {});
  const failure = assert.rejects(b, { message: 'device_key_unavailable' });
  f.reply({ id: f.requests[1].id, error: { code: 'device_key_unavailable', message: 'ignored details' } });
  f.reply({ id: f.requests[0].id, result: 'lease' });
  assert.equal(await a, 'lease'); await failure;
  f.helper.close();
});
test('valid transport events are separate from pending RPC replies', async () => {
  const f = fixture(); const pending = f.helper.call('net_document');
  const event = { event: 'transport', document: 'doc', channel: 'chan', payload: { kind: 'open' } };
  f.reply(event); f.reply({ id: f.requests[0].id, result: 'doc' });
  assert.equal(await pending, 'doc'); assert.deepEqual(f.events, [event]); f.helper.close();
});
test('unknown or duplicate reply ID retires the helper and rejects outstanding work', async () => {
  const f = fixture(); const pending = f.helper.call('net_document');
  const failure = assert.rejects(pending, /invalid_native_response/);
  f.reply({ id: 99999, result: 'unexpected' }); await failure;
  assert.equal(f.helper.closed, true); assert.equal(f.closed.length, 1);
  await assert.rejects(f.helper.call('net_document'), /unavailable/);
});
test('malformed error envelope cannot make a request hang after its timer is removed', async () => {
  const f = fixture(); const pending = f.helper.call('net_document');
  const failure = assert.rejects(pending, /invalid_native_response/);
  f.reply({ id: f.requests[0].id, error: {} }); await failure;
});
test('retiring a document rejects pending calls immediately and kills a child ignoring EOF', async () => {
  const f = fixture(); const pending = f.helper.call('net_http_read', { id: 'request' });
  const failure = assert.rejects(pending, /native_document_retired/);
  f.helper.close(); await failure; assert.equal(f.child.killed, false);
  await delay(15); assert.equal(f.child.killed, true); assert.equal(f.closed.length, 1);
});
test('a timed-out HTTP slot is cancelled without breaking other calls or accepting its late response', async () => {
  const f = fixture();
  const a = assert.rejects(f.helper.call('net_http_open', { id: 'slow' }, 5), /native_request_timeout/);
  const b = f.helper.call('net_document');
  await delay(15); await a;
  assert.equal(f.requests[2].command, 'net_cancel'); assert.deepEqual(f.requests[2].args, { id: 'slow' });
  f.reply({ id: f.requests[2].id, result: null });
  f.reply({ id: f.requests[0].id, result: 'late body' });
  f.reply({ id: f.requests[1].id, result: 'healthy document' });
  assert.equal(await b, 'healthy document'); assert.equal(f.helper.closed, false); f.helper.close();
});
test('an unresponsive process-level command retires the failed helper', async () => {
  const f = fixture();
  const a = assert.rejects(f.helper.call('net_document', {}, 5), /native_request_timeout/);
  const b = assert.rejects(f.helper.call('device_create'), /native_helper_timeout/);
  await delay(15); await Promise.all([a, b]); assert.equal(f.helper.closed, true);
});
test('in-flight calls are bounded and process-only commands do not include arbitrary exec', async () => {
  const f = fixture(); const pending = [];
  for (let i = 0; i < MAX_PENDING; i++) pending.push(assert.rejects(f.helper.call('net_document'), /native_document_retired/));
  await assert.rejects(f.helper.call('net_document'), /busy/);
  await assert.rejects(f.helper.call('exec'), /invalid_native_request/);
  f.helper.close(); await Promise.all(pending);
});
test('handshake refuses a mismatched helper protocol', async () => {
  const f = fixture(); const ready = f.helper.ready(); const failure = assert.rejects(ready, /native_protocol_mismatch/);
  assert.equal(f.requests[0].command, 'helper_info'); f.reply({ id: f.requests[0].id, result: { protocol: 2 } }); await failure;
});
test('retirement immediately rejects renderer work but grants an in-flight Host action its bounded graceful period', async () => {
  const f = fixture({ hostShutdownMs: 40, shutdownMs: 5 });
  const failure = assert.rejects(f.helper.call('desktop_host', { action: 'resume' }), /native_document_retired/);
  f.helper.close(); await failure; await delay(10);
  assert.equal(f.child.killed, false); await delay(50); assert.equal(f.child.killed, true);
});
test('helper death terminates its dedicated process group exactly once', async () => {
  const groups = []; const f = fixture({ killGroup: pid => groups.push(pid) });
  f.child.pid = 2147483647;
  f.child.emit('close', 1); assert.deepEqual(groups, [2147483647]);
  f.helper.close(); await delay(10); assert.deepEqual(groups, [2147483647]);
});


test('read-only Host status does not retain a dead renderer helper for the mutation grace period', async () => {
  const f = fixture({ hostShutdownMs: 1000, shutdownMs: 5 });
  const failed = assert.rejects(f.helper.call('desktop_host', { action: 'status' }), /native_document_retired/);
  f.helper.close(); await failed; await delay(20); assert.equal(f.child.killed, true);
});
test('helper death preserves an in-flight Host reconciliation until its bounded grace expires', async () => {
  const groups = [], f = fixture({ hostShutdownMs: 45, killGroup: pid => groups.push(pid) });
  f.child.pid = 2147483647;
  const rejected = assert.rejects(f.helper.call('desktop_host', { action: 'resume' }), /native_helper_exited/);
  f.child.emit('close', 1); await rejected;
  assert.deepEqual(groups, []); await delay(15); assert.deepEqual(groups, []);
  await delay(50); assert.deepEqual(groups, [2147483647]);
});
test('a recycled leader PID cannot receive the delayed group kill', async () => {
  const groups = [], f = fixture({ hostShutdownMs: 5, killGroup: pid => groups.push(pid) });
  f.child.pid = process.pid;
  const rejected = assert.rejects(f.helper.call('desktop_host', { action: 'resume' }), /native_helper_exited/);
  f.child.emit('close', 1); await rejected; await delay(15); assert.deepEqual(groups, []);
});
