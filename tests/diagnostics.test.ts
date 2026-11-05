import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readBotDiagnostics } from "../src/runtime/diagnostics.js";
import { diagnosticPageSchema, diagnosticQuerySchema } from "../src/client-protocol/diagnostics.js";
import { readHubDiagnostics } from "../src/hub/diagnostics.js";
import { HubServer } from "../src/hub/server.js";
import { HubDatabase } from "../src/hub/database.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), "diagnostics-")); roots.push(value); return value; }
const event = (i: number, extra: object = {}) => ({ timestamp: new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString(), type: "turn.completed", outcome: "success", channel: "lark", chatId: 42, conversationKey: "lark:gw_example", detail: `Record ${i}`, ...extra });
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r) + "\n").join("");

it("compares UTC timestamps chronologically across fractional precision", async () => {
  const from = "2026-10-15T09:00:00Z", to = "2026-10-15T09:00:00.001Z";
  expect(diagnosticQuerySchema.safeParse({ from, to }).success).toBe(true);
  expect(diagnosticQuerySchema.safeParse({ from: to, to: from }).success).toBe(false);
  const dir = await root();
  await writeFile(path.join(dir, "timeline.log.jsonl"), jsonl([
    event(1, { timestamp: "2026-10-15T08:59:59.999Z" }),
    event(2, { timestamp: new Date(from).toISOString() }),
    event(3, { timestamp: "2026-10-15T09:00:00.000Z" }),
    event(4, { timestamp: to }),
    event(5, { timestamp: "2026-10-15T09:00:00.002Z" }),
  ]));
  expect((await readBotDiagnostics(dir, { from, to })).events.map(e => e.detail)).toEqual(["Record 4", "Record 3", "Record 2"]);
  expect((await readBotDiagnostics(dir, { to: from })).events.map(e => e.detail)).toEqual(["Record 3", "Record 2", "Record 1"]);
});

it("distinguishes a requested worker restart from a crash or process communication error", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  try {
    await hub.store.audit("bot.worker_stopped", null, { botId: "alpha", exitCode: 75 });
    await hub.store.audit("bot.worker_stopped", null, { botId: "alpha", exitCode: -1 });
    await hub.store.audit("bot.worker_error", null, { botId: "alpha", pid: 123 });
    const page = await readHubDiagnostics(hub.store, { source: "audit" });
    expect(page.events.map((event) => [event.type, event.outcome])).toEqual([
      ["bot.worker_error", "error"], ["bot.worker_stopped", "error"], ["bot.worker_stopped", "info"],
    ]);
  } finally { await hub.close(); }
});

it("reads all retained rotations, keeps cursor order across append/rotation and reports expiry", async () => {
  const dir = await root(), file = path.join(dir, "timeline.log.jsonl");
  await writeFile(file + ".1", jsonl([event(1), event(2)])); await writeFile(file, jsonl([event(3), event(4)]));
  const first = diagnosticPageSchema.parse(await readBotDiagnostics(dir, { source: "timeline", limit: 2 }));
  expect(first.events.map((e) => e.detail)).toEqual(["Record 4", "Record 3"]); expect(first.total).toBe(4); expect(first.next).toBe(first.events[1]!.id);
  await rename(file + ".1", file + ".2"); await rename(file, file + ".1"); await writeFile(file, jsonl([event(5)]));
  const second = await readBotDiagnostics(dir, { limit: 2, before: first.next });
  expect(second.events.map((e) => e.detail)).toEqual(["Record 2", "Record 1"]); expect(second.next).toBeNull(); expect(second.total).toBe(5);
  await rm(file + ".1"); expect(await readBotDiagnostics(dir, { before: first.next })).toMatchObject({ cursorExpired: true, events: [], next: null });
});

