import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { HubAttachments } from "../src/hub/attachments.js";
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { HubDatabase } from '../src/hub/database.js';
import { EventHistoryRetention, eventHistoryPolicySchema } from '../src/hub/event-history.js';
import { databaseSpace, reclaimDatabasePages, compactOfflineDatabase } from '../src/hub/storage-space.js';
import { HubMaintenance } from '../src/hub/maintenance.js';
import { updateBackupSettings } from '../src/hub/backup-settings.js';
import type { SnapshotFrame } from '../src/client-protocol/snapshot.js';
let directory:string,store:HubStore;
beforeEach(async()=>{directory=await mkdtemp(path.join(os.tmpdir(),'event-history-'));store=await HubStore.open(directory);await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','synthetic')");});
afterEach(async()=>{vi.restoreAllMocks();await store.db.close();await rm(directory,{recursive:true,force:true});});
const policy={retentionDays:7,maxBytes:128*1024,maxRows:100};
const collect=()=>new EventHistoryRetention(store,policy).run(Date.now(),10_000);
async function stream(conversationId:string,count=50){
 let message=await store.publishBotMessage('bot',{conversationId,blocks:[{type:'text',text:'start'}],status:'streaming'});
 for(let i=0;i<count;i++)message=await store.publishBotMessage('bot',{conversationId,id:message.id,blocks:[{type:'text',text:`${i}:`+'流式'.repeat(4096)}],status:i===count-1?'complete':'streaming'});
 return message;
}
async function frames(id:string,after=0){const rows:SnapshotFrame[]=[];for await(const f of store.snapshotFrames('owner',id,after,{incremental:true}))rows.push(f);return rows;}
it('bounds repeated streaming history across rounds without touching messages, activity, read state or idempotency',async()=>{
 const c=await store.createConversation('owner',['bot'],'History','c');
 const input={conversationId:c.id,clientMsgId:'stable',text:'Question',attachments:[]};
 const user=await store.sendMessage('owner',input);
 const sizes:number[]=[];
 for(let round=0;round<4;round++){
  const m=await stream(c.id);
  await store.markRead('owner',c.id,(await store.syncHead('owner',c.id)).seq);
  const before=await frames(c.id);
  expect((await collect()).removed).toBeGreaterThan(0);
  expect(await frames(c.id)).toEqual(before.map(f=>f.type==='snapshot.begin'||f.type==='snapshot.message'||f.type==='snapshot.end'?expect.objectContaining({...f,id:expect.any(String)}):f));
  const total=await store.db.get<{bytes:number,rows:number}>('SELECT bytes,rows FROM event_history_state');sizes.push(total!.bytes);
  expect(total!.bytes).toBeLessThanOrEqual(policy.maxBytes);expect(total!.rows).toBeLessThanOrEqual(policy.maxRows);
  expect(await store.messageForUser('owner',m.id)).toEqual(m);
 }
 expect(await store.sendMessage('owner',input)).toMatchObject({duplicate:true,message:{id:user.message.id}});
 expect(sizes).toHaveLength(4);
},20_000);
it('uses exact snapshot deltas across sparse reclaimed ranges and preserves edits, hidden/deleted messages and head monotonicity',async()=>{
 const c=await store.createConversation('owner',['bot'],'History','c');
 const first=await stream(c.id),second=await stream(c.id);
 await store.deleteMessages('owner',c.id,{messageIds:[first.id]});
 const before=await frames(c.id),head=(await store.syncHead('owner',c.id)).seq;
 await collect();
 expect((await store.syncHead('owner',c.id)).seq).toBe(head);
 expect((await store.syncHead('owner',c.id)).firstSeq).toBeGreaterThan(2);
 await expect(store.sync('owner',c.id,1)).rejects.toThrow('sync_snapshot_required');
 expect((await store.catchupPlan('owner',c.id,1)).mergeable).toBe(true);
 const full=await frames(c.id,1);expect(full[0]).toHaveProperty('mode','merge');
 expect(full.filter(f=>f.type==='snapshot.message').map(f=>f.message)).toEqual(before.filter(f=>f.type==='snapshot.message').map(f=>f.message));
 const edited=await store.publishBotMessage('bot',{conversationId:c.id,id:second.id,blocks:[{type:'text',text:'edited'}]});
 const delta=await store.sync('owner',c.id,head);expect(delta.events).toHaveLength(1);expect(delta.events[0]!.seq).toBe(head+1);expect(delta.events[0]!.payload).toEqual(edited);
});
it('retains unknown/reaction events and latest head even when protected payloads exceed the history budget',async()=>{
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id);
 await store.appendBotEvent('bot',c.id,'reaction',{messageId:'synthetic',reactionId:'r',removed:false});
 await stream(c.id,2);const head=await store.syncHead('owner',c.id);
 await new EventHistoryRetention(store,{...policy,maxBytes:1,maxRows:1}).run(Date.now(),10_000);
 expect(await store.db.get("SELECT 1 FROM events WHERE kind='reaction'")).toBeDefined();
 expect((await store.syncHead('owner',c.id)).seq).toBe(head.seq);
 expect(await store.db.get('SELECT 1 FROM events WHERE conversation_id=? AND seq=?',[c.id,head.seq])).toBeDefined();
});
it('skips uncovered activity and refuses a destructive rebuild once history has been reclaimed',async()=>{
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id);
 await store.activityIndex.stop();
 await store.db.run('UPDATE conversation_activity SET through_seq=0 WHERE conversation_id=?',[c.id]);
 expect((await collect()).removed).toBe(0);
 await store.db.run('UPDATE conversation_activity SET through_seq=(SELECT MAX(seq) FROM events WHERE conversation_id=?) WHERE conversation_id=?',[c.id,c.id]);
 await collect();const activity=await store.db.all('SELECT * FROM message_activity');
 await store.db.run('DELETE FROM conversation_activity');
 await expect(frames(c.id)).rejects.toMatchObject({code:'history_metadata_unavailable',status:409});
 await expect(store.catchupPlan('owner',c.id,0)).rejects.toMatchObject({code:'history_metadata_unavailable',status:409});
 expect(await store.db.all('SELECT * FROM message_activity')).toEqual(activity);
});
it('rolls back floor, accounting and deletes together when a cleanup transaction fails',async()=>{
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id);
 const before=await store.db.all('SELECT * FROM events'),original=store.db.run.bind(store.db);
 const spy=vi.spyOn(store.db,'run').mockImplementation(async(sql,params)=>{const r=await original(sql,params);if(sql.startsWith('DELETE FROM events'))throw new Error('injected interruption');return r;});
 await expect(collect()).rejects.toThrow('injected interruption');spy.mockRestore();
 expect(await store.db.all('SELECT * FROM events')).toEqual(before);expect(await store.db.all('SELECT * FROM event_history_floor')).toEqual([]);
 expect((await collect()).removed).toBeGreaterThan(0);
});
it('keeps an open snapshot consistent while writes and reclamation proceed',async()=>{
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id);
 const snapshot=store.snapshotFrames('owner',c.id,0);const begin=await snapshot.next();expect(begin.value?.type).toBe('snapshot.begin');
 const old=(await store.listMessages('owner',c.id)).messages;
 const [next]=await Promise.all([stream(c.id),collect()]);
 const received=[];for await(const f of snapshot)if(f.type==='snapshot.message')received.push(f.message);
 expect(received).toEqual(old);
 const head=(begin.value as Extract<SnapshotFrame,{type:'snapshot.begin'}>).seq;
 const newer=await frames(c.id,head);expect(newer.filter(f=>f.type==='snapshot.message').map(f=>f.message.id)).toContain(next.id);
});
it('migrates old accounting in bounded resumable passes and keeps backups enabled/disabled independently',async()=>{
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id,150);
 await store.db.exec('DROP TRIGGER event_history_insert; DROP TRIGGER event_history_delete; DELETE FROM event_history; UPDATE event_history_state SET scanned_rowid=0,ready=0;');
 await store.db.close();store=await HubStore.open(directory);
 const first=await new EventHistoryRetention(store,policy).run(Date.now(),0);expect(first.indexed).toBe(false);
 await store.db.close();store=await HubStore.open(directory);await collect();
 const accounted=(await store.db.get<{bytes:number}>('SELECT bytes FROM event_history_state'))!.bytes;
 const actual=(await store.db.get<{bytes:number}>("SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) bytes FROM events WHERE kind='message.updated'"))!.bytes;expect(accounted).toBe(actual);
 const maintenance=new HubMaintenance(store,directory);await maintenance.dailyBackup();
 const backup=await HubDatabase.snapshot(path.join(directory,'backups',`auto-${new Date().toISOString().slice(0,10)}.sqlite`));
 expect(await backup.all('SELECT * FROM messages')).toEqual(await store.db.all('SELECT * FROM messages'));await backup.close();
 await updateBackupSettings(store,directory,{requestId:'off',revision:'default',retentionDays:0},'owner',async()=>{});
 await maintenance.dailyBackup();await expect(stat(path.join(directory,'backups',`auto-${new Date().toISOString().slice(0,10)}.sqlite`))).rejects.toMatchObject({code:'ENOENT'});
 expect(await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({value:'25'});
},20_000);
it('reclaims new databases incrementally and converts legacy files only through explicit offline compaction',async()=>{
 expect((await databaseSpace(store.db)).autoVacuum).toBe(2);
 const c=await store.createConversation('owner',['bot'],'c','c');await stream(c.id,150);await collect();
 const before=await databaseSpace(store.db);expect(before.freePages).toBeGreaterThan(256);
 await reclaimDatabasePages(store.db,128);expect(before.freePages-(await databaseSpace(store.db)).freePages).toBeGreaterThanOrEqual(128);
 for(let i=0;i<30;i++)await reclaimDatabasePages(store.db);
 expect((await databaseSpace(store.db)).pages).toBeLessThan(before.pages);
 await store.db.exec('PRAGMA auto_vacuum=NONE; VACUUM;');await stream(c.id,100);await collect();
 const original=await databaseSpace(store.db),messages=await store.db.all('SELECT * FROM messages');
 await expect(compactOfflineDatabase(store.db,0)).rejects.toThrow('storage_compaction_insufficient_space');expect(await databaseSpace(store.db)).toEqual(original);
 const result=await compactOfflineDatabase(store.db);expect(result.after.autoVacuum).toBe(2);expect(result.after.pages).toBeLessThan(original.pages);
 expect(await store.db.all('SELECT * FROM messages')).toEqual(messages);
 expect(await store.db.get('PRAGMA quick_check')).toEqual({quick_check:'ok'});
},20_000);
it('validates bounded configuration without changing backup defaults',()=>{
 expect(eventHistoryPolicySchema.parse({})).toEqual({retentionDays:7,maxBytes:256*1024*1024,maxRows:50_000});
 expect(()=>eventHistoryPolicySchema.parse({retentionDays:0})).toThrow();expect(()=>eventHistoryPolicySchema.parse({maxBytes:-1})).toThrow();
});

