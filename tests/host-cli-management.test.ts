import { botAvatarById } from "../src/client-protocol/bot-avatar-catalog.js";
import os from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { LocalHostClient, resetCliController } from "../src/host-cli/client.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runHostCli } from "../src/host-cli/cli.js";
import { HostManagement } from "../src/host-cli/management.js";
import { HostNetwork, verifyCliNetworkMembership } from "../src/host-cli/network-cli.js";
import { HubServer } from "../src/hub/server.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { controlPath, startHubControl } from "../src/hub/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { networkCanonical } from "../src/client-protocol/private-network.js";

const hosts: { directory: string; hub: HubServer; closeControl: () => Promise<void> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { directory, hub, closeControl } of hosts.splice(0)) { await closeControl(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
async function host(tls = false, initialized = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taro-cli-"));
  if (initialized) await initializeHost(directory, "CLI audit");
  const files = tls ? await desktopTls(directory, ["127.0.0.1"]) : undefined;
  if (files) await writeFile(path.join(directory, "config.json"), JSON.stringify({ tls: { cert: files.cert, key: files.key } }));
  const hub = await HubServer.start({ stateDir: directory,
    ...(files ? { tls: { cert: await readFile(files.cert), key: await readFile(files.key) } } : {}),
    managedBots: { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.resolve("tests/fixtures/agy-models.mjs") } },
    networkExchange: async (target, request) => {
      const peer = hosts.find(item => item.hub.auth.publicKey === target.publicKey);
      if (!peer) throw new Error("test_peer_unavailable");
      return peer.hub.network.peer(request, "test_cli_peer");
    },
  });
  const closeControl = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const result = { directory, hub, closeControl }; hosts.push(result); return result;
}
async function client(root: Awaited<ReturnType<typeof host>>) { return LocalHostClient.connect(root.directory, { enroll: true }); }
async function phone(root: Awaited<ReturnType<typeof host>>, id: string) {
  const key = generateKeyPairSync("ed25519");
  return root.hub.auth.pair({ deviceId: id, name: "Phone", platform: "android", publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64") }, "fixture");
}

it("does not create state on missing/stopped hosts or a read without an enrolled controller", async () => {
  const root = await host(), directory = path.join(root.directory, "absent");
  await expect(LocalHostClient.connect(directory)).rejects.toThrow("host_not_running");
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  const files = await readdir(root.directory);
  await expect(LocalHostClient.connect(root.directory)).rejects.toThrow("cli_controller_missing_run_host_enroll");
  expect(await readdir(root.directory)).toEqual(files);
  expect(await root.hub.store.devices("owner")).toEqual([]);
});

it("uses the authenticated loopback instance listener for a TLS host and refuses untrusted remote control endpoints", async () => {
  const root = await host(true), local = await client(root);
  expect(local.url).toBe(root.hub.instanceUrl); expect(root.hub.url).toMatch(/^https:/);
  expect((await new HostManagement(local).profile()).name).toBeTruthy(); local.close();
  await root.closeControl();
  root.closeControl = await startHubControl(root.directory, { running: true, pid: process.pid, url: "https://remote.example:8788", publicKey: root.hub.auth.publicKey }, () => {});
  await expect(LocalHostClient.connect(root.directory)).rejects.toThrow("cli_control_requires_loopback_listener");
});

it("enrolls one persistent host controller under concurrency and never adopts a phone or revoked key", async () => {
  const root = await host();
  const [first, second] = await Promise.all([client(root), client(root)]);
  expect(first.deviceId).toBe(second.deviceId);
  expect((await root.hub.store.devices("owner")).map(device => device.name)).toEqual(["TaroBird CLI"]);
  expect(await root.hub.store.db.serial(() => root.hub.auth.originalDeviceScopesInTransaction())).toEqual(new Map([[first.deviceId, "host"]]));
  const keyFile = path.join(root.directory, "cli/identity.json"), saved = await readFile(keyFile, "utf8");
  if (process.platform !== "win32") expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  first.close(); second.close();
  const third = await LocalHostClient.connect(root.directory); expect(third.deviceId).toBe(first.deviceId); third.close();
  await root.hub.auth.revoke(first.deviceId, "local-owner");
  await expect(client(root)).rejects.toThrow("desktop_controller_identity_invalid");
  expect(await readFile(keyFile, "utf8")).toBe(saved);
});

it("pins the running identity and rejects broad private-key permissions before authentication", async () => {
  const root = await host(), initial = await client(root); initial.close();
  const file = path.join(root.directory, "identity.json"), original = await readFile(file, "utf8");
  const wrong = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await writeFile(file, JSON.stringify({ ...JSON.parse(original), publicKey: wrong }));
  await expect(LocalHostClient.connect(root.directory)).rejects.toThrow("cli_host_identity_changed");
  await writeFile(file, original);
  if (process.platform !== "win32") {
    await chmod(path.join(root.directory, "cli/identity.json"), 0o644);
    await expect(LocalHostClient.connect(root.directory)).rejects.toThrow("cli_identity_permissions");
  }
});

it("enrolls inside the running process without migrating a live database", async () => {
  const root = await host();
  await root.hub.store.db.run("UPDATE meta SET value='13' WHERE key='schema_version'");
  const local = await client(root); local.close();
  expect(await root.hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "13" });
  expect(await root.hub.store.devices("owner")).toHaveLength(1);
});

it("never falls back to direct database writes when a running host lacks enrollment control", async () => {
  const root = await host(); await root.closeControl();
  root.closeControl = await startHubControl(root.directory, { running: true, pid: process.pid, url: root.hub.url, publicKey: root.hub.auth.publicKey }, () => {});
  await expect(client(root)).rejects.toThrow("host_update_required_enroll_controller");
  expect(await root.hub.store.devices("owner")).toEqual([]);
  await expect(stat(path.join(root.directory, "cli/identity.pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("requires the local control token and expected host identity before enrolling", async () => {
  const root = await host(), key = generateKeyPairSync("ed25519");
  const controller = { deviceId: "cli_rejected", name: "TaroBot CLI", platform: "web", publicKey: key.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const token = (await readFile(path.join(root.directory, "hub-control.key"), "utf8")).trim();
  const send = (body: unknown) => new Promise<string>((resolve, reject) => {
    const socket = net.createConnection(controlPath(root.directory)); let result = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("test_timeout")));
    socket.on("connect", () => socket.end(JSON.stringify(body) + "\n")); socket.on("data", chunk => { result += chunk.toString(); });
    socket.on("close", () => resolve(result)); socket.on("error", reject);
  });
  expect(await send({ command: "enroll-controller", controller, expectedPublicKey: root.hub.auth.publicKey })).toBe("");
  expect(await send({ command: "enroll-controller", controller, expectedPublicKey: controller.publicKey, token })).toBe("");
  expect(await root.hub.store.devices("owner")).toEqual([]);
});

it("recovers an interrupted enrollment with the same key without canceling another device's pairing", async () => {
  const root = await host();
  const enroll = root.hub.enrollLocalController.bind(root.hub);
  vi.spyOn(root.hub, "enrollLocalController").mockImplementationOnce(async raw => { await enroll(raw); throw new Error("fixture_interrupted_enrollment"); });
  await expect(client(root)).rejects.toThrow("fixture_interrupted_enrollment");
  await expect(stat(path.join(root.directory, "cli/identity.json"))).rejects.toMatchObject({ code: "ENOENT" });
  const before = JSON.parse(await readFile(path.join(root.directory, "cli/identity.pending.json"), "utf8"));
  await phone(root, "pending_phone");
  const recovered = await client(root);
  expect(recovered.deviceId).toBe(before.deviceId);
  expect(JSON.parse(await readFile(path.join(root.directory, "cli/identity.json"), "utf8")).publicKey).toBe(before.publicKey);
  expect((await new HostManagement(recovered).pendingDevices()).map(device => device.deviceId)).toEqual(["pending_phone"]);
  recovered.close();
});

it("never upgrades a paired owner to host scope and enrolls a new desktop controller atomically", async () => {
  const root = await host(), pending = await phone(root, "phone_existing"); await root.hub.auth.approve(pending.code, "local-owner");
  const phoneRow = (await root.hub.store.device("phone_existing"))!;
  await expect(root.hub.enrollLocalController({ deviceId: phoneRow.id, publicKey: phoneRow.public_key, name: "Desktop", platform: "macos" })).rejects.toThrow("desktop_controller_identity_invalid");
  expect(await root.hub.store.db.serial(() => root.hub.auth.originalDeviceScopesInTransaction())).toEqual(new Map([[phoneRow.id, "network"]]));
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const desktop = { deviceId: "desktop_new", publicKey, name: "Desktop", platform: "macos" };
  const execute = root.hub.store.db.run.bind(root.hub.store.db);
  const failing = vi.spyOn(root.hub.store.db, "run").mockImplementation(async (sql, params) => {
    if (sql.startsWith("INSERT INTO meta(key,value)") && String(params?.[0]).startsWith("desktop-controller:")) throw new Error("fixture_marker_write_failed");
    return execute(sql, params);
  });
  await expect(root.hub.enrollLocalController(desktop)).rejects.toThrow("fixture_marker_write_failed"); failing.mockRestore();
  expect(await root.hub.store.device(desktop.deviceId)).toBeUndefined();
  await root.hub.enrollLocalController(desktop); await root.hub.enrollLocalController(desktop);
  expect((await root.hub.store.db.serial(() => root.hub.auth.originalDeviceScopesInTransaction())).get(desktop.deviceId)).toBe("host");
});

it("refuses symlinked private keys and orphaned restored CLI records without revoking desktop identities", async () => {
  const root = await host(), initial = await client(root); initial.close();
  const file = path.join(root.directory, "cli/identity.json"), saved = await readFile(file, "utf8"), elsewhere = path.join(root.directory, "external-key.json");
  await writeFile(elsewhere, saved, { mode: 0o600 }); await rm(file); await symlink(elsewhere, file);
  await expect(client(root)).rejects.toThrow("cli_identity_unsafe_file"); await rm(file);
  await expect(client(root)).rejects.toThrow("cli_controller_orphaned_revoke_explicitly");
  expect((await root.hub.store.device(initial.deviceId))?.revoked).toBe(0);
  const desktop = { deviceId: "desktop_existing", name: "Desktop", platform: "macos", publicKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  await root.hub.enrollLocalController(desktop); await root.hub.auth.revoke(initial.deviceId, "local-owner");
  const replacement = await client(root); replacement.close();
  expect((await root.hub.store.device(desktop.deviceId))?.revoked).toBe(0);
});

it("recovers a revoked CLI only by explicit reset and leaves the old key revoked", async () => {
  const root = await host(), initial = await client(root); initial.close();
  await expect(resetCliController(root.directory)).rejects.toThrow("cli_controller_active_revoke_before_reset");
  await root.hub.auth.revoke(initial.deviceId, "local-owner");
  expect(await resetCliController(root.directory)).toEqual({ retiredDeviceId: initial.deviceId });
  const restored = await client(root); expect(restored.deviceId).not.toBe(initial.deviceId);
  const devices = await new HostManagement(restored).devices();
  expect(devices.find(device => device.id === initial.deviceId)?.revoked).toBe(1);
  expect(devices.find(device => device.id === restored.deviceId)?.revoked).toBe(0);
  restored.close();
});

it("requests management metadata without loading conversation history and fails false-success restarts", async () => {
  const root = await host();
  const conversations = vi.spyOn(root.hub.store, "conversations").mockRejectedValue(new Error("history_must_not_load"));
  const local = await client(root);
  expect(conversations).not.toHaveBeenCalled(); expect(local.ready.bots).toEqual([]);
  vi.spyOn(local, "request").mockResolvedValueOnce({ ok: false, error: "restart_confirmation_unavailable" });
  await expect(new HostManagement(local).restartBot("bot", "ordinary_request_id")).rejects.toThrow("restart_confirmation_unavailable");
  local.close();
});

it("does not reopen the database for a previously enrolled controller", async () => {
  const root = await host(), initial = await client(root); initial.close();
  const enroll = vi.spyOn(root.hub.auth, "pair");
  // The marker and exact key already establish classification. An enrollment
  // request can reconnect without changing even an unknown future schema.
  await root.hub.store.db.run("UPDATE meta SET value='22' WHERE key='schema_version'");
  const again = await client(root); expect(again.deviceId).toBe(initial.deviceId);
  expect(enroll).not.toHaveBeenCalled();
  expect(await root.hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "22" });
  expect(JSON.stringify(again)).not.toContain("sessionToken");
  expect(JSON.stringify(again)).not.toContain("PRIVATE KEY");
  again.close();
});

it("exposes the shared Argon catalog and creates an AGY Bot through the headless API", async () => {
  const root = await host(), local = await client(root), management = new HostManagement(local);
  try {
    const agy = (await management.catalog()).engines.find(engine => engine.id === "antigravity")!;
    expect(agy.defaultModel).toBe("gemini-4-argon-medium");
    expect(agy.models.find(model => model.id === agy.defaultModel)?.label).toBe("Gemini 4 Argon (Medium)");
    const bot = await management.createBot({ requestId: "create_argon", name: "Argon", engine: "antigravity", model: agy.defaultModel, effort: "", workspace: "" });
    expect(JSON.parse(await readFile(path.join(root.directory, "bots", bot.id, "config.json"), "utf8"))).toMatchObject({ engine: "antigravity", model: "gemini-4-argon-medium" });
  } finally { local.close(); }
});

it("uses live APIs for create/rename/restart/delete and keeps history and files after retirement", async () => {
  const root = await host(), local = await client(root), management = new HostManagement(local);
  const catalog = await management.catalog(); expect(catalog.engines.map(engine => engine.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi"]);
  const bot = await management.createBot({ requestId: "create_once", name: "Local Bot", engine: "codex", model: "", effort: "", workspace: "" });
  const same = await management.createBot({ requestId: "create_once", name: "Local Bot", engine: "codex", model: "", effort: "", workspace: "" });
  expect(same.id).toBe(bot.id);
  expect(botAvatarById(bot.defaultAvatar)).toBeDefined();
  expect(bot.defaultAvatar).toBe("pastel-fox");
  expect(same.defaultAvatar).toBe(bot.defaultAvatar);
  await vi.waitFor(async () => expect((await root.hub.store.bots("owner"))[0]?.online).toBe(1));
  const refreshed = await LocalHostClient.connect(root.directory); expect(new HostManagement(refreshed).bots().map(item => ({ id: item.id, defaultAvatar: item.defaultAvatar }))).toEqual([{ id: bot.id, defaultAvatar: bot.defaultAvatar }]); refreshed.close();
  await expect(management.renameBot(bot.id, { name: "Renamed", expectedName: "Stale" })).rejects.toMatchObject({ code: "bot_name_conflict", status: 409 });
  await management.renameBot(bot.id, { name: "Renamed", expectedName: "Local Bot" });
  expect(await management.restartBot(bot.id, "restart_once")).toMatchObject({ ok: true, result: { text: "已安排空闲后重启" } });
  const chat = await root.hub.store.createConversation("owner", [bot.id], "Retained", "retained_history");
  const file = path.join(root.directory, "bots", bot.id, "workspace", "keep.txt"); await writeFile(file, "retained");
  await expect(management.deleteBot(bot.id, { expectedName: "Local Bot", confirm: true })).rejects.toMatchObject({ code: "bot_name_conflict" });
  await management.deleteBot(bot.id, { expectedName: "Renamed", confirm: true });
  expect(await root.hub.store.bots("owner")).toEqual([]);
  expect((await root.hub.store.conversations("owner")).find(item => item.id === chat.id)?.archived).toBe(true);
  expect(await readFile(file, "utf8")).toBe("retained");
  local.close();
}, 20_000);

it("reviews pending pairing identities, signs approvals/revocations and enforces fresh owner trust", async () => {
  const root = await host(), local = await client(root), management = new HostManagement(local);
  const pairing = await phone(root, "my_phone");
  const pending = await management.pendingDevices(); expect(pending).toHaveLength(1); expect(pending[0]).toMatchObject({ deviceId: "my_phone", name: "Phone", platform: "android" });
  expect(JSON.stringify(pending)).not.toContain("code_hash");
  expect((await fetch(root.hub.url + "/api/devices/pending")).status).toBe(401);
  await expect(management.approveDevice(pairing.code)).resolves.toEqual({ deviceId: "my_phone" });
  expect(await management.pendingDevices()).toEqual([]);
  expect((await management.devices()).find(item => item.id === "my_phone")?.revoked).toBe(0);
  await management.renameDevice("my_phone", "vivo 手机");
  expect((await management.devices()).find(item => item.id === "my_phone")?.name).toBe("vivo 手机");
  await expect(management.renameDevice("missing_device", "Unknown")).rejects.toMatchObject({ status: 404 });
  await management.revokeDevice("my_phone");
  expect((await management.devices()).find(item => item.id === "my_phone")?.revoked).toBe(1);
  const profile = await management.profile(); await management.renameHost("CLI Mac", profile.revision);
  await expect(management.renameHost("stale", profile.revision)).rejects.toMatchObject({ status: 409 });
  await root.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  await expect(management.pendingDevices()).rejects.toMatchObject({ status: 403 });
  await root.hub.store.db.run("UPDATE users SET role='owner' WHERE id='owner'");
  await root.hub.auth.revoke(local.deviceId, "local-owner");
  await expect(management.devices()).rejects.toMatchObject({ status: 401 });
  local.close();
});

it("rejects substituted server challenges before producing a device proof", async () => {
  const root = await host(), initial = await client(root); initial.close();
  const authenticate = vi.spyOn(root.hub.auth, "authenticate"), challenge = root.hub.auth.challenge.bind(root.hub.auth);
  vi.spyOn(root.hub.auth, "challenge").mockImplementation(async (...args) => ({ ...await challenge(...args), signature: "A".repeat(86) + "==" }));
  await expect(LocalHostClient.connect(root.directory)).rejects.toThrow("cli_host_signature_invalid");
  expect(authenticate).not.toHaveBeenCalled();
});

it("keeps headless hosts and phones in their correct scopes through signed join and departure", async () => {
  const a = await host(), b = await host(), c = await host();
  const ca = await client(a), cb = await client(b), cc = await client(c);
  const na = new HostNetwork(ca), nb = new HostNetwork(cb), nc = new HostNetwork(cc);
  const pairing = await phone(a, "network_phone"); await new HostManagement(ca).approveDevice(pairing.code);
  const created = await na.command({ operation: "create", name: "CLI Network" });
  // @ts-expect-error The public CLI type excludes phone attestation; also test the runtime boundary.
  await expect(na.command({ operation: "attest", networkId: created.membership!.manifest.id, device: { id: "remote_cli", name: "Impersonation", platform: "web", host: cb.publicKey, publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64") } })).rejects.toThrow("cli_network_host_controller_only");
  const join = async (destination: HostNetwork) => {
    const membership = (await na.view()).membership!;
    const proposal = (await destination.command({ operation: "propose", networkId: membership.manifest.id, authorityKey: ca.publicKey, seenManifestHash: hashSecret(networkCanonical(membership.manifest)) })).proposal!;
    const admitted = (await na.command({ operation: "admit", proposal })).membership!;
    return destination.command({ operation: "join", membership: admitted, nonce: proposal.proposal.nonce });
  };
  await join(nb); await join(nc);
  const membership = (await na.view()).membership!;
  expect(membership.manifest.hosts.filter(host => !host.revoked && host.state === "active")).toHaveLength(3);
  expect(membership.manifest.devices.find(device => device.id === cc.deviceId)?.scope).toBe("host");
  expect(membership.manifest.devices.find(device => device.id === "network_phone")?.scope).toBe("network");
  const tampered = structuredClone(membership); tampered.manifest.name = "tampered";
  expect(() => verifyCliNetworkMembership(tampered)).toThrow("network_membership_invalid");
  const invalidOrigin = structuredClone(membership); invalidOrigin.manifest.devices[0]!.memberId = "missing_original_member";
  invalidOrigin.signature = a.hub.auth.signNetworkManifest(invalidOrigin.manifest);
  expect(() => verifyCliNetworkMembership(invalidOrigin)).toThrow("network_membership_invalid");
  await c.hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('local_bot','Local data','fixture')");
  const departed = await nc.command({ operation: "leave", networkId: created.membership!.manifest.id, expectedState: "active" });
  expect(departed.view.sync).toBe("standalone");
  expect((await new HostManagement(ca).devices()).find(device => device.id === "network_phone")?.revoked).toBe(0);
  expect(await c.hub.store.bots("owner")).toMatchObject([{ id: "local_bot" }]);
  const reopened = await LocalHostClient.connect(c.directory); expect(reopened.deviceId).toBe(cc.deviceId); reopened.close();
  expect((await na.view()).membership!.manifest.hosts.find(host => host.publicKey === cc.publicKey)?.revoked).toBe(true);
  ca.close(); cb.close(); cc.close();
}, 20_000);

it("CLI issues, lists and revokes the same strict invitation API without changing listener or identity", async () => {
  const root = await host(), local = await client(root), management = new HostManagement(local);
  const before = { key: root.hub.auth.publicKey, url: root.hub.url, devices: await management.devices() };
  const invitation = await management.issuePairingInvite();
  expect(invitation.invite).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const list = await management.pairingInvites();
  expect(list.invites).toEqual([expect.objectContaining({ id: invitation.id, state: "available" })]);
  expect(JSON.stringify(list)).not.toContain(invitation.invite);
  expect(await management.revokePairingInvite(invitation.id)).toMatchObject({ id: invitation.id, state: "closed" });
  const keys = generateKeyPairSync("ed25519"), body = { deviceId: "from_cli_invite", name: "Phone", platform: "android", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), requestId: "r".repeat(43), invite: invitation.invite };
  const refused = await fetch(root.hub.url + "/api/pair", { method: "POST", body: JSON.stringify(body) });
  expect(refused.status).toBe(403); expect(await refused.json()).toMatchObject({ error: "pairing_invite_invalid" });
  expect({ key: root.hub.auth.publicKey, url: root.hub.url, devices: await management.devices() }).toEqual(before);
  const oldCapabilities = local.ready.serverCapabilities; local.ready.serverCapabilities = oldCapabilities.filter(cap => cap !== "pairing-invites.v1");
  await expect(management.issuePairingInvite()).rejects.toThrow("请先更新此主机");
  local.ready.serverCapabilities = oldCapabilities; local.close();
});

it("prints Bot creation request identity before a lost response", async () => {
  const root = await host(false, true), local = await client(root); local.close();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const create = vi.spyOn(HostManagement.prototype, "createBot").mockImplementation(async input => {
    expect(err.mock.calls.flat().join("\n")).toContain(input.requestId);
    throw new Error("fixture_response_lost");
  });
  try {
    await expect(runHostCli(["bots", "create", "--name", "Audit", "--engine", "codex", "--state-dir", root.directory])).rejects.toThrow("fixture_response_lost");
    const id = create.mock.calls[0]![0].requestId;
    expect(id).toBeTruthy();
    await expect(runHostCli(["bots", "create", "--name", "Audit", "--engine", "codex", "--request-id", id, "--state-dir", root.directory])).rejects.toThrow("fixture_response_lost");
    expect(create.mock.calls[1]![0].requestId).toBe(id);
  } finally { create.mockRestore(); err.mockRestore(); }
});
