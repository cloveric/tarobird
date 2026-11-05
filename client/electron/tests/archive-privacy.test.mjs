import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createMacUpdateArchive } from '../../scripts/electron-macos-artifacts.mjs';

test('Mac update archive removes build-user ownership while retaining executable modes, bytes and symlinks', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'archive-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage.noindex'), app = path.join(stage, 'TaroBird.app'), executable = path.join(app, 'Contents/MacOS/app');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, 'fixture executable\n'); await chmod(executable, 0o755);
  await symlink('MacOS/app', path.join(app, 'Contents/alias'));
  const archive = path.join(root, 'app.tar.gz');
  createMacUpdateArchive({ stage, archive });
  const bytes = gunzipSync(await readFile(archive)), entries = [];
  const text = b => b.toString('utf8').replace(/\0.*$/s, '').trim();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512); if (header.every(b => b === 0)) break;
    const size = parseInt(text(header.subarray(124, 136)) || '0', 8);
    entries.push({ name: text(header.subarray(0, 100)), mode: parseInt(text(header.subarray(100, 108)), 8),
      uid: parseInt(text(header.subarray(108, 116)), 8), gid: parseInt(text(header.subarray(116, 124)), 8),
      user: text(header.subarray(265, 297)), group: text(header.subarray(297, 329)), link: text(header.subarray(157, 257)),
      content: bytes.subarray(offset + 512, offset + 512 + size).toString('utf8') });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(entries.length >= 5);
  for (const entry of entries) {
    assert.deepEqual([entry.uid, entry.gid, entry.user, entry.group], [0, 0, 'root', 'wheel']);
    assert.ok(!entry.name.includes('._'));
  }
  assert.equal(entries.find(e => e.name.endsWith('/MacOS/app')).mode & 0o777, 0o755);
  assert.equal(entries.find(e => e.name.endsWith('/MacOS/app')).content, 'fixture executable\n');
  assert.equal(entries.find(e => e.name.endsWith('/alias')).link, 'MacOS/app');
});
