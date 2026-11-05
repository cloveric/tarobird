import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it, expect, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { CronStore } from "../src/state/cron-store.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { blocksText } from "../src/client-protocol/index.js";
import type { ScheduleMutation, ScheduleSettings } from "../src/client-protocol/schedules.js";
import { Bridge } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { scheduledTasksSchema, scheduleSettingsSchema } from "../src/client-protocol/schedules.js";
async function token(hub: HubServer, id: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner", userId);
  const challenge = await hub.auth.challenge(id,id,nonce,id);
  return (await hub.auth.authenticate(id,sign(null,deviceProof(id,challenge.nonce,nonce),keys.privateKey).toString("base64"))).token;
}
it("keeps persisted one-shot tasks with missing execution times visible and repairable without hiding healthy tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-legacy-time-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const runtime = createCoreServiceRuntime();
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime, bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  const store = new CronStore(stateDir), scheduler = new CronScheduler({ store, stateDir, executor: async () => {} }); runtime.cronRuntime = { store, scheduler };
  try {
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Legacy reminders", "legacy_reminders");
    const base = { channel: "lark" as const, chatId: 1, userId: 2, larkChatId: conversation.id, cronExpr: "0 9 * * *", prompt: "Keep this reminder" };
    const healthy = await store.add(base), invalid = await store.add({ ...base, description: "Missing time", runOnce: true });
    expect((await new CronStore(stateDir).get(invalid.id))?.targetAt).toBeUndefined();
    const before = await readFile(path.join(stateDir, "cron-jobs.json"), "utf8");
    const headers = { Authorization: `Bearer ${await token(hub, "legacy_device")}` }, endpoint = hub.url + "/api/bots/alpha/schedules";
    const response = await fetch(endpoint, { headers }); expect(response.status).toBe(200);
    const listed = scheduledTasksSchema.parse(await response.json());
    expect(listed.jobs).toHaveLength(2);
    expect(listed.jobs.find(job => job.id === invalid.id)).toMatchObject({ timing: { kind: "once", at: "" }, nextRunAt: null, validationError: "missing_run_time" });
    expect(listed.jobs.find(job => job.id === healthy.id)?.nextRunAt).not.toBeNull();
    expect(await readFile(path.join(stateDir, "cron-jobs.json"), "utf8")).toBe(before);
    const post = (mutation: ScheduleMutation) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ mutation, locale: "en" }) });
    const existing = { id: invalid.id, conversationId: conversation.id, expectedUpdatedAt: invalid.updatedAt };
    expect((await post({ ...existing, action: "enabled", enabled: true, requestId: "invalid_enable" })).status).toBe(409);
    expect((await post({ ...existing, action: "enabled", enabled: false, requestId: "invalid_pause" })).status).toBe(200);
    const settings: ScheduleSettings = { title: "Repaired", prompt: invalid.prompt, timezone: "UTC", timing: { kind: "once", at: "" }, sessionMode: "new_per_run" };
    expect(scheduleSettingsSchema.safeParse(settings).success).toBe(false);
    expect((await post({ ...existing, action: "update", settings, requestId: "invalid_edit" })).status).toBe(400);
    const at = new Date(Date.now() + 86_400_000).toISOString();
    expect((await post({ ...existing, expectedUpdatedAt: (await store.get(invalid.id))!.updatedAt, action: "update", settings: { ...settings, timing: { kind: "once", at } }, requestId: "repair_time" })).status).toBe(200);
    const repaired = (await store.get(invalid.id))!; expect(repaired.targetAt).toBe(at);
    const refreshed = scheduledTasksSchema.parse(await (await fetch(endpoint, { headers })).json());
    expect(refreshed.jobs.find(job => job.id === invalid.id)).not.toHaveProperty("validationError");
    expect((await post({ ...existing, expectedUpdatedAt: repaired.updatedAt, action: "remove", requestId: "remove_repaired" })).status).toBe(200);
    expect(await store.get(healthy.id)).toEqual(healthy);
  } finally { await scheduler.stop(); await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
it("App schedule HTTP operations are authorized, durable, replay-safe and fire through the shared scheduler and Gateway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"schedule-contract-")), stateDir=path.join(root,"bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir,"config.json"),JSON.stringify({engine:"codex",locale:"zh",timezone:"Asia/Shanghai"}));
  const hub=await HubServer.start({stateDir:path.join(root,"hub")}), secret=randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?),('beta','Beta','fixture')",[hashSecret(secret)]);
  const runtime=createCoreServiceRuntime(), seen:string[]=[];
  const channel=await attachGateway({stateDir,botId:"alpha",secret,url:hub.url.replace("http","ws")+"/instance",runtime,bridge:{handleAuthorizedMessage:async input=>{seen.push(input.text);return {text:"SCHEDULE_RESULT_OK"};}}});
  const store=new CronStore(stateDir), scheduler=new CronScheduler({store,stateDir,executor:(job,signal)=>channel.runCron!(job,signal)});
  await scheduler.start(); runtime.cronRuntime={store,scheduler};
  try {
    const owner=await token(hub,"desktop"), phone=await token(hub,"phone");
    await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest=await token(hub,"guest","guest");
    const conversation=await hub.store.createConversation("owner",["alpha"],"Results","results");
    const other=await hub.store.createConversation("owner",["beta"],"Other Bot","other");
    const endpoint=hub.url+"/api/bots/alpha/schedules";
    const get=(auth=owner)=>fetch(endpoint,{headers:{Authorization:`Bearer ${auth}`}});
    const post=(mutation:ScheduleMutation,auth=owner)=>fetch(endpoint,{method:"POST",headers:{Authorization:`Bearer ${auth}`,"Content-Type":"application/json"},body:JSON.stringify({mutation,locale:"zh"})});
    expect((await get(guest)).status).toBe(403); expect((await fetch(endpoint)).status).toBe(401);
    const settings:ScheduleSettings={title:"Daily",prompt:"Summarize progress",timezone:"Asia/Shanghai",timing:{kind:"cron",expression:"0 9 * * 1-5"},sessionMode:"new_per_run"};
    const create:ScheduleMutation={action:"create",conversationId:conversation.id,requestId:"create_daily",settings};
    expect((await post({...create,conversationId:other.id,requestId:"wrong_bot"})).status).toBe(403);
    expect((await post(create,guest)).status).toBe(403);
    expect((await post({...create,requestId:"bad_tz",settings:{...settings,timezone:"invalid/zone"}})).status).toBe(409);
    expect((await post({...create,requestId:"bad_cron",settings:{...settings,timing:{kind:"cron",expression:"* * * * * *"}}})).status).toBe(409);
    expect((await post(create)).status).toBe(200); expect((await post(create)).status).toBe(200);
    expect(await store.list()).toHaveLength(1);
    let job=(await store.list())[0]!;
    expect(job).toMatchObject({conversationKey:`lark:${conversation.id}`,larkChatId:conversation.id,timezone:"Asia/Shanghai",deliveryMode:"agent",sessionMode:"new_per_run"});
    expect((await (await get(phone)).json()).jobs).toHaveLength(1);
    const stale=job.updatedAt;
    expect((await post({action:"update",id:job.id,expectedUpdatedAt:stale,requestId:"edit_daily",conversationId:conversation.id,settings:{...settings,title:"Updated"}},phone)).status).toBe(200);
    expect((await post({action:"enabled",id:job.id,expectedUpdatedAt:stale,requestId:"stale_pause",conversationId:conversation.id,enabled:false})).status).toBe(409);
    job=(await store.get(job.id))!;
    const pause:ScheduleMutation={action:"enabled",id:job.id,expectedUpdatedAt:job.updatedAt,requestId:"pause_daily",conversationId:conversation.id,enabled:false};
    expect((await post(pause)).status).toBe(200); expect((await post(pause)).status).toBe(200);
    expect((await new CronStore(stateDir).get(job.id))?.enabled).toBe(false);
    const runAt=new Date(Date.now()+1200).toISOString();
    expect((await post({...create,requestId:"once",settings:{...settings,title:"One time",timing:{kind:"once",at:runAt}}})).status).toBe(200);
    await expect.poll(async()=>blocksText((await hub.store.snapshot("owner",conversation.id)).messages.flatMap(m=>m.blocks)),{timeout:12000}).toContain("SCHEDULE_RESULT_OK");
    expect(seen).toHaveLength(1);
    await expect.poll(async()=>(await store.list()).find(j=>j.description==="One time")?.enabled).toBe(false);
    // A replay after the one-time date has passed still returns the persisted receipt.
    expect((await post({...create,requestId:"once",settings:{...settings,title:"One time",timing:{kind:"once",at:runAt}}})).status).toBe(200);
    expect(await store.list()).toHaveLength(2);
    job=(await store.get(job.id))!;
    expect((await post({action:"remove",id:job.id,expectedUpdatedAt:job.updatedAt,requestId:"remove_daily",conversationId:conversation.id})).status).toBe(200);
    expect(await store.get(job.id)).toBeNull();expect(await hub.store.conversations("owner")).toHaveLength(2);
    await channel.disconnect();expect((await get()).status).toBe(503);
  } finally {await scheduler.stop();await channel.disconnect();await hub.close();await rm(root,{recursive:true,force:true});}
},25000);

