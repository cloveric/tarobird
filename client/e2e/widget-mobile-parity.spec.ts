import { preparePairing } from "./fixtures/pairing-invite.js";
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { widgetBlock } from '../../src/client-protocol/widget.js';
import { sendChoiceFixture } from './fixtures/claude-send-choice.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';
import { mountWidget } from './fixtures/widget-runtime-host.js';

test.use({serviceWorkers:'block'});
const guest=(page:Page)=>page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
async function fixture(page:Page){
 const f=await sendChoiceFixture();
 await f.hub.store.publishBotMessage('bot',{id:'mobile_workbench',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'筛选方案与分步规划',summary:'本地筛选、分步填写和流程说明。示例数据，不会自动发送。',html:await readFile('../docs/examples/widget-decision-workbench.html','utf8')})]});
 await page.goto(f.hub.url);await preparePairing(page, f.hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
 await f.hub.auth.approve((await page.locator('.pair-code').innerText()).replace(/\s/g,''),'local-owner');
 await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});
 await waitForClientOnline(page);await selectConversation(page,f.chats[0]!.title);
 await expect(guest(page).locator('#tab-options')).toHaveAttribute('data-tarobot-node',/\d+/);
 return f;
}

const sizes: {width:number;height:number;userAgent?:string}[] = [[320,740],[390,844],[430,932],[844,390],[1360,900]].map(([width,height])=>({width:width!,height:height!}));
sizes.push({width:844,height:390,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
for(const {width,height,userAgent} of sizes)test.describe(`workbench ${width}x${height}${userAgent?' iOS WebKit reading compensation':''}`,()=>{
 // The iOS compensation algorithm belongs to WebKit. A Safari UA on Chromium
 // creates an impossible engine/platform pair with different scroll geometry;
 // the ordinary 844x390 case above still exercises Chromium with its own UA.
 test.use({viewport:{width,height},hasTouch:width!==1360,isMobile:width!==1360,...(userAgent?{userAgent}:{})});
 test('linked filtering, a two-step form and a process explanation remain usable',async({page,browserName},info)=>{
  test.skip(!!userAgent && browserName !== 'webkit', 'iOS scroll compensation is a WebKit-only platform test; Chromium uses its own UA in the other 844x390 case.');
  const f=await fixture(page);try{
   const frame=guest(page);
   await frame.locator('#mode').selectOption('onsite');await expect(frame.locator('#match-count')).toHaveText('2 个方案符合条件');
   await frame.locator('[data-choice=b]').click();await expect(frame.locator('#selection')).toContainText('现场共创');
   await frame.locator('#budget').fill('1000');await expect(frame.locator('#match-count')).toHaveText('0 个方案符合条件');
   await expect(frame.locator('#selection')).toContainText('不在当前筛选结果中');
   await frame.locator('#budget').fill('3000');await expect(frame.locator('#match-count')).toHaveText('1 个方案符合条件');
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
    await expect.poll(()=>frame.locator('html').evaluate(e=>getComputedStyle(e).colorScheme)).toBe(theme);
    expect(await frame.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
    await page.locator('.inline-widget').screenshot({path:info.outputPath(`filter-${width}-${theme}.png`),animations:'disabled'});
   }
   await frame.locator('#tab-plan').click();await frame.locator('#next').click();await expect(frame.locator('#step-label')).toHaveText('第 1 步，共 2 步');
   await frame.locator('#plan-name').fill('周五产品讨论');await frame.locator('#notes').fill('保留原有安排。\n讨论结束后一起确认改进项。');
   await page.getByRole('button',{name:'放大交互组件',exact:true}).click();
   await expect(frame.locator('#plan-name')).toHaveValue('周五产品讨论');
   await frame.locator('#next').click();await expect(frame.locator('#step-label')).toHaveText('第 2 步，共 2 步');
   await expect(frame.locator('#review')).toContainText('周五产品讨论：现场共创');
   await frame.locator('#back').click();await expect(frame.locator('#notes')).toHaveValue('保留原有安排。\n讨论结束后一起确认改进项。');
   await frame.locator('#tab-flow').click();await frame.locator('[data-stage="2"]').click();await expect(frame.locator('#stage-title')).toHaveText('安排执行');
   await frame.locator('#stage-next').click();await expect(frame.locator('#stage-title')).toHaveText('回顾调整');await expect(frame.locator('#stage-next')).toBeDisabled();
   expect(await frame.locator('body').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath(`flow-expanded-${width}-dark.png`),animations:'disabled'});
   // The expanded panel must fit a short landscape window and retain its close affordance.
   const bounds=await page.locator('.widget-expanded').boundingBox();expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(height+1);
   await page.getByRole('button',{name:'收起交互组件',exact:true}).click();
   await frame.locator('#tab-plan').click();await frame.locator('#next').click();await frame.locator('#compose').click();
   await expect(page.locator('.composer textarea')).toHaveValue(/请完善这份计划：周五产品讨论：现场共创/);
   expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(0);
  }finally{await page.close();await f.close()}
 });
});

test.describe('widget keyboard viewport',()=>{
 test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 test('expanded authored and fixed reports stay in the visible keyboard band',async({page},info)=>{
  const f=await fixture(page);try{
   await page.getByRole('button',{name:'放大交互组件',exact:true}).click();
   await guest(page).locator('#tab-plan').click();await guest(page).locator('#notes').focus();
   // Exercise the native viewport controller's CSS contract, without claiming
   // browser emulation opens an actual iOS keyboard.
   const keyboard=()=>page.evaluate(()=>{const root=document.documentElement;root.style.setProperty('--app-height','470px');root.style.setProperty('--app-top','20px');root.setAttribute('data-keyboard-open','true')});
   await keyboard();
   let box=await page.locator('.widget-expanded').boundingBox();
   // The focused editor must remain readable after the iframe shrinks, not
   // merely exist somewhere inside a keyboard-safe modal.
   await expect.poll(async()=>{
    const editor=await guest(page).locator('#notes').boundingBox(),port=await page.locator('.widget-expanded > iframe').boundingBox();
    return !!editor&&!!port&&editor.y>=port.y-1&&editor.y+editor.height<=port.y+port.height+1;
   }).toBe(true);
   await page.screenshot({path:info.outputPath('authored-keyboard-band.png')});
   expect(box!.y).toBeGreaterThanOrEqual(20);expect(box!.y+box!.height).toBeLessThanOrEqual(490);
   await page.getByRole('button',{name:'收起交互组件',exact:true}).click();
   await f.hub.store.publishBotMessage('bot',{id:'mobile_workbench',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'报告筛选',summary:'同一个可见窗口约束。',report:{version:1,columns:['日期','数值'],rows:Array.from({length:12},(_,i)=>[String(i),i])}})]});
   await page.getByRole('button',{name:'放大交互组件',exact:true}).click();await page.getByRole('searchbox',{name:'筛选报告'}).focus();await keyboard();
   box=await page.locator('.report-panel:modal').boundingBox();
   await page.screenshot({path:info.outputPath('report-keyboard-band.png')});
   expect(box!.y).toBeGreaterThanOrEqual(20);expect(box!.y+box!.height).toBeLessThanOrEqual(490);
   await page.evaluate(()=>{const root=document.documentElement;root.style.removeProperty('--app-height');root.style.removeProperty('--app-top');root.setAttribute('data-keyboard-open','false')});
   await page.getByRole('button',{name:'收起交互组件',exact:true}).click();
  }finally{await page.close();await f.close()}
 });
});

