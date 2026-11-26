import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryFile = path.join(repoRoot, 'integrations/infinite-canvas/src/main.tsx');
const outDir = path.join(repoRoot, 'dist/plugins/tarobird.infinite-canvas/1.0.0');
const clientNodeModules = path.join(repoRoot, 'client/node_modules');

export async function buildInfiniteCanvasPlugin() {
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    nodePaths: [clientNodeModules],
    outdir: 'out',
    write: false,
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  const jsFile = result.outputFiles.find((f) => f.path.endsWith('.js'));
  const cssFile = result.outputFiles.find((f) => f.path.endsWith('.css'));
  if (!jsFile) throw new Error('infinite_canvas_build_missing_js');

  const safeJs = jsFile.text.replace(/<\/script/gi, '<\\/script');
  const safeCss = (cssFile?.text ?? '').replace(/<\/style/gi, '<\\/style');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Infinite Canvas — basketikun (MIT)</title>
<style>${safeCss}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
</body>
</html>
`;

  const bytes = Buffer.from(html, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sizeBytes = bytes.byteLength;

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'bundle.html'), bytes);

  const upstream = JSON.parse(await readFile(path.join(repoRoot, 'integrations/infinite-canvas/UPSTREAM.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1,
    id: 'tarobird.infinite-canvas',
    name: 'Infinite Canvas',
    nameZh: '无限画布',
    version: '1.0.0',
    description: 'Full Infinite Canvas workbench (canvas, image/video create, prompts, assets, bundled node plugins, and TaroBird Bot Canvas Agent).',
    descriptionZh: '完整无限画布工作台（画布编排、生图/生视频、提示词库、素材库、内置官方节点插件与对话 Bot Agent 联动）。',
    icon: 'canvas',
    source: { repository: 'basketikun/infinite-canvas', commit: upstream.commit },
    artifact: {
      sha256,
      sizeBytes,
      url: '/api/plugins/artifacts/tarobird.infinite-canvas/1.0.0/bundle.html',
    },
    attribution: {
      author: upstream.author,
      license: upstream.license,
      homepage: upstream.repository,
      notice: 'MIT License — Copyright (c) 2026 basketikun',
    },
    entry: 'dist/index.html',
    platforms: ['desktop'],
    contributions: [
      { kind: 'workbench-item', id: 'infinite-canvas', title: 'Infinite Canvas', titleZh: '无限画布', icon: 'canvas' },
    ],
    domains: ['api.openai.com', 'generativelanguage.googleapis.com', 'raw.githubusercontent.com'],
    capabilities: ['theme.read', 'storage.device', 'clipboard.write', 'workbench.canvas', 'canvas.agent'],
    requiresHost: true,
    official: true,
  };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { sha256, sizeBytes, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const info = await buildInfiniteCanvasPlugin();
  console.log(JSON.stringify(info));
}
