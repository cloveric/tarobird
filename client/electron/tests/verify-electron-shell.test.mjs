import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackage } from '@electron/asar';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyElectronShell } from '../../scripts/verify-electron-shell.mjs';

const atlas = await readFile(new URL('../windows-unread-badges.png', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, badge, layout = 'resources') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'electron-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), resources = path.join(root, layout);
  const frontend = path.join(source, 'dist'), version = '1.2.3', commit = 'a'.repeat(40);
  await mkdir(frontend, { recursive: true }); await mkdir(resources, { recursive: true });
  await Promise.all([
    writeFile(path.join(source, 'package.json'), JSON.stringify({ version, main: 'main.mjs' })),
    writeFile(path.join(source, 'desktop.json'), JSON.stringify({ format: 1, mode: 'production', sourceCommit: commit, dirty: false })),
    writeFile(path.join(source, 'main.mjs'), 'export {};'),
    writeFile(path.join(source, 'preload.cjs'), 'module.exports = {};'),
    writeFile(path.join(frontend, 'index.html'), '<!doctype html><title>Fixture</title>'),
    ...(badge ? [writeFile(path.join(source, 'windows-unread-badges.png'), badge)] : []),
  ]);
  await createPackage(source, path.join(resources, 'app.asar'));
  return { resources, frontend, version, commit };
}

test('packaged shell rejects an omitted Windows taskbar atlas', async t => {
  const options = await fixture(t);
  await assert.rejects(verifyElectronShell(options), /Electron Windows unread badge/);
});

test('packaged shell rejects atlas bytes that differ from the source PNG', async t => {
  const corrupt = Buffer.from(atlas); corrupt[corrupt.length - 1] ^= 1;
  const options = await fixture(t, corrupt);
  await assert.rejects(verifyElectronShell(options), /Electron Windows unread badge bytes differ/);
});

for (const layout of ['resources', 'TaroBird.app/Contents/Resources']) {
  test(`packaged shell verifies the exact atlas in ${layout}`, async t => {
    const options = await fixture(t, atlas, layout);
    const result = await verifyElectronShell(options);
    assert.equal(result.windowsUnreadBadgeSha256, digest(atlas));
    assert.equal(result.files, 1);
    assert.equal(result.sourceCommit, options.commit);
  });
}
