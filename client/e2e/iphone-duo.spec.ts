import { setListOption } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { sendChoiceFixture } from './fixtures/claude-send-choice.js';
import { enterMobileChat, mobileHome } from './fixtures/mobile.js';

// Xcode 27.1 iPhone Duo device profile: cover 1398x2034 @3,
// inner 2853x2007 @3. Insets below are asymmetric stress fixtures, not hardware claims.
test.use({ viewport: { width: 466, height: 678 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
async function safe(page: Page, top: number, right: number, bottom: number, left: number) {
  await page.evaluate(v => { for (const [k,n] of Object.entries(v)) document.documentElement.style.setProperty(`--safe-area-inset-${k}`,`${n}px`); }, {top,right,bottom,left});
}
async function pair(page: Page, f: Awaited<ReturnType<typeof sendChoiceFixture>>) {
  await page.goto(f.hub.url);
  await preparePairing(page, f.hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
  await f.hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
  await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});
  await expect(mobileHome(page)).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.platform='ios'; (window as any).Capacitor.getPlatform=()=> 'ios'; });
  await setListOption(page, '显示未连接 Bot', true);
  await enterMobileChat(page,f.chats[0]!.title);
}

test('Duo fold, rotate and split preserve current chat, rich draft and queue choice',async({page}, info)=>{
  const f=await sendChoiceFixture();
  try {
    await f.appendHistory(); await pair(page,f);
    const input=page.getByRole('textbox',{name:'消息',exact:true});
    await input.fill('核对这段脚本'); await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await page.getByRole('radio',{name:/^(排到下一轮|排队)$/}).check();
    await input.fill('下轮再整理镜头。保留这份草稿，折叠后继续编辑。');
    await page.locator('input.attachment-picker-input').setInputFiles({name:'镜头说明.txt',mimeType:'text/plain',buffer:Buffer.from('仅供布局回归，不会调用模型。')});
    for (const size of [{name:'cover',width:466,height:678,insets:[0,64,21,8]}, {name:'inner',width:951,height:669,insets:[0,64,21,8]}, {name:'rotated',width:669,height:951,insets:[24,8,21,64]}, {name:'split',width:320,height:669,insets:[0,8,21,48]}, {name:'return-cover',width:466,height:678,insets:[0,64,21,8]}]) {
      await page.setViewportSize({width:size.width,height:size.height}); await safe(page,...size.insets as [number,number,number,number]);
      await expect(input).toHaveValue('下轮再整理镜头。保留这份草稿，折叠后继续编辑。');
      await expect(page.locator('.attachment-draft')).toContainText('镜头说明.txt');
      // A desktop-only compactness update must not restyle expanded native iOS.
      await expect(page.getByRole('radio',{name:size.width <= 760 ? '排队' : '排到下一轮',exact:true})).toBeChecked();
      await expect(page.getByRole('heading',{name:f.chats[0]!.title,exact:true,level:1})).toBeVisible();
      for (const theme of ['light','dark']) {
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.screenshot({path:info.outputPath(`${size.name}-${theme}.png`),animations:'disabled'});
      }
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      const title = page.locator('.chat-identity > span[title]').first();
      expect((await title.boundingBox())!.width).toBeGreaterThan(60);
      const send = page.getByRole('button',{name:'发送消息',exact:true});
      const box=(await send.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(size.insets[3]!);
      expect(box.x+box.width).toBeLessThanOrEqual(size.width-size.insets[1]!+1);
      expect(box.y+box.height).toBeLessThanOrEqual(size.height-size.insets[2]!+1);
      await page.locator('.send-choice-help').click();
      const dialog=page.getByRole('dialog',{name:'发送方式',exact:true});
      await expect(dialog).toBeVisible();
      const rect=(await dialog.boundingBox())!;
      expect(rect.x).toBeGreaterThanOrEqual(size.insets[3]!-1);
      expect(rect.x+rect.width).toBeLessThanOrEqual(size.width-size.insets[1]!+1);
      await dialog.getByRole('button',{name:'关闭发送方式说明',exact:true}).click();
    }
    // Wide iOS still offers the native camera/photo/file entry, and folding
    // while the system picker is open must not discard its result.
    await page.setViewportSize({width:951,height:669}); await safe(page,0,64,21,8);
    await page.locator('.composer-attachment-menu > button').click();
    const sheet=page.getByRole('dialog',{name:'添加附件',exact:true});
    await expect(sheet.getByRole('button',{name:'附加图片',exact:true})).toBeVisible();
    const chooserPromise=page.waitForEvent('filechooser');
    await sheet.getByRole('button',{name:'拍照',exact:true}).click();
    const chooser=await chooserPromise;
    expect(await chooser.element().getAttribute('capture')).toBe('environment');
    await page.setViewportSize({width:466,height:678});
    await chooser.setFiles({name:'现场照片.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64')});
    await expect(page.locator('.attachment-draft')).toContainText('现场照片.png');
    expect(f.turns).toHaveLength(1); expect(f.inputs).toHaveLength(0); expect(f.controls).toHaveLength(0);
  } finally {await page.close();await f.close();}
});

