import { isHubLogFile } from "./log-rotation.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { acquireInstanceLock, type InstanceLockHandle } from "../state/instance-lock.js";
import { withFileMutex } from "../state/file-mutex.js";
import { ConfigFileSchema } from "../state/config-file-schema.js";
import { SessionStateSchema } from "../state/session-state-schema.js";
import { idSchema } from "../client-protocol/index.js";
import { hashSecret } from "./auth.js";
import { HubDatabase } from "./database.js";
import { hubConfigSchema } from "./config.js";
import { assertHostRuntimeCompatible, requireExistingHostState } from "../host-cli/schema-guard.js";

// Directory bundles avoid the instance archive's 100 MiB member limit: Hub
// attachments may be much larger. Bodies are copied and hashed in 256 KiB blocks.
const MAX_ENTRIES = 100_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 ** 4;
const safePath = z.string().min(1).max(4096).refine((value) => value.split("/").every((part) =>
  !!part && part !== "." && part !== ".." && !/[\\:\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
), "unsafe backup member path");
const fileEntry = z.object({ type: z.literal("file"), path: safePath, size: z.number().int().min(0).max(MAX_TOTAL_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/), executable: z.boolean() }).strict();
const entrySchema = z.discriminatedUnion("type", [fileEntry, z.object({ type: z.literal("directory"), path: safePath }).strict(), z.object({ type: z.literal("symlink"), path: safePath, target: z.string().min(1).max(4096).refine((v) => !v.includes("\0")) }).strict()]);
export const hubBackupSchema = z.object({
  format: z.literal("tarocub-hub-state"), version: z.literal(1), createdAt: z.string().datetime(),
  sourceDirectory: z.string().min(1).max(4096).refine(path.isAbsolute),
  entries: z.array(entrySchema).max(MAX_ENTRIES),
  excluded: z.array(safePath).max(MAX_ENTRIES),
  externalPaths: z.array(z.string().min(1).max(4096)).max(MAX_ENTRIES),
  unmanagedBots: z.array(idSchema).max(MAX_ENTRIES),
  engineStateIsExternal: z.literal(true),
}).strict();
export type HubStateBackup = z.infer<typeof hubBackupSchema>;
type Entry = HubStateBackup["entries"][number];
type ManagedBot = { bot_id: string; secret_hash: string };

function inside(parent: string, child: string): boolean { const rel = path.relative(parent, child); return rel === "" || !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel); }
async function exists(file: string): Promise<boolean> { return lstat(file).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return false; throw e; }); }
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(file) === file) throw error; return path.join(await canonical(path.dirname(file)), path.basename(file)); }
}
async function regular(file: string): Promise<void> { if (!(await lstat(file)).isFile()) throw new Error("hub_backup_requires_regular_file"); }
function transient(relative: string): boolean {
  const parts = relative.split("/"), name = parts.at(-1)!;
  // Workspace files are user data, even when named *.lock or *.log.
  if (parts[0] === "bots" && parts[2] === "workspace") return false;
  return ["backups", "host-service", "cli", "runtimes", "media-transcripts"].includes(parts[0]!) || ["host-runtime.json", "update-in-progress.json", "last-exit.json", "host-service.json", "host-service-refresh.json", "hub-control.key"].includes(relative) || name === "instance.lock.json" || name.endsWith(".lock") || name.endsWith(".sock") ||
    relative === "hub.sqlite-wal" || relative === "hub.sqlite-shm" || isHubLogFile(relative) || relative === "restore.incomplete.json";
}

/** Validate the complete tree before creating any restoration destination. */
function validateManifest(input: unknown): HubStateBackup {
  const manifest = hubBackupSchema.parse(input), byPath = new Map<string, Entry>(); let total = 0;
  for (const entry of manifest.entries) {
    const key = entry.path.normalize("NFC").toLowerCase();
    if (byPath.has(key) || transient(entry.path)) throw new Error("hub_backup_invalid_member");
    byPath.set(key, entry);
    if (entry.type === "file") { total += entry.size; if (total > MAX_TOTAL_BYTES) throw new Error("hub_backup_size_limit"); }
    // Links are preserved, never followed. State roots/credentials must be real
    // directories/files; only workspace content may contain symbolic links.
    if (entry.type === "symlink" && !/^bots\/[^/]+\/workspace\/.+/.test(entry.path)) throw new Error("hub_backup_state_symlink");
  }
  for (const entry of manifest.entries) {
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && byPath.get(parent.normalize("NFC").toLowerCase())?.type !== "directory") throw new Error("hub_backup_invalid_parent");
  }
  for (const name of ["hub.sqlite", "identity.json"]) if (byPath.get(name)?.type !== "file") throw new Error("hub_backup_missing_state");
  return manifest;
}

