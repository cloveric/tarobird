import test from 'node:test';
import assert from 'node:assert/strict';
import { electronBuildPlan } from '../../scripts/electron-build.mjs';
const base = { out: '/test.noindex/build', cache: '/cache.noindex', targetDir: '/target.noindex' };
test('shipping migration supports both full-Host targets and rejects shell-only architectures', () => {
  assert.equal(electronBuildPlan({ ...base, platform: 'darwin' }, {}).target, 'aarch64-apple-darwin');
  assert.equal(electronBuildPlan({ ...base, platform: 'win32' }, {}).target, 'x86_64-pc-windows-msvc');
  for (const [platform, arch] of [['linux','x64'], ['darwin','x64'], ['win32','arm64']]) assert.throws(() => electronBuildPlan({ ...base, platform, arch }, {}), /Supported desktop/);
});
test('build setup fails before compilation for missing output or production credentials', () => {
  assert.throws(() => electronBuildPlan({ platform: 'darwin' }, {}), /absolute --out/);
  assert.throws(() => electronBuildPlan({ ...base, platform: 'darwin', production: true }, {}));
});
test('production Mac cannot inherit a different updater provider from the shell', () => {
  for (const key of ['TAROBOT_UPDATE_URL', 'TAROCUB_UPDATE_URL']) {
    assert.throws(() => electronBuildPlan({ ...base, platform: 'darwin', production: true }, { [key]: 'https://example.invalid/latest.json' }), /pinned GitHub update channel/);
  }
  assert.equal(electronBuildPlan({ ...base, platform: 'darwin' }, {}).updateProvider, 'none');
});
