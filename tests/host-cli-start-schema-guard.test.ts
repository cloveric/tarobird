import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sqlite3 from "sqlite3";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import * as setup from "../src/host-cli/setup.js";
import * as runtime from "../src/host-cli/update.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as desktop from "../src/hub/desktop.js";
import { HubDatabase } from "../src/hub/database.js";
import { HubStore } from "../src/hub/store.js";
import { readHostSchema } from "../src/host-cli/schema-guard.js";

// Same commands as host-cli-start-migration.test.ts, but with the real schema
// guard reading a real database: only the host process itself is faked.
const roots: string[] = [];
async function hostAtSchema(schema: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t63-guard-")); roots.push(directory);
  const store = await HubStore.open(directory); await store.db.run("UPDATE meta SET value=? WHERE key='schema_version'", [String(schema)]); await store.db.close();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(setup, "requireInitialized").mockResolvedValue(undefined as never);
  // The repository package.json declares the runtime's schema range (1-28).
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: path.resolve("dist/src/index.js"), executable: process.execPath } as never);
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ deviceId: "cli_fixture", publicKey: "same-host", close: vi.fn() } as never);
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false } as never);
  const host = vi.spyOn(desktop, "desktopHost").mockImplementation(async action => (action === "status" ? { available: true, running: false } : { available: true, running: true, publicKey: "same-host" }) as never);
  return { directory, host };
}
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("start explains a database from a newer version before starting anything", async () => {
  const f = await hostAtSchema(29);
  const failure = runHostCli(["start", "--state-dir", f.directory]);
  await expect(failure).rejects.toThrow("来自更新版本的 TaroBird");
  await expect(failure).rejects.toThrow("数据库未修改");
  expect(f.host.mock.calls.map(call => call[0])).toEqual(["status"]);
  expect(LocalHostClient.connect).not.toHaveBeenCalled();
  expect(await readHostSchema(f.directory)).toBe(29);
});

it("restart explains a database from a newer version and does not stop the host", async () => {
  const f = await hostAtSchema(29);
  await expect(runHostCli(["restart", "--force", "--state-dir", f.directory])).rejects.toThrow("来自更新版本的 TaroBird");
  expect(f.host).not.toHaveBeenCalled();
});

it("restart of a desktop-managed host on an older database is admitted like start", async () => {
  const f = await hostAtSchema(26);
  await runHostCli(["restart", "--force", "--state-dir", f.directory]);
  expect(f.host.mock.calls.map(call => call[0])).toEqual(["stop", "status", "start"]);
});

async function schemaFixture(version: 26 | 27, schema: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t63-schema-")); roots.push(directory);
  const file = path.join(directory, "hub.sqlite");
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const sqlite = new sqlite3.Database(file, error => error ? reject(error) : resolve(sqlite));
  });
  try {
    const base = version === 27
      ? await readFile(new URL("./fixtures/hub-schema-v27.sql", import.meta.url), "utf8")
      : "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
    await new Promise<void>((resolve, reject) => db.exec(
      `${base}
       INSERT INTO meta VALUES('schema_version','${version}');
       ${schema}`,
      error => error ? reject(error) : resolve(),
    ));
  } finally {
    await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
  return directory;
}

