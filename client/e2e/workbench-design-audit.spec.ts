import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
import { DESIGN_PREPARE_SCRIPT, DESIGN_CANCEL_SCRIPT } from "../electron/design-quit.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import type { WorkbenchBroker } from "../../src/hub/workbench.js";
import type { WorkbenchRequest } from "../../src/client-protocol/workbench.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
async function fixture(page: Page) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workbench-design-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: fileURLToPath(new URL("../dist", import.meta.url)) });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "设计验收", "design_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
  return { hub, conversation, targets: () => workbenchContentTargets(broker, actor), command: (request: WorkbenchRequest) => broker.request(actor, request), close: async () => { await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });

test('design follows App and system theme changes without discarding the live canvas', async ({page}) => {
  const f=await fixture(page);
  try {
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
    await f.command({requestId:'theme-design',operation:'design.create',payload:{title:'Theme probe'}});
    const editor=page.frameLocator('.workbench-design-frame');
    await expect(editor.locator('html')).toHaveAttribute('data-theme','light',{timeout:20000});
    await expect(editor.frameLocator('iframe').locator('h1')).toHaveText('Theme probe',{timeout:20000});
    await editor.locator('html').evaluate(node=>{node.dataset.auditIdentity='same-document';});
    await editor.frameLocator('iframe').locator('h1').dblclick();
    await page.keyboard.press('Meta+A');await page.keyboard.type('Human theme edit');await page.keyboard.press('Escape');
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
    await expect(editor.locator('html')).toHaveAttribute('data-theme','dark');
    await page.evaluate(()=>{document.documentElement.dataset.theme='system';});
    await page.emulateMedia({colorScheme:'light'});
    await expect(editor.locator('html')).toHaveAttribute('data-theme','light');
    await page.emulateMedia({colorScheme:'dark'});
    await expect(editor.locator('html')).toHaveAttribute('data-theme','dark');
    await expect(editor.locator('html')).toHaveAttribute('data-audit-identity','same-document');
    await expect(editor.frameLocator('iframe').locator('h1')).toHaveText('Human theme edit',{timeout:20000});
    // Theme updates are accepted only from the parent, never a nested artboard.
    await editor.frameLocator('iframe').locator('h1').evaluate(()=>window.parent.postMessage({type:'tarobot-design-theme',dark:false},'*'));
    await expect(editor.locator('html')).toHaveAttribute('data-theme','dark');
  }finally{await f.close();}
});

test('design still tracks its surface bounds after a Bot reload', async ({page}) => {
  const f=await fixture(page);
  try {
    const created=await f.command({requestId:'resize-design',operation:'design.create',payload:{title:'Resize probe'}});
    const target={...created.target,tabId:(created.result as {tabId:string}).tabId};
    const editor=page.frameLocator('.workbench-design-frame');
    await expect(editor.frameLocator('iframe').locator('h1')).toHaveText('Resize probe',{timeout:20000});
    const read=await f.command({requestId:'resize-read',operation:'design.read',target,payload:{path:'project/Main.dc.html'}});
    const content=(read.result as {content:string}).content.replace('Resize probe','Reloaded canvas');
    expect(await f.command({requestId:'resize-publish',operation:'design.publish',target,expectedRevision:read.revision,payload:{files:{'project/Main.dc.html':{content,contentType:'text/html'}}}})).toMatchObject({status:'applied',saved:true});
    await expect(editor.frameLocator('iframe').locator('h1')).toHaveText('Reloaded canvas',{timeout:20000});
    // Internal pane resize changes element geometry without resizing the window.
    await page.locator('.workbench-design-surface').evaluate(el=>{el.style.width='230px';});
    await expect.poll(async()=>page.evaluate(()=>{
      const surface=document.querySelector('.workbench-design-surface')!.getBoundingClientRect();
      const frame=document.querySelector('.workbench-design-frame')!.getBoundingClientRect();
      return Math.abs(frame.width-surface.width);
    })).toBeLessThan(1);
  }finally{await f.close();}
});


