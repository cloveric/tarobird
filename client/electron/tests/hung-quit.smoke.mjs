// Actual blocked Chromium renderer and normal App quit, in an isolated package.
import { _electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
const [binary, output] = process.argv.slice(2);
if (!binary?.includes('.noindex/')) throw new Error('isolated package required');
const root = await isolatedRoot(output), state = await mkdtemp(path.join(root, 'state-'));
const app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${state}`], env: helperEnvironment() });
const child = app.process();
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.tarobotDesktop?.engine === 'electron' && !document.querySelector('.desktop-migration-gate'));
  await page.evaluate(() => { setTimeout(() => { for (;;) {} }, 0); });
  const end = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hung_renderer_prevented_quit')), 15000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const started = Date.now(); await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  const result = await end;
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ passed: true, elapsedMs: Date.now() - started, ...result }));
  console.log(JSON.stringify({ passed: true, ...result }));
} finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