it("opens a v27 cross-host group without rebuilding it and adds the v28 remote dispatch fields", async () => {
  const directory = await schemaFixture(27, `
    INSERT INTO users VALUES('owner','Owner','owner');
    INSERT INTO bots(id,name,secret_hash) VALUES('dispatcher','Fixture','fixture');
    INSERT INTO conversations(id,type,title,owner_id,created_at,workspace_path)
      VALUES('group','group','Fixture group','owner',1,'/example/workspace');
    INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,attempts_json,created_at,updated_at)
      VALUES('ticket','dispatcher','group','request','Review','Fixture','queued','[{"id":"old-attempt","botId":"dispatcher","engine":"codex","model":"","effort":"","conversationId":"group","inputMessageId":"fixture-input","startedAt":1}]',1,2);
    INSERT INTO group_discussion_settings VALUES('group','designated','["remote"]',3,'owner',2);
    INSERT INTO group_designated_member VALUES('group','remote');
    INSERT INTO group_session_members(conversation_id,group_id,member_key,kind,host_id,host_name,host_public_key,bot_id,session_id,session_title,name_snapshot,engine_snapshot,joined_at,joined_after_seq,history_visibility_json,history_backfilled)
      VALUES('group','group','remote','remote','other-host','Other Host','synthetic-fixture-public-key','remote-bot','remote-session','Remote session','Fixture Bot','codex',1,12,'{"kind":"recent","count":2}',1);
    CREATE INDEX fixture_group_settings_index ON group_discussion_settings(updated_at);
  `);
  expect(await readHostSchema(directory)).toBe(27);

  const db = await HubDatabase.open(directory);
  try {
    expect(await db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "28" });
    expect(await db.get("SELECT * FROM group_discussion_settings")).toEqual({
      group_id: "group", mode: "designated", order_json: '["remote"]', max_rounds: 3, updated_by: "owner", updated_at: 2,
    });
    expect(await db.get("SELECT name FROM sqlite_master WHERE name='fixture_group_settings_index'")).toBeDefined();
    expect(await db.get("SELECT member_key FROM group_designated_member")).toEqual({ member_key: "remote" });
    expect(await db.get("SELECT host_id,host_name,host_public_key,session_id,joined_after_seq,history_visibility_json,history_backfilled FROM group_session_members")).toEqual({
      host_id: "other-host", host_name: "Other Host", host_public_key: "synthetic-fixture-public-key", session_id: "remote-session",
      joined_after_seq: 12, history_visibility_json: '{"kind":"recent","count":2}', history_backfilled: 1,
    });
    expect(await db.get("SELECT workspace_path FROM conversations WHERE id='group'")).toEqual({ workspace_path: "/example/workspace" });
    expect(await db.get("SELECT attempts_json,batch_id,batch_index,batch_total,host_id,host_name,artifacts_json,plan_json FROM dispatch_tickets WHERE id='ticket'")).toEqual({
      attempts_json: '[{"id":"old-attempt","botId":"dispatcher","engine":"codex","model":"","effort":"","conversationId":"group","inputMessageId":"fixture-input","startedAt":1}]', batch_id: null, batch_index: null, batch_total: null,
      host_id: null, host_name: null, artifacts_json: null, plan_json: null,
    });
    await db.run("UPDATE dispatch_tickets SET host_id='other-host',host_name='Other Host',batch_id='batch',batch_index=0,batch_total=1 WHERE id='ticket'");
    await db.run(`INSERT INTO remote_dispatch_tickets(id,source_key,source_host_id,source_bot_id,remote_request_id,title,request,engine,model,effort,bot_id,conversation_id,input_message_id,status,stop_requested,created_at,updated_at)
      VALUES('inbound','synthetic-fixture-public-key','other-host','remote-bot','remote-request','Review','Fixture','codex','','','dispatcher','group','input','running','pause',2,3)`);
    expect(await db.all("PRAGMA foreign_key_check")).toEqual([]);
  } finally { await db.close(); }
  const reopened = await HubDatabase.open(directory);
  try {
    expect(await reopened.get("SELECT host_id,batch_id FROM dispatch_tickets WHERE id='ticket'")).toEqual({ host_id: "other-host", batch_id: "batch" });
    expect(await reopened.get("SELECT stop_requested FROM remote_dispatch_tickets WHERE id='inbound'")).toEqual({ stop_requested: "pause" });
  } finally { await reopened.close(); }
});

it("widens a pre-v27 group policy once and keeps new designated settings on reopen", async () => {
  const directory = await schemaFixture(26, `CREATE TABLE group_discussion_settings (
    group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('mentions','parallel','sequential','independent')),
    order_json TEXT NOT NULL, max_rounds INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO group_discussion_settings VALUES('group','parallel','[]',2,'owner',1);
    CREATE INDEX fixture_pre27_index ON group_discussion_settings(updated_at);
  `);
  const db = await HubDatabase.open(directory);
  try {
    expect(await db.get("SELECT mode FROM group_discussion_settings WHERE group_id='group'")).toEqual({ mode: "parallel" });
    expect(await db.get("SELECT name FROM sqlite_master WHERE name='fixture_pre27_index'")).toBeUndefined();
    await db.run("UPDATE group_discussion_settings SET mode='designated' WHERE group_id='group'");
    await db.exec("CREATE INDEX fixture_post28_index ON group_discussion_settings(updated_at)");
  } finally { await db.close(); }
  const reopened = await HubDatabase.open(directory);
  try {
    expect(await reopened.get("SELECT mode FROM group_discussion_settings WHERE group_id='group'")).toEqual({ mode: "designated" });
    expect(await reopened.get("SELECT name FROM sqlite_master WHERE name='fixture_post28_index'")).toBeDefined();
  } finally { await reopened.close(); }
});
