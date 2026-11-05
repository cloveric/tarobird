import { assignNewBotAvatar } from "../src/hub/bot-avatar-default.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { HubAvatars } from "../src/hub/avatars.js";
import { avatarDataUrl, avatarFixture } from "./helpers/avatar-fixture.js";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backupHubState, restoreHubState, type HubStateBackup } from "../src/hub/state-backup.js";
import { HubAuth, deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { HubStore } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubAttachments } from "../src/hub/attachments.js";
import { HubServer } from "../src/hub/server.js";
import { runHubCli } from "../src/hub/cli.js";
import { acquireInstanceLock } from "../src/state/instance-lock.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { readDeliveryObligationContent, readDeliveryObligations, recordDeliveryObligation } from "../src/state/delivery-obligation-store.js";

let root: string, source: string, bundle: string, botDir: string, conversationId: string, attachmentId: string, pendingId: string, publicKey: string;

it("excludes machine service registration and CLI credentials without dropping similarly named workspace files", async () => {
  await mkdir(path.join(source, "host-service"), { recursive: true });
  await mkdir(path.join(source, "cli"), { recursive: true });
  for (const file of ["host-service.json", "host-service-refresh.json", "hub-control.key", "host-service/launch.plist", "cli/identity.json"]) await writeFile(path.join(source, file), "machine-only");
  await writeFile(path.join(botDir, "workspace", "host-service.json"), "user project");
  const manifest = await backupHubState(source, bundle);
  const names = manifest.entries.map(entry => entry.path);
  expect(names).not.toContain("host-service.json"); expect(names).not.toContain("host-service"); expect(names).not.toContain("cli"); expect(names).not.toContain("hub-control.key");
  expect(names).toContain(`bots/${botId}/workspace/host-service.json`);
});
const botId = "client_test_backup", bytes = Buffer.from("保留附件内容"), deviceKeys = generateKeyPairSync("ed25519");
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-backup-")); source = path.join(root, "hub"); bundle = path.join(root, "bundle"); botDir = path.join(source, "bots", botId);
  const store = await HubStore.open(source);
  try {
    await new HubAvatars(store).set("owner", { kind: "user", id: "owner" }, { expectedRevision: 0, dataUrl: avatarDataUrl() });
    const auth = await HubAuth.open(store, source); publicKey = auth.publicKey;
    const pair = await auth.pair({ deviceId: "trusted_device", name: "Desktop", platform: "macos", publicKey: deviceKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "local"); await auth.approve(pair.code, "local-owner");
    const secret = randomBytes(32).toString("base64url");
    await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort) VALUES(?,?,?,?,?,?)", [botId, "Backup Bot", hashSecret(secret), "codex", "gpt-6-astra", "high"]);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('external','External','outside-key-hash')");
    const spec = { requestId: "create_backup", name: "Backup Bot", engine: "codex", model: "gpt-6-astra", effort: "high", workspace: "" };
    await store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [botId, "owner", spec.requestId, JSON.stringify(spec)]);
    const conversation = await store.createConversation("owner", [botId], "Preserved session", "new"); conversationId = conversation.id;
    await mkdir(path.join(botDir, "workspace"), { recursive: true });
    await writeFile(path.join(botDir, "gateway.key"), secret, { mode: 0o600 });
    await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-6-astra", effort: "high", workspacePath: path.join(botDir, "workspace") }));
    await writeFile(path.join(botDir, "session.json"), JSON.stringify({ chats: [{ telegramChatId: 1, conversationKey: `lark:${conversationId}`, codexSessionId: "native-session-preserved", status: "idle", updatedAt: new Date().toISOString() }] }));
    await writeFile(path.join(botDir, "workspace", "report.md"), "# Unchanged project\n");
    await writeFile(path.join(botDir, "workspace", "package.lock"), "Keep workspace lock files");
    await writeFile(path.join(botDir, "workspace", "script.sh"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(botDir, "workspace", "script.sh"), 0o700);
    await new GatewayReceipts(botDir).run("already_done", async () => ({ saved: true }));
    await new GatewayReceipts(path.join(source, "bot-operations", botId)).run("restart:before_backup", async () => ({ ok: true, result: { text: "already queued" } }));
    const attachments = new HubAttachments(store, source); await attachments.initialize();
    const input = { conversationId, name: "kept.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    attachmentId = (await attachments.create("owner", input)).id; await attachments.putChunk("owner", attachmentId, 0, bytes); await attachments.complete("owner", attachmentId);
    pendingId = (await attachments.create("owner", { ...input, name: "upload-in-progress.txt" })).id; await attachments.putChunk("owner", pendingId, 0, bytes);
    await store.sendMessage("owner", { conversationId, clientMsgId: "saved", text: "保存聊天", attachments: [attachmentId] });
  } finally { await store.db.close(); }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function hideSource(): Promise<void> { await rename(source, path.join(root, "original-preserved")); }
async function changeManifest(change: (manifest: HubStateBackup) => void): Promise<void> { const manifest = JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")); change(manifest); await writeFile(path.join(bundle, "manifest.json"), JSON.stringify(manifest)); }

it("restores identity, trusted devices, Bot credentials/session, workspace, receipts and unfinished uploads", async () => {
  await mkdir(path.join(source, "backups")); await writeFile(path.join(source, "backups", "old.sqlite"), "excluded snapshot");
  await mkdir(path.join(source, "media-transcripts")); await writeFile(path.join(source, "media-transcripts", "cached.json"), "private transient transcript");
  await writeFile(path.join(source, "hub.log"), "excluded operational log");
  await writeFile(path.join(source, "hub.log.1"), "excluded rotated operational log");
  const fileLabels = JSON.stringify({ version: 1, revision: 1, units: { ["f".repeat(24)]: { important: true, note: "Keep the shared file label", revision: 1, updatedAt: new Date().toISOString() } } });
  await writeFile(path.join(source, "file-center-labels.json"), fileLabels, { mode: 0o600 });
  const longReply = "备份保留长回复🙂".repeat(30000);
  await recordDeliveryObligation(botDir, { channel: "lark", chatId: conversationId, allowLargeContent: true, content: longReply });
  const before = await HubStore.open(source);
  await before.db.transaction(() => assignNewBotAvatar(before.db, botId));
  const assigned = (await before.bots("owner")).find(bot => bot.id === botId)?.defaultAvatar;
  expect(assigned).toBeDefined();
  await before.db.run("INSERT INTO push_bindings VALUES('trusted_device','apns','preserved-consent')");
  const processRecord = createRunRecord(); recordRunEvent(processRecord, { type: "tool_use", toolName: "Read", toolUseId: "preserved" }); recordRunEvent(processRecord, { type: "tool_result", toolUseId: "preserved", output: "preserved process detail" });
  await new RunJournal(before).write(botId, { conversationId, messageId: "process_backup", runId: processRecord.id, entries: processRecord.entries });
  await before.publishBotMessage(botId, { id: "process_backup", conversationId, blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(processRecord, "done"))) } }] });
  await before.db.close();
  const manifest = await backupHubState(source, bundle);
  expect(manifest.unmanagedBots).toEqual(["external"]); expect(manifest.engineStateIsExternal).toBe(true);
  expect(manifest.excluded).toEqual(expect.arrayContaining(["instance.lock.json", "maintenance.mutex.lock", "backups", "media-transcripts", "hub.log", "hub.log.1", `bots/${botId}/instance.lock.json`]));
  expect(manifest.externalPaths).toEqual([]);
  const session = await readFile(path.join(botDir, "session.json"));
  await hideSource(); await restoreHubState(bundle, source);
  await expect(lstat(path.join(source, "media-transcripts"))).rejects.toMatchObject({ code: "ENOENT" });
  const store = await HubStore.open(source);
  try {
    expect(await new HubAvatars(store).image("owner", { kind: "user", id: "owner" }, 1)).toEqual(avatarFixture());
    const auth = await HubAuth.open(store, source); expect(auth.publicKey).toBe(publicKey);
    const challenge = await auth.challenge("connection", "trusted_device", "nonce", "local");
    const proof = sign(null, deviceProof("trusted_device", challenge.nonce, "nonce"), deviceKeys.privateKey).toString("base64");
    expect((await auth.authenticate("connection", proof)).userId).toBe("owner");
    expect((await store.snapshot("owner", conversationId)).messages[0]?.blocks).toContainEqual({ type: "text", text: "保存聊天" });
    expect((await new RunJournal(store).read("owner", "process_backup", 0)).entries[0]!.output).toBe("preserved process detail");
    expect((await store.bots("owner")).find(bot => bot.id === botId)?.defaultAvatar).toBe(assigned);
    const attachments = new HubAttachments(store, source);
    expect(await readFile((await attachments.download({ userId: "owner" }, attachmentId)).path)).toEqual(bytes);
    expect((await attachments.status("owner", pendingId)).chunks).toEqual([0]); await attachments.complete("owner", pendingId);
    expect(await readFile((await attachments.download({ userId: "owner" }, pendingId)).path)).toEqual(bytes);
  } finally { await store.db.close(); }
  expect(await readFile(path.join(botDir, "session.json"))).toEqual(session);
  expect(await readFile(path.join(source, "file-center-labels.json"), "utf8")).toBe(fileLabels);
  expect(await readDeliveryObligationContent(botDir, (await readDeliveryObligations(botDir))[0]!)).toBe(longReply);
  const run = vi.fn(); expect(await new GatewayReceipts(botDir).run("already_done", run)).toEqual({ ok: true, result: { saved: true } }); expect(run).not.toHaveBeenCalled();
  expect(await new GatewayReceipts(path.join(source, "bot-operations", botId)).run("restart:before_backup", run)).toEqual({ ok: true, result: { ok: true, result: { text: "already queued" } } }); expect(run).not.toHaveBeenCalled();
  expect(await readFile(path.join(botDir, "workspace", "package.lock"), "utf8")).toContain("Keep");
  for (const file of ["identity.json", "file-center-labels.json", `bots/${botId}/gateway.key`, `bots/${botId}/session.json`]) if (process.platform !== "win32") expect((await lstat(path.join(source, file))).mode & 0o777).toBe(0o600);
  if (process.platform !== "win32") expect((await lstat(path.join(botDir, "workspace", "script.sh"))).mode & 0o777).toBe(0o700);
  const hub = await HubServer.start({ stateDir: source, managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs") } });
  try { expect(await hub.store.db.get("SELECT provider,revision FROM push_bindings WHERE device_id='trusted_device'")).toEqual({ provider: "apns", revision: "preserved-consent" }); await vi.waitFor(async () => expect((await hub.store.bots("owner")).find((b) => b.id === botId)).toMatchObject({ online: 1, model: "gpt-6-astra", effort: "high" }), { timeout: 8000 }); }
  finally { await hub.close(); }
}, 30_000); // Full copy, restore, re-authentication and a real child-process boot.

