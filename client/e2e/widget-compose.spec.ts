import { preparePairing } from "./fixtures/pairing-invite.js";
import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { widgetBlock } from '../../src/client-protocol/widget.js';
import { sendChoiceFixture } from './fixtures/claude-send-choice.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
const guest = (page: Page) => page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
const html = `<p>方案探索</p><button id="choose">选择方案 B</button><p id="selected">方案 A</p><button id="compose">填入输入框</button><p id="receipt"></p><script>
let choice='方案 A'; document.querySelector('#choose').onclick=()=>{choice='方案 B';document.querySelector('#selected').textContent=choice};
document.querySelector('#compose').onclick=async()=>{const ok=await tarobot.prompt.compose('请进一步分析'+choice);document.querySelector('#receipt').textContent=String(ok)};
</script>`;
async function open(page: Page, f: Awaited<ReturnType<typeof sendChoiceFixture>>, source=html) {
  await page.goto(f.hub.url); await preparePairing(page, f.hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
  await f.hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
  await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page);
  await selectConversation(page, f.chats[0]!.title);
  const input=page.getByRole('textbox',{name:'消息',exact:true});
  await input.fill('先做一项任务'); await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await expect(page.getByRole('radio',{name:/^(补充当前|补充)$/})).toBeChecked();
  await f.hub.store.publishBotMessage('bot',{id:'widget_compose',conversationId:f.chats[0]!.id,status:'complete',blocks:[widgetBlock({title:'方案探索',summary:'选择方案后放入输入框，发送方式仍由你决定。',html:source})]});
  await expect(guest(page).locator('button').first()).toHaveAttribute('data-tarobot-node',/\d+/);
  return input;
}
for(const phone of [false,true]) test.describe(phone?'touch phone':'desktop mouse',()=>{
 test.use({hasTouch:phone,isMobile:phone});
 test(`${phone?'phone':'desktop'} widget hands selection to the owning draft without sending or changing queue`,async({page},info)=>{
  await page.setViewportSize(phone?{width:390,height:844}:{width:1360,height:900}); const f=await sendChoiceFixture();
  try{
    const input=await open(page,f); await input.fill('原有草稿');
    const queue=page.getByRole('radio',{name:/^(排到下一轮|排队)$/}); await queue.check();
    await guest(page).getByRole('button',{name:'选择方案 B'}).click();
    await page.getByRole('button',{name:'放大交互组件'}).click();
    const handoff=guest(page).getByRole('button',{name:'填入输入框'});if(phone)await handoff.tap();else await handoff.click();
    await expect(input).toHaveValue('原有草稿\n\n请进一步分析方案 B');
    await expect(queue).toBeChecked(); await expect(page.locator('.widget-expanded')).toHaveCount(0);
    await expect(page.getByText('已填入输入框，未自动发送。')).toBeVisible();
    await expect(guest(page).locator('#selected')).toHaveText('方案 B');
    expect(f.turns).toHaveLength(1); expect(f.inputs).toHaveLength(0); expect(f.controls).toHaveLength(0);
    await page.screenshot({path:info.outputPath(`compose-${phone?'phone':'desktop'}.png`),animations:'disabled'});
    // Explicit ordinary Send still follows the existing queue choice.
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect(page.getByRole('button',{name:'管理待执行消息，共 1 条',exact:true})).toBeVisible();
    expect(f.turns).toHaveLength(1); expect(f.inputs).toHaveLength(0); expect(f.controls).toHaveLength(0);
  }finally{await page.close();await f.close()}
});
});

