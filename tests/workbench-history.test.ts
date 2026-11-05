import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { reserveWorkbenchHistory, WORKBENCH_HISTORY_LIMITS } from '../src/hub/workbench-history.js';

let directory:string,store:HubStore,conversationId:string;
const now=Date.now(),old=now-2*86400_000;
beforeEach(async()=>{directory=await mkdtemp(path.join(os.tmpdir(),'workbench-history-'));store=await HubStore.open(directory);await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");conversationId=(await store.createConversation('owner',['bot'],'History','history')).id;});
afterEach(async()=>{vi.restoreAllMocks();await store.db.close();await rm(directory,{recursive:true,force:true});});
async function insert(key:string,value:unknown,limit={maxEntries:20_000,maxBytes:32*1024*1024}){const body=JSON.stringify(value);return store.db.transaction(async()=>{const allowed=await reserveWorkbenchHistory(store.db,key,body,limit,now);if(allowed)await store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[key,body]);return allowed;});}
it('caps both rows and reserved bytes without discarding old local mutation deduplication',async()=>{
  const value={createdAt:old,readOnly:false,fingerprint:'keep',target:{deviceId:'d',windowId:'w'},receipt:{status:'applied',saved:true}};
  expect(await insert('workbench-command:one',value,{maxEntries:2,maxBytes:8192})).toBe(true);
  expect(await insert('workbench-command:two',value,{maxEntries:2,maxBytes:8192})).toBe(true);
  expect(await insert('workbench-command:three',value,{maxEntries:2,maxBytes:8192})).toBe(false);
  expect(await store.db.get('SELECT value FROM meta WHERE key=?',['workbench-command:one'])).toBeDefined();
  expect(await insert('workbench-command:three',value,{maxEntries:3,maxBytes:8192})).toBe(false);
});
it('prunes only invalid contexts, old read-only records and fully accepted sources, retaining pending or failed sources',async()=>{
  const accepted=(await store.sendMessage('owner',{conversationId,clientMsgId:'accepted',text:'done',attachments:[]})).message;
  const pending=(await store.sendMessage('owner',{conversationId,clientMsgId:'pending',text:'active',attachments:[]})).message;
  const failed=(await store.sendMessage('owner',{conversationId,clientMsgId:'failed',text:'retryable',attachments:[]})).message;
  await store.acknowledgeDelivery('bot',accepted.id);await store.db.run("UPDATE deliveries SET status='failed' WHERE message_id=?",[failed.id]);
  for(const [key,value] of [
    ['workbench-context:missing',{target:{deviceId:'d',windowId:'w'}}],
    [`workbench-context:${pending.id}`,{target:{deviceId:'d',windowId:'w'}}],
    ['workbench-command:read',{createdAt:old,readOnly:true}],
    ['workbench-command:accepted',{createdAt:old,sourceMessageId:accepted.id}],
    ['workbench-command:pending',{createdAt:old,sourceMessageId:pending.id}],
    ['workbench-command:failed',{createdAt:old,sourceMessageId:failed.id}],
    ['workbench-command:owner',{createdAt:old,readOnly:false}],
  ] as const)await store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[key,JSON.stringify(value)]);
  expect(await insert('workbench-command:new',{createdAt:now,readOnly:false})).toBe(true);
  const rows=await store.db.all<{key:string}>('SELECT key FROM meta WHERE key GLOB ? OR key GLOB ? ORDER BY key',['workbench-context:*','workbench-command:*']);
  expect(rows.map(row=>row.key)).toEqual(['workbench-command:failed','workbench-command:new','workbench-command:owner','workbench-command:pending',`workbench-context:${pending.id}`]);
});
it('updates the accounting row without rescanning historical rows on every ordinary request and rolls back reservations atomically',async()=>{
  await insert('workbench-command:first',{createdAt:now,readOnly:false});
  const get=vi.spyOn(store.db,'get');await insert('workbench-command:second',{createdAt:now,readOnly:false});
  expect(get.mock.calls.some(([sql])=>sql.includes('SUM('))).toBe(false);
  const budget=await store.db.get('SELECT value FROM meta WHERE key=?',['workbench-history-budget-v1']);
  await expect(store.db.transaction(async()=>{await reserveWorkbenchHistory(store.db,'workbench-command:aborted','{}',undefined,now);throw Error('rollback');})).rejects.toThrow('rollback');
  expect(await store.db.get('SELECT value FROM meta WHERE key=?',['workbench-history-budget-v1'])).toEqual(budget);
});

