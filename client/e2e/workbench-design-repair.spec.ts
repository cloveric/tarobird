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
  page.on("pageerror",error=>console.log("HUMAN_PAGEERROR",error.message.slice(0,600)));
  page.on("console",message=>{if(message.type()==="error")console.log("HUMAN_CONSOLE",message.text().slice(0,400));});
  const directory = await mkdtemp(path.join(os.tmpdir(), "design-comment-draft-"));
  const hub = await HubServer.start({ stateDir: directory, clientDir: process.env.DESIGN_DRAFT_CLIENT_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)) });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','设计助手','fixture')");
  const conversation = await hub.store.createConversation("owner", ["alpha"], "设计验收", "design_chat");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner"); await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, conversation.title);
  const broker = (hub as unknown as { workbench: WorkbenchBroker }).workbench, actor = { userId: "owner", conversationId: conversation.id, validate: async () => undefined };
  await page.getByRole("textbox", { name: "消息", exact: true }).fill("Keep my existing draft.\n保留我的草稿。");
  await page.getByRole("button", { name: "工作台", exact: true }).click(); await expect(panel(page)).toBeVisible();
  await expect.poll(async () => (await workbenchContentTargets(broker, actor)).length).toBe(1);
  return { hub, conversation, targets: () => workbenchContentTargets(broker, actor), command: (request: WorkbenchRequest) => broker.request(actor, request), close: async () => { await page.close({ runBeforeUnload: false }); await hub.close(); await rm(directory, { recursive: true, force: true }); } };
}
const panel = (page: Page) => page.getByRole("complementary", { name: "工作台", exact: true });


async function storedAssociation(page:Page,conversationId:string){return page.evaluate(async(id)=>{
 for(const info of await indexedDB.databases()){
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open(info.name!);open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
  try{if(!db.objectStoreNames.contains("conversationDrafts"))continue;const row=await new Promise<any>((resolve,reject)=>{const request=db.transaction("conversationDrafts").objectStore("conversationDrafts").get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});if(row?.workbench)return row.workbench;}finally{db.close();}
 }
},conversationId);}

for (const phone of [false, true]) test.describe(phone ? "phone touch" : "desktop", () => {
test.use({ hasTouch: phone, isMobile: phone });
for (const format of ["canvas", "slides"] as const) test(`the upstream ${format} repair button opens and sends a reviewable draft for its exact tab`, async ({ page }) => {
  test.setTimeout(70000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1360, height: 900 });
  const f = await fixture(page);
  try {
    const field = page.getByRole("textbox", { name: "消息", exact: true });
    const created = await f.command({ requestId: "repair-create", operation: "design.create", payload: { title: "修复目标 Repair", format } });
    expect(created).toMatchObject({ status: "applied", saved: true });
    const target = { ...created.target, tabId: (created.result as { tabId: string }).tabId };
    const path = format === "canvas" ? "project/Main.dc.html" : "project/slides/cover.html";
    const read = await f.command({ requestId: "repair-read", operation: "design.read", target, payload: { path } });
    let content = '<div>Broken slide content 保留内容</div>';
    if (format === "canvas") content = (read.result as { content: string }).content.replace("class Component extends DCLogic {}", 'class Component extends DCLogic { renderVals() { throw new Error("REPAIR_CANVAS_FIXTURE 保留内容"); } }');
    expect(await f.command({ requestId: "repair-damage", operation: "design.publish", target, expectedRevision: read.revision, payload: { files: { [path]: { content, contentType: "text/html" } } } })).toMatchObject({ status: "applied", saved: true });
    const editor = page.frameLocator('.workbench-design-frame:visible');
    const repair = editor.locator(format === "canvas" ? '[data-testid^="mega-artboard-notice-ask-"]' : '[data-testid="slides-held-ask"]');
    await expect(repair).toBeVisible({ timeout: 25000 }).catch(async error => { console.log("REPAIR_EDITOR", await editor.locator("body").ariaSnapshot()); throw error; });
    if (phone) await repair.tap(); else await repair.click();
    await expect(panel(page)).toBeVisible();
    await expect(field).toHaveValue(/Keep my existing draft\.[\s\S]*修复目标 Repair[\s\S]*(artboard|slide)/i);
    await expect.poll(() => storedAssociation(page, f.conversation.id)).toMatchObject({ context: { target, kind: "design" } });
    const count = await f.hub.store.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE author_type='user' AND conversation_id=?", [f.conversation.id]);
    expect(count?.n).toBe(0);
    await expect(editor.getByText("Added to your message to the agent. Send it when you’re ready.", { exact: true })).toBeVisible();
    if (phone) {
      await expect(page.locator(".workbench-draft-notice")).toBeFocused();
      await expect.poll(() => page.evaluate(() => {
        const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="消息"]')!.getBoundingClientRect();
        const panel = document.querySelector<HTMLElement>('.workbench')!.getBoundingClientRect();
        return input.top >= panel.bottom && input.bottom <= innerHeight;
      })).toBe(true);
    }
    const send = page.getByRole("button", { name: "发送消息", exact: true });
    if (phone) await send.tap(); else await send.click();
    await expect(field).toHaveValue("", { timeout: 15000 });
    const messages = await f.hub.store.db.all<{ id: string }>("SELECT id FROM messages WHERE author_type='user' AND conversation_id=?", [f.conversation.id]);
    expect(messages).toHaveLength(1);
    const context = await f.hub.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [`workbench-context:${messages[0]!.id}`]);
    expect(JSON.parse(context!.value)).toMatchObject({ target, kind: "design" });
    await expect(editor.getByText("Sent to the agent.", { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});
});


test.describe("phone repair focus ownership", () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const format of ["canvas", "slides"] as const) test(`an asynchronous ${format} suggestion preserves the focused chat input`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await fixture(page);
    try {
      const created = await f.command({ requestId: "focus-create", operation: "design.create", payload: { title: "Focus ownership", format } });
      expect(created).toMatchObject({ status: "applied", saved: true });
      const editor = page.frameLocator(".workbench-design-frame:visible");
      await expect.poll(() => editor.locator("body").evaluate((_, kind) => typeof (window as any)[kind === "canvas" ? "designHost" : "slidesHost"]?.chat?.suggestPrompt, format)).toBe("function");
      const field = page.getByRole("textbox", { name: "消息", exact: true });
      await field.focus();
      await editor.locator("body").evaluate(async (_, kind) => {
        await (window as any)[kind === "canvas" ? "designHost" : "slidesHost"].chat.suggestPrompt("Keep typing while this suggestion arrives.");
      }, format);
      await expect(field).toHaveValue(/Keep my existing draft[\s\S]*Keep typing while this suggestion arrives/);
      await expect(field).toBeFocused();
      const count = await f.hub.store.db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE author_type='user' AND conversation_id=?", [f.conversation.id]);
      expect(count?.n).toBe(0);
    } finally { await f.close(); }
  });
});
