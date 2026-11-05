import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../src/hub/server.js";
import { HubSideSessions } from "../src/hub/side-sessions.js";
import type { AuthSession } from "../src/hub/auth.js";
import type { SideScope } from "../src/client-protocol/side.js";
import { CoreSideSessions } from "../src/core/side-sessions.js";

let hub: HubServer, root: string, side: HubSideSessions, core: CoreSideSessions, conversationId: string;
const session: AuthSession = { deviceId: "desktop", userId: "owner", expiresAt: Date.now() + 3600_000 };
const capability = { supported: true, concurrent: true, liveContext: false, tools: "read-only" as const };
const dispose = vi.fn(async () => {});
let blockedOpen: (() => Promise<void>) | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "side-hub-")); hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  for (const id of ["desktop", "second"]) await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,'owner',?,'web','fixture',0,0)", [id, id]);
  conversationId = (await hub.store.createConversation("owner", ["bot"], "Direct", "direct")).id;
  dispose.mockClear(); blockedOpen = undefined;
  core = new CoreSideSessions({ open: async () => ({ nativeId: "temp", dispose, send: async () => ({ text: "answer" }) }), beforeAsk: async () => {}, record: async () => {} });
  side = new HubSideSessions(hub.store, hub.auth, async (_bot, method, raw) => {
    const { sideId, requestId, ...scope } = raw as SideScope & { sideId: string; requestId: string };
    if (method === "side.open") { const result = core.open(scope, requestId, capability); await blockedOpen?.(); return result; }
    if (method === "side.read") return { ok: true, ...core.read(scope, sideId) };
    if (method === "side.close") return core.close(scope, sideId);
    return { ok: true, capability };
  });
});
afterEach(async () => { side.dispose(); await core.closeAll(); await hub.close(); await rm(root, { recursive: true, force: true }); });
it("keeps side handles device-scoped and never appends journal events", async () => {
  const before = await hub.store.db.get("SELECT COUNT(*) AS n FROM events"), result = await side.request(session, conversationId, "bot", "side.open", { requestId: "open" });
  if (!result.ok || !result.view) throw new Error(); const sideId = result.view.id;
  expect(await side.request({ ...session, deviceId: "second" }, conversationId, "bot", "side.read", { sideId })).toEqual({ ok: false, error: "expired" });
  await side.request({ ...session, deviceId: "second" }, conversationId, "bot", "side.close", { sideId }); expect(dispose).not.toHaveBeenCalled();
  expect(await side.request(session, conversationId, "bot", "side.read", { sideId })).toMatchObject({ ok: true });
  expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM events")).toEqual(before);
  side.revoke("desktop"); await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  expect(await side.request(session, conversationId, "bot", "side.read", { sideId })).toEqual({ ok: false, error: "expired" });
});
it("rechecks authorization after a delayed worker response and disposes a revoked open", async () => {
  let release!: () => void; blockedOpen = () => new Promise(resolve => { release = resolve; });
  const pending = side.request(session, conversationId, "bot", "side.open", { requestId: "open" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='desktop'"); release();
  await expect(pending).rejects.toThrow("device_revoked"); await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
});
it("forwards an authenticated close after Hub lease metadata is lost", async () => {
  const result = await side.request(session, conversationId, "bot", "side.open", { requestId: "open" });
  if (!result.ok || !result.view) throw new Error();
  (side as unknown as { entries: Map<string, unknown> }).entries.clear();
  await side.request(session, conversationId, "bot", "side.close", { sideId: result.view.id });
  expect(dispose).toHaveBeenCalledTimes(1);
});
it("requires current membership, a single direct Bot and an unarchived conversation", async () => {
  await hub.store.db.run("UPDATE conversations SET type='group' WHERE id=?", [conversationId]);
  await expect(side.request(session, conversationId, "bot", "side.open", { requestId: "group" })).rejects.toThrow("side_unavailable");
  await hub.store.db.run("UPDATE conversations SET type='direct',archived=1 WHERE id=?", [conversationId]);
  await expect(side.request(session, conversationId, "bot", "side.open", { requestId: "archive" })).rejects.toThrow("side_unavailable");
  await hub.store.db.run("UPDATE conversations SET archived=0 WHERE id=?", [conversationId]);
  await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversationId]);
  await expect(side.request(session, conversationId, "bot", "side.open", { requestId: "removed" })).rejects.toThrow();
});
it("forwards only the caller's own completed uploads in this conversation and never retires them", async () => {
  const calls: Array<{ method: string; raw: Record<string, unknown> }> = [];
  const recording = new HubSideSessions(hub.store, hub.auth, async (_bot, method, raw) => {
    calls.push({ method, raw: raw as Record<string, unknown> });
    if (method === "side.open") return { ok: true, view: { id: "side_fixture", conversationId, revision: 0, openedAt: 0, phase: "idle", capability, exchanges: [], omitted: 0 } };
    if (method === "side.close") return { ok: true };
    return { ok: true, capability };
  });
  try {
    await hub.store.db.run("INSERT INTO users(id,name) VALUES('guest','Guest')").catch(() => undefined);
    const other = (await hub.store.createConversation("owner", ["bot"], "Other", "other-direct")).id; expect(other).not.toBe(conversationId);
    const insert = (id: string, conversation: string, owner: string, complete: number) => hub.store.db.run("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?)", [id, conversation, owner, "a".repeat(64), 12, "text/plain", `${id}.txt`, `${id}.blob`, complete, Date.now()]);
    await insert("att_mine", conversationId, "owner", 1); await insert("att_guest", conversationId, "guest", 1); await insert("att_other", other, "owner", 1);
    await insert("att_partial", conversationId, "owner", 0); await insert("att_retired", conversationId, "owner", 1);
    await hub.store.db.run("INSERT INTO retired_attachments VALUES('att_retired')");
    await recording.request(session, conversationId, "bot", "side.status", {});
    await recording.request(session, conversationId, "bot", "side.status", { withAttachments: true });
    expect(calls.map(call => call.raw.attachments)).toEqual([undefined, true]);
    await recording.request(session, conversationId, "bot", "side.open", { requestId: "open" });
    for (const id of ["att_guest", "att_other", "att_partial", "att_retired", "att_missing"]) {
      calls.length = 0;
      expect(await recording.request(session, conversationId, "bot", "side.ask", { sideId: "side_fixture", requestId: id, text: "", attachments: ["att_mine", id] })).toEqual({ ok: false, error: "attachment_unavailable" });
      expect(calls).toEqual([]);
    }
    await recording.request(session, conversationId, "bot", "side.ask", { sideId: "side_fixture", requestId: "ok", text: "", attachments: ["att_mine"] });
    expect(calls.at(-1)).toEqual({ method: "side.ask", raw: { sideId: "side_fixture", requestId: "ok", text: "", attachments: [{ id: "att_mine", name: "att_mine.txt", mime: "text/plain", size: 12, sha256: "a".repeat(64) }], ...{ userId: "owner", deviceId: "desktop", conversationId } } });
    await recording.request(session, conversationId, "bot", "side.close", { sideId: "side_fixture" });
    expect(await hub.store.db.all("SELECT attachment_id FROM retired_attachments")).toEqual([{ attachment_id: "att_retired" }]);
    expect((await hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM attachments"))!.n).toBe(5);
  } finally { recording.dispose(); }
});
it("falls back to plain status for an older strict Gateway and still re-authorizes the reply", async () => {
  let revoke = false;
  const seen: Array<Record<string, unknown>> = [];
  const legacy = new HubSideSessions(hub.store, hub.auth, async (_bot, _method, raw) => {
    seen.push(raw as Record<string, unknown>);
    if ((raw as { attachments?: unknown }).attachments !== undefined) throw new Error("Unrecognized key: \"attachments\"");
    if (revoke) await hub.store.db.run("UPDATE devices SET revoked=1 WHERE id='desktop'");
    return { ok: true, capability };
  });
  const down = new HubSideSessions(hub.store, hub.auth, async () => { throw new Error("worker unavailable"); });
  try {
    expect(await legacy.request(session, conversationId, "bot", "side.status", { withAttachments: true })).toEqual({ ok: true, capability });
    expect(seen.map(raw => raw.attachments)).toEqual([true, undefined]);
    expect(await down.request(session, conversationId, "bot", "side.status", { withAttachments: true })).toMatchObject({ ok: true, capability: { supported: false, reason: "unsupported" } });
    expect(await down.request(session, conversationId, "bot", "side.status", {})).toMatchObject({ ok: true, capability: { supported: false } });
    revoke = true;
    await expect(legacy.request(session, conversationId, "bot", "side.status", { withAttachments: true })).rejects.toThrow("device_revoked");
  } finally { legacy.dispose(); down.dispose(); }
});
it("forwards the audio opt-in only with attachments and degrades one flag at a time for older Gateways", async () => {
  const attachments = { images: true, files: "text" as const, maxCount: 8, maxFileBytes: 1024, maxImageBytes: 1024, maxTotalBytes: 2048 };
  const seen: Array<Record<string, unknown>> = [];
  // rejects: the opt-in keys this Gateway's strict status schema does not know.
  const gateway = (rejects: string[], reply = { ...capability, attachments }) => new HubSideSessions(hub.store, hub.auth, async (_bot, _method, raw) => {
    const params = raw as Record<string, unknown>; seen.push(params);
    const unknown = rejects.find(key => key in params); if (unknown) throw new Error(`Unrecognized key: "${unknown}"`);
    return { ok: true, capability: "attachments" in params ? { ...reply, attachments: { ...reply.attachments, ...("audio" in params ? { audio: true } : {}) } } : capability };
  });
  const current = gateway([]), audioUnaware = gateway(["audio"]), legacy = gateway(["audio", "attachments"]);
  try {
    expect(await current.request(session, conversationId, "bot", "side.status", { withAttachments: true, withAudio: true })).toEqual({ ok: true, capability: { ...capability, attachments: { ...attachments, audio: true } } });
    expect(await current.request(session, conversationId, "bot", "side.status", { withAudio: true })).toEqual({ ok: true, capability });
    expect(seen.map(raw => [raw.attachments, raw.audio])).toEqual([[true, true], [undefined, undefined]]);
    seen.length = 0;
    // An audio-unaware Gateway keeps its ordinary attachment capability: the side entry stays.
    expect(await audioUnaware.request(session, conversationId, "bot", "side.status", { withAttachments: true, withAudio: true })).toEqual({ ok: true, capability: { ...capability, attachments } });
    expect(seen.map(raw => [raw.attachments, raw.audio])).toEqual([[true, true], [true, undefined]]);
    seen.length = 0;
    expect(await legacy.request(session, conversationId, "bot", "side.status", { withAttachments: true, withAudio: true })).toEqual({ ok: true, capability });
    expect(seen.map(raw => [raw.attachments, raw.audio])).toEqual([[true, true], [true, undefined], [undefined, undefined]]);
  } finally { current.dispose(); audioUnaware.dispose(); legacy.dispose(); }
});
it("never passes the audio key to a client that did not opt in", async () => {
  const attachments = { images: false, files: "text" as const, maxCount: 8, maxFileBytes: 1024, maxImageBytes: 1024, maxTotalBytes: 2048 };
  const eager = new HubSideSessions(hub.store, hub.auth, async () => ({ ok: true, capability: { ...capability, attachments: { ...attachments, audio: true } } }));
  try {
    const reply = await eager.request(session, conversationId, "bot", "side.status", { withAttachments: true });
    expect(reply).toEqual({ ok: true, capability: { ...capability, attachments } });
    // The pre-audio strict client schema accepts the reply as-is.
    const { sideAttachmentCapabilitySchema } = await import("../src/client-protocol/side.js");
    expect(sideAttachmentCapabilitySchema.omit({ audio: true }).strict().safeParse(reply.ok && reply.capability?.attachments).success).toBe(true);
  } finally { eager.dispose(); }
});

it("negotiates delivery explicitly and falls back through delivery, tools, audio and attachments on old Gateways", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const legacy = new HubSideSessions(hub.store, hub.auth, async (_bot, _method, raw) => {
    const params = raw as Record<string, unknown>; seen.push(params);
    if (["delivery", "tools", "audio", "attachments"].some(key => key in params)) throw new Error("unknown opt-in");
    return { ok: true, capability };
  });
  const current = new HubSideSessions(hub.store, hub.auth, async (_bot, _method, raw) => {
    const params = raw as Record<string, unknown>;
    return { ok: true, capability: { ...capability, tools: params.tools ? "inherited" : "read-only", ...(params.delivery ? { delivery: true } : {}) } };
  });
  try {
    expect(await current.request(session, conversationId, "bot", "side.status", {})).toMatchObject({ capability: { tools: "read-only" } });
    expect(await current.request(session, conversationId, "bot", "side.status", { withTools: true })).toMatchObject({ capability: { tools: "inherited" } });
    expect(await current.request(session, conversationId, "bot", "side.status", { withTools: true, withDelivery: true })).toMatchObject({ capability: { tools: "inherited", delivery: true } });
    expect(await current.request(session, conversationId, "bot", "side.status", { withTools: true })).not.toHaveProperty("capability.delivery");
    expect(await legacy.request(session, conversationId, "bot", "side.status", { withTools: true, withAttachments: true, withAudio: true })).toEqual({ ok: true, capability });
    expect(seen.map(p => [p.tools, p.audio, p.attachments])).toEqual([[true, true, true], [undefined, true, true], [undefined, undefined, true], [undefined, undefined, undefined]]);
    seen.length = 0;
    expect(await legacy.request(session, conversationId, "bot", "side.status", { withDelivery: true, withTools: true })).toEqual({ ok: true, capability });
    expect(seen.map(p => [p.delivery, p.tools])).toEqual([[true, true], [undefined, true], [undefined, undefined]]);
  } finally { legacy.dispose(); current.dispose(); }
});
