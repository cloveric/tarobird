import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore, HubError } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import { workbenchContextSchema, workbenchReceiptSchema, type WorkbenchCommandFrame, type WorkbenchRegistration } from '../src/client-protocol/workbench.js';

describe('authenticated workbench command lifecycle', () => {
  let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, actor: WorkbenchActor, peer: WorkbenchPeer, registration: WorkbenchRegistration;
  let commands: WorkbenchCommandFrame[], revoked: boolean;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hub-workbench-'));
    store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 1500);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    conversationId = (await store.createConversation('owner', ['bot'], 'Workbench', 'new')).id;
    revoked = false; commands = [];
    actor = { userId: 'owner', conversationId, validate: async () => {} };
    peer = { key: {}, userId: 'owner', deviceId: 'device', active: () => !revoked, validate: async () => { if (revoked) throw new HubError('device_revoked', 401); }, send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } };
    registration = { windowId: 'window', generation: 'gen', conversationId, capabilities: ['whiteboard.v1', 'browser.v1', 'charts.v1'], tabs: [{ id: 'board', kind: 'whiteboard', title: 'Board', revision: 1 }], activeTabId: 'board', visible: true };
    await broker.register(peer, registration);
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, {recursive: true, force: true}); });
  async function dispatched() { for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 5)); expect(commands).toHaveLength(1); return commands[0]!; }
  async function finish(frame: WorkbenchCommandFrame, status: 'success' | 'applied' = 'success') {
    await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, { requestId: frame.request.requestId, target: frame.target, status, ...(status === 'applied' ? {saved: true, revision: 2} : {}), result: {elements: []} });
  }
  it('waits for the exact admitted App receipt and freezes the tab', async () => {
    const result = broker.request(actor, {requestId: 'read', operation: 'whiteboard.read'});
    const frame = await dispatched();
    await broker.register(peer, {...registration, activeTabId: 'other', tabs: [...registration.tabs, {id: 'other', kind: 'whiteboard', title: 'Other'}]});
    expect(frame.target.tabId).toBe('board');
    await expect(broker.receive(peer, frame.dispatchId, {requestId:'read', target:frame.target, status:'success'})).rejects.toThrow('workbench_admission_required');
    await finish(frame); expect(await result).toMatchObject({status:'success', target: {tabId:'board'}});
  });
  it('does not redirect a frozen closed target to a new active tab', async () => {
    const result = broker.request(actor, {requestId:'closed', operation:'whiteboard.read'}); await dispatched();
    await broker.register(peer, {...registration, tabs:[], activeTabId:undefined});
    expect(await result).toMatchObject({status:'not_executed', error:'workbench_target_closed'});
  });
  it('distinguishes disconnect before admission from uncertain application afterward', async () => {
    const first = broker.request(actor, {requestId:'before', operation:'whiteboard.patch', payload:{ops:[]}}); await dispatched(); broker.unregister(peer);
    expect(await first).toMatchObject({status:'not_executed'});
    commands=[]; await broker.register(peer, registration);
    const second = broker.request(actor, {requestId:'after', operation:'whiteboard.patch', payload:{ops:[]}}); const frame = await dispatched(); await broker.admit(peer,frame.dispatchId); broker.unregister(peer);
    expect(await second).toMatchObject({status:'unknown'});
  });
  it('denies other users and requires explicit selection with multiple eligible windows', async () => {
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    await store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','guest')", [conversationId]);
    expect(await broker.list({...actor,userId:'guest'})).toEqual([]);
    await expect(broker.request({...actor,userId:'guest'}, {requestId:'foreign',operation:'tabs.list',target:{deviceId:'device',windowId:'window'}})).rejects.toThrow('workbench_app_unavailable');
    await broker.register({...peer,key:{}}, {...registration, windowId:'second'});
    await expect(broker.request(actor,{requestId:'ambiguous',operation:'tabs.list'})).rejects.toThrow('workbench_target_ambiguous');
  });
  it('revocation fences pre-apply admission and rejects a foreign socket receipt', async () => {
    const result = broker.request(actor,{requestId:'revoked',operation:'whiteboard.read'}); const frame = await dispatched();
    await expect(broker.receive({...peer,key:{}}, frame.dispatchId,{requestId:'revoked',target:frame.target,status:'not_executed'})).rejects.toThrow('workbench_receipt_forbidden');
    revoked=true; await expect(broker.admit(peer,frame.dispatchId)).rejects.toThrow(); expect(await result).toMatchObject({status:'not_executed'});
  });
  it('deduplicates concurrent request IDs and retains outcome across broker restart', async () => {
    const request={requestId:'same',operation:'whiteboard.patch',payload:{ops:[]}};
    const a=broker.request(actor,request), b=broker.request(actor,request); const frame=await dispatched(); await finish(frame,'applied');
    expect(await a).toEqual(await b); expect(commands).toHaveLength(1);
    broker.close(); broker=new WorkbenchBroker(store);
    expect(await broker.request(actor,request)).toMatchObject({status:'applied',saved:true}); expect(commands).toHaveLength(1);
    await expect(broker.request(actor,{...request,payload:{ops:[{op:'delete',id:'x'}]}})).rejects.toThrow('request_id_conflict');
  });
  it('persists the tiny frozen context in the message transaction and rejects replay with a different target', async () => {
    const context=workbenchContextSchema.parse({target:{deviceId:'device',windowId:'window',tabId:'board'},kind:'whiteboard',revision:1,selection:['element']});
    await broker.validateContext('owner',conversationId,context);
    const input={conversationId,clientMsgId:'input',text:'edit this',attachments:[],workbench:context};
    const result=await store.sendMessage('owner',input); expect(await broker.contextForMessage('owner',result.message.id,conversationId)).toEqual(context);
    expect((await store.sendMessage('owner',input)).duplicate).toBe(true);
    await expect(store.sendMessage('owner',{...input,workbench:{...context,selection:[]}})).rejects.toThrow('idempotency_conflict');
    await expect(broker.validateContext('owner',conversationId,{...context,target:{deviceId:'foreign',windowId:'window'}})).rejects.toThrow('workbench_target_unavailable');
  });
  it('cancels only the same source request and consumes admission once', async () => {
    actor.sourceMessageId='source'; const pending=broker.request(actor,{requestId:'cancel',operation:'whiteboard.read'});const frame=await dispatched();
    await broker.cancelRequest({...actor,sourceMessageId:'another'},'cancel');await broker.admit(peer,frame.dispatchId);
    await expect(broker.admit(peer,frame.dispatchId)).rejects.toThrow('workbench_already_admitted');
    await broker.cancelRequest(actor,'cancel');expect(await pending).toMatchObject({status:'unknown',error:'workbench_cancelled'});
  });
  it('binds screenshot downloads to the exact successful request and originating turn', async () => {
    const attachmentId='shot';await store.db.run("INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,1,?)",[attachmentId,conversationId,'owner','a'.repeat(64),12,'image/png','shot.png','shot.blob',Date.now()]);
    actor.sourceMessageId='source';const pending=broker.request(actor,{requestId:'screenshot',operation:'browser',payload:{action:'screenshot'}});const frame=await dispatched();await broker.admit(peer,frame.dispatchId);
    await broker.receive(peer,frame.dispatchId,{requestId:'screenshot',target:frame.target,status:'success',result:{screenshot:{attachmentId,mime:'image/png',bytes:12,width:1,height:1}}});await pending;
    await expect(broker.screenshot(actor,'screenshot',attachmentId)).resolves.toBeUndefined();await expect(broker.screenshot({...actor,sourceMessageId:'other'},'screenshot',attachmentId)).rejects.toThrow('workbench_screenshot_forbidden');await expect(broker.screenshot(actor,'screenshot','unrelated')).rejects.toThrow('workbench_screenshot_forbidden');
  });
  it('rejects browser upload and inserted images from another conversation before dispatch',async()=>{
    const other=(await store.createConversation('owner',['bot'],'Other','other')).id;await store.db.run("INSERT INTO attachments VALUES('private',?,'owner',?,12,'image/png','p.png','private.blob',1,?)",[other,'a'.repeat(64),Date.now()]);
    for(const request of [{requestId:'upload',operation:'browser',payload:{action:'upload',attachmentIds:['private'],ref:'file'}},{requestId:'insert',operation:'image.insert',payload:{attachmentId:'private'}}]) expect(await broker.request(actor,request)).toMatchObject({status:'not_executed',error:'workbench_attachment_forbidden'});
    expect(commands).toEqual([]);
  });
  it('cannot claim saved application without a durable save receipt', () => {
    expect(workbenchReceiptSchema.safeParse({requestId:'x',target:{deviceId:'d',windowId:'w'},status:'applied'}).success).toBe(false);
  });
  it('keeps a saved mutation receipt at capacity and refuses new operations before dispatch',async()=>{
    broker.close();broker=new WorkbenchBroker(store,1500,{maxEntries:1,maxBytes:4096});await broker.register(peer,registration);
    const request={requestId:'retained',operation:'whiteboard.patch',payload:{ops:[]}};const first=broker.request(actor,request);await finish(await dispatched(),'applied');expect(await first).toMatchObject({status:'applied'});commands.length=0;
    expect(await broker.request(actor,{...request,requestId:'over-limit'})).toMatchObject({status:'not_executed',error:'workbench_history_limit'});expect(commands).toHaveLength(0);
    expect(await broker.request(actor,request)).toMatchObject({status:'applied',saved:true});expect(commands).toHaveLength(0);
  });
  it('requires an explicit source or quoted attachment for Bot website uploads and never lets a Bot resume user takeover',async()=>{
    for(const id of ['supplied','unreferenced'])await store.db.run("INSERT INTO attachments VALUES(?,?,'owner',?,12,'image/png','p.png',?,1,?)",[id,conversationId,'a'.repeat(64),`${id}.blob`,Date.now()]);
    const source=(await store.sendMessage('owner',{conversationId,clientMsgId:'source-file',text:'Upload this',attachments:['supplied']})).message;
    actor.sourceMessageId=source.id;
    expect(await broker.request(actor,{requestId:'unsafe-upload',operation:'browser',payload:{action:'upload',attachmentIds:['unreferenced'],ref:'file'}})).toMatchObject({status:'not_executed',error:'workbench_upload_source_required'});
    expect(await broker.request(actor,{requestId:'bot-resume',operation:'browser',payload:{action:'resume'}})).toMatchObject({status:'not_executed',error:'workbench_browser_user_action_required'});
    for (const action of ['find','stop_find','zoom','device','print','save_screenshot','history','clear_history','settings','settings_set']) {
      expect(await broker.request(actor,{requestId:`bot-tools-${action}`,operation:'browser',payload:{action}})).toMatchObject({status:'not_executed',error:'workbench_browser_user_action_required'});
    }
    expect(commands).toHaveLength(0);
    const first=broker.request(actor,{requestId:'source-upload',operation:'browser',payload:{action:'upload',attachmentIds:['supplied'],ref:'file'}});let frame=await dispatched();await broker.admit(peer,frame.dispatchId);await broker.receive(peer,frame.dispatchId,{requestId:frame.request.requestId,target:frame.target,status:'success'});expect(await first).toMatchObject({status:'success'});commands.length=0;
    const quote=(await store.sendMessage('owner',{conversationId,clientMsgId:'quoted-file',text:'Upload that file',attachments:[],replyTo:source.id})).message;
    const second=broker.request({...actor,sourceMessageId:quote.id},{requestId:'quote-upload',operation:'browser',payload:{action:'upload',attachmentIds:['supplied'],ref:'file'}});frame=await dispatched();await broker.admit(peer,frame.dispatchId);await broker.receive(peer,frame.dispatchId,{requestId:frame.request.requestId,target:frame.target,status:'failed',error:'navigation_failed'});expect(await second).toMatchObject({status:'failed'});
  });
  it('rejects guessed chart payloads with a stable source error before App dispatch',async()=>{
    for(const [index,payload] of [{messageId:'report',report:{}},{widget:{}},{source:{messageId:'report'}},{source:{messageId:'report',blockIndex:0,version:1,extra:true}}].entries()) {
      expect(await broker.request(actor,{requestId:`bad-chart-${index}`,operation:'chart.open',payload})).toMatchObject({status:'not_executed',error:'invalid_workbench_source'});
    }
    expect(await broker.request(actor,{requestId:'bad-chart-update',operation:'chart.update',payload:{source:{messageId:'report',blockIndex:0,version:1}}})).toMatchObject({status:'not_executed',error:'invalid_workbench_source'});
    expect(commands).toHaveLength(0);
  });
  it('routes Design only to its capable exact tab and requires durable mutation receipts', async () => {
    await expect(broker.request(actor,{requestId:'no-design-cap',operation:'design.create'})).rejects.toThrow('workbench_capability_unsupported');
    await broker.register(peer,{...registration,capabilities:[...registration.capabilities,'design.v1'],tabs:[...registration.tabs,{id:'design',kind:'design',title:'Design',revision:0}],activeTabId:'design'});
    expect(await broker.request(actor,{requestId:'wrong-design-kind',operation:'whiteboard.read'})).toMatchObject({status:'not_executed',error:'workbench_wrong_kind'});
    // Design reads/edits name their exact tab; the original payload/revision errors still apply.
    const designTarget={deviceId:'device',windowId:'window',tabId:'design'};
    expect(await broker.request(actor,{requestId:'missing-design-revision',operation:'design.publish',target:designTarget,payload:{files:{'project/x.txt':{content:'x'}}}})).toMatchObject({status:'not_executed',error:'workbench_revision_required'});
    expect(await broker.request(actor,{requestId:'design-path',operation:'design.read',target:designTarget,payload:{path:'project/../secret'}})).toMatchObject({status:'not_executed',error:'invalid_design_payload'});
    expect(commands).toHaveLength(0);
    const result=broker.request(actor,{requestId:'design-edit',operation:'design.publish',target:designTarget,expectedRevision:0,payload:{files:{'project/x.txt':{content:'x'}}}});
    const frame=await dispatched(); expect(frame.target.tabId).toBe('design'); await broker.admit(peer,frame.dispatchId);
    await expect(broker.receive(peer,frame.dispatchId,{requestId:'design-edit',target:frame.target,status:'success'})).rejects.toThrow('workbench_saved_receipt_required');
    await broker.receive(peer,frame.dispatchId,{requestId:'design-edit',target:frame.target,status:'applied',saved:true,revision:1});
    expect(await result).toMatchObject({status:'applied',saved:true,revision:1});
  });
  it('routes markdown notes by capability and enforces their kind, revision and payload boundary before App dispatch',async()=>{
    await expect(broker.request(actor,{requestId:'no-markdown-cap',operation:'markdown.create'})).rejects.toThrow('workbench_capability_unsupported');
    const notes:WorkbenchRegistration={...registration,capabilities:[...registration.capabilities,'markdown.v1'],tabs:[...registration.tabs,{id:'note',kind:'markdown',title:'Note',revision:3}],activeTabId:'note'};
    await broker.register(peer,notes);
    const reject=async(requestId:string,request:object,error:string)=>expect(await broker.request(actor,{requestId,...request} as never)).toMatchObject({status:'not_executed',error});
    await reject('board-on-note',{operation:'whiteboard.read'},'workbench_wrong_kind');
    await reject('browser-on-note',{operation:'browser',payload:{action:'observe'}},'workbench_wrong_kind');
    await reject('note-on-board',{operation:'markdown.patch',target:{deviceId:'device',windowId:'window',tabId:'board'},expectedRevision:1,payload:{edits:[{oldText:'a',newText:'b'}]}},'workbench_wrong_kind');
    for(const operation of ['markdown.replace','markdown.patch','markdown.undo','markdown.redo']) await reject(`${operation.replace(".","-")}-no-revision`,{operation,payload:operation==='markdown.replace'?{content:'x'}:operation==='markdown.patch'?{edits:[{oldText:'a',newText:'b'}]}:{}},'workbench_revision_required');
    const tooLarge='a'.repeat(128*1024+1);
    for(const [index,request] of ([
      {operation:'markdown.read',payload:{path:'/etc/hosts'}},{operation:'markdown.read',payload:{limit:32001}},{operation:'markdown.create',payload:{path:'/tmp/note.md'}},{operation:'markdown.create',payload:{title:'t'.repeat(129)}},
      {operation:'markdown.replace',expectedRevision:3,payload:{content:tooLarge}},{operation:'markdown.patch',expectedRevision:3,payload:{edits:[{oldText:'',newText:'x'}]}},
      {operation:'markdown.patch',expectedRevision:3,payload:{edits:[]}},{operation:'markdown.undo',expectedRevision:3,payload:{steps:2}},
    ] as const).entries()) await reject(`bad-markdown-${index}`,request,'invalid_markdown_payload');
    expect(commands).toHaveLength(0);
    await broker.register(peer,{...notes,activeTabId:undefined});
    await reject('note-without-tab',{operation:'markdown.read'},'workbench_target_required');
    expect(commands).toHaveLength(0);
    await broker.register(peer,notes);
    for(const request of [{requestId:'list-on-note',operation:'tabs.list'},{requestId:'board-create-on-note',operation:'whiteboard.create',payload:{title:'Diagram'}}] as const) {
      commands=[];const pending=broker.request(actor,request);const frame=await dispatched();expect(frame.target.tabId).toBeUndefined();
      await finish(frame,request.operation==='tabs.list'?'success':'applied');expect((await pending).status).toBe(request.operation==='tabs.list'?'success':'applied');
    }
    commands=[];const read=broker.request(actor,{requestId:'note-read',operation:'markdown.read',payload:{offset:0,limit:16000}});const frame=await dispatched();
    expect(frame.target.tabId).toBe('note');await finish(frame);expect(await read).toMatchObject({status:'success',target:{tabId:'note'}});
    const journal=await store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`workbench-command:owner:${conversationId}:note-read`]);
    expect(JSON.parse(journal!.value)).toMatchObject({readOnly:true,receipt:{status:'success'}});
  });
  it('accepts markdown changes only as saved receipts and replays a create by request identity',async()=>{
    await broker.register(peer,{...registration,capabilities:[...registration.capabilities,'markdown.v1']});
    const create={requestId:'note-create',operation:'markdown.create',payload:{title:'Notes',content:'# Notes'}} as const;
    const created=broker.request(actor,create);let frame=await dispatched();expect(frame.target.tabId).toBeUndefined();await broker.admit(peer,frame.dispatchId);
    await expect(broker.receive(peer,frame.dispatchId,{requestId:create.requestId,target:frame.target,status:'success'})).rejects.toThrow('workbench_saved_receipt_required');
    await broker.receive(peer,frame.dispatchId,{requestId:create.requestId,target:frame.target,status:'applied',saved:true,revision:0,result:{tabId:'note'}});
    expect(await created).toMatchObject({status:'applied',saved:true});
    commands=[];expect(await broker.request(actor,create)).toMatchObject({status:'applied',saved:true});expect(commands).toHaveLength(0);
    await expect(broker.request(actor,{...create,payload:{title:'Other'}})).rejects.toThrow('request_id_conflict');
    await broker.register(peer,{...registration,capabilities:[...registration.capabilities,'markdown.v1'],tabs:[...registration.tabs,{id:'note',kind:'markdown',title:'Notes',revision:0}],activeTabId:'note'});
    const patched=broker.request(actor,{requestId:'note-patch',operation:'markdown.patch',expectedRevision:0,payload:{edits:[{oldText:'# Notes',newText:'# Plan'}]}});frame=await dispatched();await broker.admit(peer,frame.dispatchId);
    await expect(broker.receive(peer,frame.dispatchId,{requestId:'note-patch',target:frame.target,status:'success'})).rejects.toThrow('workbench_saved_receipt_required');
    await broker.receive(peer,frame.dispatchId,{requestId:'note-patch',target:frame.target,status:'applied',saved:true,revision:1});
    expect(await patched).toMatchObject({status:'applied',saved:true,revision:1,target:{tabId:'note'}});
    const journal=await store.db.get<{value:string}>('SELECT value FROM meta WHERE key=?',[`workbench-command:owner:${conversationId}:note-patch`]);expect(JSON.parse(journal!.value).readOnly).toBe(false);
  });
  it('settles an admitted command by its own receipt when the App drops that Tab, and still times out without one',async()=>{
    const page={id:'page',kind:'browser',title:'Page'} as const, withPage={...registration,tabs:[...registration.tabs,page],activeTabId:'page'};
    await broker.register(peer,withPage);
    // A Bot close removes its own Tab; the App re-registers before sending the receipt.
    const closed=broker.request(actor,{requestId:'close-page',operation:'browser',target:{deviceId:'device',windowId:'window',tabId:'page'},payload:{action:'close'}});
    let frame=await dispatched();await broker.admit(peer,frame.dispatchId);
    await broker.register(peer,registration);
    await broker.receive(peer,frame.dispatchId,{requestId:'close-page',target:frame.target,status:'success',result:{status:'ok',state:'closed'}});
    expect(await closed).toMatchObject({status:'success',target:{tabId:'page'}});
    // Before admission a vanished Tab still means nothing ran.
    commands=[];await broker.register(peer,withPage);
    const early=broker.request(actor,{requestId:'early',operation:'browser',target:{deviceId:'device',windowId:'window',tabId:'page'},payload:{action:'observe'}});
    await dispatched();await broker.register(peer,registration);
    expect(await early).toMatchObject({status:'not_executed',error:'workbench_target_closed'});
    // Admitted, Tab gone and no receipt: the deadline still settles it as unknown.
    commands=[];await broker.register(peer,withPage);
    const silent=broker.request(actor,{requestId:'silent',operation:'browser',target:{deviceId:'device',windowId:'window',tabId:'page'},payload:{action:'close'}});
    frame=await dispatched();await broker.admit(peer,frame.dispatchId);await broker.register(peer,registration);
    expect(await silent).toMatchObject({status:'unknown',error:'workbench_timeout'});
  });

});
