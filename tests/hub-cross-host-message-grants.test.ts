import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotMessages, messageHostId } from "../src/hub/bot-messages.js";
import { hashSecret } from "../src/hub/auth.js";
import { networkId } from "../src/hub/private-network.js";
import { startHubControl } from "../src/hub/service.js";
import { networkCanonical, networkManifestProof, networkManifestSchema } from "../src/client-protocol/private-network.js";
import { botMessageGrantsCommandSchema, crossHostMessageGrantsCommandSchema, crossHostMessageGrantsSnapshotSchema, messageHostIdSchema, type CrossHostMessageGrantsCommand } from "../src/client-protocol/bot-message-grants.js";
import type { BotLocalRequest } from "../src/client-protocol/bot-messages.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { initializeHost } from "../src/host-cli/setup.js";

type Change = { targetBot: string; allowed: boolean };
let root: string, bDir: string, a: HubServer, b: HubServer, source: BotMessages, reverse: BotMessages, macId: string, winId: string, authorityId: string;
// A third authority lets the source or this Host leave while the manifest stays valid.
let authority: { key: string; privateKey: KeyObject };
const guard = async () => undefined;
const secret = "test-".repeat(10);
const read = () => b.botMessages.readCrossHostGrants("owner", guard);
const command = async (changes: Change[], sourceBot = "source", sourceHost = macId): Promise<CrossHostMessageGrantsCommand> =>
  ({ operation: "cross-host-message-grants", sourceHost, sourceBot, revision: (await read()).revision, changes });
const update = async (changes: Change[], sourceBot = "source", sourceHost = macId) =>
  b.botMessages.updateCrossHostGrants("owner", "device_test", await command(changes, sourceBot, sourceHost), guard, guard);
const audits = () => b.store.db.all<{ actor: string; detail_json: string }>("SELECT actor,detail_json FROM audit_log WHERE kind='bot-message.cross-host-grants-updated' ORDER BY id");
const grantRows = () => b.store.db.all("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key");
const keyPair = () => { const pair = generateKeyPairSync("ed25519"); return { key: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey: pair.privateKey }; };
const signManifest = (manifest: any) => sign(null, Buffer.from(networkManifestProof(manifest)), authority.privateKey).toString("base64");
const peers = (snapshot: { hosts: { id: string }[] }) => snapshot.hosts.filter(host => host.id !== authorityId);
const input = (operation: BotLocalRequest["operation"], data: Record<string, unknown> = {}, conversation?: string, requestId = randomUUID()): BotLocalRequest =>
  ({ operation, host: "Windows", bot: "target", requestId, data, ...(conversation ? { conversation } : {}) });
const call = (request: BotLocalRequest) => source.local(request, "source", guard, true) as Promise<any>;

/** Rewrites Host B's local view of the signed membership (authority A re-signs). */
async function setNetwork(change: (state: any, manifest: any) => void) {
  const row = await b.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
  const state = JSON.parse(row!.value);
  change(state, state.membership?.manifest);
  if (state.membership) {
    const manifest = networkManifestSchema.parse(state.membership.manifest);
    state.membership = { manifest, signature: signManifest(manifest) };
  }
  await b.store.db.run("UPDATE meta SET value=? WHERE key='private-network:v1'", [JSON.stringify(state)]);
}
const entry = (manifest: any, key: string) => manifest.hosts.find((host: any) => host.publicKey === key);
async function withOwnerClient<T>(run: (client: LocalHostClient) => Promise<T>): Promise<T> {
  const close = await startHubControl(bDir, { running: true, pid: process.pid, url: b.url, instanceUrl: b.instanceUrl, publicKey: b.auth.publicKey }, () => {}, { enrollController: value => b.enrollLocalController(value) });
  const client = await LocalHostClient.connect(bDir, { enroll: true });
  try { return await run(client); } finally { client.close(); await close(); }
}
const proofFor = (client: LocalHostClient, value: unknown) => client.deviceAction({ operation: "bot-message-grant", target: hashSecret(networkCanonical(value)) });

beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "cross-host-grants-")); bDir = path.join(root, "b");
  await initializeHost(bDir, "Windows");
  a = await HubServer.start({ stateDir: path.join(root, "a") }); b = await HubServer.start({ stateDir: bDir });
  await a.profile.update({ name: "Mac", revision: 0 }); await b.profile.update({ name: "Windows", revision: 0 });
  for (const hub of [a, b]) for (const [id, name] of [["source", "Source"], ["target", "Target"], ["other", "Other"]]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id!, name!, hashSecret(secret)]);
  const nonce = randomBytes(32).toString("base64url");
  authority = keyPair(); authorityId = messageHostId(authority.key);
  const manifest = networkManifestSchema.parse({ v: 2, id: networkId(authority.key, nonce), name: "Test", authorityKey: authority.key, genesisNonce: nonce, revision: 1,
    hosts: [[authority.key, "Authority"], [a.auth.publicKey, "Mac"], [b.auth.publicKey, "Windows"]].map(([publicKey, name]) => ({ publicKey, name, routes: [], protocol: 2, state: "active", revoked: false })),
    devices: [], revokedMembers: [], blockedBindings: [] });
  const membership = { manifest, signature: signManifest(manifest) };
  for (const hub of [a, b]) await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  source = new BotMessages(a.store, a.auth, a.network, a.attachments, async (_host, signed, body) => b.botMessages.receive(signed, signed.passport.method, signed.passport.path, body));
  reverse = new BotMessages(b.store, b.auth, b.network, b.attachments, async (_host, signed, body) => a.botMessages.receive(signed, signed.passport.method, signed.passport.path, body));
  macId = messageHostId(a.auth.publicKey); winId = messageHostId(b.auth.publicKey);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); });

it("keeps the command strict, bounded, unique and in its own signed domain", () => {
  expect(messageHostIdSchema.parse(macId)).toBe(macId);
  const base = { operation: "cross-host-message-grants", sourceHost: macId, sourceBot: "source", revision: "0".repeat(64), changes: [{ targetBot: "target", allowed: true }] };
  expect(crossHostMessageGrantsCommandSchema.safeParse(base).success).toBe(true);
  for (const invalid of [
    { ...base, extra: true }, { ...base, operation: "local-message-grants" }, { ...base, sourceHost: "Mac" }, { ...base, sourceHost: a.auth.publicKey },
    { ...base, sourceBot: "a/b" }, { ...base, revision: "x" }, { ...base, changes: [] },
    { ...base, changes: [{ targetBot: "target", allowed: true }, { targetBot: "target", allowed: false }] },
    { ...base, changes: [{ targetBot: "target", allowed: true, sourceHost: macId }] },
    { ...base, changes: Array.from({ length: 257 }, (_, i) => ({ targetBot: `t${i}`, allowed: true })) },
  ]) expect(crossHostMessageGrantsCommandSchema.safeParse(invalid).success).toBe(false);
  // Neither command parses as the other, so their proof digests never collide in use.
  expect(botMessageGrantsCommandSchema.safeParse(base).success).toBe(false);
  expect(crossHostMessageGrantsCommandSchema.safeParse({ ...base, operation: "local-message-grants", sourceHost: undefined }).success).toBe(false);
});

it("lists available peers and residual cross-host edges only; hides local, revoked and worker edges without writing", async () => {
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "target" }, guard);
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "w" }, guard);
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "other", targetBot: "target", revoke: true }, guard);
  await b.botMessages.grant({ sourceHost: "Windows", sourceBot: "source", targetBot: "target" }, guard);
  const before = await b.store.db.all("SELECT * FROM meta ORDER BY key");
  const snapshot = crossHostMessageGrantsSnapshotSchema.parse(await read());
  expect(snapshot.host).toEqual({ id: winId, name: "Windows" });
  expect(peers(snapshot)).toEqual([{ id: macId, name: "Mac", available: true }]);
  expect(snapshot.hosts).toContainEqual({ id: authorityId, name: "Authority", available: true });
  expect(snapshot.hosts.map(host => host.id)).toEqual([...snapshot.hosts.map(host => host.id)].sort());
  expect(snapshot.bots).toEqual([{ id: "other", name: "Other", online: false }, { id: "source", name: "Source", online: false }, { id: "target", name: "Target", online: false }]);
  expect(snapshot.grants).toEqual([{ sourceHost: macId, sourceBot: "source", targetBot: "target" }]);
  expect(JSON.stringify(snapshot)).not.toContain(a.auth.publicKey);
  expect(await b.store.db.all("SELECT * FROM meta ORDER BY key")).toEqual(before);
  // The local tab still reads only its own Host's edges.
  expect((await b.botMessages.readGrants("owner", guard)).grants).toEqual([{ sourceBot: "source", targetBot: "target" }]);
});

