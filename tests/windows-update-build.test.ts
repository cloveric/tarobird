import { describe, expect, it } from 'vitest';
// @ts-expect-error Build helper is plain Node ESM.
import { windowsBuildPlan } from '../client/scripts/windows-build-plan.mjs';

const pubkey = Buffer.from(`untrusted comment: disposable test key\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 1)]).toString('base64')}\n`).toString('base64');
const signing = {
  TAROBOT_GITHUB_REPOSITORY: 'example/private-tarobot',
  TAROBOT_GITHUB_CLIENT_ID: 'Iv1.0123456789abcdef',
  TAROBOT_UPDATE_PUBLIC_KEY: pubkey,
  TAURI_SIGNING_PRIVATE_KEY: 'PRIVATE_SIGNING_KEY_MUST_NOT_BE_EMBEDDED',
};

describe('Windows updater build mode', () => {
  it('keeps ordinary developer builds unsigned with no update configuration', () => {
    const plan = windowsBuildPlan({}, signing);
    expect(plan.args).toContain('--no-sign');
    expect(plan.updateConfig).toBeUndefined();
    expect(() => windowsBuildPlan({ arch: 'arm64' }, signing)).toThrow();
  });

  it('embeds the private GitHub provider and pinned key only in explicit signed mode', () => {
    const plan = windowsBuildPlan({ signedUpdates: true }, signing);
    expect(plan.args).not.toContain('--no-sign');
    expect(plan.updateConfig).toMatchObject({
      bundle: { createUpdaterArtifacts: true },
      plugins: {
        updater: { pubkey, requireSignedVersion: true, allowDowngrades: false, windows: { installMode: 'passive' } },
        'github-updates': { repository: signing.TAROBOT_GITHUB_REPOSITORY, clientId: signing.TAROBOT_GITHUB_CLIENT_ID },
      },
    });
    expect(JSON.stringify(plan)).not.toContain(signing.TAURI_SIGNING_PRIVATE_KEY);
  });

  it('marks the public release repository so updates need no GitHub sign-in, unless a fork opts out', () => {
    expect(windowsBuildPlan({ signedUpdates: true }, signing).updateConfig.plugins['github-updates'].public).toBe(true);
    expect(windowsBuildPlan({ signedUpdates: true }, { ...signing, TAROBOT_GITHUB_PRIVATE: 'true' }).updateConfig.plugins['github-updates']).not.toHaveProperty('public');
  });

  it.each(Object.keys(signing))('fails before building when signed mode lacks %s', name => {
    const env = { ...signing, [name]: '' };
    expect(() => windowsBuildPlan({ signedUpdates: true }, env)).toThrow();
  });

  it('matches the native GitHub client ID limit before packaging', () => {
    const plan = windowsBuildPlan({ signedUpdates: true }, { ...signing, TAROBOT_GITHUB_CLIENT_ID: 'a'.repeat(100) });
    expect(plan.updateConfig.plugins['github-updates'].clientId).toHaveLength(100);
    for (const length of [101, 128]) {
      expect(() => windowsBuildPlan({ signedUpdates: true }, { ...signing, TAROBOT_GITHUB_CLIENT_ID: 'a'.repeat(length) })).toThrow('TAROBOT_GITHUB_CLIENT_ID');
    }
  });

  it.each(['https://github.com/example/repo', 'example/repo?token=secret', '../repo', 'example/repo/extra'])('rejects unsafe repository input %s', repository => {
    expect(() => windowsBuildPlan({ signedUpdates: true }, { ...signing, TAROBOT_GITHUB_REPOSITORY: repository })).toThrow();
  });
});
