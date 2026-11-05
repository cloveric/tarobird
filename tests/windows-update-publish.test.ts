import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
// @ts-expect-error Plain Node release helper.
import { publishDesktopUpdate } from '../client/scripts/publish-desktop-update.mjs';
// @ts-expect-error Plain Node release helper.
import { publishMacosUpdate } from '../client/scripts/publish-macos-update.mjs';

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture(platform: string, change: { publicRepo?: boolean; badDigest?: boolean; wrongTagCommit?: boolean; failCreate?: boolean; wrongAssetRepo?: boolean; publicationLost?: boolean; extraArtifact?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tarobot-update-publish-')); temporary.push(directory);
  const installer = path.join(directory, platform === 'macos' ? 'TaroBot.app.tar.gz' : 'TaroBot_1.2.3_x64-setup.exe');
  await writeFile(installer, 'MZ disposable signed-payload fixture'); await writeFile(installer + '.sig', 'signature fixture');
  const extraArtifacts = change.extraArtifact ? [path.join(directory, 'tarobot-0.1.1.tgz')] : [];
  for (const file of extraArtifacts) await writeFile(file, 'matching CLI fixture');
  const calls: string[][] = [], commit = 'a'.repeat(40), repository = 'example/private-repo', version = '1.2.3', tag = `${platform}-tarobot-v1.2.3`;
  let published = false;
  let bundle: Record<string, string> | undefined;
  const digest = async (file: string) => 'sha256:' + createHash('sha256').update(await readFile(file)).digest('hex');
  const asset = async (file: string, id: number) => ({ id, name: path.basename(file), size: (await readFile(file)).length, digest: change.badDigest && id === 101 ? 'sha256:' + '0'.repeat(64) : await digest(file), url: `https://api.github.com/repos/${change.wrongAssetRepo ? 'other/repo' : repository}/releases/assets/${id}` });
  const dependencies = {
    verifyArtifact: async () => ({ installerFile: installer, signatureFile: installer + '.sig', version }),
    createBundle: async (input: Record<string, string>) => {
      expect(input.assetUrl).toBe(`https://api.github.com/repos/${repository}/releases/assets/101`);
      expect(input.platform).toBe(platform);
      const manifestFile = path.join(directory, `${platform}-tarobot-latest.json`), checksumFile = path.join(directory, 'SHA256SUMS');
      await writeFile(manifestFile, JSON.stringify({ version, platforms: { [platform === 'macos' ? 'darwin-aarch64' : 'windows-x86_64']: { url: input.assetUrl, signature: 'fixture' } } }));
      await writeFile(checksumFile, 'checksums fixture');
      bundle = { manifestFile, checksumFile, installerFile: installer, signatureFile: installer + '.sig' };
      return bundle;
    },
    run: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === `repos/${repository}`) return JSON.stringify({ full_name: repository, private: !change.publicRepo });
      if (args[0] === 'api' && args[1] === `repos/${repository}/git/matching-refs/tags/${tag}`) return JSON.stringify(change.wrongTagCommit ? [{ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: 'b'.repeat(40) } }] : []);
      // A separate draft may share this pending tag. Publication must never
      // re-resolve it; only the ID returned by the create request is ours.
      if (args[0] === 'release' && args[1] === 'view') return JSON.stringify({ databaseId: 999 });
      if (args[0] === 'api' && args[1] === `repos/${repository}/releases` && args.includes('POST')) {
        if (change.failCreate) throw new Error('existing release');
        const input = JSON.parse(await readFile(args[args.indexOf('--input') + 1]!, 'utf8'));
        expect(input).toMatchObject({ tag_name: tag, target_commitish: commit, name: `TaroBird ${version} (${platform === 'macos' ? 'macOS' : 'Windows'})`, draft: true, make_latest: 'false' });
        return JSON.stringify({ id: 501 });
      }
      if (args[0] === 'api' && args[1] === `repos/${repository}/releases/501`) {
        if (args.includes('PATCH') && !change.publicationLost) published = true;
        const assets = [await asset(installer, 101), await asset(installer + '.sig', 102)];
        if (bundle) assets.push(await asset(bundle.manifestFile!, 103), await asset(bundle.checksumFile!, 104));
        for (const file of extraArtifacts) assets.push(await asset(file, 105));
        return JSON.stringify({ id: 501, tag_name: tag, target_commitish: commit, draft: !published, prerelease: false, assets });
      }
      if (args[0] === 'release' && args[1] === 'create' && change.failCreate) throw new Error('existing release');
      return '';
    },
  };
  return { options: { installer, version, repository, commit, platform, extraArtifacts, outputDir: path.join(directory, 'bundle'), publicKey: 'public fixture key', notes: 'Desktop release notes' }, dependencies, calls, directory };
}

