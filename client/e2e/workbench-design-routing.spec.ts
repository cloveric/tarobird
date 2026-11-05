import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import type { WorkbenchActor, WorkbenchBroker } from '../../src/hub/workbench.js';
import type { WorkbenchRequest, WorkbenchReceipt, WorkbenchTarget } from '../../src/client-protocol/workbench.js';
import { preparePairing } from './fixtures/pairing-invite.js';
import { selectConversation, showDisconnectedBots, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
const panel = (page: Page) => page.getByRole('complementary', { name: '工作台', exact: true });
const title = (page: Page) => page.frameLocator('.workbench-design-frame:visible').frameLocator('iframe').locator('h1');
const content = (receipt: WorkbenchReceipt) => (receipt.result as { content: string }).content;
const createdTarget = (receipt: WorkbenchReceipt): WorkbenchTarget => ({ ...receipt.target, tabId: (receipt.result as {tabId: string}).tabId });
const read = (requestId: string, target?: WorkbenchTarget): WorkbenchRequest => ({ requestId, operation: 'design.read', target, payload: { path: 'project/Main.dc.html' } });
const publish = (requestId: string, target: WorkbenchTarget, revision: number, text: string): WorkbenchRequest => ({ requestId, operation: 'design.publish', target, expectedRevision: revision, payload: { files: { 'project/Main.dc.html': { content: text, contentType: 'text/html' } } } });

async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'design-routing-'));
  const hub = await HubServer.start({ stateDir: directory, clientDir: path.resolve('dist') });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','同一个设计助手','fixture')");
  const a = await hub.store.createConversation('owner', ['alpha'], '设计对话 A', 'design_a');
  const b = await hub.store.createConversation('owner', ['alpha'], '设计对话 B', 'design_b');
  for (const conversation of [a,b]) await hub.store.publishBotMessage('alpha', { conversationId: conversation.id, status: 'complete', blocks: [{ type: 'text', text: conversation.title }] });
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
  const broker = (hub as unknown as {workbench: WorkbenchBroker}).workbench;
  const actor = (conversationId: string): WorkbenchActor => ({ userId: 'owner', conversationId, validate: async () => undefined });
  const pages = [page];
  async function open(p: Page, conversation: typeof a) {
    await waitForClientOnline(p); await showDisconnectedBots(p); await selectConversation(p, conversation.title);
    if (!await panel(p).isVisible()) await p.getByRole('button', {name:'工作台',exact:true}).click();
    await expect(panel(p)).toBeVisible();
    await expect.poll(async () => (await workbenchContentTargets(broker, actor(conversation.id))).filter(w => w.visible).length).toBeGreaterThan(0);
  }
  async function another(conversation: typeof a) {
    const p = await page.context().newPage(); pages.push(p); await p.goto(hub.url); await open(p, conversation); return p;
  }
  await open(page, a);
  return {hub, a, b, broker, actor, open, another, command:(conversationId:string, request:WorkbenchRequest) => broker.request(actor(conversationId), request), close:async () => { for(const p of pages) if(!p.isClosed()) await p.close({runBeforeUnload:false}); await hub.close(); await rm(directory,{recursive:true,force:true}); }};
}

