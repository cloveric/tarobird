// Documentation only: real App UI, disposable loopback Hubs, fictional content.
// Build Host/client first. No engine, user profile, native capture or input runs.
import { chromium, expect } from '../client/node_modules/@playwright/test/index.mjs';
import { HubServer } from '../dist/src/hub/server.js';
import { BOT_AVATAR_DEFAULT_PREFIX } from '../dist/src/hub/bot-avatar-default.js';
import { prepareReadmePairing } from './readme-pairing.mjs';
import { readmePreferences, readmeAvatars, visibleReadmeAvatars } from './readme-appearance.mjs';
import { captureProvenance } from './readme-provenance.mjs';
import { recordReadmeMotion } from './readme-motion.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'assets/product');
const provenance = await captureProvenance(root);
const browser = await chromium.launch({ headless: true });
const images = [], animations = [];
const textFile = content => ({ content, contentType: 'text/html' });
await mkdir(output, { recursive: true });
try {
 for (const locale of ['zh', 'en']) {
  const zh = locale === 'zh', words = (cn, en) => zh ? cn : en;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'tarobird-showcase-'));
  const hub = await HubServer.start({ stateDir, clientDir: path.join(root, 'client/dist') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, serviceWorkers: 'block', locale: zh ? 'zh-CN' : 'en-GB' });
  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
   await hub.profile.update({ name: words('演示工作室', 'Demo Studio'), revision: (await hub.profile.read()).revision });
   const bots = [['studio', words('设计搭档', 'Design partner'), 'codex', '', readmeAvatars.codex], ['chief', words('幕僚长', 'Chancellor'), 'claude', 'dispatcher', readmeAvatars.claude], ['research', words('研究助手', 'Research'), 'codex', '', readmeAvatars.kimi], ['brand', words('品牌顾问', 'Brand partner'), 'claude', '', readmeAvatars.gemini], ['writing', words('文案编辑', 'Copy editor'), 'claude', '', readmeAvatars.studio], ['review', words('代码审阅', 'Code reviewer'), 'codex', '', readmeAvatars.deepseek], ['library', words('资料管家', 'Librarian'), 'codex', '', readmeAvatars.agy]];
   for (const [id, name, engine, role, avatar] of bots) {
    await hub.store.db.run('INSERT INTO bots(id,name,secret_hash,engine,role,online) VALUES(?,?,?,?,?,1)', [id, name, 'documentation-only', engine, role]);
    await hub.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [BOT_AVATAR_DEFAULT_PREFIX + id, avatar]);
   }
   const design = await hub.store.createConversation('owner', ['studio'], words('从想法到发布', 'From idea to launch'), 'design');
   const chief = await hub.store.createConversation('owner', ['chief'], words('本周工作安排', 'This week’s plan'), 'chief');
   await hub.store.createConversation('owner', ['research'], words('用户访谈', 'User interviews'), 'research');
   await hub.store.sendMessage('owner', { conversationId: design.id, clientMsgId: 'request', text: words('为我们的工作室设计一张发布页，放到工作台的画布里。文字和配色都要能继续调整。', 'Design a launch page for our studio in Workbench. Keep the text and colors editable.'), attachments: [] });
   await hub.store.publishBotMessage('studio', { conversationId: design.id, blocks: [{ type: 'text', text: words('发布页草稿已放到画布。\n\n暖色、清晰的标题，留出舒展的空间。\n\n双击文字就能编辑，也可以继续告诉我哪里需要调整。', 'The launch page is ready in Canvas.\n\nWarm colors, a clear headline and room to breathe.\n\nDouble-click text to edit, or tell me what you would like to change.') }] });
   // Task-oriented sidebar examples; ordinary read state keeps the focus on content.
   await hub.store.markRead('owner', design.id, Number.MAX_SAFE_INTEGER);
   for (const [index, botId, cn, en] of [[0,'brand','品牌与配色','Brand and palette'],[1,'writing','首页文案','Homepage copy'],[2,'review','代码审阅','Code review'],[3,'library','每周回顾','Weekly review']]) {
    const chat = await hub.store.createConversation('owner', [botId], words(cn,en), `showcase-topic-${index}`);
    await hub.store.publishBotMessage(botId, { conversationId:chat.id, blocks:[{type:'text',text:words('资料已整理，随时继续。','Notes are organized and ready to continue.')}] });
    await hub.store.markRead('owner',chat.id,Number.MAX_SAFE_INTEGER);
   }
   await page.goto(hub.url); await prepareReadmePairing(page, hub);
   await page.getByRole('button', { name: '配对此设备', exact: true }).click();
   await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
   await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' });
   await readmePreferences(page, locale, 'conversations'); await page.reload();
   await page.locator('.app-shell').filter({ visible: true }).waitFor();
   await page.locator(`.conversation-row[data-conversation-id="${design.id}"]`).filter({ visible: true }).click();
   await page.getByRole('button', { name: words('工作台', 'Workbench'), exact: true }).click();
   const panel = page.getByRole('complementary', { name: words('工作台', 'Workbench'), exact: true });
   await expect(panel).toBeVisible();
   const actor = { userId: 'owner', conversationId: design.id, validate: async () => undefined };
   await expect.poll(async () => (await hub.workbench.list(actor)).filter(w => !w.capabilities.includes('design.open.v1')).length).toBe(1);
   let serial = 0;
   const command = value => hub.workbench.request(actor, { requestId: `showcase-${++serial}`, ...value });
   const create = async (title, format) => {
    const result = await command({ operation: 'design.create', payload: { title, format } });
    expect(result).toMatchObject({ status: 'applied', saved: true });
    return { ...result.target, tabId: result.result.tabId };
   };
   const title = words('让想法，有处生长。', 'Give ideas room to grow.');
   const canvas = await create(words('发布页 · 画布', 'Launch page · Canvas'), 'canvas');
   const old = await command({ operation: 'design.read', target: canvas, payload: { path: 'project/Main.dc.html' } });
   const art = `<div style="width:880px;height:560px;box-sizing:border-box;padding:38px 46px;background:#f7f4ed;color:#292723;font-family:Arial,'PingFang SC',sans-serif;display:flex;flex-direction:column"><div style="display:flex;justify-content:space-between;font-size:12px;letter-spacing:2px;color:#806d60"><b>FIELDNOTES / STUDIO</b><span>IDEAS INTO EVERYDAY</span></div><div style="display:flex;gap:24px;align-items:center;flex:1"><div style="width:470px"><p style="font-size:12px;letter-spacing:3px;color:#9d775e">${words('研究 · 设计 · 创作','RESEARCH · DESIGN · CREATE')}</p><h1 style="font-size:${zh ? 48 : 55}px;line-height:1.16;letter-spacing:-1.5px;margin:24px 0;max-width:465px">${title}</h1><p style="font-size:17px;line-height:1.7;max-width:360px;color:#7d776e;margin:0">${words('从一条线索，到一个值得分享的作品。','From a small observation to something worth sharing.')}</p></div><div style="width:268px;height:290px;position:relative;overflow:hidden;border-radius:150px 150px 12px 12px;background:#e5dfd1"><div style="position:absolute;width:142px;height:142px;top:34px;left:62px;border-radius:50%;background:#b96d4f"></div><div style="position:absolute;width:360px;height:230px;top:172px;left:-145px;border-radius:50%;background:#82927b"></div><div style="position:absolute;width:350px;height:210px;top:206px;left:59px;border-radius:50%;background:#c7b391"></div></div></div><div style="display:flex;border-top:1px solid #d7d0c3;padding-top:20px;justify-content:space-between;font-size:13px;color:#766b5e"><span>${words('01 发现方向','01 FIND A DIRECTION')}</span><span>${words('02 把它做出来','02 MAKE IT TANGIBLE')}</span><span>${words('03 一起完善','03 REFINE TOGETHER')}</span></div></div>`;
   const html = old.result.content.replace(/<x-dc>[\s\S]*?<\/x-dc>/, `<x-dc>${art}</x-dc>`);
   expect(await command({ operation: 'design.publish', target: canvas, expectedRevision: old.revision, payload: { files: { 'project/Main.dc.html': textFile(html) } } })).toMatchObject({ status: 'applied', saved: true });
   await panel.getByRole('button', { name: words('展开到主区', 'Expand workbench'), exact: true }).click();
   await expect(page.frameLocator('.workbench-design-frame:visible').frameLocator('iframe').getByText(title, { exact: true })).toBeVisible({ timeout: 30_000 });
   const capture = async name => {
    await page.evaluate(() => document.fonts.ready); await page.mouse.move(0, 0); await page.waitForTimeout(350);
    expect(errors).toEqual([]);
    const file = `${name}-${locale}.png`; await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
    images.push({ file, locale, viewport: page.viewportSize(), sha256: createHash('sha256').update(await readFile(path.join(output, file))).digest('hex') });
   };
   await capture('workbench-canvas');
   expect((await visibleReadmeAvatars(page)).length).toBeGreaterThanOrEqual(7);
   const canvasMotion = await recordReadmeMotion(page,path.join(stateDir,'canvas-motion'),path.join(output,`canvas-demo-${locale}.gif`),async()=>{
    const heading=page.frameLocator('.workbench-design-frame:visible').frameLocator('iframe').locator('h1');
    await page.waitForTimeout(1800);
    await heading.dblclick();await page.waitForTimeout(700);
    await page.keyboard.press('Meta+A');
    await page.keyboard.insertText(words('让好想法，继续生长。','Let good ideas take root.'));
    await page.keyboard.press('Escape');
    await expect(heading).toHaveText(words('让好想法，继续生长。','Let good ideas take root.'));
    await page.waitForTimeout(1700);
    // Click outside the edited element to show the completed canvas at a
    // readable size; side-panel transitions are demonstrated with notes below.
    const frameBox=await page.locator('.workbench-design-frame:visible').boundingBox();
    await page.mouse.click(frameBox.x+36,frameBox.y+130);
    await page.waitForTimeout(1800);
   });
   animations.push({...canvasMotion,locale,actions:['Canvas launch page','Double-click and edit heading','Review the updated canvas']});
   await expect.poll(async()=>(await command({operation:'design.read',target:canvas,payload:{path:'project/Main.dc.html'}})).result.content).toContain(words('让好想法，继续生长。','Let good ideas take root.'));
   console.log(`Captured ${canvasMotion.file}`);
   const boardTitle = words('发布流程 · 白板','Launch flow · Whiteboard');
   const board = await command({ operation:'whiteboard.create', payload:{title:boardTitle} });
   expect(board).toMatchObject({ status:'applied', saved:true });
   const boardTarget = { ...board.target, tabId:board.result.tabId };
   const boardOps = [{op:'add',id:'heading',type:'text',x:80,y:70,text:words('从想法到交付','From idea to delivery'),fontSize:32,fontFamily:2,strokeColor:'#302c28'}];
   for (const [i,cn,en,color] of [[0,'研究','Research','#e9e4d9'],[1,'创作','Create','#e1e8dc'],[2,'审阅','Review','#eddfd4']]) {
    boardOps.push({op:'add',id:`step-${i}`,type:'rectangle',x:80+i*260,y:200,width:210,height:120,backgroundColor:color,fillStyle:'solid',strokeColor:'#8c8075',roughness:1});
    boardOps.push({op:'add',id:`label-${i}`,type:'text',x:110+i*260,y:245,text:words(cn,en),fontSize:26,fontFamily:2,strokeColor:'#302c28'});
    if(i<2)boardOps.push({op:'add',id:`arrow-${i}`,type:'arrow',x:300+i*260,y:260,points:[[0,0],[30,0]],endArrowhead:'arrow',strokeColor:'#8c8075'});
   }
   expect(await command({operation:'whiteboard.patch',target:boardTarget,expectedRevision:board.revision,payload:{ops:boardOps}})).toMatchObject({status:'applied',saved:true});
   await expect(panel.locator('.excalidraw')).toBeVisible({timeout:30000});
   await page.waitForTimeout(1200);
   await capture('workbench-whiteboard');
   const noteTitle = words('项目笔记.md','Project notes.md');
   const note = await command({operation:'markdown.create',payload:{title:noteTitle,content:words('# 本周发布计划\n\n让每一步都有清晰的交付物。\n\n## 待办\n\n- [x] 整理访谈与需求\n- [x] 完成发布页草稿\n- [ ] 审阅实现与交付材料\n\n## 决定\n\n先完成核心流程，再补充细节。','# This week’s launch\n\nGive every step a clear deliverable.\n\n## Checklist\n\n- [x] Summarize interviews and needs\n- [x] Prepare the launch page\n- [ ] Review implementation and deliverables\n\n## Decision\n\nComplete the core flow, then refine the details.')}});
   expect(note).toMatchObject({status:'applied',saved:true});
   await expect(panel.locator('.vditor')).toBeVisible({timeout:30000});
   await page.waitForTimeout(700);
   await capture('workbench-notes');
   await panel.getByRole('button',{name:words('返回右侧','Return to side'),exact:true}).click();
   await page.waitForTimeout(700);
   await capture('workbench-side');
   const toolsMotion = await recordReadmeMotion(page,path.join(stateDir,'tools-motion'),path.join(output,`workbench-tools-demo-${locale}.gif`),async()=>{
    await page.waitForTimeout(1400);
    await panel.getByRole('button',{name:words('展开到主区','Expand workbench'),exact:true}).click();
    await page.waitForTimeout(1200);
    await panel.getByRole('tab',{name:boardTitle,exact:true}).click();
    await expect(panel.locator('.excalidraw')).toBeVisible({timeout:30000});
    await page.waitForTimeout(1800);
    await panel.getByRole('tab',{name:noteTitle,exact:true}).click();
    await expect(panel.locator('.vditor')).toBeVisible({timeout:30000});
    await page.waitForTimeout(1800);
   });
   animations.push({...toolsMotion,locale,actions:['Side panel','Expand workbench','Whiteboard','Markdown note']});
   // Ticket states are illustrative database fixtures. No model dispatch runs.
   await page.setViewportSize({ width:1440, height:760 });
   await hub.store.sendMessage('owner', { conversationId: chief.id, clientMsgId: 'chief-request', text: words('帮我准备下周的产品发布：梳理用户反馈、检查实现，再整理一份简报。', 'Prepare next week’s launch: summarize feedback, review the implementation and write a short brief.'), attachments: [] });
   await hub.store.publishBotMessage('chief', { conversationId: chief.id, blocks: [{ type: 'text', text: words('我把工作拆成了三张工单。\n\n1. 用户反馈已整理，等你验收。\n2. 实现审查正在进行。\n3. 发布简报会在审查后继续。\n\n你可以随时暂停、补充要求，或打开工单查看过程。', 'I split the work into three tickets.\n\n1. The feedback summary is ready for review.\n2. The implementation review is in progress.\n3. The launch brief will follow.\n\nYou can pause a ticket, add context or open its conversation.') }] });
   const now = Date.now();
   for (const [i, cn, en, status, engine] of [[1,'检查实现与边界','Review implementation','working','codex'],[2,'整理用户反馈','Summarize feedback','needs_review','claude'],[3,'撰写发布简报','Write the launch brief','queued','codex']]) {
    const attempts = status === 'queued' ? [] : [{ id: `attempt_${i}`, botId: 'research', engine, model: engine === 'codex' ? 'gpt-6-astra' : 'claude-opus-5-5', effort: 'high', conversationId: chief.id, inputMessageId: `input_${i}`, startedAt: now - 120000, ...(status === 'needs_review' ? { endedAt: now - 60000, outcome: 'completed' } : {}) }];
    await hub.store.db.run('INSERT INTO dispatch_tickets(id,dispatcher_bot_id,conversation_id,request_id,title,request,status,paused,attempts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)', [`ticket_${i}`, 'chief', chief.id, `request_${i}`, words(cn,en), words(cn,en), status, JSON.stringify(attempts), now - 300000, now - i * 60000]);
   }
   await page.reload();
   await page.locator(`.conversation-row[data-conversation-id="${chief.id}"]`).filter({ visible:true }).click();
   await expect(page.getByRole('heading', { name: chief.title, exact: true })).toBeVisible();
   await page.locator('.dispatch-tickets > button, .dispatch-tickets > header button').first().click();
   await expect(page.locator('.dispatch-ticket-list')).toBeVisible();
   await expect(page.locator('.dispatch-ticket')).toHaveCount(3);
   await capture('chancellor');
   const ticketToggle = page.locator('.dispatch-tickets > button, .dispatch-tickets > header button').first();
   await ticketToggle.click();
   const chiefMotion = await recordReadmeMotion(page, path.join(stateDir,'chief-motion'), path.join(output,`chancellor-demo-${locale}.gif`), async () => {
    await page.waitForTimeout(1200);
    await ticketToggle.click();
    await expect(page.locator('.dispatch-ticket-list')).toBeVisible();
    await page.waitForTimeout(2600);
   });
   animations.push({ ...chiefMotion, locale, viewport:page.viewportSize(), actions:['Ticket summary','Expand ticket list'], simulatedTicketState:true });

  } catch (error) {
   if (process.env.DEMO_KEEP) {
    await page.screenshot({path:path.join(process.env.DEMO_KEEP,`workbench-failure-${locale}.png`)});
    await writeFile(path.join(process.env.DEMO_KEEP,`workbench-failure-${locale}.json`), JSON.stringify({ errors, frames:await Promise.all(page.frames().map(async frame => ({ url:frame.url(), text:(await frame.locator('body').innerText().catch(()=>'' )).slice(0,4000) }))) }, null, 2));
   }
   throw error;
  } finally { await context.close(); await hub.close(); await rm(stateDir, { recursive: true, force: true }); }
 }
 await writeFile(path.join(output, 'workspaces-capture.json'), JSON.stringify({ ...provenance, captured: new Date().toISOString(), source: 'Real built App, disposable loopback Hubs, fictional projects and ticket states; no model execution', images, animations }, null, 2) + '\n');
} finally { await browser.close(); }
