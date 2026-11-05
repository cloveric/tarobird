import { preparePairing } from "./fixtures/pairing-invite.js";
import { blocksText } from "../../src/client-protocol/index.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HubServer } from '../../src/hub/server.js';
import { readReport, readWidget } from '../../src/client-protocol/widget.js';
import { archiveAcceptanceThreads } from '../../tests/helpers/codex-acceptance.js';
import { waitForClientOnline, selectConversation } from './fixtures/mobile.js';

test.use({ actionTimeout: 15000 });
test('real Codex proactively publishes an inline visual through the native tool',async({page},info)=>{
 test.skip(process.env.TAROBOT_LIVE_WIDGET!=='1','opt-in authenticated model acceptance');test.setTimeout(480000);
 const root=await mkdtemp(path.join(os.tmpdir(),'live-app-tools-')),workspace=path.join(root,'workspace');await mkdir(workspace);
 const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist'),managedBots:{entrypoint:path.resolve('../dist/src/index.js'),env:process.env}});
 try{
  const bot=await hub.botManager!.create('owner',{requestId:'widget_acceptance',name:'交互组件验收',engine:'codex',model:'gpt-6.1-sol',effort:'low',workspace});
  const conv=await hub.store.createConversation('owner',[bot.id],'交互组件验收','widget_live');
  await page.goto(hub.url);await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});await waitForClientOnline(page);await selectConversation(page,conv.title);
  await expect.poll(async()=>!!(await hub.store.bots('owner'))[0]?.online).toBe(true);
  await page.getByLabel('消息',{exact:true}).fill('这是验收用的示例交付记录，不需要上网：10月16日体验2项、可靠性1项；17日体验1项、可靠性3项；18日体验4项、可靠性2项；19日体验2项、可靠性1项；20日体验3项、可靠性5项；21日体验2项、可靠性3项。帮我分析这周的节奏、比较两类变化，方便我查看任一天的明细。请直接交付结果。');await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect.poll(async()=>{const messages=(await hub.store.snapshot('owner',conv.id)).messages;return messages.some(m=>m.authorType==='bot'&&m.blocks.some(b=>!!readWidget(b)));},{timeout:180000}).toBe(true);
  const messages=(await hub.store.snapshot('owner',conv.id)).messages,block=messages.flatMap(m=>m.blocks).find(b=>readWidget(b))!,widget=readWidget(block)!,report=readReport(block);
  if(process.env.TAROBOT_LIVE_REPORT==='1')expect(report,'ordinary comparison should choose data report').toBeDefined();
  if(report){
    await expect(page.locator('.inline-report')).toBeVisible();
    await page.getByRole('button',{name:'放大交互组件'}).click();
    await expect(page.locator('.report-panel:modal')).toBeVisible();
    await expect(page.locator('.report-chart')).toBeVisible();
    await page.getByRole('combobox', {name:'选择记录查看数值'}).selectOption('0');
    await expect(page.locator('.report-selection')).toBeVisible();
    await page.locator('.report-panel:modal').screenshot({path:info.outputPath('real-model-report.png'),animations:'disabled'});
    await writeFile(info.outputPath('real-model-report.json'),JSON.stringify(report,null,2));
  }else{
  await expect(page.locator('.inline-widget iframe')).toBeVisible();await expect(page.getByText('正在加载交互组件…')).toHaveCount(0);await expect(page.getByText('组件未能完整运行，文字摘要仍可阅读。')).toHaveCount(0);
  await page.getByRole('button',{name:'放大交互组件'}).click();
  const guest=page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
  await expect(guest.locator('body')).toContainText('29');
  expect(await page.locator('.widget-expanded').evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.locator('.widget-expanded').screenshot({path:info.outputPath('real-model-widget.png'),animations:'disabled'});await writeFile(info.outputPath('real-model-widget.html'),widget.html);
  }
  const state=path.join(root,'bots',bot.id),files=await readdir(path.join(state,'gateway-receipts'));const receipts=await Promise.all(files.map(async file=>JSON.parse(await readFile(path.join(state,'gateway-receipts',file),'utf8'))));
  const deliveries=receipts.filter(r=>r.result?.result?.delivered&&r.result?.result?.title===widget.title);expect(deliveries).toHaveLength(1);
  await expect.poll(async()=>(await hub.store.pendingForBot(bot.id)).length,{timeout:60000}).toBe(0);
  // Exercise the policy with a real persisted v5 session, then a fresh v3
  // session. Neither user prompt names the setting or asks the model to avoid it.
  await hub.widgetSettings.update({ requestId: 'disable-live', revision: hub.widgetSettings.status().revision, enabled: false }, operation => hub.store.db.serial(operation));
  await page.getByRole('button',{name:'收起交互组件',exact:true}).click();
  const offTurns: { conversationId: string; text: string; widgetCount: number }[] = [];
  for (const fresh of [false, true]) {
    const target = fresh ? await hub.store.createConversation('owner',[bot.id],'关闭图形的新会话','widget_off_live') : conv;
    if (fresh) { await page.reload(); await waitForClientOnline(page); await selectConversation(page,target.title); }
    const before = (await hub.store.snapshot('owner',target.id)).messages.map(m=>m.id);
    await page.getByLabel('消息',{exact:true}).fill('这是验收示例，不需要上网：周一完成2项、周二完成4项、周三完成3项。帮我比较三天的变化并计算总数，直接给出结果。');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(async()=>(await hub.store.snapshot('owner',target.id)).messages.some(m=>!before.includes(m.id)&&m.authorType==='user'),{timeout:10000}).toBe(true);
    await expect.poll(async()=>(await hub.store.snapshot('owner',target.id)).messages.filter(m=>!before.includes(m.id)&&m.authorType==='bot').map(m=>blocksText(m.blocks)).join('\n'),{timeout:120000}).toContain('9');
    await expect.poll(async()=>(await hub.store.pendingForBot(bot.id)).length,{timeout:120000}).toBe(0);
    const after=(await hub.store.snapshot('owner',target.id)).messages.filter(m=>!before.includes(m.id)&&m.authorType==='bot');
    const text=after.map(m=>blocksText(m.blocks)).join('\n');
    expect(text).toContain('9');
    const widgetCount=after.flatMap(m=>m.blocks).filter(b=>readWidget(b)).length; expect(widgetCount).toBe(0);
    offTurns.push({conversationId:target.id,text,widgetCount});
  }
  await selectConversation(page,conv.title); await page.locator(report?'.inline-report':'.inline-widget').scrollIntoViewIfNeeded(); await expect(page.locator(report?'.inline-report':'.inline-widget iframe')).toHaveCount(1);
  const threadContracts = await Promise.all((await readdir(path.join(state,'app-tool-threads'))).map(async file=>JSON.parse(await readFile(path.join(state,'app-tool-threads',file),'utf8'))));
  expect(new Set(threadContracts.map(value=>value.toolVersion)).size).toBe(2);
  await writeFile(info.outputPath('live-widget-off.json'),JSON.stringify({model:'gpt-6.1-sol',effort:'low',offTurns,threadContracts,historyWidgetStillVisible:true},null,2));
  await writeFile(info.outputPath('live-widget.json'),JSON.stringify({model:'gpt-6.1-sol',effort:'low',toolNamesAbsentFromPrompt:true,widgetCount:messages.flatMap(m=>m.blocks).filter(b=>readWidget(b)).length,title:widget.title,htmlBytes:Buffer.byteLength(widget.html),reportBytes:report?Buffer.byteLength(JSON.stringify(report)):undefined,physicalDevices:false,durableNativeReceipts:deliveries.length},null,2));
 }finally{await page.close();await hub.close();await archiveAcceptanceThreads(root);await rm(root,{recursive:true,force:true});}
});
