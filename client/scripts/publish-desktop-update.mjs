import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, writeFile, appendFile, lstat, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopUpdateBundle, validateGithubAssetUrl, validateGithubRepository, verifyDesktopUpdateArtifact } from './desktop-update-manifest.mjs';
import { desktopUpdatePlatform } from './desktop-update-platform.mjs';

const execute = promisify(execFile);
async function github(args) {
  try { return (await execute('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (cause) { throw new Error('GitHub release operation failed; inspect the selected release before retrying', { cause }); }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return 'sha256:' + hash.digest('hex');
}

/** Publication is a separate explicit command. No existing release is overwritten. */
export async function publishDesktopUpdate(options, dependencies = {}) {
  const { installer, publicKey, version, commit, outputDir, notes = '', platform = 'windows', extraArtifacts = [] } = options;
  const channel = desktopUpdatePlatform(platform);
  const repository = validateGithubRepository(options.repository);
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('A full verified source commit is required');
  const verifyArtifact = dependencies.verifyArtifact ?? verifyDesktopUpdateArtifact;
  const createBundle = dependencies.createBundle ?? createDesktopUpdateBundle;
  const run = dependencies.run ?? github;
  const verified = await verifyArtifact({ installer, publicKey, version, platform });
  if (!Array.isArray(extraArtifacts) || extraArtifacts.length > 8) throw new Error('Invalid additional release artifacts');
  const names = new Set([path.basename(verified.installerFile), path.basename(verified.signatureFile), channel.manifest, 'SHA256SUMS']);
  for (const file of extraArtifacts) {
    const name = typeof file === 'string' ? path.basename(file) : '';
    if (!name || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || names.has(name) || !(await lstat(file)).isFile()) throw new Error('Expected unique regular additional release artifacts');
    names.add(name);
  }
  const tag = `${channel.prefix}${version}`;
  const api = async endpoint => JSON.parse(await run(['api', endpoint, '--method', 'GET']));
  const repo = await api(`repos/${repository}`);
  if (repo.private !== true || repo.full_name?.toLowerCase() !== repository.toLowerCase() || repo.archived) throw new Error('Desktop updates must stay in the configured private repository');
  let releaseId;
  const releaseInfo = async (draft = true) => {
    const release = await api(`repos/${repository}/releases/${releaseId}`);
    if (release.id !== releaseId || release.tag_name !== tag || release.target_commitish !== commit || release.draft !== draft || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error('Expected the desktop release for the built source commit and publication state');
    return release;
  };
  const verifyExistingTag = async () => {
    const references = await api(`repos/${repository}/git/matching-refs/tags/${tag}`);
    if (!Array.isArray(references)) throw new Error('Invalid release tag response');
    const exact = references.filter(reference => reference.ref === `refs/tags/${tag}`);
    // GitHub does not materialize a new draft's pending tag until publication.
    // An already-existing tag, however, must identify the exact built commit.
    if (!exact.length) return;
    if (exact.length !== 1) throw new Error('Ambiguous release tag');
    let reference = exact[0];
    for (let depth = 0; reference.object?.type === 'tag' && depth < 4; depth++) {
      if (!/^[a-f0-9]{40}$/.test(reference.object.sha)) throw new Error('Invalid release tag object');
      reference = await api(`repos/${repository}/git/tags/${reference.object.sha}`);
    }
    if (reference.object?.type !== 'commit' || reference.object.sha !== commit) throw new Error('Release tag does not identify the built source commit');
  };
  await verifyExistingTag();
  const uploadedAsset = async (release, file) => {
    const matches = release.assets.filter(asset => asset.name === path.basename(file));
    if (matches.length !== 1) throw new Error('Draft release is missing a unique expected asset');
    const asset = matches[0];
    validateGithubAssetUrl(asset.url, repository);
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !asset.url.endsWith('/' + asset.id)
        || asset.size !== (await stat(file)).size || asset.digest !== await digest(file)) throw new Error('Uploaded asset identity, size or SHA-256 does not match the verified local file');
    return asset;
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tarobot-update-notes-'));
  try {
    const metadataFile = path.join(directory, 'release.json');
    await writeFile(metadataFile, JSON.stringify({ tag_name: tag, target_commitish: commit, name: `TaroBird ${version} (${channel.name})`, body: notes, draft: true, prerelease: false, make_latest: 'false' }), { mode: 0o600 });
    const created = JSON.parse(await run(['api', `repos/${repository}/releases`, '--method', 'POST', '--input', metadataFile]));
    if (!Number.isSafeInteger(created.id) || created.id <= 0) throw new Error('Invalid draft release identity');
    releaseId = created.id;
    const upload = file => run(['api', `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(path.basename(file))}`,
      '--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', file]);
    // Bind every mutation to the numeric ID returned by create. Pending draft
    // tags are not unique and cannot safely identify either uploads or publish.
    await upload(verified.installerFile);
    await upload(verified.signatureFile);
    for (const file of extraArtifacts) await upload(file);
    const draft = await releaseInfo();
    const asset = await uploadedAsset(draft, verified.installerFile);
    await uploadedAsset(draft, verified.signatureFile);
    for (const file of extraArtifacts) await uploadedAsset(draft, file);
    const bundle = await createBundle({ installer, publicKey, version, platform, repository, tag, assetUrl: asset.url, outputDir, notes });
    for (const file of extraArtifacts) await appendFile(bundle.checksumFile, `${(await digest(file)).slice(7)}  ${path.basename(file)}\n`);
    await upload(bundle.manifestFile);
    await upload(bundle.checksumFile);
    const complete = await releaseInfo();
    const files = [bundle.installerFile, bundle.signatureFile, bundle.manifestFile, bundle.checksumFile, ...extraArtifacts];
    for (const file of files) await uploadedAsset(complete, file);
    await verifyExistingTag();
    const finalRepo = await api(`repos/${repository}`);
    if (finalRepo.private !== true || finalRepo.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('Update repository privacy changed before publication');
    // Release creation/upload failures leave a draft. Only a complete verified
    // set becomes discoverable; other platform "latest" pointers are untouched.
    const publicationFile = path.join(directory, 'publish.json');
    await writeFile(publicationFile, JSON.stringify({ draft: false, make_latest: 'false' }), { mode: 0o600 });
    await run(['api', `repos/${repository}/releases/${releaseId}`, '--method', 'PATCH', '--input', publicationFile]);
    const published = await releaseInfo(false);
    for (const file of files) await uploadedAsset(published, file);
    return { version, tag, repository, releaseUrl: `https://github.com/${repository}/releases/tag/${tag}` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
