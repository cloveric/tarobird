import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubAuth, deviceProof, hashSecret, parsePublicKey, serverProof } from "../src/hub/auth.js";
import { HubStore } from "../src/hub/store.js";
import { authDeniedProof, authDeniedSchema } from "../src/client-protocol/auth-status.js";

describe("Hub durable state and device trust", () => {
  let directory: string; let store: HubStore; let auth: HubAuth; let now: number;
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "hub-")); now = Date.now();
    store = await HubStore.open(directory); auth = await HubAuth.open(store, directory, () => now);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret("test-only-secret")]);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta',?)", [hashSecret("test-only-secret-2")]);
    await store.db.run("INSERT INTO users VALUES('member','Member','member')");
  });
  afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });
  const pairInput = () => ({ deviceId: "test_device", name: "Test", platform: "web", publicKey });
  async function enroll() { const pair = await auth.pair(pairInput(), "test"); await auth.approve(pair.code, "local-owner"); return pair; }
  async function login() {
    const nonce = randomBytes(32).toString("base64url");
    const challenge = await auth.challenge("connection", "test_device", nonce, "test");
    expect(verify(null, serverProof("test_device", challenge.nonce, nonce), parsePublicKey(auth.publicKey), Buffer.from(challenge.signature, "base64"))).toBe(true);
    const signature = sign(null, deviceProof("test_device", challenge.nonce, nonce), keys.privateKey).toString("base64");
    return { session: await auth.authenticate("connection", signature), signature };
  }
  it("requires trusted approval, consumes pairing/challenge once, expires tokens, and immediately revokes", async () => {
    const pair = await auth.pair(pairInput(), "test");
    await expect(auth.challenge("connection", "test_device", "nonce", "test")).rejects.toThrow("untrusted_device");
    await expect(auth.approve(pair.code, "member")).rejects.toThrow("owner_required");
    await auth.approve(pair.code, "local-owner");
    await expect(auth.approve(pair.code, "local-owner")).rejects.toThrow("pairing_expired_or_invalid");
    const { session, signature } = await login();
    expect((await auth.authorize(session.token)).userId).toBe("owner");
    await expect(auth.authenticate("connection", signature)).rejects.toThrow("challenge_expired");
    now += 15 * 60_000 + 1;
    await expect(auth.authorize(session.token)).rejects.toThrow("token_expired_or_invalid");
    const second = await login(); let closed = false;
    auth.onRevoke(() => { closed = true; }); await auth.revoke("test_device", "local-owner");
    expect(closed).toBe(true);
    await expect(auth.authorize(second.session.token)).rejects.toThrow();
    await expect(auth.challenge("other", "test_device", "nonce", "test")).rejects.toThrow("untrusted_device");
    const audit = JSON.stringify(await store.db.all("SELECT * FROM audit_log"));
    expect(audit).toContain("device.revoked"); expect(audit).not.toContain(pair.code); expect(audit).not.toContain(session.token);
  });
  it("pins the Hub identity across restart and protects state permissions", async () => {
    const reloaded = await HubAuth.open(store, directory);
    expect(reloaded.publicKey).toBe(auth.publicKey);
    if (process.platform !== "win32") expect((await stat(directory)).mode & 0o777).toBe(0o700);
    for (const file of ["hub.sqlite", "hub.sqlite-wal", "identity.json"]) if (process.platform !== "win32") expect((await stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
  });
  it("signs a fresh, domain-separated denial only for a known revoked device", async () => {
    const nonce = randomBytes(32).toString("base64url");
    expect(await auth.revocationDenial("missing", nonce)).toBeUndefined();
    await enroll(); expect(await auth.revocationDenial("test_device", nonce)).toBeUndefined();
    await auth.revoke("test_device", "local-owner");
    const denied = authDeniedSchema.parse(await auth.revocationDenial("test_device", nonce));
    expect(denied).toMatchObject({ type: "auth.denied", deviceId: "test_device", clientNonce: nonce, code: "device_revoked", publicKey: auth.publicKey });
    const signature = Buffer.from(denied.signature, "base64"), key = parsePublicKey(auth.publicKey);
    expect(verify(null, Buffer.from(authDeniedProof("test_device", nonce)), key, signature)).toBe(true);
    expect(verify(null, Buffer.from(authDeniedProof("other", nonce)), key, signature)).toBe(false);
    expect(verify(null, Buffer.from(authDeniedProof("test_device", nonce + "x")), key, signature)).toBe(false);
    expect(verify(null, serverProof("test_device", "", nonce), key, signature)).toBe(false);
    expect(verify(null, deviceProof("test_device", "", nonce), key, signature)).toBe(false);
    expect(Object.keys(denied).sort()).toEqual(["clientNonce", "code", "deviceId", "publicKey", "signature", "type", "v"]);
  });
  it("rejects expired pairing and a signature for another connection", async () => {
    const pair = await auth.pair(pairInput(), "test"); now += 5 * 60_000 + 1;
    await expect(auth.approve(pair.code, "local-owner")).rejects.toThrow("pairing_expired_or_invalid");
    await enroll(); const { signature } = await login();
    await auth.challenge("other", "test_device", randomBytes(32).toString("hex"), "test");
    await expect(auth.authenticate("other", signature)).rejects.toThrow("signature_invalid");
  });
  it("creates a one-Bot group and isolated topics with inherited access, without reconfiguring the Bot", async () => {
    const group = await store.createConversation("owner", ["alpha"], "Project", "project", { type: "group" });
    expect(group.type).toBe("group");
    await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [group.id]);
    await store.updateConversation("owner", group.id, { sessionId: "parent_native" });
    const topic = await store.createConversation("member", [], "Task A", "topic_a", { parentId: group.id });
    const second = await store.createConversation("owner", [], "Task B", "topic_b", { parentId: group.id });
    expect(topic).toMatchObject({ parentId: group.id, type: "group", botIds: ["alpha"] }); expect(topic.sessionId).toBeUndefined();
    expect((await store.conversations("owner")).map((c) => c.id)).toContain(topic.id);
    expect((await store.conversations("member")).map((c) => c.id)).toContain(second.id);
    await store.sendMessage("member", { conversationId: topic.id, clientMsgId: "topic_message", text: "only in A", attachments: [] });
    expect((await store.snapshot("owner", group.id)).messages).toHaveLength(0);
    expect((await store.snapshot("owner", second.id)).messages).toHaveLength(0);
    expect((await store.snapshot("owner", topic.id)).messages).toHaveLength(1);
    await expect(store.createConversation("owner", [], "nested", "nested", { parentId: topic.id })).rejects.toThrow("topic_requires_group");
    const direct = await store.createConversation("owner", ["beta"], "Private", "private");
    await expect(store.createConversation("member", [], "forbidden", "forbidden", { parentId: direct.id })).rejects.toThrow("conversation_forbidden");
    await expect(store.createConversation("owner", [], "bad", "bad", { parentId: direct.id })).rejects.toThrow("topic_requires_group");
    await store.updateConversation("owner", group.id, { archived: true });
    await expect(store.createConversation("owner", [], "archived", "archived", { parentId: group.id })).rejects.toThrow("conversation_archived");
    await expect(store.sendMessage("member", { conversationId: topic.id, clientMsgId: "late", text: "late", attachments: [] })).rejects.toThrow("conversation_archived");
    await store.db.close(); store = await HubStore.open(directory);
    expect((await store.conversations("owner")).find((c) => c.id === topic.id)?.parentId).toBe(group.id);
  });
  it("atomically deduplicates offline retries, sequences concurrent writes and survives restart", async () => {
    const c = await store.createConversation("owner", ["alpha", "beta"], "Group", "create_1");
    expect((await store.createConversation("owner", ["alpha"], "retry", "create_1")).id).toBe(c.id);
    const input = { conversationId: c.id, clientMsgId: "client_1", text: "你好世界", attachments: [], mentions: ["alpha"] };
    const writes = await Promise.all(Array.from({ length: 12 }, () => store.sendMessage("owner", input)));
    expect(new Set(writes.map((w) => w.message.id)).size).toBe(1); expect(writes.filter((w) => !w.duplicate)).toHaveLength(1);
    expect(await store.pendingForBot("alpha")).toHaveLength(1); expect(await store.pendingForBot("beta")).toHaveLength(0);
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => store.publishBotMessage("alpha", { conversationId: c.id, blocks: [{ type: "text", text: `reply ${i}` }] })));
    await store.publishBotMessage("alpha", { id: replies[0]!.id, conversationId: c.id, blocks: [{ type: "text", text: "newest" }], version: 5 });
    await store.publishBotMessage("alpha", { id: replies[0]!.id, conversationId: c.id, blocks: [{ type: "text", text: "stale" }], version: 3 });
    await store.db.close(); store = await HubStore.open(directory);
    const sync = await store.sync("owner", c.id, 0);
    expect(sync.events.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await store.snapshot("owner", c.id)).messages).toHaveLength(11);
    expect((await store.messageForUser("owner", replies[0]!.id)).blocks).toEqual([{ type: "text", text: "newest" }]);
    expect(await store.search("owner", "你好", { botId: "alpha" })).toHaveLength(1);
    expect(await store.search("owner", "你好", { from: Date.now() + 1_000 })).toHaveLength(0);
  });
  it("enforces membership, bot grants and message author ownership", async () => {
    const c = await store.createConversation("owner", ["alpha"], "Private", "create_1");
    await expect(store.createConversation("member", ["alpha"], "Forbidden", "create_2")).rejects.toThrow("bot_forbidden");
    await expect(store.snapshot("member", c.id)).rejects.toThrow("conversation_forbidden");
    expect(await store.search("member", "")).toEqual([]);
    await expect(store.publishBotMessage("beta", { conversationId: c.id, blocks: [] })).rejects.toThrow("bot_forbidden");
    const { message } = await store.sendMessage("owner", { conversationId: c.id, clientMsgId: "client_1", text: "original", attachments: [] });
    await expect(store.publishBotMessage("alpha", { id: message.id, conversationId: c.id, blocks: [] })).rejects.toThrow("message_forbidden");
  });
});
