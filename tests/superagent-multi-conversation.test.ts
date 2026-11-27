import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";
import type { Conversation } from "../src/client-protocol/index.js";

describe("Superagent multiple conversations, groups, and Bot messages (#122)", () => {
  let root: string;
  let hub: HubServer;
  let firstChat: Conversation;
  const owner = { kind: "owner" as const, userId: "owner" };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "superagent-multi-"));
    hub = await HubServer.start({ stateDir: root });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role,online) VALUES('super','Superagent','fixture','claude','','','dispatcher',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,online) VALUES('helper','Helper','fixture','codex','','',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role,online) VALUES('w_codex','Superagent · codex','fixture','codex','','','worker',1)");
    hub.dispatch.workers = {
      catalog: async () => ({ engines: [{ id: "codex", available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" }] }),
      dispatchWorker: async () => "w_codex",
      ticketWorkspace: async (_dispatcher, ticketId) => path.join(root, "tickets", ticketId),
    };
    firstChat = await hub.store.createConversation("owner", ["super"], "Project Alpha", "alpha");
  });

  afterEach(async () => {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });

  async function activeBotTurn(conversationId: string, text: string, clientMsgId: string) {
    const sent = await hub.store.sendMessage("owner", { conversationId, clientMsgId, text, attachments: [], mentions: ["super"], previewUrl: null });
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='super'", [sent.message.id]);
    return { kind: "bot" as const, botId: "super", contextMessage: sent.message.id };
  }

  async function settleTicket(ticket: DispatchTicket, text: string) {
    const attempt = ticket.attempts.at(-1)!;
    await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text }], replyTo: attempt.inputMessageId, status: "complete" });
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
    await hub.dispatch.sweep();
    return hub.dispatch.show(owner, ticket.id);
  }

  it("isolates tickets and settlement notices across parallel direct conversations while supporting an all-tickets view", async () => {
    const secondChat = await hub.store.createConversation("owner", ["super"], "Project Beta", "beta");

    const turnA = await activeBotTurn(firstChat.id, "Build Alpha", "msg-a");
    const turnB = await activeBotTurn(secondChat.id, "Build Beta", "msg-b");

    const ticketA = await hub.dispatch.create(turnA, "super", { requestId: "req-a", title: "Alpha Task", request: "Do Alpha" });
    const ticketB = await hub.dispatch.create(turnB, "super", { requestId: "req-b", title: "Beta Task", request: "Do Beta" });

    expect(ticketA.conversationId).toBe(firstChat.id);
    expect(ticketB.conversationId).toBe(secondChat.id);

    // Filtered list & overview return only each conversation's tickets; unfiltered returns all.
    expect((await hub.dispatch.list(owner, "super", { conversationId: firstChat.id })).tickets.map(t => t.id)).toEqual([ticketA.id]);
    expect((await hub.dispatch.list(owner, "super", { conversationId: secondChat.id })).tickets.map(t => t.id)).toEqual([ticketB.id]);
    expect((await hub.dispatch.overview(owner, "super", { conversationId: secondChat.id })).tickets.map(t => t.id)).toEqual([ticketB.id]);
    expect((await hub.dispatch.list(owner, "super")).tickets.map(t => t.id).sort()).toEqual([ticketA.id, ticketB.id].sort());

    // Dispatch and settle ticket B -> notice must land ONLY in secondChat, never leaking into firstChat.
    const workingB = await hub.dispatch.dispatch(turnB, "super", { requestId: "go-b", ticketId: ticketB.id, engine: "codex" });
    await settleTicket(workingB, "Beta finished cleanly.");

    const noticesA = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [firstChat.id]);
    const noticesB = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [secondChat.id]);
    expect(noticesA).toHaveLength(0);
    expect(noticesB).toHaveLength(1);
    expect(noticesB[0]!.blocks_json).toContain("Beta Task");
    expect(noticesB[0]!.blocks_json).toContain("【工单完成】");
  });

  it("allows a Superagent to join groups and deliver group ticket notices back to that group", async () => {
    const group = await hub.store.createConversation("owner", ["helper"], "Release Squad", "grp1", { type: "group" });
    const [updated] = await hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: ["helper", "super"],
      expectedBotIds: ["helper"],
    });
    expect(updated!.botIds).toEqual(["helper", "super"]);

    const groupTurn = await activeBotTurn(group.id, "@Superagent ship release", "msg-grp");
    const ticket = await hub.dispatch.create(groupTurn, "super", { requestId: "req-grp", title: "Ship Release", request: "Tag and verify" });
    expect(ticket.conversationId).toBe(group.id);

    const working = await hub.dispatch.dispatch(groupTurn, "super", { requestId: "go-grp", ticketId: ticket.id, engine: "codex" });
    await settleTicket(working, "Release verified.");

    const groupNotices = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [group.id]);
    expect(groupNotices).toHaveLength(1);
    expect(groupNotices[0]!.blocks_json).toContain("Ship Release");
    const delivered = await hub.store.db.all<{ bot_id: string }>("SELECT d.bot_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND m.bot_source_json IS NOT NULL", [group.id]);
    expect(delivered).toEqual([{ bot_id: "super" }]);
  });

  it("supports Bot-to-Bot messages, dedicated collaboration chats, and steering settings on a Superagent", async () => {
    const guard = async () => undefined;
    await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
    await hub.botMessages.grant({ sourceHost: "macmini", sourceBot: "helper", targetBot: "super" }, guard);

    // Helper sends a Bot message to Superagent (creates a dedicated collaboration conversation even though firstChat already exists!).
    const helperChat = await hub.store.createConversation("owner", ["helper"], "Helper Chat", "helper-chat");
    const trigger = await hub.store.sendMessage("owner", { conversationId: helperChat.id, clientMsgId: "h1", text: "Ask Superagent", attachments: [], mentions: ["helper"], previewUrl: null });
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='helper'", [trigger.message.id]);

    const resolved = await hub.botMessages.local({
      operation: "resolve",
      host: "macmini",
      bot: "super",
      requestId: "bm-resolve-1",
      contextMessage: trigger.message.id,
      data: {},
    }, "helper", guard) as { conversationId: string; botId: string };
    expect(resolved.botId).toBe("super");
    expect(resolved.conversationId).not.toBe(firstChat.id);

    const receipt = await hub.botMessages.local({
      operation: "send",
      host: "macmini",
      bot: "super",
      conversation: resolved.conversationId,
      requestId: "bm-send-1",
      contextMessage: trigger.message.id,
      data: { text: "Please review this design", attachments: [] },
    }, "helper", guard) as { messageId: string; conversationId: string };
    expect(receipt.conversationId).toBe(resolved.conversationId);
    expect(receipt.messageId).toBeTruthy();

    // Steering support is enabled for Claude/Codex dispatchers just like ordinary Bots.
    const steerSettings = await hub.botMessages.readSteering("owner", "super", guard);
    expect(steerSettings).toMatchObject({ botId: "super", supported: true, allowed: true });
  });

  it("preserves upgrade compatibility: existing single conversation receives tickets created without explicit conversationId", async () => {
    const legacyTicket = await hub.dispatch.create(owner, "super", { requestId: "legacy-1", title: "Legacy Task", request: "Keep working" });
    expect(legacyTicket.conversationId).toBe(firstChat.id);
    const working = await hub.dispatch.dispatch(owner, "super", { requestId: "legacy-go", ticketId: legacyTicket.id, engine: "codex" });
    await settleTicket(working, "Done.");
    const notices = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [firstChat.id]);
    expect(notices).toHaveLength(1);
  });

  it("refuses to resume a ticket whose conversation is archived", async () => {
    const ticket = await hub.dispatch.create(owner, "super", { requestId: "resume-arch", title: "Paused Work", request: "Wait", conversationId: firstChat.id });
    await hub.dispatch.action("owner", ticket.id, { requestId: "resume-arch-pause", action: "pause" });
    await hub.store.updateConversation("owner", firstChat.id, { archived: true });
    await expect(hub.dispatch.action("owner", ticket.id, { requestId: "resume-arch-resume", action: "resume" })).rejects.toThrow("conversation_archived");
    expect((await hub.dispatch.show(owner, ticket.id)).paused).toBe(true);
    expect(await hub.store.db.all("SELECT key FROM meta WHERE key LIKE 'dispatch:pending-notice:%'")).toEqual([]);
    await hub.store.updateConversation("owner", firstChat.id, { archived: false });
    await expect(hub.dispatch.action("owner", ticket.id, { requestId: "resume-arch-resume-2", action: "resume" })).resolves.toMatchObject({ paused: false });
  });

  it("rejects archived targets, skips archived home chats, and settles tickets without wedging concurrency slots or leaking notices", async () => {
    const secondChat = await hub.store.createConversation("owner", ["super"], "Project Beta", "beta");
    const group = await hub.store.createConversation("owner", ["super", "helper"], "Squad", "squad", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["super", "helper"], "Topic 1", "topic-1", { parentId: group.id });
    const settings = await hub.dispatch.settings("owner", "super");
    await hub.dispatch.updateSettings("owner", "super", { settings: { mode: "auto", maxConcurrent: 1 }, expectedRevision: settings.revision });

    // Create and dispatch a ticket in firstChat, then archive firstChat while it is still working.
    const ticketA = await hub.dispatch.create(owner, "super", { requestId: "arch-a", title: "Archived Work", request: "Run in Alpha", conversationId: firstChat.id });
    const workingA = await hub.dispatch.dispatch(owner, "super", { requestId: "arch-go-a", ticketId: ticketA.id, engine: "codex" });
    await hub.store.updateConversation("owner", firstChat.id, { archived: true });

    // Creating a ticket targeting an archived chat or a topic under an archived parent group is rejected.
    await expect(hub.dispatch.create(owner, "super", { requestId: "arch-reject-direct", title: "Bad", request: "No", conversationId: firstChat.id })).rejects.toThrow("conversation_archived");
    await hub.store.updateConversation("owner", group.id, { archived: true });
    await expect(hub.dispatch.create(owner, "super", { requestId: "arch-reject-topic", title: "Bad Topic", request: "No", conversationId: topic.id })).rejects.toThrow("conversation_archived");

    // Fallback home() skips archived firstChat and picks active secondChat.
    const fallbackTicket = await hub.dispatch.create(owner, "super", { requestId: "arch-fallback", title: "Fallback", request: "Run in Beta" });
    expect(fallbackTicket.conversationId).toBe(secondChat.id);

    // Worker finishes while firstChat is archived: settlement commits cleanly, releases maxConcurrent,
    // and never leaks firstChat's notice into secondChat.
    const settledA = await settleTicket(workingA, "Finished while archived.");
    expect(settledA.status).toBe("needs_review");
    expect(settledA.result).toBe("Finished while archived.");
    const leaked = await hub.store.db.all("SELECT id FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [secondChat.id]);
    expect(leaked).toHaveLength(0);

    // Concurrency slot (maxConcurrent=1) is released: fallbackTicket can dispatch immediately!
    const workingB = await hub.dispatch.dispatch(owner, "super", { requestId: "arch-go-b", ticketId: fallbackTicket.id, engine: "codex" });
    expect(workingB.status).toBe("working");

    // Unarchiving firstChat allows the next sweep to deliver the deferred notice into firstChat.
    await hub.store.updateConversation("owner", firstChat.id, { archived: false });
    await hub.dispatch.sweep();
    const noticesA = await hub.store.db.all<{ blocks_json: string; client_msg_id: string }>("SELECT blocks_json,client_msg_id FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [firstChat.id]);
    expect(noticesA).toHaveLength(1);
    expect(noticesA[0]!.blocks_json).toContain("Archived Work");
    expect(noticesA[0]!.client_msg_id).toMatch(/^tn_/);
  });

  it("settles group tickets cleanly during active/paused group discussions and blocks removing a busy dispatcher from the group", async () => {
    const group = await hub.store.createConversation("owner", ["super", "helper"], "Release Squad", "grp-disc", { type: "group" });
    const topic = await hub.store.createConversation("owner", ["super", "helper"], "Release Topic", "grp-topic", { parentId: group.id });
    const settings = await hub.dispatch.settings("owner", "super");
    await hub.dispatch.updateSettings("owner", "super", { settings: { mode: "auto", maxConcurrent: 1 }, expectedRevision: settings.revision });

    const ticket = await hub.dispatch.create(owner, "super", { requestId: "disc-tk", title: "Topic Build", request: "Build", conversationId: topic.id });
    const working = await hub.dispatch.dispatch(owner, "super", { requestId: "disc-go", ticketId: ticket.id, engine: "codex" });

    // Removing the dispatcher from the root group while it has a working ticket in a topic is blocked.
    await expect(hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: ["helper"],
      expectedBotIds: ["helper", "super"],
    })).rejects.toThrow("group_bot_busy");

    // Simulate an active (and paused) group discussion on topic.id while the ticket finishes.
    const now = Date.now();
    await hub.store.db.run(
      `INSERT INTO group_discussions(id,group_id,conversation_id,topic_message_id,created_by,settings_revision,mode,participants_json,max_rounds,stage,round,status,revision,created_at,updated_at)
       VALUES('gd_active',?,?,?,'owner','rev','sequential','[]',2,'discussion',1,'paused',1,?,?)`,
      [group.id, topic.id, "msg_topic_seed", now, now],
    );

    const settled = await settleTicket(working, "Topic build ready.");
    expect(settled.status).toBe("needs_review");
    // Notice is deferred rather than violating the active/paused discussion boundary.
    expect(await hub.store.db.all("SELECT id FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [topic.id])).toHaveLength(0);

    // Concurrency slot is freed even while the discussion is paused.
    const directTicket = await hub.dispatch.create(owner, "super", { requestId: "after-disc", title: "Direct", request: "Work", conversationId: firstChat.id });
    expect((await hub.dispatch.dispatch(owner, "super", { requestId: "after-disc-go", ticketId: directTicket.id, engine: "codex" })).status).toBe("working");

    // Once the discussion ends, the next sweep delivers the deferred notice into the topic.
    await hub.store.db.run("UPDATE group_discussions SET status='ended' WHERE id='gd_active'");
    await hub.dispatch.sweep();
    const delivered = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [topic.id]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.blocks_json).toContain("Topic Build");

    // Now that no working ticket remains in the group/topic (and pending notice delivery is settled), removing the dispatcher succeeds.
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE bot_id='super'");
    const [updated] = await hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: ["helper"],
      expectedBotIds: ["helper", "super"],
    });
    expect(updated!.botIds).toEqual(["helper"]);
  });

  it("enforces conversationId idempotency, Bot conversation scope, and group-discussion mutation blocks", async () => {
    const secondChat = await hub.store.createConversation("owner", ["super"], "Project Beta", "beta-scope");
    const turnA = await activeBotTurn(firstChat.id, "Work A", "scope-a");
    const turnB = await activeBotTurn(secondChat.id, "Work B", "scope-b");

    const ticketA = await hub.dispatch.create(turnA, "super", { requestId: "shared-req", title: "Same Title", request: "Same Body" });
    // Reusing the same requestId with identical title/request from another conversation must conflict.
    await expect(hub.dispatch.create(turnB, "super", { requestId: "shared-req", title: "Same Title", request: "Same Body" })).rejects.toThrow("idempotency_conflict");
    await expect(hub.dispatch.create(owner, "super", { requestId: "shared-req", title: "Same Title", request: "Same Body", conversationId: secondChat.id })).rejects.toThrow("idempotency_conflict");
    // Same conversation idempotent retry still returns the existing ticket.
    expect((await hub.dispatch.create(turnA, "super", { requestId: "shared-req", title: "Same Title", request: "Same Body" })).id).toBe(ticketA.id);

    // Bot turn in Chat B cannot create into Chat A, nor dispatch/update Chat A's ticket.
    await expect(hub.dispatch.create(turnB, "super", { requestId: "cross-create", title: "Cross", request: "Body", conversationId: firstChat.id })).rejects.toThrow("dispatch_conversation_mismatch");
    await expect(hub.dispatch.dispatch(turnB, "super", { requestId: "cross-dispatch", ticketId: ticketA.id, engine: "codex" })).rejects.toThrow("dispatch_conversation_mismatch");
    await expect(hub.dispatch.update(turnB, "super", { ticketId: ticketA.id, status: "blocked" })).rejects.toThrow("dispatch_conversation_mismatch");

    // A sealed group discussion turn cannot create/dispatch/update tickets.
    const now = Date.now();
    await hub.store.db.run(
      `INSERT INTO group_discussion_turns(id,discussion_id,seq,round,position,attempt,bot_id,blind,input_message_id,context_json,state,created_at)
       VALUES('gdt_1','gd_1',1,1,0,1,'super',1,?,'{}','active',?)`,
      [turnB.contextMessage, now],
    );
    await expect(hub.dispatch.create(turnB, "super", { requestId: "disc-blocked", title: "Blocked", request: "No" })).rejects.toThrow("group_discussion_dispatch_blocked");
  });

  it("keeps current-conversation tickets visible past global LIMIT 200 and preserves strict unfiltered overview shape", async () => {
    const secondChat = await hub.store.createConversation("owner", ["super"], "Project Beta", "beta-limit");
    const now = Date.now();
    for (let i = 0; i < 205; i++) {
      await hub.store.db.run(
        "INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',0,'[]',?,?)",
        [`tk_bulk_${String(i).padStart(3, "0")}`, "super", firstChat.id, `req_bulk_${i}`, `Bulk ${i}`, "Work", now + i, now + i],
      );
    }
    const target = await hub.dispatch.create(owner, "super", { requestId: "beta-older", title: "Beta Ticket", request: "Do Beta", conversationId: secondChat.id });
    // Push Beta Ticket's timestamp older than all 205 bulk tickets in firstChat.
    await hub.store.db.run("UPDATE dispatch_tickets SET created_at=?,updated_at=? WHERE id=?", [now - 10_000, now - 10_000, target.id]);

    const scoped = await hub.dispatch.overview(owner, "super", { conversationId: secondChat.id, capabilities: true });
    expect(scoped.tickets.map(t => t.id)).toEqual([target.id]);
    expect(scoped.otherCount).toBe(205);
    expect(scoped.capabilities).toEqual({ remove: true });

    const unfiltered = await hub.dispatch.overview(owner, "super");
    expect(unfiltered).not.toHaveProperty("otherCount");
    expect(unfiltered.tickets).toHaveLength(200);
  });

  it("keeps dispatchers owner-only for non-owner members and protects home() and openAttempt()", async () => {
    await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member','Member','member')");
    await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member','helper'),('member','super')");

    // Non-owner members never see dispatchers or workers in bots() and cannot create/add them in chats/groups.
    expect((await hub.store.bots("member")).map(b => b.id)).toEqual(["helper"]);
    await expect(hub.store.createConversation("member", ["super"], "Member Super", "mem-super")).rejects.toThrow("bot_forbidden");
    const memberGroup = await hub.store.createConversation("member", ["helper"], "Member Group", "mem-grp", { type: "group" });
    await expect(hub.store.updateGroup("member", memberGroup.id, {
      title: memberGroup.title,
      expectedTitle: memberGroup.title,
      botIds: ["helper", "super"],
      expectedBotIds: ["helper"],
    })).rejects.toThrow("bot_forbidden");

    // Even if a legacy DB has an earlier member-owned chat row with the dispatcher, home() ignores it and picks owner's chat.
    await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,archived,created_at) VALUES('gw_legacy_member','direct','Legacy Member','member',0,1)");
    await hub.store.db.run("INSERT INTO conversation_members VALUES('gw_legacy_member','user','member',0),('gw_legacy_member','bot','super',0)");
    const ticket = await hub.dispatch.create(owner, "super", { requestId: "owner-home", title: "Owner Home", request: "Use owner chat" });
    expect(ticket.conversationId).toBe(firstChat.id);
    // And even if a ticket were bound to a legacy member conversation, openAttempt creates its hidden worker chat under 'owner'.
    const legacyTicket = await hub.dispatch.create(owner, "super", { requestId: "legacy-mem-tk", title: "Legacy Member Ticket", request: "Run", conversationId: "gw_legacy_member" });
    const dispatched = await hub.dispatch.dispatch(owner, "super", { requestId: "legacy-mem-go", ticketId: legacyTicket.id, engine: "codex" });
    expect(dispatched.status).toBe("working");
    const workerRow = await hub.store.db.get<{ owner_id: string }>("SELECT owner_id FROM conversations WHERE id=?", [dispatched.attempts[0]!.conversationId]);
    expect(workerRow?.owner_id).toBe("owner");
  });
});
