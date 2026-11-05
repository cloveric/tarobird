// Synthetic, read-only dashboard load. Run with: TMPDIR=/tmp/t node --import tsx scripts/benchmark-bot-dashboard.mts [receipt.json]
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readBotDashboard } from '../src/runtime/bot-dashboard.ts';
import { parseCronStoreState } from '../src/state/cron-store.ts';
import { toCronJobSnapshot } from '../src/runtime/cron-snapshot.ts';
const root = await mkdtemp(path.join(os.tmpdir(), 'dashboard-scale-')), at='2026-10-03T00:00:00.000Z';
const results=[];
try {
 await writeFile(root+'/config.json',JSON.stringify({engine:'codex',timezone:'Asia/Shanghai'}));
 for (const count of [1000,5000]) {
  const state={jobs:Array.from({length:count},(_,i)=>({id:i.toString(16).padStart(8,'0'),channel:'lark',chatId:1,userId:1,conversationKey:'lark:gw_scale',cronExpr:`${i%60} ${i%24} * * *`,timezone:i%2?'Asia/Shanghai':'UTC',prompt:'Synthetic reminder '+i,description:'Reminder '+i,createdAt:at,updatedAt:at,runHistory:Array.from({length:10},()=>({ranAt:at,success:true}))}))};
  await writeFile(root+'/cron-jobs.json',JSON.stringify(state));
  let tick=performance.now(),maxGap=0;
  const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-tick);tick=now;},5);
  const start=performance.now(); const data=await readBotDashboard(root); await delay(15); clearInterval(timer);
  const elapsed=performance.now()-start;
  assert.equal(data.cron?.length,count); assert.deepEqual(data.warnings,[]);
  const parseStart=performance.now();const jobs=parseCronStoreState(state).jobs;const parseMs=performance.now()-parseStart;
  const snapshotStart=performance.now();jobs.map(toCronJobSnapshot);const snapshotMs=performance.now()-snapshotStart;
  const result={count,bytes:Buffer.byteLength(JSON.stringify(state)),elapsedMs:Math.round(elapsed),maxEventLoopGapMs:Math.round(maxGap),parseMs:Math.round(parseMs),snapshotMs:Math.round(snapshotMs),returned:data.cron?.length,warnings:data.warnings}; results.push(result);console.log(JSON.stringify(result));
 }
 if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(results,null,2)+'\n');
} finally {await rm(root,{recursive:true,force:true});}
