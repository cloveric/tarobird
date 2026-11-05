// macOS native file paste; isolated acceptance App, disposable files, and
// restore every original clipboard format without logging clipboard contents.
import { _electron } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';
const [binary, output] = process.argv.slice(2);
if (process.platform !== 'darwin' || !binary?.includes('.noindex/')) throw new Error('isolated Mac package required');
const root = await isolatedRoot(output), state = await mkdtemp(path.join(root, 'state-'));
const files = [path.join(root, 'paste-one.md'), path.join(root, 'paste-two.txt')];
for (const [i, file] of files.entries()) await writeFile(file, `file paste fixture ${i}`, { flag: 'wx' });
let app, clipboardSaved = false;
try {
  app = await _electron.launch({ executablePath: binary, args: [`--tarobot-development=${state}`], env: helperEnvironment() });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.tarobotDesktop?.engine === 'electron' && !document.querySelector('.desktop-migration-gate'));
  await app.evaluate(async ({ clipboard, ClipboardItem }) => { globalThis.savedClipboard = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))); }); clipboardSaved = true;
  await app.evaluate(async ({ clipboard, ClipboardItem }, files) => {
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const plist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>' + files.map(file => '<string>' + escape(file) + '</string>').join('') + '</array></plist>';
    await clipboard.write([new ClipboardItem({ 'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([plist]) })]);
  }, files);
  await page.evaluate(() => {
    const field = document.createElement('textarea'); field.id = 'native-paste-probe'; document.body.prepend(field); field.focus();
    field.addEventListener('paste', event => { event.preventDefault();
      globalThis.pastedFiles = Array.from(event.clipboardData.files).map(file => ({ name: file.name, size: file.size }));
      globalThis.pasteTypes = Array.from(event.clipboardData.types);
    });
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste());
  await page.waitForFunction(() => Array.isArray(globalThis.pastedFiles));
  const result = await page.evaluate(() => ({ files: globalThis.pastedFiles, types: globalThis.pasteTypes }));
  await writeFile(path.join(root, 'verification.json'), JSON.stringify({ ...result, scope: 'native file-alias clipboard to Chromium paste event; no message sent' }, null, 2));
  assert.deepEqual(result.files.map(file => file.name).sort(), files.map(file => path.basename(file)).sort());
  console.log(JSON.stringify({ passed: true, files: result.files.length }));
} finally {
  if (app && clipboardSaved) await app.evaluate(async ({ clipboard }) => { if (globalThis.savedClipboard.length) await clipboard.write(globalThis.savedClipboard); else clipboard.clear(); delete globalThis.savedClipboard; });
  if (app) await app.close();
}
