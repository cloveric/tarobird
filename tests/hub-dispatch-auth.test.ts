import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

let hub: HubServer, root: string, token: string, ticketId: string;
const secret = "dispatch-test-secret".repeat(3);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-auth-"));
  hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher',?,'claude','dispatcher'),('w','Worker','fixture','codex','worker')", [hashSecret(secret)]);
  await hub.store.createConversation("owner", ["d"], "Home", "home");
  const ticket = await hub.dispatch.create({ kind: "owner", userId: "owner" }, "d", { requestId: "initial", title: "T", request: "R" }); ticketId = ticket.id;
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: "device", name: "Device", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
  await hub.auth.approve(pair.code, "local-owner");
  const challenge = await hub.auth.challenge("device", "device", nonce, "fixture");
  token = (await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
});
afterEach(async () => { vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); });

it("serves a compact owner overview without changing full ticket/CLI reads", async () => {
  const attempt = { id: "a", botId: "w", engine: "codex", model: "", effort: "", conversationId: "worker_chat", inputMessageId: "input", startedAt: 1, endedAt: 2, outcome: "failed" };
  await hub.store.db.run("UPDATE dispatch_tickets SET request=?,result=?,note=?,attempts_json=? WHERE id=?", ["任务".repeat(750), "结果".repeat(2000), "保留备注", JSON.stringify([attempt, { ...attempt, id: "b", startedAt: 3, endedAt: 4 }]), ticketId]);
  const headers = { Authorization: `Bearer ${token}` };
  const full = await (await fetch(hub.url + "/api/bots/d/tickets", { headers })).json();
  const overview = await (await fetch(hub.url + "/api/bots/d/tickets?summary=1", { headers })).json();
  // Released Apps parse the outer snapshot strictly. The feature flag must be
  // absent unless the current App explicitly asks for it.
  expect(Object.keys(overview).sort()).toEqual(["engines", "tickets"]);
  const capable = await (await fetch(hub.url + "/api/bots/d/tickets?summary=1&capabilities=1", { headers })).json();
  expect(capable).toEqual({ ...overview, capabilities: { remove: true } });
  expect(await (await fetch(hub.url + "/api/bots/d/tickets?capabilities=1", { headers })).json()).toEqual(full);
  expect(full.tickets[0]).toMatchObject({ request: "任务".repeat(750), result: "结果".repeat(2000), note: "保留备注" });
  expect(full.tickets[0].attempts).toHaveLength(2);
  expect(overview.tickets[0]).not.toHaveProperty("request");
  expect(overview.tickets[0]).not.toHaveProperty("result");
  expect(overview.tickets[0]).not.toHaveProperty("note");
  expect(overview.tickets[0].attempts).toEqual([full.tickets[0].attempts[1]]);
  expect(Buffer.byteLength(JSON.stringify(overview))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)) / 10);
  expect((await hub.dispatch.show({ kind: "owner", userId: "owner" }, ticketId))).toEqual(full.tickets[0]);
  await hub.store.db.run("UPDATE dispatch_tickets SET status='done' WHERE id=?", [ticketId]);
  expect((await (await fetch(hub.url + "/api/bots/d/tickets?open=1&summary=1", { headers })).json()).tickets).toEqual([]);
  await hub.auth.revoke("device", "local-owner");
  expect((await fetch(hub.url + "/api/bots/d/tickets?summary=1", { headers })).status).toBe(401);
});