it("applies a selected native session before a reuse schedule runs and delivers from its workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-selected-session-")), stateDir = path.join(root, "bot"), workspace = path.join(root, "external-project");
  await mkdir(stateDir); await mkdir(workspace);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  const report = path.join(workspace, "report.txt"); await writeFile(report, "selected project report");
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  await sessions.upsert({ telegramChatId: 1, conversationKey: "lark:source", codexSessionId: "selected_native",
    resume: { sessionId: "selected_native", dirName: "external-project", workspacePath: workspace }, status: "idle", updatedAt: new Date().toISOString() });
  const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn(async () => ({ text: `[send-file:${report}]` })) };
  const bridge = new Bridge({} as never, new SessionManager(sessions, adapter), adapter);
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir, botId: "alpha", secret, url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge });
  try {
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Selected project", "selected_project");
    await hub.store.updateConversation("owner", conversation.id, { sessionId: "selected_native" });
    const job = await new CronStore(stateDir).add({ channel: "lark", chatId: 2, userId: 3, larkChatId: conversation.id, conversationKey: `lark:${conversation.id}`,
      cronExpr: "0 9 * * *", prompt: "Continue the selected project", sessionMode: "reuse", deliveryMode: "agent" });
    const result = await channel.runCron!(job).then(() => undefined, error => error);
    expect(adapter.sendUserMessage).toHaveBeenCalledWith("selected_native", expect.objectContaining({ workspaceOverride: workspace }));
    expect(result).toBeUndefined();
    expect((await sessions.findByConversationKey(`lark:${conversation.id}`))?.codexSessionId).toBe("selected_native");
    const attachment = (await hub.store.snapshot("owner", conversation.id)).messages.flatMap(message => message.blocks).find(block => block.type === "file");
    expect(attachment).toBeDefined();
    const download = await hub.attachments.download({ userId: "owner" }, attachment!.attachmentId);
    expect(await readFile(download.path, "utf8")).toBe("selected project report");
    await hub.store.updateConversation("owner", conversation.id, { sessionId: "missing_native" });
    await expect(channel.runCron!(job)).rejects.toThrow("session_not_found_on_instance");
    expect(adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    expect((await sessions.findByConversationKey(`lark:${conversation.id}`))?.codexSessionId).toBe("selected_native");
  } finally { await channel.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