test.describe('report phone reading',()=>{
 test.use({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 test('wide details advertise horizontal scrolling and respect asymmetric safe areas',async({page},info)=>{
  const f=await fixture(page);try{
   await f.hub.store.publishBotMessage('bot',{id:'mobile_workbench',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'不同方案完整明细',summary:'演示数据，所有列保持可读。',report:{version:1,columns:['方案','安排方式','预算','天数','说明'],rows:[['现场工作坊','现场',2500,1,'包含讨论与回顾'],['异地协作','远程',1500,1,'保留完整的结果记录']]}})]});
   await expect(page.locator('.report-table-hint')).toHaveText('左右滑动查看');
   const port=page.getByRole('region',{name:'报告明细',exact:true});await port.focus();await port.press('ArrowRight');
   await expect.poll(()=>port.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);
   expect(await page.locator('.inline-report').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);
   await page.screenshot({path:info.outputPath('report-phone-details.png')});
   await page.setViewportSize({width:844,height:390});
   await page.evaluate(()=>{document.documentElement.style.setProperty('--app-safe-left','48px');document.documentElement.style.setProperty('--app-safe-right','24px')});
   await page.getByRole('button',{name:'放大交互组件',exact:true}).click();
   const box=await page.locator('.report-panel:modal').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(48);expect(box!.x+box!.width).toBeLessThanOrEqual(820);
   await expect(page.locator('.report-table-hint')).toHaveCount(0);
   await page.screenshot({path:info.outputPath('report-landscape-safe-area.png')});
  }finally{await page.close();await f.close()}
 });
});

