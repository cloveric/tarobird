import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubAttachments } from "../src/hub/attachments.js";
import { HubDatabase } from "../src/hub/database.js";
import { readBackupSettings, updateBackupSettings } from "../src/hub/backup-settings.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { inspectHubService, startHubControl } from "../src/hub/service.js";
import * as fsPromises from "node:fs/promises";
vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rm: vi.fn(actual.rm), open: vi.fn(actual.open) }; });

let root: string; let store: HubStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hm-")); store = await HubStore.open(root); });
afterEach(async () => { vi.restoreAllMocks(); await store.db.close(); await rm(root, { force: true, recursive: true }); });
it("keeps seven automatic daily snapshots across restarts, leaving manual backups and links alone", async () => {
  await updateBackupSettings(store, root, { requestId: "seven", revision: "default", retentionDays: 7 }, "owner", async () => {});
  const backups = path.join(root, "backups"); await mkdir(backups);
  await writeFile(path.join(backups, "manual.sqlite"), "manual");
  await writeFile(path.join(backups, "2026-09-01-1788220800000.sqlite"), "legacy");
  await writeFile(path.join(root, "outside.sqlite"), "outside");
  await symlink(path.join(root, "outside.sqlite"), path.join(backups, "auto-2026-08-01.sqlite"));
  await mkdir(path.join(backups, "auto-2026-08-02.sqlite"));
  for (let day = 1; day <= 9; day++) {
    const now = Date.UTC(2026, 9, day), maintenance = new HubMaintenance(store, root);
    await maintenance.dailyBackup(now);
    const file = path.join(backups, `auto-2026-10-${String(day).padStart(2, "0")}.sqlite`), before = await stat(file);
    await new HubMaintenance(store, root).dailyBackup(now);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    if (process.platform !== "win32") expect(before.mode & 0o777).toBe(0o600);
  }
  const names = await readdir(backups);
  expect(names.filter((name) => name.startsWith("auto-2026-10-")).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `auto-2026-10-0${i + 3}.sqlite`));
  expect(names).toContain("auto-2026-08-01.sqlite"); expect(names).toContain("auto-2026-08-02.sqlite");
  expect(await readFile(path.join(root, "outside.sqlite"), "utf8")).toBe("outside");
  expect(await readFile(path.join(backups, "manual.sqlite"), "utf8")).toBe("manual");
  expect(await readFile(path.join(backups, "2026-09-01-1788220800000.sqlite"), "utf8")).toBe("legacy");
});
it("does not prune existing backups if publishing today's snapshot fails", async () => {
  await updateBackupSettings(store, root, { requestId: "seven", revision: "default", retentionDays: 7 }, "owner", async () => {});
  const maintenance = new HubMaintenance(store, root), backups = path.join(root, "backups");
  for (let day = 1; day <= 7; day++) await maintenance.dailyBackup(Date.UTC(2026, 9, day));
  await updateBackupSettings(store, root, { requestId: "one", revision: (await readBackupSettings(store.db)).revision, retentionDays: 1 }, "owner", async () => {});
  const before = (await readdir(backups)).sort();
  const failure = vi.spyOn(maintenance, "backup").mockImplementationOnce(async (file) => { await writeFile(file, "partial"); throw new Error("disk_full"); });
  await expect(maintenance.dailyBackup(Date.UTC(2026, 9, 8))).rejects.toThrow("disk_full");
  expect((await readdir(backups)).sort()).toEqual(before);
  failure.mockRestore();
  await writeFile(path.join(backups, "auto-2026-10-08.sqlite"), "corrupt snapshot");
  await maintenance.dailyBackup(Date.UTC(2026, 9, 8));
  const snapshot = await HubDatabase.snapshot(path.join(backups, "auto-2026-10-08.sqlite"));
  try { expect(await snapshot.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" }); } finally { await snapshot.close(); }
  expect((await readdir(backups)).filter(name => /^auto-.*\.sqlite$/.test(name))).toHaveLength(1);
});
it("copies a snapshot through its own reader without holding the Hub queue", async () => {
  await store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES('conv_1','direct','c','owner',1)");
  const insert = (id: string) => store.db.transaction(() => store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,'conv_1','owner','user','[]','complete',1,1)", [id]));
  const snapshot = HubDatabase.snapshot.bind(HubDatabase);
  let release!: () => void, copying!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { copying = resolve; });
  vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
    const reader = await snapshot(file), run = reader.run.bind(reader);
    vi.spyOn(reader, "run").mockImplementation(async (sql, params) => { if (sql.startsWith("VACUUM INTO")) { copying(); await gate; } return run(sql, params); });
    return reader;
  });
  // Queued before the call: still part of the backup, as on the Hub queue.
  const queued = insert("before"), destination = path.join(root, "copy.sqlite");
  const backup = new HubMaintenance(store, root).backup(destination);
  await started;
  await insert("during"); expect(await store.db.get("SELECT id FROM messages WHERE id='during'")).toEqual({ id: "during" });
  release(); await backup; await queued;
  const copy = await snapshot(destination);
  try {
    expect(await copy.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" });
    expect(await copy.get("SELECT id FROM messages WHERE id='before'")).toEqual({ id: "before" });
  } finally { await copy.close(); }
  expect((await stat(destination)).mode & 0o777).toBe(0o600);
});

