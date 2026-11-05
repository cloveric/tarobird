import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { botMessageGrantsCommandSchema } from "../src/client-protocol/bot-message-grants.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { networkCanonical } from "../src/client-protocol/private-network.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";

let root: string, hub: HubServer;
const guard = async () => undefined;
const read = () => hub.botMessages.readGrants("owner", guard);
const command = async (changes: {targetBot:string;allowed:boolean}[], sourceBot="a") => ({ operation: "local-message-grants" as const, sourceBot, revision: (await read()).revision, changes });
const update = async (changes: {targetBot:string;allowed:boolean}[], sourceBot="a") => hub.botMessages.updateGrants("owner", "device_test", await command(changes, sourceBot), guard, guard);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-message-grants-")); hub = await HubServer.start({ stateDir: root });
  for (const id of ["a", "b", "c"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id.toUpperCase(), hashSecret("secret-".repeat(8))]);
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

it("hides internal workers and their edges without changing grants or queued work", async () => {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('d','Dispatcher','fixture','dispatcher'),('w','Dispatcher · Claude','fixture','worker')");
  // A user Bot with the same name must remain selectable: the role decides.
  await hub.store.db.run("UPDATE bots SET name='Dispatcher · Claude' WHERE id='c'");
  const host = messageHostId(hub.auth.publicKey);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "w" }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "w", targetBot: "b" }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "b" }, guard);
  const conversation = await hub.store.createConversation("owner", ["w"], "Worker task", "worker-task", { dispatchWorker: true });
  const message = await hub.store.sendMessage("owner", { conversationId: conversation.id, clientMsgId: "work", text: "Continue the task", attachments: [] });
  const worker = await hub.store.db.get("SELECT * FROM bots WHERE id='w'");
  const pending = await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [message.message.id]);
  expect(pending).toHaveLength(1);
  const storedGrants = await hub.store.db.all("SELECT * FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key");
  const snapshot = await read();
  expect(snapshot.bots.map(bot => bot.id)).toEqual(["a", "b", "c", "d"]);
  expect(snapshot.grants).toEqual([{ sourceBot: "a", targetBot: "b" }]);
  await update([{ targetBot: "b", allowed: true }]);
  expect(await hub.store.db.all("SELECT * FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key")).toEqual(storedGrants);
  expect(await hub.store.db.get("SELECT * FROM bots WHERE id='w'")).toEqual(worker);
  expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [message.message.id])).toEqual(pending);
  // Background worker creation must not invalidate an unrelated UI draft.
  const revision = (await read()).revision;
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w2','Dispatcher · Codex','fixture','worker')");
  expect((await read()).revision).toBe(revision);
});

it("rejects hidden worker endpoints in grant edits without partial writes", async () => {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  await expect(update([{ targetBot: "b", allowed: true }, { targetBot: "w", allowed: true }])).rejects.toThrow("bot_deleted");
  await expect(update([{ targetBot: "b", allowed: true }], "w")).rejects.toThrow("bot_deleted");
  expect((await read()).grants).toEqual([]);
  expect(await hub.store.db.all("SELECT * FROM audit_log WHERE kind='bot-message.grants-updated'")).toEqual([]);
});

it("reads existing CLI grants without writing or granting the reverse direction", async () => {
  const host = messageHostId(hub.auth.publicKey);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "b" }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "c", targetBot: "a", revoke: true }, guard);
  const before = await hub.store.db.all("SELECT * FROM meta ORDER BY key");
  expect((await read()).grants).toEqual([{ sourceBot: "a", targetBot: "b" }]);
  expect(await hub.store.db.all("SELECT * FROM meta ORDER BY key")).toEqual(before);
});

