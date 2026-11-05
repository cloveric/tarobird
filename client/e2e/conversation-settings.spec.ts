import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

// Actual panel and connection notification methods with controlled network
// receipts. This is browser evidence, not a physical device acceptance test.
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><button id="chat-menu">更多对话操作</button><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css'; import '/src/brand-theme.css'; import '/src/palette-tokens.css'; import '/src/mobile-im.css'; import '/src/mobile-shell.css';
import { ConversationPanel } from '/src/ConversationPanel.tsx';
import { HubConnection } from '/src/connection.ts';
const listeners = new Set();
const f = window.settingsFixture = { reads: [], writes: [], frames: [], readMode:sessionStorage.getItem('failReads')?'fail':'normal', writeMode:'normal', sendMode:'normal', muted:false, closed:false,
conv:{id:'chat',type:'direct',title:'原名称',botIds:['bot'],ownerId:'owner',createdAt:1,archived:false} };
const c = f.connection = Object.create(HubConnection.prototype);
c.closed=false; c.generation=1; c.notificationRequest=0;
c.state={status:'online', bots:[{id:'bot',name:'研究助手',engine:'kimi',online:1}], notifications:{preferences:{}, mutedConversations:[]}};
c.subscribe=notify => { listeners.add(notify); return () => listeners.delete(notify); };
c.update=value => { c.state={...c.state,...value}; listeners.forEach(fn=>fn()); };
c.cache={conversations:async()=>[f.conv]};
c.http=async(route, init)=> {
if(route==='/api/notifications') {
 f.lastReadBounded=!!init?.signal;
 const result={preferences:{},mutedConversations:f.muted?['chat']:[]};
 if(f.readMode==='fail') throw Error('read_failed');
 if(f.readMode==='hold') return new Promise(resolve=>f.reads.push(()=>resolve(result)));
 return result;
}
if(route==='/api/conversations/mute') {
 const body=JSON.parse(init.body); f.writes.push(body); f.muted=body.muted;
 if(f.writeMode==='unknown') throw Error('response_lost');
 if(f.writeMode==='hold') await new Promise(resolve=>f.releaseWrite=resolve);
 return {ok:true};
}
return [{id:'existing',title:'已有会话',updatedAt:'2026-10-06'}];
};
c.send=async frame=>{
f.frames.push(frame);
if(f.sendMode==='hold') await new Promise(resolve=>f.releaseSend=resolve);
if(f.sendMode==='unknown') throw Error('response_lost');
if(frame.type==='conversation.rename') f.conv={...f.conv,title:frame.title};
if(frame.type==='conversation.archive') f.conv={...f.conv,archived:frame.archived};
if(frame.type==='conversation.bind') f.conv={...f.conv,sessionId:frame.sessionId,bindingId:frame.sessionId?'new-binding':undefined};
c.update({});
};
const returnFocus={current:document.getElementById('chat-menu')};
function App(){React.useSyncExternalStore(c.subscribe,()=>c.state); return f.closed?React.createElement('p',null,'closed'):React.createElement(ConversationPanel,{returnFocus,connection:c,conversation:f.conv,pinned:false,pin:()=>{},chooseRecipient:()=>{},newChat:()=>{f.newCalls=(f.newCalls??0)+1;},close:()=>{f.closed=true;c.update({});}});}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
let server: ViteDevServer;
test.beforeAll(async () => {
server=await createServer({plugins:[{name:'conversation-settings-harness',configureServer(vite){
vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__settings-harness')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__settings-harness',html));});
}}],server:{port:0,host:'127.0.0.1'}}); await server.listen();
});
test.afterAll(async()=>{await server.close();});
test.beforeEach(async({page})=>{await page.goto(server.resolvedUrls!.local[0]+'__settings-harness');await expect(page.getByLabel('此对话免打扰')).toBeEnabled();});

test('acknowledged mute survives failed refresh and an older read',async({page})=>{
await page.evaluate(()=>{const f=(window as any).settingsFixture;f.readMode='hold';void f.connection.refreshNotificationPreferences();});
await page.evaluate(()=>{(window as any).settingsFixture.readMode='fail';});
await page.getByLabel('此对话免打扰').check();await expect(page.getByLabel('此对话免打扰')).toBeChecked();
await expect(page.getByText('通知设置暂时无法刷新，已保存的修改仍然有效。')).toBeVisible();
await page.evaluate(()=>(window as any).settingsFixture.reads[0]());await expect(page.getByLabel('此对话免打扰')).toBeChecked();
expect(await page.evaluate(()=>(window as any).settingsFixture.writes.length)).toBe(1);
});

test('unknown mute receipt rereads without resubmitting',async({page})=>{
await page.evaluate(()=>{(window as any).settingsFixture.writeMode='unknown';});
await page.getByLabel('此对话免打扰').check();await expect(page.getByLabel('此对话免打扰')).toBeChecked();
await expect(page.getByRole('alert')).toContainText('未能确认操作结果');
expect(await page.evaluate(()=>(window as any).settingsFixture.writes.length)).toBe(1);
});

