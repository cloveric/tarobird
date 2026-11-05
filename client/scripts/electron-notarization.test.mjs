import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { notarizeElectron } from './electron-notarization.mjs';
test('interrupted wait preserves submission ID; resume and accepted replay never upload again', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notary-'));
  const archive = path.join(root, 'app.zip'), receiptFile = path.join(root, 'receipt.json');
  const id = '12345678-1234-4321-a123-123456789abc', binding = { sourceCommit: 'a'.repeat(40), version: '1.2.3', team: 'fixture', cdhash: 'b'.repeat(40) };
  let uploads = 0, creates = 0, waits = 0, failWait = true;
  const input = { archive, receiptFile, binding, profile: 'fixture', createArchive: async () => { creates++; await writeFile(archive, 'signed bytes'); },
    run: async args => {
      if (args[0] === 'submit') { uploads++; assert.equal(args.includes('--wait'), false); return JSON.stringify({ id }); }
      assert.equal(args[0], 'wait'); assert.equal(args[1], id); waits++;
      assert.equal(JSON.parse(await readFile(receiptFile)).id, id);
      if (failWait) throw new Error('network interrupted');
      return JSON.stringify({ id, status: 'Accepted' });
    } };
  await assert.rejects(notarizeElectron(input), /interrupted/);
  assert.equal(JSON.parse(await readFile(receiptFile)).status, 'Submitted');
  failWait = false; assert.equal((await notarizeElectron(input)).status, 'Accepted');
  await notarizeElectron(input); assert.deepEqual([uploads, creates, waits], [1, 1, 2]);
  await assert.rejects(notarizeElectron({ ...input, binding: { ...binding, cdhash: 'c'.repeat(40) } }), /does not match/);
  await writeFile(archive, 'different bytes'); await assert.rejects(notarizeElectron(input), /does not match/);
  assert.equal(uploads, 1);
});
test('a rejected submission keeps its durable ID and requires a new output after fixing the App', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'notary-invalid-'));
  const archive = path.join(root, 'app.zip'), receiptFile = path.join(root, 'receipt.json');
  const id = '12345678-1234-4321-a123-123456789abc'; let uploads = 0;
  const input = { archive, receiptFile, binding: { sourceCommit: 'a'.repeat(40) }, profile: 'fixture',
    createArchive: () => writeFile(archive, 'invalid signed bytes'), run: async args => {
      if (args[0] === 'submit') { uploads++; return JSON.stringify({ id }); }
      return JSON.stringify({ id, status: 'Invalid' });
    } };
  await assert.rejects(notarizeElectron(input), /notarization is Invalid/);
  assert.equal(JSON.parse(await readFile(receiptFile)).status, 'Invalid');
  await assert.rejects(notarizeElectron(input), /new output directory/);
  assert.equal(uploads, 1);
});