describe.each(['windows', 'macos'])('private %s update publication', platform => {
  it('stages and verifies all private assets before publishing without changing the generic latest release', async () => {
    const value = await fixture(platform);
    await publishDesktopUpdate(value.options, value.dependencies);
    const writes = value.calls.filter(args => args.includes('POST') || args.includes('PATCH'));
    expect(writes).toHaveLength(6);
    expect(writes[0]?.[1]).toBe(`repos/${value.options.repository}/releases`);
    expect(writes.at(-1)?.slice(0, 4)).toEqual(['api', `repos/${value.options.repository}/releases/501`, '--method', 'PATCH']);
    for (const upload of writes.slice(1, -1)) expect(upload[1]).toContain(`/releases/501/assets?name=`);
    expect(value.calls.at(-1)).toEqual(['api', `repos/${value.options.repository}/releases/501`, '--method', 'GET']);
    expect(value.calls.some(args => args[0] === 'release')).toBe(false);
    expect(value.calls.some(args => args[0] === 'api' && args[1]?.includes('/releases/tags/'))).toBe(false);
    expect(value.calls.flat()).not.toContain('--clobber');
  });

  it('verifies installer signatures before making any GitHub request', async () => {
    const value = await fixture(platform); value.dependencies.verifyArtifact = async () => { throw new Error('invalid signature'); };
    await expect(publishDesktopUpdate(value.options, value.dependencies)).rejects.toThrow();
    expect(value.calls).toEqual([]);
  });

  it.each([
    { publicRepo: true }, { badDigest: true }, { wrongTagCommit: true }, { failCreate: true }, { wrongAssetRepo: true },
  ])('does not publish or overwrite an invalid release: %o', async change => {
    const value = await fixture(platform, change);
    await expect(publishDesktopUpdate(value.options, value.dependencies)).rejects.toThrow();
    expect(value.calls.some(args => args.includes('PATCH'))).toBe(false);
    expect(value.calls.flat()).not.toContain('--clobber');
    if (change.publicRepo) expect(value.calls.some(args => args.includes('POST'))).toBe(false);
  });

  it('rejects an unbound source commit before remote writes', async () => {
    const value = await fixture(platform);
    await expect(publishDesktopUpdate({ ...value.options, commit: 'main' }, value.dependencies)).rejects.toThrow();
    expect(value.calls).toEqual([]);
  });
  it('does not claim success without reading back the published release', async () => {
    const value = await fixture(platform, { publicationLost: true });
    await expect(publishDesktopUpdate(value.options, value.dependencies)).rejects.toThrow('publication state');
  });
  it('verifies matching CLI/bootstrap assets before publication and includes their checksums', async () => {
    const value = await fixture(platform, { extraArtifact: true });
    await publishDesktopUpdate(value.options, value.dependencies);
    expect(value.calls.filter(args => args.includes('POST') || args.includes('PATCH'))).toHaveLength(7);
    expect(await readFile(path.join(value.directory, 'SHA256SUMS'), 'utf8')).toContain('  tarobot-0.1.1.tgz\n');
  });
  it('rejects additional files that collide with the updater before any GitHub request', async () => {
    const value = await fixture(platform);
    await expect(publishDesktopUpdate({ ...value.options, extraArtifacts: [value.options.installer] }, value.dependencies)).rejects.toThrow('unique');
    expect(value.calls).toEqual([]);
  });
});


it('Mac publication cleans artifacts only after successful final asset read-back', async () => {
  const value = await fixture('macos');
  let cleaned = 0;
  const result = await publishMacosUpdate(value.options, { ...value.dependencies, cleanupArtifacts: () => {
    expect(value.calls.at(-1)).toEqual(['api', `repos/${value.options.repository}/releases/501`, '--method', 'GET']);
    cleaned++; return { status: 'checked' };
  } });
  expect(cleaned).toBe(1); expect(result.cleanup.status).toBe('checked');
  const failed = await fixture('macos', { publicationLost: true });
  await expect(publishMacosUpdate(failed.options, { ...failed.dependencies, cleanupArtifacts: () => { cleaned++; } })).rejects.toThrow();
  expect(cleaned).toBe(1);
});
