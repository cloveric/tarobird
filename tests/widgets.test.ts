import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { widgetInputSchema, widgetBlock, readWidget, MAX_WIDGET_BYTES } from "../src/client-protocol/widget.js";
import { blocksText } from "../src/client-protocol/index.js";
import { forwardedBlocks } from "../src/client-protocol/forwarding.js";
import { validateWidget } from "../src/runtime/widget.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { appAgentInstructions, appCapabilityInstructions, appTurnInstructions } from "../src/gateway/agent-instructions.js";
import { runWidgetsCommand } from "../src/host-cli/widgets.js";
const input={title:"交付趋势",summary:"示例：周二完成 8 项。",html:"<button id='b'>查看</button><script>document.getElementById('b').onclick=()=>{};</script>"};
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
it("validates bytes and scripts without executing them, keeps fallback/quotes/forwarding readable",()=>{
  expect(validateWidget({...input,html:'<script>throw new Error("must not execute")</script>'})).toBeTruthy();
  expect(()=>validateWidget({...input,html:'<script>const x = ;</script>'})).toThrow();
  expect(()=>validateWidget({...input,html:'<script src="https://example.com/x.js"></script>'})).toThrow();
  expect(()=>validateWidget({...input,html:'<meta http-equiv="refresh" content="0;url=https://example.com">'})).toThrow();
  expect(widgetInputSchema.safeParse({...input,html:'中'.repeat(MAX_WIDGET_BYTES/2)}).success).toBe(false);
  expect(widgetInputSchema.safeParse({...input,conversationId:'victim'}).success).toBe(false);
  const block=widgetBlock(input);expect(blocksText([block])).toBe(input.title+'\n'+input.summary);
  expect(readWidget(forwardedBlocks([block],new Map())[0]!)).toEqual({...input,version:1});
  expect(readWidget({...block,extra:{widget:{version:2}}})).toBeUndefined();
});
it("native publication is current-conversation, replay-safe, cancelled/muted turns cannot publish",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'widgets-'));roots.push(root);
  const controller=new AbortController(),sendWidget=vi.fn(async(_input:unknown)=>({messageId:'msg_widget'}));
  const make=(suppressDelivery=false)=>createAppPlatformTools({stateDir:root,conversationId:'chat',replyTo:'user_input',receipts:new GatewayReceipts(root),signal:controller.signal,suppressDelivery,channel:{sendWidget,sendArtifact:vi.fn(),sendArtifactBatch:vi.fn()}});
  const call={name:'app_show_widget',arguments:input,sessionId:'session',callId:'call',abortSignal:controller.signal};
  const result=await make().call(call);expect(JSON.parse(result.text)).toMatchObject({delivered:true,messageId:'msg_widget'});
  expect(await make().call(call)).toEqual(result);expect(sendWidget).toHaveBeenCalledTimes(1);
  expect(sendWidget.mock.calls[0]?.[0]).toMatchObject({conversationId:'chat',replyTo:'user_input',widget:input});
  expect((await make().call({...call,arguments:{...input,title:'changed'}})).text).toContain('reused_with_different_arguments');
  expect((await make(true).call({...call,callId:'muted'})).text).toContain('delivery_disabled');
  controller.abort();expect((await make().call({...call,callId:'late'})).text).toContain('turn_ended');
  expect(sendWidget).toHaveBeenCalledTimes(1);
});
it("syntax failures identify the script or inline handler without executing either",async()=>{
  expect(()=>validateWidget({...input,html:'<script>const good = 1;</script><script>\nconst broken = ;</script>'})).toThrow('Widget script 2, line 2:');
  expect(()=>validateWidget({...input,html:'<button onclick="const broken = ;">Go</button>'})).toThrow('<button> onclick handler, line 1:');
  expect(validateWidget({...input,html:'<button onclick="throw new Error(\'must not execute\'); return false">Go</button>'})).toBeTruthy();
  const root=await mkdtemp(path.join(os.tmpdir(),'widget-syntax-'));roots.push(root);
  const sendWidget=vi.fn();const tools=createAppPlatformTools({stateDir:root,conversationId:'chat',receipts:new GatewayReceipts(root),signal:new AbortController().signal,channel:{sendWidget,sendArtifact:vi.fn(),sendArtifactBatch:vi.fn()}});
  const result=JSON.parse((await tools.call({name:'app_show_widget',arguments:{...input,html:'<script>\nlet x = ;</script>'},sessionId:'s',callId:'syntax',abortSignal:new AbortController().signal})).text);
  expect(result).toMatchObject({error:'invalid_widget',published:false});expect(result.detail).toContain('line 2');expect(sendWidget).not.toHaveBeenCalled();
  expect(validateWidget({...input,html:await readFile('docs/examples/widget-decision-workbench.html','utf8')})).toBeTruthy();
});
it("preserves the previous three-tool contract and provides compatibility guidance without resetting sessions",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'widget-contract-'));roots.push(root);
  const tools=createAppPlatformTools({stateDir:root,conversationId:'chat',receipts:new GatewayReceipts(root),signal:new AbortController().signal,channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),sendWidget:vi.fn()}});
  const old=structuredClone(tools.definitions.slice(0,3));(old[1]!.inputSchema.properties as any).topic.enum=(old[1]!.inputSchema.properties as any).topic.enum.filter((x:string)=>x!=='widgets');
  const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
  await mkdir(path.join(root,'app-tool-threads'));await writeFile(path.join(root,'app-tool-threads',hash('old')+'.json'),JSON.stringify({toolVersion:hash(JSON.stringify(old))}));
  const resumed=await tools.forSession!('old');expect(resumed?.definitions).toEqual(old);expect(resumed?.instructions).toContain('send.widget');expect(resumed?.instructions).not.toContain('Use app_show_widget');
  await tools.register('new');expect((await tools.forSession!('new'))?.definitions.map(x=>x.name)).toContain('app_show_widget');
  for(const engine of ['codex','claude','deepseek','kimi','antigravity'] as const){expect(appAgentInstructions({engine})).toContain('send.widget');expect(appTurnInstructions('比较本周趋势',{engine})).toContain('proactively');}
});
it("headless CLI validates before the shared API and retains the caller request ID",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'widget-cli-'));roots.push(root);const file=path.join(root,'report.html');await writeFile(file,input.html);
  const request=vi.fn(async()=>({id:'msg_one',conversationId:'chat',authorId:'owner',authorType:'user',blocks:[widgetBlock(input)],status:'complete',version:1,createdAt:1}));
  expect(await runWidgetsCommand({request},'publish','chat',{htmlFile:file,title:input.title,summary:input.summary,requestId:'request_one'})).toMatchObject({delivered:true,authorType:'user',source:{messageId:'msg_one',blockIndex:0,version:1}});
  expect(request).toHaveBeenCalledWith('/api/conversations/chat/widgets','POST',{...input,requestId:'request_one'});
  await writeFile(file,'<script>broken(</script>');await expect(runWidgetsCommand({request},'publish','chat',{htmlFile:file,title:input.title,summary:input.summary,requestId:'request_two'})).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
});
it("the shipped example is a valid self-contained widget",async()=>{expect(validateWidget({...input,html:await readFile('docs/examples/widget-release-timeline.html','utf8')})).toBeTruthy();});

