import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { automaticBackupSummary, readBackupSettings, updateBackupSettings } from "../src/hub/backup-settings.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubStore } from "../src/hub/store.js";
import { HubServer } from "../src/hub/server.js";
import { HubDatabase } from "../src/hub/database.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBackupsCommand } from "../src/host-cli/backups.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { startHubControl } from "../src/hub/service.js";
import { withFileMutex } from "../src/state/file-mutex.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-policy-")), store = await HubStore.open(root);
  cleanup.push(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, maintenance: new HubMaintenance(store, root), set: async (days: number) => updateBackupSettings(store, root,
    { requestId: crypto.randomUUID(), revision: (await readBackupSettings(store.db)).revision, retentionDays: days }, "owner", async () => {}) };
}
it("defaults to one day for old and new hosts and applies live policy changes even on the same day", async () => {
  const f = await fixture(), now = Date.UTC(2026, 9, 23);
  expect(await readBackupSettings(f.store.db)).toMatchObject({ retentionDays: 1, revision: "default" });
  await f.maintenance.dailyBackup(now - 86400000); await f.maintenance.dailyBackup(now);
  expect(await automaticBackupSummary(f.root)).toMatchObject({ count: 1, latestDay: "2026-10-23" });
  const key = await f.maintenance.backupScheduleKey(now);
  await f.set(0);
  expect(await f.maintenance.backupScheduleKey(now)).not.toBe(key);
  const backup = vi.spyOn(f.maintenance, "backup"); await f.maintenance.dailyBackup(now);
  expect(backup).not.toHaveBeenCalled(); expect((await automaticBackupSummary(f.root)).count).toBe(0);
  await f.set(1); await f.maintenance.dailyBackup(now);
  expect(backup).toHaveBeenCalledTimes(1);
  const snapshot = await HubDatabase.snapshot(path.join(f.root, "backups/auto-2026-10-23.sqlite"));
  try { expect(await snapshot.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" }); } finally { await snapshot.close(); }
});
it("uses calendar days across gaps, preserves future snapshots and never prunes manual files or links", async () => {
  const f = await fixture(); await f.set(3);
  const dir = path.join(f.root, "backups"); await mkdir(dir);
  for (const name of ['auto-2026-08-01.sqlite', 'auto-2026-10-20.sqlite', 'auto-2026-10-21.sqlite', 'auto-2026-10-25.sqlite', 'auto-2026-02-31.sqlite', 'manual.sqlite', '2026-10-01-123.sqlite']) await writeFile(path.join(dir, name), name);
  await mkdir(path.join(dir, 'auto-2026-06-01.sqlite'));
  await writeFile(path.join(f.root, 'outside.sqlite'), 'safe'); await symlink(path.join(f.root, 'outside.sqlite'), path.join(dir, 'auto-2026-07-01.sqlite'));
  await f.maintenance.dailyBackup(Date.UTC(2026, 9, 23));
  expect(await readdir(dir)).not.toContain('auto-2026-10-20.sqlite');
  expect(await readdir(dir)).toContain('auto-2026-10-21.sqlite');
  expect(await readdir(dir)).toContain('auto-2026-10-25.sqlite');
  await f.set(0); await f.maintenance.dailyBackup(Date.UTC(2026, 9, 23));
  expect((await readdir(dir)).sort()).toEqual(['2026-10-01-123.sqlite','auto-2026-02-31.sqlite','auto-2026-06-01.sqlite','auto-2026-07-01.sqlite','manual.sqlite']);
  expect(await readFile(path.join(f.root, 'outside.sqlite'), 'utf8')).toBe('safe');
  expect(await readFile(path.join(dir, 'manual.sqlite'), 'utf8')).toBe('manual.sqlite');
});
it("rejects stale, conflicting, invalid or damaged policies without replacing settings or deleting snapshots", async () => {
  const f = await fixture(); await f.maintenance.dailyBackup();
  const command = { requestId: 'save', revision: 'default', retentionDays: 0 };
  const saved = await updateBackupSettings(f.store, f.root, command, 'owner', async () => {});
  expect(await updateBackupSettings(f.store, f.root, command, 'owner', async () => {})).toEqual(saved);
  await expect(updateBackupSettings(f.store, f.root, { ...command, retentionDays: 1 }, 'owner', async () => {})).rejects.toThrow('backup_request_conflict');
  await expect(updateBackupSettings(f.store, f.root, { ...command, requestId: 'stale' }, 'owner', async () => {})).rejects.toThrow('backup_revision_conflict');
  for (const retentionDays of [-1, 1.5, 3651, NaN]) await expect(f.set(retentionDays)).rejects.toThrow();
  await expect(updateBackupSettings(f.store, f.root, { ...command, revision: saved.revision, requestId: 'revoked', retentionDays: 2 }, 'owner', async () => { throw Error('revoked'); })).rejects.toThrow('revoked');
  expect(await readBackupSettings(f.store.db)).toEqual(saved);
  await f.store.db.run("UPDATE meta SET value='broken' WHERE key='automatic-backup-policy:v1'");
  await expect(f.maintenance.dailyBackup()).rejects.toThrow('backup_settings_unavailable');
  expect((await automaticBackupSummary(f.root)).count).toBe(1);
});
it("refuses a symlinked backup directory rather than reading or clearing its target", async () => {
  const f = await fixture(), outside = path.join(f.root, 'elsewhere'); await mkdir(outside);
  await writeFile(path.join(outside, 'auto-2026-10-01.sqlite'), 'keep');
  await symlink(outside, path.join(f.root, 'backups')); await f.set(0);
  await expect(f.maintenance.dailyBackup()).rejects.toThrow('backup_directory_invalid');
  await expect(automaticBackupSummary(f.root)).rejects.toThrow('backup_directory_invalid');
  expect(await readFile(path.join(outside, 'auto-2026-10-01.sqlite'), 'utf8')).toBe('keep');
});
async function onlineFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-api-")); await initializeHost(root, 'Backup fixture');
  const hub = await HubServer.start({ stateDir: root });
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true });
  cleanup.push(async () => { client.close(); await control(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hub, client };
}
it("shares the authenticated policy API with the CLI, preserves settings after restart and enforces owner access", async () => {
  const f = await onlineFixture();
  expect(f.client.ready.serverCapabilities).toContain('backups.settings.v1');
  expect(await runBackupsCommand(f.client, 'status', {})).toMatchObject({ retentionDays: 1, snapshots: { count: 0 } });
  const set = await runBackupsCommand(f.client, 'configure', { days: '14', requestId: 'cli-save' });
  expect(set.retentionDays).toBe(14);
  expect(await runBackupsCommand(f.client, 'status', { requestId: 'cli-save' })).toMatchObject({ receipt: { requestId: 'cli-save', revision: set.revision } });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await runHostCli(['backups', 'configure', '--days', '0', '--state-dir', f.root, '--json']);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"retentionDays": 0'));
  log.mockRestore(); err.mockRestore();
  const reopened = await HubDatabase.snapshot(path.join(f.root, 'hub.sqlite'));
  try { expect(await readBackupSettings(reopened)).toMatchObject({ retentionDays: 0 }); } finally { await reopened.close(); }
  await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  await expect(f.client.request('/api/settings/backups')).rejects.toMatchObject({ status: 403 });
  await expect(f.client.request('/api/settings/backups', 'PUT', { requestId: 'member', revision: set.revision, retentionDays: 1 })).rejects.toMatchObject({ status: 403 });
});
it("checks revocation again after a backup lock wait before committing a setting", async () => {
  const f = await onlineFixture(), owner = vi.spyOn(f.hub.store, 'requireOwner');
  let outcome: Promise<unknown>;
  await withFileMutex(path.join(f.root, 'daily-backup'), async () => {
    outcome = f.client.request('/api/settings/backups', 'PUT', { requestId: 'revoked', revision: 'default', retentionDays: 0 }).catch(error => error);
    await vi.waitFor(() => expect(owner).toHaveBeenCalled());
    await f.hub.store.db.run('UPDATE devices SET revoked=1 WHERE id=?', [f.client.deviceId]);
  });
  expect(await outcome!).toMatchObject({ status: 401 });
  expect(await readBackupSettings(f.hub.store.db)).toMatchObject({ retentionDays: 1, revision: 'default' });
});
it("validates CLI values before requests and never reports a concurrent write as its own", async () => {
  const request = vi.fn();
  for (const days of ['-1','1.5','1e2','', '3651']) await expect(runBackupsCommand({ request }, 'configure', { days })).rejects.toThrow();
  await expect(runBackupsCommand({ request }, 'status', { days: '1' })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue({ revision: 'other', retentionDays: 2, receipt: null, snapshots: { count: 0, bytes: 0, latestDay: null } });
  await expect(runBackupsCommand({ request }, 'configure', { days: '1' })).rejects.toThrow('backup_settings_unconfirmed');
});
