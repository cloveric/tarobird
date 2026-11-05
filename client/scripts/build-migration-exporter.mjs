import { build } from 'esbuild';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const client = fileURLToPath(new URL('..', import.meta.url));
const dist = path.resolve(client, '../.desktop-migration-exporter-dist');
// This exact generated directory contains only bundled reader assets.
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({ entryPoints: [path.join(client, 'src/desktop-migration-reader.ts')], bundle: true, outfile: path.join(dist, 'reader.js'),
  format: 'esm', platform: 'browser', target: 'safari17' });
await writeFile(path.join(dist, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>TaroBot</title>
<style>body{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:40px;color:#252525;background:#f6f5f3}p{line-height:1.6}small{color:#666}</style>
</head><body><p role="status">正在保留旧版桌面数据…<br>Preparing your desktop data…</p><small>聊天记录、配对与草稿会保留。</small><script type="module" src="/reader.js"></script></body></html>`);

if (JSON.stringify((await readdir(dist)).sort()) !== JSON.stringify(['index.html', 'reader.js'])) throw new Error('Unexpected migration reader assets');
