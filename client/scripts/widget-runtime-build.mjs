import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
/** The compiled sources are data in the host chunk. Only the trusted viewer
 * creates a CSP-inheriting opaque blob Worker; no extra network fetch is needed. */
export async function buildWidgetRuntime() {
  const compile = async name => (await build({ entryPoints: [fileURLToPath(new URL(`../src/widget-runtime/${name}.js`, import.meta.url))], bundle: true, write: false, format: 'iife', minify: true, platform: 'browser', target: 'es2022', legalComments: 'inline' })).outputFiles[0].text;
  const [worker, viewer] = await Promise.all([compile('worker'), compile('viewer')]);
  const require = createRequire(import.meta.url);
  const license = await readFile(join(dirname(require.resolve('linkedom/package.json')), 'LICENSE'), 'utf8');
  return { worker: `/*! LinkeDOM ${license.replace(/\*\//g, '* /')} */\n${worker}`, viewer };
}
