import { _electron } from '@playwright/test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
import { assertImported, assertReloadKeepsQueue, gateDone } from './migration-content.mjs';
const [binary, source, output, stateRoot] = process.argv.slice(2);
if (!binary || !source || !output || !stateRoot || !binary.split(path.sep).some(p => p.endsWith('.noindex'))) throw new Error('explicit isolated paths required');
const lab = await isolatedRoot(output), origin = await isolatedRoot(source);
const receipt = JSON.parse(await readFile(path.join(origin, 'tauri-export.json'), 'utf8'));
assert.equal(receipt.passed, true);
const state = await mkdtemp(path.join(await isolatedRoot(stateRoot), 'm-'));
await cp(path.join(origin, 'native-state'), path.join(state, 'native-state'), { recursive: true });
const marker = await readFile(path.join(state, 'native-state/tarobot-client-installation-v1'));
let app;
try {
  app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${state}`], env: helperEnvironment(), timeout: 30000 });
  const page = await app.firstWindow(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await gateDone(page);
  const { after, profile } = await assertImported(page, { receipt, state, exportId: receipt.result.exportId, marker });
  await page.screenshot({ path: path.join(lab, 'imported.png') });
  await assertReloadKeepsQueue(page, receipt);
  assert.deepEqual(errors, []);
  await writeFile(path.join(lab, 'verification.json'), JSON.stringify({ passed: true, source: `real ${process.platform === 'win32' ? 'WebView2' : 'WKWebView'} / native Rust export`, target: 'packaged Electron / native migration gate', exportId: profile.exportId, after }, null, 2));
  console.log(JSON.stringify({ passed: true, exportId: profile.exportId, state }));
} finally { if (app) await Promise.race([app.close(), new Promise(resolve => { const timer = setTimeout(() => { app.process().kill('SIGKILL'); resolve(); }, 5000); timer.unref(); })]); }
