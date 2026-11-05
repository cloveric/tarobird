import { retiredTransportPath, checkRetiredTransportSources } from './retired-transport-guard.mjs';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/index.ts', 'src/codex/claude-permission-mcp-server.ts', 'src/codex/deepseek-app-plugin.ts'], outdir: 'standalone-graph', bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true, logLevel: 'silent' });
// Runtime and TypeScript/test imports must both stay independent.
const forbidden = Object.keys(result.metafile.inputs).filter(retiredTransportPath);
const externals = Object.values(result.metafile.outputs).flatMap(o => o.imports).filter(i => i.path.includes('larksuite'));
// Shared collaboration must not regain Telegram delivery/formatting defaults.
// No retired transport entrypoints are shipped.
const busOwners = /^src\/core\/(?:bus|delivery|shared\/(?:board-commands|board-plan|crew-workflow|delegation-commands|mini-bus-commands|turn-bookkeeping|command-reply))\.ts$/;
const busTransportImports = Object.entries(result.metafile.inputs).filter(([p]) => busOwners.test(p))
  .flatMap(([p, input]) => input.imports.filter(i => /(?:^|\/)src\/telegram\//.test(i.path)).map(i => `${p} -> ${i.path}`));
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (forbidden.length || externals.length || busTransportImports.length || manifest.dependencies?.['@larksuiteoapi/node-sdk'] || manifest.scripts?.postinstall?.includes('lark')) throw new Error(`Standalone boundary violated: ${JSON.stringify({ forbidden, externals, busTransportImports })}`);
await checkRetiredTransportSources();
await mkdir('dist', { recursive: true });
await writeFile('dist/standalone-graph.json', JSON.stringify(result.metafile, null, 2));
console.log(`Standalone graph: ${Object.keys(result.metafile.inputs).length} modules; no legacy transport or Feishu SDK.`);