it("refuses an active Hub or managed Bot without stopping it or producing a bundle", async () => {
  const hubLock = await acquireInstanceLock(source);
  try { await expect(backupHubState(source, bundle)).rejects.toThrow("Instance lock already held"); expect(await lstat(hubLock.filePath)).toBeDefined(); }
  finally { await hubLock.release(); }
  const botLock = await acquireInstanceLock(botDir);
  try { await expect(backupHubState(source, bundle)).rejects.toThrow("Instance lock already held"); expect(await lstat(botLock.filePath)).toBeDefined(); }
  finally { await botLock.release(); }
  await expect(lstat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
  await backupHubState(source, bundle); // Failed attempts released their Hub lock.
});

it("preserves attachment retirement through a full backup and restore", async () => {
  const store = await HubStore.open(source);
  let retiredId = "";
  try {
    const files = new HubAttachments(store, source);
    retiredId = (await files.create("owner", { conversationId, name: "recalled.txt", mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })).id;
    await files.putChunk("owner", retiredId, 0, bytes); await files.complete("owner", retiredId);
    const message = await store.publishBotMessage(botId, { conversationId, blocks: [{ type: "file", attachmentId: retiredId, name: "recalled.txt", mime: "text/plain", size: bytes.length }] });
    await store.publishBotMessage(botId, { id: message.id, conversationId, status: "deleted", blocks: [] });
  } finally { await store.db.close(); }
  await backupHubState(source, bundle); await hideSource(); await restoreHubState(bundle, source);
  const restored = await HubStore.open(source);
  try {
    const files = new HubAttachments(restored, source);
    await expect(files.download({ userId: "owner" }, retiredId)).rejects.toThrow("attachment_not_found");
    await expect(restored.sendMessage("owner", { conversationId, clientMsgId: "after-restore", text: "reuse", attachments: [retiredId] })).rejects.toThrow("attachment_not_found");
    expect(await readFile((await files.download({ userId: "owner" }, attachmentId)).path)).toEqual(bytes);
  } finally { await restored.db.close(); }
});

it("backs up and restores active files when interrupted GC left retired rows without blobs or chunks", async () => {
  const store = await HubStore.open(source), retired: string[] = [];
  try {
    const files = new HubAttachments(store, source);
    for (const complete of [true, false]) {
      const id = (await files.create("owner", { conversationId, name: `retired-${complete}.txt`, mime: "text/plain", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })).id;
      await files.putChunk("owner", id, 0, bytes); if (complete) await files.complete("owner", id);
      await store.db.run("INSERT INTO retired_attachments VALUES(?)", [id]);
      await rm(path.join(source, "attachments", complete ? `${id}.blob` : `${id}.0.chunk`)); retired.push(id);
    }
  } finally { await store.db.close(); }
  const manifest = await backupHubState(source, bundle);
  expect(manifest.entries.some(entry => retired.some(id => entry.path.startsWith(`attachments/${id}.`)))).toBe(false);
  await hideSource(); await restoreHubState(bundle, source);
  const restored = await HubStore.open(source);
  try {
    const files = new HubAttachments(restored, source);
    for (const id of retired) { expect(await restored.db.get("SELECT 1 FROM retired_attachments WHERE attachment_id=?", [id])).toBeDefined(); await expect(files.status("owner", id)).rejects.toThrow("upload_not_found"); }
    expect(await readFile((await files.download({ userId: "owner" }, attachmentId)).path)).toEqual(bytes);
    expect((await files.status("owner", pendingId)).chunks).toEqual([0]);
  } finally { await restored.db.close(); }
});

it("keeps validating legacy backup snapshots that have no retirement table", async () => {
  const store = await HubStore.open(source);
  try { await store.db.run("DROP TABLE retired_attachments"); await store.db.run("UPDATE meta SET value='9' WHERE key='schema_version'"); }
  finally { await store.db.close(); }
  await backupHubState(source, bundle); await hideSource(); await restoreHubState(bundle, source);
  expect(await readFile(path.join(source, "attachments", `${attachmentId}.blob`))).toEqual(bytes);
  expect(await readFile(path.join(source, "attachments", `${pendingId}.0.chunk`))).toEqual(bytes);
});

it("streams a file larger than the legacy instance archive limit without dropping it", async () => {
  const relative = `bots/${botId}/workspace/large-result.bin`, size = 101 * 1024 * 1024;
  const file = await open(path.join(source, relative), "w");
  try { await file.truncate(size); await file.write(Buffer.from("end"), 0, 3, size - 3); } finally { await file.close(); }
  const manifest = await backupHubState(source, bundle), entry = manifest.entries.find((e) => e.path === relative)!;
  expect(entry).toMatchObject({ type: "file", size });
  await hideSource(); await restoreHubState(bundle, source);
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path.join(source, relative))) hash.update(chunk);
  expect(entry).toMatchObject({ sha256: hash.digest("hex") });
}, 30_000);

