import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { deviceProof } from "../src/hub/auth.js";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { readCollaboration, saveCollaboration } from "../src/hub/collaboration.js";
import { loadBusConfig } from "../src/bus/bus-config.js";
import { updateInstanceConfig } from "../src/state/instance-config.js";

describe("managed Bot collaboration configuration", () => {
  let root: string, hub: HubServer, manager: BotManager;
  const ids = ["alpha", "beta", "gamma", "delta", "epsilon"];
  const file = (id = "alpha") => path.join(root, "bots", id, "config.json");
  const snapshot = () => readCollaboration(manager, "owner", "alpha");
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hub-collaboration-")); hub = await HubServer.start({ stateDir: root, managedBots: { entrypoint: "unused" } });
    manager = new BotManager(hub.store, root, { entrypoint: "unused" }, () => hub.instanceUrl, async () => {});
    for (const id of ids) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, `Name ${id}`, "fixture"]);
      await hub.store.db.run("INSERT INTO managed_bots VALUES(?,?,?,?)", [id, "owner", id, "{}"]);
      await mkdir(path.dirname(file(id)), { recursive: true });
      await writeFile(file(id), JSON.stringify({ engine: "codex", model: "gpt-6-astra", custom: { preserve: true }, botToken: "SECRET-DO-NOT-RETURN" }));
    }
  });
  afterEach(async () => { await manager.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  it("round trips native fan/chain/verifier/Crew settings, keeps unrelated config and never returns secrets", async () => {
    const before = await snapshot();
    const settings = { ...before.settings, enabled: true, peers: ids.slice(1), parallel: ["beta", "gamma"], chain: ["gamma", "beta"], verifier: "epsilon", crew: { enabled: true as const, workflow: "research-report" as const, coordinator: "alpha", roles: { researcher: "beta", analyst: "gamma", writer: "delta", reviewer: "epsilon" }, maxResearchQuestions: 5, maxRevisionRounds: 0 } };
    await saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings });
    const after = await snapshot(), raw = JSON.parse(await readFile(file(), "utf8"));
    expect(after.settings).toEqual(settings); expect(after.revision).not.toBe(before.revision);
    expect(raw).toMatchObject({ model: "gpt-6-astra", custom: { preserve: true }, botToken: "SECRET-DO-NOT-RETURN" });
    expect(raw.bus.secret).toHaveLength(64); expect(JSON.stringify(after)).not.toContain(raw.bus.secret); expect(JSON.stringify(after)).not.toContain("SECRET-DO-NOT-RETURN");
    if (process.platform !== "win32") expect((await stat(file())).mode & 0o777).toBe(0o600);
    expect(await loadBusConfig(path.dirname(file()))).toMatchObject({ parallel: settings.parallel, chain: settings.chain, crew: settings.crew });
    expect(after.peers.find((peer) => peer.id === "beta")).toMatchObject({ allowsThisBot: false, listener: "offline" });
    const beta = await readCollaboration(manager, "owner", "beta");
    await saveCollaboration(manager, "owner", "beta", { revision: beta.revision, settings: { ...beta.settings, enabled: true, peers: ["alpha"] } });
    expect((await snapshot()).peers.find((peer) => peer.id === "beta")?.allowsThisBot).toBe(true);
    await saveCollaboration(manager, "owner", "alpha", { revision: after.revision, settings: { ...settings, enabled: false } });
    expect(await loadBusConfig(path.dirname(file()))).toBeNull(); expect((await snapshot()).settings).toEqual({ ...settings, enabled: false });
    expect(JSON.parse(await readFile(file(), "utf8")).bus.secret).toBe(raw.bus.secret);
  });
  it("allows only one concurrent revision writer and preserves native model edits", async () => {
    const before = await snapshot();
    const requests = ["beta", "gamma"].map((id) => saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings: { ...before.settings, enabled: true, peers: [id] } }));
    requests.push(updateInstanceConfig(path.dirname(file()), (config) => { config.model = "changed-model"; }));
    const outcomes = await Promise.allSettled(requests);
    expect(outcomes.slice(0, 2).filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.slice(0, 2).find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { message: "collaboration_conflict" } });
    expect(JSON.parse(await readFile(file(), "utf8")).model).toBe("changed-model");
    const current = await snapshot();
    await saveCollaboration(manager, "owner", "alpha", { revision: current.revision, settings: before.settings });
    await expect(saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings: { ...before.settings, peers: ["epsilon"] } })).rejects.toThrow("collaboration_conflict");
  });
  it("denies nonowners and unmanaged/path targets without altering any files", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    const input = await snapshot(), before = await readFile(file(), "utf8");
    await expect(readCollaboration(manager, "member", "alpha")).rejects.toThrow("owner_required");
    await expect(saveCollaboration(manager, "member", "alpha", { revision: input.revision, settings: input.settings })).rejects.toThrow("owner_required");
    for (const id of ["../alpha", "unregistered"]) await expect(readCollaboration(manager, "owner", id)).rejects.toThrow("collaboration_managed_only");
    for (const peers of [["alpha"], ["unregistered"], ["../outside"]]) await expect(saveCollaboration(manager, "owner", "alpha", { revision: input.revision, settings: { ...input.settings, enabled: true, peers } })).rejects.toThrow();
    await expect(saveCollaboration(manager, "owner", "alpha", { revision: input.revision, settings: { ...input.settings, enabled: true, peers: ["beta"], chain: ["gamma"] } })).rejects.toThrow("collaboration_target_not_allowed");
    expect(await readFile(file(), "utf8")).toBe(before);
  });
  it("fails closed on malformed existing config and preserves unknown native fields", async () => {
    const initial = await snapshot();
    for (const text of ["{bad", "[]", '{"engine":"invalid"}', '{"bus":{"peers":["beta"],"chain":42}}']) {
      await writeFile(file(), text);
      await expect(snapshot()).rejects.toThrow(/collaboration_config_/);
      await expect(saveCollaboration(manager, "owner", "alpha", { revision: initial.revision, settings: initial.settings })).rejects.toThrow(/collaboration_config_/);
      expect(await readFile(file(), "utf8")).toBe(text);
    }
    await writeFile(file(), JSON.stringify({ bus: { peers: "*", secret: "native-secret", port: 45234, extraOption: { retained: true } } }));
    const before = await snapshot();
    await saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings: { ...before.settings, peers: ["beta"] } });
    expect(JSON.parse(await readFile(file(), "utf8")).bus).toMatchObject({ port: 45234, secret: "native-secret", extraOption: { retained: true } });
  });
  it("rejects duplicate Crew roles, wildcard unknown workflow targets and empty enabled ACLs", async () => {
    const before = await snapshot(), raw = await readFile(file(), "utf8");
    const invalid = [
      { ...before.settings, enabled: true },
      { ...before.settings, enabled: true, peers: "*", chain: ["foreign"] },
      { ...before.settings, enabled: true, peers: ids.slice(1), crew: { enabled: true, workflow: "research-report", coordinator: "alpha", roles: { researcher: "beta", analyst: "beta", writer: "delta", reviewer: "epsilon" }, maxResearchQuestions: 5, maxRevisionRounds: 1 } },
      { ...before.settings, maxDepth: 100000 },
    ];
    for (const settings of invalid) await expect(saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings })).rejects.toThrow();
    expect(await readFile(file(), "utf8")).toBe(raw);
  });
  it("rechecks trust immediately before committing a queued write", async () => {
    const before = await snapshot(), raw = await readFile(file(), "utf8");
    await expect(saveCollaboration(manager, "owner", "alpha", { revision: before.revision, settings: { ...before.settings, enabled: true, peers: ["beta"] } }, async () => { throw new Error("device_revoked"); })).rejects.toThrow("device_revoked");
    expect(await readFile(file(), "utf8")).toBe(raw);
  });
  it("enforces HTTP device trust, owner role and strict writes, including revoked devices", async () => {
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    async function token(user: string) {
      const keys = generateKeyPairSync("ed25519"), device = `device_${user}`;
      const pair = await hub.auth.pair({ deviceId: device, name: user, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
      await hub.auth.approve(pair.code, "local-owner", user);
      const nonce = randomBytes(32).toString("base64url"), challenge = await hub.auth.challenge(device, device, nonce, "fixture");
      return (await hub.auth.authenticate(device, sign(null, deviceProof(device, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
    }
    const owner = await token("owner"), member = await token("member"), route = `${hub.url}/api/bots/alpha/collaboration`;
    expect((await fetch(route)).status).toBe(401);
    for (const method of ["GET", "PUT"]) expect((await fetch(route, { method, headers: { Authorization: `Bearer ${member}` }, ...(method === "PUT" ? { body: "{}" } : {}) })).status).toBe(403);
    const headers = { Authorization: `Bearer ${owner}` }, response = await fetch(route, { headers });
    expect(response.status).toBe(200); const current = await response.json();
    const input = { revision: current.revision, settings: { ...current.settings, enabled: true, peers: ["beta"] } };
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify({ ...input, secret: "inject" }) })).status).toBe(400);
    const saved = await fetch(route, { method: "PUT", headers, body: JSON.stringify(input) }); expect(saved.status).toBe(200);
    const savedText = await saved.text(); expect(savedText).not.toContain("secret"); expect(savedText).not.toContain("SECRET-DO-NOT-RETURN");
    const beforeRevoke = await readFile(file(), "utf8"); await hub.auth.revoke("device_owner", "local-owner");
    expect((await fetch(route, { method: "PUT", headers, body: JSON.stringify(input) })).status).toBe(401);
    expect(await readFile(file(), "utf8")).toBe(beforeRevoke);
  });

});
