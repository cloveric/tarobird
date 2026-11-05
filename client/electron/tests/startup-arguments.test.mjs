import test from 'node:test';
import assert from 'node:assert/strict';
import { validProductionLaunch as valid } from '../startup-arguments.mjs';
test('production accepts only packaged launch and OS activation, not debug/security/profile switches', () => {
  assert.equal(valid(['/App/TaroBot'], true, 'darwin'), true);
  assert.equal(valid(['/App/TaroBot'], false, 'darwin'), false);
  for (const value of ['--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect=9229', '--no-sandbox', '--disable-web-security',
    '--user-data-dir=/tmp/other', '--js-flags=--expose-gc', '--proxy-server=evil', '--tarobot-development=/tmp/x', 'file:///tmp/a', 'https://example.org',
    'tarocub://user@conversation/a', 'tarocub://conversation:22/a']) assert.equal(valid(['/App', value], true, 'darwin'), false, value);
  assert.equal(valid(['/App', '-psn_0_123', 'tarocub://conversation/c1'], true, 'darwin'), true);
  assert.equal(valid(['/App', 'tarocub://notification/open?a=1'], true, 'win32'), true);
  assert.equal(valid(['/App', '--clear-notification-history'], true, 'win32'), true);
  assert.equal(valid(['/App', '--register-notification-shortcut', 'C:\\Start Menu\\TaroBot.lnk'], true, 'win32'), true);
  assert.equal(valid(['/App', '--register-notification-shortcut', 'C:\\x', '--remote-debugging-port=9222'], true, 'win32'), false);
});
