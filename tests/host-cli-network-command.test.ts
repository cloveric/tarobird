import os from "node:os";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostNetwork } from "../src/host-cli/network-cli.js";
import { executeNetworkTransfer, exportNetworkTransfer } from "../src/host-cli/network-transfer.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { networkCanonical, type NetworkCommand, type SignedNetworkManifest, type SignedNetworkProposal } from "../src/client-protocol/private-network.js";

type Host = { directory: string; hub: HubServer; closeControl: () => Promise<void> };
const hosts: Host[] = []; let printed: unknown[];
beforeEach(() => { printed = []; vi.spyOn(console, "log").mockImplementation(value => { printed.push(value); }); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) { await host.closeControl(); await host.hub.close(); await rm(host.directory, { recursive: true, force: true }); }
});
async function run(host: Host, ...args: string[]) { await runHostCli([...args, "--state-dir", host.directory, "--json"]); }
async function host(name: string): Promise<Host> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taro-cli-net-"));
  await runHostCli(["init", "--name", name, "--state-dir", directory, "--json"]);
  const hub = await HubServer.start({ stateDir: directory, networkExchange: async (peer, request) => {
    const destination = hosts.find(host => host.hub.auth.publicKey === peer.publicKey);
    if (!destination) throw new Error("fixture_peer_unavailable");
    return destination.hub.network.peer(request, "cli_fixture_peer");
  } });
  const closeControl = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: controller => hub.enrollLocalController(controller) });
  const result = { directory, hub, closeControl }; hosts.push(result); await run(result, "enroll"); return result;
}
async function join(authority: Host, candidate: Host) {
  const suffix = randomUUID(), offer = path.join(authority.directory, `offer-${suffix}.json`), proposal = path.join(candidate.directory, `proposal-${suffix}.json`), admission = path.join(authority.directory, `admission-${suffix}.json`);
  await run(authority, "network", "offer", "--out", offer);
  await run(candidate, "network", "propose", "--from", offer, "--out", proposal, "--yes");
  await run(authority, "network", "admit", "--from", proposal, "--out", admission, "--yes");
  await run(candidate, "network", "join", "--from", admission, "--yes");
  const proposed = JSON.parse(await readFile(proposal, "utf8")) as SignedNetworkProposal;
  const admitted = JSON.parse(await readFile(admission, "utf8")) as { membership: SignedNetworkManifest; nonce: string };
  expect(admitted.nonce).toBe(proposed.proposal.nonce);
  expect((await candidate.hub.network.view()).membership!.manifest.id).toBe(admitted.membership.manifest.id);
  return { offer, proposal, admission };
}
async function pairPhone(host: Host, id: string) {
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pending = await host.hub.auth.pair({ deviceId: id, name: "My phone", platform: "android", publicKey }, "fixture");
  await run(host, "devices", "approve", pending.code);
  return { id, privateKey: keys.privateKey };
}
async function login(host: Host, id: string, key: KeyObject) {
  const connection = randomUUID(), nonce = randomBytes(32).toString("base64url"), challenge = await host.hub.auth.challenge(connection, id, nonce, "fixture");
  const { token } = await host.hub.auth.authenticate(connection, sign(null, deviceProof(id, challenge.nonce, nonce), key).toString("base64"));
  return { token, session: await host.hub.auth.authorize(token) };
}
async function enrollPhoneElsewhere(source: Host, target: Host, phone: Awaited<ReturnType<typeof pairPhone>>, id: string) {
  const keys = generateKeyPairSync("ed25519"), session = await login(source, phone.id, phone.privateKey);
  const command: NetworkCommand = { operation: "attest", networkId: (await source.hub.network.view()).membership!.manifest.id,
    device: { id, name: "My phone", platform: "android", host: target.hub.auth.publicKey, publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") } };
  // This is the phone's existing App protocol, deliberately not a CLI operation.
  const statement = await source.hub.auth.prepareDeviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) }, session.token, session.session);
  const result = await source.hub.network.command(command, session.session, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), phone.privateKey).toString("base64") });
  await target.hub.network.enroll(result.membership);
  return { id, ...await login(target, id, keys.privateKey) };
}

it("renames a device through the same API without renaming the host or changing trust", async () => {
  const a = await host("Host A"), phone = await pairPhone(a, "phone_for_rename");
  const profile = await a.hub.profile.read();
  await run(a, "devices", "rename", phone.id, "--name", "vivo 手机");
  expect((await a.hub.store.devices("owner")).find(device => device.id === phone.id)).toMatchObject({ name: "vivo 手机", revoked: 0 });
  expect(await a.hub.profile.read()).toEqual(profile);
  await expect(run(a, "devices", "rename", phone.id)).rejects.toThrow("缺少 --name");
});