test('same Bot in two conversations uses separate Design storage, targets and request receipts', async ({page}) => {
  // Two independent editors, writes and two full reloads share this budget;
  // retain each assertion's 20 s bound instead of truncating the last reload.
  test.setTimeout(180000); const f = await fixture(page);
  try {
    const bPage = await f.another(f.b);
    const [a,b] = await Promise.all([f.command(f.a.id,{requestId:'same-create',operation:'design.create',payload:{title:'Canvas A'}}),f.command(f.b.id,{requestId:'same-create',operation:'design.create',payload:{title:'Canvas B'}})]);
    const aTarget=createdTarget(a),bTarget=createdTarget(b);
    expect(await f.command(f.a.id,{requestId:'same-create',operation:'design.create',payload:{title:'Canvas A'}})).toMatchObject({status:'applied',saved:true,result:{tabId:aTarget.tabId}});
    expect(aTarget.tabId).toBe(bTarget.tabId); expect(aTarget.windowId).not.toBe(bTarget.windowId);
    await expect(title(page)).toHaveText('Canvas A',{timeout:20000});await expect(title(bPage)).toHaveText('Canvas B',{timeout:20000});
    await expect(f.command(f.a.id,read('cross-target',bTarget))).rejects.toThrow('workbench_app_unavailable');
    const [ar,br]=await Promise.all([f.command(f.a.id,read('same-read',aTarget)),f.command(f.b.id,read('same-read',bTarget))]);
    const ap=publish('same-publish',aTarget,ar.revision!,content(ar).replace('Canvas A','Only conversation A'));
    const bp=publish('same-publish',bTarget,br.revision!,content(br).replace('Canvas B','Only conversation B'));
    const writes=await Promise.all([f.command(f.a.id,ap),f.command(f.b.id,bp)]);
    for(const result of writes)expect(result).toMatchObject({status:'applied',saved:true,revision:1});
    await expect(title(page)).toHaveText('Only conversation A',{timeout:20000});await expect(title(bPage)).toHaveText('Only conversation B',{timeout:20000});
    expect(await f.command(f.a.id,ap)).toMatchObject({status:'applied',saved:true,revision:1});
    expect(await f.command(f.b.id,bp)).toMatchObject({status:'applied',saved:true,revision:1});
    // Reopen the actual App database, not just the controller's memory.
    await page.reload();await f.open(page,f.a);await expect(title(page)).toHaveText('Only conversation A',{timeout:20000});
    await bPage.reload();await f.open(bPage,f.b);await expect(title(bPage)).toHaveText('Only conversation B',{timeout:20000});
  } finally { await f.close(); }
});

test('a frozen Design target survives tab selection and hiding a pending conversation never edits another one', async ({page}) => {
  test.setTimeout(120000);const f=await fixture(page);let release:()=>void=()=>{};const originalAdmit=f.broker.admit.bind(f.broker);
  try {
    const a=createdTarget(await f.command(f.a.id,{requestId:'first',operation:'design.create',payload:{title:'First design'}}));
    await expect(title(page)).toHaveText('First design',{timeout:20000});
    const frozen=await f.broker.validateContext('owner',f.a.id,{target:a,kind:'design'});
    const next=createdTarget(await f.command(f.a.id,{requestId:'second',operation:'design.create',payload:{title:'Second design'}}));
    await expect(title(page)).toHaveText('Second design',{timeout:20000});
    const frozenRead=await f.broker.request({...f.actor(f.a.id),context:frozen},read('frozen-read'));
    expect(frozenRead.target).toEqual(a);expect(content(frozenRead)).toContain('First design');
    const bPage=await f.another(f.b);const b=createdTarget(await f.command(f.b.id,{requestId:'third',operation:'design.create',payload:{title:'Unaffected B'}}));
    await expect(title(bPage)).toHaveText('Unaffected B',{timeout:20000});
    const before=await f.command(f.a.id,read('before-hide',next));
    let started!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
    f.broker.admit=async(peer,id)=>{started();await gate;return originalAdmit(peer,id);};
    const pending=f.command(f.a.id,publish('hidden-publish',next,before.revision!,content(before).replace('Second design','Must not be written')));
    await entered;await panel(page).getByRole('button',{name:'返回聊天',exact:true}).click();release();
    const result=await pending;expect(result.status).not.toBe('applied');expect(result.saved).not.toBe(true);
    f.broker.admit=originalAdmit;
    expect(content(await f.command(f.b.id,read('b-still-own',b)))).toContain('Unaffected B');
    await f.open(page,f.a);expect(content(await f.command(f.a.id,read('a-unchanged',next)))).toContain('Second design');
  } finally {release();f.broker.admit=originalAdmit;await f.close();}
});