it.each(["blob", "chunk"])("refuses a backup or restore missing a database-referenced %s", async (kind) => {
  const member = kind === "blob" ? `attachments/${attachmentId}.blob` : `attachments/${pendingId}.0.chunk`;
  await backupHubState(source, bundle);
  await changeManifest((manifest) => { manifest.entries = manifest.entries.filter((e) => e.path !== member); });
  await hideSource(); await expect(restoreHubState(bundle, source)).rejects.toThrow("attachment_mismatch");
  await rename(path.join(root, "original-preserved"), source);
  await rm(path.join(source, member));
  const missing = path.join(root, "missing-file-backup");
  await expect(backupHubState(source, missing)).rejects.toThrow("attachment_mismatch");
  await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports external dependencies and preserves workspace symlinks without copying their targets", async () => {
  const external = path.join(root, "external-workspace"); await mkdir(external); await writeFile(path.join(external, "private.txt"), "external bytes must not be copied");
  const config = JSON.parse(await readFile(path.join(botDir, "config.json"), "utf8")); config.workspaceProfiles = [{ name: "outside", path: external }]; await writeFile(path.join(botDir, "config.json"), JSON.stringify(config));
  await writeFile(path.join(source, "config.json"), JSON.stringify({ tls: { cert: "relative/cert.pem", key: "relative/key.pem" }, push: { fcm: { serviceAccountFile: "relative/fcm.json" } }, relays: [{ id: "backup", host: "backup.test", servername: "tunnel.test", targetPort: 9443, tls: { ca: "backup/ca.pem", cert: "backup/mac.pem", key: "backup/mac.key" } }] }));
  await symlink("report.md", path.join(botDir, "workspace", "report-link"));
  await symlink(path.join(external, "private.txt"), path.join(botDir, "workspace", "external-link"));
  const manifest = await backupHubState(source, bundle);
  expect(manifest.externalPaths).toEqual(expect.arrayContaining([external, path.join(external, "private.txt"), "relative/cert.pem", "relative/key.pem", "relative/fcm.json", "backup/ca.pem", "backup/mac.pem", "backup/mac.key"]));
  expect(manifest.entries.some((entry) => entry.path.includes("private.txt"))).toBe(false);
  await hideSource(); await restoreHubState(bundle, source);
  expect(await readlink(path.join(botDir, "workspace", "report-link"))).toBe("report.md");
  expect(await readlink(path.join(botDir, "workspace", "external-link"))).toBe(path.join(external, "private.txt"));
  expect(await readFile(path.join(external, "private.txt"), "utf8")).toBe("external bytes must not be copied");
});

