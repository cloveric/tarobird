import test from 'node:test';
import assert from 'node:assert/strict';
import { installExternalLinks } from '../external-links.mjs';
test('trusted anchor clicks and middle clicks open externally; scripts, downloads and local paths do not', async () => {
  const listeners = new Map(), opened = [];
  installExternalLinks((name, fn) => listeners.set(name, fn), url => opened.push(url));
  const click = (href, extra = {}) => {
    let prevented = false;
    const event = { type: 'click', button: 0, isTrusted: true, defaultPrevented: false,
      target: { closest: () => ({ href, hasAttribute: () => false }) }, preventDefault: () => { prevented = true; }, ...extra };
    listeners.get(event.type)(event); return prevented;
  };
  assert.equal(click('https://example.org/'), true);
  assert.equal(click('mailto:person@example.org', { type: 'auxclick', button: 1 }), true);
  for (const href of ['file:///tmp/a', 'javascript:alert(1)', 'https://user:secret@example.org', 'tarobot://app/index.html']) assert.equal(click(href), false);
  for (const extra of [{ isTrusted: false }, { defaultPrevented: true }, { button: 2 }, { target: { closest: () => ({ href: 'https://example.org', hasAttribute: () => true }) } }]) assert.equal(click('https://example.org/', extra), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, ['https://example.org/', 'mailto:person@example.org']);
});