it("exposes existing CLI self grants without migration and revokes only the selected edge", async () => {
  const host = messageHostId(hub.auth.publicKey);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "a" }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "b" }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "c", targetBot: "c", revoke: true }, guard);
  const before = await hub.store.db.all("SELECT * FROM meta ORDER BY key");
  expect(await read()).toMatchObject({ selfTargetSupported: true, grants: expect.arrayContaining([
    { sourceBot: "a", targetBot: "a" }, { sourceBot: "a", targetBot: "b" },
  ]) });
  expect((await read()).grants).toHaveLength(2);
  expect(await hub.store.db.all("SELECT * FROM meta ORDER BY key")).toEqual(before);
  const stale = await command([{ targetBot: "a", allowed: false }]);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "a", revoke: true }, guard);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "a", targetBot: "a" }, guard);
  await expect(hub.botMessages.updateGrants("owner", "device_test", stale, guard, guard)).rejects.toThrow("grants_changed");
  expect((await update([{ targetBot: "a", allowed: false }])).grants).toEqual([{ sourceBot: "a", targetBot: "b" }]);
  const audit = await hub.store.db.get<{ detail_json: string; actor: string }>("SELECT actor,detail_json FROM audit_log WHERE kind='bot-message.grants-updated'");
  expect(audit?.actor).toBe("device_test");
  expect(JSON.parse(audit!.detail_json).changes).toEqual([{ targetBot: "a", allowed: false, previous: true }]);
});

it("requires an explicit owner self grant and uses a separate conversation with the existing queue and result receipt", async () => {
  const origin = await hub.store.createConversation("owner", ["a"], "User conversation", "origin");
  const incoming = await hub.store.sendMessage("owner", { conversationId: origin.id, clientMsgId: "origin-task", text: "Delegate to another conversation", attachments: [] });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [incoming.message.id]);
  const request = { operation: "resolve", host: messageHostId(hub.auth.publicKey), bot: "a", requestId: "self-task", contextMessage: incoming.message.id, data: {} };
  await expect(hub.botMessages.local(request, "a", guard)).rejects.toThrow("not_authorized");
  await update([{ targetBot: "a", allowed: true }]);
  const target: any = await hub.botMessages.local(request, "a", guard);
  expect(target.botId).toBe("a"); expect(target.conversationId).not.toBe(origin.id);
  const send = { ...request, operation: "send", conversation: target.conversationId, data: { text: "Self collaboration", attachments: [] } };
  const receipt: any = await hub.botMessages.local(send, "a", guard);
  // Request IDs keep self delivery idempotent too.
  expect(await hub.botMessages.local(send, "a", guard)).toEqual({ ...receipt, duplicate: true });
  const queued = await hub.store.db.all<{ dispatched: number }>("SELECT dispatched FROM deliveries WHERE message_id=?", [receipt.messageId]);
  expect(queued).toEqual([{ dispatched: 0 }]);
  await hub.store.publishBotMessage("a", { conversationId: target.conversationId, replyTo: receipt.messageId, blocks: [{ type: "text", text: "Self result" }] });
  await hub.store.acknowledgeDelivery("a", receipt.messageId);
  const wait = { ...request, operation: "wait", conversation: target.conversationId, data: { messageId: receipt.messageId } };
  expect(await hub.botMessages.local(wait, "a", guard)).toMatchObject({ status: "completed", text: "Self result" });
  await expect(hub.botMessages.local({ ...request, bot: "b" }, "a", guard)).rejects.toThrow("target_not_found");
  await update([{ targetBot: "a", allowed: false }]);
  await expect(hub.botMessages.local({ ...send, requestId: "after-revoke" }, "a", guard)).rejects.toThrow("not_authorized_or_revoked");
  await expect(hub.botMessages.local(wait, "a", guard)).rejects.toThrow("not_authorized_or_revoked");
});

it("self grants preserve source/context validation, control rejection, hop and rate limits", async () => {
  await update([{ targetBot: "a", allowed: true }]);
  const origin = await hub.store.createConversation("owner", ["a"], "Origin", "source");
  const host = messageHostId(hub.auth.publicKey);
  const incoming = await hub.store.sendMessage("owner", { conversationId: origin.id, clientMsgId: "hop3", text: "Third hop", attachments: [], botSource: { hostId: host, hostName: "Host", botId: "a", botName: "A", hops: 3, requestId: "hop3" } });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [incoming.message.id]);
  const base = { host, bot: "a", requestId: "limits", data: {} };
  const target: any = await hub.botMessages.local({ ...base, operation: "resolve" }, "a", guard, true);
  const send = { ...base, operation: "send", conversation: target.conversationId, data: { text: "Task", attachments: [] } };
  await expect(hub.botMessages.local(send, "a", guard)).rejects.toThrow("context_required");
  await expect(hub.botMessages.local({ ...send, sourceBot: "b" }, "a", guard, true)).rejects.toThrow("source_invalid");
  await expect(hub.botMessages.local({ ...send, contextMessage: incoming.message.id }, "a", guard)).rejects.toThrow("hop_limit");
  await expect(hub.botMessages.local({ ...send, requestId: "control", data: { text: "/stop", attachments: [] } }, "a", guard, true)).rejects.toThrow("control");
  for (let i = 0; i < 10; i++) await hub.botMessages.local({ ...send, requestId: `rate_${i}` }, "a", guard, true);
  await expect(hub.botMessages.local({ ...send, requestId: "rate_last" }, "a", guard, true)).rejects.toThrow("rate_limit");
});

