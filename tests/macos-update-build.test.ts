import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Build helpers are plain Node ESM.
import { macosBuildPlan } from '../client/scripts/macos-build-plan.mjs';
const pubkey = Buffer.from(`untrusted comment: disposable test key\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 1)]).toString('base64')}\n`).toString('base64');
const signing = { TAROBOT_GITHUB_REPOSITORY: 'example/private-tarobot', TAROBOT_GITHUB_CLIENT_ID: 'Iv1.0123456789abcdef', TAROBOT_UPDATE_PUBLIC_KEY: pubkey, TAURI_SIGNING_PRIVATE_KEY: 'PRIVATE_KEY_NOT_FOR_THE_APP' };
describe('macOS updater build', () => {
  it('requires a pinned signed private update channel by default', () => {
    const plan = macosBuildPlan({}, signing);
    expect(plan.args).not.toContain('--no-sign');
    expect(plan.target).toBe('aarch64-apple-darwin');
    expect(plan.updateConfig).toMatchObject({ bundle: { createUpdaterArtifacts: true, macOS: { signingIdentity: '-' } }, plugins: { updater: { pubkey, requireSignedVersion: true, allowDowngrades: false }, 'github-updates': { repository: signing.TAROBOT_GITHUB_REPOSITORY, clientId: signing.TAROBOT_GITHUB_CLIENT_ID } } });
    expect(JSON.stringify(plan)).not.toContain(signing.TAURI_SIGNING_PRIVATE_KEY);
  });
  it.each(Object.keys(signing))('fails before building without %s', name => {
    expect(() => macosBuildPlan({}, { ...signing, [name]: '' })).toThrow();
  });
  it('allows explicit development builds but never publishes an unverified architecture', () => {
    expect(macosBuildPlan({ signedUpdates: false }, {}).args).toContain('--no-sign');
    expect(() => macosBuildPlan({ arch: 'x64' }, signing)).toThrow();
  });
});

// The migrated entrypoints must strip signing credentials before all build
// preparation commands. Stop at the last preparation child: no actual build,
// signing, package copy or network request runs in this fixture.
it.each([['macos', true], ['windows', true], ['macos', false], ['windows', false]] as const)('keeps %s preparation free of signing secrets (signed=%s)', (platform, signed) => {
  if (platform === 'macos' && process.platform !== 'darwin') return;
  const script = `
    import child from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { mkdtemp, rm } from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const root = await mkdtemp(path.join(os.tmpdir(), 'electron-preparation-'));
    const isolated = path.join(root, 'build.noindex');
    const calls = [];
    child.spawn = (_bin, args, options) => {
      const env = options.env;
      calls.push({ args, key: env.TAURI_SIGNING_PRIVATE_KEY, keyPath: env.TAURI_SIGNING_PRIVATE_KEY_PATH, password: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, apple: env.APPLE_API_KEY });
      if (calls.length === 4) throw new Error('FIXTURE_PREPARATION_COMPLETE');
      const emitter = new EventEmitter(); queueMicrotask(() => emitter.emit('exit', 0)); return emitter;
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, 'build.mjs', ...${JSON.stringify(signed ? ['--development', '--signed-updates'] : ['--unsigned-development'])}, '--out', path.join(isolated,'out'), '--cache', path.join(isolated,'cache'), '--targetDir', path.join(isolated,'target')];
    try { await import(${JSON.stringify(new URL(`../client/scripts/${platform}-build.mjs`, import.meta.url).href)}); throw new Error('did not reach preparation'); }
    catch (error) { if (error.message !== 'FIXTURE_PREPARATION_COMPLETE') throw error; }
    finally { await rm(root, { recursive: true, force: true }); }
    console.log(JSON.stringify(calls));
  `;
  const calls = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    env: { ...process.env, ...signing, TAROBOT_UPDATE_URL: '', TAROCUB_UPDATE_URL: '', npm_execpath: '/fixture/npm.mjs', TAURI_SIGNING_PRIVATE_KEY: 'fixture-key', TAURI_SIGNING_PRIVATE_KEY_PATH: '/fixture/key', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'fixture-password', APPLE_API_KEY: 'fixture-api-key' }, encoding: 'utf8',
  }));
  expect(calls).toHaveLength(4);
  expect(calls.map((call: { key?: string; keyPath?: string; password?: string; apple?: string }) => [call.key, call.keyPath, call.password, call.apple])).toEqual(Array.from({ length: 4 }, () => [undefined, undefined, undefined, undefined]));
  expect(calls[0].args).toContain('scripts/build-standalone.mjs');
  expect(calls[2].args).toContain('scripts/prepare-desktop-host.mjs');
  expect(calls[3].args).toContain('scripts/build-migration-exporter.mjs');
});
