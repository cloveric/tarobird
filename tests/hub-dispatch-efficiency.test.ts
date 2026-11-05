import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { HubDispatch } from '../src/hub/dispatch.js';
import { ticketOverviewListSchema } from '../src/client-protocol/dispatch.js';

let directory: string, store: HubStore, dispatch: HubDispatch;
const owner={kind:'owner' as const,userId:'owner'};
beforeEach(async()=>{
  directory=await mkdtemp(path.join(os.tmpdir(),'dispatch-efficiency-'));
  store=await HubStore.open(directory);
  dispatch=new HubDispatch(store,{source:async()=>({hostId:'host',hostName:'test'}),conversationCreated:()=>{},stop:async()=>{}});
  await store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher','fixture','codex','dispatcher'),('w','Worker','fixture','codex','worker')");
  await store.createConversation('owner',['d'],'Dispatcher','home');
  dispatch.workers={catalog:async()=>({engines:[]}),dispatchWorker:async()=> 'w',ticketWorkspace:async()=>directory};
});
afterEach(async()=>{vi.restoreAllMocks();await dispatch.stop();await store.db.close();await rm(directory,{recursive:true,force:true});});
async function working(){const t=await dispatch.create(owner,'d',{requestId:'create',title:'Task',request:'Do work'});return dispatch.dispatch(owner,'d',{requestId:'go',ticketId:t.id,engine:'codex'});}

it.each(['streaming','complete'] as const)('does not materialize %s reply bodies while delivery is pending',async status=>{
  const t=await working(),a=t.attempts[0]!;
  await store.publishBotMessage(a.botId,{conversationId:a.conversationId,replyTo:a.inputMessageId,blocks:[{type:'text',text:'x'.repeat(128*1024)}],status});
  let bytes=0;
  const all=store.db.all.bind(store.db);
  vi.spyOn(store.db,'all').mockImplementation(async(sql,params)=>{const rows=await all<Record<string,unknown>>(sql,params);for(const row of rows)if(typeof row.blocks_json==='string')bytes+=Buffer.byteLength(row.blocks_json);return rows as never;});
  await dispatch.sweep();
  expect((await dispatch.show(owner,t.id)).status).toBe('working');
  expect(bytes).toBe(0);
});

it('finds replies by input ID without walking unrelated conversation history',async()=>{
  const t=await working(),a=t.attempts[0]!;
  for(const after of [false,true]){
    const plan=await store.db.all<{detail:string}>(`EXPLAIN QUERY PLAN SELECT id,created_at,blocks_json,status FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted' ${after?'AND (created_at,id)>(?,?)':''} ORDER BY created_at,id LIMIT 32`,[a.conversationId,a.botId,a.inputMessageId,...(after?[1,'reply']:[])]);
    expect(plan.some(row=>row.detail.includes('reply_to=?'))).toBe(true);
    expect(plan.some(row=>row.detail.includes('TEMP B-TREE'))).toBe(false);
  }
});

it('settles an error after the 201st reply as failed and retains the latest result',async()=>{
  const t=await working(),a=t.attempts[0]!;
  await store.db.transaction(async()=>{
    // Equal timestamps must page by ID as well, without skipping the late error.
    for(let i=0;i<202;i++) await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,reply_to,created_at) VALUES(?,?,'w','bot',?,?,1,?,?)",[`reply_${String(i).padStart(3,'0')}`,a.conversationId,JSON.stringify([{type:'text',text:i===201?'Final test failure':'Earlier progress'}]),i===201?'error':'complete',a.inputMessageId,1]);
    await store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?",[a.inputMessageId]);
  });
  let maxBatch=0;
  const all=store.db.all.bind(store.db);
  vi.spyOn(store.db,'all').mockImplementation(async(sql,params)=>{const rows=await all<Record<string,unknown>>(sql,params);maxBatch=Math.max(maxBatch,rows.filter(row=>typeof row.blocks_json==='string').length);return rows as never;});
  await dispatch.sweep();
  expect(await dispatch.show(owner,t.id)).toMatchObject({status:'blocked',attempts:[{outcome:'failed'}]});
  expect((await dispatch.show(owner,t.id)).result).toContain('Final test failure');
  expect(maxBatch).toBeLessThanOrEqual(64);
});

it('keeps bounded latest excerpts, failure priority and a trailing reset hint across pages',async()=>{
  const t=await working(),a=t.attempts[0]!;
  await store.db.transaction(async()=>{
    for(let i=0;i<205;i++) {
      const text=i===0?'usage quota is exhausted':i===100?'sign-in is missing or expired':i===204?'Reset information: resets in 2h.':'progress'.repeat(200);
      await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,reply_to,created_at) VALUES(?,?,'w','bot',?,?,1,?,?)",[`r${i}`,a.conversationId,JSON.stringify([{type:'text',text}]),i===100?'error':'complete',a.inputMessageId,i]);
    }
    await store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?",[a.inputMessageId]);
  });
  await dispatch.sweep();
  const done=await dispatch.show(owner,t.id);
  expect(done).toMatchObject({status:'queued',attempts:[{failure:{category:'engine-quota',resetHint:'resets in 2h'}}]});
  expect(done.result).toHaveLength(4000);
  expect(done.result).toMatch(/Reset information: resets in 2h\.$/);
});