it("writes one selected direction atomically, preserves other directions, audits the actor and uses existing delivery permissions", async () => {
  await update([{ targetBot: "a", allowed: true }], "c");
  const snapshot = await update([{ targetBot: "b", allowed: true }, { targetBot: "c", allowed: true }]);
  expect(snapshot.grants).toEqual(expect.arrayContaining([{sourceBot:"a",targetBot:"b"},{sourceBot:"a",targetBot:"c"},{sourceBot:"c",targetBot:"a"}]));
  const host = messageHostId(hub.auth.publicKey);
  const request = { operation: "resolve", host, bot: "b", requestId: "local-task", data: {} };
  const target: any = await hub.botMessages.local(request, "a", guard, true);
  const receipt: any = await hub.botMessages.local({ ...request, operation: "send", conversation: target.conversationId, data: { text: "One-way request", attachments: [] } }, "a", guard, true);
  await hub.store.publishBotMessage("b", { conversationId: target.conversationId, replyTo: receipt.messageId, blocks: [{type:"text",text:"Original result"}] });
  await hub.store.acknowledgeDelivery("b", receipt.messageId);
  expect(await hub.botMessages.local({...request, operation:"wait", conversation:target.conversationId, data:{messageId:receipt.messageId}},"a",guard,true)).toMatchObject({status:"completed",text:"Original result"});
  await expect(hub.botMessages.local({ ...request, bot: "a" }, "b", guard, true)).rejects.toThrow("not_authorized");
  await update([{targetBot:"a",allowed:true}],"b");
  await expect(hub.botMessages.local({...request,bot:"a"},"b",guard,true)).resolves.toMatchObject({botId:"a"});
  const audit = await hub.store.db.all<{actor:string;detail_json:string}>("SELECT actor,detail_json FROM audit_log WHERE kind='bot-message.grants-updated'");
  expect(audit.every(row=>row.actor==="device_test")).toBe(true);
  expect(JSON.parse(audit[1]!.detail_json).changes).toEqual([{targetBot:"b",allowed:true,previous:false},{targetBot:"c",allowed:true,previous:false}]);
});

it("rejects stale edits, including an allow/revoke ABA through the old CLI; no partial writes", async () => {
  const old = await command([{targetBot:"b",allowed:true},{targetBot:"c",allowed:true}]);
  const host = messageHostId(hub.auth.publicKey);
  await hub.botMessages.grant({sourceHost:host,sourceBot:"b",targetBot:"a"},guard);
  await hub.botMessages.grant({sourceHost:host,sourceBot:"b",targetBot:"a",revoke:true},guard);
  await expect(hub.botMessages.updateGrants("owner","device_test",old,guard,guard)).rejects.toThrow("grants_changed");
  expect((await read()).grants).toEqual([]);
  await expect(update([{targetBot:"b",allowed:true},{targetBot:"missing",allowed:true}])).rejects.toThrow("bot_deleted");
  expect((await read()).grants).toEqual([]);
  const fresh = await command([{targetBot:"b",allowed:true}]);
  await expect(hub.botMessages.updateGrants("owner","device_test",fresh,guard,async()=>{throw new Error("revoked_device");})).rejects.toThrow("revoked_device");
  expect((await read()).revision).toBe(fresh.revision);
});

