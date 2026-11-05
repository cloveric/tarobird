import test from 'node:test';
import assert from 'node:assert/strict';
import { ELECTRON_RIGHTS, electronSigningRole, credentialCodeIdentifier } from '../../scripts/electron-signing-policy.mjs';
test('foreign addon permission belongs only to the independent Host Node', () => {
  const app = '/lab.noindex/TaroBot.app';
  const targets = [app, `${app}/Contents/Resources/host/node`, `${app}/Contents/Resources/host/node_modules/canvas.node`,
    `${app}/Contents/Resources/native/tarobot-desktop-native.node`, `${app}/Contents/Resources/native/tarobot-desktop-core`,
    `${app}/Contents/Frameworks/TaroBot Helper (Renderer).app`, `${app}/Contents/Frameworks/TaroBot Helper (Renderer).app/Contents/MacOS/TaroBot Helper (Renderer)`];
  const roles = targets.map(file => electronSigningRole(app, file));
  assert.deepEqual(roles, ['app', 'host', 'native', 'native', 'native', 'chromium', 'chromium']);
  assert.deepEqual(targets.filter((_, i) => ELECTRON_RIGHTS[roles[i]].includes('com.apple.security.cs.disable-library-validation')), [targets[1]]);
  assert.throws(() => electronSigningRole(app, '/Applications/Other.app'), /outside/);
});
test('only developer-signed credential readers preserve the legacy designated identifier', () => {
  const app = '/lab.noindex/TaroBot.app', core = `${app}/Contents/Resources/native/tarobot-desktop-core`;
  assert.equal(credentialCodeIdentifier(app, core, true), 'com.tarobot.client');
  assert.equal(credentialCodeIdentifier(app, core, false), undefined);
  assert.equal(credentialCodeIdentifier(app, `${app}/Contents/Resources/host/node`, true), undefined);
});

test('renamed TaroBird helpers retain their exact Chromium and capture entitlements', () => {
  const app = '/lab.noindex/TaroBird.app';
  assert.equal(electronSigningRole(app, `${app}/Contents/Frameworks/TaroBird Helper.app`), 'chromiumMedia');
  assert.equal(electronSigningRole(app, `${app}/Contents/Frameworks/TaroBird Helper.app/Contents/MacOS/TaroBird Helper`), 'chromiumMedia');
  for (const helper of ['Renderer', 'GPU', 'Plugin']) {
    const bundle = `${app}/Contents/Frameworks/TaroBird Helper (${helper}).app`;
    assert.equal(electronSigningRole(app, bundle), 'chromium');
    assert.equal(electronSigningRole(app, `${bundle}/Contents/MacOS/TaroBird Helper (${helper})`), 'chromium');
  }
  assert.equal(credentialCodeIdentifier(app, `${app}/Contents/Resources/native/tarobot-desktop-core`, true), 'com.tarobot.client');
});

test('only the main executable and generic capture helper receive camera and microphone rights', () => {
  const app = '/lab.noindex/TaroBot.app';
  for (const file of ['', '/Contents/MacOS/tarocub-client', '/Contents/Frameworks/TaroBot Helper.app', '/Contents/Frameworks/TaroBot Helper.app/Contents/MacOS/TaroBot Helper']) {
    const rights = ELECTRON_RIGHTS[electronSigningRole(app, app + file)];
    assert.ok(rights.includes('com.apple.security.device.audio-input')); assert.ok(rights.includes('com.apple.security.device.camera'));
    assert.equal(rights.includes('com.apple.security.cs.disable-library-validation'), false);
  }
  for (const role of ['chromium', 'native', 'host']) assert.equal(ELECTRON_RIGHTS[role].some(right => /device\.(audio-input|camera)$/.test(right)), false);
});