it("reuses timeline counters, filters App versus Feishu, dates, conversation and complete redacted detail", async () => {
  const dir = await root(); const file = path.join(dir, "timeline.log.jsonl");
  await writeFile(file, jsonl([
    event(1, { type: "turn.retried", outcome: "error", detail: "Authorization: Bearer fixture-hidden-secret" }),
    event(2, { type: "file.rejected", outcome: "error", conversationKey: "lark:oc_feishu" }),
    event(3, { type: "crew.run.failed", outcome: "error", metadata: { client_secret: "fixture-private", nested: { api_key: "fixture-key" } }, detail: "语".repeat(2400) + "后部搜索标记" }),
    event(4, { type: "engine.lock.waiting", outcome: "pending", metadata: { reason: "turn_pool" } }),
  ]));
  const all = await readBotDiagnostics(dir, {}); expect(all.counts).toMatchObject({ retryCount: 1, fileRejectedCount: 1, crewRunsFailedCount: 1, turnPoolWaitCount: 1 });
  expect(JSON.stringify(all)).not.toMatch(/fixture-hidden-secret|fixture-private|fixture-key/);
  expect((await readBotDiagnostics(dir, { channel: "gateway", outcome: "error" })).matched).toBe(2);
  expect((await readBotDiagnostics(dir, { chat: "42" })).matched).toBe(4);
  expect((await readBotDiagnostics(dir, { chat: "lark:oc_feishu" })).events.map((e) => e.type)).toEqual(["file.rejected"]);
  const searched = await readBotDiagnostics(dir, { search: "后部搜索标记", from: event(2).timestamp, to: event(3).timestamp });
  expect(searched.matched).toBe(1); expect(searched.events[0]!.truncated).toBe(true);
  expect((await readBotDiagnostics(dir, { search: "fixture-private" })).matched).toBe(0);
  expect(diagnosticQuerySchema.safeParse({ path: "/private" }).success).toBe(false);
  expect(diagnosticQuerySchema.safeParse({ from: event(3).timestamp, to: event(2).timestamp }).success).toBe(false);
  expect(diagnosticQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
});

it("skips corrupt, oversized and unfinished lines, refuses symlink logs and preserves disk content", async () => {
  const dir = await root(), external = path.join(dir, "outside.txt"), file = path.join(dir, "audit.log.jsonl");
  await writeFile(external, jsonl([event(0, { detail: "must not be exposed" })])); await symlink(external, file + ".1");
  const content = '{broken}\n' + JSON.stringify(event(1, { detail: "x".repeat(300000) })) + "\n" + jsonl([event(2)]) + '{"partial":';
  await writeFile(file, content);
  const page = await readBotDiagnostics(dir, { source: "audit" });
  expect(page.events.map((e) => e.detail)).toEqual(["Record 2"]); expect(page.warnings).toHaveLength(4);
  expect(page.warnings.join(" ")).toMatch(/格式损坏/); expect(page.warnings.join(" ")).toMatch(/256 KiB/);
  expect(await readFile(file, "utf8")).toBe(content);
  const empty = await root(); expect(await readBotDiagnostics(empty, {})).toMatchObject({ missing: true, events: [], total: 0 });
});

it("keeps Unicode split across chunks and a full page below the RPC frame budget", async () => {
  const dir = await root();
  await writeFile(path.join(dir, "timeline.log.jsonl"), jsonl(Array.from({ length: 90 }, (_, i) => event(i, { detail: "中文".repeat(25000), metadata: { description: "🙂".repeat(2500) } }))));
  const page = await readBotDiagnostics(dir, { limit: 50 });
  expect(page.total).toBe(90); expect(page.events).toHaveLength(50); expect(JSON.stringify(page)).not.toContain("�");
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024 * 1024); expect(page.warnings).toEqual([]);
  await writeFile(path.join(dir, "audit.log.jsonl"), jsonl(Array.from({ length: 200 }, (_, i) => event(i, { type: `${i}${"中".repeat(160)}`, outcome: `${i}${"中".repeat(80)}`, channel: `${i}${"中".repeat(40)}`, conversationKey: "中".repeat(200), userId: i, detail: "\ud800".repeat(2500), metadata: { detail: "中".repeat(2500) } }))));
  const adversarial = await readBotDiagnostics(dir, { source: "audit", limit: 50 });
  expect(adversarial.total).toBe(200); expect(Buffer.byteLength(JSON.stringify(adversarial))).toBeLessThan(1024 * 1024);
});

