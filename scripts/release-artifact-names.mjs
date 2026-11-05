import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function releaseArtifactNames(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) throw new Error('A stable product version is required');
  return {
    macos: `TaroBird_${version}_aarch64.dmg`,
    macosUpdate: 'TaroBird.app.tar.gz',
    windows: `TaroBird_${version}_x64-setup.exe`,
    android: `TaroBird_${version}_android.apk`,
    ios: `TaroBird_${version}.ipa`,
    cli: `tarobird-${version}.tgz`,
  };
}

/** Standardize exported APK/IPA/npm filenames without changing signed bytes or
 * the retained npm package identity used by existing CLI upgrade readers. */
export async function stageNamedReleaseArtifact({ kind, version, source, output }) {
  const names = releaseArtifactNames(version);
  if (!['android', 'ios', 'cli'].includes(kind)) throw new Error('Expected android, ios or cli artifact');
  if (!path.isAbsolute(source ?? '') || !path.isAbsolute(output ?? '')) throw new Error('Absolute source and output paths are required');
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || !source.endsWith(path.extname(names[kind]))) throw new Error('Expected a regular artifact with the matching extension');
  const destination = path.join(output, names[kind]);
  if (path.resolve(source) === path.resolve(destination)) throw new Error('Use a separate output directory');
  const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const sha256 = await hash(source);
  await mkdir(output, { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (await hash(destination) !== sha256) throw new Error('Artifact bytes changed during staging');
  return { file: destination, sha256, bytes: info.size };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: Object.fromEntries(['kind', 'version', 'source', 'output'].map(name => [name, { type: 'string' }])) });
  stageNamedReleaseArtifact(values).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