it("rejects missing/key-mismatched Bot state, refuses nested destinations and never replaces an existing bundle", async () => {
  await expect(backupHubState(source, path.join(source, "nested"))).rejects.toThrow("destination_inside_state");
  await writeFile(path.join(botDir, "gateway.key"), "wrong key");
  await expect(backupHubState(source, bundle)).rejects.toThrow("bot_key_mismatch");
  await expect(lstat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(bundle); await writeFile(path.join(bundle, "sentinel"), "preserve");
  await expect(backupHubState(source, bundle)).rejects.toThrow();
  expect(await readFile(path.join(bundle, "sentinel"), "utf8")).toBe("preserve");
});

it("refuses relocation and existing destinations, and cleans only its own failed checksum restore", async () => {
  await backupHubState(source, bundle);
  await expect(restoreHubState(bundle, path.join(root, "different"))).rejects.toThrow("original_path");
  await expect(restoreHubState(bundle, source)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(path.join(botDir, "workspace", "report.md"), "utf8")).toContain("Unchanged");
  await hideSource();
  const file = path.join(bundle, "state", "bots", botId, "session.json"), original = await readFile(file); const corrupt = Buffer.from(original); corrupt[0] = 32; await writeFile(file, corrupt);
  await expect(restoreHubState(bundle, source)).rejects.toThrow("checksum_mismatch");
  await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(root, "original-preserved", "bots", botId, "session.json"))).toEqual(original);
  await writeFile(file, original); await restoreHubState(bundle, source);
});

