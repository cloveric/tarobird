import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GoogleAuthorization } from "../src/gdocs/auth.js";
import { GoogleDocs } from "../src/gdocs/client.js";
import { deviceProof, type AuthSession } from "../src/hub/auth.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubFileCenter } from "../src/hub/file-center.js";
import { HubServer } from "../src/hub/server.js";
import { withFileMutex } from "../src/state/file-mutex.js";
import { JsonStore } from "../src/state/json-store.js";

let root: string, hub: HubServer, docs: GoogleDocs, admitted: AuthSession | undefined;
const centers: HubFileCenter[] = [];
const spec = { requestId: "create_once", name: "Fixture", engine: "codex" as const, model: "gpt-5.5", effort: "high" as const, workspace: "" };
const barrier = () => {
  let enter!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => { enter = r; }), gate = new Promise<void>((r) => { release = r; });
  return { enter, release, waiting, gate };
};
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-control-auth-"));
  const auth = new GoogleAuthorization({ client_id: "fixture" }, { read: async () => JSON.stringify({ refreshToken: "fixture" }), write: async () => {}, remove: async () => {} }, async () => Response.json({ access_token: "fixture", expires_in: 3600 }));
  docs = new GoogleDocs(auth, async () => { throw new Error("unexpected_google_request"); });
  // This authorization fixture must not discover the operator's live Antigravity
  // service. Only the synthetic Codex executable is needed by these cases.
  hub = await HubServer.start({ stateDir: root, managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.join(root, "no-antigravity") } }, googleDocs: async () => docs });
  admitted = undefined;
  const authorize = hub.auth.authorize.bind(hub.auth);
  vi.spyOn(hub.auth, "authorize").mockImplementation(async (token) => { admitted = await authorize(token); return admitted; });
});
afterEach(async () => { vi.restoreAllMocks(); for (const center of centers.splice(0)) await center.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
async function login(id = "source") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner");
  const challenge = await hub.auth.challenge(id, id, nonce, id);
  return hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"));
}
function post(token: string, route: string, body = {}, method = "POST") {
  return fetch(hub.url + route, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
async function invalidate(kind: "revoke" | "demote" | "expire") {
  if (kind === "revoke") await hub.auth.revoke("source", "local-owner");
  else if (kind === "expire") { expect(admitted).toBeDefined(); admitted!.expiresAt = 0; }
  else await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
}

it.each(["revoke", "demote", "expire"] as const)("does not register or start a Bot after %s while discovering engines", async (kind) => {
  const session = await login(), held = barrier();
  const catalog = BotManager.prototype.catalog;
  vi.spyOn(BotManager.prototype, "catalog").mockImplementationOnce(async function (this: BotManager) { const value = await catalog.call(this); held.enter(); await held.gate; return value; });
  const pending = post(session.token, "/api/bots", spec);
  try { await held.waiting; await invalidate(kind); } finally { held.release(); }
  const response = await pending;
  expect(response.status).toBe(kind === "demote" ? 403 : 401);
  expect(await hub.store.db.get("SELECT 1 FROM managed_bots")).toBeUndefined();
  expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='bot.created'")).toBeUndefined();
});

it("rechecks registration after preparing files and preserves the staged specification on a trusted retry", async () => {
  const session = await login(), held = barrier();
  type Prepared = { prepare(row: { bot_id: string }): Promise<string> };
  const proto = BotManager.prototype as unknown as Prepared, prepare = proto.prepare;
  vi.spyOn(proto, "prepare").mockImplementationOnce(async function (this: Prepared, row) { const secret = await prepare.call(this, row); held.enter(); await held.gate; return secret; });
  const pending = post(session.token, "/api/bots", spec);
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401);
  expect(await hub.store.db.get("SELECT 1 FROM managed_bots")).toBeUndefined();
  const trusted = await login("trusted");
  expect((await post(trusted.token, "/api/bots", { ...spec, model: "gpt-6-astra" })).status).toBe(409);
  const response = await post(trusted.token, "/api/bots", spec); expect(response.status).toBe(201);
  const bot = await response.json() as { id: string };
  expect(JSON.parse(await readFile(path.join(root, "bots", bot.id, "config.json"), "utf8"))).toMatchObject({ model: spec.model, effort: spec.effort });
});

it("rejects a second device's queued Bot creation but finishes the trusted creation ahead of it", async () => {
  const source = await login(), trusted = await login("trusted"), held = barrier(), queued = barrier();
  const catalog = BotManager.prototype.catalog, create = BotManager.prototype.create;
  vi.spyOn(BotManager.prototype, "catalog").mockImplementationOnce(async function (this: BotManager) { const value = await catalog.call(this); held.enter(); await held.gate; return value; });
  vi.spyOn(BotManager.prototype, "create").mockImplementation(function (this: BotManager, ...args) { const pending = create.apply(this, args); if (args[1].requestId === "queued") queued.enter(); return pending; });
  const first = post(trusted.token, "/api/bots", spec); await held.waiting;
  const second = post(source.token, "/api/bots", { ...spec, requestId: "queued" });
  try { await queued.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await first).status).toBe(201); expect((await second).status).toBe(401);
  expect(await hub.store.db.all("SELECT request_id FROM managed_bots")).toEqual([{ request_id: spec.requestId }]);
});

it("finishes launching an already registered Bot when the original device is revoked afterward", async () => {
  const session = await login(), held = barrier(), audit = hub.store.audit.bind(hub.store);
  vi.spyOn(hub.store, "audit").mockImplementation(async (...args) => { await audit(...args); if (args[0] === "bot.created") { held.enter(); await held.gate; } });
  const pending = post(session.token, "/api/bots", spec);
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401);
  expect(await hub.store.db.get("SELECT 1 FROM managed_bots")).toBeDefined();
  await vi.waitFor(async () => expect((await hub.store.bots("owner"))[0]?.online).toBe(1));
});

