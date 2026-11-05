import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { configureGoogleDocs, googleDocsClient } from "../src/gdocs/settings.js";
import { openGoogleDocs, runGoogleDocsCli } from "../src/gdocs/cli.js";
import { SystemSecretVault } from "../src/gdocs/keychain.js";
import { GoogleAuthorization } from "../src/gdocs/auth.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "gdocs-setup-")); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const fixture = { installed: { client_id: "fixture-client", client_secret: "fixture-secret" } };

it("distinguishes missing and invalid OAuth configuration without exposing file contents", async () => {
  await expect(openGoogleDocs(root)).rejects.toMatchObject({ code: "google_docs_not_configured" });
  await writeFile(path.join(root, "google-oauth-client.json"), '{"private":"do-not-leak"}');
  await expect(openGoogleDocs(root)).rejects.toMatchObject({ code: "google_docs_config_invalid", message: "google_docs_config_invalid" });
});
it("imports a validated private copy, retains legacy configuration, and does not corrupt a working import", async () => {
  const input = path.join(root, "input.json"), legacy = path.join(root, "legacy.json");
  await writeFile(legacy, JSON.stringify({ installed: { client_id: "legacy" } }));
  const config = JSON.stringify({ gdocs: { clientFile: legacy }, port: 54321 });
  await writeFile(path.join(root, "config.json"), config);
  expect((await googleDocsClient(root)).client_id).toBe("legacy");
  await writeFile(input, JSON.stringify(fixture)); await configureGoogleDocs(root, input); await rm(input);
  expect(await googleDocsClient(root)).toEqual(fixture.installed);
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(config);
  if (process.platform !== "win32") expect((await stat(path.join(root, "gdocs/google-oauth-client.json"))).mode & 0o777).toBe(0o600);
  await writeFile(input, JSON.stringify({ web: fixture.installed }));
  await expect(configureGoogleDocs(root, input)).rejects.toMatchObject({ code: "google_docs_config_invalid" });
  expect(await googleDocsClient(root)).toEqual(fixture.installed);
});
it("the public CLI selects the current host, persists configuration, and reports authorization without cloud calls", async () => {
  await initializeHost(root, "Docs test"); vi.stubEnv("TAROBOT_HOST_DIR", root);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runGoogleDocsCli(["status"]);
  expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ configured: false, authorized: false, error: "google_docs_not_configured" });
  await expect(runGoogleDocsCli(["auth"])).rejects.toThrow(/google_docs_not_configured:.*tarobot gdocs --help/);
  const input = path.join(root, "download.json"); await writeFile(input, JSON.stringify(fixture));
  await runGoogleDocsCli(["configure", "--client-file", input]); await rm(input);
  const vault = vi.spyOn(SystemSecretVault.prototype, "read").mockResolvedValue(null);
  await runGoogleDocsCli(["status"]); expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ configured: true, authorized: false });
  vault.mockResolvedValue(JSON.stringify({ refreshToken: "fixture-token" }));
  await runGoogleDocsCli(["status"]); expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({ configured: true, authorized: true });
  vault.mockResolvedValue("bad-secret");
  await runGoogleDocsCli(["status"]); expect(JSON.parse(log.mock.calls.at(-1)![0]).error).toBe("google_docs_authorization_invalid");
  expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret"); expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-token");
});

it("auth --client-file retains the imported client for later App exports", async () => {
  await initializeHost(root, "Docs auth test");
  const input = path.join(root, "download.json"); await writeFile(input, JSON.stringify(fixture));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const begin = vi.spyOn(GoogleAuthorization.prototype, "begin").mockImplementation(async function (this: GoogleAuthorization) {
    expect(this.client).toEqual(fixture.installed);
    return { url: "https://accounts.google.com/fixture", completed: Promise.resolve(), cancel() {} };
  });
  await runGoogleDocsCli(["auth", "--state-dir", root, "--client-file", input]); await rm(input);
  expect(begin).toHaveBeenCalledOnce();
  expect((await openGoogleDocs(root)).authorization.client).toEqual(fixture.installed);
});

it("real export and status routes return actionable codes, with owner checks and no credential leakage", async () => {
  const hub = await HubServer.start({ stateDir: root, googleDocs: () => openGoogleDocs(root) });
  try {
    const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pairing = await hub.auth.pair({ deviceId: "device", name: "Test", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
    await hub.auth.approve(pairing.code, "local-owner");
    const challenge = await hub.auth.challenge("device", "device", nonce, "fixture");
    const session = await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"));
    const headers = { Authorization: `Bearer ${session.token}` };
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["bot"], "Docs", "docs");
    const message = await hub.store.publishBotMessage("bot", { conversationId: chat.id, blocks: [{ type: "text", text: "Export" }] });
    const exportMessage = () => fetch(hub.url + "/api/gdocs/export", { method: "POST", headers, body: JSON.stringify({ messageId: message.id }) });
    const missing = await exportMessage(); expect(missing.status).toBe(503); expect(await missing.json()).toEqual({ error: "google_docs_not_configured" });
    expect(await (await fetch(hub.url + "/api/gdocs/status", { headers })).json()).toMatchObject({ configured: false, error: "google_docs_not_configured" });
    await writeFile(path.join(root, "google-oauth-client.json"), JSON.stringify(fixture));
    const vault = vi.spyOn(SystemSecretVault.prototype, "read").mockResolvedValue(null);
    expect(await (await exportMessage()).json()).toEqual({ error: "google_docs_authorization_required" });
    vault.mockRejectedValue(new Error("system_keychain_read_failed"));
    expect(await (await exportMessage()).json()).toEqual({ error: "google_docs_keychain_unavailable" });
    vault.mockRejectedValue(new Error("private-provider-diagnostic"));
    expect(await (await exportMessage()).json()).toEqual({ error: "google_docs_export_failed" });
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await fetch(hub.url + "/api/gdocs/status", { headers })).status).toBe(403);
    expect((await exportMessage()).status).toBe(403);
    expect(await hub.store.db.get("SELECT 1 FROM meta WHERE key LIKE 'gdocs:%'")).toBeUndefined();
  } finally { await hub.close(); }
});
