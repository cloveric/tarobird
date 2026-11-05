import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { reportSchema, reportMetric } from '../src/client-protocol/report.js';
import { widgetBlock, readReport, readWidget } from '../src/client-protocol/widget.js';
import { validateWidget } from '../src/runtime/widget.js';
import { forwardedBlocks } from '../src/client-protocol/forwarding.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { widgetDefinition } from '../src/gateway/app-widget.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { runWidgetsCommand } from '../src/host-cli/widgets.js';
const report = {version:1 as const, columns:['Day','Items'],rows:[['Mon',2],['Tue',4],['Wed',null]], chart:{kind:'bar' as const,category:0,values:[1]},metrics:[{label:'Total',column:1,operation:'sum' as const}]};
const input={title:'Delivery',summary:'Six completed items.',report};
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it('rejects unbounded data, script-like fields, invalid indexes and nonnumeric chart values',()=>{
 expect(reportSchema.parse(report)).toEqual(report);
 for(const value of [ {...report,script:'while(true){}'}, {...report,columns:['Day']}, {...report,chart:{...report.chart,values:[0]}}, {...report,chart:{...report.chart,values:[4]}}, {...report,rows:[['Tue',Infinity]]}, {...report,rows:[['Tue','4']]}, {...report,rows:Array.from({length:61},()=>['Mon',2])}, {...report,rows:[['a'.repeat(501),2]]}, {...report,timeline:{date:0,title:1}} ])expect(reportSchema.safeParse(value).success).toBe(false);
 expect(reportMetric(report.rows,report.metrics[0])).toBe(6);
 expect(reportMetric(report.rows,{label:'Average',column:1,operation:'average'})).toBe(3);
 expect(reportMetric([['missing',null]],report.metrics[0])).toBeNull();
 expect(reportMetric([],{label:'Count',column:1,operation:'count'})).toBe(0);
 // Published reports already rely on count meaning displayed rows; nulls are missing values for the numeric aggregates only.
 expect(reportMetric(report.rows,{label:'Count',column:1,operation:'count'})).toBe(3);
 expect(reportMetric(report.rows,{label:'Minimum',column:1,operation:'min'})).toBe(2);
 expect(()=>validateWidget({...input,html:'<script>while(true){}</script>'})).toThrow();
});
it('persists typed data, escapes a useful old-reader preview, and preserves reports through forwarding',()=>{
 const block=widgetBlock({...input,report:{...report,rows:[['<img src=x onerror="alert(1)">',2]]}});
 expect(readReport(block)?.rows[0][0]).toContain('<img');
 expect(readWidget(block)?.html).toContain('&lt;img');expect(readWidget(block)?.html).not.toContain('<script');
 expect(readReport(forwardedBlocks([block],new Map())[0]!)).toEqual(readReport(block));
 expect(readReport({...block,extra:{...block.extra,report:{...report,rows:'bad'}}})).toBeUndefined();
 expect(readWidget(block)).toBeDefined();
});
it('publishes reports once via native tools and preserves the exact v4 contract on resume',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'reports-'));roots.push(root);const signal=new AbortController().signal;
 const sendWidget=vi.fn(async()=>({messageId:'msg_report'}));const tools=createAppPlatformTools({stateDir:root,conversationId:'chat',receipts:new GatewayReceipts(root),signal,channel:{sendWidget,sendArtifact:vi.fn(),sendArtifactBatch:vi.fn()}});
 const frozen=tools.definitions.filter(tool=>tool.name!=='app_workbench').map(tool=>tool.name==='app_show_widget'?widgetDefinition:tool);const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 expect(hash(JSON.stringify(frozen))).toBe('1956a5d7d9c3506dccd34de1be3248a9aa88beb8fc6989bd2c6b3bffd2871cac');
 await mkdir(path.join(root,'app-tool-threads'));await writeFile(path.join(root,'app-tool-threads',hash('v4')+'.json'),JSON.stringify({toolVersion:hash(JSON.stringify(frozen))}));
 const old=await tools.forSession!('v4');expect(old?.definitions).toEqual(frozen);expect(JSON.stringify(old?.definitions)).not.toContain('"report":');
 expect(JSON.stringify(tools.definitions)).toContain('"report":');
 const call={name:'app_show_widget',arguments:input,sessionId:'new',callId:'one',abortSignal:signal};
 const result=await tools.call(call);expect(JSON.parse(result.text).delivered).toBe(true);expect(await tools.call(call)).toEqual(result);expect(sendWidget).toHaveBeenCalledTimes(1);
});
it('CLI sends the same validated report and rejects conflicting file inputs',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'report-cli-'));roots.push(root);const file=path.join(root,'report.json');await writeFile(file,JSON.stringify(report));
 const request=vi.fn(async()=>({id:'msg_report',conversationId:'chat',authorId:'owner',authorType:'user',blocks:[widgetBlock(input)],status:'complete',version:1,createdAt:1}));
 expect(await runWidgetsCommand({request},'publish','chat',{reportFile:file,title:input.title,summary:input.summary,requestId:'one'})).toMatchObject({delivered:true});
 expect(request).toHaveBeenCalledWith('/api/conversations/chat/widgets','POST',{...input,requestId:'one'});
 await expect(runWidgetsCommand({request},'publish','chat',{reportFile:file,htmlFile:file,requestId:'two'})).rejects.toThrow('choose_html_or_report');
 await writeFile(file,JSON.stringify({...report,rows:[['Tue','bad']]}));await expect(runWidgetsCommand({request},'publish','chat',{reportFile:file,title:input.title,summary:input.summary,requestId:'three'})).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
});
