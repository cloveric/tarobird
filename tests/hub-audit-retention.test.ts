import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubAudit } from "../src/hub/audit.js";
import { HubAuth } from "../src/hub/auth.js";
import { HubStore } from "../src/hub/store.js";
import { HubMaintenance } from "../src/hub/maintenance.js";
import { HubServer } from "../src/hub/server.js";

let root: string, store: HubStore;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hub-audit-")); store = await HubStore.open(root); });
afterEach(async () => { vi.restoreAllMocks(); await store.db.close(); await rm(root, { force: true, recursive: true }); });

it("bounds disk writes for 5000 distinct invalid bearer tokens while retaining totals and source samples", async () => {
  const auth = await HubAuth.open(store, root);
  const writes = vi.spyOn(store.db, "run");
  const rejected = await Promise.allSettled(Array.from({ length: 5000 }, (_, i) => auth.authorize(`private-invalid-token-${i}`, `source-${i}`)));
  expect(rejected.every((result) => result.status === "rejected" && result.reason.message === "token_expired_or_invalid")).toBe(true);
  expect(writes).toHaveBeenCalledTimes(10);
  await store.flushAudit();
  expect(writes).toHaveBeenCalledTimes(11);
  const rows = await store.db.all<{ kind: string; detail_json: string }>("SELECT * FROM audit_log ORDER BY id");
  expect(rows).toHaveLength(11);
  expect(JSON.parse(rows[0]!.detail_json)).toEqual({ reason: "token_expired_or_invalid", source: "source-0" });
  expect(JSON.parse(rows[10]!.detail_json)).toMatchObject({ kind: "http.rejected", count: 4990 });
  expect(JSON.stringify(rows)).not.toContain("private-invalid-token");
});

it("does not throttle trusted changes and keeps independent, fixed rejection buckets across windows", async () => {
  let now = 10_000;
  const audit = new HubAudit(store.db, () => now);
  for (let i = 0; i < 200; i++) await audit.write("auth.rejected", `rotating_${i}`, { reason: `reason_${i}` });
  for (let i = 0; i < 15; i++) await audit.write("pairing.approved", "owner", { deviceId: `device_${i}` });
  await audit.write("socket.rejected", "source", { code: "device_revoked" });
  now += 60_000;
  await audit.write("auth.rejected", "next_window", { reason: "signature_invalid" });
  await Promise.all([audit.flush(), audit.flush()]);
  expect((await store.db.all("SELECT id FROM audit_log WHERE kind='pairing.approved'"))).toHaveLength(15);
  expect((await store.db.all("SELECT id FROM audit_log WHERE kind='auth.rejected'"))).toHaveLength(11);
  expect(await store.db.get("SELECT id FROM audit_log WHERE kind='socket.rejected' AND actor='source'")).toBeDefined();
  const summaries = await store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='rejections.summarized'");
  expect(summaries).toHaveLength(1);
  expect(JSON.parse(summaries[0]!.detail_json)).toEqual({ kind: "auth.rejected", count: 190, firstAt: 10_000, lastAt: 10_000 });
});

it("keeps failed flush counts for retry instead of silently dropping them", async () => {
  const audit = new HubAudit(store.db);
  for (let i = 0; i < 20; i++) await audit.write("http.rejected", null, {});
  vi.spyOn(store.db, "transaction").mockRejectedValueOnce(new Error("storage_temporarily_unavailable"));
  await expect(audit.flush()).rejects.toThrow("storage_temporarily_unavailable");
  await audit.write("http.rejected", null, {});
  await audit.flush();
  const row = await store.db.get<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='rejections.summarized'");
  expect(JSON.parse(row!.detail_json).count).toBe(11);
});

it("bounds unauthenticated Bot passport rejection writes while retaining their total", async () => {
  const hub = await HubServer.start({ stateDir: path.join(root, "ingress") });
  try {
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`${hub.url}/api/bot-messages/send`, { method: "POST", headers: { "X-TaroBot-Message-Passport": Buffer.from(`invalid-${i}`).toString("base64url") }, body: "{}" });
      expect(response.ok).toBe(false); await response.arrayBuffer();
    }
    await hub.store.flushAudit();
    const rows = await hub.store.db.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log WHERE kind IN ('bot-message.rejected','rejections.summarized')");
    expect(rows.filter(row => row.kind === "bot-message.rejected")).toHaveLength(10);
    expect(rows.filter(row => row.kind === "rejections.summarized").map(row => JSON.parse(row.detail_json))).toContainEqual(expect.objectContaining({ kind: "bot-message.rejected", count: 30 }));
  } finally { await hub.close(); }
});

it.each(["http.rejected", "pairing.requested", "bot-message.rejected", "bot-message.wait", "bot-message.outgoing-wait"])("bounds 90-day audit history without letting %s traffic evict approval receipts, messages or trust", async (kind) => {
  const now = Date.now(), expired = now - 91 * 24 * 60 * 60_000;
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','test')");
  const conversation = await store.createConversation("owner", ["alpha"], "Keep history", "create");
  await store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "keep", text: "retained", attachments: [] });
  await store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES('trusted','owner','Desktop','macos','test',?,?)", [now, now]);
  await store.audit("pairing.approved", "local-owner", { deviceId: "trusted" });
  await store.db.run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100005) INSERT INTO audit_log(at,actor,kind,detail_json) SELECT ?,NULL,?,'{}' FROM n", [now, kind]);
  // Age pruning must work even when an expired row is among the newest IDs.
  await store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,NULL,'auth.rejected','{}')", [expired]);
  expect(await new HubMaintenance(store, root).pruneAudit(now)).toBe(90006);
  expect((await store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_log"))!.count).toBe(10001);
  expect(await store.db.get("SELECT id FROM audit_log WHERE kind='pairing.approved'")).toBeDefined();
  expect((await store.snapshot("owner", conversation.id)).messages[0]!.blocks).toContainEqual({ type: "text", text: "retained" });
  expect(await store.device("trusted")).toBeDefined();
});
