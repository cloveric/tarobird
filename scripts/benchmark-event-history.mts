/** Isolated, bounded storage benchmark. Never accepts a live state directory. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HubStore } from '../src/hub/store.js';
import { HubAttachments } from '../src/hub/attachments.js';
import { HubMaintenance } from '../src/hub/maintenance.js';
import { DEFAULT_EVENT_HISTORY_POLICY, EventHistoryRetention } from '../src/hub/event-history.js';
import { databaseSpace, reclaimDatabasePages, compactOfflineDatabase } from '../src/hub/storage-space.js';
import { updateBackupSettings } from '../src/hub/backup-settings.js';
const destination=process.argv[2];if(!destination)throw new Error('Pass a JSON report destination; fixtures use os.tmpdir only.');
const defaults=process.argv.includes('--default-policy'),updates=defaults?7000:1800;
const directory=await mkdtemp(path.join(os.tmpdir(),'event-history-benchmark-'));
let store=await HubStore.open(directory);let peak=0,poll:ReturnType<typeof setInterval>|undefined;
const bytes=async(file:string)=>stat(file).then(s=>s.size,()=>0);
const footprint=async()=>{const n=(await Promise.all(['hub.sqlite','hub.sqlite-wal','hub.sqlite-shm','snapshot.sqlite'].map(p=>bytes(path.join(directory,p))))).reduce((a,b)=>a+b,0);peak=Math.max(peak,n);return n;};
const report:Record<string,unknown>={format:1,synthetic:true};
try {
 await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture','synthetic')");
 const chat=await store.createConversation('owner',['fixture'],'Synthetic storage','create');
 const attachments=new HubAttachments(store,directory);await attachments.initialize();
 const contents=Buffer.from('synthetic attachment payload'),sha256=createHash('sha256').update(contents).digest('hex');
 const file=await attachments.create('owner',{conversationId:chat.id,name:'fixture.txt',mime:'text/plain',size:contents.length,sha256});
 await attachments.putChunk('owner',file.id,0,contents);await attachments.complete('owner',file.id);
 await store.sendMessage('owner',{conversationId:chat.id,clientMsgId:'with-file',text:'Keep this attachment',attachments:[file.id]});
 // Simulate a pre-existing non-auto-vacuum database; this is fixture-only.
 await store.db.exec('PRAGMA auto_vacuum=NONE; VACUUM;');
 poll=setInterval(()=>{void footprint();},20);
 const text='合成stream '.repeat(3072);let message=await store.publishBotMessage('fixture',{conversationId:chat.id,blocks:[{type:'text',text:'start'}],status:'streaming'});
 const start=performance.now();
 for(let n=0;n<updates;n++)message=await store.publishBotMessage('fixture',{conversationId:chat.id,id:message.id,blocks:[{type:'text',text:`${n} ${text}`}],status:n===updates-1?'complete':'streaming'});
 report.writeMs=performance.now()-start;await store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 report.before={space:await databaseSpace(store.db),footprint:await footprint(),events:await store.db.get("SELECT COUNT(*) rows,SUM(length(CAST(payload_json AS BLOB))) bytes FROM events WHERE kind='message.updated'")};
 const canonical=await store.db.all('SELECT * FROM messages ORDER BY id');const activity=await store.db.all('SELECT * FROM message_activity ORDER BY message_id');
 const policy=defaults?DEFAULT_EVENT_HISTORY_POLICY:{retentionDays:7,maxBytes:1024*1024,maxRows:500};
 const retention=new EventHistoryRetention(store,policy);let removed=0,cleanupMs=performance.now(),passes=0,writeDelayMax=0;
 for(;;){const r=await retention.run(Date.now(),25);removed+=r.removed;passes++;const t=performance.now();await store.db.transaction(()=>store.db.run("INSERT OR REPLACE INTO meta VALUES('benchmark-liveness',?)",[String(passes)]));writeDelayMax=Math.max(writeDelayMax,performance.now()-t);await footprint();if(r.indexed&&!r.removed)break;if(passes>500)throw new Error('retention_did_not_converge');}
 cleanupMs=performance.now()-cleanupMs;
 const after=await store.db.all('SELECT * FROM messages ORDER BY id');if(JSON.stringify(after)!==JSON.stringify(canonical))throw new Error('canonical_changed');
 if(JSON.stringify(await store.db.all('SELECT * FROM message_activity ORDER BY message_id'))!==JSON.stringify(activity))throw new Error('activity_changed');
 if(!contents.equals(await readFile(path.join(directory,'attachments',`${file.id}.blob`))))throw new Error('attachment_changed');
 await store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 report.cleanup={removed,passes,ms:cleanupMs,writeDelayMaxMs:writeDelayMax,space:await databaseSpace(store.db),footprint:await footprint(),history:await store.db.get('SELECT rows,bytes FROM event_history_state')};
 const maintenance=new HubMaintenance(store,directory);await maintenance.backup(path.join(directory,'snapshot.sqlite'));report.backupBytes=await bytes(path.join(directory,'snapshot.sqlite'));await footprint();
 const compactAt=performance.now();report.compact=await compactOfflineDatabase(store.db);report.compactMs=performance.now()-compactAt;await footprint();
 const rounds=[];
 for(let round=0;round<5;round++){
  for(let n=0;n<200;n++){
   message=await store.publishBotMessage('fixture',{conversationId:chat.id,id:message.id,blocks:[{type:'text',text:`round ${round} ${n} ${text}`}],status:n===199?'complete':'streaming'});
   if(n%25===24){await retention.run(Date.now(),200);await reclaimDatabasePages(store.db);await footprint();}
  }
  while((await retention.run(Date.now(),200)).removed){}
  for(let i=0;i<30;i++)await reclaimDatabasePages(store.db);
  rounds.push({space:await databaseSpace(store.db),history:await store.db.get('SELECT rows,bytes FROM event_history_state')});
 }
 report.rounds=rounds;report.policy=policy;
 await maintenance.dailyBackup();await updateBackupSettings(store,directory,{requestId:'off',revision:'default',retentionDays:0},'owner',async()=>{});await maintenance.dailyBackup();
 report.canonicalBeforeAfterIdentical=true;report.attachmentSha256=sha256;report.integrity=await store.db.get('PRAGMA integrity_check');
 report.peakDatabaseWalSnapshotBytes=peak;
}finally{if(poll)clearInterval(poll);await store.db.close();await rm(directory,{recursive:true,force:true});report.fixturesRemoved=true;await writeFile(destination,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
