import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ENTRY, APP_ORIGIN, trustedSender, validateViewRequest, isEntryURL } from '../contract.mjs';

test('only the owned main frame at the exact trusted entry receives native authority', () => {
  const frame = { url: APP_ENTRY, origin: APP_ORIGIN };
  const contents = { mainFrame: frame, isDestroyed: () => false };
  assert.equal(trustedSender({ sender: contents, senderFrame: frame }, contents), true);
  assert.equal(trustedSender({ sender: {}, senderFrame: frame }, contents), false);
  assert.equal(trustedSender({ sender: contents, senderFrame: { ...frame } }, contents), false);
  for (const url of ['about:blank', 'blob:tarobot://app/id', 'tarobot://widget/index.html', 'tarobot://app/other.html', 'https://app/index.html']) {
    frame.url = url;
    assert.equal(trustedSender({ sender: contents, senderFrame: frame }, contents), false, url);
  }
  frame.url = APP_ENTRY; frame.origin = 'null';
  assert.equal(trustedSender({ sender: contents, senderFrame: frame }, contents), false);
  assert.equal(trustedSender({ sender: contents, senderFrame: null }, contents), false);
});

test('entry rejects credentials, ports and query documents; hash navigation remains valid', () => {
  assert.equal(isEntryURL(APP_ENTRY + '#conversation=abc'), true);
  for (const url of ['tarobot://app:80/index.html', 'tarobot://user@app/index.html', APP_ENTRY + '?route=bad', 'tarobot://app/', 'invalid']) assert.equal(isEntryURL(url), false, url);
});

test('view cannot call process controls, choose native channels or control Host from a secondary view', () => {
  const controller = { controller: true };
  for (const command of ['helper_info', 'net_reset', 'exec', 'readFile']) assert.throws(() => validateViewRequest({ command, args: {} }, controller));
  for (const command of ['device_create', 'device_sign', 'device_forget', 'desktop_host']) assert.throws(() => validateViewRequest({ command, args: {} }), /controller/);
  assert.doesNotThrow(() => validateViewRequest({ command: 'device_create', args: {} }, controller));
  for (const args of [{ channel: 'chosen' }, { events: {} }]) assert.throws(() => validateViewRequest({ command: 'net_socket_open', args, subscription: 1 }, controller));
  for (const subscription of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => validateViewRequest({ command: 'net_socket_open', args: {}, subscription }, controller));
  assert.throws(() => validateViewRequest({ command: 'net_cancel', args: {}, subscription: 1 }, controller));
  assert.throws(() => validateViewRequest({ command: 'net_cancel', args: {}, executable: '/bad' }, controller));
});
