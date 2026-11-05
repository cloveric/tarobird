import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('sharing badge updates names, control and language on same-document navigation', () => {
  const nodes = { label: { textContent: '' }, clock: { textContent: '' } }, listeners = {}, timers = [];
  const location = { hash: '#lang=en&names=first&control=0&since=1000' };
  vm.runInNewContext(readFileSync(new URL('../screen-indicator-page.js', import.meta.url), 'utf8'), {
    document: { getElementById: id => nodes[id] }, location, URLSearchParams, Date: { now: () => 62000 },
    addEventListener: (type, listener) => { listeners[type] = listener; }, setInterval: callback => timers.push(callback),
  });
  assert.equal(nodes.label.textContent, 'Sharing screen · first');
  assert.equal(nodes.clock.textContent, '01:01');
  location.hash = '#lang=en&names=second%0A%3Cb%3Ethird%3C%2Fb%3E&control=1&since=1000';
  listeners.hashchange();
  assert.equal(nodes.label.textContent, 'Sharing screen · second, <b>third</b> · controlling');
  location.hash = '#lang=zh&names=second&control=0&since=1000'; listeners.hashchange();
  assert.equal(nodes.label.textContent, '正在共享屏幕 · second');
  assert.equal(timers.length, 1);
});
