import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { messageAction } from './fixtures/message-actions.js';
import { showDisconnectedBots, selectConversation, waitForClientOnline } from './fixtures/mobile.js';

const cases = [
  { width:1360, palette:'white-violet', theme:'light' },
  { width:390, palette:'white-teal', theme:'light' },
  { width:320, palette:'mono', theme:'light' },
  { width:390, palette:'white-violet', theme:'dark' },
  { width:1360, palette:'cli', theme:'light' },
  { width:390, palette:'pixel', theme:'dark' },
];
for (const config of cases) test(`a quoted reply is one readable send surface (${config.width} ${config.palette} ${config.theme})`, async ({page}, info) => {
  await page.setViewportSize({width:config.width,height:900});
  const root=await mkdtemp(path.join(os.tmpdir(),'quoted-reply-'));
  const hub=await HubServer.start({stateDir:root,clientDir:path.resolve('dist')});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','GG1','fixture')");
    const conversation=await hub.store.createConversation('owner',['alpha'],'设备页面讨论','chat');
    const original=await hub.store.publishBotMessage('alpha',{conversationId:conversation.id,blocks:[{type:'card',title:'已完成',elements:[{type:'markdown',text:'已和 **Opus 5.5 xhigh** 做了两轮讨论。建议将页面按当前设备、其他设备和已撤销记录重新组织。\n\n旧设备名称会保留，当前设备依据身份识别。\n\n| 位置 | 展示方式 |\n| --- | --- |\n| 第一组 | 你正在使用 |\n| 第二组 | 其他可访问设备 |\n\n```js\nconst current = device.id === identity.deviceId;\n```\n\n详细内容保留在原消息中。'}]}]});
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
    await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
    await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'}); await showDisconnectedBots(page);
    await waitForClientOnline(page); await selectConversation(page,conversation.title);
    await page.evaluate(({palette,theme})=>{document.documentElement.dataset.palette=palette;document.documentElement.dataset.theme=theme;},config);
    const source=page.locator(`[data-message-id="${original.id}"]`);
    await messageAction(page,source,'引用回复');
    await page.getByRole('textbox',{name:'消息',exact:true}).fill('修改啊');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(async ()=>(await hub.store.snapshot('owner',conversation.id)).messages.filter(m=>m.authorType==='user').length).toBe(1);
    const reply=(await hub.store.snapshot('owner',conversation.id)).messages.find(m=>m.authorType==='user')!;
    expect(reply.replyTo).toBe(original.id); expect(reply.blocks).toEqual([{type:'text',text:'修改啊'}]);
    const row=page.locator(`[data-message-id="${reply.id}"]`), bubble=row.locator('.message-blocks');
    await expect(bubble.locator(':scope > .quoted-message')).toBeVisible();
    await expect(bubble.locator(':scope > .markdown')).toHaveText('修改啊');
    await expect(row.locator('.message-body > .message-reference')).toHaveCount(0);
    const preview=bubble.locator('.rich-preview-viewport');
    await expect(bubble.getByRole('button',{name:'展开预览',exact:true})).toBeVisible();
    expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(61);
    const geometry=await bubble.evaluate(element=>{
      const r=element.getBoundingClientRect(),q=element.querySelector('.quoted-message')!.getBoundingClientRect(),body=element.querySelector(':scope > .markdown')!.getBoundingClientRect();
      const color=getComputedStyle(element).backgroundColor;
      const text=getComputedStyle(element.querySelector('.rich-preview-content .markdown')!).color;
      const luminance=(value:string)=>{const rgb=value.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
      const a=luminance(color),b=luminance(text);
      return {inside:q.left>=r.left && q.right<=r.right+1 && body.top>=q.bottom && body.bottom<=r.bottom+1,viewport:r.left>=0 && r.right<=innerWidth+1,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),quoteBackground:getComputedStyle(element.querySelector('.quoted-message')!).backgroundColor};
    });
    expect(geometry.inside).toBe(true); expect(geometry.viewport).toBe(true);
    expect(geometry.contrast).toBeGreaterThanOrEqual(4.5); expect(geometry.quoteBackground).toBe('rgba(0, 0, 0, 0)');
    await row.screenshot({path:info.outputPath('reply-collapsed.png'),animations:'disabled'});
    await bubble.screenshot({path:info.outputPath('bubble.png'),animations:'disabled'});
    await page.screenshot({path:info.outputPath('conversation.png'),animations:'disabled'});
    await bubble.getByRole('button',{name:'展开预览',exact:true}).click();
    await expect(bubble.locator('.quoted-message table')).toContainText('你正在使用');
    await expect(bubble.locator('.quoted-message pre code')).toContainText('device.id === identity.deviceId');
    await bubble.getByRole('button',{name:'收起预览',exact:true}).click();
    await bubble.getByRole('button',{name:'查看引用原消息',exact:true}).click();
    await expect(source).toHaveClass(/focused-message/);
    await hub.store.publishBotMessage('alpha',{id:original.id,conversationId:conversation.id,blocks:[],status:'deleted'});
    await expect(bubble).toContainText('原消息已删除或当前不可访问');
    await expect(bubble.getByRole('button',{name:'查看引用原消息',exact:true})).toBeDisabled();
    await expect(bubble.locator(':scope > .markdown')).toHaveText('修改啊');
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});
