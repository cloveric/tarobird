// Run after npm run build. Temporary synthetic history only; removed on exit.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubStore } from '../dist/src/hub/store.js';
const directory = await mkdtemp(path.join(os.tmpdir(), 'hub-search-probe-'));
const store = await HubStore.open(directory);
try {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Fixture','fixture')");
  const c = await store.createConversation('owner', ['alpha'], 'Search performance', 'search');
  const count = 30000, body = '历史档案 ordinary project record without target. '.repeat(30);
  await store.db.transaction(async () => {
    await store.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at)
      SELECT 'fixture_'||i,?,'alpha','bot',json_array(json_object('type','text','text',?||CASE WHEN i=15000 THEN '独有检索词 abc%def' ELSE '' END)),'complete',1,i FROM n`, [count,c.id,body]);
    await store.db.exec("INSERT INTO messages_fts SELECT id,conversation_id,json_extract(blocks_json,'$[0].text') FROM messages");
  });
  const report = {count,bodyChars:body.length,plans:{},queries:[]};
  const patterns = [
    ['escaped', "SELECT message_id FROM messages_fts WHERE body LIKE ? ESCAPE '\\'", ['%独有检索词%']],
    ['indexed', 'SELECT message_id FROM messages_fts WHERE body LIKE ?', ['%独有检索词%']],
    ['literal-wildcard', "SELECT message_id FROM messages_fts WHERE body LIKE ? AND body LIKE ? ESCAPE '\\'", ['%abc%def%', '%abc\\%def%']],
  ];
  for (const [label,sql,params] of patterns) {
    report.plans[label] = await store.db.all('EXPLAIN QUERY PLAN '+sql,params);
    for(let i=0;i<3;i++) { const start=performance.now(); const rows=await store.db.all(sql,params); report.queries.push({label,ms:performance.now()-start,matches:rows.length}); }
  }
  const start = performance.now(); const search = store.search('owner','独有检索词');
  let mutationMs; const mutation = store.db.serial(async()=> { await store.db.run("INSERT INTO audit_log(at,kind,detail_json) VALUES(1,'fixture','{}')"); mutationMs=performance.now()-start; });
  const result=await search; await mutation;
  report.store={searchAndWriteMs:performance.now()-start,mutationMs,matches:result.length};
  report.pages=[];
  for (const query of ['独有检索词','历史档案','']) {
    let cursor;
    for(let page=0;page<3;page++) {
      const at=performance.now(), result=await store.searchPage('owner',query,{},cursor);
      report.pages.push({query,page:page+1,ms:performance.now()-at,matches:result.items.length,bytes:Buffer.byteLength(JSON.stringify(result)),more:!!result.nextCursor});
      if(!result.nextCursor) break;
      cursor=result.nextCursor;
    }
  }
  // A small number of large answers is enough to expose full-body response cost.
  const longBody='长回答正文'.repeat(9000)+'长文分页检索'+ '结束';
  await store.db.transaction(async () => {
    await store.db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<125)
      INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at)
      SELECT 'long_'||i,?,'alpha','bot',json_array(json_object('type','text','text',?)),'complete',1,40000+i FROM n`, [c.id,longBody]);
    await store.db.run("INSERT INTO messages_fts SELECT id,conversation_id,json_extract(blocks_json,'$[0].text') FROM messages WHERE id LIKE 'long_%'");
  });
  const legacyAt=performance.now(), legacy=await store.search('owner','长文分页检索');
  report.longLegacy={ms:performance.now()-legacyAt,matches:legacy.length,bytes:Buffer.byteLength(JSON.stringify(legacy))};
  const pageAt=performance.now(), longPage=store.searchPage('owner','长文分页检索');
  let longMutationMs;
  const longMutation=store.db.serial(async()=> { await store.db.run("INSERT INTO audit_log(at,kind,detail_json) VALUES(1,'long-search','{}')"); longMutationMs=performance.now()-pageAt; });
  const longResults=await longPage; await longMutation;
  report.longPage={ms:performance.now()-pageAt,mutationMs:longMutationMs,matches:longResults.items.length,bytes:Buffer.byteLength(JSON.stringify(longResults)),more:!!longResults.nextCursor};
  console.log(JSON.stringify(report,null,2));
} finally { await store.db.close(); await rm(directory,{recursive:true,force:true}); }
