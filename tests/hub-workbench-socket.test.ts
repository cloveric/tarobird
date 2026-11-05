import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { HubServer } from '../src/hub/server.js';
import { deviceProof, hashSecret } from '../src/hub/auth.js';
import { nodeFrameReader } from '../src/client-protocol/fragments-node.js';
import { WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY } from '../src/client-protocol/workbench.js';
import { GatewayChannel } from '../src/gateway/channel.js';
import { GatewayTransport } from '../src/gateway/transport.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY } from '../src/client-protocol/workbench-design.js';
import { WORKBENCH_HISTORY_LIMITS } from '../src/hub/workbench-history.js';
class Peer {
  frames: any[]=[];
  constructor(readonly ws:WebSocket) { const reader=nodeFrameReader(); ws.on('message',raw=>{const frame=reader.read(raw.toString()); if(frame)this.frames.push(frame);}); }
  static async connect(url:string) {const peer=new Peer(new WebSocket(url)); await new Promise<void>((r,j)=>{peer.ws.once('open',r);peer.ws.once('error',j);});return peer;}
  send(frame:object) {this.ws.send(JSON.stringify({v:1,...frame}));}
  async next(type:string) {return until(()=>{const i=this.frames.findIndex(f=>f.type===type);return i<0?undefined:this.frames.splice(i,1)[0];});}
}
async function until<T>(fn:()=>T|undefined|Promise<T|undefined>) {const deadline=Date.now()+4000;for(;;){const value=await fn();if(value!==undefined)return value;if(Date.now()>deadline)throw Error('timed_out');await new Promise(r=>setTimeout(r,5));}}
describe('workbench signed socket and API boundary',()=>{
  let dir:string,hub:HubServer,conversationId:string,peer:Peer,token:string; const peers:Peer[]=[];const channels:GatewayChannel[]=[];const secret='workbench-fixture-'+ 'a'.repeat(40);
  beforeEach(async()=>{dir=await mkdtemp(path.join(os.tmpdir(),'workbench-socket-'));hub=await HubServer.start({stateDir:dir});await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Bot',?,'codex')",[hashSecret(secret)]);conversationId=(await hub.store.createConversation('owner',['bot'],'Workbench','create')).id;const auth=await client('desktop');peer=auth.peer;token=auth.token;});
  afterEach(async()=>{for(const channel of channels.splice(0))await channel.disconnect();for(const p of peers.splice(0))p.ws.terminate();await hub.close();await rm(dir,{recursive:true,force:true});});
  async function client(deviceId:string,capabilities=[WORKBENCH_CAPABILITY]) {const keys=generateKeyPairSync('ed25519');const pair=await hub.auth.pair({deviceId,name:deviceId,platform:'web',publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')},'127.0.0.1');await hub.auth.approve(pair.code,'local-owner');const peer=await Peer.connect(hub.url.replace(/^http/,'ws')+'/ws');peers.push(peer);const nonce=randomBytes(32).toString('base64url');peer.send({type:'hello',deviceId,nonce,protocolVersions:[1],capabilities,cursors:{}});const c=await peer.next('challenge');peer.send({type:'auth',signature:sign(null,deviceProof(deviceId,c.nonce,nonce),keys.privateKey).toString('base64')});const ready=await peer.next('ready');await peer.next('sync.complete');return {peer,token:ready.sessionToken as string,serverCapabilities:ready.serverCapabilities as string[]};}
  function api(url:string,body?:unknown,bearer=token){return fetch(hub.url+url,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  function instanceApi(route:string,body:unknown,botId='bot',key=secret){return fetch(hub.instanceUrl+'/api/instance'+route,{method:'POST',headers:{Authorization:`Instance ${botId}:${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});}
  async function register(){peer.send({type:'workbench.register',registration:{windowId:'window',generation:'generation',conversationId,capabilities:['whiteboard.v1'],tabs:[{id:'board',kind:'whiteboard',title:'Board'}],activeTabId:'board',visible:true}});await until(async()=>{const r=await api(`/api/conversations/${conversationId}/workbench/targets`);return (await r.json()).length===1?true:undefined;});}
  it('authenticates the target device immediately before applying and waits for the App save receipt',async()=>{
    await register();const other=await client('phone');
    const request={requestId:'patch',operation:'whiteboard.patch',expectedRevision:1,payload:{ops:[]}};
    const reply=api(`/api/conversations/${conversationId}/workbench/commands`,request);const frame=await peer.next('workbench.command');
    expect((await api('/api/workbench/admit',{dispatchId:frame.dispatchId},other.token)).status).toBe(404);
    expect((await api('/api/workbench/admit',{dispatchId:frame.dispatchId})).status).toBe(200);
    peer.send({type:'workbench.receipt',dispatchId:frame.dispatchId,receipt:{requestId:'patch',target:frame.target,status:'applied',saved:true,revision:2}});
    const response=await reply;expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'applied',saved:true,revision:2});
    expect(await (await api(`/api/conversations/${conversationId}/workbench/commands`,request)).json()).toMatchObject({status:'applied'});
  });
  it('freezes signed message context and rejects unsupported clients or spoofed windows',async()=>{
    await register();const context={target:{deviceId:'desktop',windowId:'window',tabId:'board'},kind:'whiteboard'};
    peer.send({type:'message.send',conversationId,clientMsgId:'msg_context',text:'Edit',attachments:[],workbench:context});
    const ack=await peer.next('message.ack');const meta=await hub.store.db.get<{value:string}>("SELECT value FROM meta WHERE key=?",[`workbench-context:${ack.messageId}`]);expect(JSON.parse(meta!.value)).toEqual(context);
    peer.send({type:'message.send',conversationId,clientMsgId:'spoof',text:'Edit',attachments:[],workbench:{...context,target:{deviceId:'foreign',windowId:'window'}}});expect((await peer.next('error')).code).toBe('workbench_target_unavailable');
    const old=await client('old',[]);old.peer.send({type:'workbench.register',registration:{windowId:'old',generation:'g',conversationId,capabilities:[],tabs:[],visible:true}});expect((await old.peer.next('error')).code).toBe('workbench_capability_required');
  });
  it('advertises markdown notes to App clients and Bot gateways and accepts a note registration',async()=>{
    const app=await client('notes-app');expect(app.serverCapabilities).toEqual(expect.arrayContaining([WORKBENCH_CAPABILITY,WORKBENCH_MARKDOWN_CAPABILITY]));
    const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);worker.send({type:'instance.hello',botId:'bot',secret,engine:'kimi',model:'',effort:'',capabilities:[]});
    expect((await worker.next('instance.ready')).capabilities).toEqual(expect.arrayContaining([WORKBENCH_CAPABILITY,WORKBENCH_MARKDOWN_CAPABILITY]));
    peer.send({type:'workbench.register',registration:{windowId:'window',generation:'notes',conversationId,capabilities:['whiteboard.v1','markdown.v1'],tabs:[{id:'board',kind:'whiteboard',title:'Board'},{id:'note',kind:'markdown',title:'Note',revision:0}],activeTabId:'note',visible:true}});
    const targets=await until(async()=>{const list=await(await api(`/api/conversations/${conversationId}/workbench/targets`)).json();return list.length===1&&list[0].capabilities.includes('markdown.v1')?list:undefined;});
    expect(targets[0]).toMatchObject({activeTabId:'note',tabs:expect.arrayContaining([expect.objectContaining({id:'note',kind:'markdown'})])});
  });
  // Use the actual Gateway transport/channel/tool. Calling the instance API
  // directly bypasses capability negotiation and missed the 1.0.123 regression.
  it.each(['deepseek', 'codex', 'claude', 'kimi', 'antigravity'])('%s Design and PPT tools pass the real handshake and wait for the exact App receipt', async engine => {
    const app = await client('design-capability-check');
    expect(app.serverCapabilities).toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(app.serverCapabilities).toContain(WORKBENCH_SLIDES_CAPABILITY);
    const target = { deviceId: 'desktop', windowId: 'design-window', tabId: 'design-tab' };
    peer.send({ type: 'workbench.register', registration: { windowId: target.windowId, generation: 'design-generation', conversationId, capabilities: ['design.v1', 'design.slides.v1'], tabs: [{ id: target.tabId, kind: 'design', title: 'Design', revision: 0 }], activeTabId: target.tabId, visible: true } });
    await until(async () => (await (await api(`/api/conversations/${conversationId}/workbench/targets`)).json()).length === 1 || undefined);
    const stateDir = path.join(dir, 'worker');
    const transport = new GatewayTransport({ url: hub.instanceUrl.replace(/^http/, 'ws') + '/instance', botId: 'bot', secret, stateDir, engine });
    const channel = new GatewayChannel(transport); channels.push(channel);
    const responses: any[] = [], failures: unknown[] = [];
    channel.on('error', error => { failures.push(error); });
    channel.on('message', async () => {
      try {
        const signal = new AbortController().signal;
        const tools = createAppPlatformTools({ channel, stateDir, conversationId, receipts: new GatewayReceipts(stateDir), signal });
        for (const request of [
          { requestId: 'design-read', operation: 'design.read', target, payload: {} },
          { requestId: 'design-publish', operation: 'design.publish', target, expectedRevision: 0, payload: { files: { 'project/Main.dc.html': { content: '<x-dc>Updated</x-dc>', contentType: 'text/html' } } } },
          { requestId: 'slides-create', operation: 'design.create', target: { deviceId: target.deviceId, windowId: target.windowId }, payload: { title: 'Slides', format: 'slides' } },
        ]) {
          const result = await tools.call({ name: 'app_workbench', arguments: request, callId: request.requestId, sessionId: 'design-session', abortSignal: signal });
          responses.push(JSON.parse(result.text));
          if (result.isError) break;
        }
      } catch (error) { failures.push(error); }
    });
    await channel.connect();
    await until(() => transport.capabilities.includes(WORKBENCH_CAPABILITY) || undefined);
    peer.send({ type: 'message.send', conversationId, clientMsgId: 'design-native-tool-turn', text: 'Update this design', attachments: [], workbench: { target, kind: 'design', revision: 0 } });
    const sourceMessageId = (await peer.next('message.ack')).messageId;
    await until(() => responses.length > 0 || failures.length > 0 || peer.frames.some(frame => frame.type === 'workbench.command') || undefined);
    expect(failures).toEqual([]);
    expect(responses[0]?.error).toBeUndefined();
    expect(transport.capabilities).toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(transport.capabilities).toContain(WORKBENCH_SLIDES_CAPABILITY);
    const reading = await peer.next('workbench.command');
    expect(reading).toMatchObject({ conversationId, target, request: { operation: 'design.read', contextMessageId: sourceMessageId } });
    expect(responses).toEqual([]);
    expect((await api('/api/workbench/admit', { dispatchId: reading.dispatchId })).status).toBe(200);
    peer.send({ type: 'workbench.receipt', dispatchId: reading.dispatchId, receipt: { requestId: 'design-read', target, status: 'success', revision: 0, result: { title: 'Design' } } });
    const publishing = await peer.next('workbench.command');
    expect(publishing).toMatchObject({ conversationId, target, request: { operation: 'design.publish', contextMessageId: sourceMessageId, expectedRevision: 0 } });
    expect(responses).toHaveLength(1);
    expect((await api('/api/workbench/admit', { dispatchId: publishing.dispatchId })).status).toBe(200);
    peer.send({ type: 'workbench.receipt', dispatchId: publishing.dispatchId, receipt: { requestId: 'design-publish', target, status: 'applied', saved: true, revision: 1 } });
    const creating = await peer.next('workbench.command');
    expect(creating).toMatchObject({ conversationId, target: { deviceId: target.deviceId, windowId: target.windowId }, request: { operation: 'design.create', contextMessageId: sourceMessageId, payload: { title: 'Slides', format: 'slides' } } });
    expect(responses).toHaveLength(2);
    expect((await api('/api/workbench/admit', { dispatchId: creating.dispatchId })).status).toBe(200);
    peer.send({ type: 'workbench.receipt', dispatchId: creating.dispatchId, receipt: { requestId: 'slides-create', target: creating.target, status: 'applied', saved: true, revision: 0, result: { tabId: 'slides-tab' } } });
    await until(() => responses.length === 3 || failures.length > 0 || undefined);
    expect(failures).toEqual([]);
    expect(responses).toEqual([
      expect.objectContaining({ requestId: 'design-read', status: 'success', target, revision: 0 }),
      expect.objectContaining({ requestId: 'design-publish', status: 'applied', target, saved: true, revision: 1 }),
      expect.objectContaining({ requestId: 'slides-create', status: 'applied', saved: true, revision: 0, result: { tabId: 'slides-tab' } }),
    ]);
  });
  it('returns only the exact authored message context through authenticated human and Bot APIs',async()=>{
    await register();const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);worker.send({type:'instance.hello',botId:'bot',secret,engine:'kimi',model:'',effort:'',capabilities:[]});await worker.next('instance.ready');
    const context={target:{deviceId:'desktop',windowId:'window',tabId:'board'},selection:Array.from({length:256},(_,i)=>`frozen_${i}`),revision:2};
    peer.send({type:'message.send',conversationId,clientMsgId:'context-api',text:'Use sent selection',attachments:[],workbench:context});const message=(await worker.next('instance.message')).message;
    const params={conversationId,contextMessageId:message.id};
    expect(await(await api(`/api/conversations/${conversationId}/workbench/context`,{contextMessageId:message.id})).json()).toEqual(context);
    expect(await(await instanceApi('/workbench',{method:'workbench.context',params})).json()).toEqual(context);
    expect((await instanceApi('/workbench',{method:'workbench.context',params},'bot','wrong'.repeat(8))).status).toBe(401);
    expect((await api(`/api/conversations/${conversationId}/workbench/context`,{contextMessageId:message.id},'invalid')).status).toBe(401);
    const other=(await hub.store.createConversation('owner',['bot'],'Other','other-context')).id;
    expect(await(await instanceApi('/workbench',{method:'workbench.context',params:{...params,conversationId:other}})).json()).toMatchObject({error:'workbench_context_forbidden'});
    await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')");await hub.store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','guest')",[conversationId]);
    const foreign=(await hub.store.sendMessage('guest',{conversationId,clientMsgId:'guest-context',text:'Guest source',attachments:[],workbench:context})).message;
    expect(await(await api(`/api/conversations/${conversationId}/workbench/context`,{contextMessageId:foreign.id})).json()).toMatchObject({error:'workbench_context_forbidden'});
    await hub.store.acknowledgeDelivery('bot',message.id);
    expect(await(await instanceApi('/workbench',{method:'workbench.context',params})).json()).toMatchObject({error:'workbench_turn_ended'});
  });
  for (const pull of [false,true]) it(`keeps chat usable at capacity and rejects remembered targets in the omitted ${pull ? 'queued' : 'pushed'} turn`,async()=>{
    await register();
    const target={deviceId:'desktop',windowId:'window',tabId:'board'};
    const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);
    worker.send({type:'instance.hello',botId:'bot',secret,engine:'codex',model:'',effort:'',capabilities:pull?['prompt-queue.v1','prompt-queue.pull.v1']:[]});await worker.next('instance.ready');
    const receive=async(id:string)=>{if(!pull)return worker.next('instance.message');worker.send({type:'instance.request',id,method:'queue.take',params:{conversationId}});const answer=await worker.next('instance.result');expect(answer.error).toBeUndefined();return answer.result;};
    peer.send({type:'message.send',conversationId,clientMsgId:'prior-context',text:'Earlier board',attachments:[],workbench:{target}});await peer.next('message.ack');
    const previous=await receive('take-prior');expect(previous.workbench.target).toEqual(target);
    worker.send({type:'instance.request',id:'finish-prior',method:'ack',params:{messageId:previous.message.id}});await worker.next('instance.result');
    await hub.store.db.run('UPDATE meta SET value=? WHERE key=?',[JSON.stringify({entries:WORKBENCH_HISTORY_LIMITS.maxEntries,bytes:1000,cleanedAt:Date.now()}),'workbench-history-budget-v1']);
    const frame={type:'message.send',conversationId,clientMsgId:'full-budget',text:'Please send this',attachments:[],workbench:{target}};
    peer.send(frame);
    const ack=await peer.next('message.ack');expect(ack).toMatchObject({clientMsgId:frame.clientMsgId,workbenchContextOmitted:'history_limit'});
    const incoming=await receive('take-omitted');expect(incoming.message.id).toBe(ack.messageId);expect(incoming.workbench).toBeUndefined();expect(incoming.workbenchContextOmitted).toBe('history_limit');
    expect(await(await api(`/api/conversations/${conversationId}/workbench/context`,{contextMessageId:ack.messageId})).json()).toMatchObject({error:'workbench_context_unavailable'});
    expect(await(await instanceApi('/workbench',{method:'workbench.context',params:{conversationId,contextMessageId:ack.messageId}})).json()).toMatchObject({error:'workbench_context_unavailable'});
    expect(await(await instanceApi('/workbench/publish',{conversationId,contextMessageId:ack.messageId,requestId:'omitted-publish',widget:{title:'No stale target',summary:'Omitted',html:'<p>Must not publish</p>'}})).json()).toMatchObject({error:'workbench_context_unavailable'});
    for(const explicit of [true,false]){
      worker.send({type:'instance.request',id:`recalled-${explicit}`,method:'workbench.command',params:{conversationId,contextMessageId:ack.messageId,request:{requestId:`recalled-${explicit}`,operation:'whiteboard.patch',expectedRevision:1,payload:{ops:[{op:'delete',id:'old-element'}]},...(explicit?{target:previous.workbench.target}:{})}}});
      expect(await worker.next('instance.result')).toMatchObject({id:`recalled-${explicit}`,error:'workbench_context_unavailable'});
    }
    expect(peer.frames.filter(frame=>frame.type==='workbench.command')).toEqual([]);
    peer.send(frame);expect(await peer.next('message.ack')).toEqual(ack);
    expect(await hub.store.db.get<{n:number}>('SELECT COUNT(*) AS n FROM deliveries WHERE message_id=?',[ack.messageId])).toEqual({n:1});
  });
  it('only lets a currently dispatched Bot turn act for the actual user author',async()=>{
    await register();const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);worker.send({type:'instance.hello',botId:'bot',secret,engine:'codex',model:'',effort:'',capabilities:[]});await worker.next('instance.ready');
    peer.send({type:'message.send',conversationId,clientMsgId:'user_turn',text:'Read the board',attachments:[],workbench:{target:{deviceId:'desktop',windowId:'window',tabId:'board'}}});
    const message=(await worker.next('instance.message')).message;
    worker.send({type:'instance.request',id:'call',method:'workbench.command',params:{conversationId,contextMessageId:message.id,request:{requestId:'read',operation:'whiteboard.read'}}});const frame=await peer.next('workbench.command');
    worker.send({type:'instance.request',id:'ack',method:'ack',params:{messageId:message.id}});expect((await worker.next('instance.result')).id).toBe('ack');
    const admission=await api('/api/workbench/admit',{dispatchId:frame.dispatchId});expect(admission.status).toBe(409);expect(await admission.json()).toMatchObject({error:'workbench_turn_ended'});
    const result=await worker.next('instance.result');expect(result.id).toBe('call');expect(result.error).toBe('workbench_turn_ended');
  });
  it('uploads a real generated file through the source-bound Instance route without leaking authorization fields into the strict upload schema',async()=>{
    const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);worker.send({type:'instance.hello',botId:'bot',secret,engine:'codex',model:'',effort:'',capabilities:[]});await worker.next('instance.ready');
    peer.send({type:'message.send',conversationId,clientMsgId:'image_turn',text:'Edit this picture',attachments:[]});
    const message=(await worker.next('instance.message')).message;
    const bytes=Buffer.from('real generated image bytes'), headers={Authorization:`Instance bot:${secret}`};
    const body={contextMessageId:message.id,conversationId,name:'generated.png',mime:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    const created=await fetch(hub.instanceUrl+'/api/instance/workbench/uploads',{method:'POST',headers,body:JSON.stringify(body)});
    expect(created.status).toBe(201);const upload=await created.json();
    const status=await fetch(hub.instanceUrl+`/api/instance/uploads/${upload.id}`,{headers});expect(status.status).toBe(200);expect(await status.json()).toMatchObject({complete:false,chunks:[]});
    expect((await fetch(hub.instanceUrl+`/api/instance/uploads/${upload.id}/0`,{method:'PUT',headers,body:bytes})).status).toBe(200);
    expect((await fetch(hub.instanceUrl+`/api/instance/uploads/${upload.id}/complete`,{method:'POST',headers})).status).toBe(200);
    expect(await hub.store.db.get('SELECT owner_id,conversation_id,complete FROM attachments WHERE id=?',[upload.id])).toEqual({owner_id:'owner',conversation_id:conversationId,complete:1});
    worker.send({type:'instance.request',id:'finish-image-turn',method:'ack',params:{messageId:message.id}});await worker.next('instance.result');
    expect((await fetch(hub.instanceUrl+'/api/instance/workbench/uploads',{method:'POST',headers,body:JSON.stringify(body)})).status).toBe(409);
  });
  it('publishes a source-bound CLI widget with real source, deduplication and no owner or cross-Bot authority',async()=>{
    const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);worker.send({type:'instance.hello',botId:'bot',secret,engine:'antigravity',model:'',effort:'',capabilities:[]});await worker.next('instance.ready');
    peer.send({type:'message.send',conversationId,clientMsgId:'publish-source',text:'Show a chart',attachments:[]});const message=(await worker.next('instance.message')).message;
    const input={conversationId,contextMessageId:message.id,requestId:'chart-publication',widget:{title:'Chart',summary:'Real values',html:'<p>First chart</p>'}};
    const first=await instanceApi('/workbench/publish',input);expect(first.status).toBe(200);const receipt=await first.json();
    expect(receipt).toMatchObject({delivered:true,conversationId,authorType:'bot',source:{messageId:receipt.messageId,blockIndex:0,version:1}});
    const published=await hub.store.messageForBot('bot',receipt.messageId);expect(published.replyTo).toBe(message.id);expect(published.blocks[0]).toMatchObject({type:'card',title:'Chart'});
    expect(await(await instanceApi('/workbench/publish',input)).json()).toEqual(receipt);
    const changed=await instanceApi('/workbench/publish',{...input,widget:{...input.widget,summary:'Changed'}});expect(changed.status).toBe(409);expect(await changed.json()).toMatchObject({error:'idempotency_conflict'});
    expect(await hub.store.db.get('SELECT COUNT(*) AS n FROM messages WHERE author_type=\'bot\' AND reply_to=?',[message.id])).toEqual({n:1});
    const other=(await hub.store.createConversation('owner',['bot'],'Other','publish-other')).id;
    expect(await(await instanceApi('/workbench/publish',{...input,conversationId:other})).json()).toMatchObject({error:'workbench_context_forbidden'});
    const secondSecret='second-'+ 'b'.repeat(40);await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('other_bot','Other',?,'kimi')",[hashSecret(secondSecret)]);
    expect((await instanceApi('/workbench/publish',input,'other_bot',secondSecret)).status).toBe(403);
    expect((await instanceApi('/workbench/publish',{...input,authorId:'other_bot'})).status).toBe(400);
    const settings=await(await api('/api/settings/widgets')).json();
    expect((await fetch(hub.url+'/api/settings/widgets',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({enabled:false,revision:settings.revision,requestId:'disable-for-publish'})})).status).toBe(200);
    const disabled=await instanceApi('/workbench/publish',{...input,requestId:'disabled-new'});expect(disabled.status).toBe(409);expect(await disabled.json()).toMatchObject({error:'widgets_disabled'});
    // A successful existing publication can be read back without republishing.
    expect(await(await instanceApi('/workbench/publish',input)).json()).toEqual(receipt);
    // Replaying an old publication must not silently acquire a later message version, even with identical blocks.
    await hub.store.publishBotMessage('bot',{id:receipt.messageId,conversationId,replyTo:message.id,blocks:published.blocks,version:2,status:'complete'});
    expect(await(await instanceApi('/workbench/publish',input)).json()).toMatchObject({error:'idempotency_conflict'});
    await hub.store.acknowledgeDelivery('bot',message.id);
    expect(await(await instanceApi('/workbench/publish',input)).json()).toMatchObject({error:'workbench_turn_ended'});
  });
  it('binds Design commands to the authenticated Bot turn and refuses another conversation or an ended turn', async () => {
    const other = (await hub.store.createConversation('owner',['bot'],'Other design','other-design')).id;
    const registerDesign = (id:string,windowId:string,tabId:string) => peer.send({type:'workbench.register',registration:{windowId,generation:'design-generation',conversationId:id,capabilities:['design.v1'],tabs:[{id:tabId,kind:'design',title:tabId,revision:0}],activeTabId:tabId,visible:true}});
    registerDesign(conversationId,'design-window-a','design-a');registerDesign(other,'design-window-b','design-b');
    for(const id of [conversationId,other]) await until(async()=>{const rows=await(await api(`/api/conversations/${id}/workbench/targets`)).json();return rows.length===1?true:undefined;});
    const worker=await Peer.connect(hub.instanceUrl.replace(/^http/,'ws')+'/instance');peers.push(worker);
    worker.send({type:'instance.hello',botId:'bot',secret,engine:'codex',model:'',effort:'',capabilities:[]});await worker.next('instance.ready');
    const target={deviceId:'desktop',windowId:'design-window-a',tabId:'design-a'};
    peer.send({type:'message.send',conversationId,clientMsgId:'design-turn',text:'Edit this design',attachments:[],workbench:{target,kind:'design',revision:0}});
    const message=(await worker.next('instance.message')).message;
    const call=(request:object,id=conversationId)=>instanceApi('/workbench',{method:'workbench.command',params:{conversationId:id,contextMessageId:message.id,request:{...request,contextMessageId:message.id}}});
    expect(await(await call({requestId:'foreign-conversation',operation:'design.read',target},other)).json()).toMatchObject({error:'workbench_context_forbidden'});
    expect(await(await call({requestId:'foreign-target',operation:'design.read',target:{deviceId:'desktop',windowId:'design-window-b',tabId:'design-b'}})).json()).toMatchObject({error:'workbench_app_unavailable'});
    const files={files:{'project/Main.dc.html':{content:'<x-dc>Updated</x-dc>',contentType:'text/html'}}};
    expect(await(await call({requestId:'missing-tab',operation:'design.publish',expectedRevision:0,payload:files})).json()).toMatchObject({error:'workbench_target_required'});
    expect(peer.frames.filter(frame=>frame.type==='workbench.command')).toEqual([]);
    const reply=call({requestId:'exact-design',operation:'design.publish',target,expectedRevision:0,payload:files});
    const frame=await peer.next('workbench.command');expect(frame).toMatchObject({conversationId,target,request:{operation:'design.publish'}});
    expect((await api('/api/workbench/admit',{dispatchId:frame.dispatchId})).status).toBe(200);
    peer.send({type:'workbench.receipt',dispatchId:frame.dispatchId,receipt:{requestId:'exact-design',target,status:'applied',saved:true,revision:1}});
    expect(await(await reply).json()).toMatchObject({status:'applied',saved:true,target});
    const create={requestId:'created-design',operation:'design.create',target:{deviceId:'desktop',windowId:'design-window-a'},payload:{title:'New design'}};
    const creating=call(create),createdFrame=await peer.next('workbench.command');
    expect(createdFrame.request.contextMessageId).toBe(message.id);
    expect((await api('/api/workbench/admit',{dispatchId:createdFrame.dispatchId})).status).toBe(200);
    peer.send({type:'workbench.receipt',dispatchId:createdFrame.dispatchId,receipt:{requestId:create.requestId,target:create.target,status:'applied',saved:true,revision:0,result:{tabId:'new-design'}}});
    expect(await(await creating).json()).toMatchObject({status:'applied',result:{tabId:'new-design'}});
    expect(await(await call(create)).json()).toMatchObject({status:'applied',result:{tabId:'new-design'}});
    expect(peer.frames.filter(frame=>frame.type==='workbench.command')).toEqual([]);
    await hub.store.acknowledgeDelivery('bot',message.id);
    expect(await(await call({requestId:'ended-design',operation:'design.read',target})).json()).toMatchObject({error:'workbench_turn_ended'});
    expect(peer.frames.filter(frame=>frame.type==='workbench.command')).toEqual([]);
  });

});