test('native quit handshake saves live text, cancellation restores editing, and reopen retains every edit', async ({page,browserName})=>{
  test.setTimeout(90000);
  const f=await fixture(page);
  const reopen=async(text:string)=>{
    page=await page.context().newPage();await page.goto(f.hub.url);await waitForClientOnline(page);await selectConversation(page,f.conversation.title);await page.getByRole('button',{name:'工作台',exact:true}).click();
    await expect(page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1')).toHaveText(text,{timeout:20000});
  };
  try {
    await f.command({requestId:'quit-design',operation:'design.create',payload:{title:'Quit probe'}});
    let h1=page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1');await expect(h1).toHaveText('Quit probe',{timeout:20000});
    await h1.click();await page.waitForTimeout(600);
    await h1.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Saved across App exit');await expect(h1).toHaveText('Saved across App exit');
    // A direct browser/OS close without the App handshake must remain guarded.
    if(browserName==='chromium') {const dialog=page.waitForEvent('dialog');await page.close({runBeforeUnload:true});await(await dialog).dismiss();expect(page.isClosed()).toBe(false);}
    else expect(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true})))).toBe(false);
    expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(true);
    await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',true);
    await page.evaluate(DESIGN_CANCEL_SCRIPT);await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);
    for(const [text,escape] of [['Second edit after cancelled quit',false],['Escaped edit before quit',true]] as const){
      h1=page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1');
      await h1.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type(text);await expect(h1).toHaveText(text);
      if(escape){await page.keyboard.press('Escape');await panel(page).evaluate(node=>{node.tabIndex=-1;node.focus();});}
      expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(true);
      await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',true);
      let warning=false;page.once('dialog',async d=>{warning=true;await d.dismiss();});
      const closed=page.waitForEvent('close');await page.close({runBeforeUnload:browserName==='chromium'});await closed;expect(warning).toBe(false);
      await reopen(text);
    }
    // A clean editor also exits without an unnecessary native confirmation.
    expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(true);
    expect(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true})))).toBe(true);
  }finally{await page.close({runBeforeUnload:false});await f.close();}
});

test('a failed Design save keeps quit protection until the editor can save again', async ({page,browserName})=>{
  const f=await fixture(page);
  try {
    const created=await f.command({requestId:'failed-save-design',operation:'design.create',payload:{title:'Save failure'}});
    const target={...created.target,tabId:(created.result as {tabId:string}).tabId};
    const h1=page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1');await expect(h1).toHaveText('Save failure',{timeout:20000});
    await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;(window as any).rejectDesignWrites=true;IDBObjectStore.prototype.put=function(...args:Parameters<IDBObjectStore['put']>){if(this.name==='workbenchDesign'&&(window as any).rejectDesignWrites)throw new DOMException('Fixture full','QuotaExceededError');return original.apply(this,args);};});
    await h1.dblclick();await page.keyboard.press('Meta+A');await page.keyboard.type('Keep this failed edit');await expect(h1).toHaveText('Keep this failed edit');
    const tryQuit=async()=>{
      if(browserName==='chromium'){const warn=page.waitForEvent('dialog');await page.close({runBeforeUnload:true});await(await warn).dismiss();}
      else expect(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true})))).toBe(false);
    };
    await tryQuit();
    await expect(page.locator('.workbench-design-error')).toBeVisible({timeout:15000});expect(page.isClosed()).toBe(false);
    expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(false);
    await expect(page.locator('.workbench-design-frame')).toHaveJSProperty('inert',false);
    await tryQuit();expect(page.isClosed()).toBe(false);
    await page.evaluate(()=>(window as any).rejectDesignWrites=false);
    expect(await page.evaluate(DESIGN_PREPARE_SCRIPT)).toBe(true);
    await expect(page.locator('.workbench-design-error')).toHaveCount(0,{timeout:20000});
    await expect(page.frameLocator('.workbench-design-frame').frameLocator('iframe').locator('h1')).toHaveText('Keep this failed edit',{timeout:20000});
    const read=await f.command({requestId:'failed-save-read',operation:'design.read',target,payload:{path:'project/Main.dc.html'}});expect((read.result as {content:string}).content).toContain('Keep this failed edit');
  }finally{await f.close();}
});