it('sends chat without context at capacity, retaining the omission receipt and exact retry identity across restart',async()=>{
  const workbench={target:{deviceId:'desktop',windowId:'window',tabId:'board'},kind:'whiteboard' as const};
  await store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',['workbench-history-budget-v1',JSON.stringify({entries:WORKBENCH_HISTORY_LIMITS.maxEntries,bytes:1000,cleanedAt:Date.now()})]);
  const input={conversationId,clientMsgId:'full-history',text:'Send this message',attachments:[],workbench};
  const sent=await store.sendMessage('owner',input);
  expect(sent).toMatchObject({duplicate:false,workbenchContextOmitted:'history_limit'});
  expect(await store.db.get('SELECT value FROM meta WHERE key=?',[`workbench-context:${sent.message.id}`])).toBeUndefined();
  expect(await store.db.get('SELECT message_id FROM deliveries WHERE message_id=?',[sent.message.id])).toBeDefined();
  await store.db.close();store=await HubStore.open(directory);
  expect(await store.sendMessage('owner',input)).toMatchObject({duplicate:true,message:{id:sent.message.id},workbenchContextOmitted:'history_limit'});
  await expect(store.sendMessage('owner',{...input,workbench:{...workbench,title:'different target context'}})).rejects.toThrow('idempotency_conflict');
  await expect(store.sendMessage('owner',{...input,workbench:undefined})).rejects.toThrow('idempotency_conflict');
  expect(await store.db.get<{n:number}>('SELECT COUNT(*) AS n FROM messages WHERE client_msg_id=?',[input.clientMsgId])).toEqual({n:1});
});

it('retires old completed context while preserving pending and retryable deliveries and context retry identity',async()=>{
  const workbench={target:{deviceId:'desktop',windowId:'window',tabId:'board'}};
  const send=(id:string)=>store.sendMessage('owner',{conversationId,clientMsgId:id,text:id,attachments:[],workbench});
  const done=await send('done'),pending=await send('pending'),failed=await send('failed'),recent=await send('recent');
  await store.acknowledgeDelivery('bot',done.message.id);await store.acknowledgeDelivery('bot',recent.message.id);
  await store.db.run("UPDATE deliveries SET status='failed' WHERE message_id=?",[failed.message.id]);
  await store.db.run('UPDATE messages SET created_at=? WHERE id IN (?,?,?)',[old,done.message.id,pending.message.id,failed.message.id]);
  // Existing pre-fix rows have no durable digest yet; cleanup must migrate it.
  await store.db.run('UPDATE messages SET workbench_receipt_json=NULL WHERE id=?',[done.message.id]);
  await store.db.run("DELETE FROM meta WHERE key='workbench-history-budget-v1'");
  await insert('workbench-command:cleanup',{createdAt:now,readOnly:true});
  const contexts=await store.db.all<{key:string}>("SELECT key FROM meta WHERE key GLOB 'workbench-context:*'");
  expect(contexts.map(row=>row.key).sort()).toEqual([pending,recent,failed].map(r=>`workbench-context:${r.message.id}`).sort());
  expect(await send('done')).toMatchObject({duplicate:true,message:{id:done.message.id}});
  await expect(store.sendMessage('owner',{conversationId,clientMsgId:'done',text:'done',attachments:[],workbench:{...workbench,title:'changed'}})).rejects.toThrow('idempotency_conflict');
  const budget=JSON.parse((await store.db.get<{value:string}>("SELECT value FROM meta WHERE key='workbench-history-budget-v1'"))!.value);
  expect(budget.entries).toBe(4);
});

it('adds the optional receipt column when reopening an older database without losing messages',async()=>{
  const input={conversationId,clientMsgId:'before-upgrade',text:'keep me',attachments:[]};
  const original=await store.sendMessage('owner',input);
  await store.db.exec('ALTER TABLE messages DROP COLUMN workbench_receipt_json');
  await store.db.close();store=await HubStore.open(directory);
  expect(await store.sendMessage('owner',input)).toMatchObject({duplicate:true,message:{id:original.message.id}});
  const next=await store.sendMessage('owner',{...input,clientMsgId:'after-upgrade',workbench:{target:{deviceId:'d',windowId:'w'}}});
  expect((await store.db.get<{workbench_receipt_json:string}>('SELECT workbench_receipt_json FROM messages WHERE id=?',[next.message.id]))?.workbench_receipt_json).toMatch(/digest/);
});

it('persists cleanup accounting even when there is still insufficient room for the next record',async()=>{
  for(const [key,value] of [['workbench-context:gone','{}'],['workbench-command:a',JSON.stringify({createdAt:now})],['workbench-command:b',JSON.stringify({createdAt:now})]])await store.db.run('INSERT INTO meta(key,value) VALUES(?,?)',[key!,value!]);
  const limit={maxEntries:2,maxBytes:100_000};
  expect(await insert('workbench-command:denied',{createdAt:now},limit)).toBe(false);
  const budget=JSON.parse((await store.db.get<{value:string}>("SELECT value FROM meta WHERE key='workbench-history-budget-v1'"))!.value);
  expect(budget).toMatchObject({entries:2,bytes:8192});
  expect(await insert('workbench-command:denied',{createdAt:now},limit)).toBe(false);
  expect(JSON.parse((await store.db.get<{value:string}>("SELECT value FROM meta WHERE key='workbench-history-budget-v1'"))!.value)).toEqual(budget);
});