it.each(["traversal", "duplicate", "link-parent", "missing-state", "oversize", "version"])("rejects a malformed %s manifest before writing state", async (fault) => {
  await backupHubState(source, bundle); await hideSource();
  await changeManifest((manifest) => {
    const file = manifest.entries.find((e) => e.type === "file")!;
    if (fault === "traversal") manifest.entries.push({ ...file, path: "../escape" });
    if (fault === "duplicate") manifest.entries.push({ ...file, path: file.path.toUpperCase() });
    if (fault === "link-parent") manifest.entries.push({ type: "file", path: `${file.path}/child`, size: 0, sha256: "a".repeat(64), executable: false });
    if (fault === "missing-state") manifest.entries = manifest.entries.filter((e) => e.path !== "identity.json");
    if (fault === "oversize") { if (file.type === "file") file.size = 1024 ** 4 + 1; }
    if (fault === "version") (manifest as { version: number }).version = 99;
  });
  await expect(restoreHubState(bundle, source)).rejects.toThrow(); await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects a payload directory symlink and prevents starting an interrupted restore", async () => {
  await backupHubState(source, bundle); await hideSource();
  const savedBots = path.join(bundle, "state", "bots"); await rename(savedBots, path.join(root, "outside-payload")); await symlink(path.join(root, "outside-payload"), savedBots);
  await expect(restoreHubState(bundle, source)).rejects.toThrow("payload_escape");
  await mkdir(source); await writeFile(path.join(source, "restore.incomplete.json"), "{}");
  await expect(HubServer.start({ stateDir: source })).rejects.toThrow("hub_restore_incomplete");
  expect(await readdir(source)).toEqual(["restore.incomplete.json"]);
});