it.each(['before','after'] as const)('does not call a run completed when a partial run is beyond the old limit (%s pause)',async order=>{
  const t=await working(),a=t.attempts[0]!;
  await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?",[a.inputMessageId]);
  if(order==='after')await dispatch.action('owner',t.id,{requestId:'pause',action:'pause'});
  const run={version:1,id:'run',revision:1,phase:'partial',startedAt:1,updatedAt:2,count:0,completed:0,failed:0,truncated:false};
  await store.db.transaction(async()=>{
    for(let i=0;i<202;i++)await store.db.run("INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,reply_to,created_at) VALUES(?,?,'w','bot',?,'complete',1,?,?)",[`r${i}`,a.conversationId,JSON.stringify(i===201?[{type:'card',elements:[],extra:{nativeRun:run}}]:[{type:'text',text:'progress'}]),a.inputMessageId,i]);
    await store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?",[a.inputMessageId]);
  });
  if(order==='before')await dispatch.action('owner',t.id,{requestId:'pause',action:'pause'});
  await dispatch.sweep();
  expect(await dispatch.show(owner,t.id)).toMatchObject({status:'queued',paused:true,attempts:[{outcome:'cancelled'}]});
});

it('adds the reply index when reopening an existing database without changing tickets or schema',async()=>{
  const t=await working(),schema=await store.db.get("SELECT value FROM meta WHERE key='schema_version'");
  await store.db.exec('DROP INDEX messages_bot_replies');
  await dispatch.stop();await store.db.close();
  store=await HubStore.open(directory);
  expect(await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual(schema);
  expect(await store.db.get("SELECT name FROM sqlite_master WHERE type='index' AND name='messages_bot_replies'")).toEqual({name:'messages_bot_replies'});
  expect(await store.db.get("SELECT status FROM dispatch_tickets WHERE id=?",[t.id])).toEqual({status:'working'});
});

it('reads only overview columns while accepting a legacy full-ticket response',async()=>{
  await working();
  const full=await dispatch.list(owner,'d');
  expect(ticketOverviewListSchema.parse(full).tickets[0]).not.toHaveProperty('request');
  const all=store.db.all.bind(store.db);
  let returnedBodies=0;
  vi.spyOn(store.db,'all').mockImplementation(async(sql,params)=>{
    const rows=await all<Record<string,unknown>>(sql,params);
    returnedBodies+=rows.filter(row=> 'request' in row || 'result' in row || 'note' in row || 'attempts_json' in row).length;
    return rows as never;
  });
  expect(await dispatch.overview(owner,'d')).toEqual(ticketOverviewListSchema.parse(full));
  expect(returnedBodies).toBe(0);
  await expect(dispatch.overview({kind:'owner',userId:'not-owner'},'d')).rejects.toThrow();
  await expect(dispatch.overview(owner,'d',{open:true})).resolves.toMatchObject({tickets:[{status:'working'}]});
});


it.each(["partial", "stopped", "interrupted"] as const)("does not claim an incomplete foreground run succeeded (%s)", async phase => {
  const t = await working(), a = t.attempts[0]!;
  const run = { version: 1, id: "run", revision: 1, phase, startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false };
  await store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: "complete", blocks: [{ type: "card", elements: [{ type: "markdown", text: "Some work is preserved; usage quota is exhausted" }], extra: { nativeRun: run } }] });
  await store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?", [a.inputMessageId]);
  await dispatch.sweep();
  // Partial or interrupted work requires review, not automatic failover/replay.
  expect(await dispatch.show(owner, t.id)).toMatchObject({ status: "blocked", attempts: [{ outcome: "failed", failure: { category: "task" } }] });
  expect((await dispatch.list(owner, "d")).engines).toEqual([]);
  const notices = await store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=?", [t.conversationId]);
  expect(notices.some(row => row.blocks_json.includes("不要自动重派或重做"))).toBe(true);
});
it.each(["none", "before", "after"] as const)("allows foreground success after a handled scoped failure (%s pause)", async timing => {
  const t = await working(), a = t.attempts[0]!;
  await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [a.inputMessageId]);
  if (timing === "before") await dispatch.action("owner", t.id, { requestId: "pause", action: "pause" });
  const run = { version: 1, id: "child", revision: 1, phase: "error", startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false };
  await store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: "complete", blocks: [{ type: "card", elements: [], extra: { scopedRun: run } }] });
  await store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: "complete", blocks: [{ type: "card", elements: [{ type: "markdown", text: "Recovered and finished" }], extra: { nativeRun: { ...run, id: "parent", phase: "done" } } }] });
  await store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?", [a.inputMessageId]);
  if (timing === "after") await dispatch.action("owner", t.id, { requestId: "pause", action: "pause" });
  await dispatch.sweep();
  expect(await dispatch.show(owner, t.id)).toMatchObject({ status: "needs_review", paused: timing !== "none", attempts: [{ outcome: "completed" }] });
});

it("does not use a scoped-only success as foreground stop completion proof", async () => {
  const t = await working(), a = t.attempts[0]!;
  await store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [a.inputMessageId]);
  await dispatch.action("owner", t.id, { requestId: "pause", action: "pause" });
  const run = { version: 1, id: "child", revision: 1, phase: "done", startedAt: 1, updatedAt: 2, count: 0, completed: 0, failed: 0, truncated: false };
  await store.publishBotMessage(a.botId, { conversationId: a.conversationId, replyTo: a.inputMessageId, status: "complete", blocks: [{ type: "card", elements: [], extra: { scopedRun: run } }] });
  await store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [a.inputMessageId]);
  await dispatch.sweep();
  expect(await dispatch.show(owner, t.id)).toMatchObject({ status: "queued", paused: true, attempts: [{ outcome: "cancelled" }] });
});