async function token(hub: HubServer, id: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner", userId); const challenge = await hub.auth.challenge(id, id, nonce, id);
  return (await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
}
it("gates real Hub/Gateway reads by owner/device/Bot and includes Hub audit with redaction and stable paging", async () => {
  const dir = await root(), stateDir = path.join(dir, "bot"); await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), "{}");
  await writeFile(path.join(stateDir, "timeline.log.jsonl"), jsonl([event(1), event(2)]));
  const hub = await HubServer.start({ stateDir: path.join(dir, "hub"), managedBots: { entrypoint: "unused-test-entrypoint" } }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.url.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  try {
    const owner = await token(hub, "desktop"), phone = await token(hub, "phone"); await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest = await token(hub, "guest", "guest");
    const get = (auth: string, endpoint: string) => fetch(hub.url + endpoint, { headers: { Authorization: `Bearer ${auth}` } });
    for (const endpoint of ["/api/ops/audit?source=audit", "/api/bots/alpha/diagnostics"]) {
      expect((await get("", endpoint)).status).toBe(401); expect((await get(guest, endpoint)).status).toBe(403); expect((await get(owner, endpoint)).status).toBe(200);
    }
    const page = diagnosticPageSchema.parse(await (await get(phone, "/api/bots/alpha/diagnostics")).json()); expect(page.total).toBe(2);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('offline','Offline',?)", [hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO managed_bots VALUES('offline','owner','fixture','{}')");
    const offlineDir = path.join(dir, "hub", "bots", "offline"); await mkdir(offlineDir, { recursive: true }); await writeFile(path.join(offlineDir, "audit.log.jsonl"), jsonl([event(1, { type: "service.stopped" })]));
    expect(diagnosticPageSchema.parse(await (await get(owner, "/api/bots/offline/diagnostics?source=audit")).json()).events[0]?.type).toBe("service.stopped");
    expect((await get(owner, "/api/bots/unknown/diagnostics")).status).toBe(403); expect((await get(owner, "/api/bots/alpha/diagnostics?path=/private")).status).toBe(400);
    await hub.store.audit("fixture.info", "tester");
    expect((await readHubDiagnostics(hub.store, { source: "audit", type: "fixture.info" })).events[0]?.outcome).toBe("info");
    await hub.store.audit("fixture.success", "tester", { reason: "token=fixture-secret" });
    const first = await readHubDiagnostics(hub.store, { source: "audit", limit: 2 }); expect(JSON.stringify(first)).not.toContain("fixture-secret");
    await hub.store.audit("fixture.later", "tester"); const older = await readHubDiagnostics(hub.store, { source: "audit", limit: 2, before: first.next });
    expect(older.events.some((e) => first.events.some((f) => f.id === e.id))).toBe(false);
    expect((await readHubDiagnostics(hub.store, { source: "audit", type: "fixture.success" })).matched).toBe(1);
    await hub.auth.revoke("phone", "local-owner"); expect((await get(phone, "/api/bots/alpha/diagnostics")).status).toBe(401);
    await channel.disconnect(); expect((await get(owner, "/api/bots/alpha/diagnostics")).status).toBe(503);
  } finally { await channel.disconnect(); await hub.close(); }
}, 20000);


it("reads a committed audit snapshot without occupying the live writer queue", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writing: Promise<unknown> | undefined;
  try {
    await hub.store.audit("fixture.created", "tester", { ok: true });
    writing = hub.store.db.transaction(async () => {
      await hub.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,NULL,'fixture.uncommitted','{}')", [Date.now()]);
      entered(); await blocked;
    });
    await started;
    const page = await Promise.race([readHubDiagnostics(hub.store, { source: "audit" }), new Promise<undefined>(resolve => setTimeout(resolve, 500))]);
    expect(page).toBeDefined();
    expect(page?.events.map(e => e.type)).toEqual(["fixture.created"]);
    release(); await writing;
    expect((await readHubDiagnostics(hub.store, { source: "audit" })).events.map(e => e.type)).toContain("fixture.uncommitted");
  } finally { release?.(); await writing; await hub.close(); }
});

