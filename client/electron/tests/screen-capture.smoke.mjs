// Real Electron smoke for the remote-screen capture renderer (#99).
//   node electron/tests/screen-capture.smoke.mjs --lab <absolute .noindex dir>
// Runs the real capture page, preload, display-media handler and WebCodecs
// encoder. The display source is a hidden synthetic page (a WebFrameMain), so
// no screen-recording permission is requested and nothing is captured from the
// real desktop. A hidden viewer decodes every packet. No OS input is posted.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--lab') throw new Error('usage: screen-capture.smoke.mjs --lab <absolute .noindex directory>');
const root = await isolatedRoot(args[1]), run = await mkdtemp(path.join(root, 'screen-capture-'));
const electronDir = fileURLToPath(new URL('..', import.meta.url)), client = path.dirname(electronDir);
const app = path.join(run, 'app'), capture = path.join(app, 'screen-capture');
await mkdir(capture, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(electronDir, 'screen-capture-page.mjs')], outfile: path.join(capture, 'capture.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome140' }),
  build({ entryPoints: [path.join(electronDir, 'screen-capture-preload.mjs')], outfile: path.join(app, 'screen-capture-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] }),
  cp(path.join(electronDir, 'screen-capture.html'), path.join(capture, 'capture.html')),
  build({ stdin: { contents: "const{ipcRenderer}=require('electron');ipcRenderer.on('viewer-port',e=>window.postMessage('viewer-port','*',e.ports));", loader: 'js' }, outfile: path.join(app, 'viewer-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', external: ['electron'] }),
  build({ entryPoints: [path.join(electronDir, 'tests/screen-capture-smoke-main.mjs')], outfile: path.join(app, 'main.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', external: ['electron'] }),
]);
await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'tarobot-screen-capture-smoke', main: 'main.mjs', type: 'module' }));
const electron = path.join(client, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const result = path.join(run, 'result.json');
const code = await new Promise(resolve => {
  const child = spawn(electron, [app, `--smoke-result=${result}`, `--smoke-profile=${path.join(run, 'profile.noindex')}`], { env: helperEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.on('exit', value => { clearTimeout(timer); resolve(value); });
});
const report = JSON.parse(await readFile(result, 'utf8'));
console.log(JSON.stringify(report, null, 1));
const failures = report.failures ?? ['no_report'];
if (code !== 0 || failures.length) { console.error(`screen capture smoke FAILED (exit ${code}): ${failures.join(', ')}`); process.exit(1); }
console.log(`screen capture smoke passed: ${run}`);
