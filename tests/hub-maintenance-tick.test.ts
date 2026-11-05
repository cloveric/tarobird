import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runHubMaintenanceTick, type HubMaintenanceSchedule } from "../src/hub/cli.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubStore } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
import { updateBackupSettings } from "../src/hub/backup-settings.js";

let root: string, store: HubStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hub-maintenance-tick-")); store = await HubStore.open(root); });
afterEach(async () => { vi.restoreAllMocks(); await store.db.close(); await rm(root, { force: true, recursive: true }); });

it.each([true, false])("history reclamation failure does not block daily work or change backup preference (enabled=%s)", async enabled => {
  const now = Date.UTC(2026, 9, 26, 12), maintenance = new HubMaintenance(store, root), schedule: HubMaintenanceSchedule = {};
  const history = vi.spyOn(maintenance, "pruneEventHistory").mockRejectedValue(new Error("snapshot_open_failed"));
  const warning = vi.spyOn(console, "error").mockImplementation(() => {});
  const collect = vi.spyOn(maintenance, "collectOrphans");
  if (!enabled) await updateBackupSettings(store, root, { requestId: "disable", revision: "default", retentionDays: 0 }, "owner", async () => {});
  const preference = await store.db.get("SELECT value FROM meta WHERE key='automatic-backup-policy:v1'");
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  const chat = await store.createConversation("owner", ["bot"], "Retained", "retained");
  await store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "retained", text: "Keep this message", attachments: [] });
  const messages = await store.db.all("SELECT * FROM messages");
  await store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(0,'owner','expired-fixture','{}')");
  await runHubMaintenanceTick(maintenance, schedule, now);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("event_history_maintenance_failed"));
  expect(await store.db.get("SELECT id FROM audit_log WHERE kind='expired-fixture'")).toBeUndefined();
  expect(collect).toHaveBeenCalledTimes(1);
  expect(schedule.cleanupDay).toBe("2026-10-26"); expect(schedule.backupKey).toBeDefined();
  expect(await store.db.get("SELECT value FROM meta WHERE key='automatic-backup-policy:v1'")).toEqual(preference);
  expect(await store.db.all("SELECT * FROM messages")).toEqual(messages);
  expect(await readdir(path.join(root, "backups"))).toEqual(enabled ? ["auto-2026-10-26.sqlite"] : []);
  if (enabled) {
    const backup = await HubDatabase.snapshot(path.join(root, "backups", "auto-2026-10-26.sqlite"));
    try { expect(await backup.all("SELECT * FROM messages")).toEqual(messages); }
    finally { await backup.close(); }
  }
  await runHubMaintenanceTick(maintenance, schedule, now + 60_000);
  expect(history).toHaveBeenCalledTimes(2); expect(collect).toHaveBeenCalledTimes(1);
});

it.each(["not-json", JSON.stringify({ format: 2, revision: "newer-host", retentionDays: 7, receipts: [] })])("still trims and collects garbage with an unreadable backup policy: %s", async policy => {
  const now = Date.UTC(2026, 9, 23, 12), day = new Date(now).toISOString().slice(0, 10);
  const maintenance = new HubMaintenance(store, root), schedule: HubMaintenanceSchedule = {};
  const pruneRuns = vi.spyOn(maintenance, "pruneRunDetails"), pruneDelivery = vi.spyOn(maintenance, "pruneDeliveryHistory"), collect = vi.spyOn(maintenance, "collectOrphans");
  await store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(0,'owner','old-fixture','{}'),(?,'owner','recent-fixture','{}')", [now]);
  const attachments = path.join(root, "attachments"), backups = path.join(root, "backups");
  await mkdir(attachments); await mkdir(backups);
  const orphan = path.join(attachments, "att_abandoned.blob");
  await writeFile(orphan, "crash-leftover"); await utimes(orphan, new Date(0), new Date(0));
  await writeFile(path.join(attachments, "operator-notes.txt"), "keep");
  await writeFile(path.join(backups, "auto-2020-01-01.sqlite"), "preserve-until-policy-is-readable");
  await store.db.run("INSERT INTO meta(key,value) VALUES('automatic-backup-policy:v1',?)", [policy]);

  await expect(runHubMaintenanceTick(maintenance, schedule, now)).rejects.toThrow("backup_settings_unavailable");
  expect(await store.db.get("SELECT id FROM audit_log WHERE kind='old-fixture'")).toBeUndefined();
  expect(await store.db.get("SELECT id FROM audit_log WHERE kind='recent-fixture'")).toBeDefined();
  expect(pruneRuns).toHaveBeenCalledWith(now); expect(pruneDelivery).toHaveBeenCalledWith(now);
  await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(attachments, "operator-notes.txt"), "utf8")).toBe("keep");
  expect(await readFile(path.join(backups, "auto-2020-01-01.sqlite"), "utf8")).toBe("preserve-until-policy-is-readable");
  expect(await readdir(backups)).toEqual(["auto-2020-01-01.sqlite"]);

  // An invalid policy retries without repeating the entire daily cleanup.
  await expect(runHubMaintenanceTick(maintenance, schedule, now + 1)).rejects.toThrow("backup_settings_unavailable");
  expect(collect).toHaveBeenCalledTimes(1); expect(pruneRuns).toHaveBeenCalledTimes(1);
  // Once a supported policy returns, the same day's backup is still due.
  await store.db.run("DELETE FROM meta WHERE key='automatic-backup-policy:v1'");
  await runHubMaintenanceTick(maintenance, schedule, now + 2);
  expect(await readdir(backups)).toEqual([`auto-${day}.sqlite`]);
  expect(collect).toHaveBeenCalledTimes(1);
  // Policy revisions are applied promptly, even after today's work completed.
  await updateBackupSettings(store, root, { requestId: "disable", revision: "default", retentionDays: 0 }, "owner", async () => {});
  await runHubMaintenanceTick(maintenance, schedule, now + 3);
  expect(await readdir(backups)).toEqual([]);
  await runHubMaintenanceTick(maintenance, schedule, now + 86400_000);
  expect(collect).toHaveBeenCalledTimes(2); expect(pruneRuns).toHaveBeenCalledTimes(2);
});

it("collects garbage even when snapshot creation fails, then retries only the backup", async () => {
  const now = Date.UTC(2026, 9, 23, 12), maintenance = new HubMaintenance(store, root), schedule: HubMaintenanceSchedule = {};
  const backup = vi.spyOn(maintenance, "backup").mockRejectedValueOnce(new Error("disk_full"));
  const pruneAudit = vi.spyOn(maintenance, "pruneAudit"), collect = vi.spyOn(maintenance, "collectOrphans");
  await expect(runHubMaintenanceTick(maintenance, schedule, now)).rejects.toThrow("disk_full");
  expect(collect).toHaveBeenCalledTimes(1);
  await runHubMaintenanceTick(maintenance, schedule, now + 60_000);
  expect(await readdir(path.join(root, "backups"))).toEqual(["auto-2026-10-23.sqlite"]);
  expect(backup).toHaveBeenCalledTimes(2);
  expect(pruneAudit).toHaveBeenCalledTimes(1); expect(collect).toHaveBeenCalledTimes(1);
});
