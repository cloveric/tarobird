import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MAX_FRAME_BYTES, MAX_TEXT_BYTES, blocksText, conversationSchema, idSchema, messageSchema, type GroupReplyGuard } from "../src/client-protocol/index.js";
import { groupDiscussionRunSchema, groupDiscussionViewSchema } from "../src/client-protocol/group-discussion.js";
import { CROSS_HOST_GROUPS_CAPABILITY, groupMembersStateSchema } from "../src/client-protocol/group-members.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { attachGateway } from "../src/gateway/service.js";
import { SessionStore } from "../src/state/session-store.js";
import { deviceProof, hashSecret, HubAuth } from "../src/hub/auth.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { groupMailSignaturePayload, HubCrossHostGroups } from "../src/hub/group-cross-host.js";
import { HubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { groupMentions } from "../client/src/group-mentions.js";
import { groupRecipientOptions, insertScopedGroupMention } from "../client/src/group-recipient-options.js";

async function waitFor<T>(fn: () => Promise<T> | T, predicate: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out; last=${JSON.stringify(last)}`);
}

async function openOwnerSession(
  hub: HubServer,
  deviceId = "dev_owner",
  capabilities: string[] = [CROSS_HOST_GROUPS_CAPABILITY],
): Promise<{
  token: string;
  ws: WebSocket;
  frames: Record<string, unknown>[];
}> {
  const kp = generateKeyPairSync("ed25519");
  const publicKey = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  await bootstrapTrusted(hub.auth, { deviceId, name: "Test Device", platform: "web", publicKey });
  const ws = new WebSocket(hub.url.replace("http", "ws") + "/ws");
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const next = async (type: string) => waitFor(() => frames.find((f) => f.type === type), (f) => !!f);
  const nonce = randomBytes(32).toString("base64url");
  ws.send(JSON.stringify({ v: 1, type: "hello", deviceId, nonce, protocolVersions: [1], capabilities, cursors: {} }));
  const challenge = await next("challenge");
  ws.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof(deviceId, challenge!.nonce as string, nonce), kp.privateKey).toString("base64") }));
  const ready = await next("ready");
  await next("sync.complete");
  return { token: ready!.sessionToken as string, ws, frames };
}

describe("Cross-host group chat, session-based members & Orca-style group settings (#85)", () => {
  const dirs: string[] = [];
  const hubs: HubServer[] = [];
  const gateways: Array<Awaited<ReturnType<typeof attachGateway>>> = [];
  const sockets: WebSocket[] = [];

  async function startHub(
    name: string,
    existingStateDir?: string,
    extraOptions?: Partial<Parameters<typeof HubServer.start>[0]>,
  ): Promise<{ hub: HubServer; stateDir: string }> {
    const stateDir = existingStateDir ?? await fs.mkdtemp(path.join(os.tmpdir(), `tarobird-85-${name}-`));
    if (!existingStateDir) dirs.push(stateDir);
    const hub = await HubServer.start({ stateDir, ...extraOptions });
    hubs.push(hub);
    const profile = await hub.profile.read();
    await hub.profile.update({ name, revision: profile.revision });
    return { hub, stateDir };
  }

  async function connectBot(
    hub: HubServer,
    stateDir: string,
    botId: string,
    botName: string,
    handler: CoreBridgeLike["handleAuthorizedMessage"],
  ) {
    const secret = randomBytes(32).toString("base64url");
    const botDir = path.join(stateDir, "bots", botId);
    await fs.mkdir(botDir, { recursive: true });
    await fs.writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", approvalMode: "bypass" }));
    await hub.store.db.run(
      "INSERT OR REPLACE INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,'codex',?,0)",
      [botId, botName, hashSecret(secret)],
    );
    const channel = await attachGateway({
      stateDir: botDir,
      botId,
      secret,
      engine: "codex",
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      runtime: createCoreServiceRuntime(),
      bridge: { handleAuthorizedMessage: handler },
    });
    gateways.push(channel);
    await waitFor(
      async () => (await hub.store.db.get<{ online: number }>("SELECT online FROM bots WHERE id=?", [botId]))?.online,
      (v) => v === 1,
    );
    return channel;
  }

  async function deliveryFixture() {
    const a = await startHub("mail-sender");
    const b = await startHub("mail-receiver");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "Receiver", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "Sender", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Local','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Remote','codex','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");
    const group = await a.hub.store.createConversation("owner", ["bot_local"], "Delivery fixture", "delivery_group", { type: "group" });
    const post = (clientMsgId: string, text: string) => a.hub.store.sendMessage("owner", {
      conversationId: group.id, clientMsgId, text, attachments: [], mentions: ["bot_local"],
    });
    const addRemote = (history: "all" | "none" = "none") => a.hub.crossHostGroups.addMember("owner", group.id, {
      hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: history },
    });
    return { a, b, group, post, addRemote };
  }

  afterEach(async () => {
    while (sockets.length) {
      try { sockets.pop()!.close(); } catch { /* ignore */ }
    }
    while (gateways.length) {
      await gateways.pop()!.disconnect().catch(() => undefined);
    }
    while (hubs.length) {
      const h = hubs.pop()!;
      await h.close().catch(() => undefined);
    }
    while (dirs.length) {
      await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("projects only distinct active remote portraits into visible group conversations", async () => {
    const { hub } = await startHub("portrait-fixture");
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member','Member','member'),('outsider','Outsider','member')");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('assistant','Local assistant','fixture')");
    const group = await hub.store.createConversation("owner", ["assistant"], "Mixed group", "mixed_group", { type: "group" });
    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [group.id]);
    const topic = await hub.store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
    const localGroup = await hub.store.createConversation("owner", ["assistant"], "Local group", "local_group", { type: "group" });

    await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [localGroup.id]);

    const addSnapshot = (hostId: string, sessionId: string, avatar: string | null, joinedAt: number, active = 1, publicKey: string | null = null) =>
      hub.store.db.run(
        `INSERT INTO group_session_members(conversation_id,group_id,member_key,kind,host_id,host_name,host_public_key,bot_id,session_id,
          session_title,name_snapshot,avatar_snapshot,engine_snapshot,joined_at,joined_after_seq,history_visibility_json,active)
         VALUES(?,?,?,'remote',?,'Fixture host',?,'assistant',?,'Private direct chat','Remote assistant',?,'codex',?,0,'{"kind":"none"}',?)`,
        [group.id, group.id, `remote:${hostId}:assistant`, hostId, publicKey, sessionId, avatar, joinedAt, active],
      );
    await addSnapshot("peer_a", "private_a", "orange-cat", 1);
    await addSnapshot("peer_a", "private_a_duplicate", "pink-bunny", 2);
    await addSnapshot("peer_removed", "private_removed", "taro", 3, 0);
    const peerKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" });
    await addSnapshot("peer_b", "private_b", "profile:bot:assistant:v1", 4, 1, peerKey.toString("base64"));
    await addSnapshot("peer_duplicate_alias", "private_b_alias", "taro", 4, 1, peerKey.toString("base64"));
    for (let i = 0; i < 8; i++) await addSnapshot(`peer_extra_${i}`, `private_extra_${i}`, null, 5 + i);

    const ownerConversations = await hub.store.conversations("owner");
    const memberConversations = await hub.store.conversations("member");
    const expected = [
      { memberKey: "remote:peer_a:assistant", preset: "orange-cat" },
      { memberKey: "remote:peer_b:assistant", profile: { hostId: `hub_${createHash("sha256").update(peerKey).digest("hex")}`, botId: "assistant" } },
      ...Array.from({ length: 6 }, (_, i) => ({ memberKey: `remote:peer_extra_${i}:assistant` })),
    ];
    for (const conversations of [ownerConversations, memberConversations]) {
      expect(conversations.find(c => c.id === group.id)).toMatchObject({ botIds: ["assistant"] });
      expect(conversations.find(c => c.id === group.id)).toHaveProperty("remoteAvatarMembers", expected);
      expect(conversations.find(c => c.id === topic.id)).not.toHaveProperty("remoteAvatarMembers");
      expect(conversations.find(c => c.id === localGroup.id)).not.toHaveProperty("remoteAvatarMembers");
    }
    expect(await hub.store.conversations("outsider")).toEqual([]);
  });

  it("supports joining by existing session, different sessions per group, and auto-creating a session when none exists", async () => {
    const { hub } = await startHub("macmini");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_alpha','Alpha','codex','h',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_beta','Beta','claude','h',1)");

    // Give bot_alpha two pre-existing sessions; bot_beta has NONE.
    const sess1 = await hub.store.createConversation("owner", ["bot_alpha"], "Alpha Session 1", "s_alpha_1", { type: "direct" });
    const sess2 = await hub.store.createConversation("owner", ["bot_alpha"], "Alpha Session 2", "s_alpha_2", { type: "direct" });

    const g1 = await hub.store.createConversation("owner", ["bot_alpha"], "Architecture Group", "g_arch", { type: "group" });
    const g2 = await hub.store.createConversation("owner", ["bot_alpha"], "Release Group", "g_rel", { type: "group" });

    // 1. Join g1 with explicit session sess1 and g2 with explicit session sess2 (same Bot, different sessions!)
    const m1 = await hub.crossHostGroups.addMember("owner", g1.id, {
      botId: "bot_alpha",
      sessionId: sess1.id,
      historyVisibility: { kind: "recent", count: 10 },
    });
    const m2 = await hub.crossHostGroups.addMember("owner", g2.id, {
      botId: "bot_alpha",
      sessionId: sess2.id,
      historyVisibility: { kind: "all" },
    });
    expect(m1.sessionId).toBe(sess1.id);
    expect(m2.sessionId).toBe(sess2.id);
    expect(m1.historyVisibility).toEqual({ kind: "recent", count: 10 });

    // 2. Join bot_beta which has NO existing session -> auto-creates a session stating which group it came from!
    const mBeta = await hub.crossHostGroups.addMember("owner", g1.id, {
      botId: "bot_beta",
      historyVisibility: { kind: "none" },
    });
    expect(mBeta.sessionTitle).toContain("Architecture Group");
    expect(mBeta.sessionTitle).toContain("Beta");
    expect(await hub.crossHostGroups.canSessionAccessGroup(g1.id, mBeta.sessionId)).toBe(true);

    // 3. Removing a member revokes future access and records sessionId in formerSessionIds while keeping history openable!
    const { removed } = await hub.crossHostGroups.removeMember("owner", g1.id, mBeta.memberKey);
    expect(removed.sessionId).toBe(mBeta.sessionId);
    expect(await hub.crossHostGroups.canSessionAccessGroup(g1.id, mBeta.sessionId)).toBe(false);
    const state = await hub.crossHostGroups.getState("owner", g1.id, false);
    expect(state.formerSessionIds).toContain(mBeta.sessionId);
    expect(state.members.some((m) => m.memberKey === mBeta.memberKey)).toBe(false);
    // Former session conversation still exists in store so history stays readable
    const allConvs = await hub.store.conversations("owner");
    expect(allConvs.some((c) => c.id === mBeta.sessionId)).toBe(true);
  });

  it("delivers cross-host questions across two real Hubs, covers all 4 delivery states, survives Hub B restart, prevents rename hijacking, and marks unanswered questions on group stop", async () => {
    const a = await startHub("macmini");
    let b = await startHub("studio-b");

    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Architect','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Reviewer','claude','h',1)");

    // Wire mutual Ed25519 peer trust & explicit per-Bot cross-host grant
    const linkPeers = async () => {
      a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
      b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
      await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");
    };
    await linkPeers();

    const group = await a.hub.store.createConversation("owner", ["bot_local"], "Cross-Host Review", "g_cross", { type: "group" });

    // Join remote bot_remote on Hub B (no session yet -> auto-creates session on Hub B!)
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", group.id, {
      hostId: "peer_b",
      botId: "bot_remote",
      historyVisibility: { kind: "recent", count: 5 },
    });
    expect(remoteMember.kind).toBe("remote");
    expect(remoteMember.hostName).toBe("studio-b");
    expect(remoteMember.nameSnapshot).toBe("Reviewer");
    expect(remoteMember.sessionTitle).toContain("Cross-Host Review");

    // 1. Delivered state: Hub A sends a real signed cross-host question -> Hub B receives it in bot_remote's exact session!
    const msg1 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_1",
      text: "Please review the TLS handshake patch.",
      attachments: [],
    });
    const deliveredQuestions = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg1.message);
    expect(deliveredQuestions).toHaveLength(1);
    expect(deliveredQuestions[0]!.status).toBe("delivered");

    // Remote Bot replies on Hub B -> lands cleanly in Hub A's group attributed to join-time snapshot "Reviewer" on "studio-b"
    await b.hub.crossHostGroups.recordRemoteBotReply(deliveredQuestions[0]!.requestId, "b_reply_1", "Looks solid from studio-b!");
    const groupMsgsAfterReply = await a.hub.store.db.all<{ bot_source_json: string | null; blocks_json: string }>(
      "SELECT bot_source_json, blocks_json FROM messages WHERE conversation_id=?",
      [group.id],
    );
    expect(groupMsgsAfterReply.some((m) => m.bot_source_json && JSON.parse(m.bot_source_json).botName === "Reviewer" && JSON.parse(m.bot_source_json).hostName === "studio-b")).toBe(true);

    // 2. Rename-hijack protection: rename original bot_remote -> "Reviewer Old", create a NEW bot named "Reviewer"!
    await b.hub.store.db.run("UPDATE bots SET name='Reviewer Old' WHERE id='bot_remote'");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_impostor','Reviewer','codex','h',1)");

    const msg2 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_2",
      text: "Follow-up after rename",
      attachments: [],
    });
    const qAfterRename = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg2.message);
    expect(qAfterRename[0]!.status).toBe("delivered");
    // Verify it arrived strictly in original bot_remote's session, NEVER bot_impostor!
    const inboxRow = await b.hub.store.db.get<{ bot_id: string; session_id: string }>(
      "SELECT bot_id, session_id FROM group_mail_inbox WHERE request_id=?",
      [qAfterRename[0]!.requestId],
    );
    expect(inboxRow).toEqual({ bot_id: "bot_remote", session_id: remoteMember.sessionId });

    // 3. Whole-group stop marks unanswered remote question as stoppedUnanswered=true, yet late reply STILL lands!
    const stopRes = await a.hub.crossHostGroups.stopGroup("owner", group.id);
    expect(stopRes.stoppedUnansweredCount).toBe(1);
    expect(stopRes.questions[0]!.stoppedUnanswered).toBe(true);
    await b.hub.crossHostGroups.recordRemoteBotReply(qAfterRename[0]!.requestId, "b_reply_late", "Late answer after stop");
    const msgsAfterLate = await a.hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=?", [group.id]);
    expect(msgsAfterLate.some((m) => JSON.parse(m.blocks_json)[0]?.text === "Late answer after stop")).toBe(true);

    // 4. Uncertain state (mid-flight drop after Hub B accepted) + Hub B RESTART + idempotent recovery!
    const realDeliver = a.hub.crossHostGroups["transport"];
    a.hub.crossHostGroups.setTransport(async (peer, method, routePath, headers, body) => {
      if (routePath === "/api/group-mail/deliver") {
        await realDeliver(peer, method, routePath, headers, body);
        throw new Error("socket hang up");
      }
      return realDeliver(peer, method, routePath, headers, body);
    });
    const msg3 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_3",
      text: "Message during mid-flight drop",
      attachments: [],
    });
    const qUncertain = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg3.message);
    expect(qUncertain[0]!.status).toBe("uncertain");

    // Now SHUT DOWN Hub B completely (offline!) -> sending a new message fails cleanly with offline notice & zero loss!
    a.hub.crossHostGroups.setTransport(realDeliver);
    await b.hub.close();
    hubs.splice(hubs.indexOf(b.hub), 1);

    const msg4 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_4",
      text: "Message while Hub B is offline",
      attachments: [],
    });
    const qFailed = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg4.message);
    expect(qFailed[0]!.status).toBe("failed");
    expect(qFailed[0]!.error).toContain("studio-b");

    // RESTART Hub B on the SAME stateDir (real restart recovery!)
    b = await startHub("studio-b", b.stateDir);
    await linkPeers();

    // Reconcile uncertain msg3 (already persisted on Hub B before restart -> recovers as delivered with ZERO duplicate!)
    const recovered3 = await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, qUncertain[0]!.id);
    expect(recovered3.status).toBe("delivered");
    // Retry failed msg4 now that Hub B is back -> succeeds cleanly!
    const retried4 = await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, qFailed[0]!.id);
    expect(retried4.status).toBe("delivered");

    // Verify zero duplicate messages in bot_remote's session for msg3!
    const remoteMsgs = await b.hub.store.db.all<{ client_msg_id: string | null }>(
      "SELECT client_msg_id FROM messages WHERE conversation_id=?",
      [remoteMember.sessionId],
    );
    expect(remoteMsgs.filter((m) => m.client_msg_id === `gmail_${qUncertain[0]!.requestId}`)).toHaveLength(1);

    // 5. New room allocates fresh sessions for every active member (local + remote) WITHOUT revoking root group
    const { room, memberSessions } = await a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Sprint 12 Room" });
    expect(room.parentId).toBe(group.id);
    expect(memberSessions).toHaveLength(2);
    expect(memberSessions.every((ms) => ms.sessionId !== remoteMember.sessionId)).toBe(true);
    expect(await a.hub.crossHostGroups.canSessionAccessGroup(group.id, remoteMember.sessionId)).toBe(true);
    const roomRemote = memberSessions.find((ms) => ms.memberKey === remoteMember.memberKey)!;
    expect(await a.hub.crossHostGroups.canSessionAccessGroup(room.id, roomRemote.sessionId)).toBe(true);
    expect(await a.hub.crossHostGroups.canSessionAccessGroup(room.id, remoteMember.sessionId)).toBe(false);
  });

  it("wires live cross-host dispatch, remote Bot gateway reply forwarding with durable retry, live WS/FTS/push delivery, and local Gateway session binding", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });

    const localCalls: Array<{ conversationKey?: string; text: string }> = [];
    await connectBot(a.hub, a.stateDir, "bot_local", "LocalArch", async (turn) => {
      localCalls.push({ conversationKey: turn.conversationKey, text: turn.text });
      return { text: `Local reply on ${turn.conversationKey}` };
    });
    await connectBot(b.hub, b.stateDir, "bot_remote", "RemoteRev", async (turn) => {
      return { text: `Remote auto answer: ${turn.text.slice(-24)}` };
    });
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");

    // Create two groups with distinct local sessions for bot_local
    const sessG1 = await a.hub.store.createConversation("owner", ["bot_local"], "Local Sess G1", "s_local_g1", { type: "direct" });
    const sessG2 = await a.hub.store.createConversation("owner", ["bot_local"], "Local Sess G2", "s_local_g2", { type: "direct" });
    const g1 = await a.hub.store.createConversation("owner", ["bot_local"], "Wired Group 1", "g_wired_1", { type: "group" });
    const g2 = await a.hub.store.createConversation("owner", ["bot_local"], "Wired Group 2", "g_wired_2", { type: "group" });

    // Attach a live owner WS session + push-registered device on Hub A (after groups exist so WS subscribes to g1)
    const ownerSession = await openOwnerSession(a.hub, "dev_live");
    sockets.push(ownerSession.ws);
    await a.hub.store.db.run(
      "UPDATE devices SET push_json=? WHERE id='dev_live'",
      [JSON.stringify({ kind: "apns", token: "a".repeat(64), topic: "com.tarobot.app" })],
    );
    await a.hub.store.db.run(
      "INSERT OR REPLACE INTO device_preferences(device_id, preferences_json) VALUES('dev_live', ?)",
      [JSON.stringify({ enabled: true })],
    );
    const liveEvents: string[] = [];
    a.hub.store.subscribe((ev) => {
      if (ev.kind === "message.created") liveEvents.push(ev.conversationId);
    });

    // Pre-join message in g1 to verify local join-time history backfill happens once
    await a.hub.store.sendMessage("owner", { conversationId: g1.id, clientMsgId: "pre_join_1", text: "Pre-join architectural decision", attachments: [] });

    await a.hub.crossHostGroups.addMember("owner", g1.id, { botId: "bot_local", sessionId: sessG1.id, historyVisibility: { kind: "recent", count: 5 } });
    await a.hub.crossHostGroups.addMember("owner", g2.id, { botId: "bot_local", sessionId: sessG2.id, historyVisibility: { kind: "none" } });
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", g1.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "none" } });

    // Switch g1 to parallel mode so a plain sendMessage automatically dispatches to BOTH local & remote members!
    const cur = await a.hub.store.groupSettings("owner", g1.id);
    await a.hub.store.updateGroup("owner", g1.id, {
      title: g1.title,
      expectedTitle: g1.title,
      botIds: g1.botIds,
      expectedBotIds: g1.botIds,
      policy: { ...cur.policy, mode: "parallel" },
      expectedRevision: cur.revision,
    });

    // Send message WITHOUT ever calling sendToRemoteMembers or recordRemoteBotReply manually!
    await a.hub.store.sendMessage("owner", { conversationId: g1.id, clientMsgId: "auto_parallel_1", text: "Auto cross-host trigger", attachments: [] });

    // Wait for remote answer to land automatically on Hub A!
    const remoteAnswer = await waitFor(
      async () => {
        const rows = await a.hub.store.db.all<{ id: string; blocks_json: string; bot_source_json: string | null }>(
          "SELECT id, blocks_json, bot_source_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL",
          [g1.id],
        );
        return rows[0];
      },
      (row) => !!row,
    );
    expect(JSON.parse(remoteAnswer!.blocks_json)[0].text).toContain("Remote auto answer");

    // Verify live WS event, FTS5 index, and push_outbox enqueue for the remote answer!
    expect(liveEvents).toContain(g1.id);
    await waitFor(
      () => ownerSession.frames.some((f) => f.kind === "message.created" && f.conversationId === g1.id && (f.payload as { id?: string } | undefined)?.id === remoteAnswer!.id),
      (ok) => ok,
    );
    const ftsHits = await a.hub.store.search("owner", "Remote auto answer");
    expect(ftsHits.some((m) => m.id === remoteAnswer!.id)).toBe(true);
    const pushRows = await a.hub.store.db.all<{ payload_json: string }>("SELECT payload_json FROM push_outbox WHERE conversation_id=?", [g1.id]);
    expect(pushRows.some((p) => p.payload_json.includes(remoteAnswer!.id))).toBe(true);

    // Verify local Bot received bound session conversationKey (sessG1.id) + pre-join history ONLY on first turn
    await waitFor(() => localCalls.length, (n) => n >= 1);
    expect(localCalls[0]!.conversationKey).toContain(sessG1.id);
    expect(localCalls[0]!.text).toContain("Pre-join architectural decision");

    // Second turn in g1 must NOT repeat pre-join history; turn in g2 must use sessG2.id!
    await a.hub.store.sendMessage("owner", { conversationId: g1.id, clientMsgId: "auto_local_2", text: "Second turn in g1", attachments: [], mentions: ["bot_local"] });
    await a.hub.store.sendMessage("owner", { conversationId: g2.id, clientMsgId: "auto_local_g2", text: "Turn in g2", attachments: [], mentions: ["bot_local"] });
    await waitFor(() => localCalls.length, (n) => n >= 3);
    expect(localCalls[1]!.conversationKey).toContain(sessG1.id);
    expect(localCalls[1]!.text).not.toContain("Pre-join architectural decision");
    expect(localCalls[2]!.conversationKey).toContain(sessG2.id);
    expect(localCalls[2]!.conversationKey).not.toBe(localCalls[0]!.conversationKey);

    // Durable retry when Hub A is temporarily unreachable during remote reply forwarding!
    const origBTransport = b.hub.crossHostGroups["transport"];
    let failReply = true;
    b.hub.crossHostGroups.setTransport(async (peer, method, routePath, headers, body) => {
      if (routePath === "/api/group-mail/reply" && failReply) throw new Error("ECONNREFUSED");
      return origBTransport(peer, method, routePath, headers, body);
    });
    await a.hub.store.sendMessage("owner", {
      conversationId: g1.id,
      clientMsgId: "durable_retry_1",
      text: "Trigger durable reply retry",
      attachments: [],
      mentions: [remoteMember.botId],
    });
    // Wait until Hub B records the bot's reply in inbox as pending retry (reply_forwarded=0)
    const pendingInbox = await waitFor(
      async () => b.hub.store.db.get<{ request_id: string; reply_forwarded: number; reply_text: string | null }>(
        "SELECT request_id, reply_forwarded, reply_text FROM group_mail_inbox WHERE status='answered' AND reply_forwarded=0",
      ),
      (row) => !!row && !!row.reply_text,
    );
    expect(pendingInbox!.reply_forwarded).toBe(0);
    // Restore Hub A reachability and flush pending replies!
    failReply = false;
    await b.hub.store.db.run("UPDATE group_mail_inbox SET reply_next_at=0 WHERE request_id=?", [pendingInbox!.request_id]);
    await b.hub.crossHostGroups.flushPendingReplies();
    const afterFlush = await b.hub.store.db.get<{ reply_forwarded: number }>(
      "SELECT reply_forwarded FROM group_mail_inbox WHERE request_id=?",
      [pendingInbox!.request_id],
    );
    expect(afterFlush?.reply_forwarded).toBe(1);
    const allRemoteMsgs = await a.hub.store.db.all<{ id: string }>(
      "SELECT id FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL",
      [g1.id],
    );
    expect(allRemoteMsgs).toHaveLength(2);
  }, 20_000);

  it("migrates schema 26 group_discussion_settings CHECK constraint to allow 'designated' and routes designated replies accurately", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('alpha','Alpha','codex','h',1),('beta','Beta','claude','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','RemoteBot','claude','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");
    const group = await a.hub.store.createConversation("owner", ["alpha", "beta"], "Designated Test", "g_desig", { type: "group" });

    // Downgrade group_discussion_settings to the schema 26 4-mode CHECK constraint and reopen HubServer!
    await a.hub.store.db.transaction(async () => {
      await a.hub.store.db.exec(`
        ALTER TABLE group_discussion_settings RENAME TO old_gds;
        CREATE TABLE group_discussion_settings (group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('mentions','parallel','sequential','independent')), order_json TEXT NOT NULL, max_rounds INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO group_discussion_settings SELECT * FROM old_gds;
        DROP TABLE old_gds;
        UPDATE meta SET value='26' WHERE key='schema_version';
      `);
    });
    const stateDirA = a.stateDir;
    await a.hub.close();
    hubs.splice(hubs.indexOf(a.hub), 1);
    const reopened = await startHub("macmini", stateDirA);
    reopened.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });

    expect(await reopened.hub.store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "28" });

    // Saving mode='designated' succeeds cleanly without SQLITE_CONSTRAINT!
    const current = await reopened.hub.store.groupSettings("owner", group.id);
    await reopened.hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: group.botIds,
      expectedBotIds: group.botIds,
      policy: { ...current.policy, mode: "designated" },
      expectedRevision: current.revision,
    });
    expect((await reopened.hub.store.groupSettings("owner", group.id)).policy.mode).toBe("designated");

    // 1. Designated unset -> unmentioned message creates 0 deliveries (clean fallback to record-only)
    const mUnset = await reopened.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "desig_unset", text: "Nobody designated yet", attachments: [] });
    expect(await reopened.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [mUnset.message.id])).toEqual([]);

    // 2. Designate local 'beta' -> unmentioned message routes ONLY to 'beta', explicit @alpha overrides!
    await reopened.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: "local:beta" });
    const mLocal = await reopened.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "desig_local", text: "Default to beta", attachments: [] });
    expect(await reopened.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [mLocal.message.id])).toEqual([{ bot_id: "beta" }]);
    const mOverride = await reopened.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "desig_override", text: "Override to alpha", attachments: [], mentions: ["alpha"] });
    expect(await reopened.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [mOverride.message.id])).toEqual([{ bot_id: "alpha" }]);

    // 3. Designate remote member -> unmentioned message automatically dispatches cross-host to Hub B and creates 0 local deliveries!
    const remoteMember = await reopened.hub.crossHostGroups.addMember("owner", group.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "none" } });
    await reopened.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: remoteMember.memberKey });
    const mRemote = await reopened.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "desig_remote", text: "Default to remote", attachments: [] });
    expect(await reopened.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [mRemote.message.id])).toEqual([]);
    const remoteQ = await waitFor(
      async () => reopened.hub.store.db.get<{ status: string; member_key: string }>(
        "SELECT status, member_key FROM group_remote_questions WHERE source_message_id=?",
        [mRemote.message.id],
      ),
      (row) => row?.status === "delivered",
    );
    expect(remoteQ).toEqual({ status: "delivered", member_key: remoteMember.memberKey });
  });

  it("blocks cross-peer reply spoofing, status disclosure, signature reflection/replay, ungranted Bots, dispatcher/worker Bots, non-direct sessions, and malformed JSON", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    const c = await startHub("studio-c");

    // Register A, B, C with each other (B ONLY grants bot_allowed to A, never to C; B also has bot_ungranted & bot_dispatcher)
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_c", hostName: "studio-c", publicKey: c.hub.auth.publicKey, url: c.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_c", hostName: "studio-c", publicKey: c.hub.auth.publicKey, url: c.hub.url });
    c.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    c.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });

    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Local','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_allowed','Allowed','claude','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_ungranted','SecretBot','claude','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online,role) VALUES('bot_disp','Dispatcher','codex','h',1,'dispatcher')");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online,role) VALUES('bot_work','Worker','codex','h',1,'worker')");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_allowed");
    await expect(b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_disp")).rejects.toThrow("dispatcher_group_forbidden");
    await expect(b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_work")).rejects.toThrow("dispatch_worker_internal");
    // Even if a legacy cross-host grant exists in meta for dispatcher/worker, group-mail endpoints still block them!
    for (const targetBot of ["bot_disp", "bot_work"]) {
      const k = `bot-messages:grant:${hashSecret(JSON.stringify([a.hub.auth.publicKey, "group-mail", targetBot]))}`;
      await b.hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [k, JSON.stringify({ sourceKey: a.hub.auth.publicKey, sourceBot: "group-mail", targetBot, revoked: false })]);
    }

    const signedHeaders = (fromHub: HubServer, targetPublicKey: string, method: string, routePath: string, bodyText: string, nonce = randomBytes(16).toString("base64url")) => {
      const ts = String(Date.now());
      const payload = groupMailSignaturePayload(fromHub.auth.publicKey, targetPublicKey, method, routePath, ts, nonce, bodyText);
      const sig = fromHub.auth.signGroupMail(payload);
      return {
        "Content-Type": "application/json",
        "X-TaroBot-Group-Peer-Key": fromHub.auth.publicKey,
        "X-TaroBot-Group-Target-Key": targetPublicKey,
        "X-TaroBot-Group-Timestamp": ts,
        "X-TaroBot-Group-Nonce": nonce,
        "X-TaroBot-Group-Signature": sig,
      };
    };

    // 1. Peer C has NO grants on Hub B -> directory is empty & /sessions rejected (403)
    const dirC = await fetch(`${b.hub.url}/api/group-mail/directory`, { headers: signedHeaders(c.hub, b.hub.auth.publicKey, "GET", "/api/group-mail/directory", "") });
    expect(dirC.status).toBe(200);
    expect((await dirC.json() as { bots: unknown[] }).bots).toEqual([]);

    const ungrantedBody = JSON.stringify({ botId: "bot_allowed", title: "Sneaky" });
    const ungrantedRes = await fetch(`${b.hub.url}/api/group-mail/sessions`, {
      method: "POST",
      headers: signedHeaders(c.hub, b.hub.auth.publicKey, "POST", "/api/group-mail/sessions", ungrantedBody),
      body: ungrantedBody,
    });
    expect(ungrantedRes.status).toBe(403);

    // 2. Peer A sees ONLY bot_allowed (never bot_ungranted, bot_disp, or bot_work)
    const dirA = await fetch(`${b.hub.url}/api/group-mail/directory`, { headers: signedHeaders(a.hub, b.hub.auth.publicKey, "GET", "/api/group-mail/directory", "") });
    expect(((await dirA.json()) as { bots: Array<{ botId: string }> }).bots.map((x) => x.botId)).toEqual(["bot_allowed"]);

    for (const [forbiddenBot, expectedStatus] of [["bot_ungranted", 403], ["bot_disp", 409], ["bot_work", 409]] as const) {
      const body = JSON.stringify({ botId: forbiddenBot, title: "Forbidden" });
      const res = await fetch(`${b.hub.url}/api/group-mail/sessions`, {
        method: "POST",
        headers: signedHeaders(a.hub, b.hub.auth.publicKey, "POST", "/api/group-mail/sessions", body),
        body,
      });
      expect(res.status).toBe(expectedStatus);
    }

    // 3. Replay & cross-peer reflection protection
    const sessBody = JSON.stringify({ botId: "bot_allowed", title: "Replay Check" });
    const replayHeaders = signedHeaders(a.hub, b.hub.auth.publicKey, "POST", "/api/group-mail/sessions", sessBody);
    const firstSess = await fetch(`${b.hub.url}/api/group-mail/sessions`, { method: "POST", headers: replayHeaders, body: sessBody });
    expect(firstSess.status).toBe(200);
    // Exact replay rejected with 403!
    const replaySess = await fetch(`${b.hub.url}/api/group-mail/sessions`, { method: "POST", headers: replayHeaders, body: sessBody });
    expect(replaySess.status).toBe(403);
    expect((await replaySess.json() as { error: string }).error).toBe("group_peer_replay");
    // Cross-peer reflection (Hub A's headers targeting Hub B sent to Hub C) rejected with 403!
    const reflected = await fetch(`${c.hub.url}/api/group-mail/sessions`, { method: "POST", headers: replayHeaders, body: sessBody });
    expect(reflected.status).toBe(403);

    // 4. Non-direct / archived / hidden conversation rejected in /deliver
    const bGroup = await b.hub.store.createConversation("owner", ["bot_allowed"], "Private B Group", "b_grp", { type: "group" });
    const bArchived = await b.hub.store.createConversation("owner", ["bot_allowed"], "Archived Direct", "b_arch", { type: "direct" });
    await b.hub.store.db.run("UPDATE conversations SET archived=1 WHERE id=?", [bArchived.id]);
    const bHidden = await b.hub.store.createConversation("owner", ["bot_allowed"], "Hidden Direct", "b_hid", { type: "direct" });
    await b.hub.store.db.run("UPDATE conversations SET hidden=1 WHERE id=?", [bHidden.id]);
    for (const badSessionId of [bGroup.id, bArchived.id, bHidden.id]) {
      const deliverBody = JSON.stringify({
        requestId: `req_bad_${badSessionId}`,
        groupId: "g_x",
        groupTitle: "G",
        conversationId: "g_x",
        sourceHostId: "origin",
        sourceHostName: "macmini",
        sourceMessageId: "m_x",
        botId: "bot_allowed",
        sessionId: badSessionId,
        text: "Should be blocked",
        contextMessages: [],
      });
      const res = await fetch(`${b.hub.url}/api/group-mail/deliver`, {
        method: "POST",
        headers: signedHeaders(a.hub, b.hub.auth.publicKey, "POST", "/api/group-mail/deliver", deliverBody),
        body: deliverBody,
      });
      expect(res.status).toBe(409);
    }

    // 5. Hub A delivers legitimate question to Hub B -> Peer C cannot read its status AND cannot forge Hub B's reply to Hub A!
    const groupA = await a.hub.store.createConversation("owner", ["bot_local"], "Protected Group", "g_sec", { type: "group" });
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", groupA.id, { hostId: "peer_b", botId: "bot_allowed", historyVisibility: { kind: "none" } });
    const msg = await a.hub.store.sendMessage("owner", { conversationId: groupA.id, clientMsgId: "sec_q", text: "Private question", attachments: [] });
    const [q] = await a.hub.crossHostGroups.sendToRemoteMembers("owner", groupA.id, groupA.id, msg.message);
    expect(q!.status).toBe("delivered");

    // Peer C tries to read Hub A's status on Hub B -> 403!
    const statusPath = `/api/group-mail/status/${encodeURIComponent(q!.requestId)}`;
    const spoofedStatus = await fetch(`${b.hub.url}${statusPath}`, { headers: signedHeaders(c.hub, b.hub.auth.publicKey, "GET", statusPath, "") });
    expect(spoofedStatus.status).toBe(403);

    // Peer C tries to forge Hub B's reply to Hub A -> 403!
    const forgedReplyBody = JSON.stringify({
      requestId: q!.requestId,
      groupId: groupA.id,
      conversationId: groupA.id,
      botId: remoteMember.botId,
      sessionId: remoteMember.sessionId,
      text: "Forged reply from Peer C!",
    });
    const forgedReply = await fetch(`${a.hub.url}/api/group-mail/reply`, {
      method: "POST",
      headers: signedHeaders(c.hub, a.hub.auth.publicKey, "POST", "/api/group-mail/reply", forgedReplyBody),
      body: forgedReplyBody,
    });
    expect(forgedReply.status).toBe(403);

    // 6. Malformed JSON returns 400 invalid_json (not 500)
    const badJson = "{not-json";
    const badJsonRes = await fetch(`${b.hub.url}/api/group-mail/sessions`, {
      method: "POST",
      headers: signedHeaders(a.hub, b.hub.auth.publicKey, "POST", "/api/group-mail/sessions", badJson),
      body: badJson,
    });
    expect(badJsonRes.status).toBe(400);
    expect((await badJsonRes.json() as { error: string }).error).toBe("invalid_json");
  });

  it("connects over real private-CA desktopTls with leaf certificate pinning and enforces non-loopback SSRF guard for network peers", async () => {
    const a = await startHub("macmini");
    const bStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "tarobird-85-tls-b-"));
    dirs.push(bStateDir);
    const tlsInfo = await desktopTls(bStateDir, ["127.0.0.1"]);
    const [cert, key] = await Promise.all([fs.readFile(tlsInfo.cert), fs.readFile(tlsInfo.key)]);
    const b = await startHub("studio-tls", bStateDir, { tls: { cert, key } });
    expect(b.hub.url.startsWith("https://127.0.0.1:")).toBe(true);

    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Local','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_tls','TlsBot','claude','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_tls");

    // Register Hub B using its private CA route (allowLoopback: true for local test fixture, HTTPS + real private CA + peerPin)
    a.hub.crossHostGroups.registerPeer({
      hostId: "peer_tls",
      hostName: "studio-tls",
      publicKey: b.hub.auth.publicKey,
      routes: [{ name: "Direct", url: b.hub.url, certificateAuthority: tlsInfo.certificateAuthority }],
      allowLoopback: true,
    });
    b.hub.crossHostGroups.registerPeer({
      hostId: "peer_a",
      hostName: "macmini",
      publicKey: a.hub.auth.publicKey,
      url: a.hub.url,
    });

    const group = await a.hub.store.createConversation("owner", ["bot_local"], "TLS Group", "g_tls", { type: "group" });
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "peer_tls", botId: "bot_tls", historyVisibility: { kind: "none" } });
    expect(remoteMember.hostName).toBe("studio-tls");

    const msg = await a.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "tls_msg", text: "Hello over private-CA TLS", attachments: [] });
    const [q] = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg.message);
    expect(q!.status).toBe("delivered");

    // Verify network peer with allowLoopback=false rejects loopback/plain HTTP routes (SSRF guard)
    a.hub.crossHostGroups.registerPeer({
      hostId: "peer_ssrf",
      hostName: "ssrf",
      publicKey: b.hub.auth.publicKey,
      routes: [{ name: "Direct", url: b.hub.url, certificateAuthority: tlsInfo.certificateAuthority }],
      allowLoopback: false,
    });
    await expect(
      a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "peer_ssrf", botId: "bot_tls", historyVisibility: { kind: "none" } }),
    ).rejects.toThrow();
  });

  it("enforces non-owner bot_grants, revoked device guards, URI validation, read-only GET /members, history filtering, stopGroup, archived/topic guards, and avatar snapshots", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('b1','Bot1','codex','h',1),('b2','Bot2','claude','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Rem','claude','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");
    // Seed profile avatar for b1 so avatarSnapshot is populated
    await a.hub.store.db.run("INSERT INTO profile_avatars(kind,target_id,revision,png) VALUES('bot','b1',3,?)", [Buffer.from([1, 2, 3])]);

    // Bug 6: Non-owner group creator u2 cannot bypass revoked bot_grants or add remote peer Bots
    await a.hub.store.db.run("INSERT INTO users(id,name,role) VALUES('u2','MemberUser','member')");
    await a.hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('u2','b1'),('u2','b2')");
    const u2SessB2 = await a.hub.store.createConversation("u2", ["b2"], "Prior b2 session", "s_u2_b2", { type: "direct" });
    const u2Group = await a.hub.store.createConversation("u2", ["b1"], "Member Group", "g_u2", { type: "group" });
    // Revoke u2's grant to b2!
    await a.hub.store.db.run("DELETE FROM bot_grants WHERE user_id='u2' AND bot_id='b2'");
    await expect(a.hub.crossHostGroups.addMember("u2", u2Group.id, { botId: "b2", sessionId: u2SessB2.id, historyVisibility: { kind: "none" } })).rejects.toThrow("bot_forbidden");
    await expect(a.hub.crossHostGroups.addMember("u2", u2Group.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "none" } })).rejects.toThrow("owner_required");

    // Bug 11: GET /api/groups/:id/members is strictly read-only (0 direct conversations created) & works for non-owner member!
    const directCountBefore = (await a.hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE type='direct'"))!.n;
    const u2State = await a.hub.crossHostGroups.getState("u2", u2Group.id, true);
    expect(u2State.members).toHaveLength(1);
    expect(u2State.members[0]!.avatarSnapshot).toBe("profile:bot:b1:v3");
    const directCountAfter = (await a.hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE type='direct'"))!.n;
    expect(directCountAfter).toBe(directCountBefore);

    // Owner group for remaining checks
    const group = await a.hub.store.createConversation("owner", ["b1", "b2"], "Full Checks Group", "g_checks", { type: "group" });
    const s1 = await a.hub.store.createConversation("owner", ["b1"], "S1", "s_c1", { type: "direct" });
    const s2 = await a.hub.store.createConversation("owner", ["b1"], "S2", "s_c2", { type: "direct" });
    await a.hub.crossHostGroups.addMember("owner", group.id, { botId: "b1", sessionId: s1.id, historyVisibility: { kind: "none" } });
    // Bug 11: Replacing session via addMember records s1 in group_former_sessions
    await a.hub.crossHostGroups.addMember("owner", group.id, { botId: "b1", sessionId: s2.id, historyVisibility: { kind: "none" } });
    expect((await a.hub.crossHostGroups.getState("owner", group.id, false)).formerSessionIds).toContain(s1.id);

    // Bug 11: >512 former sessions caps at 512 and parses cleanly with groupMembersStateSchema
    for (let i = 0; i < 520; i++) {
      await a.hub.store.db.run(
        "INSERT OR IGNORE INTO group_former_sessions(conversation_id,group_id,session_id,member_key,bot_id,host_id,revoked_at) VALUES(?,?,?,?,?,?,?)",
        [group.id, group.id, `old_sess_${i}`, "local:b1", "b1", "local", 1000 + i],
      );
    }
    const cappedState = groupMembersStateSchema.parse(await a.hub.crossHostGroups.getState("owner", group.id, false));
    expect(cappedState.formerSessionIds).toHaveLength(512);

    // Bug 9: store.updateGroup removing local Bot b2 retires its group_session_members into group_former_sessions and clears designated
    const b2Added = await a.hub.crossHostGroups.addMember("owner", group.id, { botId: "b2", historyVisibility: { kind: "none" } });
    await a.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: b2Added.memberKey });
    await a.hub.store.updateGroup("owner", group.id, { title: group.title, expectedTitle: group.title, botIds: ["b1"], expectedBotIds: ["b1", "b2"] });
    expect(await a.hub.crossHostGroups.canSessionAccessGroup(group.id, b2Added.sessionId)).toBe(false);
    expect((await a.hub.crossHostGroups.getState("owner", group.id, false)).designatedMemberKey).toBeNull();

    // Bug 8: removeMember rejects removing last local Bot (bots_required), busy Bot (group_bot_busy), and active discussion participant (group_discussion_active)
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "none" } });
    await expect(a.hub.crossHostGroups.removeMember("owner", group.id, "local:b1")).rejects.toThrow("bots_required");
    await a.hub.crossHostGroups.addMember("owner", group.id, { botId: "b2", historyVisibility: { kind: "none" } });
    const busyMsg = await a.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "busy_b2", text: "Busy", attachments: [], mentions: ["b2"] });
    await expect(a.hub.crossHostGroups.removeMember("owner", group.id, "local:b2")).rejects.toThrow("group_bot_busy");
    await a.hub.store.acknowledgeDelivery("b2", busyMsg.message.id);

    // Bug 8: createRoom broadcasts conversation.updated over live WS AND partial remote failure leaves 0 orphaned rooms
    const ownerWs = await openOwnerSession(a.hub, "dev_checks");
    sockets.push(ownerWs.ws);
    const { room } = await a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Broadcast Room" });
    await waitFor(
      () => ownerWs.frames.some((f) => f.type === "conversation.updated" && (f.conversation as { id?: string })?.id === room.id),
      (ok) => ok,
    );
    const roomCountBeforeFail = (await a.hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE parent_id=?", [group.id]))!.n;
    const origTrans = a.hub.crossHostGroups["transport"];
    a.hub.crossHostGroups.setTransport(async () => { throw new Error("ECONNREFUSED"); });
    await expect(a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Should Not Orphan" })).rejects.toThrow("peer_host_offline");
    expect((await a.hub.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE parent_id=?", [group.id]))!.n).toBe(roomCountBeforeFail);
    a.hub.crossHostGroups.setTransport(origTrans);

    // Bug 7: Malformed % in memberKey returns 400 invalid_request; revoked device token gets 401 before mutating DB
    const badUriRes = await fetch(`${a.hub.url}/api/groups/${group.id}/members/%E0%A4%A`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerWs.token}` },
    });
    expect(badUriRes.status).toBe(400);
    await a.hub.auth.revoke("dev_checks", "local-owner");
    const revokedDelete = await fetch(`${a.hub.url}/api/groups/${group.id}/members/${encodeURIComponent(remoteMember.memberKey)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ownerWs.token}` },
    });
    expect(revokedDelete.status).toBe(401);
    expect(await a.hub.crossHostGroups.canSessionAccessGroup(group.id, remoteMember.sessionId)).toBe(true);
    const revokedStop = await fetch(`${a.hub.url}/api/groups/${group.id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerWs.token}` },
    });
    expect(revokedStop.status).toBe(401);

    // Bug 12: visibleHistoryForMember excludes current prompt, deleted messages, respects joinedAfterSeq, sends once, preserves on retry
    const histGroup = await a.hub.store.createConversation("owner", ["b1"], "History Filter Group", "g_hist", { type: "group" });
    const hKeep = await a.hub.store.sendMessage("owner", { conversationId: histGroup.id, clientMsgId: "h_keep", text: "KEEP_HISTORY_MSG", attachments: [] });
    const hDel = await a.hub.store.sendMessage("owner", { conversationId: histGroup.id, clientMsgId: "h_del", text: "DELETED_SECRET_MSG", attachments: [] });
    await a.hub.store.deleteMessages("owner", histGroup.id, { messageIds: [hDel.message.id] });
    expect(hKeep.message.id).toBeTruthy();

    const histRemote = await a.hub.crossHostGroups.addMember("owner", histGroup.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "recent", count: 10 } });
    // Post-join message MUST NOT appear in join-time backfill (joinedAfterSeq check)
    await a.hub.store.sendMessage("owner", { conversationId: histGroup.id, clientMsgId: "h_post_join", text: "POST_JOIN_MSG", attachments: [] });

    // First delivery fails offline -> then retry must STILL include KEEP_HISTORY_MSG (not []) and exclude DELETED_SECRET_MSG, POST_JOIN_MSG, and current prompt!
    const capturedDeliveries: Array<{ text: string; contextMessages: Array<{ text: string }> }> = [];
    let failOnce = true;
    a.hub.crossHostGroups.setTransport(async (peer, method, routePath, headers, body) => {
      if (routePath === "/api/group-mail/deliver") {
        if (failOnce) {
          failOnce = false;
          throw new Error("ECONNREFUSED");
        }
        if (body) capturedDeliveries.push(JSON.parse(body));
      }
      return origTrans(peer, method, routePath, headers, body);
    });
    const q1Msg = await a.hub.store.sendMessage("owner", { conversationId: histGroup.id, clientMsgId: "h_q1", text: "CURRENT_PROMPT_1", attachments: [] });
    const [q1Failed] = await a.hub.crossHostGroups.sendToRemoteMembers("owner", histGroup.id, histGroup.id, q1Msg.message);
    expect(q1Failed!.status).toBe("failed");
    const q1Retried = await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", histGroup.id, q1Failed!.id);
    expect(q1Retried.status).toBe("delivered");
    expect(capturedDeliveries).toHaveLength(1);
    const ctxTexts = capturedDeliveries[0]!.contextMessages.map((m) => m.text);
    expect(ctxTexts).toContain("KEEP_HISTORY_MSG");
    expect(ctxTexts).not.toContain("DELETED_SECRET_MSG");
    expect(ctxTexts).not.toContain("POST_JOIN_MSG");
    expect(ctxTexts).not.toContain("CURRENT_PROMPT_1");

    // Second question to same member must NOT re-send join-time backfill!
    const q2Msg = await a.hub.store.sendMessage("owner", { conversationId: histGroup.id, clientMsgId: "h_q2", text: "CURRENT_PROMPT_2", attachments: [] });
    await a.hub.crossHostGroups.sendToRemoteMembers("owner", histGroup.id, histGroup.id, q2Msg.message);
    expect(capturedDeliveries).toHaveLength(2);
    expect(capturedDeliveries[1]!.contextMessages).toEqual([]);
    a.hub.crossHostGroups.setTransport(origTrans);

    // Bug 13: stopGroup ignores already-answered questions, ends active discussion, rejects topics & archived groups
    await b.hub.crossHostGroups.recordRemoteBotReply(q1Retried.requestId, "r_ans_1", "Answer 1");
    const stopFirst = await a.hub.crossHostGroups.stopGroup("owner", histGroup.id);
    expect(stopFirst.stoppedUnansweredCount).toBe(1); // Only q2 is unanswered; q1 was already answered!
    await b.hub.crossHostGroups.recordRemoteBotReply(stopFirst.questions[0]!.requestId, "r_ans_2", "Late answer 2");
    const stopSecond = await a.hub.crossHostGroups.stopGroup("owner", histGroup.id);
    expect(stopSecond.stoppedUnansweredCount).toBe(0);

    // Active discussion ended by stopGroup & blocks removeMember while active
    const curS = await a.hub.store.groupSettings("owner", group.id);
    await a.hub.store.updateGroup("owner", group.id, {
      title: group.title, expectedTitle: group.title, botIds: ["b1", "b2"], expectedBotIds: ["b1", "b2"],
      policy: { mode: "sequential", botOrder: ["b1", "b2"], maxRounds: 1 }, expectedRevision: curS.revision,
    });
    const afterS = await a.hub.store.groupSettings("owner", group.id);
    const disc = await a.hub.groupDiscussions.start("owner", group.id, { requestId: "stop_disc", revision: afterS.revision, text: "Test stop" });
    expect(disc.run?.status).toBe("running");
    await expect(a.hub.crossHostGroups.removeMember("owner", group.id, "local:b2")).rejects.toThrow("group_discussion_active");
    await a.hub.crossHostGroups.stopGroup("owner", group.id);
    expect((await a.hub.groupDiscussions.view("owner", group.id)).run?.status).toBe("ended");

    // Topic & archived group rejected on mutating endpoints
    await expect(a.hub.crossHostGroups.stopGroup("owner", room.id)).rejects.toThrow("group_required");
    await a.hub.store.db.run("UPDATE conversations SET archived=1 WHERE id=?", [histGroup.id]);
    await expect(a.hub.crossHostGroups.stopGroup("owner", histGroup.id)).rejects.toThrow("conversation_archived");
    await expect(a.hub.crossHostGroups.addMember("owner", histGroup.id, { botId: "b2", historyVisibility: { kind: "none" } })).rejects.toThrow("conversation_archived");
    expect(histRemote.sessionId).toBeTruthy();
  });

  it("preserves 1.6.0 strict schema compatibility for designated mode across discussion/settings reads, sends, topics, and updates", async () => {
    // Exact 1.6.0 strict Zod schemas (closed 4-mode enum without "designated").
    const v160PolicySchema = z.object({
      mode: z.enum(["mentions", "parallel", "sequential", "independent"]),
      botOrder: z.array(idSchema).max(32).refine((ids) => new Set(ids).size === ids.length),
      maxRounds: z.number().int().min(1).max(5),
    }).strict();
    const v160SettingsSnapshotSchema = z.object({
      group: conversationSchema,
      policy: v160PolicySchema,
      revision: z.string().min(1).max(128),
    });
    const v160DiscussionViewSchema = z.object({
      settings: v160SettingsSnapshotSchema,
      run: groupDiscussionRunSchema.nullable(),
      viewRevision: z.string().min(1).max(260).optional(),
    });

    const { hub } = await startHub("macmini");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('alpha','Alpha','codex','h',1),('beta','Beta','claude','h',1)");
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "Compat Group", "g_compat", { type: "group" });
    const topic = await hub.store.createConversation("owner", [], "Compat Topic", "t_compat", { parentId: group.id });

    const initial = await hub.store.groupSettings("owner", group.id);
    await hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: group.botIds,
      expectedBotIds: group.botIds,
      policy: { ...initial.policy, mode: "designated" },
      expectedRevision: initial.revision,
    });
    await hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: "local:beta" });
    const realSettings = await hub.store.groupSettings("owner", group.id);
    expect(realSettings.policy.mode).toBe("designated");

    // 1. Direct HubStore contract mirrors parallelCapable: false
    await expect(hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "store_old_unmentioned",
      text: "no mention",
      attachments: [],
      designatedCapable: false,
    })).rejects.toThrow("group_designated_client_update_required");
    const storeExplicit = await hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "store_old_named",
      text: "@alpha please",
      attachments: [],
      mentions: ["alpha"],
      designatedCapable: false,
    });
    expect(await hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [storeExplicit.message.id])).toEqual([{ bot_id: "alpha" }]);

    // 2. Simulated 1.6.0 client (advertises 1.6.0 capabilities, NOT groups.cross-host.v1)
    const legacy = await openOwnerSession(hub, "dev_v160", ["cards.v1", "groups.discussion.v1", "groups.reply-guard.v1", "groups.parallel.v1"]);
    sockets.push(legacy.ws);
    const legacyHeaders = { Authorization: `Bearer ${legacy.token}`, "Content-Type": "application/json" };

    // GET /api/conversations/:id/discussion?brief=1 parses cleanly against 1.6.0 strict schema!
    const discRes = await fetch(`${hub.url}/api/conversations/${group.id}/discussion?brief=1`, { headers: legacyHeaders });
    expect(discRes.status).toBe(200);
    const parsedView = v160DiscussionViewSchema.parse(await discRes.json());
    expect(parsedView.settings.policy.mode).toBe("mentions");
    expect(parsedView.settings.revision).toBe(`${realSettings.revision}_compat`);
    expect(parsedView.viewRevision).toBeTruthy();

    // Conditional known= polling matches the downgraded viewRevision
    const unchangedRes = await fetch(
      `${hub.url}/api/conversations/${group.id}/discussion?brief=1&known=${encodeURIComponent(parsedView.viewRevision!)}`,
      { headers: legacyHeaders },
    );
    expect(await unchangedRes.json()).toEqual({ unchanged: true });

    // Topic discussion view ALSO downgrades cleanly for 1.6.0 clients
    const topicDiscRes = await fetch(`${hub.url}/api/conversations/${topic.id}/discussion?brief=1`, { headers: legacyHeaders });
    const parsedTopicView = v160DiscussionViewSchema.parse(await topicDiscRes.json());
    expect(parsedTopicView.settings.policy.mode).toBe("mentions");
    expect(parsedTopicView.settings.revision).toBe(`${realSettings.revision}_compat`);

    // GET /api/groups/:id/settings parses cleanly against 1.6.0 strict schema!
    const settingsRes = await fetch(`${hub.url}/api/groups/${group.id}/settings`, { headers: legacyHeaders });
    expect(settingsRes.status).toBe(200);
    const parsedSettings = v160SettingsSnapshotSchema.parse(await settingsRes.json());
    expect(parsedSettings.policy.mode).toBe("mentions");
    expect(parsedSettings.revision).toBe(`${realSettings.revision}_compat`);

    // PUT /api/groups/:id/settings from 1.6.0 echoing downgraded policy is rejected (cannot silently clobber designated!)
    const clobberRes = await fetch(`${hub.url}/api/groups/${group.id}/settings`, {
      method: "PUT",
      headers: legacyHeaders,
      body: JSON.stringify({
        title: "Renamed by 1.6.0",
        expectedTitle: group.title,
        botIds: group.botIds,
        expectedBotIds: group.botIds,
        policy: parsedSettings.policy,
        expectedRevision: parsedSettings.revision,
      }),
    });
    expect(clobberRes.status).toBe(409);
    expect((await clobberRes.json() as { error: string }).error).toBe("group_designated_client_update_required");
    expect((await hub.store.groupSettings("owner", group.id)).policy.mode).toBe("designated");

    // 1.6.0 WS send WITHOUT mentions (with 1.6.0 reply guard, even spoofing designatedCapable: true) -> rejected with update-required & human-readable message!
    legacy.ws.send(JSON.stringify({
      v: 1,
      type: "message.send",
      conversationId: group.id,
      clientMsgId: "v160_unmentioned",
      text: "unmentioned from 1.6.0",
      attachments: [],
      groupReplyGuard: { mode: "mentions", revision: parsedView.settings.revision },
      designatedCapable: true,
    }));
    const errFrame = await waitFor(
      () => legacy.frames.find((f) => f.type === "error" && f.requestId === "v160_unmentioned"),
      (f) => !!f,
    );
    expect(errFrame).toMatchObject({
      code: "group_designated_client_update_required",
      retryable: false,
    });
    expect(String(errFrame!.message)).toContain("更新 App");
    expect(await hub.store.db.get("SELECT COUNT(*) AS n FROM messages WHERE client_msg_id='v160_unmentioned'")).toEqual({ n: 0 });

    // 1.6.0 WS send WITH explicit @alpha (with 1.6.0 reply guard) -> succeeds on both root group and topic!
    legacy.ws.send(JSON.stringify({
      v: 1,
      type: "message.send",
      conversationId: topic.id,
      clientMsgId: "v160_topic_named",
      text: "@alpha in topic",
      attachments: [],
      mentions: ["alpha"],
      groupReplyGuard: { mode: "mentions", revision: parsedTopicView.settings.revision },
    }));
    const topicAck = await waitFor(
      () => legacy.frames.find((f) => f.type === "message.ack" && f.clientMsgId === "v160_topic_named"),
      (f) => !!f,
    );
    expect(await hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [topicAck!.messageId as string])).toEqual([{ bot_id: "alpha" }]);

    // Stale revision from 1.6.0 still triggers group_reply_mode_changed
    legacy.ws.send(JSON.stringify({
      v: 1,
      type: "message.send",
      conversationId: group.id,
      clientMsgId: "v160_stale",
      text: "@alpha stale",
      attachments: [],
      mentions: ["alpha"],
      groupReplyGuard: { mode: "mentions", revision: `${initial.revision}_compat` },
    }));
    const staleErr = await waitFor(
      () => legacy.frames.find((f) => f.type === "error" && f.requestId === "v160_stale"),
      (f) => !!f,
    );
    expect(staleErr).toMatchObject({ code: "group_reply_mode_changed", retryable: false });

    // 3. Modern client (with groups.cross-host.v1) receives raw "designated" and real revision
    const modern = await openOwnerSession(hub, "dev_modern", ["cards.v1", "groups.discussion.v1", "groups.reply-guard.v1", "groups.parallel.v1", CROSS_HOST_GROUPS_CAPABILITY]);
    sockets.push(modern.ws);
    const modernHeaders = { Authorization: `Bearer ${modern.token}`, "Content-Type": "application/json" };
    const modernView = await (await fetch(`${hub.url}/api/conversations/${group.id}/discussion?brief=1`, { headers: modernHeaders })).json() as { settings: { policy: { mode: string }; revision: string } };
    expect(modernView.settings.policy.mode).toBe("designated");
    expect(modernView.settings.revision).toBe(realSettings.revision);

    modern.ws.send(JSON.stringify({
      v: 1,
      type: "message.send",
      conversationId: group.id,
      clientMsgId: "modern_designated_send",
      text: "route to beta",
      attachments: [],
      groupReplyGuard: { mode: "designated", revision: modernView.settings.revision },
    }));
    const modernAck = await waitFor(
      () => modern.frames.find((f) => f.type === "message.ack" && f.clientMsgId === "modern_designated_send"),
      (f) => !!f,
    );
    expect(await hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [modernAck!.messageId as string])).toEqual([{ bot_id: "beta" }]);
  });

  it.each(["initial", "manual retry"] as const)("bounds group history on %s by wire bytes and preserves the full question", async mode => {
    const { a, b, group, post, addRemote } = await deliveryFixture();
    for (let i = 0; i < 186; i++) {
      await post(`old_${i}`, `old history ${i} ${"历史".repeat(1990)}`);
    }
    const recent = '最近的可见消息 "quoted"\nnext line';
    await post("last_visible", recent);
    const deleted = await post("last_deleted", "Deleted fixture");
    await a.hub.store.deleteMessages("owner", group.id, { messageIds: [deleted.message.id] });
    const remote = await addRemote("all");
    await post("after_join", "Post-join fixture");
    const prompt = "完整提问 " + '"\\\n汉'.repeat(14_000);
    const source = await post("current_question", prompt);

    const transport = a.hub.crossHostGroups["transport"];
    const payloads: string[] = [];
    a.hub.crossHostGroups.setTransport(async (peer, method, route, headers, body) => {
      if (route === "/api/group-mail/deliver" && body) {
        payloads.push(body);
        if (mode === "manual retry" && payloads.length === 1) throw new Error("ECONNREFUSED");
      }
      return transport(peer, method, route, headers, body);
    });
    const [initial] = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, source.message);
    const result = mode === "manual retry"
      ? await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, initial.id)
      : initial;

    expect(result.status).toBe("delivered");
    expect(payloads).toHaveLength(mode === "manual retry" ? 2 : 1);
    expect(Buffer.byteLength(payloads.at(-1)!)).toBeLessThanOrEqual(2 * MAX_FRAME_BYTES);
    const delivered = JSON.parse(payloads.at(-1)!) as { text: string; contextMessages: Array<{ text: string }> };
    expect(delivered.text).toBe(prompt);
    expect(delivered.contextMessages.at(-1)?.text).toBe(recent);
    const savedHistory = delivered.contextMessages.map(entry => entry.text);
    expect(savedHistory).not.toContain("Deleted fixture");
    expect(savedHistory).not.toContain("Post-join fixture");
    expect(savedHistory).not.toContain(prompt);
    expect(savedHistory.some(text => text.startsWith("old history 0 "))).toBe(false);
    const inbox = await b.hub.store.db.get<{ delivered_message_id: string }>("SELECT delivered_message_id FROM group_mail_inbox WHERE request_id=?", [result.requestId]);
    const row = await b.hub.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=? AND conversation_id=?", [inbox?.delivered_message_id, remote.sessionId]);
    const parsed = messageSchema.shape.blocks.parse(JSON.parse(row!.blocks_json));
    expect(blocksText(parsed)).toContain(recent);
    expect(blocksText(parsed).endsWith(prompt)).toBe(true);
    expect(Buffer.byteLength(blocksText(parsed))).toBeLessThanOrEqual(MAX_TEXT_BYTES);
  });

  it.each(["initial listener", "restart recovery", "stop during status check"] as const)(
    "does not auto-deliver stopped group questions (%s)",
    async mode => {
      const { a, b, group, addRemote } = await deliveryFixture();
      const remote = await addRemote();
      const queued = await a.hub.store.db.transaction(() => a.hub.store.sendMessageInTransaction("owner", {
        conversationId: group.id, clientMsgId: "pending_group_question", text: "Pending group question", attachments: [], mentions: [remote.memberKey],
      }));
      expect(queued.remoteDispatch?.questionIds).toHaveLength(1);
      const [id] = queued.remoteDispatch!.questionIds;
      let checkedStatus!: () => void;
      const statusStarted = new Promise<void>(resolve => { checkedStatus = resolve; });
      let resumeStatus!: () => void;
      const statusWait = new Promise<void>(resolve => { resumeStatus = resolve; });
      const transport = a.hub.crossHostGroups["transport"];
      const posts: string[] = [];
      const intercepted: typeof transport = async (peer, method, route, headers, body) => {
        if (route === "/api/group-mail/deliver") posts.push(body!);
        if (mode === "stop during status check" && method === "GET" && route.startsWith("/api/group-mail/status/")) {
          checkedStatus();
          await statusWait;
        }
        return transport(peer, method, route, headers, body);
      };
      a.hub.crossHostGroups.setTransport(intercepted);
      const sweeping = mode === "stop during status check" ? a.hub.crossHostGroups.recoverPendingQuestions({ includeRecent: true }) : undefined;
      if (sweeping) await statusStarted;
      try {
        const stop = await a.hub.crossHostGroups.stopGroup("owner", group.id);
        expect(stop.questions.find(q => q.id === id)?.stoppedUnanswered).toBe(true);
      } finally {
        resumeStatus();
      }
      let store = a.hub.store;
      let groups = a.hub.crossHostGroups;
      if (mode === "restart recovery") {
        await a.hub.close();
        hubs.splice(hubs.indexOf(a.hub), 1);
        store = await HubStore.open(a.stateDir);
      }

      try {
        if (sweeping) {
          await sweeping;
        } else if (mode === "initial listener") {
          await groups.deliverQueuedQuestions(queued.remoteDispatch!);
        } else {
          const auth = await HubAuth.open(store, a.stateDir);
          groups = new HubCrossHostGroups(store, auth, { transport: intercepted });
          groups.registerPeer({ hostId: "peer_b", hostName: "Receiver", publicKey: b.hub.auth.publicKey, url: b.hub.url });
          await groups.recoverPendingQuestions({ includeRecent: true });
        }
        expect(posts).toHaveLength(0);
        expect(await store.db.get("SELECT status, stopped_unanswered FROM group_remote_questions WHERE id=?", [id]))
          .toMatchObject({ status: "failed", stopped_unanswered: 1 });

        const retried = await groups.reconcileOrRetryQuestion("owner", group.id, id);
        expect(retried).toMatchObject({ status: "delivered" });
        expect(posts).toHaveLength(1);
      } finally {
        if (store !== a.hub.store) await store.db.close();
      }
    },
  );

  it("keeps group reconciliation retryable after status and reply failures without losing a late answer", async () => {
    const { a, b, group, addRemote, post } = await deliveryFixture();
    await addRemote();
    const source = await post("pending_answer", "Question already accepted by peer");
    const transport = a.hub.crossHostGroups["transport"];
    let posts = 0;
    let statusMode: "disconnect" | "unavailable" | "missing" | "stale delivered" | "normal" = "disconnect";
    a.hub.crossHostGroups.setTransport(async (peer, method, route, headers, body) => {
      if (route === "/api/group-mail/deliver") {
        posts++;
        await transport(peer, method, route, headers, body);
        throw new Error("ECONNRESET");
      }
      if (route.startsWith("/api/group-mail/status/")) {
        if (statusMode === "disconnect") throw new Error("ECONNREFUSED");
        if (statusMode === "unavailable") return { status: 502, json: {} };
        if (statusMode === "missing") return { status: 200, json: { found: false } };
        if (statusMode === "stale delivered") return { status: 200, json: { found: true, status: "delivered" } };
      }
      return transport(peer, method, route, headers, body);
    });
    const [question] = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, source.message);
    expect(question.status).toBe("uncertain");
    await a.hub.crossHostGroups.stopGroup("owner", group.id);
    const reconcile = () => a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, question.id);
    await expect(reconcile()).resolves.toMatchObject({ status: "uncertain", stoppedUnanswered: true });
    statusMode = "unavailable";
    await expect(reconcile()).resolves.toMatchObject({ status: "uncertain" });

    // The target durably answers while the origin callback and the first
    // local reply publication are unavailable.
    b.hub.crossHostGroups.setTransport(async () => { throw new Error("ECONNREFUSED"); });
    await b.hub.crossHostGroups.recordRemoteBotReply(question.requestId, "fixture_reply", "Late answer");
    statusMode = "normal";
    const publish = vi.spyOn(a.hub.store, "publishRemoteBotMessageInTransaction")
      .mockRejectedValueOnce(new Error("Synthetic reply storage failure"));
    try {
      await expect(reconcile()).resolves.toMatchObject({ status: "uncertain", stoppedUnanswered: true, error: "group_reply_pending" });
      statusMode = "stale delivered";
      await expect(reconcile()).resolves.toMatchObject({ status: "uncertain", error: "group_reply_pending" });
      statusMode = "missing";
      await expect(reconcile()).resolves.toMatchObject({ status: "uncertain", error: "group_reply_pending" });
      statusMode = "normal";
      const answered = await reconcile();
      expect(answered).toMatchObject({ status: "delivered", stoppedUnanswered: true, answerMessageId: expect.any(String) });
      await expect(reconcile()).resolves.toMatchObject({ answerMessageId: answered.answerMessageId });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(posts).toBe(1);
    } finally {
      publish.mockRestore();
    }
  });

  it("recovers interrupted 'sending' cross-host group questions on startup init() and periodic sweep idempotently without duplicates", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });

    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Local','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Remote','claude','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");

    const group = await a.hub.store.createConversation("owner", ["bot_local"], "Restart Recovery Group", "g_recover", { type: "group" });
    await a.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "pre_join_ctx", text: "PRE_JOIN_RECOVERY_CTX", attachments: [] });
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", group.id, {
      hostId: "peer_b",
      botId: "bot_remote",
      historyVisibility: { kind: "recent", count: 5 },
    });

    // Switch to parallel so store.sendMessage creates durable `sending` rows atomically
    const cur = await a.hub.store.groupSettings("owner", group.id);
    await a.hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: group.botIds,
      expectedBotIds: group.botIds,
      policy: { ...cur.policy, mode: "parallel" },
      expectedRevision: cur.revision,
    });

    // Case 1: Simulate Host A crashing mid-`sending` BEFORE delivery reached Hub B,
    // AND Case 2: Simulate Host A crashing mid-`sending` AFTER Hub B already accepted & answered `requestId`!
    const msgBeforeDeliver = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "crash_before_deliver_src",
      text: "Recover me across restart",
      attachments: [],
      mentions: ["bot_local"], // avoid auto-dispatching remote so we can seed exact pre-crash DB state
    });
    const reqBefore = "greq_restart_before_01";
    const qidBefore = "gq_restart_before_01";
    const now = Date.now();
    await a.hub.store.db.run(
      `INSERT INTO group_remote_questions(
        id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
        bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
      [qidBefore, group.id, group.id, remoteMember.memberKey, "peer_b", "studio-b", b.hub.auth.publicKey, "bot_remote", remoteMember.sessionId, "Remote", msgBeforeDeliver.message.id, reqBefore, now - 5_000, now - 5_000],
    );

    // Seed Case 2: Hub B already accepted & answered `reqAfter`, while Hub A's DB row was still stuck in `sending` at crash!
    const msgAfterAccept = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "crash_after_accept_src",
      text: "Already accepted on Hub B before Hub A crashed",
      attachments: [],
      mentions: ["bot_local"],
    });
    const reqAfter = "greq_restart_after_02";
    const qidAfter = "gq_restart_after_02";
    await a.hub.store.db.run(
      `INSERT INTO group_remote_questions(
        id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
        bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
      [qidAfter, group.id, group.id, remoteMember.memberKey, "peer_b", "studio-b", b.hub.auth.publicKey, "bot_remote", remoteMember.sessionId, "Remote", msgAfterAccept.message.id, reqAfter, now - 4_000, now - 4_000],
    );
    await b.hub.crossHostGroups.handlePeerDeliver(
      { hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url, allowLoopback: true, manualPeer: true },
      {
        requestId: reqAfter,
        groupId: group.id,
        groupTitle: group.title,
        conversationId: group.id,
        sourceHostId: "origin",
        sourceHostName: "macmini",
        sourceMessageId: msgAfterAccept.message.id,
        botId: "bot_remote",
        sessionId: remoteMember.sessionId,
        text: "Already accepted on Hub B before Hub A crashed",
        contextMessages: [],
      },
    );
    // Mark answered on Hub B without forwarding yet (Hub A was down!)
    await b.hub.store.db.run(
      "UPDATE group_mail_inbox SET reply_message_id='b_ans_2', reply_text='Recovered reply from Hub B', status='answered', answered_at=?, reply_forwarded=0, reply_next_at=? WHERE request_id=?",
      [now, now + 60_000, reqAfter],
    );

    // Shut down Hub A cleanly (simulating restart) and reopen store + auth + fresh HubCrossHostGroups on the SAME stateDir!
    const stateDirA = a.stateDir;
    await a.hub.close();
    hubs.splice(hubs.indexOf(a.hub), 1);

    const reopenedStore = await HubStore.open(stateDirA);
    try {
      const reopenedAuth = await HubAuth.open(reopenedStore, stateDirA);
      const reopenedGroups = new HubCrossHostGroups(reopenedStore, reopenedAuth, {
        localHostName: async () => "macmini",
      });
      reopenedGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
      // Startup recovery (run by HubServer.start in the background, after init) MUST recover BOTH persisted `sending` rows!
      await reopenedGroups.init();
      await reopenedGroups.recoverPendingQuestions({ includeRecent: true });

      const recoveredBefore = await reopenedStore.db.get<{ status: string; error: string | null }>(
        "SELECT status, error FROM group_remote_questions WHERE id=?",
        [qidBefore],
      );
      expect(recoveredBefore).toEqual({ status: "delivered", error: null });

      const recoveredAfter = await reopenedStore.db.get<{ status: string; error: string | null; answer_message_id: string | null }>(
        "SELECT status, error, answer_message_id FROM group_remote_questions WHERE id=?",
        [qidAfter],
      );
      expect(recoveredAfter?.status).toBe("delivered");
      expect(recoveredAfter?.error).toBeNull();
      expect(recoveredAfter?.answer_message_id).toBeTruthy();

      // Verify Hub B received `reqBefore` WITH join-time context, and `reqAfter` was NOT duplicated!
      const bSessionMsgs = await b.hub.store.db.all<{ client_msg_id: string | null; blocks_json: string }>(
        "SELECT client_msg_id, blocks_json FROM messages WHERE conversation_id=?",
        [remoteMember.sessionId],
      );
      const beforeDelivered = bSessionMsgs.filter((m) => m.client_msg_id === `gmail_${reqBefore}`);
      expect(beforeDelivered).toHaveLength(1);
      expect(JSON.parse(beforeDelivered[0]!.blocks_json)[0].text).toContain("PRE_JOIN_RECOVERY_CTX");
      expect(bSessionMsgs.filter((m) => m.client_msg_id === `gmail_${reqAfter}`)).toHaveLength(1);

      // Verify Hub A's group chat received the recovered answer for `reqAfter`
      const aGroupMsgs = await reopenedStore.db.all<{ blocks_json: string }>(
        "SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL",
        [group.id],
      );
      expect(aGroupMsgs.some((m) => JSON.parse(m.blocks_json)[0]?.text === "Recovered reply from Hub B")).toBe(true);

      // Verify history_backfilled was set to 1
      const memberRow = await reopenedStore.db.get<{ history_backfilled: number }>(
        "SELECT history_backfilled FROM group_session_members WHERE conversation_id=? AND member_key=? AND active=1",
        [group.id, remoteMember.memberKey],
      );
      expect(memberRow?.history_backfilled).toBe(1);
    } finally {
      await reopenedStore.db.close();
    }

    // Case 3: Real HubServer.start() restart when peer is offline/unavailable transitions persisted `sending` -> `failed` (never stuck!),
    // and live HubServer sweep recovers an orphaned `sending` row once peer is registered, with concurrent deduplication!
    const reopenedHub = await startHub("macmini", stateDirA);
    reopenedHub.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: reopenedHub.hub.auth.publicKey, url: reopenedHub.hub.url });

    // Seed an orphaned `sending` row older than sweep grace period (as if in-memory listener was missed)
    const msgSweep = await reopenedHub.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "sweep_orphan_src",
      text: "Orphaned sending row for sweep",
      attachments: [],
      mentions: ["bot_local"],
    });
    const reqSweep = "greq_sweep_orphan_03";
    const qidSweep = "gq_sweep_orphan_03";
    await reopenedHub.hub.store.db.run(
      `INSERT INTO group_remote_questions(
        id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
        bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
      [qidSweep, group.id, group.id, remoteMember.memberKey, "peer_b", "studio-b", b.hub.auth.publicKey, "bot_remote", remoteMember.sessionId, "Remote", msgSweep.message.id, reqSweep, Date.now() - 5_000, Date.now() - 5_000],
    );

    // Wait for HubServer's periodic sweep() to recover the orphaned `sending` row automatically!
    const sweptRow = await waitFor(
      async () => reopenedHub.hub.store.db.get<{ status: string }>(
        "SELECT status FROM group_remote_questions WHERE id=?",
        [qidSweep],
      ),
      (row) => row?.status === "delivered",
    );
    expect(sweptRow?.status).toBe("delivered");
    const sweepInboxRows = await b.hub.store.db.all<{ request_id: string }>(
      "SELECT request_id FROM group_mail_inbox WHERE request_id=?",
      [reqSweep],
    );
    expect(sweepInboxRows).toHaveLength(1);

    // Case 4: Real HubServer.start() restart while peer is offline/unregistered moves `sending` -> `failed` (retryable, never stuck)
    const msgOffline = await reopenedHub.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "restart_offline_src",
      text: "Restart while peer unreachable",
      attachments: [],
      mentions: ["bot_local"],
    });
    const reqOffline = "greq_restart_offline_04";
    const qidOffline = "gq_restart_offline_04";
    await reopenedHub.hub.store.db.run(
      `INSERT INTO group_remote_questions(
        id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
        bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
      [qidOffline, group.id, group.id, remoteMember.memberKey, "peer_b", "studio-b", b.hub.auth.publicKey, "bot_remote", remoteMember.sessionId, "Remote", msgOffline.message.id, reqOffline, Date.now() - 5_000, Date.now() - 5_000],
    );
    await reopenedHub.hub.close();
    hubs.splice(hubs.indexOf(reopenedHub.hub), 1);

    const restartedOffline = await startHub("macmini", stateDirA);
    // Startup recovery runs in the background after start() resolves.
    const offlineRow = await waitFor(
      async () => restartedOffline.hub.store.db.get<{ status: string; error: string | null }>(
        "SELECT status, error FROM group_remote_questions WHERE id=?",
        [qidOffline],
      ),
      (row) => row?.status !== "sending",
    );
    expect(offlineRow?.status).toBe("failed");
    expect(offlineRow?.error).toContain("studio-b");
    // Once peer is registered again, retry succeeds!
    restartedOffline.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    const retried = await restartedOffline.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, qidOffline);
    expect(retried.status).toBe("delivered");
  }, 20_000);

  it("starts without waiting for cross-host question recovery, re-drives the question afterwards, and stops cleanly mid-recovery", async () => {
    const a = await startHub("macmini");
    const b = await startHub("studio-b");
    a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
    b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Local','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Remote','claude','h',1)");
    await b.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "bot_remote");
    const group = await a.hub.store.createConversation("owner", ["bot_local"], "Background Recovery", "g_bg_recover", { type: "group" });
    const member = await a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "peer_b", botId: "bot_remote", historyVisibility: { kind: "none" } });
    const source = await a.hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "bg_src", text: "Recover me in the background", attachments: [], mentions: ["bot_local"] });
    // updated_at in the future: only the startup recovery (includeRecent) picks it, never the regular sweep's grace window.
    const qid = "gq_bg_recover_01", future = Date.now() + 10 * 60_000;
    await a.hub.store.db.run(
      `INSERT INTO group_remote_questions(
        id, group_id, conversation_id, member_key, host_id, host_name, host_public_key, bot_id, session_id,
        bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
      [qid, group.id, group.id, member.memberKey, "peer_b", "studio-b", b.hub.auth.publicKey, "bot_remote", member.sessionId, "Remote", source.message.id, "greq_bg_recover_01", future, future],
    );
    const stateDirA = a.stateDir;
    await a.hub.close();
    hubs.splice(hubs.indexOf(a.hub), 1);

    // A peer that never answers is modelled by holding every recovery call until the test releases it
    // (the real peer timeout is 10 s and this file has no fake clock).
    const original = HubCrossHostGroups.prototype.recoverPendingQuestions;
    let release!: () => void;
    let gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<Promise<unknown>> = [];
    HubCrossHostGroups.prototype.recoverPendingQuestions = function (this: HubCrossHostGroups, ...args) {
      const run = gate.then(() => original.apply(this, args));
      calls.push(run);
      return run;
    };
    try {
      // 1. Stop during recovery: close() resolves, the held recovery then does no work, the row is untouched.
      const first = await startHub("macmini", stateDirA);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const closing = first.hub.close();
      hubs.splice(hubs.indexOf(first.hub), 1);
      release();
      await closing;
      expect(await Promise.all(calls)).toEqual(calls.map(() => []));
      const afterStop = await HubStore.open(stateDirA);
      try {
        expect(await afterStop.db.get("SELECT status FROM group_remote_questions WHERE id=?", [qid])).toEqual({ status: "sending" });
      } finally { await afterStop.db.close(); }

      // 2. start() resolves while recovery is still held; the question is re-driven afterwards.
      gate = new Promise<void>((resolve) => { release = resolve; });
      calls.length = 0;
      const second = await startHub("macmini", stateDirA);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(await second.hub.store.db.get("SELECT status FROM group_remote_questions WHERE id=?", [qid])).toEqual({ status: "sending" });
      second.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
      b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: second.hub.auth.publicKey, url: second.hub.url });
      release();
      const delivered = await waitFor(
        async () => second.hub.store.db.get<{ status: string }>("SELECT status FROM group_remote_questions WHERE id=?", [qid]),
        (row) => row?.status === "delivered",
      );
      expect(delivered?.status).toBe("delivered");
    } finally {
      HubCrossHostGroups.prototype.recoverPendingQuestions = original;
      release();
    }
  });

  it("runs session-bound group messages in the member's single-chat saved workspace folder when it differs from the group conversation's workspace folder", async () => {
    const { hub } = await startHub("macmini");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "tb-group-ws-"));
    dirs.push(root);
    const bot1Dir = path.join(root, "bot1-state");
    const bot2Dir = path.join(root, "bot2-state");
    const wsDefault = path.join(root, "ws-default");
    const wsSession = path.join(root, "ws-session");
    const wsGroup = path.join(root, "ws-group");
    await Promise.all([
      fs.mkdir(bot1Dir, { recursive: true }),
      fs.mkdir(bot2Dir, { recursive: true }),
      fs.mkdir(wsDefault, { recursive: true }),
      fs.mkdir(wsSession, { recursive: true }),
      fs.mkdir(wsGroup, { recursive: true }),
    ]);
    await fs.writeFile(path.join(bot1Dir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: wsDefault }, null, 2));
    await fs.writeFile(path.join(bot2Dir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: wsDefault }, null, 2));

    const secret1 = randomBytes(24).toString("base64url");
    const secret2 = randomBytes(24).toString("base64url");
    await hub.store.db.run(
      "INSERT INTO bots(id,name,engine,secret_hash,online,workspace_path) VALUES('bot_bound','Bound Bot','codex',?,0,?),('bot_plain','Plain Bot','codex',?,0,?)",
      [hashSecret(secret1), wsDefault, hashSecret(secret2), wsDefault],
    );

    const boundCalls: Array<{ conversationKey?: string; workspaceOverride?: string; text: string }> = [];
    const plainCalls: Array<{ conversationKey?: string; workspaceOverride?: string; text: string }> = [];
    const makeBridge = (calls: typeof boundCalls): CoreBridgeLike => ({
      checkAccess: async () => ({ kind: "allow" }),
      handleAuthorizedMessage: async (input) => {
        calls.push({ conversationKey: input.conversationKey, workspaceOverride: input.workspaceOverride, text: input.text });
        return { text: `ok:${path.basename(input.workspaceOverride ?? "")}` };
      },
    });

    const instanceWsUrl = `${(hub.instanceUrl || hub.url).replace(/^http/, "ws")}/instance`;
    const gw1 = await attachGateway({
      url: instanceWsUrl,
      botId: "bot_bound",
      secret: secret1,
      stateDir: bot1Dir,
      engine: "codex",
      bridge: makeBridge(boundCalls),
      runtime: createCoreServiceRuntime(),
      recoverDeliveries: false,
    });
    gateways.push(gw1);
    const gw2 = await attachGateway({
      url: instanceWsUrl,
      botId: "bot_plain",
      secret: secret2,
      stateDir: bot2Dir,
      engine: "codex",
      bridge: makeBridge(plainCalls),
      runtime: createCoreServiceRuntime(),
      recoverDeliveries: false,
    });
    gateways.push(gw2);

    await waitFor(
      async () => await hub.store.bots("owner"),
      (bots) => bots.find((b) => b.id === "bot_bound")?.online === 1 && bots.find((b) => b.id === "bot_plain")?.online === 1,
    );

    // 1. Create single-chat session pinned to wsSession, and an unpinned single-chat session (uses bot default wsDefault).
    const pinnedDirect = await hub.store.createConversation("owner", ["bot_bound"], "Bound Session Chat", "dir_pinned", {
      type: "direct",
      workspacePath: wsSession,
    });
    const unpinnedDirect = await hub.store.createConversation("owner", ["bot_bound"], "Default Workspace Chat", "dir_unpinned", {
      type: "direct",
    });

    // 2. Create group conversation pinned to a DIFFERENT folder (wsGroup).
    const group = await hub.store.createConversation("owner", ["bot_plain"], "Group With Own Folder", "grp_ws", {
      type: "group",
      workspacePath: wsGroup,
    });
    expect(group.workspacePath).toBe(wsGroup);

    // Seed a stale group-level resume entry in bot_bound's session.json pointing at wsGroup
    // to prove the bound single-chat session's saved workspace STILL wins over stale group state!
    const bot1Sessions = new SessionStore(path.join(bot1Dir, "session.json"));
    await bot1Sessions.upsert({
      telegramChatId: 1001,
      conversationKey: buildCoreConversationKey(group.id),
      codexSessionId: "stale-group-thread",
      resume: { sessionId: "stale-group-thread", workspacePath: wsGroup, dirName: "ws-group" },
      status: "idle",
      updatedAt: new Date().toISOString(),
    });

    // 3. Join bot_bound to the group bound to pinnedDirect (whose saved workspace is wsSession != wsGroup).
    await hub.crossHostGroups.addMember("owner", group.id, {
      botId: "bot_bound",
      sessionId: pinnedDirect.id,
      historyVisibility: { kind: "none" },
    });

    // Send group message mentioning @bot_bound -> MUST run in wsSession (NOT wsGroup!) under pinnedDirect's session key!
    await hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "grp_ws_bound_1",
      text: "@bot_bound check bound workspace",
      attachments: [],
      mentions: ["bot_bound"],
    });
    await waitFor(() => boundCalls.length, (n) => n >= 1);
    expect(boundCalls[0]).toMatchObject({
      conversationKey: buildCoreConversationKey(pinnedDirect.id),
      workspaceOverride: wsSession,
    });

    // 4. Switch bot_bound's group session to unpinnedDirect (no pinned workspace -> Bot's default wsDefault != wsGroup).
    await hub.crossHostGroups.switchMemberSession("owner", group.id, "local:bot_bound", {
      sessionId: unpinnedDirect.id,
    });
    await hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "grp_ws_unpinned_2",
      text: "@bot_bound check unpinned single-chat workspace",
      attachments: [],
      mentions: ["bot_bound"],
    });
    await waitFor(() => boundCalls.length, (n) => n >= 2);
    expect(boundCalls[1]).toMatchObject({
      conversationKey: buildCoreConversationKey(unpinnedDirect.id),
      workspaceOverride: wsDefault,
    });

    // 5. Ordinary non-session-bound Bot (bot_plain) in the same group STILL uses the group's workspace folder (wsGroup).
    await hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "grp_ws_plain_3",
      text: "@bot_plain check group workspace",
      attachments: [],
      mentions: ["bot_plain"],
    });
    await waitFor(() => plainCalls.length, (n) => n >= 1);
    expect(plainCalls[0]).toMatchObject({
      conversationKey: buildCoreConversationKey(group.id),
      workspaceOverride: wsGroup,
    });
  }, 20_000);
  it("routes scoped mentions to exactly one host and session despite identical Bot IDs and names", async () => {
    const a = await startHub("example-a");
    const b = await startHub("example-b");
    const c = await startHub("example-c");
    for (const { hub } of [a, b, c]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('shared_bot','Example Bot','fixture',1)");
    }
    await a.hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('other_bot','Other Bot','fixture')");
    await b.hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('ungranted','Private Bot','fixture')");
    for (const [hostId, peer] of [["example_b", b], ["example_c", c]] as const) {
      a.hub.crossHostGroups.registerPeer({ hostId, hostName: hostId, publicKey: peer.hub.auth.publicKey, url: peer.hub.url });
      peer.hub.crossHostGroups.registerPeer({ hostId: "example_a", hostName: "example-a", publicKey: a.hub.auth.publicKey, url: a.hub.url });
      await peer.hub.crossHostGroups.grantPeerBot(a.hub.auth.publicKey, "shared_bot");
    }
    const group = await a.hub.store.createConversation("owner", ["shared_bot", "other_bot"], "Example group", "example_group", { type: "group" });
    const other = await a.hub.store.createConversation("owner", ["other_bot"], "Another group", "example_other_group", { type: "group" });
    const topic = await a.hub.store.createConversation("owner", [], "Example topic", "example_topic", { parentId: group.id });
    const { room: emptyRoom } = await a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Local-only room" });
    const memberB = await a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "example_b", botId: "shared_bot" });
    const { room, memberSessions } = await a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Cross-host room" });
    const roomSession = memberSessions.find(member => member.memberKey === memberB.memberKey)!.sessionId;
    expect(roomSession).not.toBe(memberB.sessionId);
    const memberC = await a.hub.crossHostGroups.addMember("owner", group.id, { hostId: "example_c", botId: "shared_bot" });
    const owner = await openOwnerSession(a.hub, "dev_roster");
    sockets.push(owner.ws);
    const send = (id: string, mentions: string[], conversationId = group.id, groupReplyGuard?: GroupReplyGuard, text = "Example question") =>
      owner.ws.send(JSON.stringify({ v: 1, type: "message.send", clientMsgId: id, conversationId, text, attachments: [], mentions, groupReplyGuard }));
    const ack = (id: string) => waitFor(() => owner.frames.find(f => f.clientMsgId === id || f.type === "error" && (f.requestId === id || !f.requestId)), Boolean);
    const rejected = (id: string) => waitFor(() => owner.frames.find(f => f.requestId === id && f.type === "error"), Boolean);

    send("example_route_b", [memberB.memberKey]);
    const accepted = await ack("example_route_b");
    expect(accepted?.type).toBe("message.ack");
    const inbox = (hub: HubServer) => hub.store.db.all("SELECT bot_id, session_id FROM group_mail_inbox");
    await waitFor(() => inbox(b.hub), rows => rows.length > 0);
    expect(await inbox(b.hub)).toEqual([{ bot_id: "shared_bot", session_id: memberB.sessionId }]);
    expect(await inbox(c.hub)).toEqual([]);
    expect(await a.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [accepted!.messageId])).toEqual([]);

    const headers = { Authorization: `Bearer ${owner.token}` };
    const rosterResponse = await fetch(`${a.hub.url}/api/conversations/${group.id}/discussion?brief=1`, { headers });
    expect(rosterResponse.status).toBe(200);
    const view = groupDiscussionViewSchema.parse(await rosterResponse.json());
    const snapshot = await a.hub.store.snapshot("owner", group.id);
    expect(snapshot.messages.find(message => message.id === accepted!.messageId)?.groupRecipientKeys).toEqual([memberB.memberKey]);
    expect(view.remoteMembers).toEqual([
      { memberKey: memberB.memberKey, name: "Example Bot", hostName: "example-b" },
      { memberKey: memberC.memberKey, name: "Example Bot", hostName: "example-c" },
    ]);
    const readMemberView = (conversationId: string) => a.hub.groupDiscussions.view("owner", conversationId);
    for (const conversation of [group, room, topic, emptyRoom]) {
      await expect(a.hub.groupDiscussions.view("non_member", conversation.id)).rejects.toThrow("conversation_forbidden");
    }
    expect((await readMemberView(other.id)).remoteMembers).toEqual([]);
    const roomView = await readMemberView(room.id);
    const topicView = await readMemberView(topic.id);
    const emptyView = await readMemberView(emptyRoom.id);
    expect.soft(roomView.remoteMembers).toEqual([view.remoteMembers![0]]);
    expect.soft(topicView.remoteMembers).toEqual(view.remoteMembers);
    expect.soft(emptyView.remoteMembers).toEqual([]);
    const guard = { mode: "mentions", revision: roomView.settings.revision } as const;

    const roomOptions = groupRecipientOptions(room.botIds, [], new Map([["shared_bot", "Example Bot"]]), "example-a", roomView.remoteMembers);
    const selected = roomOptions.find(option => option.id === memberB.memberKey)!;
    const draft = insertScopedGroupMention("@Example", selected) + "Room question";
    const addressed = groupMentions(draft, roomOptions.map(option => ({ id: option.id, names: [option.name, option.botId] })));
    expect(addressed).toEqual({ ids: [memberB.memberKey], unresolved: [] });
    send("example_room_route", addressed.ids, room.id, guard, draft);
    const roomAck = await ack("example_room_route");
    expect(roomAck?.type).toBe("message.ack");
    send("example_topic_route", [memberB.memberKey], topic.id, guard);
    const topicAck = await ack("example_topic_route");
    expect(topicAck?.type).toBe("message.ack");
    const roomMessage = (await a.hub.store.snapshot("owner", room.id)).messages.find(message => message.id === roomAck!.messageId);
    const topicMessage = (await a.hub.store.snapshot("owner", topic.id)).messages.find(message => message.id === topicAck!.messageId);
    expect(roomMessage?.blocks).toEqual([{ type: "text", text: `@${memberB.memberKey} Room question` }]);
    expect((await a.hub.store.snapshot("owner", group.id)).messages.map(message => message.id)).toEqual([accepted!.messageId]);
    for (const message of [roomMessage, topicMessage]) {
      expect(message?.groupRecipientKeys).toEqual([memberB.memberKey]);
      expect(await a.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [message!.id])).toEqual([]);
    }
    const routedInbox = (hub: HubServer) => hub.store.db.all(
      "SELECT conversation_id, session_id FROM group_mail_inbox ORDER BY conversation_id",
    );
    expect(await waitFor(() => routedInbox(b.hub), rows => rows.length === 3)).toEqual(expect.arrayContaining([
      { conversation_id: group.id, session_id: memberB.sessionId },
      { conversation_id: room.id, session_id: roomSession },
      { conversation_id: topic.id, session_id: memberB.sessionId },
    ]));
    expect(await routedInbox(c.hub)).toEqual([]);

    send("example_other_group_route", [memberB.memberKey], other.id);
    expect((await rejected("example_other_group_route"))?.code).toBe("mention_forbidden");
    send("example_room_root_only", [memberC.memberKey], room.id, guard);
    expect((await rejected("example_room_root_only"))?.code).toBe("mention_forbidden");
    send("example_empty_room_route", [memberB.memberKey], emptyRoom.id, guard);
    expect((await rejected("example_empty_room_route"))?.code).toBe("mention_forbidden");
    send("example_room_ungranted", ["remote:example_b:ungranted"], room.id, guard);
    expect((await rejected("example_room_ungranted"))?.code).toBe("mention_forbidden");
    expect((await a.hub.store.snapshot("owner", emptyRoom.id)).messages).toEqual([]);
    send("example_ungranted_route", ["remote:example_b:ungranted"]);
    expect((await rejected("example_ungranted_route"))?.code).toBe("mention_forbidden");

    send("example_legacy_bare_id", ["shared_bot"]);
    const legacyLocal = await ack("example_legacy_bare_id");
    expect(legacyLocal?.type).toBe("message.ack");
    expect(await a.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [legacyLocal!.messageId])).toEqual([{ bot_id: "shared_bot" }]);
    for (const hostId of ["example_b", "example_c"]) {
      await a.hub.crossHostGroups.addMember("owner", other.id, { hostId, botId: "shared_bot" });
    }
    send("example_ambiguous_remote_id", ["shared_bot"], other.id);
    expect((await rejected("example_ambiguous_remote_id"))?.code).toBe("mention_forbidden");
    send("example_local_id", ["local:shared_bot"]);
    const local = await ack("example_local_id");
    expect(local?.type).toBe("message.ack");
    expect(await a.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [local!.messageId])).toEqual([{ bot_id: "shared_bot" }]);

    send("example_route_c", [memberC.memberKey, memberC.memberKey]);
    expect((await ack("example_route_c"))?.type).toBe("message.ack");
    await waitFor(() => inbox(c.hub), rows => rows.length > 0);
    expect(await inbox(c.hub)).toEqual([{ bot_id: "shared_bot", session_id: memberC.sessionId }]);
    expect(await inbox(b.hub)).toHaveLength(3);

    send("example_legacy_local_route", ["shared_bot"], topic.id, guard);
    const localTopic = await ack("example_legacy_local_route");
    expect(localTopic?.type).toBe("message.ack");
    expect(await a.hub.store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [localTopic!.messageId])).toEqual([{ bot_id: "shared_bot" }]);

    const question = (await a.hub.crossHostGroups.getState("owner", group.id, false)).questions.find(q => q.sourceMessageId === roomAck!.messageId)!;
    const peer = { hostId: "example_b", hostName: "example-b", publicKey: b.hub.auth.publicKey, url: b.hub.url };
    const reply = {
      requestId: question.requestId, groupId: group.id, conversationId: room.id,
      botId: memberB.botId, sessionId: roomSession, text: "Room answer",
    };
    await expect(a.hub.crossHostGroups.handlePeerReply(peer, { ...reply, conversationId: topic.id }))
      .rejects.toThrow("group_question_identity_mismatch");
    await expect(a.hub.crossHostGroups.handlePeerReply(peer, { ...reply, sessionId: memberB.sessionId }))
      .rejects.toThrow("group_question_identity_mismatch");
    const roomReply = await a.hub.crossHostGroups.handlePeerReply(peer, reply);
    for (const outside of [group, topic, emptyRoom, other]) {
      expect((await a.hub.store.snapshot("owner", outside.id)).messages.some(message => message.id === roomReply.messageId)).toBe(false);
    }

    const removed = await fetch(`${a.hub.url}/api/groups/${group.id}/members/${encodeURIComponent(memberB.memberKey)}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    const after = await a.hub.groupDiscussions.read("owner", group.id, undefined, { known: view.viewRevision });
    expect(after).toHaveProperty("remoteMembers", [{ memberKey: memberC.memberKey, name: "Example Bot", hostName: "example-c" }]);
    await waitFor(() => owner.frames.some(frame => frame.type === "event" && frame.kind === "turn.state"
      && frame.conversationId === group.id && (frame.payload as { groupSettings?: object })?.groupSettings), Boolean);
    const refresh = (conversationId: string, known: string | undefined) => a.hub.groupDiscussions.read("owner", conversationId, undefined, { known });
    expect(await refresh(room.id, roomView.viewRevision)).toHaveProperty("remoteMembers", []);
    expect(await refresh(topic.id, topicView.viewRevision)).toHaveProperty("remoteMembers", [view.remoteMembers![1]]);
    expect(await refresh(emptyRoom.id, emptyView.viewRevision)).toEqual({ unchanged: true });
    send("example_room_removed", [memberB.memberKey], room.id, guard);
    expect((await rejected("example_room_removed"))?.code).toBe("mention_forbidden");
    expect((await a.hub.store.snapshot("owner", room.id)).messages.map(message => message.id)).toEqual([roomAck!.messageId, roomReply.messageId]);
    send("example_removed_route", [memberB.memberKey]);
    expect((await rejected("example_removed_route"))?.code).toBe("mention_forbidden");

    const settings = await a.hub.store.groupSettings("owner", group.id);
    await a.hub.store.updateGroup("owner", group.id, {
      title: group.title, expectedTitle: group.title, botIds: group.botIds, expectedBotIds: group.botIds,
      policy: { ...settings.policy, mode: "sequential" }, expectedRevision: settings.revision,
    });
    send("example_discussion_route", [memberC.memberKey]);
    expect((await rejected("example_discussion_route"))?.code).toBe("mention_forbidden");
    send("example_stale_room_guard", [memberB.memberKey], room.id, guard);
    expect((await rejected("example_stale_room_guard"))?.code).toBe("group_reply_mode_changed");

    expect(await inbox(b.hub)).toHaveLength(3);
    expect(await inbox(c.hub)).toHaveLength(1);
  }, 20_000);
  it("resends the recorded local or remote group recipient without reinterpreting its Bot ID", async () => {
    const local = await startHub("example-owner");
    const remote = await startHub("example-peer");
    for (const { hub } of [local, remote]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('shared_bot','Example Bot','fixture',1)");
    }
    local.hub.crossHostGroups.registerPeer({ hostId: "example_peer", hostName: "Example peer", publicKey: remote.hub.auth.publicKey, url: remote.hub.url });
    remote.hub.crossHostGroups.registerPeer({ hostId: "example_owner", hostName: "Example owner", publicKey: local.hub.auth.publicKey, url: local.hub.url });
    await remote.hub.crossHostGroups.grantPeerBot(local.hub.auth.publicKey, "shared_bot");
    const group = await local.hub.store.createConversation("owner", ["shared_bot"], "Retry example", "retry_group", { type: "group" });
    const member = await local.hub.crossHostGroups.addMember("owner", group.id, { hostId: "example_peer", botId: "shared_bot" });
    const store = local.hub.store;
    const settings = await store.groupSettings("owner", group.id);
    await store.updateGroup("owner", group.id, {
      title: group.title, expectedTitle: group.title, botIds: group.botIds, expectedBotIds: group.botIds,
      policy: { ...settings.policy, mode: "designated" }, expectedRevision: settings.revision,
    });
    await local.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: "local:shared_bot" });
    const owner = await openOwnerSession(local.hub, "dev_retry");
    sockets.push(owner.ws);
    const request = (clientMsgId: string, extra: object = {}) => ({
      v: 1, type: "message.send", clientMsgId, conversationId: group.id, text: "Example question", attachments: [], ...extra,
    });
    const send = async (id: string, extra?: object) => {
      owner.ws.send(JSON.stringify(request(id, extra)));
      return waitFor(() => owner.frames.find(frame => frame.clientMsgId === id || frame.requestId === id), Boolean);
    };
    const localTargets = (id: unknown) => store.db.all("SELECT bot_id FROM deliveries WHERE message_id=?", [id]);
    const remoteTargets = (id: unknown) => store.db.all("SELECT member_key FROM group_remote_questions WHERE conversation_id=? AND source_message_id=?", [group.id, id]);
    const initial = await send("designated_original");
    expect(initial?.type).toBe("message.ack");
    expect(await localTargets(initial!.messageId)).toEqual([{ bot_id: "shared_bot" }]);
    expect.soft((await store.messageForUser("owner", String(initial!.messageId))).groupRecipientKeys).toEqual(["local:shared_bot"]);

    const legacy = await openOwnerSession(local.hub, "dev_legacy_retry", []);
    sockets.push(legacy.ws);
    legacy.ws.send(JSON.stringify(request("legacy_original", { mentions: ["shared_bot"] })));
    const bare = await waitFor(() => legacy.frames.find(frame => frame.clientMsgId === "legacy_original" || frame.requestId === "legacy_original"), Boolean);
    expect.soft(bare?.type).toBe("message.ack");
    if (bare?.type === "message.ack") {
      expect(await localTargets(bare.messageId)).toEqual([{ bot_id: "shared_bot" }]);
      expect(await remoteTargets(bare.messageId)).toEqual([]);
    }
    const originalRemote = await send("remote_original", { mentions: [member.memberKey] });
    expect(originalRemote?.type).toBe("message.ack");
    await store.db.run("UPDATE messages SET group_recipient_keys_json=NULL WHERE id IN (?,?)", [initial!.messageId, originalRemote!.messageId]);
    await local.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: member.memberKey });

    const localRetry = await send("retry_local", { retryOf: initial!.messageId });
    expect.soft(localRetry?.type).toBe("message.ack");
    expect.soft(await localTargets(localRetry?.messageId ?? "")).toEqual([{ bot_id: "shared_bot" }]);
    expect.soft(await remoteTargets(localRetry?.messageId ?? "")).toEqual([]);

    const remoteRetry = await send("retry_remote", { retryOf: originalRemote!.messageId });
    expect(remoteRetry?.type).toBe("message.ack");
    expect(await localTargets(remoteRetry!.messageId)).toEqual([]);
    expect(await remoteTargets(remoteRetry!.messageId)).toEqual([{ member_key: member.memberKey }]);
    const inbound = () => remote.hub.store.db.all("SELECT session_id FROM group_mail_inbox");
    expect(await waitFor(inbound, rows => rows.length >= 2)).toEqual([{ session_id: member.sessionId }, { session_id: member.sessionId }]);

    const forward = (id: string, sourceMessageId: unknown, mentions?: string[]) =>
      send(id, { type: "message.forward", sourceMessageId, mentions });
    const forwarded = await forward("forward_original", initial!.messageId, ["shared_bot"]);
    expect(forwarded?.type).toBe("message.ack");
    const forwardedAgain = await forward("forward_retry", forwarded!.messageId, ["shared_bot"]);
    expect(forwardedAgain?.type).toBe("message.ack");
    for (const frame of [forwarded!, forwardedAgain!]) {
      expect((await store.messageForUser("owner", String(frame.messageId))).groupRecipientKeys).toEqual(["local:shared_bot"]);
      expect(await localTargets(frame.messageId)).toEqual([{ bot_id: "shared_bot" }]);
      expect(await remoteTargets(frame.messageId)).toEqual([]);
    }
    const saved = await forward("forward_record_only", initial!.messageId);
    expect(saved?.type).toBe("message.ack");
    expect(await localTargets(saved!.messageId)).toEqual([]);
    expect(await remoteTargets(saved!.messageId)).toEqual([]);

    const narrowed = await send("retry_specific_local", { retryOf: initial!.messageId, mentions: ["local:shared_bot"] });
    expect(narrowed?.type).toBe("message.ack");
    expect(await localTargets(narrowed!.messageId)).toEqual([{ bot_id: "shared_bot" }]);
    expect(await send("retry_different_recipient", { retryOf: initial!.messageId, mentions: [member.memberKey] }))
      .toMatchObject({ type: "error", code: "mention_forbidden" });

    await local.hub.crossHostGroups.removeMember("owner", group.id, member.memberKey);
    await local.hub.crossHostGroups.setDesignatedMember("owner", group.id, { memberKey: "local:shared_bot" });
    expect.soft(await send("retry_removed", { retryOf: originalRemote!.messageId })).toMatchObject({ type: "error", code: "mention_forbidden" });

    await store.db.run("DELETE FROM deliveries WHERE message_id=?", [initial!.messageId]);
    expect.soft(await send("retry_unknown", { retryOf: initial!.messageId })).toMatchObject({ type: "error", code: "group_retry_recipients_unknown" });
    expect(await inbound()).toHaveLength(2);
  }, 20_000);

});