test('multiple App windows require an exact Design target and stale revisions cannot overwrite another window', async ({page}) => {
  test.setTimeout(120000);const f=await fixture(page);
  try {
    const target=createdTarget(await f.command(f.a.id,{requestId:'shared',operation:'design.create',payload:{title:'Shared design'}}));
    await expect(title(page)).toHaveText('Shared design',{timeout:20000});
    const other=await f.another(f.a);await expect(title(other)).toHaveText('Shared design',{timeout:20000});
    await expect.poll(async()=>(await workbenchContentTargets(f.broker, f.actor(f.a.id))).length).toBe(2);
    await expect(f.command(f.a.id,read('ambiguous'))).rejects.toThrow('workbench_target_ambiguous');
    const windows=await workbenchContentTargets(f.broker, f.actor(f.a.id)),second=windows.find(w=>w.windowId!==target.windowId)!;
    const otherTarget={deviceId:second.deviceId,windowId:second.windowId,tabId:target.tabId};
    const original=await f.command(f.a.id,read('shared-read',target));
    const outcomes=await Promise.all([f.command(f.a.id,publish('writer-one',target,original.revision!,content(original).replace('Shared design','Winner one'))),f.command(f.a.id,publish('writer-two',otherTarget,original.revision!,content(original).replace('Shared design','Winner two')))]);
    expect(outcomes.map(r=>r.status).sort()).toEqual(['applied','conflict']);
    const saved=await f.command(f.a.id,read('winner',otherTarget));expect(saved.revision).toBe(1);expect(content(saved)).toMatch(/Winner (one|two)/);
    await page.close({runBeforeUnload:false});await expect.poll(async()=>(await workbenchContentTargets(f.broker, f.actor(f.a.id))).some(w=>w.windowId===target.windowId)).toBe(false);
    await expect(f.command(f.a.id,read('closed-window',target))).rejects.toThrow('workbench_app_unavailable');
    const current=await f.command(f.a.id,read('explicit-survivor',otherTarget));expect(content(current)).toBe(content(saved));
  }finally{await f.close();}
});

test('a partial explicit Design target cannot replace a frozen tab with the newly selected tab', async ({page}) => {
  test.setTimeout(90000);const f=await fixture(page);
  try {
    const a=createdTarget(await f.command(f.a.id,{requestId:'target-a',operation:'design.create',payload:{title:'Intended A'}}));
    await expect(title(page)).toHaveText('Intended A',{timeout:20000});
    const ar=await f.command(f.a.id,read('read-a',a));
    const frozen=await f.broker.validateContext('owner',f.a.id,{target:a,kind:'design',revision:ar.revision});
    const b=createdTarget(await f.command(f.a.id,{requestId:'target-b',operation:'design.create',payload:{title:'Keep B'}}));
    await expect(title(page)).toHaveText('Keep B',{timeout:20000});
    // Both documents have revision zero. Revision checks cannot identify them.
    const partial={deviceId:a.deviceId,windowId:a.windowId};
    const request=publish('partial-write',partial,ar.revision!,content(ar).replace('Intended A','Written for A'));
    await expect(f.broker.request({...f.actor(f.a.id),context:frozen},request)).rejects.toThrow('workbench_target_required');
    await expect(f.command(f.a.id,read('missing-target'))).rejects.toThrow('workbench_target_required');
    expect(content(await f.command(f.a.id,read('unchanged-a',a)))).toContain('Intended A');
    expect(content(await f.command(f.a.id,read('unchanged-b',b)))).toContain('Keep B');
    // A write must name its document even when an older tab was frozen.
    const bound={...publish('frozen-write',a,ar.revision!,content(ar).replace('Intended A','Written for A')),target:undefined};
    await expect(f.broker.request({...f.actor(f.a.id),context:frozen},bound)).rejects.toThrow('workbench_target_required');
    expect(await f.broker.request({...f.actor(f.a.id),context:frozen},{...bound,target:a})).toMatchObject({status:'applied',saved:true,target:a});
    expect(content(await f.command(f.a.id,read('updated-a',a)))).toContain('Written for A');
    expect(content(await f.command(f.a.id,read('still-b',b)))).toContain('Keep B');
  }finally{await f.close();}
});
