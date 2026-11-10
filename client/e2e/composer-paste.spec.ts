import { test, expect, type Page } from '@playwright/test';
import { createServer } from './fixtures/vite.js';
import type { ViteDevServer } from 'vite';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=';
const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useComposerPaste} from '/src/composer-paste.ts';
const f=window.pasteFixture={};
function App(){const [scope,select]=React.useState('one'),[disabled,disable]=React.useState(false),[text,change]=React.useState(''),[files,addFiles]=React.useState([]),[error,fail]=React.useState('');const input=React.useRef(null);
Object.assign(f,{select,disable,change,files});const paste=useComposerPaste({scope,input,disabled,change,add:next=>{if(f.reject)return false;addFiles(old=>[...old,...next]);return true;},fail});
return React.createElement('section',{onPaste:paste,'data-scope':scope,'data-attachment-disabled':String(disabled)},React.createElement('textarea',{ref:input,value:text,onChange:e=>change(e.target.value)}),React.createElement('button',null,'toolbar'),React.createElement('input',{placeholder:'other input'}),React.createElement('output',{id:'files'},files.map(f=>f.name).join(',')),React.createElement('output',{id:'error'},error));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server=await createServer({plugins:[{name:'paste-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{if(req.url!=='/__paste')return next();res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__paste',html));});}}],server:{port:0,host:'127.0.0.1'}});
  await server.listen();url=server.resolvedUrls!.local[0]+'__paste';
});
test.afterAll(async()=>{await server.close();});
test.beforeEach(async({page})=>{await page.goto(url);await expect(page.locator('textarea')).toBeVisible();});
async function paste(page: Page, text: string, markup: string, file: boolean | 'unreadable-image' | 'unreadable-file' | 'empty-image' = false, eventText?: string) {
  return page.locator('textarea').evaluate((field, {text,markup,file,png,eventText})=>{
    const data=new DataTransfer();data.setData('text/plain',eventText??text);if(markup)data.setData('text/html',markup);
    if(file===true || file==='empty-image')data.items.add(new File(file==='empty-image'?[]:[Uint8Array.from(atob(png),c=>c.charCodeAt(0))],'direct.png',{type:'image/png'}));
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});
    if(file==='unreadable-image' || file==='unreadable-file')Object.defineProperty(event,'clipboardData',{value:{files:data.files,items:[{kind:'file',type:file==='unreadable-image'?'image/png':'application/pdf',getAsFile:()=>null}],getData:(type:string)=>data.getData(type)}});
    field.dispatchEvent(event);
    // Synthetic events have no browser default action; model just that action.
    if(!event.defaultPrevented && text){(field as HTMLTextAreaElement).focus();document.execCommand('insertText',false,text);}
    return event.defaultPrevented;
  },{text,markup,file,png,eventText});
}
test('HTML data image without files becomes an exact attachment instead of a placeholder',async({page})=>{
  await page.locator('textarea').focus();
  expect(await paste(page,'[图片]',`<img src="data:image/png;base64,${png}">`)).toBe(true);
  await expect(page.locator('#files')).toContainText('.png');await expect(page.locator('textarea')).toHaveValue('');
  expect(await page.evaluate(async()=>btoa(String.fromCharCode(...new Uint8Array(await (window as any).pasteFixture.files[0].arrayBuffer()))))).toBe(png);
});
test('direct files take priority over HTML copies and mixed text stays at the caret',async({page})=>{
  const input=page.locator('textarea');await input.fill('AB');await input.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(1,1));
  await paste(page,'caption',`<img src="data:image/png;base64,${png}">`,true);
  await expect(input).toHaveValue('AcaptionB');await expect(page.locator('#files')).toHaveText('direct.png');
});
test('an empty direct image retains its placeholder for the existing upload validation',async({page})=>{
  await page.locator('textarea').focus();await paste(page,'[图片]','','empty-image');
  await expect(page.locator('#files')).toHaveText('direct.png');await expect(page.locator('textarea')).toHaveValue('[图片]');
});
test('ordinary text, remote and local image URLs preserve native text paste and undo',async({page})=>{
  const requests:string[]=[];page.on('request',r=>{if(r.url().includes('example.invalid'))requests.push(r.url());});
  const input=page.locator('textarea');await input.focus();
  expect(await paste(page,'hello','<b>hello</b>')).toBe(false);await expect(input).toHaveValue('hello');
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue('');
  expect(await paste(page,'[图片]','<img src="https://example.invalid/private.png"><img src="file:///private/example.png">')).toBe(false);
  await expect(page.locator('#files')).toHaveText('');expect(requests).toEqual([]);
});
async function native(page:Page){await page.evaluate(()=>{const f=(window as any).pasteFixture;f.calls=0;window.tarobotDesktop={version:1,engine:'electron',platform:'win32',on:()=>()=>{},openSocket:async()=>{},invoke:async(command,args)=>{if(command!=='desktop_clipboard_image')throw Error(command);f.calls++;f.args=args;return new Promise(resolve=>{f.resolve=resolve;});}};});}
async function resolveNative(page:Page,value:{type:string;data:string}|null){
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).pasteFixture.resolve)).toBe('function');
  await page.evaluate(value=>(window as any).pasteFixture.resolve(value),value);
}
for(const text of ['', 'Image caption\nSecond line'])test(`unreadable image file item recovers a standard native image with ${text?'caption':'empty text'}`,async({page})=>{
  await native(page);const input=page.locator('textarea');await input.focus();
  expect(await paste(page,text,'','unreadable-image')).toBe(false);await expect(input).toHaveValue(text);
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(1);
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toContainText('.png');await expect(input).toHaveValue(text);await expect(page.locator('#error')).toHaveText('');
  if(text){await input.press('ControlOrMeta+z');await expect(input).toHaveValue('');}
});
test('unreadable nonimage items and disabled image items never trigger native clipboard reads',async({page})=>{
  await native(page);const input=page.locator('textarea');await input.focus();
  expect(await paste(page,'document text','','unreadable-file')).toBe(false);await expect(input).toHaveValue('document text');
  await page.evaluate(()=>(window as any).pasteFixture.disable(true));await expect(page.locator('section')).toHaveAttribute('data-attachment-disabled','true');
  expect(await paste(page,' caption','','unreadable-image')).toBe(false);await expect(input).toHaveValue('document text caption');
  expect(await page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(0);await expect(page.locator('#files')).toHaveText('');await expect(page.locator('#error')).toHaveText('');
});
for(const text of ['[图片]', 'Image caption'])test(`empty event data uses actual native insertion to recover ${text}`,async({page})=>{
  await native(page);const input=page.locator('textarea');await input.fill('AB');await input.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(1,1));
  expect(await paste(page,text,'','unreadable-image','')).toBe(false);await expect(input).toHaveValue(`A${text}B`);
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.args?.text)).toBe(text);
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toContainText('.png');await expect(input).toHaveValue(text==='[图片]'?'AB':`A${text}B`);await expect(page.locator('#error')).toHaveText('');
});
test('desktop clipboard fallback attaches the native image and removes only its untouched placeholder',async({page})=>{
  await native(page);await page.locator('textarea').focus();await paste(page,'[图片]','');
  await expect(page.locator('textarea')).toHaveValue('[图片]');
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(1);
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toContainText('.png');await expect(page.locator('textarea')).toHaveValue('');
});
test('late clipboard result cannot change another conversation or an edited draft',async({page})=>{
  await native(page);await page.locator('textarea').focus();await paste(page,'[图片]','');
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(1);
  await page.evaluate(()=>{(window as any).pasteFixture.select('two');});
  await expect(page.locator('section')).toHaveAttribute('data-scope','two');
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toHaveText('');
  await page.locator('textarea').fill('');await paste(page,'[图片]','');
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(2);await page.locator('textarea').fill('new draft');
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toHaveText('');await expect(page.locator('textarea')).toHaveValue('new draft');
  await expect(page.locator('#error')).not.toHaveText('');
});
test('no image keeps the original placeholder and provides retry guidance',async({page})=>{
  await native(page);await page.locator('textarea').focus();await paste(page,'[图片]','');
  await resolveNative(page,null);
  await expect(page.locator('textarea')).toHaveValue('[图片]');await expect(page.locator('#files')).toHaveText('');await expect(page.locator('#error')).not.toHaveText('');
});
test('native image paste works from the toolbar and disabled drafts do not read the clipboard',async({page})=>{
  await native(page);await page.locator('button').focus();
  await page.locator('button').evaluate(button=>{const data=new DataTransfer();data.setData('text/plain','[image]');button.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  await expect(page.locator('textarea')).toHaveValue('[image]');
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toContainText('.png');await expect(page.locator('textarea')).toHaveValue('');
  await page.evaluate(()=>(window as any).pasteFixture.disable(true));
  await expect(page.locator('section')).toHaveAttribute('data-attachment-disabled','true');
  await paste(page,'[图片]','');
  expect(await page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(1);
});
test('malformed data images fail without fetching and pending images stop on disable',async({page})=>{
  await page.locator('textarea').focus();await paste(page,'[图片]','<img src="data:image/png;base64,bm90LWFuLWltYWdl">');
  await expect(page.locator('#files')).toHaveText('');await expect(page.locator('#error')).not.toHaveText('');
  await native(page);await page.locator('textarea').fill('');await paste(page,'[图片]','');
  await expect.poll(()=>page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(1);
  await page.evaluate(()=>(window as any).pasteFixture.disable(true));
  await expect(page.locator('section')).toHaveAttribute('data-attachment-disabled','true');
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toHaveText('');
});
test('rich text with data icons keeps native undo and stays editable without attachment capability',async({page})=>{
  await native(page);const input=page.locator('textarea');await input.focus();
  const markup=`<p>Result A<img src="data:image/png;base64,${png}"></p><p>Result B<img src="https://example.invalid/icon.png"></p>`;
  expect(await paste(page,'Result A\nResult B',markup)).toBe(false);
  await expect(input).toHaveValue('Result A\nResult B');await expect(page.locator('#files')).toHaveText('');
  expect(await page.evaluate(()=>(window as any).pasteFixture.calls)).toBe(0);
  await input.press('ControlOrMeta+z');await expect(input).toHaveValue('');await expect(page.locator('#error')).toHaveText('');
  await page.evaluate(()=>(window as any).pasteFixture.disable(true));await expect(page.locator('section')).toHaveAttribute('data-attachment-disabled','true');
  expect(await paste(page,'Search result: docs',markup)).toBe(false);await expect(input).toHaveValue('Search result: docs');
  await expect(page.locator('#error')).toHaveText('');await expect(page.locator('#files')).toHaveText('');
});
test('native placeholder with Windows CRLF is removed using textarea-normalized offsets',async({page})=>{
  await native(page);const input=page.locator('textarea');await input.fill('AB');await input.evaluate((n:HTMLTextAreaElement)=>n.setSelectionRange(1,1));
  await paste(page,'[图片]\r\n','');await expect(input).toHaveValue(/A\[图片\]\r?\nB/);
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('#files')).toContainText('.png');await expect(input).toHaveValue('AB');await expect(page.locator('#error')).toHaveText('');
});
test('an attachment-policy rejection preserves the clipboard text for direct and native images',async({page})=>{
  await page.evaluate(()=>(window as any).pasteFixture.reject=true);await page.locator('textarea').focus();
  await paste(page,'[图片]',`<img src="data:image/png;base64,${png}">`);
  await expect(page.locator('textarea')).toHaveValue('[图片]');await expect(page.locator('#files')).toHaveText('');
  await native(page);await page.locator('textarea').fill('');await paste(page,'[图片]','');
  await resolveNative(page,{type:'image/png',data:png});
  await expect(page.locator('textarea')).toHaveValue('[图片]');await expect(page.locator('#files')).toHaveText('');
});
