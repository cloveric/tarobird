import { extractFile, listPackage } from '@electron/asar';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
export async function verifyElectronShell({ resources, frontend, version, commit }) {
  const archive = path.join(resources, 'app.asar');
  const pkg = JSON.parse(extractFile(archive, 'package.json'));
  const metadata = JSON.parse(extractFile(archive, 'desktop.json'));
  if (pkg.version !== version || pkg.main !== 'main.mjs' || metadata.format !== 1 || !['production', 'development'].includes(metadata.mode)) throw new Error('Packaged Electron version or metadata differs');
  if (commit && (metadata.sourceCommit !== commit || metadata.dirty || metadata.mode !== 'production')) throw new Error('Packaged Electron source does not match the clean production commit');
  const files = [];
  const walk = async relative => {
    for (const entry of await readdir(path.join(frontend, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative.split(path.sep).join('/'), entry.name);
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error('Unexpected non-file frontend entry');
    }
  };
  await walk('');
  const shipped = listPackage(archive).map(name => name.replaceAll('\\', '/')).filter(name => name.startsWith('/dist/'));
  const shippedFiles = shipped.filter(name => !shipped.some(other => other.startsWith(`${name}/`))).map(name => name.slice(6)).sort();
  if (JSON.stringify(shippedFiles) !== JSON.stringify(files.sort())) throw new Error('Electron frontend inventory differs');
  for (const file of files) if (!extractFile(archive, `dist/${file}`).equals(await readFile(path.join(frontend, file)))) throw new Error(`Electron frontend bytes differ: ${file}`);
  for (const entry of ['main.mjs', 'preload.cjs']) if (!extractFile(archive, entry).length) throw new Error('Electron bootstrap missing');
  return { version, sourceCommit: metadata.sourceCommit, mode: metadata.mode, files: files.length, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex') };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { resources: { type: 'string' }, frontend: { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' } } });
  verifyElectronShell(values).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