it("requires the owner and a matching one-use device proof; tamper, replay, other domains and expiry write nothing", async () => {
  await b.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  await expect(b.botMessages.readCrossHostGrants("member", guard)).rejects.toThrow();
  await expect(b.botMessages.updateCrossHostGrants("member", "member_device", await command([{ targetBot: "target", allowed: true }]), guard, guard)).rejects.toThrow();
  const route = "/api/bot-messages/cross-host-grants";
  expect((await fetch(b.url + route)).ok).toBe(false);
  for (const method of ["GET", "POST"]) {
    const bot = await fetch(b.instanceUrl + route, { method, headers: { Authorization: `Instance target:${secret}` }, ...(method === "POST" ? { body: JSON.stringify({ command: await command([{ targetBot: "target", allowed: true }]) }) } : {}) });
    expect(bot.ok).toBe(false);
  }
  await withOwnerClient(async client => {
    expect(await client.request(route)).toEqual(await read());
    const input = await command([{ targetBot: "target", allowed: true }]);
    await expect(client.request(route, "POST", { command: input })).rejects.toThrow();
    const tampered = await proofFor(client, input);
    await expect(client.request(route, "POST", { command: { ...input, sourceBot: "other" }, proof: tampered })).rejects.toThrow("device_action_invalid");
    await expect(client.request(route, "POST", { command: input, proof: tampered })).rejects.toThrow("device_action_expired");
    const forged = await proofFor(client, input);
    const flipped = (forged.signature[0] === "A" ? "B" : "A") + forged.signature.slice(1);
    await expect(client.request(route, "POST", { command: input, proof: { ...forged, signature: flipped } })).rejects.toThrow("device_action_invalid");
    // Other grant endpoints parse their own command shapes and never accept this one.
    const other = await proofFor(client, input);
    await expect(client.request("/api/bot-messages/grants", "POST", { command: input, proof: other })).rejects.toThrow();
    await expect(client.request("/api/bot-messages/grant", "POST", { command: input, proof: other })).rejects.toThrow();
    const local = { operation: "local-message-grants", sourceBot: "source", revision: (await b.botMessages.readGrants("owner", guard)).revision, changes: [{ targetBot: "target", allowed: true }] };
    await expect(client.request(route, "POST", { command: local, proof: await proofFor(client, local) })).rejects.toThrow();
    // HubAuth captures its clock at startup; age the outstanding challenge instead.
    const late = await proofFor(client, input);
    const permits = (b.auth as unknown as { actions: Map<string, { statement: { expiresAt: number } }> }).actions;
    permits.get(late.nonce)!.statement.expiresAt = Date.now() - 1;
    await expect(client.request(route, "POST", { command: input, proof: late })).rejects.toThrow("device_action_expired");
    expect((await read()).grants).toEqual([]);
    expect((await b.botMessages.readGrants("owner", guard)).grants).toEqual([]);
    expect(await audits()).toEqual([]);
    const proof = await proofFor(client, input);
    const result: any = await client.request(route, "POST", { command: input, proof });
    expect(result.grants).toEqual([{ sourceHost: macId, sourceBot: "source", targetBot: "target" }]);
    await expect(client.request(route, "POST", { command: input, proof })).rejects.toThrow("device_action_expired");
    const audit = await audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(client.deviceId);
    expect(JSON.parse(audit[0]!.detail_json)).toEqual({ sourceHost: macId, sourceBot: "source", changes: [{ targetBot: "target", allowed: true, previous: false }] });
  });
});

