import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { runWorkbenchCommand } from '../src/host-cli/workbench.js';
import { runHostCli } from '../src/host-cli/cli.js';
import { LocalHostClient } from '../src/host-cli/client.js';
import * as hubService from '../src/hub/service.js';
import { reportWidgetDefinition } from '../src/gateway/app-widget.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { GatewayTransport } from '../src/gateway/transport.js';
import { GatewayChannel } from '../src/gateway/channel.js';
import { widgetBlock } from '../src/client-protocol/widget.js';
import { workbenchInstructions, appCapabilityInstructions, appTurnInstructions } from '../src/gateway/agent-instructions.js';

describe('workbench standalone CLI and engine tools',()=>{
  let dir:string,file:string;
  beforeEach(async()=>{dir=await mkdtemp(path.join(os.tmpdir(),'workbench-tools-'));file=path.join(dir,'request.json');for(const name of ['TAROBOT_INSTANCE','TAROBOT_ACTIVE_INSTANCE','TAROBOT_MESSAGE_ID','TAROBOT_STATE_DIR','TAROBOT_ACTIVE_STATE_DIR'])vi.stubEnv(name,'');});
  afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
  it('passes the same bounded command to the authenticated local API, preserving IDs and JSON receipts',async()=>{
    const receipt={requestId:'id',status:'applied',saved:true,target:{deviceId:'d',windowId:'w'},revision:3};
    const request=vi.fn().mockResolvedValue(receipt),close=vi.fn();vi.spyOn(LocalHostClient,'connect').mockResolvedValue({request,close} as any);
    await writeFile(file,JSON.stringify({operation:'whiteboard.patch',expectedRevision:2,payload:{ops:[{op:'delete',id:'element'}]}}));
    expect(await runWorkbenchCommand(dir,'run','conv',{from:file,requestId:'id',contextMessageId:'source'})).toEqual(receipt);
    expect(request).toHaveBeenCalledWith('/api/conversations/conv/workbench/commands','POST',{requestId:'id',operation:'whiteboard.patch',expectedRevision:2,payload:{ops:[{op:'delete',id:'element'}]},contextMessageId:'source'});expect(close).toHaveBeenCalledOnce();
    await writeFile(file,JSON.stringify({operation:'tabs.list',requestId:'different'}));await expect(runWorkbenchCommand(dir,'run','conv',{from:file,requestId:'id'})).rejects.toThrow('request_id_conflict');
  });
  it('accepts the documented CLI arguments and never enrolls a controller in Bot mode',async()=>{
    vi.spyOn(console,'log').mockImplementation(()=>{});const request=vi.fn().mockResolvedValue([]);vi.spyOn(LocalHostClient,'connect').mockResolvedValue({request,close:vi.fn()} as any);
    await writeFile(path.join(dir,'config.json'),'{}');await writeFile(path.join(dir,'identity.json'),'{}');await writeFile(path.join(dir,'hub.sqlite'),'');
    await runHostCli(['workbench','targets','conv','--state-dir',dir,'--json']);expect(request).toHaveBeenCalledWith('/api/conversations/conv/workbench/targets');
    request.mockClear();vi.stubEnv('TAROBOT_ACTIVE_INSTANCE','bot');await expect(runWorkbenchCommand(dir,'targets','conv',{})).rejects.toThrow('workbench_current_context_required');expect(request).not.toHaveBeenCalled();
  });
  it('reads the exact static guide without resolving a Host directory or enrolling credentials',async()=>{
    const connect=vi.spyOn(LocalHostClient,'connect'),inspect=vi.spyOn(hubService,'inspectHubService');
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    vi.stubEnv('TAROBOT_ACTIVE_INSTANCE','bot-with-no-state');
    await runHostCli(['workbench','guide','widgets','--state-dir','/dev/null/not-a-directory','--json']);
    const guide=JSON.parse(String(log.mock.calls[0]![0]));expect(guide).toMatchObject({topic:'widgets',staticGuide:true});
    expect(guide.instructions).toContain(appCapabilityInstructions('widgets',{widgetsEnabled:true}));
    expect(guide.instructions).toContain('send.widget');expect(guide.instructions).toContain('does not return a native source receipt');expect(guide.instructions).toContain('Never guess');expect(guide.instructions).toContain('borrow owner credentials');
    expect((await runWorkbenchCommand('', 'guide','browser',{})).instructions).toContain('image.insert payload');
    await expect(runWorkbenchCommand('', 'guide','unknown',{})).rejects.toThrow('workbench_guide_topic_required');
    await expect(runWorkbenchCommand('', 'guide','widgets',{contextMessageId:'source'})).rejects.toThrow('workbench_guide_does_not_accept_request');
    expect(connect).not.toHaveBeenCalled();expect(inspect).not.toHaveBeenCalled();
  });
  it('reads human context through the authenticated API without manufacturing a missing target',async()=>{
    const request=vi.fn().mockResolvedValue(null),close=vi.fn();const connect=vi.spyOn(LocalHostClient,'connect').mockResolvedValue({request,close} as any);
    await expect(runWorkbenchCommand(dir,'context','conv',{})).rejects.toThrow('workbench_current_context_required');expect(connect).not.toHaveBeenCalled();
    expect(await runWorkbenchCommand(dir,'context','conv',{contextMessageId:'source'})).toBeNull();
    expect(request).toHaveBeenCalledWith('/api/conversations/conv/workbench/context','POST',{contextMessageId:'source'});expect(close).toHaveBeenCalledOnce();
    await expect(runWorkbenchCommand(dir,'context','conv',{contextMessageId:'source',from:file})).rejects.toThrow('workbench_context_does_not_accept_request');
  });
  it('uses only the Bot Instance credential and the exact current source for CLI context, preserving refusals',async()=>{
    const state=path.join(dir,'bots','bot');await mkdir(state,{recursive:true});await writeFile(path.join(state,'gateway.key'),'s'.repeat(40),{mode:0o600});
    vi.stubEnv('TAROBOT_ACTIVE_INSTANCE','bot');vi.stubEnv('TAROBOT_ACTIVE_STATE_DIR',state);vi.stubEnv('TAROBOT_MESSAGE_ID','source');
    const connect=vi.spyOn(LocalHostClient,'connect');vi.spyOn(hubService,'inspectHubService').mockResolvedValue({running:true,instanceUrl:'http://127.0.0.1:8123'} as any);
    const frozen={target:{deviceId:'d',windowId:'w'},selection:['on-send']};
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify(frozen),{status:200}));
    expect(await runWorkbenchCommand(dir,'context','conv',{})).toEqual(frozen);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8123/api/instance/workbench');
    const options=fetcher.mock.calls[0]![1]!;expect(options.headers).toMatchObject({Authorization:`Instance bot:${'s'.repeat(40)}`});expect(JSON.parse(options.body as string)).toEqual({method:'workbench.context',params:{conversationId:'conv',contextMessageId:'source'}});
    for(const error of ['workbench_context_unavailable','workbench_context_forbidden','workbench_turn_ended']){
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({error}),{status:409}));
      await expect(runWorkbenchCommand(dir,'context','conv',{})).rejects.toThrow(error);
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('publishes a validated widget with Bot credentials and returns the actual source without owner enrollment',async()=>{
    const state=path.join(dir,'bots','bot');await mkdir(state,{recursive:true});await writeFile(path.join(state,'gateway.key'),'s'.repeat(40),{mode:0o600});
    vi.stubEnv('TAROBOT_ACTIVE_INSTANCE','bot');vi.stubEnv('TAROBOT_ACTIVE_STATE_DIR',state);
    const connect=vi.spyOn(LocalHostClient,'connect');vi.spyOn(hubService,'inspectHubService').mockResolvedValue({running:true,instanceUrl:'http://127.0.0.1:8123'} as any);
    const widget={title:'Chart',summary:'Values',html:'<p>Chart</p>'};await writeFile(file,JSON.stringify(widget));
    const receipt={delivered:true,messageId:'published',source:{messageId:'published',blockIndex:0,version:1}};
    const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(receipt),{status:200}));
    await expect(runWorkbenchCommand(dir,'publish','conv',{from:file,requestId:'publish'})).rejects.toThrow('workbench_current_context_required');expect(fetcher).not.toHaveBeenCalled();
    expect(await runWorkbenchCommand(dir,'publish','conv',{from:file,requestId:'publish',contextMessageId:'source'})).toEqual(receipt);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://127.0.0.1:8123/api/instance/workbench/publish');
    const options=fetcher.mock.calls[0]![1]!;expect(JSON.parse(options.body as string)).toEqual({conversationId:'conv',contextMessageId:'source',requestId:'publish',widget});
    expect(options.headers).toMatchObject({Authorization:`Instance bot:${'s'.repeat(40)}`});expect(connect).not.toHaveBeenCalled();
    await writeFile(file,JSON.stringify({...widget,html:'<script>function (</script>'}));await expect(runWorkbenchCommand(dir,'publish','conv',{from:file,requestId:'invalid',contextMessageId:'source'})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
  });
  function fixture(){const workbench=vi.fn().mockResolvedValue({requestId:'id',status:'applied',saved:true,target:{deviceId:'device',windowId:'window'},revision:2});const signal=new AbortController();const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbench},stateDir:dir,conversationId:'conv',requestOutputDir:path.join(dir,'out'),workspaceOverride:dir,receipts:new GatewayReceipts(dir),signal:signal.signal});return{tools,workbench,signal};}
  it.each([['workbench_target_required','not_executed'],['connection_closed','unknown']])('reports %s without confusing a refused Design command with an uncertain delivery',async(error,status)=>{
    const h=fixture();h.workbench.mockRejectedValueOnce(new Error(error));
    const response=await h.tools.call({name:'app_workbench',arguments:{requestId:'design-target',operation:'design.publish',expectedRevision:0,payload:{files:{'project/Main.dc.html':{content:'<x-dc>Design</x-dc>',contentType:'text/html'}}}},callId:'design-target',sessionId:'session',abortSignal:h.signal.signal});
    expect(response.isError).toBe(true);const receipt=JSON.parse(response.text);
    expect(receipt).toMatchObject({requestId:'design-target',status,error});
    expect(receipt.hint).toContain(status==='not_executed'?'exact target':'Reconcile');
    expect(h.workbench).toHaveBeenCalledOnce();
  });
  it('reports the actual App receipt and rejects a recipient or source-message override',async()=>{
    const h=fixture();const call=(args:unknown)=>h.tools.call({name:'app_workbench',arguments:args,callId:'call',sessionId:'session',abortSignal:h.signal.signal});
    expect(JSON.parse((await call({requestId:'id',operation:'whiteboard.read'})).text)).toMatchObject({status:'applied',saved:true});expect(h.workbench).toHaveBeenCalledOnce();
    expect((await call({requestId:'id',operation:'whiteboard.read',contextMessageId:'foreign'})).isError).toBe(true);expect(h.workbench).toHaveBeenCalledOnce();
    h.workbench.mockResolvedValueOnce({requestId:'id',status:'applied_not_saved',saved:false,target:{deviceId:'device',windowId:'window'}} as any);expect((await call({requestId:'id',operation:'whiteboard.read'})).isError).toBe(true);
  });
  it('uploads only a verified image locally and keeps its filesystem path off the wire',async()=>{
    const imagePath=path.join(dir,'generated.png');await writeFile(imagePath,Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
    const workbenchImage=vi.fn().mockResolvedValue('att_result'),workbench=vi.fn().mockResolvedValue({requestId:'insert',status:'applied',saved:true,target:{deviceId:'d',windowId:'w',tabId:'board'}});
    const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbenchImage,workbench},stateDir:dir,conversationId:'conv',workspaceOverride:dir,receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const result=await tools.call({name:'app_workbench',arguments:{operation:'image.insert',requestId:'insert',expectedRevision:1,imagePath,payload:{originalElementId:'original'}},callId:'image',sessionId:'session',abortSignal:new AbortController().signal});
    expect(result.isError).toBeUndefined();expect(workbenchImage).toHaveBeenCalledOnce();expect(workbench.mock.calls[0]![0]).toEqual({operation:'image.insert',requestId:'insert',expectedRevision:1,payload:{originalElementId:'original',attachmentId:'att_result'}});expect(JSON.stringify(workbench.mock.calls[0]![0])).not.toContain(imagePath);
    workbench.mockClear();workbenchImage.mockRejectedValueOnce(new Error('upload_failed'));
    const failed=await tools.call({name:'app_workbench',arguments:{operation:'image.insert',requestId:'failed-upload',expectedRevision:1,imagePath},callId:'failed-image',sessionId:'session',abortSignal:new AbortController().signal});
    expect(JSON.parse(failed.text)).toMatchObject({status:'not_executed',error:'upload_failed'});expect(workbench).not.toHaveBeenCalled();
  });
  it('keeps exact v5 schemas on existing threads and gives new threads the current contract without resetting either',async()=>{
    const h=fixture();const old=h.tools.definitions.filter(tool=>tool.name!=='app_workbench').map(tool=>tool.name==='app_show_widget'?reportWidgetDefinition:tool);const version=createHash('sha256').update(JSON.stringify(old)).digest('hex');expect(version).toBe('7d3b3587387bad834274e8d04e212d0d796e98f18c274830ef321cdc3b3940ef');const dirThreads=path.join(dir,'app-tool-threads');await mkdir(dirThreads);const filename=path.join(dirThreads,createHash('sha256').update('old').digest('hex')+'.json');const record=JSON.stringify({toolVersion:version});await writeFile(filename,record);
    const restored=await h.tools.forSession!('old');expect(restored?.definitions).toEqual(old);expect(await h.tools.isRegistered('old')).toBe(true);expect(await readFile(filename,'utf8')).toBe(record);
    await h.tools.register('new');expect((await h.tools.forSession!('new'))!.definitions.some(tool=>tool.name==='app_workbench')).toBe(true);
  });
  it('never adds ephemeral commands to the transport replay journal',()=>{
    const transport=new GatewayTransport({url:'ws://127.0.0.1:1/instance',botId:'bot',secret:'x'.repeat(32),stateDir:dir});
    expect(()=>transport.enqueue('workbench.command',{})).toThrow('workbench_requires_live_request');
    const guide=workbenchInstructions('conv','source',{target:{deviceId:'d',windowId:'w'}});expect(guide).toContain('--context-message source');expect(guide).toContain('expectedRevision required');expect(guide).toContain('app_capability topic=widgets');expect(guide).not.toContain('select{ref,values:[...]}');
    const browser=appCapabilityInstructions('browser');expect(browser).toContain("type{ref,text,mode?:'replace'|'append'}");expect(browser).toContain('select{ref,values:[...]}');expect(browser).toContain('no fill/evaluate');
  });
  it('binds persistent engine callbacks to their own second turn instead of the reader first-turn async context',async()=>{
    const transport={options:{stateDir:dir,botId:'bot'},capabilities:[],refreshStatus:async()=>undefined,request:vi.fn().mockResolvedValue(null),deliverySettled:vi.fn(),reconnectAfterDeliveryFailure:vi.fn()} as unknown as GatewayTransport;
    const channel=new GatewayChannel(transport), toolsets:ReturnType<typeof createAppPlatformTools>[]=[];
    let invokeFromFirst:ReturnType<typeof AsyncLocalStorage.snapshot>|undefined;
    channel.on('error',error=>{throw error;});
    channel.on('message',async()=>{invokeFromFirst??=AsyncLocalStorage.snapshot();toolsets.push(createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbench:async()=>({requestId:'read',status:'success',target:{deviceId:'d',windowId:'w'},result:{source:channel.currentMessageId()??'missing'}})},stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal}));});
    const conversation={id:'chat',type:'direct' as const,title:'Chat',ownerId:'owner',botIds:['bot'],archived:false,createdAt:1};
    for(const [index,id] of ['first','second'].entries()){await transport.onMessage!({id,conversationId:'chat',authorId:'owner',authorType:'user',blocks:[{type:'text',text:id}],status:'complete',version:1,createdAt:1},conversation);await vi.waitFor(()=>expect(toolsets).toHaveLength(index+1));}
    expect(invokeFromFirst!(()=>channel.currentMessageId())).toBe('first');
    await toolsets[0]!.register('persistent-thread');
    const restored=await invokeFromFirst!(()=>toolsets[1]!.forSession!('persistent-thread'));
    const result=await invokeFromFirst!(()=>restored!.call({name:'app_workbench',arguments:{requestId:'read',operation:'whiteboard.read'},callId:'read',sessionId:'persistent-thread',abortSignal:new AbortController().signal}));
    expect(JSON.parse(result.text).result.source).toBe('second');
  });
  for(const queued of [false,true]) it(`does not inherit a prior target when the ${queued ? 'queued' : 'pushed'} turn context was omitted`,async()=>{
    const transport={options:{stateDir:dir,botId:'bot'},capabilities:['workbench.v1'],refreshStatus:async()=>undefined,request:vi.fn().mockResolvedValue(null),requestLive:vi.fn(),deliverySettled:vi.fn(),reconnectAfterDeliveryFailure:vi.fn(),takeQueued:vi.fn()} as unknown as GatewayTransport;
    const channel=new GatewayChannel(transport),tools:ReturnType<typeof createAppPlatformTools>[]=[],guides:string[]=[],contexts:unknown[]=[];
    let previousReader:ReturnType<typeof AsyncLocalStorage.snapshot>|undefined;
    channel.on('error',error=>{throw error;});
    channel.on('message',async()=>{
      previousReader??=AsyncLocalStorage.snapshot();
      contexts.push(await channel.workbenchContext());
      guides.push(workbenchInstructions('chat',channel.currentMessageId()!,await channel.workbenchContext(),channel.workbenchContextOmitted()));
      tools.push(createAppPlatformTools({channel,stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal}));
    });
    const conversation={id:'chat',type:'direct' as const,title:'Chat',ownerId:'owner',botIds:['bot'],archived:false,createdAt:1};
    const message=(id:string)=>({id,conversationId:'chat',authorId:'owner',authorType:'user' as const,blocks:[{type:'text' as const,text:'continue'}],status:'complete' as const,version:1,createdAt:1});
    const prior={target:{deviceId:'d',windowId:'w',tabId:'old-board'},revision:3};
    await transport.onMessage!(message('prior'),conversation,undefined,undefined,prior);await vi.waitFor(()=>expect(tools).toHaveLength(1));
    if(queued){vi.mocked(transport.takeQueued).mockResolvedValue({message:message('omitted'),conversation,workbenchContextOmitted:'history_limit'});await channel.takeQueued('chat');}
    else await transport.onMessage!(message('omitted'),conversation,undefined,undefined,undefined,'history_limit');
    await vi.waitFor(()=>expect(tools).toHaveLength(2));
    expect(contexts).toEqual([prior,undefined]);expect(guides[1]).toContain('workbenchContextOmitted');expect(guides[1]).toContain('Do not reuse a previous turn');expect(guides[1]).not.toContain('old-board');
    await tools[0]!.register('persistent');const restored=await previousReader!(()=>tools[1]!.forSession!('persistent'));
    const result=await previousReader!(()=>restored!.call({name:'app_workbench',arguments:{requestId:'old-target',operation:'whiteboard.patch',target:prior.target,expectedRevision:3,payload:{ops:[]}},callId:'old-target',sessionId:'persistent',abortSignal:new AbortController().signal}));
    expect(JSON.parse(result.text)).toMatchObject({status:'not_executed',error:'workbench_context_unavailable'});expect(transport.requestLive).not.toHaveBeenCalled();
    const capability=await previousReader!(()=>restored!.call({name:'app_capability',arguments:{topic:'widgets'},callId:'capability',sessionId:'persistent',abortSignal:new AbortController().signal}));expect(capability.text).toContain('\"operationsAllowed\":false');expect(capability.text).not.toContain('old-board');
  });

  it('documents a whiteboard recipe through the existing capability topic without changing tool schemas',()=>{
    const help=appCapabilityInstructions('widgets',{widgetsEnabled:true});
    expect(help).toContain('payload:{ops:[...]}');expect(help).toContain('Add has flat fields');expect(help).toContain('do not nest element/properties');expect(help).toContain('"operation":"whiteboard.patch"');expect(help).toContain('"expectedRevision":4');expect(help).toContain('"points":[[0,0],[100,0]]');
    expect(workbenchInstructions('chat','source')).toContain('app_capability topic=widgets');
  });

  it('bounds the actual per-turn text while returning the complete frozen selection and image materials on demand',async()=>{
    const id='x'.repeat(128);
    const frozen={target:{deviceId:id,windowId:id,tabId:id},kind:'whiteboard',revision:Number.MAX_SAFE_INTEGER,source:{messageId:id,blockIndex:255,version:Number.MAX_SAFE_INTEGER},selection:Array.from({length:256},(_,i)=>String(i).padEnd(128,'s')),imageEdit:{requestId:id,boardId:id,baseRevision:Number.MAX_SAFE_INTEGER,originalElementId:id,originalAttachmentId:id,attachmentIds:Array(16).fill(id),referenceAttachmentIds:Array(16).fill(id)}};
    const guide=workbenchInstructions(id,id,frozen);expect(guide.length).toBeLessThan(3600);expect(guide).toContain('"selectionCount":256');expect(guide).toContain('"selectionOmitted":true');expect(guide).not.toContain(frozen.selection[255]);expect(guide).toContain('not the live selection');
    const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbenchContext:async()=>frozen as any},stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const result=await tools.call({name:'app_capability',arguments:{topic:'widgets'},callId:'frozen',sessionId:'session',abortSignal:new AbortController().signal});
    expect(result.text).toContain(JSON.stringify(frozen));expect(result.text).toContain('"operation":"chart.open"');expect(result.text).toContain('"previousSource"');expect(result.text).toContain('actual publication receipt');
  });
  for(const engine of ['kimi','antigravity'] as const) it(`provides ${engine} a bounded CLI route to full contracts and frozen context`,async()=>{
    for(const widgetsEnabled of [true,false]){
      const guide=workbenchInstructions('chat','source',{target:{deviceId:'d',windowId:'w'},selection:['on-send']},undefined,{engine,widgetsEnabled});
      expect(guide).toContain(`tarobot workbench guide ${widgetsEnabled?'widgets':'browser'} --json`);expect(guide).toContain('tarobot workbench context CONVERSATION --context-message MESSAGE --json');expect(guide).toContain('tarobot workbench run chat');expect(guide).toContain('--context-message source');expect(guide).toContain('not the current selection');expect(guide).toContain('borrow owner credentials');expect(guide.length).toBeLessThan(2300);
      expect(guide).not.toContain('Allowed geometry/style');expect(guide).not.toContain('payload:{ops:[...]}');
      const details=await runWorkbenchCommand('', 'guide',widgetsEnabled?'widgets':'browser',{});expect(details.instructions).toContain('payload:{ops:[...]}');
    }
  });
  it('returns a chart source from the real saved message version and block position, retaining it on receipt replay',async()=>{
    const widget={title:'Existing report',summary:'Values',html:'<p>Actual saved report</p>'};
    const saved={id:'msg_report',conversationId:'chat',authorId:'bot',authorType:'bot',blocks:[{type:'text',text:'Earlier block'},widgetBlock(widget)],status:'complete',version:7,createdAt:1};
    const request=vi.fn().mockResolvedValue(saved);
    const transport={options:{stateDir:dir,botId:'bot'},capabilities:['workbench.v1'],request} as unknown as GatewayTransport;
    const channel=new GatewayChannel(transport);
    const tools=createAppPlatformTools({channel,stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const call={name:'app_show_widget',arguments:widget,callId:'published',sessionId:'session',abortSignal:new AbortController().signal};
    const result=await tools.call(call);expect(JSON.parse(result.text)).toMatchObject({delivered:true,messageId:'msg_report',source:{messageId:'msg_report',blockIndex:1,version:7}});
    expect(await tools.call(call)).toEqual(result);expect(request).toHaveBeenCalledOnce();
  });

  it('keeps whiteboard/image guidance and frozen context reachable through the unchanged minimal browser topic',async()=>{
    const frozen={target:{deviceId:'device',windowId:'window',tabId:'board'},revision:2,selection:['selected-on-send']};
    const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbenchContext:async()=>frozen},stateDir:dir,conversationId:'chat',options:{widgetsEnabled:false},receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const definition=tools.definitions.find(t=>t.name==='app_capability')!;
    expect(JSON.stringify(definition.inputSchema)).not.toContain('"widgets"');expect(JSON.stringify(definition.inputSchema)).toContain('"browser"');expect(tools.definitions.some(t=>t.name==='app_workbench')).toBe(true);
    const guide=workbenchInstructions('chat','source',frozen,undefined,{widgetsEnabled:false});expect(guide).toContain('app_capability topic=browser');expect(guide).not.toContain('topic=widgets');
    const result=await tools.call({name:'app_capability',arguments:{topic:'browser'},callId:'disabled-widgets-guide',sessionId:'minimal',abortSignal:new AbortController().signal});
    expect(result.isError).toBeUndefined();expect(result.text).toContain(JSON.stringify(frozen));expect(result.text).toContain('payload:{ops:[...]}');expect(result.text).toContain('image.insert payload');expect(result.text).toContain('readAppReceipt');
    // The long on-demand recipe must not inflate every native browser turn.
    const turn=appTurnInstructions('在浏览器打开网站',{nativeDelivery:true,widgetsEnabled:false});expect(turn).toContain('app_capability topic=browser');expect(turn!.length).toBeLessThan(500);expect(turn).not.toContain('Allowed geometry/style');
  });
  it('documents actual browser actions and distinguishes user takeover from revealing the page',()=>{
    const guide=appCapabilityInstructions('browser');
    for(const action of ['upload{ref,attachmentIds:[...]}','close/takeover/sleep/wake/cancel/downloads/reveal','download_cancel{download}','scroll{ref}','resume/download_open/download_reveal/clear_data/revoke_scope'])expect(guide).toContain(action);
    expect(guide).toContain('THIS user message or its explicitly quoted message');expect(guide).toContain('Never pass local paths');expect(guide).toContain('TO THE USER');expect(guide).toContain('it does not reveal downloaded files or end user takeover');expect(guide).toContain('no targetRequestId');
  });
  it('provides a receipt decoder example that handles native code-mode text and wrappers without guessing a source',()=>{
    const guide=appCapabilityInstructions('widgets',{widgetsEnabled:true});const code=/```js\n([\s\S]*?)\n```/.exec(guide)?.[1];expect(code).toBeDefined();
    const decode=new Function('raw',code+'\nreturn readAppReceipt(raw);') as (raw:unknown)=>unknown;
    const receipt={delivered:true,messageId:'msg',source:{messageId:'msg',blockIndex:2,version:7}},text=JSON.stringify(receipt);
    for(const raw of [text,{text},{success:true,contentItems:[{type:'inputText',text}]},{content:[{type:'text',text}]},receipt])expect(decode(raw)).toEqual(receipt);
    expect(()=>decode({success:true})).toThrow('Inspect the tool receipt shape');expect(guide).toContain('Do not read raw.source');expect(guide).toContain('do not send source:undefined');
  });
  it('rejects missing chart references before dispatch or image upload, including undefined source dropped by code-mode JSON',async()=>{
    const workbench=vi.fn(),workbenchImage=vi.fn();
    const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbench,workbenchImage},stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const source={messageId:'report',blockIndex:0,version:1};
    const attempts=[{operation:'chart.open',payload:{title:'Only title'}},{operation:'chart.open',payload:{source:undefined,title:'Lost source'}},{operation:'chart.open',payload:{source:{...source,unknown:true}}},{operation:'chart.update',payload:{source}},{operation:'chart.update',payload:{source,previousSource:{messageId:'older'}}}];
    for(const [i,args] of attempts.entries()){
      const wire=JSON.parse(JSON.stringify({...args,requestId:`bad-chart-${i}`,imagePath:'/must-not-be-read.png'}));
      const result=await tools.call({name:'app_workbench',arguments:wire,callId:`bad-${i}`,sessionId:'session',abortSignal:new AbortController().signal});
      expect(JSON.parse(result.text)).toMatchObject({status:'not_executed',error:'invalid_workbench_source'});expect(result.text).not.toContain('invalid_type');
    }
    expect(workbench).not.toHaveBeenCalled();expect(workbenchImage).not.toHaveBeenCalled();
  });
  it('restores both frozen v6 digests and gives only new threads the v7 markdown operations',async()=>{
    const markdown=['markdown.create','markdown.read','markdown.replace','markdown.patch','markdown.undo','markdown.redo'];
    const operations=(definitions:{name:string;inputSchema:unknown}[])=>(definitions.find(t=>t.name==='app_workbench')!.inputSchema as {properties:{operation:{enum:string[]}}}).properties.operation.enum;
    // Digests recorded before the markdown change for the full and widgets-disabled sets.
    for(const [widgetsEnabled,digest] of [[true,'0b2a7340baefc5422f1152d5912ca7bb4e83248ce4bfb29f0ae52c1c1bb9b7a2'],[false,'2f77d969c85de7db42a34987eebbc8a00a2f41c70fb883b7418329a50f7641ae']] as const){
      const stateDir=await mkdtemp(path.join(dir,'threads-'));const workbench=vi.fn().mockResolvedValue({requestId:'v6-note',status:'success',target:{deviceId:'d',windowId:'w',tabId:'note'},revision:3});
      const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn(),workbench},stateDir,conversationId:'chat',options:{widgetsEnabled},receipts:new GatewayReceipts(stateDir),signal:new AbortController().signal});
      expect(operations(tools.definitions)).toEqual(expect.arrayContaining(markdown));
      await mkdir(path.join(stateDir,'app-tool-threads'));await writeFile(path.join(stateDir,'app-tool-threads',createHash('sha256').update('v6').digest('hex')+'.json'),JSON.stringify({toolVersion:digest}));
      const v6=(await tools.forSession!('v6'))!;expect(await tools.isRegistered('v6')).toBe(true);
      expect(createHash('sha256').update(JSON.stringify(v6.definitions)).digest('hex')).toBe(digest);expect(operations(v6.definitions).some(op=>op.startsWith('markdown.'))).toBe(false);
      // The frozen schema is unchanged, yet the shared Host contract still executes a note read sent by that thread.
      expect(JSON.parse((await v6.call({name:'app_workbench',arguments:{requestId:'v6-note',operation:'markdown.read'},callId:'v6',sessionId:'v6',abortSignal:new AbortController().signal})).text)).toMatchObject({status:'success'});expect(workbench).toHaveBeenCalledOnce();
      await tools.register('v7');expect((await tools.forSession!('v7'))!.definitions).toEqual(tools.definitions);
    }
  });
  it('rejects markdown requests lacking a revision or carrying unknown/filesystem fields before dispatch',async()=>{
    const h=fixture();const call=(args:object)=>h.tools.call({name:'app_workbench',arguments:args,callId:'md',sessionId:'session',abortSignal:h.signal.signal});
    const attempts:[object,string][]=[
      [{operation:'markdown.replace',payload:{content:'# New'}},'workbench_revision_required'],[{operation:'markdown.undo'},'workbench_revision_required'],
      [{operation:'markdown.read',payload:{path:'/etc/hosts'}},'invalid_markdown_payload'],[{operation:'markdown.create',payload:{file:'/tmp/note.md'}},'invalid_markdown_payload'],[{operation:'markdown.create',payload:{title:'t'.repeat(129)}},'invalid_markdown_payload'],
      [{operation:'markdown.patch',expectedRevision:2,payload:{edits:[{oldText:'',newText:'x'}]}},'invalid_markdown_payload'],[{operation:'markdown.patch',expectedRevision:2,payload:{oldText:'a',newText:'b'}},'invalid_markdown_payload'],
    ];
    for(const [i,[args,error]] of attempts.entries()){const result=await call({...args,requestId:`bad-md-${i}`});expect(result.isError).toBe(true);expect(JSON.parse(result.text)).toMatchObject({status:'not_executed',error});expect(result.text).toContain('Nothing was dispatched');}
    expect(h.workbench).not.toHaveBeenCalled();
    const patch={requestId:'md-patch',operation:'markdown.patch',target:{deviceId:'device',windowId:'window',tabId:'note'},expectedRevision:2,payload:{edits:[{oldText:'# Old',newText:'# New'}]}};
    expect(JSON.parse((await call(patch)).text)).toMatchObject({status:'applied',saved:true});expect(h.workbench.mock.calls[0]![0]).toEqual(patch);
  });
  it('documents markdown notes in both on-demand topics, the static CLI guide and the per-turn route even with widgets disabled',async()=>{
    for(const help of [appCapabilityInstructions('browser',{widgetsEnabled:false}),appCapabilityInstructions('widgets',{widgetsEnabled:true}),(await runWorkbenchCommand('','guide','browser',{})).instructions,(await runWorkbenchCommand('','guide','widgets',{})).instructions]){
      for(const text of ["operation:'markdown.create'","operation:'markdown.read'",'markdown.replace payload:{content}','markdown.patch payload:{edits:[{oldText,newText},...]}','markdown.undo/markdown.redo','result.nextOffset','UTF-16','never splits a character pair','result.offset is the actual start','1..128 chars','exactly once','nothing changes','128 KiB','not a local file','imports/exports through the App UI','saved:true','workbench_wrong_kind'])expect(help).toContain(text);
    }
    expect(appCapabilityInstructions('widgets',{widgetsEnabled:false})).not.toContain('markdown');
    for(const widgetsEnabled of [true,false]){const turn=workbenchInstructions('chat','source',{target:{deviceId:'d',windowId:'w',tabId:'note'},kind:'markdown',revision:3},undefined,{widgetsEnabled});expect(turn).toContain('whiteboard/markdown/image');expect(turn).toContain('"kind":"markdown"');expect(turn).toContain('not local files');expect(turn).not.toContain('exactly once');expect(turn.length).toBeLessThan(2300);}
    const tools=createAppPlatformTools({channel:{sendArtifact:vi.fn(),sendArtifactBatch:vi.fn()},stateDir:dir,conversationId:'chat',options:{widgetsEnabled:false},receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
    const result=await tools.call({name:'app_capability',arguments:{topic:'browser'},callId:'md-guide',sessionId:'minimal',abortSignal:new AbortController().signal});expect(result.isError).toBeUndefined();expect(result.text).toContain('markdown.patch payload:{edits:');
    // Engines without app tools send the same request through the CLI and the Host contract.
    const request=vi.fn().mockResolvedValue({requestId:'cli-md',status:'applied',saved:true,target:{deviceId:'d',windowId:'w',tabId:'note'},revision:4});vi.spyOn(LocalHostClient,'connect').mockResolvedValue({request,close:vi.fn(),supports:(capability:string)=>capability==='workbench.markdown.v1'} as any);
    const body={operation:'markdown.patch',target:{deviceId:'d',windowId:'w',tabId:'note'},expectedRevision:3,payload:{edits:[{oldText:'- [ ] ship',newText:'- [x] ship'}]}};await writeFile(file,JSON.stringify(body));
    expect(await runWorkbenchCommand(dir,'run','conv',{from:file,requestId:'cli-md',contextMessageId:'source'})).toMatchObject({status:'applied',saved:true});
    expect(request).toHaveBeenCalledWith('/api/conversations/conv/workbench/commands','POST',{requestId:'cli-md',...body,contextMessageId:'source'});
  });
  it.each(['markdown','design'])('refuses Bot %s access before dispatch when the Host lacks that capability, leaving other workbench kinds working',async(kind)=>{
    const operation=`${kind}.read`,error=`workbench_${kind}_host_update_required`;
    const conversation={id:'chat',type:'direct' as const,title:'Chat',ownerId:'owner',botIds:['bot'],archived:false,createdAt:1};
    for(const capabilities of [['workbench.v1'],['workbench.v1',`workbench.${kind}.v1`]]){
      const requestLive=vi.fn().mockImplementation(async(_method:string,params:{request:{requestId:string}})=>({requestId:params.request.requestId,status:'success',target:{deviceId:'d',windowId:'w',tabId:'t'},revision:1}));
      const transport={options:{stateDir:dir,botId:'bot'},capabilities,refreshStatus:async()=>undefined,request:vi.fn().mockResolvedValue(null),requestLive,deliverySettled:vi.fn(),reconnectAfterDeliveryFailure:vi.fn()} as unknown as GatewayTransport;
      const channel=new GatewayChannel(transport),results:Record<string,unknown>={};channel.on('error',error=>{throw error;});
      channel.on('message',async()=>{const tools=createAppPlatformTools({channel,stateDir:dir,conversationId:'chat',receipts:new GatewayReceipts(dir),signal:new AbortController().signal});
        for(const action of [operation,'whiteboard.read'])results[action]=JSON.parse((await tools.call({name:'app_workbench',arguments:{requestId:action.replace('.','-'),operation:action},callId:action,sessionId:'s',abortSignal:new AbortController().signal})).text);});
      await transport.onMessage!({id:`turn-${kind}-${capabilities.length}`,conversationId:'chat',authorId:'owner',authorType:'user',blocks:[{type:'text',text:`read the ${kind} tab`}],status:'complete',version:1,createdAt:1},conversation);
      await vi.waitFor(()=>expect(Object.keys(results)).toHaveLength(2));
      expect(results['whiteboard.read']).toMatchObject({status:'success'});
      if(capabilities.length===1){expect(results[operation]).toMatchObject({status:'not_executed',error});expect(JSON.stringify(results[operation])).toContain('Nothing was dispatched');expect(requestLive).toHaveBeenCalledTimes(1);}
      else{expect(results[operation]).toMatchObject({status:'success'});expect(requestLive).toHaveBeenCalledTimes(2);}
    }
    const request=vi.fn();vi.spyOn(LocalHostClient,'connect').mockResolvedValue({request,close:vi.fn(),supports:()=>false} as any);
    await writeFile(file,JSON.stringify({operation,target:{deviceId:'d',windowId:'w',tabId:'tab'}}));
    await expect(runWorkbenchCommand(dir,'run','conv',{from:file,requestId:`old-host-${kind}`})).rejects.toThrow(error);expect(request).not.toHaveBeenCalled();
    expect(appCapabilityInstructions('browser')).toContain(error);
  });

});
