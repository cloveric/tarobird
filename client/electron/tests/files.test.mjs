import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, symlink, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopFiles } from '../files.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'tarobot-save-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '用户 选择.md'), calls = [];
  const port = new DesktopFiles({}, { dialog: { showSaveDialog: async () => ({ filePath: file, canceled: false }) }, shell: { openPath: async value => { calls.push(value); return ''; }, showItemInFolder: value => calls.push(value) } }, { mark: async () => {} });
  return { root, file, port, calls, call: (name, args) => port.request(name, args, () => true) };
}
test('an incomplete save preserves the existing destination and rejects a false receipt', async t => {
  const f = await fixture(t); await writeFile(f.file, 'old');
  const { token } = await f.call('desktop_save_begin', { name: 'test.md', size: 5 });
  await f.call('desktop_save_write', { token, data: Buffer.from('abc').toString('base64') });
  await assert.rejects(f.call('desktop_save_commit', { token }), /incomplete/);
  assert.equal(await readFile(f.file, 'utf8'), 'old'); assert.deepEqual(await readdir(f.root), ['用户 选择.md']);
});
test('only a completed user-selected file can be opened or revealed; edits keep it, links and non-files revoke it', async t => {
  const f = await fixture(t), bytes = '真实保存的内容';
  const { token } = await f.call('desktop_save_begin', { name: 'test.md', size: Buffer.byteLength(bytes) });
  await f.call('desktop_save_write', { token, data: Buffer.from(bytes).toString('base64') });
  const receipt = await f.call('desktop_save_commit', { token });
  assert.equal(receipt.path, f.file); assert.equal(await readFile(f.file, 'utf8'), bytes);
  await f.call('open_saved_file', { path: f.file }); assert.deepEqual(f.calls, [f.file]);
  await assert.rejects(f.call('open_saved_file', { path: path.join(f.root, 'unknown') }), /not_granted/);
  // Edited in another App (Tauri's path-based scope allowed this too).
  await writeFile(f.file, 'edited afterwards');
  await f.call('reveal_saved_file', { path: f.file }); assert.deepEqual(f.calls, [f.file, f.file]);
  await rm(f.file); await writeFile(path.join(f.root, 'elsewhere'), 'x'); await symlink(path.join(f.root, 'elsewhere'), f.file);
  await assert.rejects(f.call('reveal_saved_file', { path: f.file }), /not_granted/);
  await assert.rejects(f.call('open_saved_file', { path: f.file }), /not_granted/);
  await rm(f.file); await mkdir(f.file);
  await assert.rejects(f.call('open_saved_file', { path: f.file }), /not_granted/);
  assert.deepEqual(f.calls, [f.file, f.file]);
});
test('destination replacement and symlinks cannot widen the save grant', async t => {
  const f = await fixture(t); await writeFile(f.file, 'old');
  const { token } = await f.call('desktop_save_begin', { name: 'test.md', size: 0 });
  await writeFile(f.file, 'concurrent edit');
  await assert.rejects(f.call('desktop_save_commit', { token }), /destination_changed/);
  assert.equal(await readFile(f.file, 'utf8'), 'concurrent edit');
  await rm(f.file); await symlink(path.join(f.root, 'not-granted'), f.file);
  await assert.rejects(f.call('desktop_save_begin', { name: 'test.md', size: 0 }), /not_granted/);
});