for (const touch of [true, false]) test.describe(`native window ${touch ? 'touch' : 'pointer'}`, () => {
  test.use({ hasTouch: touch, isMobile: touch });
  test('keyboard reports follow fold and split without losing draft or covering Send',async({page},info)=>{
  const { createServer }=await import('./fixtures/vite.js');
  const { HubServer }=await import('../../src/hub/server.js');
  const { mkdtemp,rm }=await import('node:fs/promises');
  const path=await import('node:path'); const os=await import('node:os');
  const root=await mkdtemp(path.join(os.tmpdir(),'duo-window-'));
  // Only select the actual iOS viewport controller; networking stays on the
  // browser's isolated Hub. Native UIKit delivery is verified separately.
  const vite=await createServer({plugins:[{name:'ios-window-fixture',enforce:'pre',transform(code,id){
    if(id.endsWith('/src/MobileViewport.tsx')) return code.replace('const platform = Capacitor.getPlatform();',"const platform = 'ios' as string;");
  }}],server:{host:'127.0.0.1',port:0}});
  await vite.listen();const url=vite.resolvedUrls!.local[0]!;
  const hub=await HubServer.start({stateDir:root,origins:[new URL(url).origin]});
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('duo','设计助手','fixture')");
    const chat=await hub.store.createConversation('owner',['duo'],'折叠后继续编辑','direct');
    await hub.store.publishBotMessage('duo',{conversationId:chat.id,blocks:[{type:'text',text:'打开大屏后可以并排浏览列表和聊天。折回小屏，继续在同一段对话中编辑。'}],status:'complete'});
    await page.addInitScript(()=>{
      (window as any).tarobotKeyboardInsets={supported:()=>true};
      (window as any).__tarobotKeyboard={height:0,at:Date.now(),duration:0};
    });
    await page.goto(url);await page.getByLabel('Hub 地址',{exact:true}).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
    await hub.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
    await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'});
    await setListOption(page, '显示未连接 Bot', true);
    await enterMobileChat(page,chat.title);
    await page.evaluate(()=>document.documentElement.dataset.platform='ios');
    expect(await page.evaluate(()=>matchMedia('(pointer: coarse)').matches)).toBe(touch);
    const input=page.getByRole('textbox',{name:'消息',exact:true});
    await input.fill('保留这一段话\n第二段继续输入，切换屏幕后也不丢。');
    const keyboard=(height:number)=>page.evaluate(height=>{
      (window as any).__tarobotKeyboard={height,at:Date.now(),duration:0};
      window.dispatchEvent(new CustomEvent('tarobot-keyboard',{detail:(window as any).__tarobotKeyboard}));
    },height);
    for(const state of [{name:'cover-keyboard',width:466,height:678,ime:280},{name:'inner-keyboard',width:951,height:669,ime:260},{name:'split-keyboard',width:360,height:669,ime:260},{name:'floating-keyboard',width:951,height:669,ime:0}]){
      await page.setViewportSize({width:state.width,height:state.height});await safe(page,0,48,21,8);await keyboard(state.ime);
      await expect(page.locator('html')).toHaveAttribute('data-keyboard-open',state.ime?'true':'false');
      await expect.poll(()=>page.locator('.app-shell').evaluate(n=>n.getBoundingClientRect().height)).toBe(state.height-state.ime);
      await expect(input).toHaveValue('保留这一段话\n第二段继续输入，切换屏幕后也不丢。');
      const send=page.getByRole('button',{name:'发送消息',exact:true});
      await expect(send).toBeInViewport();
      const r=(await send.boundingBox())!;expect(r.y+r.height).toBeLessThanOrEqual(state.height-state.ime);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`${state.name}.png`),animations:'disabled'});
    }
  }finally{await page.close();await hub.close();await vite.close();await rm(root,{recursive:true,force:true});}
});

});

test('image viewer follows cover and inner display while retaining the draft on return',async({page},info)=>{
  const { imageViewerFixture }=await import('./fixtures/image-viewer.js');
  const f=await imageViewerFixture(page);
  try {
    await page.evaluate(()=>document.documentElement.dataset.platform='ios');
    const input=page.getByRole('textbox',{name:'消息',exact:true});
    await input.fill('看完图片，继续写这条消息');
    await page.locator(`[data-message-id="${f.batch.id}"]`).getByRole('button',{name:'第一张',exact:true}).click();
    const viewer=page.getByRole('dialog',{name:'图片预览',exact:true});
    const img=viewer.locator('img');
    for (const size of [{name:'inner',width:951,height:669},{name:'cover',width:466,height:678},{name:'split',width:320,height:669}]) {
      await page.setViewportSize({width:size.width,height:size.height}); await safe(page,0,48,21,8);
      await expect(img).toBeVisible();
      await expect(img).toHaveAttribute('alt','第一张');
      await expect.poll(async()=>{const b=(await img.boundingBox())!;return b.width<=size.width+1&&b.height<=size.height+1;}).toBe(true);
      const close=viewer.getByRole('button',{name:'关闭',exact:true});
      await expect(close).toBeInViewport();
      const b=(await close.boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(8);expect(b.x+b.width).toBeLessThanOrEqual(size.width-48+1);
      await page.screenshot({path:info.outputPath(`image-${size.name}.png`),animations:'disabled'});
    }
    await viewer.getByRole('button',{name:'关闭',exact:true}).click();
    await expect(input).toHaveValue('看完图片，继续写这条消息');
  }finally{await page.close();await f.close();}
});
