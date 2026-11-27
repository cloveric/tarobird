import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function buildUpstreamEditor(sourceDir) {
  const webDir = path.join(sourceDir, 'apps/web');
  const workbenchDir = path.join(sourceDir, 'packages/workbench');
  const workbenchRequire = createRequire(path.join(workbenchDir, 'package.json'));
  const modelRequire = createRequire(path.join(sourceDir, 'packages/model-runtime/package.json'));
  const tailwindEntry = workbenchRequire.resolve('@tailwindcss/postcss');
  const tailwind = workbenchRequire(tailwindEntry);
  const postcss = createRequire(tailwindEntry)('postcss');
  const logo = (await readFile(path.join(workbenchDir, 'public/logo.svg'))).toString('base64');
  const favicon = `data:image/svg+xml;base64,${logo}`;
  const version = (await readFile(path.join(sourceDir, 'VERSION'), 'utf8')).trim();

  const result = await build({
    absWorkingDir: sourceDir,
    entryPoints: [path.join(webDir, 'src/tarobird/main.ts')],
    bundle: true,
    metafile: true,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outdir: 'dist',
    write: false,
    alias: {
      '@': path.join(webDir, 'src'),
      'file-saver': path.join(webDir, 'src/tarobird/exports.ts'),
      '@tarobird-canvas': path.join(webDir, 'src/tarobird'),
      '@infinite-canvas/model-runtime/channels': path.join(sourceDir, 'packages/model-runtime/src/channels.ts'),
      axios: path.join(path.dirname(modelRequire.resolve('axios/package.json')), 'index.js'),
      '@workbench': path.join(workbenchDir, 'src'),
      'radix-ui': path.dirname(workbenchRequire.resolve('radix-ui/package.json')),
      react: path.dirname(workbenchRequire.resolve('react/package.json')),
      'react-dom': path.dirname(workbenchRequire.resolve('react-dom/package.json')),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({ BASE_URL: '/', DEV: false, PROD: true }),
      __APP_VERSION__: JSON.stringify(version),
      __APP_RELEASES__: '[]',
      __TAROBIRD_CANVAS_LOGO__: JSON.stringify(favicon),
    },
    loader: { '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl' },
    plugins: [{
      name: 'upstream-tailwind',
      setup(builder) {
        builder.onLoad({ filter: /[\/]styles[\/]app\.css$/ }, async args => {
          const css = await readFile(args.path, 'utf8');
          const compiled = await postcss([tailwind({ base: sourceDir, optimize: true })]).process(css, { from: args.path });
          return { contents: compiled.css, loader: 'css', resolveDir: path.dirname(args.path) };
        });
      },
    }],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js'));
  const css = result.outputFiles.find(file => file.path.endsWith('.css'));
  if (!js || !css || result.outputFiles.length !== 2) throw Error('infinite_canvas_build_requires_inline_assets');
  const safeJs = js.text.replace(/<\/script/gi, '<\\/script');
  const safeCss = css.text.replace(/<\/style/gi, '<\\/style');
  const license = await readFile(path.join(sourceDir, 'LICENSE'), 'utf8');
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>无限画布 · Infinite Canvas</title>
<link rel="icon" href="${favicon}" />
<style>${safeCss}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
<!-- ${license.trim()} -->
</body>
</html>
`;
  return { bytes: Buffer.from(html), notices: await readDependencyNotices(sourceDir, result.metafile.inputs) };
}


// The lock pins publishers whose npm tarballs point at a repository license.
const supplementaryNotices = {
  '@ai-sdk/provider-utils@5.0.70': './notices/vercel-ai-LICENSE.txt',
  '@uiw/codemirror-extensions-basic-setup@4.25.12': './notices/uiw-LICENSE.txt',
  '@uiw/react-codemirror@4.25.12': './notices/uiw-LICENSE.txt',
  'react-remove-scroll-bar@2.3.8': '../../client/licenses/excalidraw/react-remove-scroll-bar-LICENSE.txt',
};

async function readDependencyNotices(source, buildInputs) {
  const nodeModules = '/node_modules/';
  const packageDirs = new Set();
  for (const input of Object.keys(buildInputs)) {
    const normalized = '/' + input.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf(nodeModules);
    if (marker === -1) continue;
    const start = marker + nodeModules.length;
    const name = normalized.slice(start).split('/');
    const nameLength = name[0].startsWith('@') ? 2 : 1;
    packageDirs.add(path.resolve(source, normalized.slice(1, start) + name.slice(0, nameLength).join('/')));
  }
  const notices = new Map();
  for (const directory of packageDirs) {
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const name = `${pkg.name}@${pkg.version}`;
    const contents = await readdir(directory, { withFileTypes: true });
    const docs = contents.filter(file => file.isFile() && /^(?:licen[cs]es?|copying|notice)(?:[.-].*)?$/i.test(file.name));
    const texts = await Promise.all(docs.sort((a, b) => a.name.localeCompare(b.name)).map(({ name }) => readFile(path.join(directory, name), 'utf8')));
    if (!texts.length) {
      const readme = contents.find(file => file.isFile() && /^readme(?:[.-].*)?$/i.test(file.name));
      if (readme) {
        const document = await readFile(path.join(directory, readme.name), 'utf8');
        const licenseSection = /^#{1,6} Licen[cs]e[\s\S]*?(?=\n#{1,6} |(?![\s\S]))/mi.exec(document)?.[0];
        if (licenseSection) texts.push(licenseSection);
      }
    }
    const supplementary = supplementaryNotices[name];
    if (supplementary) texts.push(await readFile(new URL(supplementary, import.meta.url), 'utf8'));
    if (!texts.length) throw Error(`infinite_canvas_dependency_notice_missing: ${name}`);
    notices.set(name, [`${name} (${pkg.license ?? 'license recorded by publisher'})`, ...texts.map(text => text.trim())].join('\n\n'));
  }
  const license = await readFile(new URL('./notices/Apache-2.0.txt', import.meta.url), 'utf8');
  return [...notices.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, notice]) => notice)
    .concat(['Apache-2.0 license text for the dependencies identified above\n\n' + license.trim()])
    .join('\n\n---\n\n') + '\n';
}
