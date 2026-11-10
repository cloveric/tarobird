import test from 'node:test';
import assert from 'node:assert/strict';
import { DESKTOP_RUST_CRATES, electronBuildPlan, rustBuildCommand } from '../../scripts/electron-build.mjs';
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
test('Mac Rust crates link unstripped and are stripped by Apple strip -x (#15)', () => {
  const plan = electronBuildPlan({ ...base, platform: 'darwin' }, {});
  assert.deepEqual(plan.strip, { command: '/usr/bin/strip', args: ['-x'] });
  assert.deepEqual(DESKTOP_RUST_CRATES.map(([kind]) => kind), ['core', 'native', 'updater', 'exporter']);
  // An inherited strip setting cannot re-enable rustc's stripping on Mac.
  for (const buildEnv of [{ PATH: '/usr/bin' }, { PATH: '/usr/bin', CARGO_PROFILE_RELEASE_STRIP: 'true' }]) {
    for (const crate of DESKTOP_RUST_CRATES) {
      const command = rustBuildCommand(plan, crate, { targetDir: '/target.noindex', buildEnv, version: '9.9.9', hostPlatform: 'darwin' });
      assert.deepEqual(command.args, ['build', '--release', '--locked', '--target', 'aarch64-apple-darwin', ...crate[2]]);
      assert.equal(command.env.CARGO_PROFILE_RELEASE_STRIP, 'false');
      assert.equal(command.env.CARGO_TARGET_DIR, `/target.noindex/${crate[0]}.noindex`);
      assert.equal(command.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS, undefined);
    }
  }
});
test('Windows Rust builds keep their previous command, environment and Cargo strip profile', () => {
  const plan = electronBuildPlan({ ...base, platform: 'win32' }, {});
  assert.equal(plan.strip, null);
  const buildEnv = { PATH: '/usr/bin' };
  for (const crate of DESKTOP_RUST_CRATES) {
    for (const hostPlatform of ['darwin', 'win32']) {
      const command = rustBuildCommand(plan, crate, { targetDir: '/target.noindex', buildEnv, version: '9.9.9', hostPlatform });
      assert.deepEqual(command.args, [...(hostPlatform === 'win32' ? [] : ['xwin']), 'build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc', ...crate[2]]);
      assert.deepEqual(command.env, { PATH: '/usr/bin', CARGO_TARGET_DIR: `/target.noindex/${crate[0]}.noindex`, CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: '-C target-feature=+crt-static',
        ...(crate[0] === 'exporter' ? { TAURI_CONFIG: JSON.stringify({ version: '9.9.9', build: { windows: { staticVCRuntime: false } }, bundle: { resources: null } }) } : {}) });
    }
  }
  // Windows does not override an inherited strip profile either way.
  assert.equal(rustBuildCommand(plan, DESKTOP_RUST_CRATES[1], { targetDir: '/target.noindex', buildEnv: { CARGO_PROFILE_RELEASE_STRIP: 'true' }, version: '9.9.9' }).env.CARGO_PROFILE_RELEASE_STRIP, 'true');
});
