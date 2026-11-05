import { workbenchContentTargets } from "./fixtures/workbench-targets.js";
import { test, expect, type Page } from "@playwright/test";
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


for (const surface of ['canvas-background','canvas-artboard','slides'] as const) test(`wheel motion stays controlled on ${surface}`, async ({page})=>{
 const f=await fixture(page);
 try {
  const format=surface==='slides'?'slides':'canvas';
  await f.command({requestId:'wheel-create',operation:'design.create',payload:{title:'Wheel probe',...(format==='slides'?{format}: {})}});
  const editor=page.frameLocator('.workbench-design-frame:visible');
  const heading=format==='canvas'?editor.frameLocator('iframe').locator('h1'):editor.getByRole('heading',{level:1}).first();
  await expect(heading).toHaveText('Wheel probe',{timeout:20000});
  const target=surface==='canvas-artboard'?heading:editor.locator('[style*="touch-action: none"]').first();
  const position=async()=>{const b=await heading.boundingBox();expect(b).not.toBeNull();return b!;};
  const wheel=async(deltaX:number,deltaY:number,deltaMode=0,ctrlKey=false)=>{
   await target.evaluate((node,args)=>{
    const r=node.getBoundingClientRect();node.dispatchEvent(new WheelEvent('wheel',{...args,bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20}));
   },{deltaX,deltaY,deltaMode,ctrlKey});
  };
  if (format==='slides') {
    // A fitted slide deliberately cannot pan outside its bounds. Enlarge it
    // using the real zoom control before testing scroll travel.
    await editor.getByRole('button',{name:/%, Zoom/}).click();
    await editor.getByRole('menuitemradio',{name:'100%',exact:true}).click();
    await expect(editor.getByRole('button',{name:'100%, Zoom',exact:true})).toBeVisible();
  }
  let before=await position();
  await target.hover({position:surface==='canvas-artboard'?{x:20,y:10}:{x:8,y:180}});
  await page.mouse.wheel(0,120);
  await expect.poll(async()=>Math.abs((await position()).y-before.y)).toBeGreaterThan(1);
  let after=await position();console.log(surface,'notch movement',after.y-before.y);
  expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(61);
  expect(after.width/before.width).toBeCloseTo(1,2);
  before=after;await wheel(0,-120);
  await expect.poll(async()=>Math.abs((await position()).y-before.y)).toBeGreaterThan(1);
  after=await position();expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(61);
  // Line/page wheel devices must not turn one event into a whole-canvas jump.
  for(const [delta,mode]of [[480,0],[3,1],[1,2]]){
   before=await position();await wheel(0,delta,mode);
   await expect.poll(async()=>Math.abs((await position()).y-before.y)).toBeGreaterThan(1);
   after=await position();expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(61);
  }
  // Modifier wheel remains cursor-anchored zoom, but one notch cannot shrink by 20%.
  before=await position();await wheel(0,120,0,true);
  await expect.poll(async()=>(await position()).width/before.width).toBeLessThan(.99);
  after=await position();expect(after.width/before.width).toBeGreaterThan(.92);
  expect(after.width/before.width).toBeLessThan(1);
  before=after;await wheel(0,-120,0,true);
  await expect.poll(async()=>(await position()).width/before.width).toBeGreaterThan(1.01);
  after=await position();expect(after.width/before.width).toBeLessThan(1.09);
 }finally{await f.close()}
});
