import { build } from '../../node_modules/esbuild/lib/main.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedRoot } from '../electron/isolation.mjs';

export async function buildPreload(directory) {
  const root = await isolatedRoot(directory);
  const outfile = path.join(root, 'preload.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../electron/preload.mjs', import.meta.url))], outfile,
    bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'], sourcemap: false });
  return outfile;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out') throw new Error('usage: node scripts/electron-preload.mjs --out <absolute .noindex directory>');
  console.log(JSON.stringify({ preload: await buildPreload(args[1]) }));
}
