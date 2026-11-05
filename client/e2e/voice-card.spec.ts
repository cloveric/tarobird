import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { translateCard } from '../../src/gateway/card-translator.js';
import { showDisconnectedBots, enterMobileChat, waitForClientOnline } from './fixtures/mobile.js';
import { messageAction } from './fixtures/message-actions.js';
import { blocksText } from '../../src/client-protocol/index.js';

test('legacy transcription cards hide generated recording names but preserve original files and text', async ({page}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-cards-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','语音助手','fixture')");
    const chat = await hub.store.createConversation('owner',['alpha'],'语音转写','voice');
    const generated = 'voice-1791780593981.m4a';
    for (const name of [generated,'项目会议.m4a']) {
      const block = translateCard({schema:'2.0',body:{elements:[
        {tag:'markdown',content:'**音频转写完成**'},
        {tag:'div',text:{tag:'plain_text',content:name}},
        {tag:'markdown',content:'帮我查询周四上海飞北京的航班。'},
      ]}});
      await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[block]});
    }
    await page.setViewportSize({width:390,height:844}); await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
    await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
    await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'}); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page,chat.title);
    await expect(page.locator('.rich-card')).toHaveCount(2);
    await expect(page.locator('.rich-card').first()).toContainText('帮我查询周四上海飞北京的航班。');
    await expect(page.locator('.rich-card').first()).not.toContainText(generated);
    await expect(page.locator('.rich-card').last()).toContainText('项目会议.m4a');
    await expect(page.getByRole('button', { name: '展开转写', exact: true })).toHaveCount(0);
    expect(JSON.stringify((await hub.store.snapshot('owner',chat.id)).messages)).toContain(generated);
    await page.screenshot({path:info.outputPath('voice-transcript-clean.png')});
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});

for (const width of [390, 1360]) test(`long transcription folds without losing copy text or status at ${width}px`, async ({page}, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-fold-'));
  const hub = await HubServer.start({stateDir:root, clientDir:path.resolve('dist')});
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const body = ('今天讨论项目安排，先核对资料和交付时间，再逐项确认负责人。\n'.repeat(80).slice(0, 1900)
    + '\n尾段：周五完成复核。[尾部来源](https://example.com/meeting)').padEnd(2000, '。')
    + '\n\n这里只显示前 2000 字，完整转写已交给 Bot。';
  const card = (title: string, text: string, name = '项目讨论.m4a') => translateCard({schema:'2.0',body:{elements:[
    {tag:'markdown',content:`**${title}**`},
    {tag:'div',text:{tag:'plain_text',content:name}},
    {tag:'markdown',content:text},
  ]}});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','语音助手','fixture')");
    const chat = await hub.store.createConversation('owner',['alpha'],'录音转写','fold');
    const message = await hub.store.publishBotMessage('alpha',{conversationId:chat.id,blocks:[card('正在转写音频…','完成后 Bot 会自动继续。')]});
    await page.setViewportSize({width,height:844}); await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
    await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
    await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'}); await showDisconnectedBots(page); await waitForClientOnline(page); await enterMobileChat(page,chat.title);
    const article = page.locator(`[data-message-id="${message.id}"]`), receipt = article.locator('.rich-card');
    await expect(receipt).toContainText('正在转写音频…');
    await expect(article.locator('.voice-transcript-toggle')).toHaveCount(0);
    const complete = card('音频转写完成',body);
    await hub.store.publishBotMessage('alpha',{id:message.id,conversationId:chat.id,blocks:[complete]});
    const expand = article.getByRole('button',{name:'展开转写',exact:true});
    await expect(expand).toBeVisible(); await expect(expand).toHaveAttribute('aria-expanded','false');
    await expect(receipt).toContainText('音频转写完成'); await expect(receipt).toContainText('项目讨论.m4a');
    await expect(article.getByRole('link',{name:'尾部来源'})).toHaveCount(0);
    const foldedHeight = await receipt.evaluate(node => node.getBoundingClientRect().height);
    expect(foldedHeight).toBeLessThan(310);
    expect(await receipt.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({path:info.outputPath(`voice-folded-${width}.png`)});
    await expand.focus(); await page.keyboard.press('Enter');
    const collapse = article.getByRole('button',{name:'收起转写',exact:true});
    await expect(collapse).toHaveAttribute('aria-expanded','true');
    await expect(article.getByRole('link',{name:'尾部来源'})).toHaveAttribute('href','https://example.com/meeting');
    await expect(receipt).toContainText('这里只显示前 2000 字，完整转写已交给 Bot。');
    expect(await receipt.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(foldedHeight + 200);
    await collapse.focus(); await page.keyboard.press('Space');
    await expect(expand).toHaveAttribute('aria-expanded','false');
    await expect(expand).toBeFocused();
    await expand.click(); await expect(collapse).toHaveAttribute('aria-expanded','true');
    await collapse.click(); await expect(expand).toHaveAttribute('aria-expanded','false');
    await expect(article.getByRole('link',{name:'尾部来源'})).toHaveCount(0);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async (value: string) => { (window as any).copiedTranscript = value; }}}));
    await messageAction(page,article,'复制消息');
    await expect.poll(() => page.evaluate(() => (window as any).copiedTranscript)).toBe(blocksText([complete]));
    await page.keyboard.press('Escape');
    const stored = (await hub.store.snapshot('owner',chat.id)).messages.find(item => item.id === message.id)!;
    expect(stored.blocks).toEqual([complete]);
    await hub.store.publishBotMessage('alpha',{id:message.id,conversationId:chat.id,blocks:[card('部分转写完成','缺失片段: 2 / 3\n\n'+body,'voice-1791780593981.m4a')]});
    await expect(receipt).toContainText('部分转写完成'); await expect(receipt).toContainText('缺失片段: 2 / 3');
    await expect(receipt).not.toContainText('voice-1791780593981.m4a'); await expect(expand).toBeVisible();
    await hub.store.publishBotMessage('alpha',{id:message.id,conversationId:chat.id,blocks:[card('普通会议记录',body)]});
    await expect(article.locator('.voice-transcript-toggle')).toHaveCount(0);
    await expect(receipt).toContainText('尾段：周五完成复核。');
    expect(errors).toEqual([]);
  } finally { await page.close(); await hub.close(); await rm(root,{recursive:true,force:true}); }
});
