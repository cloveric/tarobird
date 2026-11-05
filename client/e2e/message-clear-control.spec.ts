import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react'; import { createRoot } from 'react-dom/client';
import '/src/styles.css'; import '/src/conversation-settings.css';
import { ClearHistoryControl } from '/src/ClearHistoryControl.tsx';
import { HubConnection } from '/src/connection.ts'; import { HubHttpError } from '/src/http-error.ts';
const f = window.clearFixture = {cursor:0,posts:[],mode:'normal',conversation:'chat',count:3};
const c = f.connection = Object.create(HubConnection.prototype), listeners = new Set();
c.closed=false; c.networkBlocked=false; c.deviceRevoked=false;
c.state={status:'online',messageClearAvailable:true};
c.subscribe=notify=>{listeners.add(notify);return()=>listeners.delete(notify)};
c.update=value=>{c.state={...c.state,...value};listeners.forEach(fn=>fn())};
c.cache={cursor:async()=>f.cursor,isClosed:false};
c.http=async(route,init)=>{
  if(init?.method!=='POST')return {throughId:'original',count:f.count};
  f.posts.push({route,...JSON.parse(init.body)});
  if(f.mode==='active')throw new HubHttpError(409,'message_clear_active');
  if(f.mode==='hold')return new Promise(resolve=>f.release=()=>resolve({throughId:'original',clearedIds:['a'],remaining:2,seq:20}));
  return {throughId:'original',clearedIds:[],remaining:0,seq:50};
};
function App(){React.useSyncExternalStore(c.subscribe,()=>c.state);return React.createElement('div',{className:'creation-dialog conversation-settings'},React.createElement(ClearHistoryControl,{connection:c,conversationId:f.conversation}));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "history-control-fixture", configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
    if (req.url !== "/__clear-history") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__clear-history", html));
  }); } }], server: { port: 0, host: "127.0.0.1", hmr: false } }); await server.listen();
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "__clear-history"); await expect(page.getByRole("button", { name: "清理聊天记录", exact: true })).toBeEnabled(); });

test("empty final retry waits for this device to apply the receipt, blocks duplicate clicks and restores focus", async ({ page }) => {
  const entry = page.getByRole("button", { name: "清理聊天记录", exact: true }); await entry.click();
  const dialog = page.getByRole("dialog", { name: "清理 3 条聊天记录？", exact: true });
  await dialog.getByRole("button", { name: "清理记录", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(dialog.getByRole("button", { name: "正在清理…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await expect(page.getByText("聊天记录已清理，Bot 上下文保持不变。", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).clearFixture.posts)).toHaveLength(1);
  await page.evaluate(() => { (window as any).clearFixture.cursor = 50; });
  await expect(dialog).toHaveCount(0); await expect(entry).toBeFocused();
  await expect(page.getByText("聊天记录已清理，Bot 上下文保持不变。", { exact: true })).toBeVisible();
});

test("old Host, offline and syncing have explicit disabled hints; active cards explain why clearing paused", async ({ page }) => {
  const entry = page.getByRole("button", { name: "清理聊天记录", exact: true });
  await page.evaluate(() => (window as any).clearFixture.connection.update({ messageClearAvailable: false }));
  await expect(entry).toBeDisabled(); await expect(entry).toContainText("更新运行 Bot 的主机");
  await page.evaluate(() => (window as any).clearFixture.connection.update({ status: "offline" }));
  await expect(entry).toContainText("连接主机后");
  await page.evaluate(() => (window as any).clearFixture.connection.update({ status: "online", messageClearAvailable: true, syncProgress: { completed: 0, total: 1 } }));
  await expect(entry).toBeDisabled(); await expect(entry).toContainText("历史同步完成后");
  await page.evaluate(() => { const f = (window as any).clearFixture; f.connection.update({ syncProgress: undefined }); f.mode = "active"; });
  await entry.click(); await page.getByRole("button", { name: "清理记录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先处理后再继续");
  await page.evaluate(() => { const f = (window as any).clearFixture; f.mode = "normal"; f.cursor = 50; });
  await page.getByRole("button", { name: "继续清理", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).clearFixture.posts.map((p: any) => p.throughId))).toEqual(["original", "original"]);
});

test("changing conversations during an outstanding request cannot clear or report success in the new chat", async ({ page }) => {
  await page.evaluate(() => { (window as any).clearFixture.mode = "hold"; });
  await page.getByRole("button", { name: "清理聊天记录", exact: true }).click();
  await page.getByRole("button", { name: "清理记录", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).clearFixture.posts.length)).toBe(1);
  await page.evaluate(() => { const f = (window as any).clearFixture; f.conversation = "other"; f.connection.update({}); });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => { const f = (window as any).clearFixture; f.cursor = 20; f.release(); });
  await expect(page.getByRole("button", { name: "清理聊天记录", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "清理聊天记录", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "清理 3 条聊天记录？", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).clearFixture.posts)).toEqual([{ route: "/api/conversations/chat/messages/clear", throughId: "original" }]);
});
