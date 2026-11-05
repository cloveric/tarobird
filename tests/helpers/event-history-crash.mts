import { HubStore } from '../../src/hub/store.js';
const [directory,conversationId]=process.argv.slice(2);
if(!directory || !conversationId || !directory.includes('event-history-'))throw new Error('fixture_only');
const store=await HubStore.open(directory);
await store.db.transaction(async()=>{
 const row=(await store.db.get<{seq:number}>("SELECT MIN(seq) seq FROM events WHERE conversation_id=? AND kind='message.updated'",[conversationId]))!;
 await store.db.run('INSERT INTO event_history_floor VALUES(?,?)',[conversationId,row.seq]);
 await store.db.run('DELETE FROM events WHERE conversation_id=? AND seq=?',[conversationId,row.seq]);
 process.stdout.write('uncommitted-retention-ready\n');
 await new Promise(()=>{});
});