test('widget cannot overwrite attachments, quotation or another conversation draft',async({page})=>{
 const f=await sendChoiceFixture();try{
  const input=await open(page,f);await input.fill('保留此草稿');
  await page.locator('input.attachment-picker-input').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('keep me')});
  await page.locator('[data-message-id="widget_compose"]').getByRole('button',{name:'引用回复',exact:true}).click();
  await guest(page).getByRole('button',{name:'填入输入框'}).click();
  await expect(input).toHaveValue('保留此草稿\n\n请进一步分析方案 A');
  await expect(page.locator('.composer-wrap')).toContainText('notes.txt');
  await expect(page.getByRole('button',{name:'取消引用',exact:true})).toBeVisible();
  await selectConversation(page,f.chats[1]!.title);await input.fill('另一个会话');
  await selectConversation(page,f.chats[0]!.title);await expect(input).toHaveValue('保留此草稿\n\n请进一步分析方案 A');
  expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
 }finally{await page.close();await f.close()}
});

test('a delayed compose receipt inside the viewer deadline still reaches the widget',async({page})=>{
 const f=await sendChoiceFixture();try{
  const input=await open(page,f);
  // Delay only the App delivery, preserving the real relay Window and key.
  // The former five-second relay cleanup lost this valid six-second receipt.
  await page.evaluate(()=>{
   const delay=(event:MessageEvent)=>{
    if(event.data?.type!=='tarobot-widget-compose')return;
    window.removeEventListener('message',delay,true);event.stopImmediatePropagation();
    const {data,source}=event;
    setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data,source})),5500);
   };
   window.addEventListener('message',delay,true);
  });
  await guest(page).getByRole('button',{name:'填入输入框'}).click();
  await expect(input).toHaveValue('请进一步分析方案 A',{timeout:10_000});
  await expect(guest(page).locator('#receipt')).toHaveText('true');
  expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
 }finally{await page.close();await f.close()}
});

test('load, synthetic, hover, delayed and duplicate compose calls cannot silently insert text',async({page})=>{
 const f=await sendChoiceFixture(); const source=`<p id="result"></p><button id="auto">Synthetic</button><button id="hover">Hover</button><button id="late">Delayed</button><button id="twice">Twice</button><button id="bad">Bad</button><script>
const result=document.querySelector('#result');const ask=async s=>{const ok=await tarobot.prompt.compose(s);result.textContent=s+':'+ok};
ask('load');document.querySelector('#auto').onclick=()=>ask('synthetic');document.querySelector('#auto').click();
document.querySelector('#hover').onmouseenter=()=>ask('hover');document.querySelector('#late').onclick=()=>setTimeout(()=>ask('delayed'),50);
document.querySelector('#twice').onclick=async()=>{const a=tarobot.prompt.compose('once'),b=tarobot.prompt.compose('twice');result.textContent=String(await a)+':'+String(await b)};
document.querySelector('#bad').onclick=async()=>{result.textContent=String(await tarobot.prompt.compose('/stop'))};
</script>`;
 try{const input=await open(page,f,source);await expect(input).toHaveValue('');
  await guest(page).locator('#hover').hover();await expect(guest(page).locator('#result')).toHaveText('hover:false');
  await guest(page).locator('#late').click();await expect(guest(page).locator('#result')).toHaveText('delayed:false');await expect(input).toHaveValue('');
  await guest(page).locator('#bad').click();await expect(guest(page).locator('#result')).toHaveText('false');await expect(input).toHaveValue('');
  await guest(page).locator('#twice').click();await expect(input).toHaveValue('once');
  await expect(guest(page).locator('#result')).toHaveText('true:false');expect(f.inputs).toHaveLength(0);expect(f.controls).toHaveLength(0);
 }finally{await page.close();await f.close()}
});