it("keeps the full widget recipe on demand for native tools and out of unrelated turns",()=>{
  for(const text of ['这个比较急','帮我分析这个报错日志','对比两段函数','发布流程再走一遍','交互有点卡','Visual Studio Code','compare these two functions','帮我修一下图表组件的 bug','审计时间线的性能','Fix the chart component','review dashboard code','修复计算器的错误','debug the simulator']) {
    expect(appTurnInstructions(text) ?? '').not.toContain('128 KiB');
  }
  for(const text of ['生成趋势图','plot the memory usage trend','比较本周交付数据','画一个流程图','修好图表 bug，再画一张趋势图给我','fix the bug and show a chart of memory usage','做一个可调人数的活动预算计算器','create an interactive widget for scenario comparison','修复代码，然后做个交互组件给我试参数']) {
    expect(appTurnInstructions(text,{nativeWidgets:true}) ?? '').not.toContain('128 KiB');
    expect(appTurnInstructions(text,{nativeWidgets:false})).toContain('128 KiB');
  }
  expect(appAgentInstructions({nativeWidgets:true})).toContain('proactively');
  expect(appCapabilityInstructions('widgets')).toContain('128 KiB');
});

it("custom interaction guidance is shared without changing frozen tool definitions", async () => {
  const recipe = appCapabilityInstructions('widgets');
  expect(recipe).toContain('input[type=range]');
  expect(recipe).toContain('--chart-series-1 through --chart-series-4');
  expect(recipe).toContain('no accent means grayscale');
  expect(recipe).toContain("window's tarobot:theme event");
  expect(recipe).toContain('older clients provide distinct fallbacks');
  expect(recipe).toContain('Keep series-to-colour assignments stable');
  expect(recipe).toContain('tarobot.prompt.compose');
  expect(recipe).toContain('NOT when sent');
  expect(recipe).toContain('Local forms');
  expect(recipe).toContain('terminable Worker');
  const html = await readFile('docs/examples/widget-scenario-explorer.html','utf8');
  expect(validateWidget({ ...input, html }).html).toBe(html.trim());
});