async function fileFixture() {
  const stateDir = path.join(root, "fixture"), workspace = path.join(stateDir, "workspace");
  await mkdir(path.join(workspace, "outputs"), { recursive: true }); await writeFile(path.join(workspace, "outputs", "report.txt"), "report");
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
  const roots = vi.fn(async () => ({ instances: [{ name: "fixture", stateDir }], warnings: [] as string[] }));
  const reveal = vi.fn(async () => {});
  const center = new HubFileCenter(root, roots, { home: root, reveal }); centers.push(center);
  await center.start(); await vi.waitFor(async () => expect((await center.status()).scanning).toBe(false));
  const unit = (await center.status()).inventory!.units.find((u) => u.name === "outputs")!;
  return { center, unit, roots, reveal };
}
it.each(["revoke", "demote", "expire"] as const)("does not change a file label after %s while waiting for the actual file mutex", async (kind) => {
  const session = await login(), { center, unit } = await fileFixture(), held = barrier(), entered = barrier();
  const occupying = withFileMutex(path.join(root, "file-center-labels.json.mutex"), async () => { held.enter(); await held.gate; });
  await held.waiting;
  vi.spyOn(hub.fileCenter, "label").mockImplementation((...args) => { const pending = center.label(...args); entered.enter(); return pending; });
  const pending = post(session.token, "/api/files/labels", { unitId: unit.id, expectedRevision: 0, note: "must not save" }, "PATCH");
  try { await entered.waiting; await invalidate(kind); } finally { held.release(); }
  await occupying; expect((await pending).status).toBe(kind === "demote" ? 403 : 401);
  expect((await center.status()).inventory!.units.find((u) => u.id === unit.id)).toMatchObject({ labelRevision: 0 });
  expect(await hub.store.db.get("SELECT 1 FROM audit_log WHERE kind='file_center.label_updated'")).toBeUndefined();
});
it("does not start a new file scan after revocation during label loading", async () => {
  const session = await login(), { center, roots } = await fileFixture(), held = barrier();
  const before = roots.mock.calls.length, read = JsonStore.prototype.read;
  vi.spyOn(JsonStore.prototype, "read").mockImplementationOnce(async function (this: JsonStore<unknown>, fallback) { const value = await read.call(this, fallback); held.enter(); await held.gate; return value; });
  vi.spyOn(hub.fileCenter, "start").mockImplementation((...args) => center.start(...args));
  const pending = post(session.token, "/api/files/scan");
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401); expect(roots).toHaveBeenCalledTimes(before);
});
it("does not open Finder after revocation while re-enumerating registered roots", async () => {
  const session = await login(), { center, unit, roots, reveal } = await fileFixture(), held = barrier();
  const source = await roots(); roots.mockImplementationOnce(async () => { held.enter(); await held.gate; return source; });
  vi.spyOn(hub.fileCenter, "reveal").mockImplementation((...args) => center.reveal(...args));
  const pending = post(session.token, "/api/files/reveal", { unitId: unit.id });
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401); expect(reveal).not.toHaveBeenCalled();
});

