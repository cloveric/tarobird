import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { developmentMigration } from '../migration-acceptance.mjs';

const bundleId = 'com.tarobot.migration.acceptance.p0123456789abcdef0123456789abcdef';
const flag = `--tarobot-migration-acceptance=${bundleId}`;
async function fixture() {
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'migration-acceptance-')));
  const root = path.join(tmp, 'test.noindex'), local = path.join(tmp, 'Local');
  await mkdir(root); await mkdir(path.join(local, bundleId, 'EBWebView'), { recursive: true });
  await writeFile(path.join(root, 'identity.json'), JSON.stringify({ bundleId, productionDataAccess: false }));
  return { production: false, platform: 'win32', argv: [flag], root, env: { LOCALAPPDATA: local, TAROBOT_MIGRATION_AUDIT_ROOT: root } };
}
test('normal launch has no acceptance reader, even with inherited audit environment', async () => {
  assert.equal(await developmentMigration({ production: true, argv: [], env: { TAROBOT_MIGRATION_AUDIT_ROOT: '/untrusted' } }), undefined);
});
test('production, other platforms, malformed or repeated switches cannot enable a reader', async () => {
  const f = await fixture();
  for (const override of [{ production: true }, { platform: 'darwin' }, { argv: [flag, flag] },
    { argv: ['--tarobot-migration-acceptance'] }, { argv: ['--tarobot-migration-acceptance=com.tarobot.client'] }]) {
    await assert.rejects(developmentMigration({ ...f, ...override }), /invalid_migration_acceptance/);
  }
});
test('only the matching unique fixture and isolated root enable the real reader path', async () => {
  const f = await fixture(), result = await developmentMigration(f);
  assert.deepEqual(result, { bundleId, auditRoot: f.root, legacyWebviewDirs: [path.join(f.env.LOCALAPPDATA, bundleId, 'EBWebView')] });
  await assert.rejects(developmentMigration({ ...f, env: { ...f.env, TAROBOT_MIGRATION_AUDIT_ROOT: f.env.LOCALAPPDATA } }), /root_mismatch/);
  await writeFile(path.join(f.root, 'identity.json'), JSON.stringify({ bundleId: 'com.tarobot.client', productionDataAccess: false }));
  await assert.rejects(developmentMigration(f), /invalid_migration_acceptance_identity/);
});
test('a redirected legacy profile cannot cause the acceptance reader to inspect another profile', async () => {
  const f = await fixture(), local = path.join(f.root, 'redirected'); await mkdir(local);
  await symlink(path.join(f.env.LOCALAPPDATA, bundleId), path.join(local, bundleId), 'junction');
  await assert.rejects(developmentMigration({ ...f, env: { ...f.env, LOCALAPPDATA: local } }), /source_redirected/);
});