it("routes full backup and restore CLI commands before opening or creating destination state", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await runHubCli(["backup", bundle, "--full", "--state-dir", source]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ restoreDirectory: await realpath(source), engineStateIsExternal: true, unmanagedBots: ["external"] });
    await hideSource(); await runHubCli(["restore", bundle, "--state-dir", source]);
    await expect(runHubCli(["restore", bundle])).rejects.toThrow("explicit --state-dir");
    await expect(runHubCli(["gc", "--full", "--state-dir", path.join(root, "missing")])).rejects.toThrow("--full is only supported");
    await expect(lstat(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { log.mockRestore(); }
});

it("retains deleted Bot history and workspace through backup without reactivating its worker", async () => {
  const store = await HubStore.open(source);
  try { await store.deleteBot("owner", botId, "Backup Bot"); } finally { await store.db.close(); }
  await backupHubState(source, bundle);
  await hideSource(); await restoreHubState(bundle, source);
  const hub = await HubServer.start({ stateDir: source, managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath } } });
  try {
    expect((await hub.store.bots("owner")).some(bot => bot.id === botId)).toBe(false);
    expect((await hub.store.bots("owner", true)).find(bot => bot.id === botId)).toMatchObject({ deletedAt: expect.any(Number), online: 0 });
    expect((await hub.store.conversations("owner")).find(chat => chat.id === conversationId)?.archived).toBe(true);
    expect(await readFile(path.join(source, "bots", botId, "workspace", "report.md"), "utf8")).toBe("# Unchanged project\n");
    expect(await hub.store.db.get("SELECT id FROM attachments WHERE id=?", [attachmentId])).toBeTruthy();
  } finally { await hub.close(); }
});


it("backs up an actual schema 13 DB through a read-only source without migrating it", async () => {
  const store = await HubStore.open(source);
  await store.db.exec("ALTER TABLE bots DROP COLUMN deleted_at");
  await store.db.run("UPDATE meta SET value='13' WHERE key='schema_version'");
  await store.db.close();
  const original = await readFile(path.join(source, "hub.sqlite"));
  await chmod(path.join(source, "hub.sqlite"), 0o400);
  await backupHubState(source, bundle);
  expect((await readFile(path.join(source, "hub.sqlite"))).equals(original)).toBe(true);
  const db = await HubDatabase.snapshot(path.join(bundle, "state", "hub.sqlite"));
  try {
    expect(await db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "13" });
    expect((await db.all<{ name: string }>("PRAGMA table_info(bots)")).some(column => column.name === "deleted_at")).toBe(false);
    expect(await db.get("SELECT name FROM bots WHERE id=?", [botId])).toEqual({ name: "Backup Bot" });
  } finally { await db.close(); }
});