it.each(["a", "b"])("keeps grants to %s across rename/restart and never inherits deleted IDs by name", async targetBot => {
  await update([{targetBot,allowed:true}]); const before=await read();
  await hub.store.db.run("UPDATE bots SET name='Renamed',online=1 WHERE id=?", [targetBot]);
  expect(await read()).toMatchObject({revision:before.revision,bots:expect.arrayContaining([{id:targetBot,name:"Renamed",online:true}])});
  await hub.close(); hub=await HubServer.start({stateDir:root});
  expect((await read()).grants).toEqual(before.grants);
  await hub.store.db.run("UPDATE bots SET deleted_at=? WHERE id=?",[Date.now(),targetBot]);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('new_b','Renamed',?)",[hashSecret("secret")]);
  expect((await read()).grants).toEqual([]);
  expect((await read()).bots.some(bot=>bot.id==="new_b")).toBe(true);
});

it.each(["a", "b"])("requires owner and matching device proof for grants to %s; CLI reads the same records", async targetBot => {
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role) VALUES('w','Worker','fixture','worker')");
  const closeControl=await startHubControl(root,{running:true,pid:process.pid,url:hub.url,instanceUrl:hub.instanceUrl,publicKey:hub.auth.publicKey},()=>{}, {enrollController:value=>hub.enrollLocalController(value)});
  const client=await LocalHostClient.connect(root,{enroll:true});
  try {
    const input=await command([{targetBot,allowed:true}]);
    await expect(client.request("/api/bot-messages/grants","POST",{command:input})).rejects.toThrow();
    const proof=await client.deviceAction({operation:"bot-message-grant",target:hashSecret(networkCanonical(input))});
    await expect(client.request("/api/bot-messages/grants","POST",{command:{...input,sourceBot:"c"},proof})).rejects.toThrow();
    expect((await read()).grants).toEqual([]);
    const good=await client.deviceAction({operation:"bot-message-grant",target:hashSecret(networkCanonical(input))});
    await client.request("/api/bot-messages/grants","POST",{command:input,proof:good});
    const cli = await runBotMessagesCommand(root,"grants",{}) as any;
    expect(cli.grants).toEqual([{sourceBot:"a",targetBot}]);
    expect(cli.bots.map((bot: { id: string }) => bot.id)).toEqual(["a", "b", "c"]);
    const unauthorized=await fetch(hub.url+"/api/bot-messages/grants"); expect(unauthorized.ok).toBe(false);
    const bot=await fetch(hub.instanceUrl+"/api/bot-messages/grants",{method:"POST",headers:{Authorization:`Instance a:${"secret-".repeat(8)}`},body:JSON.stringify({command:input,proof:good})}); expect(bot.ok).toBe(false);
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    await expect(hub.botMessages.readGrants("member",guard)).rejects.toThrow();
    await expect(hub.botMessages.updateGrants("member","member_device",await command([{targetBot:"c",allowed:true}]),guard,guard)).rejects.toThrow();
  } finally {client.close();await closeControl();}
});

it("accepts a single self target, rejects duplicate/oversized writes and rolls back self grants with failed batches", async () => {
  const input=await command([{targetBot:"b",allowed:true}]);
  expect(botMessageGrantsCommandSchema.safeParse({...input,changes:[{targetBot:"b",allowed:true},{targetBot:"b",allowed:false}]}).success).toBe(false);
  expect(botMessageGrantsCommandSchema.safeParse({...input,changes:[{targetBot:"a",allowed:true}]}).success).toBe(true);
  expect(botMessageGrantsCommandSchema.safeParse({...input,changes:[{targetBot:"a",allowed:true},{targetBot:"a",allowed:false}]}).success).toBe(false);
  expect(botMessageGrantsCommandSchema.safeParse({...input,changes:Array.from({length:257},(_,i)=>({targetBot:`b${i}`,allowed:true}))}).success).toBe(false);
  await hub.store.db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON meta WHEN NEW.value LIKE '%\"targetBot\":\"c\"%' BEGIN SELECT RAISE(ABORT,'storage_full'); END");
  await expect(update([{targetBot:"a",allowed:true},{targetBot:"b",allowed:true},{targetBot:"c",allowed:true}])).rejects.toThrow("storage_full");
  expect((await read()).grants).toEqual([]);
  expect(await hub.store.db.all("SELECT * FROM audit_log WHERE kind='bot-message.grants-updated'")).toEqual([]);
});