async function readSmallJson(file: string): Promise<unknown> {
  await regular(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const size = (await handle.stat()).size; if (size > MAX_MANIFEST_BYTES) throw new Error("hub_backup_manifest_size_limit");
    // The extra byte detects a file growing after stat without an unbounded read.
    const buffer = Buffer.alloc(size + 1); let read = 0;
    while (read < buffer.length) { const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read); if (!bytesRead) break; read += bytesRead; }
    if (read !== size) throw new Error("hub_backup_file_changed");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally { await handle.close(); }
}

async function copyVerified(source: string, destination: string, expected?: z.infer<typeof fileEntry>): Promise<z.infer<typeof fileEntry>> {
  await regular(source);
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > MAX_TOTAL_BYTES || expected && before.size !== expected.size) throw new Error("hub_backup_file_size_mismatch");
    const executable = expected?.executable ?? !!(before.mode & 0o100);
    const output = await open(destination, "wx", executable ? 0o700 : 0o600);
    const hash = createHash("sha256"); let count = 0;
    try {
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        count += bytesRead; if (count > before.size) throw new Error("hub_backup_file_changed");
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); await output.writeFile(chunk);
      }
      const after = await input.stat(), sha256 = hash.digest("hex");
      if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("hub_backup_file_changed");
      if (expected && sha256 !== expected.sha256) throw new Error("hub_backup_checksum_mismatch");
      await output.sync();
      return { type: "file", path: expected?.path ?? path.basename(destination), size: count, sha256, executable };
    } finally { await output.close(); }
  } finally { await input.close(); }
}

