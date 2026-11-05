import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HubServer } from '../../src/hub/server.js';
import { readWidget, readReport } from '../../src/client-protocol/widget.js';
import { archiveAcceptanceThreads } from '../../tests/helpers/codex-acceptance.js';
import { waitForClientOnline, selectConversation } from './fixtures/mobile.js';

test.use({ serviceWorkers:'block',actionTimeout:15000 });
test('real model authors a task-specific local calculator and draft handoff',async({page},info)=>{
 test.skip(process.env.TAROBOT_LIVE_WIDGET!=='1','opt-in authenticated model acceptance'); test.setTimeout(480000);
 const root=await mkdtemp(path.join(os.tmpdir(),'live-widget-interaction-')),workspace=path.join(root,'workspace');await mkdir(workspace);
 const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist'),managedBots:{entrypoint:path.resolve('../dist/src/index.js'),env:process.env}});
 try {
  const bot=await hub.botManager!.create('owner',{requestId:'interactive_widget_acceptance',name:'交互验收',engine:'codex',model:'gpt-6.1-sol',effort:'low',workspace});
  const conv=await hub.store.createConversation('owner',[bot.id],'自定义交互验收','widget_interactions_live');
  await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);await selectConversation(page,conv.title);
  await expect.poll(async()=>!!(await hub.store.bots('owner'))[0]?.online).toBe(true);
  const input=page.getByLabel('消息',{exact:true});
  await input.fill('请直接交付一个可操作的小组件：活动成本为固定800元，加每人每天120元，餐饮可选每人每天60元。人数2至20，默认6；天数1至3，默认2；默认包含餐饮。我希望拖动人数、选择天数、勾选餐饮后实时重算费用，用SVG体现变化，有重置按钮。为了操作清晰，控件标签分别用“人数”“天数”“包含餐饮”。再提供“填入输入框”按钮，把当前参数和“请帮我优化此方案”带回对话草稿，绝不自动发送。适配手机和深色，数据仅为演示，不联网。');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(async()=> (await hub.store.snapshot('owner',conv.id)).messages.some(m=>m.authorType==='bot'&&m.blocks.some(b=>readWidget(b))),{timeout:240000}).toBe(true);
  await expect.poll(async()=> (await hub.store.pendingForBot(bot.id)).length,{timeout:180000}).toBe(0);
  const messages=(await hub.store.snapshot('owner',conv.id)).messages, block=messages.flatMap(m=>m.blocks).find(b=>readWidget(b))!, widget=readWidget(block)!;
  expect(readReport(block),'parameter controls need authored HTML, not a fixed report').toBeUndefined();
  await writeFile(info.outputPath('real-model-widget.html'),widget.html);await writeFile(info.outputPath('real-model-widget.json'),JSON.stringify({title:widget.title,summary:widget.summary,htmlBytes:Buffer.byteLength(widget.html),conversationId:conv.id,model:'gpt-6.1-sol',effort:'low'},null,2));
  const frame=page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
  const people=frame.getByRole('slider',{name:/^人数/});await expect(people).toHaveAttribute('data-tarobot-node',/\d+/);
  await expect(frame.locator('body')).toContainText(/2,?960/);await people.press('ArrowRight');await expect(frame.locator('body')).toContainText(/3,?320/);
  await frame.getByRole('combobox',{name:/^天数/}).selectOption({index:2});await expect(frame.locator('body')).toContainText(/4,?580/);
  await frame.getByRole('checkbox',{name:/包含餐饮/}).uncheck();await expect(frame.locator('body')).toContainText(/3,?320/);
  await page.getByRole('button',{name:'放大交互组件',exact:true}).click();
  for(const width of [1360,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
   await expect(frame.getByRole('slider',{name:/^人数/})).toBeVisible();
   expect(await frame.locator('body').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
   const labelSizes=await frame.locator('svg text').evaluateAll(nodes=>nodes.map(node=>({height:node.getBoundingClientRect().height,bodyFont:parseFloat(getComputedStyle(document.body).fontSize)})));
   for(const label of labelSizes)expect(label.height,'SVG labels should not be inflated by a small viewBox').toBeLessThanOrEqual(label.bodyFont*1.7);
   await page.locator('.widget-panel').screenshot({path:info.outputPath(`real-model-${width}-${theme}.png`),animations:'disabled'});
  }
  await frame.getByRole('button',{name:'填入输入框',exact:true}).click();
  await expect(input).toHaveValue(/优化/);await expect(input).toHaveValue(/7/);
  expect((await hub.store.snapshot('owner',conv.id)).messages.filter(m=>m.authorType==='user')).toHaveLength(1);
  await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
 }finally{await page.close();await hub.close();await archiveAcceptanceThreads(root);await rm(root,{recursive:true,force:true})}
});