it.each(["revoke", "demote", "membership"] as const)("does not export a document after %s during OAuth refresh", async (kind) => {
  const session = await login(), held = barrier();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Export", "export");
  const message = await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: "private content" }] });
  vi.spyOn(docs.authorization, "token").mockImplementationOnce(async () => { held.enter(); await held.gate; return "fixture"; });
  const create = vi.spyOn(docs, "create").mockResolvedValue({ documentId: "doc_fixture", url: "https://docs.google.com/document/d/doc_fixture/edit" });
  const pending = post(session.token, "/api/gdocs/export", { messageId: message.id });
  try {
    await held.waiting;
    if (kind === "membership") await hub.store.db.serial(() => hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=?", [conversation.id]));
    else await invalidate(kind);
  } finally { held.release(); }
  expect((await pending).status).toBe(kind === "revoke" ? 401 : 403);
  expect(create).not.toHaveBeenCalled();
  expect(await hub.store.db.get("SELECT 1 FROM meta WHERE key LIKE 'gdocs:%'")).toBeUndefined();
});

it("preserves an admitted export receipt after revocation and reuses it for another trusted device", async () => {
  const session = await login(), held = barrier();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const c = await hub.store.createConversation("owner", ["alpha"], "Export", "export");
  const message = await hub.store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "text", text: "authorized export" }] });
  const link = { documentId: "doc_fixture", url: "https://docs.google.com/document/d/doc_fixture/edit" };
  const create = vi.spyOn(docs, "create").mockImplementation(async (_title, _text, created) => { await created?.(link.documentId); held.enter(); await held.gate; return link; });
  const pending = post(session.token, "/api/gdocs/export", { messageId: message.id });
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401);
  const saved = await hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [`gdocs:owner:${message.id}:${message.version}`]);
  expect(JSON.parse(saved!.value)).toEqual({ status: "complete", documentId: link.documentId });
  const trusted = await login("trusted");
  const response = await post(trusted.token, "/api/gdocs/export", { messageId: message.id }); expect(response.status).toBe(200);
  expect(await response.json()).toEqual(link); expect(create).toHaveBeenCalledTimes(1);
});

it("refuses a revoked retry of an unfinished document update without damaging its document ID", async () => {
  const session = await login(), held = barrier();
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  const c = await hub.store.createConversation("owner", ["alpha"], "Export", "export");
  const message = await hub.store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "text", text: "retry contents" }] });
  const key = `gdocs:owner:${message.id}:${message.version}`, receipt = JSON.stringify({ status: "writing", documentId: "existing_document" });
  await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [key, receipt]);
  vi.spyOn(docs.authorization, "token").mockImplementationOnce(async () => { held.enter(); await held.gate; return "fixture"; });
  const update = vi.spyOn(docs, "update").mockResolvedValue({ documentId: "existing_document", url: "https://docs.google.com/document/d/existing_document/edit" });
  const pending = post(session.token, "/api/gdocs/export", { messageId: message.id });
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401); expect(update).not.toHaveBeenCalled();
  expect(await hub.store.db.get("SELECT value FROM meta WHERE key=?", [key])).toEqual({ value: receipt });
  const trusted = await login("trusted");
  expect((await post(trusted.token, "/api/gdocs/export", { messageId: message.id })).status).toBe(200);
  expect(update).toHaveBeenCalledExactlyOnceWith("existing_document", "retry contents");
});

it.each(["read", "write"] as const)("does not restart after revocation during receipt %s or consume the retry key", async (phase) => {
  const session = await login(), held = barrier();
  const response = await post(session.token, "/api/bots", spec); expect(response.status).toBe(201);
  const bot = await response.json() as { id: string };
  const manager = (hub as unknown as { botManager: BotManager }).botManager;
  // Observe the real worker-control boundary without dispatching a model request.
  const perform = vi.spyOn(manager as unknown as { performRestart(id: string): Promise<unknown> }, "performRestart");
  const original = JsonStore.prototype[phase]; let intercepted = false;
  vi.spyOn(JsonStore.prototype, phase).mockImplementation(async function (this: JsonStore<unknown>, value: unknown) {
    const result = await original.call(this, value);
    if (!intercepted && (this as unknown as { filePath: string }).filePath.includes(`${path.sep}bot-operations${path.sep}`)) {
      intercepted = true; held.enter(); await held.gate;
    }
    return result;
  });
  const receiptId = "held_restart", pending = post(session.token, `/api/bots/${bot.id}/restart`, { receiptId });
  try { await held.waiting; await invalidate("revoke"); } finally { held.release(); }
  expect((await pending).status).toBe(401); expect(perform).not.toHaveBeenCalled();
  const key = createHash("sha256").update(`restart:${receiptId}`).digest("hex");
  const saved = await readFile(path.join(root, "bot-operations", bot.id, "gateway-receipts", `${key}.json`), "utf8").catch(() => "null");
  expect(JSON.parse(saved)).toBeNull();
  const trusted = await login("trusted");
  expect((await post(trusted.token, `/api/bots/${bot.id}/restart`, { receiptId })).status).toBe(200);
  expect(perform).toHaveBeenCalledTimes(1);
});