function heldBody(route: string, body: unknown, headers: Record<string, string>, method = "POST") {
  let req!: ReturnType<typeof request>;
  const text = JSON.stringify(body);
  const response = new Promise<number>((resolve, reject) => {
    req = request(hub.url + route, { method, headers: { ...headers, "Content-Type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.write(text.slice(0, 1));
  });
  return { response, release: () => req.end(text.slice(1)) };
}

it.each(["create", "settings", "cancel"] as const)("does not mutate %s after the owner device is revoked during body upload", async operation => {
  const read = await hub.dispatch.settings("owner", "d");
  const route = operation === "create" ? "/api/bots/d/tickets" : operation === "settings" ? "/api/bots/d/dispatcher" : `/api/tickets/${ticketId}/action`;
  const body = operation === "create" ? { requestId: "late", title: "Late", request: "Late" } : operation === "settings" ? { settings: { mode: "auto", maxConcurrent: 7 }, expectedRevision: read.revision } : { requestId: "late", action: "cancel" };
  const bodyReader = vi.spyOn(hub as unknown as { jsonBody(...args: unknown[]): Promise<unknown> }, "jsonBody");
  const held = heldBody(route, body, { Authorization: `Bearer ${token}` }, operation === "settings" ? "PUT" : "POST");
  try { await vi.waitFor(() => expect(bodyReader).toHaveBeenCalled()); await hub.auth.revoke("device", "local-owner"); } finally { held.release(); }
  expect(await held.response).toBe(401);
  expect((await hub.dispatch.list({ kind: "owner", userId: "owner" }, "d")).tickets).toHaveLength(1);
  expect((await hub.dispatch.show({ kind: "owner", userId: "owner" }, ticketId)).status).toBe("queued");
  expect(await hub.dispatch.settings("owner", "d")).toEqual(read);
});

it("does not commit a dispatch after revocation while preparing its worker", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { release = r; });
  hub.dispatch.workers = { catalog: async () => ({ engines: [] }), dispatchWorker: async () => { enter(); await held; return "w"; }, ticketWorkspace: async () => root };
  const response = fetch(hub.url + "/api/bots/d/tickets/dispatch", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "late", ticketId, engine: "codex" }) });
  try { await entered; await hub.auth.revoke("device", "local-owner"); } finally { release(); }
  expect((await response).status).toBe(401);
  expect((await hub.dispatch.show({ kind: "owner", userId: "owner" }, ticketId)).attempts).toEqual([]);
  expect(await hub.store.db.get("SELECT 1 FROM conversations WHERE hidden=1")).toBeUndefined();
});

it("rejects a rotated Bot credential before committing a queued mutation", async () => {
  const home = (await hub.store.conversations("owner"))[0]!;
  const message = await hub.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn", text: "plan", attachments: [] });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [message.message.id]);
  // Pause just after credential admission, before the mutation's transaction.
  const create = hub.dispatch.create.bind(hub.dispatch);
  vi.spyOn(hub.dispatch, "create").mockImplementationOnce(async (...args) => {
    await hub.store.db.serial(() => hub.store.db.run("UPDATE bots SET secret_hash=? WHERE id='d'", [hashSecret("rotated")]));
    return create(...args);
  });
  const response = await fetch(hub.instanceUrl + "/api/instance/tickets", { method: "POST", headers: { Authorization: `Instance d:${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "create", contextMessage: message.message.id, data: { requestId: "late", title: "Late", request: "Late" } }) });
  expect(response.status).toBe(401);
  expect((await hub.dispatch.list({ kind: "owner", userId: "owner" }, "d")).tickets).toHaveLength(1);
});

it.each(["action", "updateSettings", "resetEngine"] as const)("rechecks a revoked device inside the %s transaction", async operation => {
  const initial = await hub.dispatch.settings("owner", "d");
  await hub.store.db.run("INSERT INTO engine_health(engine,state,until,reason,updated_at) VALUES('codex','login_required',NULL,'auth',0)");
  const revoke = () => hub.auth.revoke("device", "local-owner");
  if (operation === "action") {
    const original = hub.dispatch.action.bind(hub.dispatch);
    vi.spyOn(hub.dispatch, "action").mockImplementationOnce(async (...args) => { await revoke(); return original(...args); });
  } else if (operation === "updateSettings") {
    const original = hub.dispatch.updateSettings.bind(hub.dispatch);
    vi.spyOn(hub.dispatch, "updateSettings").mockImplementationOnce(async (...args) => { await revoke(); return original(...args); });
  } else {
    const original = hub.dispatch.resetEngine.bind(hub.dispatch);
    vi.spyOn(hub.dispatch, "resetEngine").mockImplementationOnce(async (...args) => { await revoke(); return original(...args); });
  }
  const route = operation === "action" ? `/api/tickets/${ticketId}/action` : operation === "updateSettings" ? "/api/bots/d/dispatcher" : "/api/dispatch/engines/codex/reset";
  const body = operation === "action" ? { requestId: "late", action: "cancel" } : operation === "updateSettings" ? { expectedRevision: initial.revision, settings: { mode: "auto", maxConcurrent: 7 } } : {};
  const response = await fetch(hub.url + route, { method: operation === "updateSettings" ? "PUT" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(401);
  expect((await hub.dispatch.show({ kind: "owner", userId: "owner" }, ticketId)).status).toBe("queued");
  expect(await hub.dispatch.settings("owner", "d")).toEqual(initial);
  expect(await hub.store.db.get("SELECT state FROM engine_health WHERE engine='codex'")).toEqual({ state: "login_required" });
});