async function inspectState(directory: string): Promise<{ bots: ManagedBot[]; unmanagedBots: string[]; externalPaths: string[] }> {
  await regular(path.join(directory, "hub.sqlite")); await regular(path.join(directory, "identity.json"));
  const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
  const paths = new Set<string>(), relativeDependencies = new Set<string>();
  const configuredPath = (value: string | undefined) => { if (value) { if (path.isAbsolute(value)) paths.add(value); else relativeDependencies.add(value); } };
  const collectPaths = (value: unknown) => {
    if (typeof value === "string" && path.isAbsolute(value)) paths.add(value);
    else if (Array.isArray(value)) value.forEach(collectPaths);
    else if (value && typeof value === "object") Object.values(value).forEach(collectPaths);
  };
  try {
    if (!["8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25"].includes((await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value ?? "")) throw new Error("unsupported_hub_schema_version");
    if ((await db.get<{ quick_check: string }>("PRAGMA quick_check"))?.quick_check !== "ok" || (await db.all("PRAGMA foreign_key_check")).length) throw new Error("hub_backup_database_invalid");
    await readSmallJson(path.join(directory, "identity.json"));
    await requireExistingHostState(directory);
    const bots = await db.all<ManagedBot>("SELECT m.bot_id,b.secret_hash FROM managed_bots m JOIN bots b ON b.id=m.bot_id");
    if (bots.length && !(await lstat(path.join(directory, "bots"))).isDirectory()) throw new Error("hub_backup_missing_bot_state");
    for (const bot of bots) {
      idSchema.parse(bot.bot_id);
      const botDir = path.join(directory, "bots", bot.bot_id);
      if (!(await lstat(botDir)).isDirectory()) throw new Error("hub_backup_missing_bot_state");
      const keyFile = path.join(botDir, "gateway.key"); await regular(keyFile);
      if ((await lstat(keyFile)).size > 1024 || hashSecret((await readFile(keyFile, "utf8")).trim()) !== bot.secret_hash) throw new Error("bot_key_mismatch");
      const settings = ConfigFileSchema.parse(await readSmallJson(path.join(botDir, "config.json")));
      collectPaths(settings); configuredPath(settings.workspacePath); configuredPath(settings.resume?.workspacePath);
      for (const profile of settings.workspaceProfiles ?? []) configuredPath(profile.path);
      const sessions = path.join(botDir, "session.json");
      if (await exists(sessions)) collectPaths(SessionStateSchema.parse(await readSmallJson(sessions)));
    }
    const config = path.join(directory, "config.json"); if (await exists(config)) {
      const value = await readSmallJson(config), settings = hubConfigSchema.parse(value); collectPaths(value);
      for (const file of [settings.clientDir, settings.gdocs?.clientFile, settings.push?.apns?.keyFile, settings.push?.fcm?.serviceAccountFile, settings.push?.webpush?.privateKeyFile]) configuredPath(file);
      for (const tls of [settings.tls, ...settings.tlsListeners.map((listener) => listener.tls)]) {
        if (tls) for (const pair of [tls, ...Object.values(tls.sni ?? {})]) { configuredPath(pair.cert); configuredPath(pair.key); }
      }
      if (settings.relay) for (const file of Object.values(settings.relay.tls)) configuredPath(file);
      for (const relay of settings.relays ?? []) for (const file of Object.values(relay.tls)) configuredPath(file);
    }
    const unmanagedBots = (await db.all<{ id: string }>("SELECT id FROM bots WHERE id NOT IN (SELECT bot_id FROM managed_bots)")).map((b) => idSchema.parse(b.id));
    // Relative config paths depend on the service's working directory; report
    // them verbatim instead of guessing the backup CLI's cwd is the same.
    const externalPaths: string[] = [...relativeDependencies];
    for (const value of paths) if (!inside(directory, await canonical(value))) externalPaths.push(value);
    return { bots, unmanagedBots, externalPaths: externalPaths.sort() };
  } finally { await db.close(); }
}

async function validateAttachments(directory: string, entries: Entry[]): Promise<void> {
  const members = new Map(entries.map((entry) => [entry.path, entry]));
  const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
  try {
    // A crash during GC may leave retired rows whose files were already
    // unlinked. Legacy read-only snapshots predate the retirement table.
    const hasRetired = await db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_attachments'");
    const active = hasRetired ? " AND NOT EXISTS(SELECT 1 FROM retired_attachments r WHERE r.attachment_id=a.id)" : "";
    const verify = (member: string, size: number, sha256: string) => {
      const entry = members.get(`attachments/${member}`);
      if (entry?.type !== "file" || entry.size !== size || entry.sha256 !== sha256) throw new Error("hub_backup_attachment_mismatch");
    };
    for (const row of await db.all<{ id: string; stored_name: string; size: number; sha256: string }>("SELECT a.id,a.stored_name,a.size,a.sha256 FROM attachments a WHERE a.complete=1" + active)) {
      idSchema.parse(row.id); if (row.stored_name !== `${row.id}.blob`) throw new Error("hub_backup_invalid_attachment_path");
      verify(row.stored_name, row.size, row.sha256);
    }
    for (const row of await db.all<{ attachment_id: string; chunk_index: number; size: number; sha256: string }>("SELECT c.* FROM upload_chunks c JOIN attachments a ON a.id=c.attachment_id WHERE a.complete=0" + active)) {
      idSchema.parse(row.attachment_id); z.number().int().nonnegative().parse(row.chunk_index);
      verify(`${row.attachment_id}.${row.chunk_index}.chunk`, row.size, row.sha256);
    }
  } finally { await db.close(); }
}

/** Offline snapshot: locks are acquired, never a request to stop live services.
 * Same-path restore intentionally preserves native engine workspace identities. */
export async function backupHubState(source: string, destination: string): Promise<HubStateBackup> {
  source = await realpath(source); destination = path.resolve(destination);
  await regular(path.join(source, "hub.sqlite")); await regular(path.join(source, "identity.json"));
  const parent = await realpath(path.dirname(destination)); destination = path.join(parent, path.basename(destination));
  if (inside(source, destination)) throw new Error("hub_backup_destination_inside_state");
  await assertHostRuntimeCompatible(source, fileURLToPath(new URL("../index.js", import.meta.url)), { allowMigration: true });
  const locks: InstanceLockHandle[] = []; let created = false;
  try {
    locks.push(await acquireInstanceLock(source));
    return await withFileMutex(path.join(source, "maintenance"), async () => {
      const state = await inspectState(source);
      // Also cover retained orphan instance directories: their state must never
      // be copied while an independently launched worker still owns its lock.
      if (await exists(path.join(source, "bots"))) for (const name of await readdir(path.join(source, "bots"))) {
        const dir = path.join(source, "bots", name); if ((await lstat(dir)).isDirectory()) locks.push(await acquireInstanceLock(dir));
      }
      await mkdir(destination, { mode: 0o700 }); created = true;
      const payload = path.join(destination, "state"); await mkdir(payload, { mode: 0o700 });
      const database = await HubDatabase.snapshot(path.join(source, "hub.sqlite"));
      try {
        // VACUUM INTO reads a consistent SQLite snapshot from this READONLY
        // connection; it neither checkpoints the source nor runs migrations.
        await database.run("VACUUM INTO ?", [path.join(payload, "hub.sqlite")]);
        await chmod(path.join(payload, "hub.sqlite"), 0o600);
      } finally { await database.close(); }
      const manifest: HubStateBackup = { format: "tarocub-hub-state", version: 1, createdAt: new Date().toISOString(), sourceDirectory: source, entries: [], excluded: [], externalPaths: state.externalPaths, unmanagedBots: state.unmanagedBots, engineStateIsExternal: true };
      let total = 0;
      const add = (entry: Entry) => { manifest.entries.push(entry); if (manifest.entries.length > MAX_ENTRIES) throw new Error("hub_backup_entry_limit"); if (entry.type === "file") { total += entry.size; if (total > MAX_TOTAL_BYTES) throw new Error("hub_backup_size_limit"); } };
      const walk = async (relative: string): Promise<void> => {
        for (const name of (await readdir(path.join(source, relative))).sort()) {
          const member = relative ? `${relative}/${name}` : name; safePath.parse(member);
          if (transient(member)) { manifest.excluded.push(member); continue; }
          const file = path.join(source, member), target = path.join(payload, member), info = await lstat(file);
          if (info.isSymbolicLink()) {
            const linkTarget = await readlink(file); add({ type: "symlink", path: member, target: linkTarget });
            const resolved = path.resolve(path.dirname(file), linkTarget); if (!inside(source, await canonical(resolved))) manifest.externalPaths.push(resolved);
          } else if (info.isDirectory()) {
            await mkdir(target, { mode: 0o700 }); add({ type: "directory", path: member }); await walk(member);
          } else if (info.isFile()) {
            if (member === "hub.sqlite") {
              // Hash the checkpointed snapshot, not the live database/WAL pair.
              const temporary = path.join(destination, "database-copy"); const entry = await copyVerified(target, temporary); await rename(temporary, target); add({ ...entry, path: member });
            } else add({ ...await copyVerified(file, target), path: member });
          } else throw new Error(`hub_backup_unsupported_file: ${member}`);
        }
      };
      await walk(""); manifest.externalPaths = [...new Set(manifest.externalPaths)].sort(); validateManifest(manifest);
      await inspectState(payload); await validateAttachments(payload, manifest.entries);
      const json = JSON.stringify(manifest, null, 2); if (Buffer.byteLength(json) + 1 > MAX_MANIFEST_BYTES) throw new Error("hub_backup_manifest_size_limit");
      const handle = await open(path.join(destination, "manifest.tmp"), "wx", 0o600);
      try { await handle.writeFile(json + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(path.join(destination, "manifest.tmp"), path.join(destination, "manifest.json"));
      // The durable manifest is the completion record; do not mutate the
      // source audit log from this read-only backup operation.
      return manifest;
    });
  } catch (error) { if (created) await rm(destination, { recursive: true, force: true }); throw error; }
  finally { for (const lock of locks.reverse()) await lock.release(); }
}

export async function restoreHubState(backup: string, destination: string): Promise<HubStateBackup> {
  backup = await realpath(backup);
  const manifest = validateManifest(await readSmallJson(path.join(backup, "manifest.json")));
  destination = path.join(await realpath(path.dirname(path.resolve(destination))), path.basename(destination));
  if (destination !== manifest.sourceDirectory) throw new Error("hub_restore_requires_original_path");
  if (inside(destination, backup) || inside(backup, destination)) throw new Error("hub_restore_overlapping_paths");
  const payload = path.join(backup, "state"); if (!(await lstat(payload)).isDirectory()) throw new Error("hub_backup_invalid_payload");
  await (await import("../host-cli/service-manager.js")).assertNoManagedServiceRegistration(destination);
  // Creating an empty destination is exclusive: never merge into or replace
  // any existing state, including an existing empty directory or symlink.
  await mkdir(destination, { mode: 0o700 }); let lock: InstanceLockHandle | undefined;
  try {
    lock = await acquireInstanceLock(destination);
    await writeFile(path.join(destination, "restore.incomplete.json"), JSON.stringify({ version: 1 }), { flag: "wx", mode: 0o600 });
    for (const entry of [...manifest.entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length)) {
      const target = path.join(destination, entry.path);
      if (entry.type === "directory") await mkdir(target, { mode: 0o700 });
      else if (entry.type === "file") {
        const source = path.join(payload, entry.path);
        if (!inside(payload, await realpath(path.dirname(source)))) throw new Error("hub_backup_payload_escape");
        await copyVerified(source, target, entry);
      }
    }
    await inspectState(destination); await validateAttachments(destination, manifest.entries);
    // Links are created only after all regular files and validation. No archive
    // member can traverse a link to write outside the destination.
    for (const entry of manifest.entries) if (entry.type === "symlink") await symlink(entry.target, path.join(destination, entry.path));
    await HubDatabase.markRestored(path.join(destination, "hub.sqlite"));
    await rm(path.join(destination, "restore.incomplete.json"));
    return manifest;
  } catch (error) {
    // If another starter won the instance lock, it owns the directory now.
    // Never remove its new state while reporting our failed restore.
    if (lock) {
      // Move the failed tree (including our lock) aside atomically before
      // deleting it. A new Hub starter can then create the original path
      // without racing a recursive cleanup of that same path.
      const failed = path.join(path.dirname(destination), `.hub-restore-failed-${randomUUID()}`);
      await rename(destination, failed); lock = undefined; await rm(failed, { recursive: true, force: true });
    }
    throw error;
  }
  finally { await lock?.release(); }
}