test('commands reject double clicks and reuse uncertain request IDs',async({page})=>{
await page.evaluate(()=>{(window as any).settingsFixture.sendMode='hold';});
await page.getByRole('button',{name:'整理上下文',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
await expect(page.getByRole('status')).toContainText('正在处理');await expect(page.getByRole('button',{name:'关闭对话设置',exact:true})).toBeDisabled();
expect(await page.evaluate(()=>(window as any).settingsFixture.frames.length)).toBe(1);
await page.evaluate(()=>{const f=(window as any).settingsFixture;f.sendMode='unknown';f.releaseSend();});
await expect(page.getByRole('alert')).toContainText('response_lost');await page.getByRole('button',{name:'整理上下文',exact:true}).click();
const ids=await page.evaluate(()=>(window as any).settingsFixture.frames.map((v:any)=>v.clientMsgId));expect(ids).toHaveLength(2);expect(ids[1]).toBe(ids[0]);
});

test('trimmed rename adopts receipt while preserving newer typing',async({page})=>{
await page.getByLabel('对话名称',{exact:true}).fill('新名称  ');await page.getByRole('button',{name:'保存名称',exact:true}).click();
await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('新名称');
await page.evaluate(()=>{(window as any).settingsFixture.sendMode='hold';});
await page.getByLabel('对话名称',{exact:true}).fill('第二次  ');await page.getByRole('button',{name:'保存名称',exact:true}).click();
await page.getByLabel('对话名称',{exact:true}).fill('继续编辑');await page.evaluate(()=>(window as any).settingsFixture.releaseSend());
await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('继续编辑');await page.getByRole('button',{name:'关闭对话设置',exact:true}).click();
await expect(page.getByRole('dialog',{name:'放弃尚未保存的对话名称？',exact:true})).toBeVisible();
});

test('native back and Escape preserve unsaved names behind confirmation',async({page})=>{
await page.getByLabel('对话名称',{exact:true}).fill('未保存');await page.evaluate(()=>window.dispatchEvent(new Event('tarocub-native-back',{cancelable:true})));
const confirmation=page.getByRole('dialog',{name:'放弃尚未保存的对话名称？',exact:true});await expect(confirmation).toBeVisible();await page.keyboard.press('Escape');
await expect(confirmation).toHaveCount(0);await expect(page.getByLabel('对话名称',{exact:true})).toBeFocused();
await page.keyboard.press('Escape');await expect(confirmation).toBeVisible();await confirmation.getByRole('button',{name:'确认',exact:true}).click();
await expect(page.getByText('closed',{exact:true})).toBeVisible();
});

test('archived conversations cannot send commands or bind',async({page})=>{
await page.evaluate(()=>{const f=(window as any).settingsFixture;f.conv={...f.conv,archived:true};f.connection.update({});});
await page.getByRole('button',{name:'高级对话管理',exact:true}).click();
await page.getByRole('button',{name:'查看可继续的会话',exact:true}).click();
for(const name of ['整理上下文','重新开始上下文','使用此会话'])await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
});


test('initial refresh failure has no false save receipt and can retry',async({page})=>{
await page.evaluate(()=>sessionStorage.setItem('failReads','1'));await page.reload();
await expect(page.getByText('通知设置暂时无法刷新，请稍后重试。')).toBeVisible();
await expect(page.getByText('通知设置暂时无法刷新，已保存的修改仍然有效。')).toHaveCount(0);
expect(await page.evaluate(()=>(window as any).settingsFixture.lastReadBounded)).toBe(true);
await page.evaluate(()=>{(window as any).settingsFixture.readMode='normal';});await page.getByRole('button',{name:'重新检查',exact:true}).click();
await expect(page.getByRole('button',{name:'重新检查',exact:true})).toHaveCount(0);
});

test('successful trimmed rename can exit without false dirty confirmation',async({page})=>{
await page.getByLabel('对话名称',{exact:true}).fill('已保存  ');await page.getByRole('button',{name:'保存名称',exact:true}).click();
await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('已保存');await page.getByRole('button',{name:'关闭对话设置',exact:true}).click();
await expect(page.getByText('closed',{exact:true})).toBeVisible();
});

test('archive blocks duplicate admission and preserves edits made while pending',async({page})=>{
await page.evaluate(()=>{(window as any).settingsFixture.sendMode='hold';});
await page.getByRole('button',{name:'归档对话',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
await expect(page.getByRole('button',{name:'关闭对话设置',exact:true})).toBeDisabled();
await page.getByLabel('对话名称',{exact:true}).fill('归档期间的新编辑');await page.evaluate(()=>(window as any).settingsFixture.releaseSend());
await expect(page.getByRole('button',{name:'恢复到会话列表',exact:true})).toBeVisible();
await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('归档期间的新编辑');
expect(await page.evaluate(()=>(window as any).settingsFixture.frames.length)).toBe(1);
});

test('a queued command remains clearly disabled while an unsaved name keeps the panel open',async({page})=>{
await page.getByLabel('对话名称',{exact:true}).fill('未保存');await page.getByRole('button',{name:'整理上下文',exact:true}).click();
await expect(page.getByRole('button',{name:'整理上下文',exact:true})).toBeDisabled();
await expect(page.getByText('命令已加入发送队列；再次执行请重新打开对话设置。')).toBeVisible();
await expect(page.getByLabel('对话名称',{exact:true})).toHaveValue('未保存');
});


test('binding waits for its new receipt and blocks duplicate clicks',async({page})=>{
await page.getByRole('button',{name:'高级对话管理',exact:true}).click();
await page.getByRole('button',{name:'查看可继续的会话',exact:true}).click();
await page.getByLabel('已有会话',{exact:true}).selectOption('existing');
await page.evaluate(()=>{(window as any).settingsFixture.sendMode='hold';});
await page.getByRole('button',{name:'使用此会话',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
await expect(page.getByRole('button',{name:'使用此会话',exact:true})).toBeDisabled();
expect(await page.evaluate(()=>(window as any).settingsFixture.frames.length)).toBe(1);
await page.evaluate(()=>(window as any).settingsFixture.releaseSend());
await expect(page.getByText('会话选择已更新',{exact:true})).toBeVisible();
});

test('creating another conversation confirms discarding an edited name',async({page})=>{
await page.getByLabel('对话名称',{exact:true}).fill('未保存');
await page.getByRole('button',{name:'新建独立对话',exact:true}).click();
const confirmation=page.getByRole('dialog',{name:'放弃尚未保存的对话名称？',exact:true});
await expect(confirmation).toBeVisible();
expect(await page.evaluate(()=>(window as any).settingsFixture.newCalls??0)).toBe(0);
await confirmation.getByRole('button',{name:'确认',exact:true}).click();
expect(await page.evaluate(()=>(window as any).settingsFixture.newCalls)).toBe(1);
});


test('phone settings return focus to the stable chat menu after the original sheet has closed',async({page})=>{
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'关闭对话设置',exact:true}).click();
await expect(page.getByRole('button',{name:'更多对话操作',exact:true})).toBeFocused();
});


test('phone session actions explain their effects and keep advanced controls folded', async ({page}, info) => {
await page.setViewportSize({width:390,height:844});
const panel=page.getByRole('dialog',{name:'对话设置',exact:true});
await expect(panel.getByRole('button',{name:'新建独立对话',exact:true})).toBeVisible();
await expect(panel.getByText('开启另一段聊天，不带入这里的上下文。Bot 人设和配置继续沿用。',{exact:true})).toBeVisible();
await expect(panel.getByRole('button',{name:'重新开始上下文',exact:true})).toHaveCount(0);
await expect(panel.getByRole('button',{name:'退出接入的会话',exact:true})).toHaveCount(0);
await panel.screenshot({path:info.outputPath('session-settings-phone.png')});
await page.evaluate(()=>{document.documentElement.dataset.palette='mono';});
await panel.screenshot({path:info.outputPath('session-settings-mono-phone.png')});
await panel.getByRole('button',{name:'高级对话管理',exact:true}).click();
await expect(panel.getByText('接着此 Bot 已有的会话聊，会使用那段会话的上下文。',{exact:true})).toBeVisible();
await panel.getByRole('button',{name:'退出接入的会话',exact:true}).click();
const confirmation=page.getByRole('dialog',{name:'退出接入的会话',exact:true});
await expect(confirmation).toContainText('下一条消息从新的上下文开始');
expect(await page.evaluate(()=>(window as any).settingsFixture.frames.length)).toBe(0);
await confirmation.getByRole('button',{name:'取消',exact:true}).click();
await panel.getByRole('button',{name:'重新开始上下文',exact:true}).click();
await expect(page.getByRole('dialog',{name:'重新开始上下文',exact:true})).toContainText('聊天记录和 Bot 人设');
await page.getByRole('dialog',{name:'重新开始上下文',exact:true}).getByRole('button',{name:'取消',exact:true}).click();
await panel.screenshot({path:info.outputPath('session-settings-advanced-phone.png')});
expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
await page.setViewportSize({width:320,height:700});
expect(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
await panel.screenshot({path:info.outputPath('session-settings-dark-small.png')});
await panel.getByRole('button',{name:'退出接入的会话',exact:true}).click();
await page.getByRole('dialog',{name:'退出接入的会话',exact:true}).getByRole('button',{name:'确认',exact:true}).click();
expect(await page.evaluate(()=>(window as any).settingsFixture.frames.map((frame:any)=>frame.text))).toEqual(['/detach']);
});

test('context compaction is offered only for engines that implement it', async ({page})=>{
for(const engine of ['codex','antigravity','unknown']) {
 await page.evaluate(engine=>{const f=(window as any).settingsFixture;f.connection.update({bots:[{id:'bot',engine}]});},engine);
 await expect(page.getByRole('button',{name:'整理上下文',exact:true})).toHaveCount(0);
}
for(const engine of ['claude','kimi','deepseek']) {
 await page.evaluate(engine=>{const f=(window as any).settingsFixture;f.connection.update({bots:[{id:'bot',engine}]});},engine);
 await expect(page.getByRole('button',{name:'整理上下文',exact:true})).toBeVisible();
}
});
