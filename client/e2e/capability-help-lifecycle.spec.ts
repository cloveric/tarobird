import { test, expect } from '@playwright/test';
import { createServer } from './fixtures/vite.js';

const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import { CapabilityHelpDialog } from '/src/CapabilityHelpDialog.tsx';
import { ClientCache } from '/src/storage.ts';
import '/src/styles.css'; import '/src/brand-theme.css';
const caches = [new ClientCache('capability-lifecycle-a'), new ClientCache('capability-lifecycle-b')];
const f = window.capabilityLifecycle = { caches, requests: [], created: [], navigation: 'original', pending: [] };
const bots = ['A 的助手', 'B 的助手'].map(name => ({id:'alpha',name,engine:'claude',model:'',effort:'',online:1}));
const connections = caches.map((cache,host) => ({cache,state:{status:'online',bots:[bots[host]]},
  createConversation: frame => new Promise(resolve => { f.requests.push({host,frame}); f.pending[host] = () => resolve({id:'same_created',type:'direct',title:frame.title,ownerId:'owner',botIds:['alpha'],archived:false,createdAt:1}); })
}));
function App() {
  const [host,setHost] = React.useState(0), [open,setOpen] = React.useState(true);
  f.switchHost = value => {setHost(value);setOpen(true);};
  return open ? React.createElement(CapabilityHelpDialog,{key:host,connection:connections[host],bot:bots[host],request:{botId:'alpha',kind:'mcp',intent:'check',name:'能力 '+host},
    close:()=>setOpen(false),created:conversation=>{f.created.push({host,id:conversation.id});f.navigation=host+':'+conversation.id;setOpen(false);}}) : React.createElement('p',null,'Closed');
}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;

test('retired capability dialog saves to its original host but cannot close or navigate the replacement', async ({ page }) => {
  const vite = await createServer({ plugins: [{ name: 'capability-lifecycle-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/__capability-lifecycle') return next();
      response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__capability-lifecycle', html));
    });
  } }], server: { port: 0, strictPort: false, host: '127.0.0.1', hmr: false } });
  await vite.listen();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(vite.resolvedUrls!.local[0]! + '__capability-lifecycle');
    const dialog = page.getByRole('dialog', { name: '准备配置消息', exact: true });
    const text = page.getByRole('textbox', { name: '配置消息', exact: true });
    await text.fill('A 主机：第一份已确认的配置草稿');
    await page.getByRole('button', { name: '打开配置对话', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).capabilityLifecycle.requests.length)).toBe(1);
    // Host navigation can retire a busy dialog even though its own close
    // button correctly stays disabled. The same IDs exist on the new host.
    await page.evaluate(() => (window as any).capabilityLifecycle.switchHost(1));
    await expect(dialog).toContainText('B 的助手');
    await text.fill('B 主机：后来打开窗口中尚未确认的修改');
    await page.evaluate(() => (window as any).capabilityLifecycle.pending[0]());
    await expect.poll(() => page.evaluate(async () => (window as any).capabilityLifecycle.caches[0].draft('same_created'))).toBe('A 主机：第一份已确认的配置草稿');
    await expect(dialog).toBeVisible(); await expect(text).toHaveValue('B 主机：后来打开窗口中尚未确认的修改');
    expect(await page.evaluate(async () => {
      const f = (window as any).capabilityLifecycle;
      return { created: f.created, navigation: f.navigation, foreignDraft: await f.caches[1].draft('same_created'), outbox: await Promise.all(f.caches.map((cache: any) => cache.outbox())) };
    })).toEqual({ created: [], navigation: 'original', foreignDraft: '', outbox: [[], []] });
    await page.getByRole('button', { name: '打开配置对话', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).capabilityLifecycle.requests.length)).toBe(2);
    await page.evaluate(() => (window as any).capabilityLifecycle.pending[1]());
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(async () => {
      const f = (window as any).capabilityLifecycle;
      return { created: f.created, navigation: f.navigation, drafts: await Promise.all(f.caches.map((cache: any) => cache.draft('same_created'))) };
    })).toEqual({ created: [{ host: 1, id: 'same_created' }], navigation: '1:same_created', drafts: ['A 主机：第一份已确认的配置草稿', 'B 主机：后来打开窗口中尚未确认的修改'] });
    expect(errors).toEqual([]);
  } finally { await page.close(); await vite.close(); }
});