it('expires aged updates below the capacity threshold while preserving group messages and attachment bytes',async()=>{
 await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot2','Bot 2','synthetic')");
 const c=await store.createConversation('owner',['bot','bot2'],'Group','group');
 const a=new HubAttachments(store,directory);await a.initialize();const bytes=Buffer.from('retained group attachment');const sha256=createHash('sha256').update(bytes).digest('hex');
 const file=await a.create('owner',{conversationId:c.id,name:'group.txt',mime:'text/plain',size:bytes.length,sha256});
 await a.putChunk('owner',file.id,0,bytes);await a.complete('owner',file.id);
 const input={conversationId:c.id,clientMsgId:'file',text:'Group input',attachments:[file.id],mentions:['bot']};const sent=await store.sendMessage('owner',input);
 await stream(c.id,2);await store.publishBotMessage('bot2',{conversationId:c.id,blocks:[{type:'text',text:'Second reply'}]});
 await store.db.run("UPDATE events SET at=1 WHERE kind='message.updated'");const before=await frames(c.id),group=await store.groupSettings('owner',c.id);
 expect((await new EventHistoryRetention(store).run(Date.now(),10_000)).removed).toBe(2);
 expect((await frames(c.id)).filter(f=>f.type==='snapshot.message').map(f=>f.message)).toEqual(before.filter(f=>f.type==='snapshot.message').map(f=>f.message));
 expect(await store.groupSettings('owner',c.id)).toEqual(group);expect((await store.sendMessage('owner',input)).message.id).toBe(sent.message.id);
 const downloaded=await a.download({userId:'owner'},file.id);expect(downloaded).toBeDefined();
 expect(await store.db.all('SELECT * FROM message_attachments')).toHaveLength(1);
});
it('recovers atomically after a process dies between deletion and committing its replay floor',async()=>{
 const c=await store.createConversation('owner',['bot'],'Crash','crash');await stream(c.id,4);
 const before=await store.db.all('SELECT * FROM events'),accounting=await store.db.get('SELECT rows,bytes FROM event_history_state');
 await store.db.close();
 const child=spawn(process.execPath,['--import','tsx','tests/helpers/event-history-crash.mts',directory,c.id],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 try {
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('crash_fixture_timeout')),8000);child.stdout.on('data',data=>{if(String(data).includes('uncommitted-retention-ready')){clearTimeout(timeout);resolve();}});child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);if(code)reject(new Error(`fixture_exit_${code}`));});});
  const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 }finally{child.kill('SIGKILL');store=await HubStore.open(directory);}
 expect(await store.db.all('SELECT * FROM events')).toEqual(before);expect(await store.db.get('SELECT rows,bytes FROM event_history_state')).toEqual(accounting);expect(await store.db.all('SELECT * FROM event_history_floor')).toEqual([]);
 expect(await store.db.get('PRAGMA integrity_check')).toEqual({integrity_check:'ok'});
},15_000);
