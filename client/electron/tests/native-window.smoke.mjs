// Hold a signed isolated App for CUA mouse/menu inspection. The explicit done
// marker is written by the operator only after observing the native window.
import { _electron } from '@playwright/test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
const [binary, output] = process.argv.slice(2);
if (!binary?.includes('.noindex/')) throw new Error('isolated package required');
const root = await isolatedRoot(output), state = await mkdtemp(path.join(root, 'state-'));
const app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${state}`], env: helperEnvironment() });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.tarobotDesktop?.engine === 'electron' && !document.querySelector('.desktop-migration-gate'));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await writeFile(path.join(root, 'ready.json'), JSON.stringify({ pid: app.process().pid, binary, state }));
  const end = Date.now() + 10 * 60000;
  for (;;) { try { await readFile(path.join(root, 'cua-done.json')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() > end) throw new Error('native_window_acceptance_not_completed'); await delay(500); }
  await page.screenshot({ path: path.join(root, 'native-window.png') });
  await writeFile(path.join(root, 'ui.txt'), await page.locator('body').innerText());
} finally { await app.close(); }