for(const [platform,bodySize,inputSize] of [['ios','14px','16px'],['android','14px','14px'],['web','14px','14px'],['ios','20px','20px']])test(`${platform} widget fields keep ${inputSize} and body stays ${bodySize}`,async({page})=>{
 const {guest:frame}=await mountWidget(page,'<p>正文保持原字号</p><input aria-label="姓名"><select aria-label="选项"><option>A</option></select><textarea aria-label="备注"></textarea><input type="checkbox"><input type="range"><input type="button" value="Action"><script>document.body.dataset.ready="yes"</script>',{width:320,theme:{platform,'font-size':bodySize}});
 await expect(frame.locator('body')).toHaveAttribute('data-ready','yes');
 await expect(frame.locator('p')).toHaveCSS('font-size',bodySize);
 for(const selector of ['input:not([type])','select','textarea'])await expect(frame.locator(selector)).toHaveCSS('font-size',inputSize);
 for(const selector of ['input[type=checkbox]','input[type=range]','input[type=button]'])await expect(frame.locator(selector)).toHaveCSS('font-size',bodySize);
});

test('a runtime failure offers a scoped repair draft without sending a turn',async({page})=>{
 const f=await fixture(page);try{
  const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('原有草稿');
  await f.hub.store.publishBotMessage('bot',{id:'mobile_workbench',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'修复验收组件',summary:'原始数据仍然可读。',html:'<p>原始内容</p><script>throw new Error("WIDGET_TEST_DIAGNOSTIC")</script>'})]});
  const repair=page.getByRole('button',{name:'把问题填入输入框',exact:true});await expect(repair).toBeVisible();
  await page.getByText('诊断信息',{exact:true}).click();await expect(page.locator('.widget-diagnostic')).toContainText('WIDGET_TEST_DIAGNOSTIC');
  await repair.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click()});
  await expect(repair).toBeDisabled();await expect(input).toHaveValue(/^原有草稿\n\n请检查并修复/);await expect(input).toHaveValue(/WIDGET_TEST_DIAGNOSTIC/);
  expect((await input.inputValue()).match(/请检查并修复/g)).toHaveLength(1);
  expect(f.turns).toHaveLength(0);expect(f.inputs).toHaveLength(0);expect(f.controls).toHaveLength(0);
 }finally{await page.close();await f.close()}
});

test('repair retry clears stale diagnostics and forwarded failures cannot offer a draft action',async({page})=>{
 const f=await fixture(page);try{
  await f.hub.store.publishBotMessage('bot',{id:'mobile_workbench',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'重试诊断',summary:'保留可读说明',html:`<p>仍可阅读</p><script>const n=Number(tarobot.state.initial?.n)||0;tarobot.state.set({n:n+1});if(!n)throw new Error('FIRST_FAILURE_ONLY');throw 7;</script>`})]});
  await expect(page.locator('.widget-diagnostic')).toContainText('FIRST_FAILURE_ONLY');
  const repair=page.getByRole('button',{name:'把问题填入输入框',exact:true});await repair.click();await expect(repair).toBeDisabled();
  await page.getByRole('button',{name:'重新加载组件',exact:true}).click();
  await expect(repair).toBeEnabled();await expect(page.locator('.widget-diagnostic')).toHaveCount(0);
  const input=page.getByRole('textbox',{name:'消息',exact:true});await input.fill('保留重试草稿');await repair.click();
  await expect(input).toHaveValue(/^保留重试草稿\n\n请检查并修复/);expect(await input.inputValue()).not.toContain('FIRST_FAILURE_ONLY');
  await f.hub.attachments.forward('owner',{v:1,type:'message.forward',conversationId:f.chats[1]!.id,sourceMessageId:'mobile_workbench',clientMsgId:'forward-broken-widget'});
  await selectConversation(page,f.chats[1]!.title);await input.fill('接收方草稿');
  await expect(page.locator('.widget-diagnostic')).toContainText('FIRST_FAILURE_ONLY');await expect(repair).toHaveCount(0);
  await expect(input).toHaveValue('接收方草稿');expect(f.turns).toHaveLength(0);expect(f.inputs).toHaveLength(0);
 }finally{await page.close();await f.close()}
});