it("reads the same snapshot from the CLI with --cross-host and keeps the original grants output and allow/revoke results", async () => {
  await withOwnerClient(async () => {
    expect(await runBotMessagesCommand(bDir, "allow", { from: "Mac/source", bot: "target" })).toEqual({ hostId: macId, sourceBotId: "source", botId: "target", revoked: false });
    expect(await runBotMessagesCommand(bDir, "grants", { "cross-host": true })).toEqual(await read());
    const local: any = await runBotMessagesCommand(bDir, "grants", {});
    expect(local).toEqual(await b.botMessages.readGrants("owner", guard));
    expect(local).not.toHaveProperty("hosts"); expect(local.grants).toEqual([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runHostCli(["messages", "grants", "--cross-host", "--state-dir", bDir, "--json"]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(await read());
    log.mockRestore();
    await expect(runHostCli(["messages", "send", "--cross-host", "--state-dir", bDir])).rejects.toThrow();
    expect(await runBotMessagesCommand(bDir, "revoke", { from: "Mac/source", bot: "target" })).toEqual({ hostId: macId, sourceBotId: "source", botId: "target", revoked: true });
    expect((await read()).grants).toEqual([]);
    vi.stubEnv("TAROBOT_INSTANCE", "target");
    await expect(runBotMessagesCommand(bDir, "grants", { "cross-host": true })).rejects.toThrow("bot_message_grant_requires_owner_controller");
  });
});

it("keeps drafts across renames, online state, worker creation and local edits; peers, CLI ABA, target lifecycle and writes change the revision", async () => {
  const first = await read();
  await b.store.db.run("UPDATE bots SET name='Renamed',online=1 WHERE id='target'");
  await b.profile.update({ name: "Windows Renamed", revision: (await b.profile.read()).revision });
  await setNetwork((_state, manifest) => { entry(manifest, a.auth.publicKey).name = "Mac Renamed"; manifest.revision++; });
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  const localBefore = (await b.botMessages.readGrants("owner", guard)).revision;
  await b.botMessages.updateGrants("owner", "device_test", { operation: "local-message-grants", sourceBot: "source", revision: localBefore, changes: [{ targetBot: "target", allowed: true }] }, guard, guard);
  const renamed = await read();
  expect(renamed.revision).toBe(first.revision);
  expect(renamed.host.name).toBe("Windows Renamed");
  expect(peers(renamed)).toEqual([{ id: macId, name: "Mac Renamed", available: true }]);
  expect(renamed.bots).toContainEqual({ id: "target", name: "Renamed", online: true });
  // A cross-host write leaves the local tab's draft valid as well.
  const localRevision = (await b.botMessages.readGrants("owner", guard)).revision;
  await update([{ targetBot: "other", allowed: true }]);
  expect((await b.botMessages.readGrants("owner", guard)).revision).toBe(localRevision);
  const stale = await command([{ targetBot: "target", allowed: true }]);
  await b.botMessages.grant({ sourceHost: macId, sourceBot: "source", targetBot: "target" }, guard);
  await b.botMessages.grant({ sourceHost: macId, sourceBot: "source", targetBot: "target", revoke: true }, guard);
  const rows = await grantRows();
  await expect(b.botMessages.updateCrossHostGrants("owner", "device_test", stale, guard, guard)).rejects.toThrow("bot_message_grants_changed");
  expect(await grantRows()).toEqual(rows);
  let revision = (await read()).revision;
  expect(revision).not.toBe(stale.revision);
  await b.store.db.run("UPDATE bots SET deleted_at=? WHERE id='target'", [Date.now()]);
  expect((await read()).revision).not.toBe(revision); revision = (await read()).revision;
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fresh','Fresh',?)", [hashSecret(secret)]);
  expect((await read()).revision).not.toBe(revision); revision = (await read()).revision;
  const joined = keyPair().key;
  await setNetwork((_state, manifest) => { manifest.hosts.push({ publicKey: joined, name: "Linux", routes: [], protocol: 2, state: "active", revoked: false }); manifest.revision++; });
  const withPeer = await read();
  expect(withPeer.revision).not.toBe(revision);
  expect(withPeer.hosts).toContainEqual({ id: messageHostId(joined), name: "Linux", available: true });
});

const pendingHost = (host: any) => Object.assign(host, { state: "pending", proposalNonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 60_000 });
it.each([
  ["removed source", (_s: any, m: any) => { entry(m, a.auth.publicKey).revoked = true; }, "Mac", "bot_message_peer_revoked"],
  ["host tombstone", (s: any, m: any) => { s.revokedHosts.push(`${m.id}:${a.auth.publicKey}`); }, "Mac", "bot_message_peer_revoked"],
  ["pending source", (_s: any, m: any) => { pendingHost(entry(m, a.auth.publicKey)); }, "Mac", "bot_message_peer_revoked"],
  ["retired network", (s: any, m: any) => { s.retiredNetworks.push(m.id); }, "Mac", "bot_message_peer_revoked"],
  ["this host removed", (_s: any, m: any) => { entry(m, b.auth.publicKey).revoked = true; }, "Mac", "network_host_removed"],
  ["network left", (s: any) => { delete s.membership; }, "id", "network_not_joined"],
] as const)("%s: blocks new grants and mixed batches at once, keeps old edges inert and revocable", async (_name, change, name, code) => {
  await update([{ targetBot: "target", allowed: true }]);
  const chat = await call(input("resolve"));
  const before = await read();
  await setNetwork(change);
  const after = await read();
  expect(after.revision).not.toBe(before.revision);
  expect(peers(after)).toEqual([{ id: macId, name: name === "id" ? macId : name, available: false }]);
  // Hosts without remaining edges are listed only while they are available.
  expect(after.hosts.filter(host => host.id === authorityId).every(host => host.available)).toBe(true);
  expect(after.grants).toEqual(before.grants);
  await expect(call(input("send", { text: "After removal", attachments: [] }, chat.conversationId))).rejects.toThrow();
  const rows = await grantRows(), audit = await audits();
  await expect(update([{ targetBot: "other", allowed: true }])).rejects.toThrow(code);
  await expect(update([{ targetBot: "target", allowed: true }])).rejects.toThrow(code);
  await expect(update([{ targetBot: "target", allowed: false }, { targetBot: "other", allowed: true }])).rejects.toThrow(code);
  await expect(update([{ targetBot: "other", allowed: false }])).rejects.toThrow("bot_message_grant_not_found");
  expect(await grantRows()).toEqual(rows); expect(await audits()).toEqual(audit);
  const revoked = await update([{ targetBot: "target", allowed: false }]);
  expect(revoked.grants).toEqual([]);
  expect(peers(revoked)).toEqual([]);
});

// The owner CLI must be able to clean up the same residual edges as the App.
const cliRevoke = (from: string, bot = "target") => runBotMessagesCommand(bDir, "revoke", { from, bot });
const cliAllow = (from: string, bot = "target") => runBotMessagesCommand(bDir, "allow", { from, bot });
// Grant changes only; rejected attempts keep their separate `bot-message.rejected` audit.
const grantAudits = () => b.store.db.all<{ kind: string; detail_json: string }>("SELECT kind,detail_json FROM audit_log WHERE kind IN ('bot-message.granted','bot-message.grant-revoked','bot-message.grants-updated','bot-message.cross-host-grants-updated') ORDER BY id");
const changedRows = async (before: unknown[]) => (await grantRows()).filter((row, index) => JSON.stringify(row) !== JSON.stringify(before[index]));
it.each([
  ["removed source", (_s: any, m: any) => { entry(m, a.auth.publicKey).revoked = true; }, false],
  ["host tombstone", (s: any, m: any) => { s.revokedHosts.push(`${m.id}:${a.auth.publicKey}`); }, true],
  ["pending source", (_s: any, m: any) => { pendingHost(entry(m, a.auth.publicKey)); }, false],
  ["retired network", (s: any, m: any) => { s.retiredNetworks.push(m.id); }, true],
  ["this host removed", (_s: any, m: any) => { entry(m, b.auth.publicKey).revoked = true; }, true],
  ["network left", (s: any) => { delete s.membership; }, false],
] as const)("%s: the owner CLI revokes the residual edge by exact ID; allow, unknown edges and unlisted names write nothing", async (_name, change, listedByName) => {
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  await update([{ targetBot: "target", allowed: true }]);
  await b.botMessages.grant({ sourceHost: macId, sourceBot: "source", targetBot: "w" }, guard);
  await withOwnerClient(async () => {
    await setNetwork(change);
    const before = await read(), rows = await grantRows(), audit = await grantAudits();
    expect(before.grants).toEqual([{ sourceHost: macId, sourceBot: "source", targetBot: "target" }]);
    await expect(cliAllow(`${macId}/source`)).rejects.toThrow();
    await expect(cliAllow(`${macId}/other`)).rejects.toThrow();
    await expect(cliRevoke(`${macId}/other`)).rejects.toThrow();
    await expect(cliRevoke(`hub_${"0".repeat(64)}/source`)).rejects.toThrow("target_not_found");
    // A removed Host is never found by its old display name.
    if (!listedByName) await expect(cliRevoke("Mac/source")).rejects.toThrow("target_not_found");
    expect(await grantRows()).toEqual(rows); expect(await grantAudits()).toEqual(audit);
    expect(await cliRevoke(`${macId}/source`)).toEqual({ hostId: macId, sourceBotId: "source", botId: "target", revoked: true });
    const after = await read();
    expect(after.grants).toEqual([]);
    expect(after.revision).not.toBe(before.revision);
    // Only the selected edge changes; the hidden worker record is untouched.
    const changed = await changedRows(rows);
    expect(changed).toHaveLength(1);
    expect(JSON.parse((changed[0] as { value: string }).value)).toEqual({ sourceKey: a.auth.publicKey, sourceBot: "source", targetBot: "target", revoked: true });
    expect((await grantAudits()).slice(audit.length).map(entry => [entry.kind, JSON.parse(entry.detail_json)])).toEqual([
      ["bot-message.grant-revoked", { hostId: macId, sourceBot: "source", targetBot: "target", residual: true }]]);
    // Nothing remains to revoke; the edge is not recreated or re-enabled.
    const settled = await grantRows();
    await expect(cliRevoke(`${macId}/source`)).rejects.toThrow();
    expect(await grantRows()).toEqual(settled);
  });
});

it("the owner CLI revokes a deleted recipient's residual edge by exact Bot ID only; live-target CLI semantics are unchanged", async () => {
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  await withOwnerClient(async () => {
    await cliAllow(`${macId}/source`, "target"); await cliAllow(`${macId}/source`, "w"); await cliAllow(`${winId}/source`, "other");
    await b.store.db.run("UPDATE bots SET deleted_at=? WHERE id IN ('target','other')", [Date.now()]);
    const before = await read(), rows = await grantRows(), audit = await grantAudits();
    expect(before.bots).toContainEqual({ id: "target", name: "Target", online: false, deleted: true });
    await expect(cliAllow(`${macId}/source`, "target")).rejects.toThrow();
    // No name fallback for deleted Bots, and no edge to revoke for "other".
    await expect(cliRevoke(`${macId}/source`, "Target")).rejects.toThrow("target_not_found");
    await expect(cliRevoke(`${macId}/source`, "other")).rejects.toThrow("target_not_found");
    await expect(cliRevoke(`${macId}/source`, "missing")).rejects.toThrow("target_not_found");
    expect(await grantRows()).toEqual(rows); expect(await grantAudits()).toEqual(audit);
    expect(await cliRevoke(`${macId}/source`, "target")).toEqual({ hostId: macId, sourceBotId: "source", botId: "target", revoked: true });
    const after = await read();
    expect(after.grants).toEqual([]); expect(after.bots.map(bot => bot.id)).not.toContain("target");
    expect(await changedRows(rows)).toHaveLength(1);
    // A live worker target keeps the original CLI behavior.
    expect(await cliRevoke(`${macId}/source`, "w")).toEqual({ hostId: macId, sourceBotId: "source", botId: "w", revoked: true });
    // A local edge to a deleted Bot is also revocable; it advances the local revision only.
    const local = (await b.botMessages.readGrants("owner", guard)).revision, cross = (await read()).revision;
    expect(await cliRevoke(`${winId}/source`, "other")).toEqual({ hostId: winId, sourceBotId: "source", botId: "other", revoked: true });
    expect((await b.botMessages.readGrants("owner", guard)).revision).not.toBe(local);
    expect((await read()).revision).toBe(cross);
  });
});

it("revokes only existing visible edges, keeps hidden worker records, exposes deleted targets for revocation only and rolls back failed batches", async () => {
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  await b.botMessages.grant({ sourceHost: "Mac", sourceBot: "source", targetBot: "w" }, guard);
  const worker = await grantRows();
  await expect(update([{ targetBot: "w", allowed: false }])).rejects.toThrow("bot_deleted");
  await expect(update([{ targetBot: "w", allowed: true }])).rejects.toThrow("bot_deleted");
  await expect(update([{ targetBot: "missing", allowed: true }])).rejects.toThrow("bot_deleted");
  await expect(update([{ targetBot: "target", allowed: false }])).rejects.toThrow("bot_message_grant_not_found");
  await expect(update([{ targetBot: "target", allowed: true }], "source", winId)).rejects.toThrow("bot_message_grant_local_source");
  await expect(update([{ targetBot: "target", allowed: false }], "source", `hub_${"0".repeat(64)}`)).rejects.toThrow("bot_message_host_not_found");
  expect(await grantRows()).toEqual(worker); expect(await audits()).toEqual([]);
  await update([{ targetBot: "target", allowed: true }, { targetBot: "other", allowed: true }]);
  await b.store.db.run("UPDATE bots SET deleted_at=? WHERE id='target'", [Date.now()]);
  const deleted = await read();
  expect(deleted.bots).toContainEqual({ id: "target", name: "Target", online: false, deleted: true });
  expect(deleted.grants).toEqual([{ sourceHost: macId, sourceBot: "source", targetBot: "other" }, { sourceHost: macId, sourceBot: "source", targetBot: "target" }]);
  await expect(update([{ targetBot: "target", allowed: true }])).rejects.toThrow("bot_deleted");
  const cleaned = await update([{ targetBot: "target", allowed: false }]);
  expect(cleaned.bots.map(bot => bot.id)).toEqual(["other", "source"]);
  expect(cleaned.grants).toEqual([{ sourceHost: macId, sourceBot: "source", targetBot: "other" }]);
  expect(await b.store.db.get("SELECT value FROM meta WHERE key=?", [(worker[0] as { key: string }).key])).toEqual({ value: (worker[0] as { value: string }).value });
  await b.store.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON meta WHEN NEW.value LIKE '%\"targetBot\":\"source\"%' BEGIN SELECT RAISE(ABORT,'storage_full'); END");
  const rows = await grantRows(), audit = await audits();
  await expect(update([{ targetBot: "other", allowed: false }, { targetBot: "source", allowed: true }])).rejects.toThrow("storage_full");
  expect(await grantRows()).toEqual(rows); expect(await audits()).toEqual(audit);
});

it("approves one direction through the existing queue and reply; the reverse direction and a revoked edge stay blocked", async () => {
  await expect(call(input("resolve"))).rejects.toThrow("not_authorized");
  await update([{ targetBot: "target", allowed: true }]);
  const chat = await call(input("resolve"));
  const receipt = await call(input("send", { text: "Cross-host task", attachments: [] }, chat.conversationId));
  expect(receipt).toMatchObject({ hostId: winId, botId: "target", status: "queued" });
  await b.store.publishBotMessage("target", { conversationId: chat.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Original result" }] });
  await b.store.acknowledgeDelivery("target", receipt.messageId);
  const wait = input("wait", { messageId: receipt.messageId }, chat.conversationId);
  expect(await call(wait)).toMatchObject({ status: "completed", text: "Original result" });
  await expect(reverse.local({ operation: "resolve", host: "Mac", bot: "source", requestId: randomUUID(), data: {} }, "target", guard, true)).rejects.toThrow("not_authorized");
  expect((await a.botMessages.readCrossHostGrants("owner", guard)).grants).toEqual([]);
  await update([{ targetBot: "target", allowed: false }]);
  await expect(call(input("send", { text: "After revoke", attachments: [] }, chat.conversationId))).rejects.toThrow("not_authorized_or_revoked");
  await expect(call(wait)).rejects.toThrow("not_authorized_or_revoked");
});