it("keeps complete statistics and pagination consistent while maintenance prunes between batches", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  try {
    await hub.store.db.transaction(async () => {
      for (let i = 0; i < 503; i++) await hub.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.UTC(2026, 9, 19) + i, "tester", i % 2 ? "fixture.failed" : "fixture.created", JSON.stringify({ reason: `record ${i}`, token: "fixture-private-token" })]);
      await hub.store.db.run("INSERT INTO audit_log(at,kind,detail_json) VALUES(0,'fixture.corrupt','broken')");
    });
    const baseline = await readHubDiagnostics(hub.store, { source: "audit", limit: 2, outcome: "success" });
    const snapshot = HubDatabase.snapshot.bind(HubDatabase); let mutated = false;
    vi.spyOn(HubDatabase, "snapshot").mockImplementation(async (file) => {
      const db = await snapshot(file), all = db.all.bind(db);
      vi.spyOn(db, "all").mockImplementation(async (sql, params) => {
        const rows = await all(sql, params);
        if (!mutated && rows.length === 250) {
          mutated = true;
          await hub.store.db.transaction(async () => {
            await hub.store.db.run("DELETE FROM audit_log");
            await hub.store.db.run("INSERT INTO audit_log(at,kind,detail_json) VALUES(?,'fixture.later','{}')", [Date.now()]);
          });
        }
        return rows;
      });
      return db;
    });
    const during = await readHubDiagnostics(hub.store, { source: "audit", limit: 2, outcome: "success" });
    expect(mutated).toBe(true);
    expect(during).toEqual({ ...baseline, generatedAt: during.generatedAt });
    expect(during).toMatchObject({ total: 503, matched: 252, warnings: ["已跳过 1 条格式损坏的记录。"] });
    expect(during.events.map(e => e.detail)).toEqual(["record 502", "record 500"]);
    expect(JSON.stringify(during)).not.toContain("fixture-private-token");
    expect(await readHubDiagnostics(hub.store, { source: "audit", before: baseline.next })).toMatchObject({ total: 1, events: [], cursorExpired: true });
  } finally { await hub.close(); }
});

it("serializes independent readers, closes them on query failure and allows the next read", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  const snapshot = HubDatabase.snapshot.bind(HubDatabase), closed = vi.fn();
  let count = 0, entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    await hub.store.audit("fixture.created", null);
    vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
      const db = await snapshot(file), index = count++, close = db.close.bind(db), all = db.all.bind(db);
      vi.spyOn(db, "close").mockImplementation(async () => { await close(); closed(); });
      if (index === 0) vi.spyOn(db, "exec").mockRejectedValueOnce(new Error("begin fixture failed"));
      vi.spyOn(db, "all").mockImplementation(async (sql, params) => {
        if (index === 1) throw new Error("query fixture failed");
        if (index === 2) { entered(); await gate; }
        return all(sql, params);
      });
      return db;
    });
    await expect(readHubDiagnostics(hub.store, { source: "audit" })).rejects.toThrow("begin fixture failed");
    await expect(readHubDiagnostics(hub.store, { source: "audit" })).rejects.toThrow("query fixture failed");
    const first = readHubDiagnostics(hub.store, { source: "audit" }); pending.push(first); await ready;
    const next = readHubDiagnostics(hub.store, { source: "audit" }); pending.push(next);
    await hub.store.audit("fixture.concurrent", null);
    expect(count).toBe(3); expect(closed).toHaveBeenCalledTimes(2);
    release();
    expect((await first).events.map(e => e.type)).toEqual(["fixture.created"]);
    expect((await next).events.map(e => e.type)).toEqual(["fixture.concurrent", "fixture.created"]);
    expect(closed).toHaveBeenCalledTimes(4);
  } finally { release(); await Promise.allSettled(pending); await hub.close(); }
});