for (const width of [390,1360]) test(`generic authored scenario calculator at ${width}px`, async ({page},info) => {
 await page.setViewportSize({width,height:900}); const f=await sendChoiceFixture();
 try {
  const input=await open(page,f,await readFile('../docs/examples/widget-scenario-explorer.html','utf8'));
  const frame=guest(page);
  await expect(frame.locator('#result')).toContainText('2,960');
  await frame.getByRole('slider',{name:'人数',exact:true}).press('ArrowRight');
  await expect(frame.locator('#people-label')).toHaveText('7');
  await frame.getByRole('combobox',{name:'天数',exact:true}).selectOption('3');
  await frame.getByRole('checkbox',{name:'包含餐饮'}).uncheck();
  await frame.getByRole('button',{name:'舒适方案',exact:true}).click();
  await expect(frame.locator('#result')).toContainText('5,400');
  await frame.locator('#extra-question > summary').click();
  await frame.getByRole('textbox',{name:'补充问题',exact:true}).fill('还有没有更合适的安排？');
  await selectConversation(page,f.chats[1]!.title);await selectConversation(page,f.chats[0]!.title);
  await expect(frame.getByRole('textbox',{name:'补充问题',exact:true})).toHaveValue('还有没有更合适的安排？');
  await expect(frame.locator('#result')).toContainText('5,400');
  for (const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
   await expect.poll(()=>frame.locator('html').evaluate(node=>getComputedStyle(node).colorScheme)).toBe(theme);
   expect(await frame.locator('body').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
   await page.locator('.inline-widget').scrollIntoViewIfNeeded();
   await page.locator('.inline-widget').screenshot({path:info.outputPath(`scenario-${width}-${theme}.png`),animations:'disabled'});
  }
  await frame.getByRole('button',{name:'填入输入框',exact:true}).click();
  await expect(input).toHaveValue('请分析舒适活动方案：7人，3天，不含餐饮，总预算5400元。还有没有更合适的安排？');
  await frame.getByRole('button',{name:'重置参数',exact:true}).click();
  await expect(frame.locator('#result')).toContainText('2,960');
  await expect(frame.getByRole('checkbox',{name:'包含餐饮'})).toBeChecked();
  expect(f.inputs).toHaveLength(0);expect(f.turns).toHaveLength(1);
 } finally {await page.close();await f.close()}
});


test('authored local state survives conversation teardown but is isolated from another message',async({page})=>{
 const source=`<button id="inc">增加</button><p id="count"></p><script>
 let count=Number(tarobot.state.initial?.count)||0;const draw=()=>document.querySelector('#count').textContent=String(count);draw();
 document.querySelector('#inc').onclick=()=>{count++;draw();tarobot.state.set({count})};</script>`;
 const f=await sendChoiceFixture();try{
  await open(page,f,source);await guest(page).locator('#inc').click();await expect(guest(page).locator('#count')).toHaveText('1');
  await selectConversation(page,f.chats[1]!.title);
  await f.hub.store.publishBotMessage('bot',{id:'widget_other',conversationId:f.chats[1]!.id,status:'complete',blocks:[widgetBlock({title:'独立组件',summary:'不同消息不继承参数',html:source})]});
  await expect(guest(page).locator('#count')).toHaveText('0');
  await selectConversation(page,f.chats[0]!.title);await expect(guest(page).locator('#count')).toHaveText('1');
  await page.reload();await waitForClientOnline(page);await selectConversation(page,f.chats[0]!.title);await expect(guest(page).locator('#count')).toHaveText('0');
 }finally{await page.close();await f.close()}
});


test('forwarded widgets remain local-only and cannot acquire the recipient composer',async({page})=>{
 const f=await sendChoiceFixture();try{
  const input=await open(page,f);
  const {message:copy}=await f.hub.attachments.forward('owner',{v:1,type:'message.forward',conversationId:f.chats[1]!.id,sourceMessageId:'widget_compose',clientMsgId:'forward-widget'});
  await selectConversation(page,f.chats[1]!.title);await input.fill('接收会话草稿');
  await expect(page.locator(`[data-message-id="${copy.id}"]`)).toBeVisible();
  await guest(page).getByRole('button',{name:'选择方案 B'}).click();await expect(guest(page).locator('#selected')).toHaveText('方案 B');
  await guest(page).getByRole('button',{name:'填入输入框'}).click();await expect(guest(page).locator('#receipt')).toHaveText('false');
  await expect(input).toHaveValue('接收会话草稿');expect(f.turns).toHaveLength(1);expect(f.inputs).toHaveLength(0);
 }finally{await page.close();await f.close()}
});
