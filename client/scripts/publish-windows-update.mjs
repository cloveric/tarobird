import { parseArgs } from 'node:util';
import { readUpdateNotes } from './desktop-update-manifest.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishDesktopUpdate } from './publish-desktop-update.mjs';
export const publishWindowsUpdate = (options, dependencies) => publishDesktopUpdate({ ...options, platform: 'windows' }, dependencies);

async function main() {
  const { values } = parseArgs({ options: {
    installer: { type: 'string' }, repository: { type: 'string' }, version: { type: 'string' },
    commit: { type: 'string' }, output: { type: 'string' }, 'notes-file': { type: 'string' },
    file: { type: 'string', multiple: true },
  } });
  for (const option of ['installer', 'repository', 'version', 'commit', 'output']) if (!values[option]) throw new Error(`--${option} is required`);
  const notes = values['notes-file'] ? await readUpdateNotes(values['notes-file']) : `TaroBird ${values.version} Windows update.`;
  const result = await publishWindowsUpdate({ ...values, extraArtifacts: values.file ?? [], outputDir: values.output, publicKey: process.env.TAROBOT_UPDATE_PUBLIC_KEY ?? process.env.TAROCUB_UPDATE_PUBLIC_KEY ?? '', notes });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