it("cancels a queued scan without opening a database and releases an aborted active reader", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  const snapshot = HubDatabase.snapshot.bind(HubDatabase), closed = vi.fn();
  let entered!: () => void, release!: () => void, opened = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const activeController = new AbortController(), queuedController = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    await hub.store.audit("fixture.created", null);
    const open = vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
      const db = await snapshot(file), all = db.all.bind(db), close = db.close.bind(db), index = opened++;
      vi.spyOn(db, "all").mockImplementation(async (sql, params) => { if (index === 0) { entered(); await gate; } return all(sql, params); });
      vi.spyOn(db, "close").mockImplementation(async () => { await close(); closed(); });
      return db;
    });
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(readHubDiagnostics(hub.store, {}, alreadyAborted.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(open).not.toHaveBeenCalled();
    const active = readHubDiagnostics(hub.store, { source: "audit" }, activeController.signal); pending.push(active); await ready;
    const queued = readHubDiagnostics(hub.store, { source: "audit" }, queuedController.signal); pending.push(queued);
    queuedController.abort(); activeController.abort(); release();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(open).toHaveBeenCalledTimes(1); expect(closed).toHaveBeenCalledTimes(1);
    expect((await readHubDiagnostics(hub.store, { source: "audit" })).events.map(e => e.type)).toEqual(["fixture.created"]);
    expect(closed).toHaveBeenCalledTimes(2);
  } finally { release(); await Promise.allSettled(pending); await hub.close(); }
});

it("rechecks revoked owner access after a slow audit snapshot", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  const owner = await token(hub, "owner-phone"), snapshot = HubDatabase.snapshot.bind(HubDatabase);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  let readerClosed = false, writerClosed = false;
  const writerClose = hub.store.db.close.bind(hub.store.db);
  vi.spyOn(hub.store.db, "close").mockImplementation(async () => { expect(readerClosed).toBe(true); await writerClose(); writerClosed = true; });
  vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
    const db = await snapshot(file), all = db.all.bind(db), close = db.close.bind(db);
    vi.spyOn(db, "all").mockImplementation(async (sql, params) => { entered(); await gate; return all(sql, params); });
    vi.spyOn(db, "close").mockImplementation(async () => { await close(); readerClosed = true; });
    return db;
  });
  let reading: Promise<Response> | undefined;
  try {
    reading = fetch(hub.url + "/api/ops/audit?source=audit", { headers: { Authorization: `Bearer ${owner}` } });
    await ready;
    await hub.auth.revoke("owner-phone", "local-owner");
    expect(readerClosed).toBe(false); expect(writerClosed).toBe(false);
    release(); expect((await reading).status).toBe(401);
    await hub.close(); expect(readerClosed).toBe(true); expect(writerClosed).toBe(true);
  } finally { release(); await reading?.catch(() => undefined); await hub.close(); }
});

it("waits for an accepted audit reader to close before shutting down the writer database", async () => {
  const hub = await HubServer.start({ stateDir: await root() });
  const owner = await token(hub, "shutdown-phone"), snapshot = HubDatabase.snapshot.bind(HubDatabase);
  await hub.store.db.transaction(async () => {
    for (let i = 0; i < 260; i++) await hub.store.db.run("INSERT INTO audit_log(at,kind,detail_json) VALUES(?,'fixture.created','{}')", [i]);
  });
  let entered!: () => void, release!: () => void, writerClosed = false, readerClosed = false;
  const batches = vi.fn();
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writerClose = hub.store.db.close.bind(hub.store.db);
  vi.spyOn(hub.store.db, "close").mockImplementation(async () => { expect(readerClosed).toBe(true); await writerClose(); writerClosed = true; });
  vi.spyOn(HubDatabase, "snapshot").mockImplementation(async file => {
    const db = await snapshot(file), all = db.all.bind(db), close = db.close.bind(db);
    vi.spyOn(db, "all").mockImplementation(async (sql, params) => { batches(); entered(); await gate; return all(sql, params); });
    vi.spyOn(db, "close").mockImplementation(async () => { await close(); readerClosed = true; });
    return db;
  });
  const reading = fetch(hub.url + "/api/ops/audit?source=audit", { headers: { Authorization: `Bearer ${owner}` } }).catch(() => undefined);
  let closing: Promise<void> | undefined;
  try {
    await ready; closing = hub.close();
    expect(await Promise.race([closing.then(() => "closed"), new Promise<string>(resolve => setTimeout(() => resolve("draining"), 20))])).toBe("draining");
    expect(writerClosed).toBe(false); expect(readerClosed).toBe(false);
    release(); await closing;
    expect(writerClosed).toBe(true); expect(readerClosed).toBe(true);
    expect(batches).toHaveBeenCalledTimes(1);
  } finally { release(); await reading; await (closing ?? hub.close()); }
});