it("cleans only old owned temporary snapshots after crash recovery", async () => {
  const backups = path.join(root, "backups"); await mkdir(backups);
  const stale = ".auto-2026-10-01.sqlite-00000000-0000-4000-8000-000000000001.tmp";
  for (const name of [stale, ".auto-operator.tmp"]) { await writeFile(path.join(backups, name), "partial"); await utimes(path.join(backups, name), new Date(0), new Date(0)); }
  await new HubMaintenance(store, root).dailyBackup(Date.UTC(2026, 9, 8));
  expect(await readdir(backups)).not.toContain(stale);
  expect(await readFile(path.join(backups, ".auto-operator.tmp"), "utf8")).toBe("partial");
});

it("indexes pending delivery work and retires terminal transport rows without deleting idempotency receipts", async () => {
  const now = Date.now(), old = now - 8 * 86400000;
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  await store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES('device','owner','Device','web','fixture',0,0)");
  const chat = await store.createConversation("owner", ["bot"], "Chat", "transport-gc");
  for (const [id, status, at] of [["old-done", "complete", old], ["old-pending", "pending", old], ["recent-done", "complete", now]] as const) {
    await store.db.run("INSERT INTO actions VALUES('owner',?,'{}')", [id]);
    await store.db.run("INSERT INTO action_deliveries(id,user_id,client_action_id,bot_id,conversation_id,params_json,status,created_at) VALUES(?,'owner',?,'bot',?,'{}',?,?)", [id, id, chat.id, status, at]);
    await store.db.run("INSERT INTO push_outbox(id,device_id,conversation_id,event_seq,payload_json,status,next_at) VALUES(?,'device',?,?,'{}',?,?)", [id, chat.id, at + (status === "pending" ? 1 : 0), status === "complete" ? "sent" : "pending", at]);
  }
  expect(await new HubMaintenance(store, root).pruneDeliveryHistory(now)).toBe(2);
  expect((await store.db.all<{ id: string }>("SELECT id FROM action_deliveries ORDER BY id")).map(r => r.id)).toEqual(["old-pending", "recent-done"]);
  expect((await store.db.all<{ id: string }>("SELECT id FROM push_outbox ORDER BY id")).map(r => r.id)).toEqual(["old-pending", "recent-done"]);
  expect(await store.db.all("SELECT * FROM actions")).toHaveLength(3);
  for (const [sql, name] of [["SELECT id FROM push_outbox WHERE status='pending' AND next_at<=100", "push_outbox_pending"], ["SELECT id FROM action_deliveries WHERE bot_id='bot' AND status='pending' ORDER BY created_at", "action_deliveries_pending"]])
    expect(JSON.stringify(await store.db.all(`EXPLAIN QUERY PLAN ${sql}`))).toContain(name);
});
it("exports a consistent database and attachment set, and GC preserves referenced files", async () => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','test')");
  const c = await store.createConversation("owner", ["alpha"], "Files", "create"); const files = new HubAttachments(store, root); await files.initialize();
  const bytes = Buffer.from("saved attachment"); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ids: string[] = [];
  for (const name of ["kept.txt", "orphan.txt"]) { const { id } = await files.create("owner", { conversationId: c.id, name, mime: "text/plain", size: bytes.length, sha256 }); await files.putChunk("owner", id, 0, bytes); await files.complete("owner", id); ids.push(id); }
  await store.sendMessage("owner", { conversationId: c.id, clientMsgId: "msg", text: "Keep", attachments: [ids[0]!] });
  const maintenance = new HubMaintenance(store, root); const dest = path.join(root, "export"); expect(await maintenance.export(dest)).toEqual({ messages: 1, attachments: 2 });
  const copy = await HubDatabase.snapshot(path.join(dest, "hub.sqlite"));
  try { expect((await copy.get<{ count: number }>("SELECT COUNT(*) AS count FROM messages"))?.count).toBe(1); } finally { await copy.close(); }
  expect(await readFile(path.join(dest, "attachments", `${ids[0]}.blob`))).toEqual(bytes); if (process.platform !== "win32") expect((await stat(path.join(dest, "hub.sqlite"))).mode & 0o777).toBe(0o600);
  expect(await maintenance.collectOrphans(Date.now() + 1)).toBe(1);
  expect(await files.download({ userId: "owner" }, ids[0]!)).toBeDefined(); await expect(files.download({ userId: "owner" }, ids[1]!)).rejects.toThrow("attachment_not_found");
});
it("refuses a newer schema rather than modifying unknown state", async () => {
  await store.db.run("UPDATE meta SET value='999' WHERE key='schema_version'");
  await expect(HubStore.open(root)).rejects.toThrow("unsupported_hub_schema_version");
  expect((await store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe("999");
});
it("controls only the Hub through its private local socket", async () => {
  expect(await inspectHubService(root)).toEqual({ running: false }); let stopped = false;
  const status = { running: true as const, pid: process.pid, url: "http://127.0.0.1:8788", publicKey: "public" };
  const close = await startHubControl(root, status, () => { stopped = true; });
  try { expect(await inspectHubService(root)).toEqual({ ...status, controlCapabilities: ["target-stop"] }); if (process.platform !== "win32") expect((await stat(path.join(root, "hub-control.sock"))).mode & 0o777).toBe(0o600); await inspectHubService(root, "stop"); await new Promise((r) => setTimeout(r, 5)); expect(stopped).toBe(true); }
  finally { await close(); }
  expect(await inspectHubService(root)).toEqual({ running: false });
});

it("removes crash-leftover chunks only for completed attachments", async () => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','synthetic')");
  const conversation = await store.createConversation("owner", ["fixture"], "fixture");
  const attachments = new HubAttachments(store, root); await attachments.initialize();
  const { createHash } = await import("node:crypto"); const bytes = Buffer.from("fixture"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const make = (name: string) => attachments.create("owner", { conversationId: conversation.id, name, size: bytes.length, sha256, mime: "text/plain" });
  const done = await make("complete.txt"), pending = await make("pending.txt");
  await store.db.run("UPDATE attachments SET complete=1 WHERE id=?", [done.id]);
  const completeChunk = path.join(attachments.directory, `${done.id}.0.chunk`), pendingChunk = path.join(attachments.directory, `${pending.id}.0.chunk`), blob = path.join(attachments.directory, `${done.id}.blob`);
  await writeFile(completeChunk, bytes); await writeFile(pendingChunk, bytes); await writeFile(blob, bytes);
  await new HubMaintenance(store, root).collectOrphans(0);
  await expect(stat(completeChunk)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(pendingChunk)).toEqual(bytes); expect(await readFile(blob)).toEqual(bytes);
});

it("reclaims old blob and chunk files left after a prior GC database commit", async () => {
  const directory = path.join(root, "attachments"); await mkdir(directory);
  const stale = ["att_abandoned.blob", "att_abandoned.0.chunk"];
  for (const name of [...stale, "att_recent.blob", "operator-notes.txt"]) await writeFile(path.join(directory, name), "fixture");
  for (const name of stale) await utimes(path.join(directory, name), new Date(0), new Date(0));
  await new HubMaintenance(store, root).collectOrphans();
  expect((await readdir(directory)).sort()).toEqual(["att_recent.blob", "operator-notes.txt"]);
});

it("exports active attachments while tolerating a retired blob already unlinked by interrupted GC", async () => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','synthetic')");
  const conversation = await store.createConversation("owner", ["fixture"], "fixture", "export-retired");
  const files = new HubAttachments(store, root); await files.initialize();
  const bytes = Buffer.from("export bytes"), sha256 = createHash("sha256").update(bytes).digest("hex"), ids: string[] = [];
  for (const name of ["active.txt", "retired.txt"]) ids.push(await files.importForBot("fixture", { conversationId: conversation.id, name, mime: "text/plain", size: bytes.length, sha256 }, bytes));
  await store.db.run("INSERT INTO retired_attachments VALUES(?)", [ids[1]!]);
  await rm(path.join(files.directory, `${ids[1]}.blob`));
  const destination = path.join(root, "export-retired");
  expect(await new HubMaintenance(store, root).export(destination)).toEqual({ messages: 0, attachments: 1 });
  expect(await readdir(path.join(destination, "attachments"))).toEqual([`${ids[0]}.blob`]);
  expect(await readFile(path.join(destination, "attachments", `${ids[0]}.blob`))).toEqual(bytes);
});

it("keeps a durable retired row after unlink failure and rejects new references until the retry succeeds", async () => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','synthetic')");
  const conversation = await store.createConversation("owner", ["fixture"], "fixture", "gc-retry");
  const files = new HubAttachments(store, root); await files.initialize();
  const bytes = Buffer.from("retry me"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = await files.importForBot("fixture", { conversationId: conversation.id, name: "retry.txt", mime: "text/plain", size: bytes.length, sha256 }, bytes);
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
  const fail = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (String(target) === path.join(files.directory, `${id}.blob`)) {
      await expect(store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "too-late", text: "attach", attachments: [id] })).rejects.toThrow("attachment_not_found");
      throw Object.assign(new Error("busy"), { code: "EPERM" });
    }
    return original(target, options);
  });
  const gc = new HubMaintenance(store, root);
  expect(await gc.collectOrphans(Date.now() + 1)).toBe(0);
  expect(await store.db.get("SELECT 1 FROM retired_attachments WHERE attachment_id=?", [id])).toBeDefined();
  expect(await readFile(path.join(files.directory, `${id}.blob`))).toEqual(bytes);
  fail.mockRestore();
  expect(await gc.collectOrphans(Date.now() + 1)).toBe(1);
  expect(await store.db.get("SELECT 1 FROM attachments WHERE id=?", [id])).toBeUndefined();
  await expect(stat(path.join(files.directory, `${id}.blob`))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["chunk", "complete"] as const)("does not publish a %s after GC retires an already-started upload", async phase => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','synthetic')");
  const conversation = await store.createConversation("owner", ["fixture"], "fixture", "gc-upload");
  const files = new HubAttachments(store, root); await files.initialize();
  const bytes = Buffer.from("in flight"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const { id } = await files.create("owner", { conversationId: conversation.id, name: "flight.txt", mime: "text/plain", size: bytes.length, sha256 });
  if (phase === "complete") await files.putChunk("owner", id, 0, bytes);
  await store.db.run("UPDATE attachments SET created_at=0 WHERE id=?", [id]);
  const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  const target = path.join(files.directory, phase === "chunk" ? `${id}.0.chunk.tmp` : `${id}.blob.tmp`);
  let retired = false;
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (String(args[0]) === target) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); await new HubMaintenance(store, root).collectOrphans(); retired = true; });
    }
    return handle;
  });
  await expect(phase === "chunk" ? files.putChunk("owner", id, 0, bytes) : files.complete("owner", id)).rejects.toThrow("upload_not_found");
  expect(retired).toBe(true); expect(await readdir(files.directory)).toEqual([]);
});