it("preserves schema-24 assistance receipts, parent session and remaining allowance through backup and restore", async () => {
  const store = await HubStore.open(source);
  const parent = { botId, engine: "codex", model: "gpt-6.1-sol", effort: "high", conversationId };
  try {
    await store.db.run("INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,created_at,updated_at) VALUES('ticket',?,?,'request','Task','Request','queued',1,1)", [botId, conversationId]);
    await store.db.run(`INSERT INTO dispatch_assists(id,ticket_id,worker_bot_id,request_id,payload_hash,parent_attempt_id,parent_json,engine,model,effort,text,note,state,outcome,created_at,updated_at)
      VALUES('assist','ticket',?,'stable-assist','hash','parent',?,'claude','opus','medium','Bounded review','Reason','returned','completed',1,2)`, [botId, JSON.stringify(parent)]);
    await store.db.run("INSERT INTO dispatch_assist_windows VALUES('ticket','parent',0)");
  } finally { await store.db.close(); }
  const readLedger = async (directory: string) => {
    const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try { return {
      schema: await db.get("SELECT value FROM meta WHERE key='schema_version'"),
      assists: await db.all("SELECT * FROM dispatch_assists"),
      allowance: await db.all("SELECT * FROM dispatch_assist_windows"),
    }; } finally { await db.close(); }
  };
  const expected = await readLedger(source), original = await readFile(path.join(source, "hub.sqlite"));
  expect(expected.schema).toEqual({ value: "25" });
  await backupHubState(source, bundle);
  expect(await readFile(path.join(source, "hub.sqlite"))).toEqual(original);
  await hideSource();
  await restoreHubState(bundle, source);
  expect(await readLedger(source)).toEqual(expected);
  expect(JSON.parse(await readFile(path.join(botDir, "session.json"), "utf8")).chats[0].codexSessionId).toBe("native-session-preserved");
});

it("preserves paused inputs and mutation receipts through schema-25 backup and restore", async () => {
  const store = await HubStore.open(source);
  let messageId: string;
  try {
    const queue = new HubPromptQueue(store); await queue.registerWorker(botId, true);
    const before = await queue.read("owner", botId, conversationId); messageId = before.items[0].message.id;
    await queue.mutate("owner", conversationId, { botId, revision: before.revision, requestId: "pause-before-backup", action: { type: "pause", messageId } });
  } finally { await store.db.close(); }
  await backupHubState(source, bundle); await hideSource(); await restoreHubState(bundle, source);
  const restored = await HubStore.open(source);
  try {
    const queue = new HubPromptQueue(restored), after = await queue.read("owner", botId, conversationId);
    expect(after.items[0]).toMatchObject({ paused: true, canResume: true });
    expect(await queue.take(botId, conversationId, () => true)).toBeUndefined();
    expect(await restored.db.get("SELECT request_id FROM prompt_queue_mutations WHERE request_id='pause-before-backup'")).toBeTruthy();
    await queue.mutate("owner", conversationId, { botId, revision: after.revision, requestId: "resume-after-backup", action: { type: "resume", messageId } });
    expect((await queue.take(botId, conversationId, () => true))?.id).toBe(messageId);
  } finally { await restored.db.close(); }
});

it("refuses a newer schema before backup writes and leaves its database bytes unchanged", async () => {
  const store = await HubStore.open(source);
  await store.db.run("UPDATE meta SET value='26' WHERE key='schema_version'"); await store.db.close();
  const original = await readFile(path.join(source, "hub.sqlite")), files = (await readdir(source)).sort();
  await expect(backupHubState(source, bundle)).rejects.toThrow("host_schema_incompatible:26");
  expect((await readFile(path.join(source, "hub.sqlite"))).equals(original)).toBe(true);
  expect((await readdir(source)).filter(file => !["hub.sqlite-shm", "hub.sqlite-wal"].includes(file)).sort()).toEqual(files.filter(file => !["hub.sqlite-shm", "hub.sqlite-wal"].includes(file)));
  await expect(lstat(bundle)).rejects.toMatchObject({ code: "ENOENT" });
});


it("rotates the restore lineage again when restoring a backup of already restored state", async () => {
  const lineage = async () => {
    const db = await HubDatabase.snapshot(path.join(source, "hub.sqlite"));
    try { return (await db.get<{ value: string }>("SELECT value FROM meta WHERE key='sync_lineage'"))?.value; }
    finally { await db.close(); }
  };
  expect(await lineage()).toBeUndefined();
  await backupHubState(source, bundle); await hideSource(); await restoreHubState(bundle, source);
  const first = await lineage(); expect(first).toMatch(/^[0-9a-f-]{36}$/);
  const next = path.join(root, "next-bundle"); await backupHubState(source, next);
  expect(await lineage()).toBe(first); // Taking a backup never invalidates live cursors.
  await rename(source, path.join(root, "first-restored")); await restoreHubState(next, source);
  expect(await lineage()).toMatch(/^[0-9a-f-]{36}$/); expect(await lineage()).not.toBe(first);
});