it("exports each signed CLI stage across three hosts and keeps an independent phone on the remaining hosts", async () => {
  const a = await host("Host A"), b = await host("Host B"), c = await host("Host C"), phone = await pairPhone(c, "phone_original_c");
  await run(a, "network", "create", "--name", "Home network");
  await join(a, b); const files = await join(a, c);
  expect((await a.hub.network.view()).membership!.manifest.hosts.filter(host => !host.revoked && host.state === "active")).toHaveLength(3);
  // Public inspection works without any initialized or reachable host.
  await runHostCli(["network", "inspect", "--from", files.proposal, "--state-dir", path.join(c.directory, "absent")]);
  await expect(stat(path.join(c.directory, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(run(c, "network", "leave", "--yes")).rejects.toThrow("network_devices_not_ready");
  const phoneA = await enrollPhoneElsewhere(c, a, phone, "phone_on_a"), phoneB = await enrollPhoneElsewhere(c, b, phone, "phone_on_b");
  await c.hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('c_bot','C private Bot','fixture')");
  await run(c, "network", "leave", "--yes"); await b.hub.network.tick();
  expect((await c.hub.network.view()).sync).toBe("standalone");
  expect(await a.hub.auth.authorize(phoneA.token)).toEqual(phoneA.session);
  expect(await b.hub.auth.authorize(phoneB.token)).toEqual(phoneB.session);
  expect((await c.hub.store.device(phone.id))?.revoked).toBe(1);
  expect((await c.hub.store.bots("owner")).map(bot => bot.id)).toEqual(["c_bot"]);
  await run(c, "bots", "list"); expect(String(printed.at(-1))).toContain("C private Bot");
  await expect(run(a, "network", "leave", "--yes")).rejects.toThrow("network_authority_has_peers");
}, 20_000);

it("never mutates membership when a CLI transfer output already exists, and rejects attest", async () => {
  const a = await host("A"), b = await host("B"), offer = path.join(a.directory, "offer.json"), occupied = path.join(b.directory, "do-not-overwrite.json");
  await run(a, "network", "create", "--name", "Network"); await run(a, "network", "offer", "--out", offer);
  await writeFile(occupied, "keep original\n");
  const execute = vi.spyOn(b.hub.network, "command");
  await expect(run(b, "network", "propose", "--from", offer, "--out", occupied, "--yes")).rejects.toMatchObject({ code: "EEXIST" });
  expect(execute).not.toHaveBeenCalled(); expect(await readFile(occupied, "utf8")).toBe("keep original\n");
  await expect(run(b, "network", "attest", "--yes")).rejects.toThrow("未知 network 命令");
  expect(execute).not.toHaveBeenCalled();
}, 20_000);

it("reserves transfer output before sending a command and retains confirmed data when export fails", async () => {
  const a = await host("A"), b = await host("B"); await run(a, "network", "create", "--name", "Network");
  const membership = (await a.hub.network.view()).membership!, client = await LocalHostClient.connect(b.directory), network = new HostNetwork(client);
  const action: NetworkCommand = { operation: "propose", networkId: membership.manifest.id, authorityKey: a.hub.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(membership.manifest)) };
  const exported = path.join(b.directory, "proposal.json");
  const sample = await open(path.join(b.directory, "prototype"), "wx"), prototype = Object.getPrototypeOf(sample); await sample.close();
  let failure: unknown;
  const write = vi.spyOn(prototype, "writeFile").mockImplementation(() => {
    // JsonStore uses fs.writeFile for durable records. FileHandle.writeFile is
    // the final reserved export, which we fail after the server has confirmed.
    throw new Error("fixture_output_io_error");
  });
  try { await executeNetworkTransfer(b.directory, action, exported, async () => {
    expect((await stat(exported)).size).toBe(0); return network.command(action);
  }); } catch (error) { failure = error; }
  finally { write.mockRestore(); client.close(); }
  expect(failure).toMatchObject({ code: "network_transfer_export_failed", receiptPath: expect.any(String) });
  const receiptPath = (failure as { receiptPath: string }).receiptPath;
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")); expect(receipt.status).toBe("complete");
  expect(receipt.document.proposal.nonce).toBe(receipt.result.proposal.proposal.nonce);
  await expect(stat(exported)).rejects.toMatchObject({ code: "ENOENT" });
  const recovered = path.join(b.directory, "recovered-proposal.json");
  await runHostCli(["network", "recover", "--from", receiptPath, "--out", recovered, "--state-dir", path.join(b.directory, "absent")]);
  expect(JSON.parse(await readFile(recovered, "utf8"))).toEqual(receipt.document);
  await expect(exportNetworkTransfer(receiptPath, recovered)).rejects.toMatchObject({ code: "EEXIST" });
  const linked = path.join(b.directory, "linked-receipt.json"); await symlink(receiptPath, linked);
  await expect(exportNetworkTransfer(linked, path.join(b.directory, "untrusted.json"))).rejects.toThrow("network_transfer_receipt_not_regular");
  const large = path.join(b.directory, "large-receipt.json"), oversized = await open(large, "wx"); await oversized.truncate(64 * 1024 * 1024 + 1); await oversized.close();
  await expect(exportNetworkTransfer(large, path.join(b.directory, "too-large.json"))).rejects.toThrow("network_transfer_receipt_too_large");
  const admission = path.join(a.directory, "admission.json");
  await run(a, "network", "admit", "--from", recovered, "--out", admission, "--yes");
  await run(b, "network", "join", "--from", admission, "--yes");
  expect((await b.hub.network.view()).host.state).toBe("active");
});

it("persists uncertain submitted commands without exporting or automatically replaying them", async () => {
  const a = await host("A"), output = path.join(a.directory, "unknown-result.json"); let calls = 0;
  await expect(executeNetworkTransfer(a.directory, { operation: "create", name: "Network" }, output, async () => { calls++; throw new Error("connection_lost"); })).rejects.toThrow("connection_lost");
  expect(calls).toBe(1); await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  const records = path.join(a.directory, "cli/network-transfers"), receipt = path.join(records, (await readdir(records))[0]!);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ status: "uncertain", command: { operation: "create", name: "Network" } });
  await expect(exportNetworkTransfer(receipt, path.join(a.directory, "wrong.json"))).rejects.toThrow("network_transfer_not_confirmed");
});

it("shows this host's local routes read-only through the authenticated owner endpoint", async () => {
  const a = await host("local-routes");
  const before = await a.hub.store.db.all("SELECT key,value FROM meta WHERE key IN ('private-network:v1','host-routes:v1') ORDER BY key");
  await run(a, "network", "local");
  expect(JSON.parse(String(printed.at(-1)))).toMatchObject({ v: 1, hostPublicKey: a.hub.auth.publicKey, routes: [], local: { lan: { enabled: false }, tailscale: { enabled: false } } });
  await runHostCli(["network", "local", "--state-dir", a.directory]);
  expect(String(printed.at(-1))).toContain("主机线路（只读）");
  expect(await a.hub.store.db.all("SELECT key,value FROM meta WHERE key IN ('private-network:v1','host-routes:v1') ORDER BY key")).toEqual(before);
  await expect(runHostCli(["network", "status", "--tailscale", "--state-dir", a.directory])).rejects.toThrow("--tailscale 仅支持 network local");
  await expect(runHostCli(["network", "local", "--yes", "--state-dir", a.directory])).rejects.toThrow("network local 只读");
});


it("selects a managed LAN via CLI while keeping Tailscale and requiring explicit confirmation", async () => {
  const a = await host("Host A"), ca = "A".repeat(120);
  vi.spyOn(a.hub, "managedListeners").mockReturnValue([{ host: "192.168.10.20", port: 8443, listening: true, authority: ca, interfaceKey: "wifi" }, { host: "192.168.64.1", port: 8443, listening: true, authority: ca, interfaceKey: "bridge" }]);
  const shared = [{ name: "Tailscale" as const, url: "https://100.64.0.7:8443", certificateAuthority: ca }];
  await a.hub.network.replaceManagedRoutes([], shared); await a.hub.refreshHostRoutes();
  const file = path.join(a.directory, "lan.json");
  await writeFile(file, JSON.stringify({ name: "Direct", url: "https://192.168.10.20:8443", certificateAuthority: ca }));
  await expect(run(a, "network", "select-lan", "--from", file)).rejects.toThrow("--yes");
  await run(a, "network", "select-lan", "--from", file, "--yes");
  await a.hub.refreshHostRoutes();
  expect((await a.hub.hostRoutes.view()).notices).not.toContain("lan_selection_required");
  expect(await a.hub.network.sharedRoutes()).toEqual(shared);
});
